/** 鲸吞：DASH（MPD）解析 */
var JTMpd = (function () {
    'use strict';

    /** DRM 系统的 schemeIdUri 特征 */
    const DRM_SYSTEMS = [
        { id: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', name: 'Widevine' },
        { id: '9a04f079-9840-4286-ab92-e65be0885f95', name: 'PlayReady' },
        { id: '94ce86fb-07ff-4f43-adb8-93d2fa968ca2', name: 'FairPlay' },
        { id: '1077efecc0b24d02ace33c1e52e2fb4b', name: 'ClearKey' }
    ];

    /**
     * 解析 ISO 8601 时长（PT1H30M45.5S）
     * @param {string} str
     * @returns {number} 秒
     */
    function parseIsoDuration(str) {
        if (!str) return 0;

        const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(str);
        if (!m) return 0;

        return (parseFloat(m[1] || 0) * 31536000) +
            (parseFloat(m[2] || 0) * 2592000) +
            (parseFloat(m[3] || 0) * 86400) +
            (parseFloat(m[4] || 0) * 3600) +
            (parseFloat(m[5] || 0) * 60) +
            parseFloat(m[6] || 0);
    }

    /**
     * 查找标签，兼容带命名空间前缀的写法（<mpd:Period>）
     * @param {Element} root
     * @param {string} name
     * @returns {Array<Element>}
     */
    function tags(root, name) {
        if (!root) return [];
        const plain = root.getElementsByTagName(name);
        if (plain.length > 0) return Array.prototype.slice.call(plain);
        const ns = root.getElementsByTagNameNS('*', name);
        return Array.prototype.slice.call(ns);
    }

    /**
     * 直接子元素里找第一个指定标签
     * @param {Element} el
     * @param {string} name
     * @returns {Element|null}
     */
    function directChild(el, name) {
        if (!el || !el.children) return null;
        for (const child of el.children) {
            if (child.localName === name || child.nodeName === name) return child;
        }
        return null;
    }

    /**
     * 把相对地址补成绝对地址
     * @param {string} base
     * @param {string} rel
     * @returns {string}
     */
    function absolute(base, rel) {
        if (!rel) return '';
        if (/^https?:\/\//i.test(rel) || rel.indexOf('data:') === 0) return rel;
        try {
            return new URL(rel, base).href;
        } catch (e) {
            return rel;
        }
    }

    /**
     * 展开 SegmentTemplate 里的占位符
     * @param {string} template
     * @param {Object} rep
     * @param {number} number
     * @param {number} time
     * @returns {string}
     */
    function expandTemplate(template, rep, number, time) {
        if (!template) return '';

        return template.replace(/\$(\w+)(?:%0(\d+)d)?\$/g, function (match, name, pad) {
            let value;

            switch (name) {
                case 'Number': value = number; break;
                case 'Time': value = time; break;
                case 'RepresentationID': return rep.id || '';
                case 'Bandwidth': value = rep.bandwidth || 0; break;
                default: return match;
            }

            let str = String(value);
            if (pad) {
                while (str.length < parseInt(pad, 10)) str = '0' + str;
            }
            return str;
        });
    }

    /**
     * 检测 AdaptationSet 上的 DRM
     * @param {Element} adaptation
     * @returns {string[]} 系统名列表
     */
    function detectDrm(adaptation) {
        const found = [];

        for (const cp of tags(adaptation, 'ContentProtection')) {
            const scheme = cp.getAttribute('schemeIdUri') || '';
            if (!scheme) continue;

            let matched = false;
            for (const sys of DRM_SYSTEMS) {
                if (scheme.indexOf(sys.id) !== -1) {
                    if (found.indexOf(sys.name) === -1) found.push(sys.name);
                    matched = true;
                    break;
                }
            }

            // schemeIdUri 是 urn:uuid:xxx 但不在已知表里，也说明有加密
            if (!matched && scheme.indexOf('urn:uuid:') === 0 && found.indexOf('未知系统') === -1) {
                found.push('未知系统');
            }
        }

        return found;
    }

    /**
     * 从 SegmentTemplate 生成分片列表
     * @param {Element} template
     * @param {Element} representation
     * @param {Object} rep
     * @param {string} baseUrl
     * @param {number} periodDuration
     * @returns {Object|null} { initUrl, segments, totalDuration }
     */
    function fromSegmentTemplate(template, representation, rep, baseUrl, periodDuration) {
        const timescale = parseFloat(template.getAttribute('timescale') || '1') || 1;
        const segDurationRaw = parseFloat(template.getAttribute('duration') || '0');
        if (!segDurationRaw) return null;

        const segDuration = segDurationRaw / timescale;
        const startNumber = parseInt(template.getAttribute('startNumber') || '1', 10) || 1;

        // 总时长：优先用 Period 的，退而求其次用 Representation 的
        let total = periodDuration;
        const repDuration = representation.getAttribute('duration');
        if (repDuration) total = parseIsoDuration(repDuration);
        if (!total) return null;

        const count = Math.ceil(total / segDuration);
        const mediaTemplate = template.getAttribute('media') || '';
        const initTemplate = template.getAttribute('initialization') || '';

        const segments = [];
        for (let i = 0; i < count; i++) {
            const number = startNumber + i;
            // $Time$ 用「已过去的时长 × timescale」换算，这是 DASH 的约定
            const time = Math.round(i * segDurationRaw);

            segments.push({
                url: absolute(baseUrl, expandTemplate(mediaTemplate, rep, number, time)),
                duration: segDuration,
                byteRange: null
            });
        }

        return {
            initUrl: initTemplate ? absolute(baseUrl, expandTemplate(initTemplate, rep, startNumber, 0)) : '',
            segments: segments,
            totalDuration: total
        };
    }

    /**
     * 从 SegmentList 生成分片列表
     * @param {Element} list
     * @param {string} baseUrl
     * @returns {Object|null}
     */
    function fromSegmentList(list, baseUrl) {
        const timescale = parseFloat(list.getAttribute('timescale') || '1') || 1;
        const defaultDuration = parseFloat(list.getAttribute('duration') || '0') / timescale;

        const initEl = directChild(list, 'Initialization');
        const initUrl = initEl
            ? absolute(baseUrl, initEl.getAttribute('sourceURL') || '')
            : '';

        const segments = [];
        let total = 0;

        for (const urlEl of tags(list, 'SegmentURL')) {
            const media = urlEl.getAttribute('media') || urlEl.getAttribute('mediaRange') || '';
            if (!media) continue;

            const d = parseFloat(urlEl.getAttribute('duration') || '0') / timescale || defaultDuration;
            segments.push({
                url: absolute(baseUrl, media),
                duration: d,
                byteRange: null
            });
            total += d;
        }

        if (segments.length === 0) return null;

        return { initUrl: initUrl, segments: segments, totalDuration: total };
    }

    /**
     * SegmentBase：整个 Representation 是一个文件，用 Range 取
     * @param {Element} base
     * @param {Object} rep
     * @param {string} baseUrl
     * @param {number} periodDuration
     * @returns {Object|null}
     */
    function fromSegmentBase(base, rep, baseUrl, periodDuration) {
        if (!rep.sourceUrl) return null;

        const initEl = directChild(base, 'Initialization');
        let initUrl = '';
        let mediaRange = null;

        if (initEl && initEl.getAttribute('range')) {
            const parts = initEl.getAttribute('range').split('-');
            initUrl = rep.sourceUrl;
            mediaRange = {
                offset: parseInt(parts[0], 10) || 0,
                length: (parseInt(parts[1], 10) || 0) - (parseInt(parts[0], 10) || 0) + 1
            };
        }

        return {
            initUrl: initUrl,
            segments: [{
                url: rep.sourceUrl,
                duration: periodDuration || 0,
                byteRange: mediaRange
            }],
            totalDuration: periodDuration || 0
        };
    }

    /**
     * 解析 MPD 文本
     * @param {string} text MPD 原文
     * @param {string} baseUrl 清单地址（用于补全相对路径）
     * @returns {Object} { ok, error, duration, isLive, hasDrm, drmSystems, tracks }
     */
    function parse(text, baseUrl) {
        const result = {
            ok: false,
            error: '',
            duration: 0,
            isLive: false,
            hasDrm: false,
            drmSystems: [],
            tracks: []
        };

        if (!text || typeof text !== 'string') {
            result.error = '内容为空';
            return result;
        }

        if (!/<(?:[\w.-]+:)?MPD[\s>/]/.test(text)) {
            // 兼容带命名空间前缀的写法（<mpd:MPD>），不能写死 '<MPD'
            result.error = '不是有效的 MPD 文件';
            return result;
        }

        let doc;
        try {
            doc = new DOMParser().parseFromString(text, 'application/xml');
        } catch (e) {
            result.error = 'XML 解析失败：' + (e.message || e);
            return result;
        }

        // DOMParser 遇到错误会返回含 parsererror 的文档
        if (doc.getElementsByTagName('parsererror').length > 0) {
            result.error = 'XML 格式错误';
            return result;
        }

        const mpd = tags(doc, 'MPD')[0];
        if (!mpd) {
            result.error = '找不到 MPD 根节点';
            return result;
        }

        result.duration = parseIsoDuration(mpd.getAttribute('mediaPresentationDuration'));
        result.isLive = (mpd.getAttribute('type') || 'static') === 'dynamic';

        const periods = tags(mpd, 'Period');
        if (periods.length === 0) {
            result.error = 'MPD 里没有 Period';
            return result;
        }

        // 只处理第一个 Period。多 Period 意味着内容被切成多段，
        // 拼接语义复杂（需要处理 PeriodStart 偏移），先不碰。
        const period = periods[0];
        const periodDuration = parseIsoDuration(period.getAttribute('duration')) || result.duration;

        const allDrm = [];

        for (const adaptation of tags(period, 'AdaptationSet')) {
            const mimeType = adaptation.getAttribute('mimeType') ||
                (adaptation.getAttribute('contentType') || '') + '/mp4';
            const type = mimeType.indexOf('audio') === 0 ? 'audio'
                : mimeType.indexOf('video') === 0 ? 'video'
                    : 'other';

            const drmSystems = detectDrm(adaptation);
            for (const s of drmSystems) {
                if (allDrm.indexOf(s) === -1) allDrm.push(s);
            }

            for (const representation of tags(adaptation, 'Representation')) {
                const rep = {
                    id: representation.getAttribute('id') || '',
                    bandwidth: parseInt(representation.getAttribute('bandwidth') || '0', 10) || 0,
                    width: parseInt(representation.getAttribute('width') || '0', 10) || 0,
                    height: parseInt(representation.getAttribute('height') || '0', 10) || 0,
                    codecs: representation.getAttribute('codecs') || adaptation.getAttribute('codecs') || '',
                    mimeType: representation.getAttribute('mimeType') || mimeType,
                    lang: adaptation.getAttribute('lang') || '',
                    sourceUrl: absolute(baseUrl, representation.getAttribute('sourceURL') || '')
                };

                // SegmentTemplate / List / Base 可能在 AdaptationSet 或 Representation 层，
                // 按「就近优先」向上找
                const templateEl = directChild(representation, 'SegmentTemplate') ||
                    directChild(adaptation, 'SegmentTemplate');
                const listEl = directChild(representation, 'SegmentList') ||
                    directChild(adaptation, 'SegmentList');
                const baseEl = directChild(representation, 'SegmentBase') ||
                    directChild(adaptation, 'SegmentBase');

                let addressing = null;
                let mode = '';

                if (templateEl) {
                    addressing = fromSegmentTemplate(templateEl, representation, rep, baseUrl, periodDuration);
                    mode = 'SegmentTemplate';
                } else if (listEl) {
                    addressing = fromSegmentList(listEl, baseUrl);
                    mode = 'SegmentList';
                } else if (baseEl) {
                    addressing = fromSegmentBase(baseEl, rep, baseUrl, periodDuration);
                    mode = 'SegmentBase';
                }

                if (!addressing || addressing.segments.length === 0) continue;

                result.tracks.push({
                    id: rep.id,
                    type: type,
                    mimeType: rep.mimeType,
                    codecs: rep.codecs,
                    bandwidth: rep.bandwidth,
                    width: rep.width,
                    height: rep.height,
                    lang: rep.lang,
                    mode: mode,
                    initUrl: addressing.initUrl,
                    segments: addressing.segments,
                    totalDuration: addressing.totalDuration
                });
            }
        }

        result.drmSystems = allDrm;
        result.hasDrm = allDrm.length > 0;

        if (result.tracks.length === 0) {
            result.error = '没有解析出任何可下载的轨道';
            return result;
        }

        result.ok = true;
        return result;
    }

    /**
     * 把一条轨道转写成 m3u8 文本
     * @param {Object} track parse() 返回的 tracks 中的一项
     * @returns {string}
     */
    function toM3u8(track) {
        if (!track || !track.segments || track.segments.length === 0) return '';

        const lines = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            '#EXT-X-PLAYLIST-TYPE:VOD'
        ];

        // 目标时长按规范取分片时长的最大值（向上取整）
        let maxDuration = 0;
        for (const seg of track.segments) {
            if (seg.duration > maxDuration) maxDuration = seg.duration;
        }
        lines.push('#EXT-X-TARGETDURATION:' + Math.max(1, Math.ceil(maxDuration)));
        lines.push('#EXT-X-MEDIA-SEQUENCE:0');

        // EXT-X-MAP 让下游知道这是 fMP4，输出扩展名会跟着变成 mp4
        if (track.initUrl) {
            lines.push('#EXT-X-MAP:URI="' + track.initUrl + '"');
        }

        for (const seg of track.segments) {
            lines.push('#EXTINF:' + (seg.duration || 0).toFixed(3) + ',');

            // 字节范围用 EXT-X-BYTERANGE 表达
            if (seg.byteRange && seg.byteRange.length) {
                lines.push('#EXT-X-BYTERANGE:' + seg.byteRange.length + '@' + seg.byteRange.offset);
            }

            lines.push(seg.url);
        }

        lines.push('#EXT-X-ENDLIST');
        return lines.join('\n');
    }

    /**
     * 给轨道生成一个可读的标签
     * @param {Object} track
     * @returns {string}
     */
    function trackLabel(track) {
        if (!track) return '未知';

        if (track.type === 'video') {
            const res = (track.width && track.height) ? track.width + '×' + track.height : '';
            return res || (track.codecs || '视频');
        }

        const lang = track.lang ? track.lang + ' ' : '';
        return lang + (track.codecs || '音频');
    }

    return {
        parse,
        toM3u8,
        trackLabel,
        parseIsoDuration
    };
})();
