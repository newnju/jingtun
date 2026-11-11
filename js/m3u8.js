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
            version: 1,
            targetDuration: 0,
            mediaSequence: 0,
            levels: [],
            segments: [],
            initSegment: null,
            hasEncryption: false,
            keyMethod: '',
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
        let currentKey = null;
        let byteRangeEnd = 0;
        let streamInfAttrs = null;
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

                if (line.startsWith('#EXT-X-ENDLIST')) {
                    result.isEndList = true;
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

                if (line.startsWith('#EXT-X-KEY:')) {
                    const attrs = parseAttributes(line.slice(11));
                    const method = (attrs.METHOD || 'NONE').toUpperCase();

                    if (method === 'NONE') {
                        currentKey = null;
                    } else {
                        result.hasEncryption = true;
                        result.keyMethod = method;
                        currentKey = {
                            method: method,
                            uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : '',
                            iv: attrs.IV || '',
                            keyFormat: attrs.KEYFORMAT || 'identity'
                        };
                    }
                    continue;
                }

                if (line.startsWith('#EXT-X-MAP:')) {
                    const attrs = parseAttributes(line.slice(11));
                    result.initSegment = {
                        url: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : '',
                        byteRange: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, 0) : null
                    };
                    continue;
                }

                if (line.startsWith('#EXT-X-STREAM-INF:')) {
                    // 主播放列表：记录码率信息，下一行非标签行是地址
                    result.isMaster = true;
                    streamInfAttrs = parseAttributes(line.slice(18));
                    continue;
                }

                if (line.startsWith('#EXT-X-MEDIA:')) {
                    // 备用音轨/字幕轨，第一版仅记录不处理
                    continue;
                }

                // 其他未知标签忽略
                continue;
            }

            // ---------- 地址行 ----------
            const url = resolveUrl(baseUrl, line);

            if (streamInfAttrs) {
                // 主播放列表中的一个码率档位
                result.levels.push({
                    url: url,
                    bandwidth: parseInt(streamInfAttrs.BANDWIDTH, 10) || 0,
                    averageBandwidth: parseInt(streamInfAttrs['AVERAGE-BANDWIDTH'], 10) || 0,
                    resolution: streamInfAttrs.RESOLUTION || '',
                    codecs: streamInfAttrs.CODECS || '',
                    frameRate: streamInfAttrs['FRAME-RATE'] || '',
                    name: streamInfAttrs.NAME || ''
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
                sequence: result.mediaSequence + index - 1
            };

            result.segments.push(segment);
            result.totalDuration += pendingDuration;

            // 更新字节范围游标
            if (pendingByteRange) {
                byteRangeEnd = pendingByteRange.offset + pendingByteRange.length;
            } else {
                byteRangeEnd = 0;
            }

            pendingDuration = 0;
            pendingTitle = '';
            pendingByteRange = null;
        }

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
        resolveUrl,
        decryptAes128,
        hexToBytes,
        suggestOutput
    };
})();
