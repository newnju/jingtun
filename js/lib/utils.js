/**
 * 鲸吞 · 通用工具库
 */
var JTUtils = (function () {
    'use strict';

    /** 字节单位换算表 */
    const SIZE_UNITS = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 };

    /**
 * 字节数格式化为可读字符串
 * @param {number} bytes
 * @param {number} [digits=2] 小数位
 * @returns {string}
 */
    function byteToSize(bytes, digits = 2) {
        if (bytes === undefined || bytes === null || isNaN(bytes)) return '-';
        if (bytes < 1024) return bytes + ' B';
        const units = ['KB', 'MB', 'GB', 'TB'];
        let value = bytes / 1024;
        let i = 0;
        while (value >= 1024 && i < units.length - 1) {
            value /= 1024;
            i++;
        }
        return value.toFixed(digits) + ' ' + units[i];
    }

    /**
 * 秒数格式化为 HH:MM:SS 或 MM:SS
 * @param {number} sec
 * @returns {string}
 */
    function secToTime(sec) {
        if (sec === undefined || sec === null || isNaN(sec)) return '00:00';
        sec = Math.max(0, Math.floor(sec));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }

    /**
 * 从 URL 中**快速**提取扩展名（纯字符串操作，不构造 URL 对象）
 * @param {string} url
 * @returns {string} 小写扩展名；无扩展名时返回空字符串
 */
    function quickExt(url) {
        if (!url || typeof url !== 'string') return '';

        const ext = extractExtRaw(url);
        if (ext) return ext;

        // 少数站点的地址做过编码（%2Emp4 这类），第一次取不到时再解一次。
        if (url.indexOf('%') !== -1) {
            try {
                return extractExtRaw(decodeURI(url));
            } catch (e) {
                // 非法编码，按无扩展名处理
            }
        }
        return '';
    }

    /**
 * 实际的扩展名提取（不含解码兜底）
 * @param {string} url
 * @returns {string}
 */
    function extractExtRaw(url) {
        // 定位有效段的结束位置（排除 query 与 hash）
        let end = url.length;
        const q = url.indexOf('?');
        if (q !== -1) end = q;
        const h = url.indexOf('#');
        if (h !== -1 && h < end) end = h;

        const slash = url.lastIndexOf('/', end);
        const dot = url.lastIndexOf('.', end);

        // 无点号，或点号在最后一个斜杠之前（说明点号属于域名部分）
        if (dot === -1 || dot <= slash) return '';

        const ext = url.slice(dot + 1, end);
        // 扩展名长度保护：正常扩展名不会超过 6 个字符
        if (ext.length === 0 || ext.length > 6) return '';

        // 扩展名必须全为字母数字，排除 `?a=1` 这类误判
        for (let i = 0; i < ext.length; i++) {
            const c = ext.charCodeAt(i);
            const isDigit = c >= 48 && c <= 57;
            const isUpper = c >= 65 && c <= 90;
            const isLower = c >= 97 && c <= 122;
            if (!isDigit && !isUpper && !isLower) return '';
        }

        return ext.toLowerCase();
    }

    /**
 * 从 pathname 解析文件名与扩展名
 * @param {string} pathname
 * @returns {[string, (string|undefined)]} [文件名, 扩展名]
 */
    function parseFileName(pathname) {
        if (!pathname) return ['', undefined];
        let fileName = '';
        try {
            fileName = decodeURIComponent(pathname.split('/').pop() || '');
        } catch (e) {
            // 非法 URI 编码时退回原始字符串
            fileName = pathname.split('/').pop() || '';
        }
        const parts = fileName.split('.');
        const ext = parts.length === 1 ? undefined : parts.pop().toLowerCase();
        return [fileName, ext || undefined];
    }

    /**
 * 清理文件名中的非法字符
 * @param {string} name
 * @param {number} [maxLength=180] 最大长度
 * @returns {string}
 */
    function sanitizeFileName(name, maxLength = 180) {
        if (!name) return '';
        let result = String(name)
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')  // 各系统非法字符
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^\.+/, '')      // 避免隐藏文件
            .replace(/[.\s]+$/, '');  // 避免结尾点号与空格（Windows 限制）
        if (result.length > maxLength) {
            result = result.slice(0, maxLength);
        }
        return result || 'untitled';
    }

    /**
 * 渲染模板字符串，支持 ${key} 占位符
 * @param {string} template
 * @param {Object} data
 * @returns {string}
 */
    function renderTemplate(template, data) {
        if (!template) return '';

        // 统一走 JTTemplate —— 文件名、复制格式、协议调用共用同一套
        // 变量与过滤器，行为不会各说各话。
        if (typeof JTTemplate !== 'undefined' && JTTemplate.render) {
            return JTTemplate.render(template, data);
        }

        // 极端情况下（模板模块没加载成功）退回最小实现，
        // 至少保证 ${key} 能替换出来
        return String(template).replace(/\$\{([^}]+)\}/g, function (match, expr) {
            const key = expr.split('|')[0].trim();
            const value = data ? data[key] : '';
            return value === undefined || value === null ? '' : String(value);
        });
    }

    /**
 * 读取本地化文案
 * @param {string} key messages.json 中的键
 * @param {string} [fallback] 取不到时使用
 * @returns {string}
 */
    function i18n(key, fallback) {
        try {
            const value = chrome && chrome.i18n && chrome.i18n.getMessage(key);
            if (value) return value;
        } catch (e) { /* 忽略，走兜底 */ }
        return fallback === undefined ? '' : fallback;
    }

    /**
 * 设置页面标题
 * @param {string} [key] messages.json 中的页面名键；不传则只用扩展名
 * @param {string} [fallback] 取不到时使用的页面名
 */
    function setTitle(key, fallback) {
        const name = i18n('extName', '鲸吞');
        if (!key) {
            document.title = name;
            return;
        }
        const page = i18n(key, fallback);
        document.title = page ? name + ' · ' + page : name;
    }

    /**
 * 从地址里取域名，取不到就返回原串
 * @param {string} url
 * @returns {string}
 */
    function safeHostname(url) {
        if (!url) return '';

        try {
            return new URL(url).hostname || String(url);
        } catch (e) {
            return String(url);
        }
    }

    /**
 * 防抖：等待停止调用 wait 毫秒后执行
 * @param {Function} fn
 * @param {number} wait
 * @returns {Function} 附带 cancel()
 */
    function debounce(fn, wait) {
        let timer = null;
        const wrapped = function (...args) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                fn.apply(this, args);
            }, wait);
        };
        wrapped.cancel = function () {
            if (timer) clearTimeout(timer);
            timer = null;
        };
        return wrapped;
    }

    /**
 * 节流：每 wait 毫秒最多执行一次
 * @param {Function} fn
 * @param {number} wait
 * @returns {Function}
 */
    function throttle(fn, wait) {
        let last = 0;
        let timer = null;
        return function (...args) {
            const now = Date.now();
            const remaining = wait - (now - last);
            if (remaining <= 0) {
                last = now;
                fn.apply(this, args);
            } else if (!timer) {
                timer = setTimeout(() => {
                    last = Date.now();
                    timer = null;
                    fn.apply(this, args);
                }, remaining);
            }
        };
    }

    /**
 * 生成唯一 ID
 * @returns {string}
 */
    let uidCounter = 0;
    function uid(prefix = 'jt') {
        uidCounter++;
        return `${prefix}_${Date.now().toString(36)}_${uidCounter.toString(36)}`;
    }

    /**
 * 在空闲时执行任务，降级为 setTimeout
 * @param {Function} fn
 */
    function onIdle(fn) {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(fn, { timeout: 1000 });
        } else {
            setTimeout(fn, 0);
        }
    }

    /**
 * 解析可能带单位的体积表达式，例如 ">100 KB"、"500-1000 MB"
 * @param {string} expr
 * @returns {{operator: string, size: number, unit: string, min: number, max: number}|null}
 */
    function parseSizeExpression(expr) {
        if (!expr || typeof expr !== 'string') return null;
        const trimmed = expr.trim().toUpperCase();

        // 范围形式：500-1000 MB
        const rangeMatch = trimmed.match(/^([\d.]+)\s*-\s*([\d.]+)\s*(B|KB|MB|GB)?$/);
        if (rangeMatch) {
            return {
                operator: '~',
                size: 0,
                unit: rangeMatch[3] || 'B',
                min: parseFloat(rangeMatch[1]),
                max: parseFloat(rangeMatch[2])
            };
        }

        // 比较形式：>=100 KB
        const cmpMatch = trimmed.match(/^(>=|<=|!=|=|>|<)?\s*([\d.]+)\s*(B|KB|MB|GB)?$/);
        if (cmpMatch) {
            return {
                operator: cmpMatch[1] || '=',
                size: parseFloat(cmpMatch[2]),
                unit: cmpMatch[3] || 'B',
                min: 0,
                max: 0
            };
        }

        return null;
    }

    /**
 * 按表达式比较体积
 * @param {number} size 实际字节数
 * @param {{operator: string, size: number, unit: string, min: number, max: number}} rule
 * @returns {boolean}
 */
    function compareSize(size, rule) {
        if (!rule) return true;
        if (size === undefined || size === null || isNaN(size)) return true;

        const unit = SIZE_UNITS[rule.unit] || 1;
        const target = rule.size * unit;

        switch (rule.operator) {
            case '=': return size === target;
            case '>': return size > target;
            case '<': return size < target;
            case '>=': return size >= target;
            case '<=': return size <= target;
            case '!=': return size !== target;
            case '~':
                return size >= rule.min * unit && size <= rule.max * unit;
            default:
                return size <= target;
        }
    }

    /**
 * 数字补零
 * @param {number} value
 * @param {number} [width]
 * @returns {string}
 */
    function appendZero(value, width = 2) {
        return String(value).padStart(width, '0');
    }

    /**
 * 比特率格式化
 * @param {number} bps 每秒比特数
 * @returns {string}
 */
    function formatBitrate(bps) {
        if (!bps || bps <= 0) return '';

        if (bps >= 1000000) return (bps / 1000000).toFixed(1) + ' Mbps';
        if (bps >= 1000) return Math.round(bps / 1000) + ' Kbps';
        return Math.round(bps) + ' bps';
    }

    /**
 * 判断空值
 * @param {*} value
 * @returns {boolean}
 */
    function isEmpty(value) {
        if (value === null || value === undefined) return true;
        if (typeof value === 'string') return value.trim() === '';
        if (Array.isArray(value)) return value.length === 0;
        if (value instanceof Map || value instanceof Set) return value.size === 0;
        if (typeof value === 'object') return Object.keys(value).length === 0;
        return false;
    }

    /**
 * 把嵌套对象展平成单层
 * @param {Object} obj
 * @param {string} [prefix]
 * @returns {Object}
 */
    function flattenObject(obj, prefix = '') {
        const out = {};

        if (!obj || typeof obj !== 'object') return out;

        for (const key of Object.keys(obj)) {
            const value = obj[key];
            const path = prefix ? prefix + '.' + key : key;

            if (value && typeof value === 'object' && !Array.isArray(value)) {
                Object.assign(out, flattenObject(value, path));
            } else if (Array.isArray(value)) {
                // 数组用下标展开，避免整体被序列化成字符串
                value.forEach(function (item, i) {
                    if (item && typeof item === 'object') {
                        Object.assign(out, flattenObject(item, path + '[' + i + ']'));
                    } else {
                        out[path + '[' + i + ']'] = item;
                    }
                });
            } else {
                out[path] = value;
            }
        }

        return out;
    }

    /**
 * 容错的 JSON 解析
 * @param {string} text
 * @returns {*} 解析失败返回 null
 */
    function jsonParse(text) {
        if (typeof text !== 'string' || !text.trim()) return null;

        // 先按标准 JSON 试
        try {
            return JSON.parse(text);
        } catch (e) {
            // 失败就往下走，给键名补引号再试
        }

        // 有些接口返回的是 JS 对象字面量写法，键名没加引号
        try {
            const fixed = text.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
            return JSON.parse(fixed);
        } catch (e) {
            return null;
        }
    }

    /**
 * 用 HEAD 请求取远程文件大小
 * @param {string} url
 * @returns {Promise<number>} 字节数；取不到返回 0
 */
    async function getRemoteFileSize(url) {
        try {
            const head = await fetch(url, { method: 'HEAD' });
            const length = parseInt(head.headers.get('content-length') || '0', 10);
            if (length > 0) return length;
        } catch (e) {
            // HEAD 失败，继续试 Range
        }

        try {
            const ranged = await fetch(url, { headers: { Range: 'bytes=0-0' } });
            const range = ranged.headers.get('content-range') || '';
            const total = parseInt(range.split('/').pop() || '0', 10);
            if (total > 0) return total;
        } catch (e) {
            // 两种方式都失败
        }

        return 0;
    }

    /**
 * 往页面注入一段 CSS
 * @param {string} css
 * @param {string} [id] style 标签 id，重复注入时替换
 */
    function injectCSS(css, id = 'jt-custom-style') {
        if (!css) return;

        try {
            let style = document.getElementById(id);
            if (!style) {
                style = document.createElement('style');
                style.id = id;
                (document.head || document.documentElement).appendChild(style);
            }
            style.textContent = css;
        } catch (e) {
            // 忽略
        }
    }

    /**
 * 用 data URL 触发下载
 * @param {string} dataUrl
 * @param {string} fileName
 */
    function downloadDataURL(dataUrl, fileName) {
        try {
            const comma = dataUrl.indexOf(',');
            if (comma === -1) return;

            const meta = dataUrl.slice(5, comma);
            const payload = dataUrl.slice(comma + 1);

            let blob;
            if (/;base64/i.test(meta)) {
                const binary = atob(payload);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                blob = new Blob([bytes], { type: meta.split(';')[0] || 'application/octet-stream' });
            } else {
                blob = new Blob([decodeURIComponent(payload)]);
            }

            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = fileName || 'download';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();

            setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
        } catch (e) {
            // 忽略
        }
    }

    return {
        byteToSize,
        secToTime,
        quickExt,
        parseFileName,
        safeHostname,
        sanitizeFileName,
        renderTemplate,
        i18n,
        setTitle,
        debounce,
        throttle,
        uid,
        onIdle,
        parseSizeExpression,
        compareSize,
        appendZero,
        formatBitrate,
        isEmpty,
        flattenObject,
        jsonParse,
        getRemoteFileSize,
        injectCSS,
        downloadDataURL,
        SIZE_UNITS
    };
})();
