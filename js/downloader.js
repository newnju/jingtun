/** 鲸吞：多线程分片下载器 */
var JTDownloader = (function () {
    'use strict';

    /** 默认配置 */
    const DEFAULTS = {
        threads: 4,
        retries: 3,
        retryDelay: 800,
        timeout: 30000
    };

    class Downloader {
        /**
         * @param {Array} segments 分片列表（来自 JTM3u8.parse）
         * @param {Object} [options]
         */
        constructor(segments, options) {
            const opts = Object.assign({}, DEFAULTS, options || {});

            this.segments = Array.isArray(segments) ? segments : [];
            this.threads = Math.max(1, Math.min(opts.threads, 16));
            this.retries = opts.retries;
            this.retryDelay = opts.retryDelay;
            this.timeout = opts.timeout;

            /** 附加请求头（取自嗅探时捕获的请求） */
            this.headers = opts.headers && typeof opts.headers === 'object' ? opts.headers : null;

            /** 备用密钥（Array<number> 或 null） */
            this.keyFallback = opts.keyFallback || null;

            /** 结果按索引存放，保证顺序 */
            this.results = new Array(this.segments.length);
            /** 密钥缓存：uri -> ArrayBuffer */
            this.keyCache = new Map();

            this.completed = 0;
            this.failed = [];
            this.bytes = 0;
            this.aborted = false;
            this.controller = new AbortController();

            this.onProgress = opts.onProgress || function () {};
            this.onSegmentDone = opts.onSegmentDone || function () {};
            this.onError = opts.onError || function () {};

            this.startTime = 0;
            this.lastTickTime = 0;
            this.lastTickBytes = 0;
        }

        /** 获取密钥（带缓存） */
        async getKey(uri) {
            if (this.keyCache.has(uri)) {
                return this.keyCache.get(uri);
            }

            const keyInit = { signal: this.controller.signal, credentials: 'include' };
            if (this.headers) keyInit.headers = this.headers;

            try {
                const response = await fetch(uri, keyInit);
                if (!response.ok) {
                    throw new Error(`密钥请求失败 HTTP ${response.status}`);
                }
                const buffer = await response.arrayBuffer();

                if (buffer.byteLength !== 16) {
                    throw new Error(`密钥长度异常：期望 16 字节，实际 ${buffer.byteLength}`);
                }

                this.keyCache.set(uri, buffer);
                return buffer;
            } catch (e) {
                // 请求不到时，退回到页面里捞到的密钥。
                // 这不是「猜」， 它就是从同一个页面上抓下来的真密钥。
                if (this.keyFallback && this.keyFallback.length === 16) {
                    console.warn('[鲸吞] 密钥请求失败，改用页面捕获的密钥:', e.message);
                    const buffer = new Uint8Array(this.keyFallback).buffer;
                    this.keyCache.set(uri, buffer);
                    return buffer;
                }
                throw e;
            }
        }

        /**
         * 下载并解密单个分片
         * @param {Object} segment
         * @returns {Promise<ArrayBuffer>}
         */
        async fetchSegment(segment) {
            const init = { signal: this.controller.signal, credentials: 'include' };
            if (this.headers) init.headers = Object.assign({}, this.headers);

            // 字节范围请求
            if (segment.byteRange) {
                const start = segment.byteRange.offset;
                const end = start + segment.byteRange.length - 1;
                init.headers = Object.assign({}, init.headers, {
                    Range: `bytes=${start}-${end}`
                });
            }

            const response = await fetch(segment.url, init);
            if (!response.ok && response.status !== 206) {
                throw new Error(`HTTP ${response.status}`);
            }

            let buffer = await response.arrayBuffer();

            // AES-128 解密
            if (segment.key && segment.key.method === 'AES-128' && segment.key.uri) {
                const key = await this.getKey(segment.key.uri);
                buffer = await JTM3u8.decryptAes128(
                    buffer,
                    key,
                    segment.key.iv,
                    segment.sequence
                );
            }

            return buffer;
        }

        /**
         * 带重试地下载一个分片
         * @param {Object} segment
         */
        async downloadWithRetry(segment) {
            let lastError = null;

            for (let attempt = 0; attempt <= this.retries; attempt++) {
                if (this.aborted) return;

                try {
                    const buffer = await this.fetchSegment(segment);
                    this.results[segment.index] = buffer;
                    this.completed++;
                    this.bytes += buffer.byteLength;

                    this.onSegmentDone(segment, this.completed, this.segments.length);
                    this.tick();
                    return;
                } catch (e) {
                    lastError = e;
                    if (this.aborted) return;

                    // 最后一次尝试失败则记录
                    if (attempt === this.retries) break;

                    // 指数退避
                    const delay = this.retryDelay * Math.pow(1.6, attempt);
                    await sleep(delay);
                }
            }

            this.failed.push({ segment: segment, error: lastError });
            this.onError(segment, lastError);
            // 占位，保证索引对齐（合并时会跳过空项）
            this.results[segment.index] = null;
            this.completed++;
            this.tick();
        }

        /** 工作协程：从共享队列取任务 */
        async worker(queue) {
            while (queue.length > 0 && !this.aborted) {
                const segment = queue.shift();
                await this.downloadWithRetry(segment);
            }
        }

        /** 进度上报（节流到约 4 次/秒） */
        tick() {
            const now = Date.now();
            if (now - this.lastTickTime < 250 && this.completed < this.segments.length) {
                return;
            }

            const elapsed = (now - this.startTime) / 1000;
            const recentElapsed = (now - this.lastTickTime) / 1000;
            const recentBytes = this.bytes - this.lastTickBytes;

            this.onProgress({
                completed: this.completed,
                total: this.segments.length,
                bytes: this.bytes,
                percent: this.segments.length > 0
                    ? Math.round((this.completed / this.segments.length) * 100)
                    : 0,
                speed: recentElapsed > 0 ? recentBytes / recentElapsed : 0,
                elapsed: elapsed,
                failed: this.failed.length
            });

            this.lastTickTime = now;
            this.lastTickBytes = this.bytes;
        }

        /**
         * 开始下载
         * @returns {Promise<{ok: boolean, parts: Array<ArrayBuffer>, failed: Array, aborted: boolean}>}
         */
        async start() {
            if (this.segments.length === 0) {
                return { ok: false, parts: [], failed: [], aborted: false };
            }

            this.startTime = Date.now();
            this.lastTickTime = this.startTime;
            this.lastTickBytes = 0;

            // 初始化队列（按 index 升序，保证有序推进）
            const queue = this.segments.slice().sort((a, b) => a.index - b.index);

            // 启动工作协程
            const workers = [];
            for (let i = 0; i < this.threads; i++) {
                workers.push(this.worker(queue));
            }

            await Promise.all(workers);

            // 过滤掉失败的空位
            const parts = this.results.filter((item) => item !== null && item !== undefined);

            this.tick();

            return {
                ok: this.failed.length === 0,
                parts: parts,
                failed: this.failed,
                aborted: this.aborted
            };
        }

        /**
         * 重试失败的分片
         * @returns {Promise<Object>} 与 start() 相同的结构
         */
        async retryFailed() {
            const collected = () => this.results.filter((item) => item !== null && item !== undefined);

            if (this.failed.length === 0) {
                return { ok: true, parts: collected(), failed: [], aborted: false };
            }

            const retryList = this.failed.slice();
            this.failed = [];

            // 复位失败项，让它们重新参与下载
            for (const item of retryList) {
                this.results[item.segment.index] = null;
            }

            // 失败时 completed 也加了 1（表示"处理完"），重试前要扣掉
            this.completed = Math.max(0, this.completed - retryList.length);

            // 上一次的 controller 可能已被 abort，换一个新的
            this.aborted = false;
            this.controller = new AbortController();

            const queue = retryList.map((item) => item.segment);
            const workers = [];
            const count = Math.min(this.threads, queue.length);

            for (let i = 0; i < count; i++) {
                workers.push(this.worker(queue));
            }
            await Promise.all(workers);

            this.tick();

            return {
                ok: this.failed.length === 0,
                parts: collected(),
                failed: this.failed,
                aborted: this.aborted
            };
        }

        /** 中断下载 */
        abort() {
            this.aborted = true;
            try {
                this.controller.abort();
            } catch (e) { /* 忽略 */ }
        }

        /**
         * 把下载结果合并为一个 Blob
         * @param {Array<ArrayBuffer>} parts
         * @param {string} mimeType
         * @returns {Blob}
         */
        static merge(parts, mimeType) {
            return new Blob(parts, { type: mimeType || 'video/mp2t' });
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
        DEFAULTS
    };
})();
