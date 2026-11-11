/** 鲸吞：多线程分片下载器 */
var JTDownloader = (function () {
    'use strict';

    /** 默认配置 */
    const DEFAULTS = {
        threads: 4,          // 起始并发
        minThreads: 1,       // 自适应下限
        maxThreads: 16,      // 自适应上限
        adaptive: true,      // 是否按实测吞吐自动调整并发
        retries: 3,          // 单个分片的重试次数（不含首次）
        retryDelay: 800,     // 首次重试的基础延迟（毫秒）
        maxRetryDelay: 15000,
        timeout: 30000,      // 单次请求的超时（毫秒）
        perHostLimit: 6,     // 每个域名同时进行的请求数（浏览器 HTTP/1.1 的实际上限）
        verifyRange: true,   // 是否校验服务器对 Range 请求的响应
        credentials: 'include',
        cache: 'no-store',
        adaptWindow: 8,       // 每完成多少个分片评估一次并发
        /**
         * 限流感知：识别「并发太高被服务器拒绝」，自动降并发 + 冷却。
         * 这是「并行开多了反而下不了」的核心对策。
         */
        throttleAware: true,
        /** 判定为限流的连续失败次数阈值 */
        throttleTrip: 2,
        /** 触发限流后并发降到原来的多少 */
        throttleBackoff: 0.5,
        /** 全局冷却时间（毫秒） */
        cooldownMs: 3000,
        /** 慢启动：从低并发起步，确认服务器扛得住再逐步加，避免一上来就被封 */
        slowStart: true,
        /** 磁盘断点续传：把已完成分片写入 OPFS，重跑时直接跳过 */
        resume: false,
        /** 任务标识（清单 URL 等），resume 开启时必填 */
        resumeId: '',
        /** 任务指纹的原始材料（清单文本） */
        resumeFingerprint: ''
    };

    /** 这些状态码代表「服务器现在忙，过会儿再来」 */
    const RETRYABLE_STATUS = new Set([
        408, 425, 429, 500, 502, 503, 504, 507, 509, 520, 521, 522, 523, 524, 525, 527, 530
    ]);

    /**
     * 典型「并发过高 / 反爬拦截」状态码。
     * 403 单看一次可能是资源本身的问题，但连续出现就是被限流了。
     */
    const THROTTLE_STATUS = new Set([403, 429, 503, 509]);

    /**
     * 带状态码的请求错误，便于上层区分「能不能重试」
     */
    class HttpError extends Error {
        /**
         * @param {number} status
         * @param {string} [message]
         * @param {number} [retryAfter] 服务器要求的等待毫秒数
         */
        constructor(status, message, retryAfter) {
            super(message || ('HTTP ' + status));
            this.name = 'HttpError';
            this.status = status;
            this.retryAfter = retryAfter || 0;
        }
    }

    /**
     * 服务器忽略了 Range 请求（返回 200 而不是 206）。
     * 这种情况下按分片切开的数据全是错的，必须报错而不是拼出一个坏文件。
     */
    class RangeMismatchError extends Error {
        constructor(message) {
            super(message);
            this.name = 'RangeMismatchError';
        }
    }

    /**
     * 取整数，非法值回落到默认。调用方经常直接把
     * `undefined` 传进来（比如「没配就用默认」），
     * 而 `undefined | 0` 会变成 0，把默认值悄悄改掉。
     * @param {*} value
     * @param {number} fallback
     * @returns {number}
     */
    function intOr(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.trunc(n) : fallback;
    }

    /**
     * 取数值，非法值回落到默认
     * @param {*} value
     * @param {number} fallback
     * @returns {number}
     */
    function numOr(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    /**
     * 把 TypedArray / ArrayBuffer 统一成 ArrayBuffer
     * @param {ArrayBuffer|ArrayBufferView} input
     * @returns {ArrayBuffer}
     */
    function toArrayBuffer(input) {
        if (input instanceof ArrayBuffer) return input;
        if (ArrayBuffer.isView(input)) {
            return input.buffer.slice(
                input.byteOffset,
                input.byteOffset + input.byteLength
            );
        }
        return input;
    }

    /**
     * 解析 Retry-After 头，支持秒数与 HTTP 日期两种写法
     * @param {string|null} value
     * @returns {number} 毫秒
     */
    function parseRetryAfter(value) {
        if (!value) return 0;

        const seconds = Number(value);
        if (!isNaN(seconds)) return Math.max(0, seconds * 1000);

        const at = Date.parse(value);
        if (!isNaN(at)) return Math.max(0, at - Date.now());

        return 0;
    }

    /**
     * 这些头不能作为 fetch 的 headers 传递，会被浏览器静默丢弃。
     * Referer 改用 fetch 的 referrer 选项；Cookie 走 credentials；
     * Origin / Sec-Fetch-* 需要 declarativeNetRequest 在后台补。
     */
    const FORBIDDEN_HEADERS = new Set([
        'host', 'cookie', 'content-length', 'connection', 'referer', 'origin',
        'accept-encoding', 'expect', 'range', 'if-range', 'user-agent',
        'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
        'upgrade', 'keep-alive', 'transfer-encoding', 'te', 'trailer'
    ]);

    /**
     * 过滤出能安全透传的请求头
     * @param {Object|null} headers
     * @returns {Object}
     */
    function cleanHeaders(headers) {
        const out = {};
        if (!headers || typeof headers !== 'object') return out;

        for (const key of Object.keys(headers)) {
            const lower = String(key).toLowerCase();
            if (FORBIDDEN_HEADERS.has(lower)) continue;
            if (lower.indexOf('sec-') === 0 || lower.indexOf('proxy-') === 0) continue;

            const value = headers[key];
            if (value === undefined || value === null || value === '') continue;
            out[key] = String(value);
        }
        return out;
    }

    /**
     * 从 content-range 里取出起始偏移，例如 `bytes 100-199/1000` → 100
     * @param {string|null} header
     * @returns {number} 取不到返回 -1
     */
    function parseContentRangeStart(header) {
        if (!header) return -1;
        const m = /(\d+)-(\d+)\/(\d+|\*)/.exec(String(header));
        return m ? parseInt(m[1], 10) : -1;
    }

    /**
     * 把父信号的状态链接到子控制器，返回解绑函数
     * @param {AbortSignal|null} parent
     * @param {AbortController} child
     * @returns {Function}
     */
    function linkAbort(parent, child) {
        if (!parent) return function () {};

        if (parent.aborted) {
            try { child.abort(parent.reason); } catch (e) { /* 老浏览器没有 reason */ }
            return function () {};
        }

        const onAbort = function () {
            try { child.abort(parent.reason); } catch (e) { child.abort(); }
        };
        parent.addEventListener('abort', onAbort, { once: true });

        return function () { parent.removeEventListener('abort', onAbort); };
    }

    /**
     * 并发闸门：容量可以随实测吞吐动态调整，
     * 已经排队的请求不会被饿死。
     */
    class DynamicGate {
      constructor(capacity) {
          this.capacity = Math.max(1, capacity | 0);
          this.active = 0;
          this.waiters = [];
      }

      /** 调整容量，并唤醒因此获得空位的等待者 */
      setCapacity(next) {
          this.capacity = Math.max(1, next | 0);
          this._pump();
      }

      /** 取一个名额；容量已满时等待 */
      async acquire() {
          if (this.active < this.capacity) {
              this.active++;
              return;
          }
          await new Promise((resolve) => this.waiters.push(resolve));
      }

      /** 归还名额，并把多出来的容量转交给等待者 */
      release() {
          this.active = Math.max(0, this.active - 1);
          this._pump();
      }

      _pump() {
          while (this.active < this.capacity && this.waiters.length > 0) {
              this.active++;
              this.waiters.shift()();
          }
      }
    }

    class Downloader {
        /**
         * @param {Array} segments 分片列表（来自 JTM3u8.parse）
         * @param {Object} [options]
         */
        constructor(segments, options) {
            const opts = Object.assign({}, DEFAULTS, options || {});

            this.segments = Array.isArray(segments) ? segments : [];

            this.minThreads = Math.max(1, intOr(opts.minThreads, DEFAULTS.minThreads));
            this.maxThreads = Math.max(this.minThreads, intOr(opts.maxThreads, DEFAULTS.maxThreads));
            this.threads = Math.max(
                this.minThreads,
                Math.min(intOr(opts.threads, DEFAULTS.threads), this.maxThreads)
            );
            this.adaptive = opts.adaptive !== false;
            this.retries = Math.max(0, intOr(opts.retries, DEFAULTS.retries));
            this.retryDelay = Math.max(0, numOr(opts.retryDelay, DEFAULTS.retryDelay));
            this.maxRetryDelay = Math.max(
                this.retryDelay,
                numOr(opts.maxRetryDelay, DEFAULTS.maxRetryDelay)
            );
            // 超时是「单次请求」的上限。以前这个字段定义了却没人用，
            // 卡住的连接会一直挂着，整次下载永远等不到结果。
            this.timeout = numOr(opts.timeout, DEFAULTS.timeout);
            this.perHostLimit = numOr(opts.perHostLimit, DEFAULTS.perHostLimit);
            this.verifyRange = opts.verifyRange !== false;
            this.credentials = opts.credentials || DEFAULTS.credentials;
            this.cache = opts.cache || DEFAULTS.cache;
            this.adaptWindow = Math.max(1, intOr(opts.adaptWindow, DEFAULTS.adaptWindow));

            /** 断点续传状态 */
            this.resume = opts.resume === true;
            this.resumeId = opts.resumeId || '';
            this.resumeFingerprint = opts.resumeFingerprint || '';
            this._cacheJobId = '';
            this.cachedCount = 0;
            this.cacheHits = 0;

            /** 附加请求头（取自嗅探时捕获的请求） */
            this.headers = cleanHeaders(opts.headers);

            /**
             * Referer 不能通过 headers 设置（fetch 禁止头），
             * 必须用 fetch 的 referrer 选项。这是反爬站点能否下到分片的关键。
             */
            this.referrer = opts.referrer && typeof opts.referrer === 'string'
                ? opts.referrer
                : '';

            /** 备用密钥（Array<number> 或 null） */
            this.keyFallback = opts.keyFallback && opts.keyFallback.length === 16
                ? opts.keyFallback
                : null;

            /** 外部取消信号 */
            this.externalSignal = opts.signal || null;

            /** 结果按索引存放，保证顺序 */
            this.results = new Array(this.segments.length);
            /** 密钥缓存：uri -> ArrayBuffer */
            this.keyCache = new Map();
            /**
             * 正在进行的密钥请求：uri -> Promise。
             * 多个分片同时开跑时会一起发现「这个密钥还没缓存」，
             * 没有这层去重就会对同一个地址打出好几个请求，
             * 而很多站点的密钥接口是限流的。
             */
            this.keyPending = new Map();

            this.completed = 0;
            this.failed = [];
            this.bytes = 0;
            this.aborted = false;
            this.abortReason = '';
            this.controller = null;

            this.onProgress = opts.onProgress || function () {};
            this.onSegmentDone = opts.onSegmentDone || function () {};
            this.onError = opts.onError || function () {};

            this.startTime = 0;
            this.lastTickTime = 0;
            this.lastTickBytes = 0;

            /** 并发自适应状态 */
            this._gate = null;
            this._hosts = null;
            this._effectiveMax = this.maxThreads;
            this._samples = [];
            this._recentFailures = [];
            this._streak = 0;
            this._settled = 0;
            this._ewmaSpeed = 0;

            /** 限流感知状态 */
            this.throttleAware = opts.throttleAware !== false;
            this.throttleTrip = Math.max(1, intOr(opts.throttleTrip, DEFAULTS.throttleTrip));
            this.throttleBackoff = Math.min(0.9, Math.max(0.1,
                numOr(opts.throttleBackoff, DEFAULTS.throttleBackoff)));
            this.cooldownMs = Math.max(0, numOr(opts.cooldownMs, DEFAULTS.cooldownMs));
            this._throttleStreak = 0;
            this._cooldownUntil = 0;
            this._throttleEvents = 0;
            this.throttledRetries = 0;
            this.slowStart = opts.slowStart !== false;

            /** 单次运行的状态标记，避免 abort 后重跑还沿用旧控制器 */
            this._running = false;
        }

        // ============================================================
        // 地址与规模
        // ============================================================

        /**
         * 分片涉及的域名数量。浏览器对同一域名的并发连接有硬上限，
         * 跨域名越多，真正能吃满的并发才越高。
         * @returns {number}
         */
        _countHosts() {
            if (this._hosts !== null) return this._hosts;

            const set = new Set();
            for (const seg of this.segments) {
                try {
                    set.add(new URL(seg.url).hostname);
                } catch (e) {
                    set.add('');
                }
            }
            this._hosts = set.size;
            return this._hosts;
        }

        /** 当前允许的最大并发 */
        _computeEffectiveMax() {
            const hosts = Math.max(1, this._countHosts());
            const limit = this.perHostLimit > 0
                ? this.perHostLimit * hosts
                : this.maxThreads;

            this._effectiveMax = Math.max(this.minThreads, Math.min(this.maxThreads, limit));
            return this._effectiveMax;
        }

        // ============================================================
        // 密钥
        // ============================================================

        /**
         * 取密钥。优先用调用方直接给的 key，其次按 URI 取（带缓存），
         * 最后退回到页面里捕获到的密钥。
         * @param {Object} key 分片上的 key 描述
         * @returns {Promise<ArrayBuffer>}
         */
        async getKey(key) {
            if (!key || !key.uri) {
                throw new Error('分片缺少密钥地址');
            }

            if (this.keyCache.has(key.uri)) {
                return this.keyCache.get(key.uri);
            }

            // 同一个密钥已经有请求在飞，直接搭同一班车，
            // 不要对每个分片各发一次
            const pending = this.keyPending.get(key.uri);
            if (pending) return pending;

            const task = this._resolveKey(key);
            this.keyPending.set(key.uri, task);

            try {
                return await task;
            } finally {
                if (this.keyPending.get(key.uri) === task) {
                    this.keyPending.delete(key.uri);
                }
            }
        }

        /**
         * 真正去取密钥（由 getKey 串行化）
         * @param {Object} key
         * @returns {Promise<ArrayBuffer>}
         */
        async _resolveKey(key) {
            // 调用方直接给了密钥（例如用户在详情面板手填），优先用它。
            // 以前这里只会去请求 URI，手填的密钥等于没生效。
            if (key.key && key.key.length === 16) {
                const buffer = ArrayBuffer.isView(key.key) || key.key instanceof ArrayBuffer
                    ? toArrayBuffer(key.key)
                    : key.key;

                if (buffer && buffer.byteLength === 16) {
                    this.keyCache.set(key.uri, buffer);
                    return buffer;
                }
            }

            try {
                const buffer = await this._fetchKey(key.uri);
                this.keyCache.set(key.uri, buffer);
                return buffer;
            } catch (e) {
                // 请求不到时，退回到页面里捞到的密钥。
                // 这不是「猜」，它就是从同一个页面上抓下来的真密钥。
                if (this.keyFallback && this.keyFallback.length === 16) {
                    console.warn('[鲸吞] 密钥请求失败，改用页面捕获的密钥:', e.message);
                    const buffer = new Uint8Array(this.keyFallback).buffer;
                    this.keyCache.set(key.uri, buffer);
                    return buffer;
                }
                throw e;
            }
        }

        /**
         * 真正发请求取密钥，带超时与有限重试
         * @param {string} uri
         * @returns {Promise<ArrayBuffer>}
         */
        async _fetchKey(uri) {
            let lastError = null;

            for (let attempt = 0; attempt <= Math.min(this.retries, 2); attempt++) {
                const child = new AbortController();
                const unlink = linkAbort(this.controller && this.controller.signal, child);
                const timer = this.timeout > 0
                    ? setTimeout(() => child.abort(), this.timeout)
                    : null;

                try {
                    const response = await fetch(uri, {
                        signal: child.signal,
                        credentials: this.credentials,
                        headers: this.headers,
                        cache: this.cache,
                        referrer: this.referrer || 'about:client'
                    });

                    if (!response.ok) {
                        throw new HttpError(response.status, '密钥请求失败 HTTP ' + response.status);
                    }

                    const buffer = await response.arrayBuffer();

                    if (buffer.byteLength !== 16) {
                        throw new Error('密钥长度异常：期望 16 字节，实际 ' + buffer.byteLength);
                    }

                    return buffer;
                } catch (e) {
                    lastError = e;
                    if (this._shouldStop(e)) throw e;
                    if (attempt < Math.min(this.retries, 2)) {
                        await sleep(this._backoff(attempt, 0));
                    }
                } finally {
                    if (timer) clearTimeout(timer);
                    unlink();
                }
            }

            throw lastError || new Error('密钥请求失败');
        }

        // ============================================================
        // 单个分片
        // ============================================================

        /**
         * 判断这个错误该不该继续重试
         * @param {Error} error
         * @returns {boolean}
         */
        _shouldStop(error) {
            // 用户主动取消，立刻停
            if (this.aborted) return true;
            if (this.externalSignal && this.externalSignal.aborted) return true;

            if (error instanceof HttpError) {
                // 限流状态码虽属 4xx/5xx，但在「限流感知」开启时要留给
                // 降并发 + 冷却后重试的机会 —— 403 连续出现就是被反爬拦了，
                // 单个 403 也值得再试一次（可能是瞬时的令牌过期）
                if (this.throttleAware && THROTTLE_STATUS.has(error.status)) {
                    return false;
                }
                return !RETRYABLE_STATUS.has(error.status);
            }
            // Range 校验失败属于「这个响应本身不对」，重试有意义但次数有限，
            // 由调用方的重试上限兜住
            return false;
        }

        /**
         * 记录一次失败是否属于「并发过高被限流」。
         * 连续出现限流状态码时立刻掐降并发 —— 此时再快也没用，
         * 只会让服务器封得更死。
         * @param {Error} error
         * @returns {boolean} 是否判定为限流
         */
        _noteThrottle(error) {
            if (!this.throttleAware) return false;

            const status = error instanceof HttpError ? error.status : 0;

            if (THROTTLE_STATUS.has(status)) {
                this._throttleStreak++;
            } else if (status === 0 &&
                error && /限流|too many request|rate limit/i.test(error.message || '')) {
                this._throttleStreak++;
            } else {
                // 普通错误打断连续计数：说明不是全局限流，
                // 而是这个分片自身的问题
                this._throttleStreak = 0;
                return false;
            }

            if (this._throttleStreak < this.throttleTrip) return false;

            // 已经触发过了就别每次都再降，避免一轮下来并发掉到 1
            if (this._cooldownUntil > Date.now()) return true;

            const current = this._gate ? this._gate.capacity : this.threads;
            const next = Math.max(this.minThreads,
                Math.floor(current * this.throttleBackoff));

            if (next < current && this._gate) {
                this._gate.setCapacity(next);
            }

            this._cooldownUntil = Date.now() + this.cooldownMs;
            this._throttleStreak = 0;
            this._throttleEvents++;
            this._effectiveMax = Math.min(this._effectiveMax,
                Math.max(this.minThreads, next));

            console.warn('[鲸吞] 检测到服务器限流，并发降到 ' + next +
                '，冷却 ' + this.cooldownMs + 'ms');
            return true;
        }

        /** 限流后应该等多久 */
        _throttleWait() {
            const remaining = this._cooldownUntil - Date.now();
            return remaining > 0 ? remaining + 100 : 0;
        }

        /**
         * 指数退避 + 抖动。多个分片同时失败时，
         * 抖动能把重试摊开，避免同一时刻一起打服务器。
         * @param {number} attempt 从 0 开始
         * @param {number} [retryAfter] 服务器要求的等待毫秒数
         * @returns {number}
         */
        _backoff(attempt, retryAfter) {
            if (retryAfter > 0) {
                return Math.min(retryAfter, this.maxRetryDelay);
            }

            const base = Math.min(this.retryDelay * Math.pow(2, attempt), this.maxRetryDelay);
            // 全抖动：在 [0.5x, 1x] 之间取，既退避又不会整齐划一
            return Math.round(base * (0.5 + Math.random() * 0.5));
        }

        /**
         * 下载并解密单个分片
         * @param {Object} segment
         * @param {AbortSignal} signal
         * @returns {Promise<Blob>}
         */
        async fetchSegment(segment, signal) {
            const headers = Object.assign({}, this.headers);
            const wantRange = !!(segment.byteRange && segment.byteRange.length);

            if (wantRange) {
                const start = segment.byteRange.offset;
                const end = start + segment.byteRange.length - 1;
                headers.Range = `bytes=${start}-${end}`;
            }

            const response = await fetch(segment.url, {
                signal: signal,
                credentials: this.credentials,
                headers: headers,
                cache: this.cache,
                redirect: 'follow',
                referrer: this.referrer || 'about:client'
            });

            if (!response.ok && response.status !== 206) {
                throw new HttpError(
                    response.status,
                    `HTTP ${response.status}`,
                    parseRetryAfter(response.headers.get('retry-after'))
                );
            }

            // 服务器把 Range 当普通请求处理了：拿回来的是整个文件，
            // 按分片长度切的话数据全是错位的，必须当作失败。
            if (wantRange && response.status !== 206 && this.verifyRange) {
                throw new RangeMismatchError(
                    '服务器忽略了 Range 请求（返回 ' + response.status + '），无法按分片下载'
                );
            }

            // 206 且我们请求了具体区间，校验起点是否对得上。
            // 有的 CDN 会「纠正」起始偏移，不查的话拼出来是静默损坏。
            if (wantRange && response.status === 206 && this.verifyRange) {
                const start = segment.byteRange.offset;
                const got = parseContentRangeStart(response.headers.get('content-range'));

                if (got !== -1 && got !== start) {
                    throw new RangeMismatchError(
                        `服务器返回的分片起点不符：期望 ${start}，实际 ${got}`
                    );
                }
            }

            // 用 Blob 接收：数据由浏览器自己托管在磁盘上，
            // 相比 arrayBuffer() 少一次全量内存拷贝。
            let blob = await response.blob();

            if (!blob || blob.size === 0) {
                throw new Error('分片返回了空数据');
            }

            const key = segment.key;

            // 样本级加密（fMP4 常见）需要解析 moof/traf 里的加密头，
            // 这里明确报错，而不是解出一堆乱码让用户以为下载成功了。
            if (key && String(key.method || '').toUpperCase() === 'SAMPLE-AES') {
                throw new Error('该分片使用 SAMPLE-AES 加密，需要样本级解密，暂不支持');
            }

            if (key && key.method && String(key.method).toUpperCase() === 'AES-128' && key.uri) {
                const keyBytes = await this.getKey(key);
                const plain = await JTM3u8.decryptAes128(
                    await blob.arrayBuffer(),
                    keyBytes,
                    key.iv,
                    segment.sequence
                );
                blob = new Blob([plain], { type: blob.type || 'application/octet-stream' });
            }

            return blob;
        }

        /**
         * 带重试地下载一个分片
         * @param {Object} segment
         */
        async downloadWithRetry(segment) {
            let lastError = null;

            // 断点续传：命中磁盘缓存的分片连请求都不发。
            // 这一步在重试循环之前，命中即走「成功」通道，统计照常走。
            if (this._cacheJobId) {
                try {
                    const hit = typeof JTCache !== 'undefined' && JTCache.get
                        ? await JTCache.get(this._cacheJobId, segment.index, {
                            url: segment.url,
                            byteRange: segment.byteRange
                        })
                        : null;

                    if (hit) {
                        this.results[segment.index] = hit;
                        this.bytes += hit.size;
                        this.cacheHits++;
                        this._noteSuccess();
                        this._settle(true, Date.now(), 0);
                        return;
                    }
                } catch (e) {
                    // 缓存不可用不影响正常下载
                }
            }

            for (let attempt = 0; attempt <= this.retries; attempt++) {
                if (this.aborted || this._stopped()) return;

                const child = new AbortController();
                const unlink = linkAbort(this.controller.signal, child);
                const timer = this.timeout > 0
                    ? setTimeout(() => child.abort(), this.timeout)
                    : null;

                const startedAt = Date.now();

                try {
                    const blob = await this.fetchSegment(segment, child.signal);

                    this.results[segment.index] = blob;
                    this.bytes += blob.size;
                    this._pushSample(startedAt, blob.size);
                    this._noteSuccess();

                    // 写完缓存才算这个分片真正「落袋」。
                    // 写失败也不影响本次下载，只是下次不能续。
                    if (this._cacheJobId && typeof JTCache !== 'undefined' && JTCache.put) {
                        try {
                            await JTCache.put(this._cacheJobId, segment.index, blob, {
                                url: segment.url,
                                byteRange: segment.byteRange
                            });
                        } catch (e) {
                            console.warn('[鲸吞] 分片缓存写入失败:', e.message);
                        }
                    }

                    if (this.onSegmentDone) {
                        this.onSegmentDone(segment, this.completed + 1, this.segments.length);
                    }

                    this._settle(true, startedAt, blob.size);
                    return;
                } catch (e) {
                    lastError = this._normalizeError(e);

                    if (this.aborted || this._stopped()) return;

                    const throttled = this._noteThrottle(lastError);

                    if (this._shouldStop(lastError)) break;

                    // 服务端明确让等，就按它说的等；
                    // 被限流时等待时间要覆盖冷却窗口
                    let wait = lastError instanceof HttpError && lastError.retryAfter > 0
                        ? lastError.retryAfter
                        : this._backoff(attempt, 0);

                    if (throttled) {
                        wait = Math.max(wait, this._throttleWait());
                        this.throttledRetries++;
                    }

                    if (attempt < this.retries) {
                        await sleep(wait);
                    }
                } finally {
                    if (timer) clearTimeout(timer);
                    unlink();
                }
            }

            // 全部重试用完还是失败：占位，保证索引对齐（合并时会跳过空项）
            this.results[segment.index] = null;
            this.failed.push({ segment: segment, error: lastError, index: segment.index });

            if (this.onError) this.onError(segment, lastError);

            this._noteFailure();
            this._settle(false, 0, 0);
        }

        /**
         * 把内部错误统一成带名字的 Error
         * @param {*} error
         * @returns {Error}
         */
        _normalizeError(error) {
            if (error instanceof Error) {
                // 我们自己设的定时器触发了 abort，报「请求超时」才有信息量；
                // 直接把浏览器的 "This operation was aborted" 甩给用户等于没说。
                if (error.name === 'AbortError' && !this.aborted && !this._stopped()) {
                    const wrapped = new Error('请求超时');
                    wrapped.name = 'TimeoutError';
                    return wrapped;
                }
                return error;
            }

            const wrapped = new Error(String(error));
            wrapped.name = 'Error';
            return wrapped;
        }

        /** 外部信号是否已经取消 */
        _stopped() {
            return !!(this.externalSignal && this.externalSignal.aborted);
        }

        // ============================================================
        // 自适应并发
        // ============================================================

        /**
         * 记录一次吞吐样本，只保留最近两秒
         * @param {number} startedAt
         * @param {number} size
         */
        _pushSample(startedAt, size) {
            this._samples.push({ time: startedAt, end: Date.now(), size: size });
            this._pruneSamples();
        }

        /** 丢弃两秒前的样本 */
        _pruneSamples() {
            const cutoff = Date.now() - 2000;
            while (this._samples.length > 0 && this._samples[0].end < cutoff) {
                this._samples.shift();
            }
            if (this._samples.length > 256) this._samples.splice(0, this._samples.length - 256);
        }

        /** 成功一个分片 */
        _noteSuccess() {
            this._streak++;
        }

        /** 失败一个分片 */
        _noteFailure() {
            this._streak = 0;
            this._recentFailures.push(Date.now());
        }

        /**
         * 一次分片结束后的统计与并发调整
         * @param {boolean} ok
         * @param {number} startedAt
         * @param {number} size
         */
        _settle(ok, startedAt, size) {
            this.completed++;
            this._settled++;

            if (!this.adaptive || !this._gate) {
                this.tick();
                return;
            }

            if (ok && startedAt && size > 0) {
                const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
                const instant = size / seconds;
                this._ewmaSpeed = this._ewmaSpeed === 0
                    ? instant
                    : this._ewmaSpeed * 0.7 + instant * 0.3;
            }

            const cutoff = Date.now() - 10000;
            while (this._recentFailures.length > 0 && this._recentFailures[0] < cutoff) {
                this._recentFailures.shift();
            }

            if (this._settled % this.adaptWindow !== 0) {
                this.tick();
                return;
            }

            const current = this._gate.capacity;

            // 冷却期间禁止升并发 —— 刚被限流就马上加回去只会再撞一次
            if (this._cooldownUntil > Date.now()) {
                this.tick();
                return;
            }

            if (this._recentFailures.length >= 2 && current > this.minThreads) {
                // 连续撞墙，先退一步，别让失败拖垮整个任务
                this._gate.setCapacity(Math.max(this.minThreads, Math.floor(current / 2)));
                this._recentFailures.length = 0;
            } else if (this._recentFailures.length === 0 &&
                this._streak >= (this.slowStart ? this.adaptWindow : this.adaptWindow * 2) &&
                current < this._effectiveMax) {
                // 一路顺风，加一档。慢启动时加得快一些，尽快摸到合适并发
                this._gate.setCapacity(current + 1);
            }

            this.tick();
        }

        /**
         * 进度上报（节流到约 4 次/秒，完成时必定上报一次）
         */
        tick() {
            const now = Date.now();
            const done = this.completed >= this.segments.length;

            if (!done && now - this.lastTickTime < 250) return;

            const elapsed = this.startTime > 0 ? (now - this.startTime) / 1000 : 0;
            const speed = this._currentSpeed();

            this.onProgress({
                completed: this.completed,
                total: this.segments.length,
                bytes: this.bytes,
                percent: this.segments.length > 0
                    ? Math.min(100, Math.round((this.completed / this.segments.length) * 100))
                    : 0,
                speed: speed,
                avgSpeed: elapsed > 0 ? this.bytes / elapsed : 0,
                eta: this._estimateEta(speed),
                elapsed: elapsed,
                failed: this.failed.length,
                active: this._gate ? this._gate.active : 0,
                concurrency: this._gate ? this._gate.capacity : this.threads,
                throttled: this._throttleEvents,
                retrying: this.throttledRetries
            });

            this.lastTickTime = now;
            this.lastTickBytes = this.bytes;
        }

        /** 最近两秒的瞬时速度 */
        _currentSpeed() {
            this._pruneSamples();

            if (this._samples.length === 0) return this._ewmaSpeed;

            let bytes = 0;
            for (const sample of this._samples) bytes += sample.size;

            const first = this._samples[0];
            const span = Math.max(0.25, (Date.now() - first.time) / 1000);

            return bytes / span;
        }

        /**
         * 估算剩余时间（秒），取不到返回 0
         * @param {number} speed
         * @returns {number}
         */
        _estimateEta(speed) {
            if (!(speed > 0)) return 0;

            const remaining = this.segments.length - this.completed;
            if (remaining <= 0) return 0;

            // 用已完成分片的平均体积推算，比按总数平摊更贴近实际
            let doneBytes = 0;
            let doneCount = 0;
            for (const item of this.results) {
                if (item && item.size > 0) {
                    doneBytes += item.size;
                    doneCount++;
                }
            }

            const avg = doneCount > 0 ? doneBytes / doneCount : 0;
            const left = avg > 0 ? avg * remaining : 0;

            return left > 0 ? Math.ceil(left / speed) : 0;
        }

        // ============================================================
        // 调度
        // ============================================================

        /** 工作协程：从共享队列取任务 */
        async worker(queue) {
            while (!this.aborted && !this._stopped()) {
                await this._gate.acquire();

                if (this.aborted || this._stopped()) {
                    this._gate.release();
                    return;
                }

                const segment = queue.shift();
                if (!segment) {
                    this._gate.release();
                    return;
                }

                try {
                    await this.downloadWithRetry(segment);
                } catch (e) {
                    // downloadWithRetry 自己已经兜住了异常，
                    // 这里只是防止意外的抛出把并发槽漏掉
                    console.error('[鲸吞] 分片任务异常:', e);
                } finally {
                    this._gate.release();
                }
            }
        }

        /**
         * 开始下载
         * @returns {Promise<{ok: boolean, parts: Array<Blob>, failed: Array, aborted: boolean, bytes: number, elapsed: number, avgSpeed: number}>}
         */
        async start() {
            if (this.segments.length === 0) {
                return {
                    ok: false, parts: [], failed: [], aborted: false,
                    bytes: 0, elapsed: 0, avgSpeed: 0
                };
            }

            // 允许 abort 之后重新 start：所有运行状态都要复位，
            // 否则会沿用上一次已经 abort 的控制器
            this.results = new Array(this.segments.length);
            this.completed = 0;
            this.failed = [];
            this.bytes = 0;
            this.aborted = false;
            this.abortReason = '';
            this._samples = [];
            this._recentFailures = [];
            this._streak = 0;
            this._settled = 0;
            this._ewmaSpeed = 0;
            this.cacheHits = 0;

            // 限流状态也要复位 —— 上次跑被限过不代表这次还被限
            this._throttleStreak = 0;
            this._cooldownUntil = 0;
            this._throttleEvents = 0;
            this.throttledRetries = 0;
            this._effectiveMax = this.maxThreads;

            // 断点续传：先算出任务指纹。指纹算不出来就安静地关掉，
            // 不能让缓存问题挡住下载本身
            this._cacheJobId = '';
            if (this.resume && this.resumeId &&
                typeof JTCache !== 'undefined' && JTCache.isSupported) {
                try {
                    if (await JTCache.isSupported()) {
                        this._cacheJobId = await JTCache.jobId(
                            this.resumeId, this.resumeFingerprint);
                    }
                } catch (e) {
                    console.warn('[鲸吞] 断点续传不可用:', e.message);
                }
            }

            if (this.externalSignal && this.externalSignal.aborted) {
                this.aborted = true;
                this.abortReason = '已取消';
                return this._result();
            }

            this.controller = new AbortController();
            linkAbort(this.externalSignal, this.controller);

            this._computeEffectiveMax();

            // 慢启动：先用 2 路试探服务器，顺利的话 _settle 会快速加档。
            // 一上来就开 16 路是很多反爬站点直接封 IP 的诱因。
            const requested = Math.max(this.minThreads,
                Math.min(this.threads, this._effectiveMax));

            // 慢启动不适用于「自适应关闭」的场景：
            // 调用方明确要固定并发，我们就不该偷偷改
            const startConcurrency = (this.slowStart && this.adaptive)
                ? Math.max(this.minThreads, Math.min(2, requested))
                : requested;

            this._gate = new DynamicGate(startConcurrency);
            this._running = true;

            this.startTime = Date.now();
            this.lastTickTime = this.startTime;
            this.lastTickBytes = 0;

            // 初始化队列（按 index 升序，保证有序推进）
            const queue = this.segments.slice().sort((a, b) => a.index - b.index);

            // 启动工作协程。并发上限由闸门控制，
            // 这里多起一些协程只是让它们排队等名额
            const workers = [];
            const workerCount = Math.max(startConcurrency, Math.min(this.maxThreads, queue.length));
            for (let i = 0; i < workerCount; i++) {
                workers.push(this.worker(queue));
            }

            await Promise.all(workers);

            this._running = false;
            this.tick();

            return this._result();
        }

        /**
         * 汇总本次运行的结果
         * @returns {Object}
         */
        _result() {
            const parts = this.results.filter((item) => item !== null && item !== undefined);
            const elapsed = this.startTime > 0 ? (Date.now() - this.startTime) / 1000 : 0;

            return {
                ok: this.failed.length === 0 && !this.aborted,
                parts: parts,
                failed: this.failed,
                aborted: this.aborted,
                abortReason: this.abortReason,
                bytes: this.bytes,
                elapsed: elapsed,
                avgSpeed: elapsed > 0 ? this.bytes / elapsed : 0,
                concurrency: this._gate ? this._gate.capacity : this.threads,
                cacheHits: this.cacheHits,
                cacheJobId: this._cacheJobId,
                throttled: this._throttleEvents,
                throttledRetries: this.throttledRetries
            };
        }

        /**
         * 重试失败的分片
         * @returns {Promise<Object>} 与 start() 相同的结构
         */
        async retryFailed() {
            const collected = () => this.results.filter((item) => item !== null && item !== undefined);

            if (this.failed.length === 0) {
                return {
                    ok: true, parts: collected(), failed: [], aborted: false,
                    bytes: this.bytes, elapsed: 0, avgSpeed: 0
                };
            }

            const retryList = this.failed.slice();
            this.failed = [];

            // 复位失败项，让它们重新参与下载
            for (const item of retryList) {
                this.results[item.segment.index] = null;
            }

            // 失败时 completed 也加了 1（表示「处理完」），重试前要扣掉
            this.completed = Math.max(0, this.completed - retryList.length);

            // 上一次的 controller 可能已被 abort，换一个新的
            this.aborted = false;
            this.abortReason = '';
            this.controller = new AbortController();
            linkAbort(this.externalSignal, this.controller);

            this._recentFailures = [];
            this._streak = 0;

            this._computeEffectiveMax();

            const concurrency = Math.max(
                this.minThreads,
                Math.min(this._gate ? this._gate.capacity : this.threads, this._effectiveMax)
            );

            this._gate = new DynamicGate(concurrency);
            this._running = true;

            const queue = retryList.map((item) => item.segment);
            const workers = [];
            const count = Math.min(concurrency, queue.length);

            for (let i = 0; i < count; i++) {
                workers.push(this.worker(queue));
            }
            await Promise.all(workers);

            this._running = false;
            this.tick();

            return {
                ok: this.failed.length === 0 && !this.aborted,
                parts: collected(),
                failed: this.failed,
                aborted: this.aborted,
                abortReason: this.abortReason,
                bytes: this.bytes,
                elapsed: 0,
                avgSpeed: 0,
                concurrency: this._gate ? this._gate.capacity : concurrency
            };
        }

        /** 中断下载 */
        abort(reason) {
            this.aborted = true;
            this.abortReason = reason || '已取消';
            try {
                if (this.controller) this.controller.abort();
            } catch (e) { /* 忽略 */ }
        }

        /**
         * 释放已下载的数据。合并完成后调用，
         * 否则几 GB 的 Blob 会一直挂在内存里。
         */
        dispose() {
            this.results = [];
            this.keyCache.clear();
            this.keyPending.clear();
            this._samples = [];
            this._recentFailures = [];
        }

        /**
         * 把下载结果合并为一个 Blob
         * @param {Array<ArrayBuffer|Blob>} parts
         * @param {string} mimeType
         * @returns {Blob}
         */
        static merge(parts, mimeType) {
            return new Blob(parts, { type: mimeType || 'video/mp2t' });
        }

        /**
         * 给单个大文件规划分段，用于多线程按 Range 下载。
         * 返回的分片列表可以直接喂给本类。
         * @param {string} url
         * @param {number} size 文件总字节数
         * @param {number} [chunkSize] 每段大小，默认 8 MB
         * @param {Object} [options] 额外的分片属性（例如 headers）
         * @returns {Array<Object>}
         */
        static buildRangePlan(url, size, chunkSize, options) {
            const total = Number(size) || 0;
            const chunk = Math.max(64 * 1024, Number(chunkSize) || 8 * 1024 * 1024);

            if (total <= 0) {
                return [Object.assign({
                    index: 0,
                    url: url,
                    duration: 0,
                    title: '',
                    byteRange: { offset: 0, length: 0 },
                    key: null,
                    sequence: 0
                }, options || {}, { byteRange: null })];
            }

            const segments = [];
            let index = 0;

            for (let offset = 0; offset < total; offset += chunk) {
                const length = Math.min(chunk, total - offset);
                segments.push(Object.assign({
                    index: index++,
                    url: url,
                    duration: 0,
                    title: '',
                    byteRange: { offset: offset, length: length },
                    key: null,
                    sequence: 0
                }, options || {}));
            }

            return segments;
        }

        /**
         * 取远端文件大小：先 HEAD，失败再用 Range 探一次
         * @param {string} url
         * @param {Object} [options] { headers, credentials, timeout }
         * @returns {Promise<number>} 取不到返回 0
         */
        static async probeSize(url, options) {
            const opts = options || {};
            const headers = cleanHeaders(opts.headers);
            const credentials = opts.credentials || 'include';
            const timeout = opts.timeout > 0 ? opts.timeout : 15000;

            const attempt = async (init) => {
                const child = new AbortController();
                const timer = setTimeout(() => child.abort(), timeout);
                try {
                    return await fetch(url, Object.assign({ signal: child.signal }, init));
                } finally {
                    clearTimeout(timer);
                }
            };

            try {
                const head = await attempt({
                    method: 'HEAD',
                    headers: headers,
                    credentials: credentials,
                    cache: 'no-store'
                });

                const length = parseInt(head.headers.get('content-length') || '0', 10);
                if (length > 0) return length;
            } catch (e) {
                // HEAD 不受支持是常事，继续用 Range 探
            }

            try {
                const ranged = await attempt({
                    headers: Object.assign({}, headers, { Range: 'bytes=0-0' }),
                    credentials: credentials,
                    cache: 'no-store'
                });

                const contentRange = ranged.headers.get('content-range') || '';
                const total = parseInt(contentRange.split('/').pop() || '0', 10);
                if (total > 0) return total;

                // 有的服务器对 Range 也回 200，那就只能拿到整个长度
                const length = parseInt(ranged.headers.get('content-length') || '0', 10);
                if (ranged.status === 200 && length > 0) return length;
            } catch (e) {
                // 两种方式都失败
            }

            return 0;
        }

        /** 解析 Retry-After 头（对外暴露，方便测试与其他模块复用） */
        static parseRetryAfter(value) {
            return parseRetryAfter(value);
        }

        /** 某个状态码是否值得重试 */
        static isRetryableStatus(status) {
            return RETRYABLE_STATUS.has(status);
        }

        /** 过滤请求头（对外暴露） */
        static cleanHeaders(headers) {
            return cleanHeaders(headers);
        }
    }

    /**
     * 延时
     * @param {number} ms
     * @returns {Promise<void>}
     */
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    return {
        Downloader,
        DEFAULTS,
        HttpError,
        RangeMismatchError
    };
})();