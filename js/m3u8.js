/** 鲸吞：M3U8 解析器 */
var JTM3u8 = (function () {
    'use strict';

    /**
     * 把相对地址解析为绝对地址
     * @param {string} base 基准地址
     * @param {string} relative
     * @returns {string}
     */
    function resolveUrl(base, relative) {
        if (!relative) return '';
        if (/^https?:\/\//i.test(relative)) return relative;
        if (relative.startsWith('//')) {
            try {
                return new URL(base).protocol + relative;
            } catch (e) {
                return 'https:' + relative;
            }
        }
        try {
            return new URL(relative, base).href;
        } catch (e) {
            // 手工拼接回退
            if (relative.startsWith('/')) {
                try {
                    const u = new URL(base);
                    return u.protocol + '//' + u.host + relative;
                } catch (e2) {
                    return relative;
                }
            }
            const idx = base.lastIndexOf('/');
            return idx === -1 ? relative : base.slice(0, idx + 1) + relative;
        }
    }

    /**
     * 解析属性列表，例如 BANDWIDTH=1280000,RESOLUTION=1280x720
     * @param {string} str
     * @returns {Object}
     */
    function parseAttributes(str) {
        const attrs = {};
        if (!str) return attrs;

        // 按逗号分割，但要跳过引号内的逗号
        const parts = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            if (ch === '"') {
                inQuotes = !inQuotes;
                current += ch;
            } else if (ch === ',' && !inQuotes) {
                parts.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        if (current) parts.push(current);

        for (const part of parts) {
            const eq = part.indexOf('=');
            if (eq === -1) continue;
            const key = part.slice(0, eq).trim().toUpperCase();
            let value = part.slice(eq + 1).trim();
            if (value.startsWith('"') && value.endsWith('"')) {
                value = value.slice(1, -1);
            }
            attrs[key] = value;
        }
        return attrs;
    }

    /**
     * 解析 BYTERANGE，格式为 "长度@起始偏移"（偏移可省略）
     * @param {string} value
     * @param {number} previousEnd 上一个切片的结束位置
     * @returns {{length: number, offset: number}|null}
     */
    function parseByteRange(value, previousEnd) {
        if (!value) return null;
        const parts = String(value).split('@');
        const length = parseInt(parts[0], 10);
        if (isNaN(length)) return null;

        let offset;
        if (parts.length > 1) {
            offset = parseInt(parts[1], 10);
        } else {
            offset = previousEnd || 0;
        }
        if (isNaN(offset)) offset = 0;

        return { length: length, offset: offset };
    }

    /**
     * 判断某个 KEYFORMAT 能不能用裸密钥直接解
     * @param {string} keyFormat
     * @returns {boolean}
     */
    function isSupportedKeyFormat(keyFormat) {
        return !keyFormat || keyFormat === 'identity';
    }

    /**
     * 把 EXT-X-KEY / EXT-X-SESSION-KEY 的属性整理成统一的 key 对象
     * @param {Object} attrs
     * @param {string} baseUrl
     * @returns {Object|null}
     */
    function buildKey(attrs, baseUrl) {
        const method = String(attrs.METHOD || 'NONE').toUpperCase();

        if (method === 'NONE') return null;

        const keyFormat = attrs.KEYFORMAT || 'identity';

        const key = {
            method: method,
            uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : '',
            iv: attrs.IV || '',
            keyFormat: keyFormat
        };

        // SAMPLE-AES 需要解析样本级加密头（moof/traf + senc），
        // 与整段 AES-128 完全不是一回事；这里打个标记，
        // 下载时给出明确提示，而不是解出一堆乱码。
        if (method === 'SAMPLE-AES' || method === 'SAMPLE-AES-CTR') {
            key.sampleEncrypted = true;
        }

        // 非 identity 的 KEYFORMAT 意味着密钥要通过 DRM 许可服务器协商，
        // 扩展拿不到裸密钥
        if (!isSupportedKeyFormat(keyFormat)) {
            key.unsupported = true;
        }

        return key;
    }

    /**
     * 解析 #EXT-X-MEDIA 行
     * @param {string} payload 冒号后面的部分
     * @param {string} baseUrl
     * @returns {Object}
     */
    function parseRendition(payload, baseUrl) {
        const attrs = parseAttributes(payload);
        const type = String(attrs.TYPE || '').toUpperCase();

        return {
            type: type,
            groupId: attrs['GROUP-ID'] || '',
            name: attrs.NAME || '',
            language: attrs.LANGUAGE || '',
            assocLanguage: attrs['ASSOC-LANGUAGE'] || '',
            uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : '',
            isDefault: attrs.DEFAULT === 'YES',
            autoselect: attrs.AUTOSELECT === 'YES',
            forced: attrs.FORCED === 'YES',
            characteristics: attrs.CHARACTERISTICS || '',
            channels: attrs.CHANNELS || ''
        };
    }

    /**
     * 解析 #EXT-X-PART 行（低延迟 HLS 的分片片段）
     * @param {string} payload
     * @param {string} baseUrl
     * @returns {Object|null}
     */
    function parsePart(payload, baseUrl) {
        const attrs = parseAttributes(payload);
        if (!attrs.URI) return null;

        return {
            url: resolveUrl(baseUrl, attrs.URI),
            duration: parseFloat(attrs.DURATION) || 0,
            independent: attrs.INDEPENDENT === 'YES',
            byteRange: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, 0) : null
        };
    }

    /**
     * 解析 #EXT-X-PRELOAD-HINT 行
     * @param {string} payload
     * @param {string} baseUrl
     * @returns {Object|null}
     */
    function parsePreloadHint(payload, baseUrl) {
        const attrs = parseAttributes(payload);
        if (!attrs.URI) return null;

        return {
            type: String(attrs.TYPE || 'PART').toUpperCase(),
            url: resolveUrl(baseUrl, attrs.URI),
            byteRange: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, 0) : null
        };
    }

    /**
     * 解析 m3u8 文本
     * @param {string} text m3u8 内容
     * @param {string} baseUrl 用于解析相对地址的基准 URL
     * @returns {Object} 解析结果
     */
    function parse(text, baseUrl) {
        const result = {
            ok: false,
            error: '',
            isMaster: false,
            isEndList: false,
            /** 直播（媒体播放列表且没有 EXT-X-ENDLIST） */
            isLive: false,
            /** 事件型播放列表：只追加，不滑动 */
            isEvent: false,
            playlistType: '',
            /** 差分播放列表（EXT-X-SKIP） */
            isDelta: false,
            skippedSegments: 0,
            iFramesOnly: false,
            startPosition: -1,
            version: 1,
            targetDuration: 0,
            mediaSequence: 0,
            levels: [],
            segments: [],
            initSegment: null,
            /** 备用音轨、字幕轨（EXT-X-MEDIA） */
            renditions: [],
            /** 主播放列表级别的密钥（EXT-X-SESSION-KEY） */
            sessionKeys: [],
            /** 还没等到完整分片的 LL-HLS 片段 */
            preloadHint: null,
            hasEncryption: false,
            keyMethod: '',
            sampleEncrypted: false,
            totalDuration: 0
        };

        if (!text || typeof text !== 'string') {
            result.error = '内容为空';
            return result;
        }

        const trimmed = text.trim();
        if (!trimmed.startsWith('#EXTM3U')) {
            result.error = '不是有效的 M3U8 文件（缺少 #EXTM3U 头）';
            return result;
        }

        const lines = trimmed.split(/\r?\n/);
        let pendingDuration = 0;
        let pendingTitle = '';
        let pendingByteRange = null;
        let pendingParts = [];
        let pendingBitrate = 0;
        let currentKey = null;
        let currentMap = null;
        let byteRangeEnd = 0;
        let streamInfAttrs = null;
        let discontinuity = false;
        let gap = false;
        let index = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // ---------- 标签行 ----------
            if (line.startsWith('#')) {
                if (line.startsWith('#EXT-X-VERSION:')) {
                    result.version = parseInt(line.slice(15), 10) || 1;
                    continue;
                }

                if (line.startsWith('#EXT-X-TARGETDURATION:')) {
                    result.targetDuration = parseInt(line.slice(22), 10) || 0;
                    continue;
                }

                if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                    result.mediaSequence = parseInt(line.slice(22), 10) || 0;
                    continue;
                }

                if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
                    result.playlistType = line.slice(21).trim().toUpperCase();
                    result.isEvent = result.playlistType === 'EVENT';
                    continue;
                }

                if (line.startsWith('#EXT-X-ENDLIST')) {
                    result.isEndList = true;
                    continue;
                }

                if (line.startsWith('#EXT-X-I-FRAMES-ONLY')) {
                    // 只有 I 帧的播放列表是给拖动进度条用的，
                    // 拿来当正片下载会得到一堆没有画面的 GOP
                    result.iFramesOnly = true;
                    continue;
                }

                if (line.startsWith('#EXT-X-SKIP:')) {
                    // 差分更新：服务器只发增量，前面的分片没在这份文本里。
                    // 单独下载这份清单会得到一段缺头的视频，必须让用户知道。
                    result.isDelta = true;
                    result.skippedSegments = parseInt(
                        (parseAttributes(line.slice(12))['SKIPPED-SEGMENTS'] || '0'), 10) || 0;
                    continue;
                }

                if (line.startsWith('#EXT-X-START:')) {
                    const attrs = parseAttributes(line.slice(13));
                    const offset = parseFloat(attrs['TIME-OFFSET']);
                    if (!isNaN(offset)) result.startPosition = offset;
                    continue;
                }

                if (line.startsWith('#EXT-X-DISCONTINUITY')) {
                    discontinuity = true;
                    continue;
                }

                if (line.startsWith('#EXT-X-GAP')) {
                    // GAP 表示这一段没有真实内容（占位），下下来是空的
                    gap = true;
                    continue;
                }

                if (line.startsWith('#EXTINF:')) {
                    const payload = line.slice(8);
                    const comma = payload.indexOf(',');
                    if (comma === -1) {
                        pendingDuration = parseFloat(payload) || 0;
                        pendingTitle = '';
                    } else {
                        pendingDuration = parseFloat(payload.slice(0, comma)) || 0;
                        pendingTitle = payload.slice(comma + 1).trim();
                    }
                    continue;
                }

                if (line.startsWith('#EXT-X-BYTERANGE:')) {
                    pendingByteRange = parseByteRange(line.slice(17), byteRangeEnd);
                    continue;
                }

                if (line.startsWith('#EXT-X-BITRATE:')) {
                    // 单分片码率，仅用于展示
                    pendingBitrate = parseFloat((parseAttributes(line.slice(16))['BITRATE'] || '0')) || 0;
                    continue;
                }

                if (line.startsWith('#EXT-X-PART:')) {
                    // 低延迟 HLS：完整分片还没下完，先给出可下载的片段
                    const part = parsePart(line.slice(12), baseUrl);
                    if (part) pendingParts.push(part);
                    continue;
                }

                if (line.startsWith('#EXT-X-PRELOAD-HINT:')) {
                    result.preloadHint = parsePreloadHint(line.slice(20), baseUrl);
                    continue;
                }

                if (line.startsWith('#EXT-X-KEY:')) {
                    const key = buildKey(parseAttributes(line.slice(11)), baseUrl);
                    currentKey = key;

                    if (key) {
                        result.hasEncryption = true;
                        result.keyMethod = key.method;
                        if (key.sampleEncrypted) result.sampleEncrypted = true;
                    }
                    continue;
                }

                if (line.startsWith('#EXT-X-SESSION-KEY:')) {
                    const key = buildKey(parseAttributes(line.slice(19)), baseUrl);
                    if (key) {
                        result.sessionKeys.push(key);
                        result.hasEncryption = true;
                        result.keyMethod = key.method;
                        if (key.sampleEncrypted) result.sampleEncrypted = true;
                    }
                    continue;
                }

                if (line.startsWith('#EXT-X-MAP:')) {
                    const attrs = parseAttributes(line.slice(11));
                    currentMap = {
                        url: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : '',
                        byteRange: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, 0) : null
                    };

                    // 兼容旧行为：第一个 MAP 同时作为整份清单的初始化段
                    if (!result.initSegment) {
                        result.initSegment = {
                            url: currentMap.url,
                            byteRange: currentMap.byteRange
                        };
                    }
                    continue;
                }

                if (line.startsWith('#EXT-X-STREAM-INF:')) {
                    // 主播放列表：记录码率信息，下一行非标签行是地址
                    result.isMaster = true;
                    streamInfAttrs = parseAttributes(line.slice(18));
                    continue;
                }

                if (line.startsWith('#EXT-X-MEDIA:')) {
                    // 备用音轨 / 字幕轨。以前这里是「记录不处理」，
                    // 结果是：只有独立音轨的流下下来没有声音，而用户完全不知道。
                    const rendition = parseRendition(line.slice(13), baseUrl);
                    if (rendition.type) result.renditions.push(rendition);
                    continue;
                }

                // 其他未知标签忽略
                continue;
            }

            // ---------- 地址行 ----------
            const url = resolveUrl(baseUrl, line);

            if (streamInfAttrs) {
                // 主播放列表中的一个码率档位
                const audioGroup = streamInfAttrs.AUDIO || '';
                const audioRenditions = audioGroup
                    ? result.renditions.filter((r) => r.type === 'AUDIO' && r.groupId === audioGroup)
                    : [];

                result.levels.push({
                    url: url,
                    bandwidth: parseInt(streamInfAttrs.BANDWIDTH, 10) || 0,
                    averageBandwidth: parseInt(streamInfAttrs['AVERAGE-BANDWIDTH'], 10) || 0,
                    resolution: streamInfAttrs.RESOLUTION || '',
                    codecs: streamInfAttrs.CODECS || '',
                    frameRate: streamInfAttrs['FRAME-RATE'] || '',
                    name: streamInfAttrs.NAME || '',
                    audioGroup: audioGroup,
                    audioRenditions: audioRenditions,
                    subtitles: streamInfAttrs.SUBTITLES || '',
                    videoRange: streamInfAttrs['VIDEO-RANGE'] || '',
                    // 主播放列表里的轨道通常是 fMP4，初始化段在各码率自己的清单里
                    isMasterLevel: true
                });
                streamInfAttrs = null;
                continue;
            }

            // 媒体播放列表中的一个切片
            const segment = {
                index: index++,
                url: url,
                duration: pendingDuration,
                title: pendingTitle,
                byteRange: pendingByteRange,
                key: currentKey,
                sequence: result.mediaSequence + index - 1,
                /** 紧跟在一个不连续点之后 */
                discontinuity: discontinuity,
                /** 占位段：没有真实内容 */
                gap: gap,
                /** 该分片自己的初始化段（EXT-X-MAP 可多次出现） */
                initSegment: currentMap,
                /** LL-HLS 片段 */
                parts: pendingParts.length > 0 ? pendingParts : null,
                bitrate: pendingBitrate
            };

            result.segments.push(segment);
            result.totalDuration += pendingDuration;

            if (currentMap && !result.initSegment) {
                result.initSegment = {
                    url: currentMap.url,
                    byteRange: currentMap.byteRange
                };
            }

            // 更新字节范围游标
            if (pendingByteRange) {
                byteRangeEnd = pendingByteRange.offset + pendingByteRange.length;
            } else {
                byteRangeEnd = 0;
            }

            // 复位这一段的临时状态
            pendingDuration = 0;
            pendingTitle = '';
            pendingByteRange = null;
            pendingParts = [];
            discontinuity = false;
            gap = false;
            pendingBitrate = 0;
        }

        // 主播放列表
        result.isLive = !result.isMaster && !result.isEndList;
        result.isEvent = result.isEvent || (!result.isMaster && !result.isEndList && result.playlistType === 'EVENT');

        result.ok = result.isMaster ? result.levels.length > 0 : result.segments.length > 0;
        if (!result.ok) {
            result.error = result.isMaster ? '主播放列表中没有可用码率' : '没有解析到任何切片';
        }

        // 按码率从高到低排序，便于界面默认选最高画质
        if (result.isMaster) {
            result.levels.sort((a, b) => b.bandwidth - a.bandwidth);
        }

        return result;
    }

    /**
     * 按类型和语言挑一条备用轨道（音轨 / 字幕）
     *
     * 指定了语言却找不到时返回 null —— 字幕挑错语言和音轨挑错语言
     * 一样糟糕，静默给个中文轨只会让人以为「这片没有日语字幕」。
     * @param {Object} parsed parse() 的结果
     * @param {string} type AUDIO / SUBTITLES
     * @param {string} [language] 语言代码，例如 zh、en
     * @returns {Object|null}
     */
    function pickRendition(parsed, type, language) {
        if (!parsed || !Array.isArray(parsed.renditions)) return null;

        const wanted = String(type || '').toUpperCase();
        const list = parsed.renditions.filter((r) => r.type === wanted && r.uri);

        if (list.length === 0) return null;

        if (language) {
            const needle = String(language).toLowerCase();
            const exact = list.filter((r) => r.language &&
                r.language.toLowerCase().indexOf(needle) === 0);

            // 找不到就明确返回「没有」，不猜
            return exact.length > 0 ? exact[0] : null;
        }

        return list.filter((r) => r.isDefault)[0] || list[0];
    }

    /**
     * 使用 AES-128-CBC 解密一个切片
     * @param {ArrayBuffer} data 密文
     * @param {ArrayBuffer} key 16 字节密钥
     * @param {string} ivHex IV（十六进制，可带 0x 前缀）
     * @param {number} sequence 切片序号（未提供 IV 时用它推导）
     * @returns {Promise<ArrayBuffer>}
     */
    async function decryptAes128(data, key, ivHex, sequence) {
        let iv;
        if (ivHex) {
            const clean = String(ivHex).replace(/^0x/i, '');
            iv = hexToBytes(clean);
        } else {
            // 未显式给出 IV 时，按 HLS 规范用媒体序号作为 IV
            iv = new Uint8Array(16);
            const view = new DataView(iv.buffer);
            view.setUint32(12, sequence >>> 0, false);
        }

        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            key,
            { name: 'AES-CBC' },
            false,
            ['decrypt']
        );

        return crypto.subtle.decrypt(
            { name: 'AES-CBC', iv: iv },
            cryptoKey,
            data
        );
    }

    /**
     * 十六进制字符串转字节数组
     * @param {string} hex
     * @returns {Uint8Array}
     */
    function hexToBytes(hex) {
        const clean = hex.length % 2 === 0 ? hex : '0' + hex;
        const bytes = new Uint8Array(clean.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
        }
        return bytes;
    }

    /**
     * 由清单本身推断输出容器，不做「改扩展名」式的假转换
     * @param {Object} parsed parse() 的结果
     * @returns {{ext: string, mime: string}}
     */
    function suggestOutput(parsed) {
        const isFmp4 = !!(parsed && parsed.initSegment);
        return isFmp4
            ? { ext: 'mp4', mime: 'video/mp4' }
            : { ext: 'ts', mime: 'video/mp2t' };
    }

    return {
        parse,
        parseAttributes,
        parseByteRange,
        parseRendition,
        parsePart,
        pickRendition,
        isSupportedKeyFormat,
        resolveUrl,
        decryptAes128,
        hexToBytes,
        suggestOutput
    };
})();