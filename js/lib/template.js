/**
 * 鲸吞 · 模板系统
 */
var JTTemplate = (function () {
    'use strict';

    /** 内置变量：不需要调用方提供 */
    function builtins() {
        const now = new Date();
        const pad = (n, width) => String(n).padStart(width || 2, '0');

        return {
            now: String(now.getTime()),
            date: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()),
            time: pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()),
            year: String(now.getFullYear()),
            month: pad(now.getMonth() + 1),
            day: pad(now.getDate()),
            hour: pad(now.getHours()),
            minute: pad(now.getMinutes()),
            second: pad(now.getSeconds()),
            // 换行。模板里没法直接写换行，用这个占位
            br: '\n'
        };
    }

    /**
 * 解析过滤器段
 * @param {string} segment
 * @returns {{name: string, arg: string}}
 */
    function parseFilter(segment) {
        const trimmed = segment.trim();
        const colon = trimmed.indexOf(':');

        if (colon === -1) {
            return { name: trimmed.toLowerCase(), arg: '' };
        }

        const name = trimmed.slice(0, colon).trim().toLowerCase();
        let arg = trimmed.slice(colon + 1).trim();

        // 去掉包裹的引号
        if ((arg.startsWith("'") && arg.endsWith("'")) ||
            (arg.startsWith('"') && arg.endsWith('"'))) {
            arg = arg.slice(1, -1);
        }

        return { name: name, arg: arg };
    }

    /**
 * 按字节切分字符串
 * @param {string} str
 * @param {string} arg 形如 `0,10` 或 `0`（从 0 到末尾）
 * @returns {string}
 */
    function sliceText(str, arg) {
        const parts = String(arg).split(',');
        const start = parseInt(parts[0], 10) || 0;

        if (parts.length < 2 || parts[1].trim() === '') {
            return str.slice(start);
        }

        const end = parseInt(parts[1], 10);
        if (isNaN(end)) return str.slice(start);

        // 支持负索引（从末尾算）
        return str.slice(start, end < 0 ? str.length + end : end);
    }

    /**
 * 应用单个过滤器
 * @param {string} value 当前值
 * @param {string} segment 过滤器原文
 * @param {Object} data 变量表（部分过滤器需要，比如 find）
 * @returns {string}
 */
    function applyFilter(value, segment, data) {
        const filter = parseFilter(segment);
        const arg = filter.arg;

        switch (filter.name) {
            // ---------- 字符串处理 ----------
            case 'slice':
                return sliceText(value, arg);

            case 'replace': {
                const parts = arg.split(',');
                if (parts.length < 2) return value;
                // 只替换第一个，避免误伤
                return value.replace(parts[0], parts[1]);
            }

            case 'replaceall': {
                const parts = arg.split(',');
                if (parts.length < 2) return value;
                return value.split(parts[0]).join(parts[1]);
            }

            case 'regexp': {
                const parts = arg.split(',');
                if (parts.length < 2) return value;
                try {
                    return value.replace(new RegExp(parts[0], 'g'), parts[1]);
                } catch (e) {
                    return value;
                }
            }

            case 'upper':
            case 'uppercase':
                return value.toUpperCase();

            case 'lower':
            case 'lowercase':
                return value.toLowerCase();

            case 'trim':
                return value.trim();

            case 'prepend':
                return arg + value;

            case 'concat':
                return value + arg;

            case 'before': {
                const idx = value.indexOf(arg);
                return idx === -1 ? value : value.slice(0, idx);
            }

            case 'after': {
                const idx = value.indexOf(arg);
                return idx === -1 ? value : value.slice(idx + arg.length);
            }

            // ---------- 条件 ----------
            case 'exists':
                // 值存在（非空）时输出模板，* 替换为实际值
                if (value === '') return '';
                return arg.replace(/\*/g, value);

            case 'default':
                return value === '' ? arg : value;

            case 'filter':
                // 按分隔符切分再取其中一段
                return value === '' ? '' : value;

            // ---------- 编码 ----------
            case 'to': {
                switch (arg.toLowerCase()) {
                    case 'base64':
                        try { return btoa(unescape(encodeURIComponent(value))); }
                        catch (e) { return value; }
                    case 'urlencode':
                        return encodeURIComponent(value);
                    case 'upper':
                    case 'uppercase':
                        return value.toUpperCase();
                    case 'lower':
                    case 'lowercase':
                        return value.toLowerCase();
                    default:
                        return value;
                }
            }

            // ---------- 页面 DOM 查询 ----------
            case 'find': {
                // 页面 DOM 的查询结果由调用方预取，塞在 data.pageDOM 里。
                // 模板渲染是同步的，没法在这里现去请求页面。
                const dom = data && data.pageDOM;
                if (!dom || typeof dom !== 'object') return value;
                const found = dom[arg];
                return found === undefined || found === null ? value : String(found);
            }

            default:
                return value;
        }
    }

    /**
 * 渲染模板
 * @param {string} template
 * @param {Object} [data] 变量表
 * @returns {string}
 */
    function render(template, data) {
        if (!template) return '';

        const vars = Object.assign({}, builtins(), data || {});

        return String(template).replace(/\$\{([^}]+)\}/g, function (match, expr) {
            const segments = expr.split('|');
            const key = segments[0].trim();

            let value = vars[key];
            if (value === undefined || value === null) value = '';
            value = String(value);

            for (let i = 1; i < segments.length; i++) {
                value = applyFilter(value, segments[i], vars);
            }

            return value;
        });
    }

    /**
 * 把模板里用到的变量名列出来
 * @param {string} template
 * @returns {Array<string>}
 */
    function extractVars(template) {
        if (!template) return [];

        const out = [];
        const re = /\$\{([^}|]+)/g;
        let m;
        while ((m = re.exec(template)) !== null) {
            const name = m[1].trim();
            if (out.indexOf(name) === -1) out.push(name);
        }
        return out;
    }

    /**
 * 检查模板里的变量是否都在可用列表中
 * @param {string} template
 * @param {Array<string>} available
 * @returns {Array<string>} 未知的变量名
 */
    function findUnknownVars(template, available) {
        const known = new Set(Object.keys(builtins()).concat(available || []));
        return extractVars(template).filter((name) => !known.has(name));
    }

    return {
        render,
        extractVars,
        findUnknownVars,
        BUILTIN_VARS: Object.keys(builtins())
    };
})();
