/** 鲸吞：深度搜索脚本（注入至页面 MAIN world） */
(function __JINGTUN_DEEP_SEARCH__() {
    'use strict';

    const SELF = typeof self !== 'undefined' ? self : this;
    const IS_WORKER = typeof WorkerGlobalScope !== 'undefined' && SELF instanceof WorkerGlobalScope;

    /** 防止重复注入 */
    if (SELF.__JINGTUN_DEEP_SEARCH__ && !IS_WORKER) return;
    SELF.__JINGTUN_DEEP_SEARCH__ = true;

    /**
     * 保证某个 hook 只应用一次
     * @param {string} name hook 名称
     * @returns {boolean} true 表示这是第一次应用
     */
    /** 取一条文案（字典由 i18n.js 先注入） */
    function t(key, params, fallback) {
        const dict = SELF.__JINGTUN_I18N__;
        if (dict && typeof dict.get === 'function') return dict.get(key, params);
        return fallback || key;
    }
    function firstTime(name) {
        const flag = '__JT_HOOK_' + name + '__';
        if (SELF[flag]) return false;
        SELF[flag] = true;
        return true;
    }

    // ============================================================
    // 配置
    // ============================================================

    const MAX_DEPTH = 20;                 // 对象遍历深度上限
    const MAX_JSON_SIZE = 2 * 1024 * 1024; // 超过此体积的响应不解析（2MB）
    const MAX_STRINGS_PER_SCAN = 500;      // 单次扫描最多处理的字符串数
    /** 单个响应体的读取上限。 */
    const MAX_BODY_SIZE = 4 * 1024 * 1024;

    /** 媒体资源扩展名 */
    const MEDIA_EXT_RE = /\.(m3u8|m3u|mpd|mp4|m4v|m4s|ts|flv|f4v|hlv|mkv|webm|mov|avi|wmv|asf|ogv|3gp|mp3|m4a|aac|wav|wma|ogg|oga|opus|flac|weba|srt|vtt|ass)(?:[?#]|$)/i;

    /** 页面地址，作为清单相对路径的回退基准 */
    function pageBase() {
        return SELF.location ? SELF.location.href : '';
    }

    /** 原生的 atob */
    const nativeAtob = (typeof SELF.atob === 'function') ? SELF.atob.bind(SELF) : null;

    /**
     * 判断一个字符串是不是 base64 编码的 m3u8
     * @param {string} value
     * @returns {boolean}
     */
    function looksLikeBase64M3u8(value) {
        if (!nativeAtob) return false;
        if (value.length < 16 || value.length % 4 !== 0) return false;
        // 快速排除：不在 base64 字符集里的直接出局
        if (!/^[A-Za-z0-9+/]{12}/.test(value)) return false;

        try {
            return nativeAtob(value.slice(0, 12)).slice(0, 7) === '#EXTM3U';
        } catch (e) {
            return false;
        }
    }

    /**
     * 处理 data URL 形式的清单
     * @param {string} url
     */
    function handleDataUrl(url) {
        const commaIndex = url.indexOf(',');
        if (commaIndex === -1) return;

        const meta = url.slice(5, commaIndex);      // 去掉 'data:'
        const payload = url.slice(commaIndex + 1);

        // 只关心清单类型，图片之类的 data URL 不碰
        if (meta.indexOf('mpegurl') === -1 && meta.indexOf('m3u8') === -1 &&
            meta.indexOf('dash+xml') === -1) {
            return;
        }

        let text = payload;
        if (/;base64/i.test(meta)) {
            try {
                text = atob(payload);
            } catch (e) {
                return;
            }
        } else {
            try {
                text = decodeURIComponent(payload);
            } catch (e) {
                // 不是百分号编码，按原样处理
            }
        }

        if (text.slice(0, 7).toUpperCase() === '#EXTM3U') {
            handleInlineM3u8(text, pageBase());
        } else if (text.indexOf('<MPD') !== -1) {
            handleInlineMpd(text, pageBase());
        }
    }

    /** 停止标志 */
    let stopped = false;

    /** 已上报过的地址 */
    const reportedUrls = new Set();

    /** 去重集合的上限，超出就清空重来，避免长驻页面把内存撑爆 */
    const MAX_REPORTED_URLS = 2000;

    /** 32 个十六进制字符 */
    const HEX_KEY_RE = /^[0-9a-fA-F]{32}$/;

    /** 本脚本自身的源码，用于向 Worker 内递归注入。 */
    const SELF_SOURCE = '(' + __JINGTUN_DEEP_SEARCH__.toString() + ')();';

    // ============================================================
    // 上报
    // ============================================================

    /** 原生的 postMessage */
    const nativePostMessage = (typeof SELF.postMessage === 'function')
        ? SELF.postMessage.bind(SELF)
        : null;

    /**
     * 上报数据到内容脚本
     * @param {string} action
     * @param {Object} payload
     */
    function report(action, payload) {
        if (stopped || !nativePostMessage) return;

        try {
            const message = { action: action, payload: payload };

            if (IS_WORKER) {
                nativePostMessage(message);
            } else {
                nativePostMessage(message, SELF.location.origin);
            }
        } catch (e) {
            // 跨域等场景下可能失败，忽略
        }
    }

    /**
     * 上报发现的媒体资源
     * @param {string} url
     * @param {string} [source]
     * @param {string} [mime]
     */
    function reportMedia(url, source, mime) {
        if (!url || typeof url !== 'string') return;
        if (url.length > 4096) return;

        // 补全成绝对地址。
        let fullUrl = url;
        if (!/^(https?|blob|data):/i.test(url)) {
            try {
                fullUrl = new URL(url, SELF.location.href).href;
            } catch (e) {
                return;   // 解析不出来说明不是有效地址，直接丢掉
            }
        }

        const extMatch = fullUrl.match(MEDIA_EXT_RE);
        const ext = extMatch ? extMatch[1].toLowerCase() : '';

        // 去重：同一个地址在页面上可能被请求几十次，
        // 不去重会让列表里全是重复项。
        if (reportedUrls.has(fullUrl)) return;

        // 防止长时间停留的页面把 Set 撑爆
        if (reportedUrls.size > MAX_REPORTED_URLS) reportedUrls.clear();
        reportedUrls.add(fullUrl);

        report('jt:addMedia', {
            url: fullUrl,
            ext: ext,
            mime: mime || '',
            source: source || 'deep-search',
            href: SELF.location.href
        });
    }

    // ============================================================
    // 对象扫描
    // ============================================================

    /** 已扫描过的对象（WeakSet 避免重复处理与内存泄漏） */
    const scannedObjects = new WeakSet();

    /**
     * 递归扫描对象，寻找媒体 URL 与密钥
     * @param {*} data
     * @param {number} [depth]
     */
    function scanObject(data, depth) {
        if (stopped) return;
        if (!data) return;
        depth = depth || 0;
        if (depth > MAX_DEPTH) return;

        // 密钥识别：16 字节数组（AES-128）
        if (Array.isArray(data) && data.length === 16) {
            const isKey = data.every((v) => typeof v === 'number' && v >= 0 && v <= 255);
            if (isKey) {
                report('jt:addKey', {
                    key: data,
                    href: SELF.location.href
                });
                return;
            }
        }

        if (typeof data !== 'object') return;

        // WeakSet 去重：同一引用只处理一次
        if (scannedObjects.has(data)) return;
        try {
            scannedObjects.add(data);
        } catch (e) {
            // 某些宿主对象不可加入 WeakSet
            return;
        }

        let stringCount = 0;

        for (const key in data) {
            if (stopped) return;
            if (!Object.prototype.hasOwnProperty.call(data, key)) continue;

            let value;
            try {
                value = data[key];
            } catch (e) {
                continue;   // getter 抛错时跳过
            }

            if (typeof value === 'object' && value !== null) {
                scanObject(value, depth + 1);
                continue;
            }

            if (typeof value !== 'string') continue;

            // 单次扫描的字符串数量上限，避免长任务
            if (++stringCount > MAX_STRINGS_PER_SCAN) return;

            // 明文 m3u8 内容
            if (value.length > 7 && value.slice(0, 7).toUpperCase() === '#EXTM3U') {
                handleInlineM3u8(value, pageBase());
                continue;
            }

            // base64 编码的 m3u8
            if (looksLikeBase64M3u8(value)) {
                handleBase64M3u8(value, pageBase());
                continue;
            }

            // data URL 形式的清单：data:application/vnd.apple.mpegurl;base64,xxx
            if (value.length > 20 && value.indexOf('data:') === 0) {
                handleDataUrl(value);
                continue;
            }

            // DASH 清单
            if (value.length > 30 && value.toLowerCase().includes('urn:mpeg:dash:schema:mpd')) {
                handleInlineMpd(value, pageBase());
                continue;
            }

            // 普通 URL
            if (value.length > 8 && value.length < 4096 && MEDIA_EXT_RE.test(value)) {
                reportMedia(value, 'deep-search');
            }
        }
    }

    /**
     * 把相对地址补成绝对地址
     * @param {string} base
     * @param {string} rel
     * @returns {string}
     */
    function resolveUrl(base, rel) {
        if (!rel) return rel;
        if (/^https?:\/\//i.test(rel) || rel.indexOf('data:') === 0 || rel.indexOf('blob:') === 0) {
            return rel;
        }
        try {
            return new URL(rel, base).href;
        } catch (e) {
            return rel;
        }
    }

    /**
     * 把内联清单里的相对路径补全
     * @param {string} text 清单原文
     * @param {string} baseUrl 清单的来源地址
     * @returns {string}
     */
    function resolveInlineUrls(text, baseUrl) {
        if (!baseUrl || !text) return text;

        const lines = String(text).split(/\r?\n/);
        const out = [];

        for (const line of lines) {
            const trimmed = line.trim();

            if (!trimmed) {
                out.push(line);
                continue;
            }

            if (trimmed.charAt(0) === '#') {
                // EXT-X-KEY / EXT-X-MAP 的 URI 属性也要补全，
                // 否则解密密钥和初始化段都取不到
                if (/^#EXT-X-(KEY|MAP)/i.test(trimmed) && /URI="/i.test(trimmed)) {
                    out.push(trimmed.replace(/URI="([^"]*)"/i, function (m, uri) {
                        return 'URI="' + resolveUrl(baseUrl, uri) + '"';
                    }));
                } else {
                    out.push(line);
                }
                continue;
            }

            out.push(resolveUrl(baseUrl, trimmed));
        }

        return out.join('\n');
    }

    /**
     * 处理内联的 m3u8 文本
     * @param {string} text
     * @param {string} [baseUrl] 清单来源地址
     */
    function handleInlineM3u8(text, baseUrl) {
        try {
            const resolved = resolveInlineUrls(text, baseUrl);
            // 没有来源地址时（纯内联在页面脚本里）只能靠文本本身，
            // 给一个可读的占位地址方便识别
            const url = baseUrl || ('inline://m3u8/' + Date.now());

            report('jt:addMedia', {
                url: url,
                ext: 'm3u8',
                mime: 'application/vnd.apple.mpegurl',
                source: 'inline-m3u8',
                href: SELF.location.href,
                inlineText: resolved
            });
        } catch (e) {
            // 忽略
        }
    }

    /**
     * 处理 base64 编码的 m3u8
     * @param {string} encoded
     * @param {string} [baseUrl]
     */
    function handleBase64M3u8(encoded, baseUrl) {
        try {
            const decoded = atob(encoded);
            if (decoded.slice(0, 7).toUpperCase() === '#EXTM3U') {
                handleInlineM3u8(decoded, baseUrl);
            }
        } catch (e) {
            // 不是合法 base64，忽略
        }
    }

    /**
     * 处理内联的 MPD 清单
     * @param {string} text
     * @param {string} [baseUrl]
     */
    function handleInlineMpd(text, baseUrl) {
        try {
            const url = baseUrl || ('inline://mpd/' + Date.now());
            report('jt:addMedia', {
                url: url,
                ext: 'mpd',
                mime: 'application/dash+xml',
                source: 'inline-mpd',
                href: SELF.location.href,
                inlineText: resolveInlineUrls(text, baseUrl)
            });
        } catch (e) {
            // 忽略
        }
    }

    /**
     * 检查二进制响应里是否藏着 AES 密钥
     * @param {ArrayBuffer} buffer
     */
    function checkBinaryForKey(buffer) {
        if (!buffer || typeof buffer.byteLength !== 'number') return;
        if (buffer.byteLength !== 16) return;

        const view = new Uint8Array(buffer);

        // MP4 的 ftyp box：第 4~7 字节是 'ftyp'
        if (view[4] === 0x66 && view[5] === 0x74 &&
            view[6] === 0x79 && view[7] === 0x70) return;

        // 全同值（全零最常见）不是有意义的密钥
        for (let i = 1; i < 16; i++) {
            if (view[i] !== view[0]) {
                report('jt:addKey', {
                    key: Array.from(view),
                    href: SELF.location.href
                });
                return;
            }
        }
    }

    /**
     * 把一段 16 字节数据当密钥上报
     * @param {ArrayBuffer|ArrayBufferView} data
     */
    function reportKeyBytes(data) {
        if (!data) return;

        let buffer;
        try {
            if (data instanceof ArrayBuffer) {
                buffer = data;
            } else if (data.buffer instanceof ArrayBuffer) {
                // 视图可能只是整个 buffer 的一段，要按视图范围切出来
                buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            } else {
                return;
            }
        } catch (e) {
            return;
        }

        if (buffer.byteLength !== 16) return;
        checkBinaryForKey(buffer);
    }

    /**
     * 判断一个字符串是不是 16 字节的 base64
     * @param {string} value
     * @returns {boolean}
     */
    function looksLikeBase64Key(value) {
        return typeof value === 'string' &&
            value.length === 24 &&
            value.slice(22) === '==';
    }

    /**
     * 从重复模式中提取出单元
     * @param {ArrayBuffer|ArrayBufferView} data
     * @param {number} unit 单元长度
     * @returns {ArrayBuffer|null} 重复的那个单元；不是重复则返回 null
     */
    function extractRepeatedUnit(data, unit) {
        let view;
        try {
            view = data instanceof Uint8Array
                ? data
                : new Uint8Array(data.buffer || data);
        } catch (e) {
            return null;
        }

        if (view.length < unit || view.length % unit !== 0) return null;

        const first = view.slice(0, unit);

        for (let i = unit; i < view.length; i += unit) {
            for (let j = 0; j < unit; j++) {
                if (view[i + j] !== first[j]) return null;
            }
        }

        return first.buffer;
    }

    /**
     * 将扫描任务放到空闲时段执行
     * @param {Function} task
     */
    function scheduleScan(task) {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(task, { timeout: 1000 });
        } else {
            setTimeout(task, 0);
        }
    }

    // ============================================================
    // Hook 1：JSON.parse
    // ============================================================

    (function hookJSONParse() {
        if (!firstTime('jsonParse')) return;
        const original = JSON.parse;
        if (!original) return;

        const patched = function () {
            const result = original.apply(this, arguments);
            try {
                scheduleScan(() => scanObject(result, 0));
            } catch (e) {
                // 扫描失败不能影响页面正常的 JSON 解析
            }
            return result;
        };

        // 伪装成原生函数，降低被检测的概率
        patched.toString = function () {
            return original.toString();
        };

        JSON.parse = patched;
    })();

    // ============================================================
    // Hook 2：XMLHttpRequest
    // ============================================================

    (function hookXHR() {
        if (!firstTime('xhr')) return;
        if (typeof XMLHttpRequest === 'undefined') return;

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url) {
            try {
                this.__jt_url = url;
            } catch (e) { /* 忽略 */ }
            return originalOpen.apply(this, arguments);
        };

        // 反检测：页面若拿 open.toString() 看是不是原生实现，
        // 直接替换的函数会把扩展源码暴露出去
        XMLHttpRequest.prototype.open.toString = function () {
            return originalOpen.toString();
        };

        XMLHttpRequest.prototype.send = function () {
            try {
                // 挂 readystatechange 而不是 load：
                this.addEventListener('readystatechange', function () {
                    if (this.readyState !== 4) return;
                    try {
                        handleXhrResponse(this);
                    } catch (e) { /* 忽略 */ }
                });
            } catch (e) { /* 忽略 */ }
            return originalSend.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send.toString = function () {
            return originalSend.toString();
        };

        /**
         * 处理 XHR 响应
         * @param {XMLHttpRequest} xhr
         */
        function handleXhrResponse(xhr) {
            const url = xhr.__jt_url || '';
            let contentType = '';
            try {
                contentType = (xhr.getResponseHeader('content-type') || '').toLowerCase();
            } catch (e) { /* 忽略 */ }

            // 优先从 URL 直接识别（最廉价）
            if (MEDIA_EXT_RE.test(url)) {
                reportMedia(url, 'xhr', contentType);
            }

            let responseType = '';
            try { responseType = xhr.responseType || ''; } catch (e) { /* 忽略 */ }

            if (responseType === 'arraybuffer') {
                let buffer = null;
                try { buffer = xhr.response; } catch (e) { /* 忽略 */ }
                if (!buffer) return;

                // 先看是不是密钥
                try { checkBinaryForKey(buffer); } catch (e) { /* 忽略 */ }

                // 再看里面有没有文本内容。
                try {
                    inspectText(new TextDecoder().decode(buffer), url);
                } catch (e) { /* 不是可解码的文本，正常 */ }

                return;
            }

            if (responseType !== '' && responseType !== 'text') return;

            let text = '';
            try { text = xhr.responseText; } catch (e) { return; }
            if (!text) return;

            inspectText(text, url);
        }
    })();

    /**
     * 检查一段文本里有没有媒体线索
     * @param {string} text
     * @param {string} url 来源地址（用于补全清单里的相对路径）
     */
    function inspectText(text, url) {
        if (!text) return;

        if (text.slice(0, 7).toUpperCase() === '#EXTM3U') {
            handleInlineM3u8(text, url);
            return;
        }

        if (text.indexOf('<MPD') !== -1 && text.indexOf('urn:mpeg:dash') !== -1) {
            handleInlineMpd(text, url);
            return;
        }

        if (text.length <= MAX_JSON_SIZE) {
            const first = text.charAt(0);
            if (first === '{' || first === '[') {
                try {
                    scheduleScan(() => scanObject(JSON.parse(text), 0));
                } catch (e) {
                    // 不是合法 JSON，正常
                }
            }
        }
    }

    // ============================================================
    // Hook 3：fetch
    // ============================================================

    (function hookFetch() {
        if (!firstTime('fetch')) return;
        if (typeof fetch === 'undefined') return;

        const original = fetch;

        const patched = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';

            const promise = original.apply(this, arguments);

            // 从 URL 直接识别
            if (url && MEDIA_EXT_RE.test(url)) {
                reportMedia(url, 'fetch');
            }

            return promise.then(function (response) {
                try {
                    // 不按 content-type 过滤。很多站点的接口返回
                    const length = parseInt(response.headers.get('content-length') || '0', 10);
                    if (length > MAX_BODY_SIZE) return response;

                    // 顺序要紧：先 clone 再读原对象。
                    const clone = response.clone();

                    response.arrayBuffer().then(function (buffer) {
                        try {
                            inspectFetchBody(buffer, url);
                        } catch (e) { /* 忽略 */ }
                    }).catch(function () { /* 忽略 */ });

                    return clone;
                } catch (e) {
                    return response;
                }
            });
        };

        patched.toString = function () {
            return original.toString();
        };

        SELF.fetch = patched;
    })();

    /**
     * 检查 fetch 响应体
     * @param {ArrayBuffer} buffer
     * @param {string} url 请求地址（用于补全清单里的相对路径）
     */
    function inspectFetchBody(buffer, url) {
        if (!buffer || buffer.byteLength === 0) return;

        // 16 字节：AES-128 密钥最常见的形态
        if (buffer.byteLength === 16) {
            checkBinaryForKey(buffer);
            return;
        }

        if (buffer.byteLength > MAX_BODY_SIZE) return;

        let text = '';
        try {
            text = new TextDecoder().decode(buffer);
        } catch (e) {
            return;
        }

        // 文本判断统一走 inspectText，与 XHR 路径保持一致
        inspectText(text, url);
    }

    // ============================================================
    // Hook 4：字符串拼接类
    //
    // 有些播放器不把 m3u8 当整体处理，而是逐字符、逐元素地拼出来，
    // 绕开简单的字符串搜索。只 hook JSON.parse / fetch / XHR 抓不到这类。
    //
    // 代价是这几个 API 的调用频率极高（join 和 decode 尤其），
    // 所以每一步判断都必须廉价，先比长度，再做包含判断，绝大多数
    // 调用在第一个 if 就返回了。
    // ============================================================

    (function hookStringBuilding() {
        if (!firstTime('stringBuilding')) return;
        // 这些 hook 拿不到清单的来源地址，只能拿页面地址回退。
        // 不完美，但比完全不补全相对路径要好。
        const fallbackBase = SELF.location ? SELF.location.href : '';

        // ---------- String.fromCharCode：逐字符拼清单的典型手法 ----------
        if (typeof String.fromCharCode === 'function') {
            const originalFromCharCode = String.fromCharCode;

            // 逐字符拼出来的片段要累积，直到出现结束标记才算完整清单
            let pendingM3u8 = '';

            const patched = new Proxy(originalFromCharCode, {
                apply(target, thisArg, args) {
                    const data = Reflect.apply(target, thisArg, args);

                    // 最廉价的判断放最前面
                    if (data.length < 7) return data;

                    if (data.slice(0, 7) === '#EXTM3U' || data.indexOf('#EXTINF:') !== -1) {
                        pendingM3u8 += data;

                        const endMark = '#EXT-X-ENDLIST';
                        const endIndex = pendingM3u8.indexOf(endMark);

                        if (endIndex !== -1) {
                            handleInlineM3u8(
                                pendingM3u8.slice(0, endIndex + endMark.length),
                                fallbackBase
                            );
                            pendingM3u8 = '';
                        } else if (pendingM3u8.length > MAX_JSON_SIZE) {
                            // 一直等不到结束标记就丢弃，别让它无限涨
                            pendingM3u8 = '';
                        }

                        return data;
                    }

                    // 32 个十六进制字符 = 16 字节密钥的另一种写法。
                    // 有些播放器把密钥转成 hex 字符串再逐字符拼出来。
                    if (data.length === 32 && HEX_KEY_RE.test(data)) {
                        const bytes = new Uint8Array(16);
                        for (let i = 0; i < 16; i++) {
                            bytes[i] = parseInt(data.substr(i * 2, 2), 16);
                        }
                        checkBinaryForKey(bytes.buffer);
                    }

                    return data;
                }
            });

            patched.toString = function () {
                return originalFromCharCode.toString();
            };

            String.fromCharCode = patched;
        }

        // ---------- TextDecoder.decode：解码结果直接就是文本 ----------
        if (typeof TextDecoder !== 'undefined' && TextDecoder.prototype.decode) {
            const originalDecode = TextDecoder.prototype.decode;

            TextDecoder.prototype.decode = function (input, options) {
                const result = originalDecode.call(this, input, options);

                if (result.length >= 7 && result.length <= MAX_JSON_SIZE &&
                    result.indexOf('#EXTM3U') !== -1) {
                    handleInlineM3u8(result, fallbackBase);
                }

                return result;
            };

            TextDecoder.prototype.decode.toString = function () {
                return originalDecode.toString();
            };
        }

        // ---------- Array.prototype.join：逐元素拼清单 ----------
        const originalJoin = Array.prototype.join;

        Array.prototype.join = function () {
            const result = originalJoin.apply(this, arguments);

            // join 是这里调用最频繁的一个，长度判断必须放第一位
            if (result.length >= 7 && result.length <= MAX_JSON_SIZE &&
                result.indexOf('#EXTM3U') !== -1) {
                handleInlineM3u8(result, fallbackBase);
            }

            return result;
        };

        Array.prototype.join.toString = function () {
            return originalJoin.toString();
        };

        // ---------- atob：base64 解码，可能是编码过的清单 ----------
        if (typeof SELF.atob === 'function') {
            const originalAtob = SELF.atob;

            const patchedAtob = function (encoded) {
                const result = originalAtob.apply(this, arguments);

                if (result.length >= 7 && result.slice(0, 7) === '#EXTM3U') {
                    handleInlineM3u8(result, fallbackBase);
                }

                return result;
            };

            patchedAtob.toString = function () {
                return originalAtob.toString();
            };

            SELF.atob = patchedAtob;
        }
    })();

    // ============================================================
    // Hook 5：字节级构造类
    //
    // 有些播放器不用「整体字符串」处理清单和密钥，而是逐字节、
    // 逐元素地构造出来，用 DataView 写、用类型化数组拼、
    // 用 subarray 切、用 btoa / escape 编码。
    // 只 hook 字符串级 API 抓不到这些。
    //
    // 这些 API 的调用频率极高（indexOf 和 subarray 尤其），
    // 所以每一步都必须先做最廉价的判断再往下走。
    // ============================================================

    (function hookEncoding() {
        if (!firstTime('encoding')) return;
        // ---------- btoa：编码结果可能是密钥或清单 ----------
        if (typeof SELF.btoa === 'function') {
            const originalBtoa = SELF.btoa;

            const patched = function (input) {
                const result = originalBtoa.apply(this, arguments);

                try {
                    if (looksLikeBase64Key(result)) {
                        // base64 是 16 字节密钥的常见编码形式
                        try {
                            const raw = nativeAtob ? nativeAtob(result) : '';
                            if (raw.length === 16) {
                                const bytes = new Uint8Array(16);
                                for (let i = 0; i < 16; i++) bytes[i] = raw.charCodeAt(i);
                                checkBinaryForKey(bytes.buffer);
                            }
                        } catch (e) { /* 不是合法 base64 */ }
                    } else if (typeof input === 'string' &&
                        input.slice(0, 7).toUpperCase() === '#EXTM3U') {
                        handleInlineM3u8(input, pageBase());
                    }
                } catch (e) { /* 忽略 */ }

                return result;
            };

            patched.toString = function () { return originalBtoa.toString(); };
            SELF.btoa = patched;
        }

        // ---------- escape：少数播放器用它做编码 ----------
        if (typeof SELF.escape === 'function') {
            const originalEscape = SELF.escape;

            const patched = function (input) {
                try {
                    if (looksLikeBase64Key(input)) {
                        try {
                            const raw = nativeAtob ? nativeAtob(input) : '';
                            if (raw.length === 16) {
                                const bytes = new Uint8Array(16);
                                for (let i = 0; i < 16; i++) bytes[i] = raw.charCodeAt(i);
                                checkBinaryForKey(bytes.buffer);
                            }
                        } catch (e) { /* 忽略 */ }
                    }
                } catch (e) { /* 忽略 */ }

                return originalEscape.apply(this, arguments);
            };

            patched.toString = function () { return originalEscape.toString(); };
            SELF.escape = patched;
        }

        // ---------- String.prototype.indexOf ----------
        //
        // 这是全项目调用最频繁的 API 之一，每次字符串查找都会走到这里。
        // 所以第一句必须是最廉价的严格相等比较，绝大多数调用在这里就返回了。
        const originalIndexOf = String.prototype.indexOf;

        String.prototype.indexOf = function (searchValue) {
            const result = originalIndexOf.apply(this, arguments);

            // 严格相等比字符串比较便宜得多，放最前面
            if (result !== -1 && searchValue === '#EXTM3U') {
                try {
                    const start = arguments.length > 1 ? Number(arguments[1]) || 0 : 0;
                    const text = this.substring(start);
                    if (text.length >= 7) handleInlineM3u8(text, pageBase());
                } catch (e) { /* 忽略 */ }
            }

            return result;
        };

        String.prototype.indexOf.toString = function () { return originalIndexOf.toString(); };
    })();

    (function hookSlicing() {
        if (!firstTime('slicing')) return;
        /**
         * 包装 subarray / slice 这类切片方法
         * @param {Function} original
         * @returns {Function}
         */
        function wrapSlice(original) {
            return function () {
                const result = original.apply(this, arguments);

                try {
                    if (result && result.byteLength === 16) {
                        reportKeyBytes(result);
                    }
                } catch (e) { /* 忽略 */ }

                return result;
            };
        }

        // ---------- 类型化数组的 subarray ----------
        for (const Ctor of [Int8Array, Uint8Array, Uint8ClampedArray]) {
            if (typeof Ctor === 'undefined' || !Ctor.prototype.subarray) continue;

            const original = Ctor.prototype.subarray;
            Ctor.prototype.subarray = wrapSlice(original);
            Ctor.prototype.subarray.toString = function () { return original.toString(); };
        }

        // ---------- Array.prototype.slice ----------
        //
        // 从普通数组里切出 16 个数字，也可能是密钥。
        const originalArraySlice = Array.prototype.slice;

        Array.prototype.slice = function (start, end) {
            const result = originalArraySlice.apply(this, arguments);

            try {
                // 只有「32 个元素的数组切出 16 个」这种形态才值得看，
                // 这是播放器把两个密钥拼在一起再切开时常见的写法
                if (this.length === 32 && end === 16 &&
                    Array.isArray(result) && result.length === 16) {
                    const bytes = new Uint8Array(16);
                    let valid = true;

                    for (let i = 0; i < 16; i++) {
                        const v = result[i];
                        if (typeof v !== 'number' || v < 0 || v > 255) { valid = false; break; }
                        bytes[i] = v;
                    }

                    if (valid) checkBinaryForKey(bytes.buffer);
                }
            } catch (e) { /* 忽略 */ }

            return result;
        };

        Array.prototype.slice.toString = function () { return originalArraySlice.toString(); };
    })();

    (function hookTypedArrays() {
        if (!firstTime('typedArrays')) return;
        /**
         * 把多字节元素的类型化数组转回字节序列
         * @param {ArrayBufferView} view
         * @param {number} bytesPerElement
         * @returns {ArrayBuffer}
         */
        function elementsToBytes(view, bytesPerElement) {
            const out = new Uint8Array(view.length * bytesPerElement);

            for (let i = 0; i < view.length; i++) {
                const value = view[i];
                const base = i * bytesPerElement;

                for (let b = 0; b < bytesPerElement; b++) {
                    const shift = (bytesPerElement - 1 - b) * 8;
                    out[base + b] = (value >> shift) & 0xff;
                }
            }

            return out.buffer;
        }

        /**
         * 包装一个类型化数组构造器
         * @param {Function} Original
         * @param {number} bytesPerElement
         * @returns {Function}
         */
        function wrapCtor(Original, bytesPerElement) {
            const patched = new Proxy(Original, {
                construct(target, args, newTarget) {
                    const instance = Reflect.construct(target, args, newTarget);

                    try {
                        const length = instance.byteLength;

                        if (length === 16) {
                            reportKeyBytes(bytesPerElement === 1
                                ? instance
                                : elementsToBytes(instance, bytesPerElement));
                        } else if (bytesPerElement === 1 &&
                            (length === 32 || length === 128 || length === 256)) {
                            // 可能是 16 字节密钥的重复扩展
                            const unit = extractRepeatedUnit(instance, 16);
                            if (unit) checkBinaryForKey(unit);
                        }
                    } catch (e) { /* 忽略 */ }

                    return instance;
                }
            });

            patched.toString = function () { return Original.toString(); };
            return patched;
        }

        // ---------- 类型化数组构造器 ----------
        if (typeof SELF.Uint8Array === 'function') {
            SELF.Uint8Array = wrapCtor(SELF.Uint8Array, 1);
        }
        if (typeof SELF.Uint16Array === 'function') {
            SELF.Uint16Array = wrapCtor(SELF.Uint16Array, 2);
        }
        if (typeof SELF.Uint32Array === 'function') {
            SELF.Uint32Array = wrapCtor(SELF.Uint32Array, 4);
        }

        // ---------- DataView ----------
        //
        // 有些播放器用 DataView 逐字节写入密钥，不 hook 的话完全看不到。
        if (typeof SELF.DataView === 'function') {
            const OriginalDataView = SELF.DataView;

            const patched = new Proxy(OriginalDataView, {
                construct(target, args, newTarget) {
                    const instance = Reflect.construct(target, args, newTarget);

                    try {
                        const length = instance.byteLength;

                        if (length === 16) {
                            reportKeyBytes(instance.buffer);
                        } else if (length === 32) {
                            // 32 字节有两种可能：密钥的重复扩展，或两个密钥拼在一起
                            const unit = extractRepeatedUnit(instance.buffer, 16);
                            if (unit) {
                                checkBinaryForKey(unit);
                            } else {
                                checkBinaryForKey(instance.buffer.slice(0, 16));
                            }
                        } else if (length === 128 || length === 256) {
                            const unit = extractRepeatedUnit(instance.buffer, 16);
                            if (unit) checkBinaryForKey(unit);
                        }
                    } catch (e) { /* 忽略 */ }

                    return instance;
                }
            });

            patched.toString = function () { return OriginalDataView.toString(); };
            SELF.DataView = patched;
        }
    })();

    // ============================================================
    // 内联脚本扫描
    //
    // 有些站点把播放地址直接写死在页面的 <script> 里，
    // 而不是通过接口下发。这种情况 hook 网络请求完全抓不到，
    // 因为根本没有请求发生，地址是从源码里读出来的。
    //
    // 只能直接读脚本源码。只在 DOMContentLoaded 时扫一次，
    // 不做轮询，避免持续占用主线程。
    // ============================================================

    (function scanInlineScripts() {
        /** 从内联脚本里抠出完整的媒体地址 */
        const INLINE_URL_RE = /["'`](https?:\/\/[^"'`\s]{10,500}?\.(?:m3u8|m3u|mpd|mp4|m4s|ts|flv|mkv|webm|mp3|m4a)(?:\?[^"'`\s]{0,300})?)["'`]/gi;

        function scan() {
            try {
                const scripts = document.querySelectorAll('script:not([src])');

                for (const el of scripts) {
                    const text = el.textContent;

                    // 太短的没内容，太大的不值得扫
                    if (!text || text.length < 20 || text.length > MAX_JSON_SIZE) continue;

                    INLINE_URL_RE.lastIndex = 0;
                    let match;

                    while ((match = INLINE_URL_RE.exec(text)) !== null) {
                        reportMedia(match[1], 'inline-script', '');
                    }
                }
            } catch (e) {
                // 扫描失败绝不能影响页面
            }
        }

        if (typeof document === 'undefined') return;

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', scan, { once: true });
        } else {
            scan();
        }
    })();

    // ============================================================
    // Hook 6：Worker（递归注入）
    // ============================================================

    (function hookWorker() {
        // Worker 环境内不再劫持，避免无限递归
        if (IS_WORKER) return;
        if (typeof Worker === 'undefined') return;

        const OriginalWorker = Worker;

        // 探测是否支持通过 Blob URL 创建 Worker（CSP 严格的站点可能不支持）
        let supportsBlobWorker = true;
        try {
            const testBlob = new Blob([''], { type: 'text/javascript' });
            const testUrl = URL.createObjectURL(testBlob);
            const testWorker = new OriginalWorker(testUrl);
            testWorker.addEventListener('error', function () {
                supportsBlobWorker = false;
                testWorker.terminate();
                URL.revokeObjectURL(testUrl);
            });
        } catch (e) {
            supportsBlobWorker = false;
        }

        if (!supportsBlobWorker) return;

        /**
         * 读取 Worker 脚本源码
         * @param {string} scriptURL
         * @returns {string|null}
         */
        function readWorkerSource(scriptURL) {
            if (typeof scriptURL !== 'string') return null;

            // data: URL 直接解码
            if (scriptURL.indexOf('data:') === 0) {
                const commaIndex = scriptURL.indexOf(',');
                if (commaIndex === -1) return null;

                const meta = scriptURL.slice(5, commaIndex);
                const payload = scriptURL.slice(commaIndex + 1);

                try {
                    return /;base64/i.test(meta) ? atob(payload) : decodeURIComponent(payload);
                } catch (e) {
                    return null;
                }
            }

            try {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', scriptURL, false);
                xhr.send();

                // blob: URL 读成功时 status 是 0，不是 200
                if ((xhr.status === 200 || xhr.status === 0) &&
                    typeof xhr.responseText === 'string') {
                    return xhr.responseText;
                }
            } catch (e) {
                // 跨源、同步 XHR 被禁、或 URL 无效
            }

            return null;
        }

        function PatchedWorker(scriptURL, options) {
            try {
                const target = readWorkerSource(scriptURL);

                // 读不到源码就退回原生。这种情况 Worker 内部的请求抓不到，
                // 但页面功能完全不受影响，这是必须守住的底线。
                if (target === null) {
                    return new OriginalWorker(scriptURL, options);
                }

                // 拼接：先跑鲸吞的 hook，再跑原脚本
                const combined = SELF_SOURCE + '\n;\n' + target;
                const blob = new Blob([combined], { type: 'text/javascript' });
                const blobUrl = URL.createObjectURL(blob);
                const worker = new OriginalWorker(blobUrl, options);

                // 转发 Worker 内部捕获到的数据
                worker.addEventListener('message', function (event) {
                    const data = event.data;
                    if (data && typeof data === 'object' && typeof data.action === 'string') {
                        if (data.action === 'jt:addMedia' || data.action === 'jt:addKey') {
                            report(data.action, data.payload);
                        }
                    }
                });

                return worker;
            } catch (e) {
                // 任何环节出错都降级到原始行为，绝不破坏页面功能
            }

            return new OriginalWorker(scriptURL, options);
        }

        // 伪装成原生构造函数
        PatchedWorker.toString = function () {
            return OriginalWorker.toString();
        };
        PatchedWorker.prototype = OriginalWorker.prototype;

        try {
            SELF.Worker = PatchedWorker;
        } catch (e) {
            // 某些页面会冻结该属性，忽略
        }
    })();

    // ============================================================
    // Hook 6b：importScripts（仅在 Worker 环境内生效）
    //
    // Worker 通过 importScripts 拉子脚本时，子脚本里的 fetch / XHR
    // 不受本脚本管理。这里在加载完成后重新注入一次 hook，
    // 有防重复守卫，重复执行是安全的。
    //
    // 局限：只能管到子脚本加载之后发起的请求。子脚本执行过程中立刻
    // 发出的请求抓不到，那需要在它执行之前注入，等于替换
    // importScripts 的语义，风险太大，不做。
    // ============================================================

    (function hookImportScripts() {
        if (!firstTime('importScripts')) return;
        if (!IS_WORKER) return;
        if (typeof self.importScripts !== 'function') return;

        const original = self.importScripts;

        const patched = function () {
            const result = original.apply(self, arguments);

            // 子脚本可能自己覆盖了原生 API（有些库会这么做），
            try {
                for (const key of Object.keys(SELF)) {
                    if (key.indexOf('__JT_HOOK_') === 0) delete SELF[key];
                }
                (0, eval)(SELF_SOURCE);
            } catch (e) {
                // CSP 禁止 eval 时忽略，功能降级，页面不受影响
            }

            return result;
        };

        patched.toString = function () {
            return original.toString();
        };

        try {
            self.importScripts = patched;
        } catch (e) {
            // 某些环境会冻结该属性
        }
    })();

    // ============================================================
    // Hook 7：DRM 检测
    // ============================================================

    (function hookEME() {
        if (typeof navigator === 'undefined') return;
        if (typeof navigator.requestMediaKeySystemAccess !== 'function') return;

        const original = navigator.requestMediaKeySystemAccess.bind(navigator);

        const patched = function (keySystem, configurations) {
            const result = original(keySystem, configurations);

            // 等结果回来再报，而不是调用时就报。
            if (result && typeof result.then === 'function') {
                result.then(function () {
                    try {
                        report('jt:drmDetected', {
                            system: keySystem || t('search.unknown', null, '未知'),
                            url: SELF.location.href
                        });
                    } catch (e) { /* 忽略 */ }
                }).catch(function () {
                    // 探测失败 = 这个 DRM 用不了，说明页面不是真在用
                });
            }

            return result;
        };

        patched.toString = function () {
            return original.toString();
        };

        try {
            Object.defineProperty(navigator, 'requestMediaKeySystemAccess', {
                value: patched,
                writable: true,
                configurable: true
            });
        } catch (e) {
            // 无法改写时忽略
        }
    })();

    // ============================================================
    // 接收停止指令
    // ============================================================

    function onMessage(event) {
        const data = event && event.data;
        if (!data || typeof data !== 'object') return;
        if (data.action === 'jt:stop') {
            stopped = true;
        }
    }

    if (IS_WORKER) {
        SELF.addEventListener('message', onMessage);
    } else {
        SELF.addEventListener('message', onMessage, false);
    }
})();
