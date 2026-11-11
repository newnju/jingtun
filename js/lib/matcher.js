/**
 * 鲸吞 · 资源判定模块
 */
var JTMatcher = (function () {
    'use strict';

    const HIT = 'hit';
    const MISS = 'miss';
    const BLOCK = 'block';

    /** 默认允许的扩展名（视频 / 音频 / 流媒体清单 / 字幕） */
    const DEFAULT_EXT = new Set([
        // 视频容器
        'mp4', 'm4v', 'flv', 'f4v', 'hlv', 'webm', 'mkv', 'mov', 'avi', 'wmv',
        'asf', 'mpeg', 'mpg', 'ogv', 'divx', '3gp', 'rmvb', 'rm', 'vid', 'movie',
        // 流媒体分片
        'ts', 'm4s', 'cmfv', 'cmfa',
        // 音频
        'mp3', 'm4a', 'aac', 'acc', 'wav', 'wma', 'ogg', 'oga', 'opus', 'flac', 'weba',
        // 流媒体清单
        'm3u8', 'm3u', 'mpd',
        // 字幕
        'srt', 'vtt', 'ass', 'ssa', 'ttml'
    ]);

    /** 默认允许的完整 MIME 类型 */
    const DEFAULT_MIME = new Set([
        'application/vnd.apple.mpegurl',   // m3u8
        'application/x-mpegurl',           // m3u8
        'application/mpegurl',             // m3u8
        'audio/mpegurl',                   // m3u8
        'audio/x-mpegurl',                 // m3u8
        'application/dash+xml',            // mpd
        'application/ogg',
        'application/x-shockwave-flash'
    ]);

    /** MIME 前缀匹配（覆盖 video/* 与 audio/*） */
    const MIME_PREFIX = ['video/', 'audio/'];

    /**
 * 含义模糊、不能单独作为判定依据的 MIME
 */
    const AMBIGUOUS_MIME = new Set([
        'application/octet-stream',
        'binary/octet-stream',
        'application/binary'
    ]);

    /**
 * 从响应头数组中提取关键字段
 * @param {Array<{name: string, value: string}>} headers
 * @returns {{size: (number|undefined), type: (string|undefined), disposition: (string|undefined)}}
 */
    function extractHeaders(headers) {
        const result = { size: undefined, type: undefined, disposition: undefined };
        if (!Array.isArray(headers) || headers.length === 0) return result;

        for (const item of headers) {
            if (!item || !item.name) continue;
            const name = item.name.toLowerCase();

            if (name === 'content-length') {
                if (result.size === undefined) {
                    const parsed = parseInt(item.value, 10);
                    if (!isNaN(parsed)) result.size = parsed;
                }
            } else if (name === 'content-type') {
                result.type = String(item.value).split(';')[0].trim().toLowerCase();
            } else if (name === 'content-range') {
                // 断点续传场景下 content-length 是分片长度，这里取总长度
                const parts = String(item.value).split('/');
                if (parts.length === 2 && parts[1] !== '*') {
                    const parsed = parseInt(parts[1], 10);
                    if (!isNaN(parsed)) result.size = parsed;
                }
            } else if (name === 'content-disposition') {
                result.disposition = item.value;
            }
        }
        return result;
    }

    /**
 * 从 Content-Disposition 中提取文件名
 * @param {string} disposition
 * @returns {string} 文件名，未找到返回空字符串
 */
    function extractDispositionFileName(disposition) {
        if (!disposition) return '';
        // 优先匹配 filename*=UTF-8''xxx 形式
        const utf8Match = disposition.match(/filename\*\s*=\s*([^;]+)/i);
        if (utf8Match) {
            let raw = utf8Match[1].trim().replace(/^["']|["']$/g, '');
            const parts = raw.split("''");
            raw = parts.length > 1 ? parts[1] : raw;
            try {
                return decodeURIComponent(raw);
            } catch (e) {
                return raw;
            }
        }
        const plainMatch = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
        if (plainMatch) {
            try {
                return decodeURIComponent(plainMatch[1].trim());
            } catch (e) {
                return plainMatch[1].trim();
            }
        }
        return '';
    }

    /**
 * 按 MIME 判定
 * @param {string} mime
 * @param {number} [size]
 * @param {Object} [config] 用户配置 { allowMime: Set, denyMime: Set }
 * @returns {string} HIT / MISS / BLOCK
 */
    function judgeByMime(mime, size, config) {
        if (!mime) return MISS;

        const allow = (config && config.allowMime) || null;
        const deny = (config && config.denyMime) || null;

        // 用户显式屏蔽的类型直接否决
        if (deny && deny.has(mime)) return BLOCK;

        // 模糊类型不能单独作数，交给扩展名判定
        if (AMBIGUOUS_MIME.has(mime)) return MISS;

        // 用户自定义允许表优先
        if (allow && allow.has(mime)) {
            const rules = (config && config.mimeRules) || null;
            const rule = rules && rules.get(mime);
            if (rule && !checkSize(size, rule)) return MISS;
            return HIT;
        }

        if (DEFAULT_MIME.has(mime)) return HIT;

        for (const prefix of MIME_PREFIX) {
            if (mime.startsWith(prefix)) return HIT;
        }

        return MISS;
    }

    /**
 * 检查体积是否满足规则里的条件
 * @param {number|undefined} size 字节
 * @param {Object} rule
 * @returns {boolean}
 */
    function checkSize(size, rule) {
        if (!rule || !rule.operator) return true;
        if (typeof size !== 'number' || size <= 0) return true;

        const units = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
        const factor = units[String(rule.unit || 'KB').toUpperCase()] || 1024;
        const threshold = (Number(rule.size) || 0) * factor;

        switch (rule.operator) {
            case '>': return size > threshold;
            case '>=': return size >= threshold;
            case '<': return size < threshold;
            case '<=': return size <= threshold;
            case '=': return size === threshold;
            case '!=': return size !== threshold;
            case '~':
                // 区间：min <= size <= max，两个值都存在规则里
                return size >= (Number(rule.min) || 0) && size <= (Number(rule.max) || Infinity);
            default:
                return true;
        }
    }

    /**
 * 按扩展名判定
 * @param {string} ext
 * @param {number} [size]
 * @param {Object} [config] 用户配置 { allowExt: Set, denyExt: Set, extRules: Map }
 * @returns {string} HIT / MISS / BLOCK
 */
    function judgeByExt(ext, size, config) {
        if (!ext) return MISS;

        const normalized = String(ext).toLowerCase().replace(/^\./, '');
        const allow = (config && config.allowExt) || null;
        const deny = (config && config.denyExt) || null;
        const rules = (config && config.extRules) || null;

        if (deny && deny.has(normalized)) return BLOCK;

        if (allow && allow.has(normalized)) {
            // 用户给这条规则加了体积条件时不满足，就当作不认识
            const rule = rules && rules.get(normalized);
            if (rule && !checkSize(size, rule)) return MISS;
            return HIT;
        }

        if (DEFAULT_EXT.has(normalized)) return HIT;

        return MISS;
    }

    /**
 * 综合判定一个请求是否为媒体资源
 * @param {Object} input
 * @param {string} [input.url]
 * @param {string} [input.ext]      预提取的扩展名（避免重复计算）
 * @param {string} [input.mime]
 * @param {number} [input.size]
 * @param {string} [input.disposition]
 * @param {Object} [config]
 * @returns {{result: string, ext: string, mime: string, size: number|undefined, fileName: string}}
 */
    function judge(input, config) {
        const url = input.url || '';
        const size = input.size;
        const mime = input.mime || '';

        let ext = input.ext;
        if (ext === undefined) {
            ext = JTUtils.quickExt(url);
        }

        let fileName = '';

        // 第一步：MIME
        const mimeResult = judgeByMime(mime, size, config);
        if (mimeResult === BLOCK) {
            return { result: BLOCK, ext, mime, size, fileName };
        }
        if (mimeResult === HIT) {
            // MIME 命中时，仍尝试补一个更精确的扩展名（MIME 可能是笼统的 video/mp4）
            return { result: HIT, ext, mime, size, fileName };
        }

        // 第二步：扩展名
        const extResult = judgeByExt(ext, size, config);
        if (extResult === BLOCK) {
            return { result: BLOCK, ext, mime, size, fileName };
        }
        if (extResult === HIT) {
            return { result: HIT, ext, mime, size, fileName };
        }

        // 第三步：Content-Disposition 兜底
        if (input.disposition) {
            fileName = extractDispositionFileName(input.disposition);
            if (fileName) {
                const dotIndex = fileName.lastIndexOf('.');
                if (dotIndex > 0) {
                    const dispExt = fileName.slice(dotIndex + 1).toLowerCase();
                    const dispResult = judgeByExt(dispExt, size, config);
                    if (dispResult === BLOCK) {
                        return { result: BLOCK, ext: dispExt, mime, size, fileName };
                    }
                    if (dispResult === HIT) {
                        return { result: HIT, ext: dispExt, mime, size, fileName };
                    }
                }
            }
        }

        return { result: MISS, ext, mime, size, fileName };
    }

    /**
 * 根据 MIME 推断扩展名（当 URL 无扩展名时使用）
 * @param {string} mime
 * @returns {string}
 */
    function mimeToExt(mime) {
        if (!mime) return '';
        const map = {
            'video/mp4': 'mp4',
            'video/webm': 'webm',
            'video/x-flv': 'flv',
            'video/mp2t': 'ts',
            'video/quicktime': 'mov',
            'video/x-matroska': 'mkv',
            'audio/mpeg': 'mp3',
            'audio/mp4': 'm4a',
            'audio/aac': 'aac',
            'audio/ogg': 'ogg',
            'audio/webm': 'weba',
            'audio/wav': 'wav',
            'audio/x-wav': 'wav',
            'audio/flac': 'flac',
            'application/vnd.apple.mpegurl': 'm3u8',
            'application/x-mpegurl': 'm3u8',
            'application/mpegurl': 'm3u8',
            'audio/mpegurl': 'm3u8',
            'audio/x-mpegurl': 'm3u8',
            'application/dash+xml': 'mpd'
        };
        if (map[mime]) return map[mime];
        if (mime.includes('/')) {
            const sub = mime.split('/')[1];
            if (sub && sub.length <= 6) return sub;
        }
        return '';
    }

    return {
        HIT,
        MISS,
        BLOCK,
        DEFAULT_EXT,
        DEFAULT_MIME,
        extractHeaders,
        extractDispositionFileName,
        judgeByMime,
        judgeByExt,
        judge,
        checkSize,
        mimeToExt
    };
})();
