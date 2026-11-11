/** 鲸吞：M3U8 解析器界面逻辑 */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    const els = {
        urlInput: $('urlInput'),
        textInput: $('textInput'),
        btnParseUrl: $('btnParseUrl'),
        btnParseText: $('btnParseText'),
        statusCard: $('statusCard'),
        statusLine: $('statusLine'),
        levelsCard: $('levelsCard'),
        levelList: $('levelList'),
        segmentsCard: $('segmentsCard'),
        segmentCount: $('segmentCount'),
        segmentList: $('segmentList'),
        hideDownloaded: $('hideDownloadedSegments'),
        btnMergeTracks: $('btnMergeTracks'),
        btnLoadMoreSegments: $('btnLoadMoreSegments'),
        segSelectedHint: $('segSelectedHint'),
        segRangeStart: $('segRangeStart'),
        segRangeEnd: $('segRangeEnd'),
        btnSegSelectAll: $('btnSegSelectAll'),
        btnSegSelectNone: $('btnSegSelectNone'),
        btnSegInvert: $('btnSegInvert'),
        btnSegApplyRange: $('btnSegApplyRange'),
        rawCard: $('rawCard'),
        rawText: $('rawText'),
        btnToggleRaw: $('btnToggleRaw'),
        btnCopyRaw: $('btnCopyRaw'),
        downloadCard: $('downloadCard'),
        threadSelect: $('threadSelect'),
        skipDecrypt: $('skipDecrypt'),
        decryptKey: $('decryptKey'),
        autoCloseWhenDone: $('autoCloseWhenDone'),
        btnDownload: $('btnDownload'),
        btnAbort: $('btnAbort'),
        progressWrap: $('progressWrap'),
        progressFill: $('progressFill'),
        progressText: $('progressText')
    };

    /** 当前解析出的分片 */
    let currentSegments = [];
    /** 当前 m3u8 的地址（用于解析相对路径） */
    let currentBaseUrl = '';
    /** 当前正在运行的下载器 */
    let activeDownloader = null;

    /** 已经下载到本地的分片（存 index） */
    const downloadedSegs = new Set();

    /** 上一次解析的结果与原始文本（切换「隐藏已下载」时要重画列表） */
    let lastParsed = null;

    /** 当前清单的所有轨道（只有 DASH 会多于一条） */
    let currentTracks = null;
    let lastRawText = '';
    /** 当前建议的文件名 */
    let currentFileName = 'video';
    /** 当前清单的初始化段（fMP4 场景需要，必须排在最前） */
    let currentInitSegment = null;
    /** 从嗅探记录里继承来的请求头，供分片下载使用 */
    let currentHeaders = null;

    /** 被选中的分片下标 */
    let selectedSegs = new Set();

    /** 原始清单文本 */
    let currentRawText = '';

    // ============================================================
    // 请求头继承
    // ============================================================

    /** fetch 不允许设置的头，传给浏览器会被静默丢弃 */
    const FORBIDDEN_HEADERS = [
        'referer', 'origin', 'cookie', 'user-agent', 'host',
        'connection', 'content-length', 'accept-encoding', 'expect'
    ];

    /**
     * 从嗅探记录里找出这个地址的请求头
     * @param {string} url
     * @returns {Promise<Object|null>}
     */
    async function lookupHeaders(url) {
        try {
            const res = await chrome.runtime.sendMessage({ type: 'tool:getItem', url: url });
            const item = res && res.item;
            if (!item || !item.requestHeaders) return null;

            const out = {};
            for (const key of Object.keys(item.requestHeaders)) {
                const lower = key.toLowerCase();
                if (FORBIDDEN_HEADERS.indexOf(lower) !== -1) continue;
                if (lower.indexOf('sec-') === 0 || lower.indexOf('proxy-') === 0) continue;
                out[key] = item.requestHeaders[key];
            }
            return Object.keys(out).length > 0 ? out : null;
        } catch (e) {
            return null;
        }
    }

    // ============================================================
    // 界面辅助
    // ============================================================

    /**
     * 设置状态信息
     * @param {string} text
     * @param {'info'|'ok'|'error'} [kind]
     */
    function setStatus(text, kind) {
        els.statusCard.hidden = false;
        els.statusLine.textContent = text;
        els.statusLine.className = 'status-line' + (kind ? ' is-' + kind : '');
    }

    /** 隐藏所有结果区 */
    function resetResults() {
        els.levelsCard.hidden = true;
        els.segmentsCard.hidden = true;
        els.downloadCard.hidden = true;
        els.progressWrap.hidden = true;
        els.levelList.textContent = '';
        els.segmentList.textContent = '';
    }

    // ============================================================
    // 解析
    // ============================================================

    /**
     * 从链接解析
     * @param {string} url
     */
    async function parseFromUrl(url) {
        if (!url) {
            setStatus('请输入 M3U8 链接', 'error');
            return;
        }

        setStatus('正在请求 ' + url + ' …');
        resetResults();

        // 继承嗅探时捕获的请求头，供后续分片下载复用
        currentHeaders = await lookupHeaders(url);

        try {
            const text = await fetchPlaylist(url);

            // 文件名建议：从 URL 路径推断
            currentFileName = guessFileName(url);
            handleParsed(text, url);
        } catch (e) {
            setStatus('请求失败：' + e.message + '\n（若为跨域或防盗链限制，可改用「解析内容」直接粘贴）', 'error');
        }
    }

    /**
     * 取播放清单文本
     * @param {string} url
     * @returns {Promise<string>}
     */
    async function fetchPlaylist(url) {
        try {
            const res = await chrome.runtime.sendMessage({ type: 'tool:fetchText', url: url });
            if (res && res.ok && typeof res.text === 'string') {
                if (res.via === 'page') {
                    // 让用户知道这次是借页面身份取的，换个页面可能就不行
                    console.info('[鲸吞] 清单通过页面上下文取得');
                }
                return res.text;
            }
            throw new Error((res && res.error) || '未知错误');
        } catch (e) {
            // 后台不可用（极端情况）时退回直连，聊胜于无
            if (e && e.message && e.message.indexOf('未知错误') === -1) {
                const response = await fetch(url, { credentials: 'omit' });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.text();
            }
            throw e;
        }
    }

    /**
     * 从文本解析
     * @param {string} text
     */
    function parseFromText(text) {
        if (!text || !text.trim()) {
            setStatus('请粘贴 M3U8 内容', 'error');
            return;
        }
        resetResults();
        currentFileName = 'video';
        // 无基准地址时用当前页面地址回退
        handleParsed(text, location.href);
    }

    /**
     * 判断是不是 DASH 清单
     * @param {string} text
     * @returns {boolean}
     */
    function isMpdText(text) {
        const head = String(text || '').slice(0, 2000);
        return /<MPD[\s>]/i.test(head) || /urn:mpeg:dash:schema/i.test(head);
    }

    /**
     * 处理解析结果
     * @param {string} text
     * @param {string} baseUrl
     */
    function handleParsed(text, baseUrl) {
        currentBaseUrl = baseUrl;
        currentTracks = null;   // 非 DASH 清单没有多轨的概念

        if (els.btnMergeTracks) els.btnMergeTracks.hidden = true;

        // DASH 清单：先转成等价的 m3u8 文本，再走后面同一套流程。
        if (isMpdText(text)) {
            const mpd = JTMpd.parse(text, baseUrl);

            if (!mpd.ok) {
                setStatus('MPD 解析失败：' + (mpd.error || '未知错误'), 'error');
                return;
            }

            if (mpd.hasDrm) {
                setStatus(
                    '注意：这个流有 DRM 保护（' + mpd.drmSystems.join(' / ') +
                    '），下载后无法播放',
                    'error'
                );
                // 不 return，分片列表对用户仍有参考价值
            }

            // 取视频轨；纯音频流就取第一条
            const tracks = mpd.tracks || [];
            const track = tracks.filter((t) => t.type === 'video')[0] || tracks[0];

            if (!track) {
                setStatus('清单里没有可用的轨道', 'error');
                return;
            }

            // DASH 常把画面和声音分成两条轨。
            currentTracks = tracks;

            const otherTracks = tracks.filter((t) => t !== track);

            if (otherTracks.length > 0) {
                const names = otherTracks.map((t) => t.type || '未知').join(' / ');
                setStatus(
                    '这个清单有 ' + tracks.length + ' 条轨道（当前显示' +
                    (track.type || '第一条') + '轨，另有 ' + names +
                    '）。点「合并下载」可一次下完并合成一个文件',
                    'ok'
                );
            }

            const converted = JTMpd.toM3u8(track);

            if (!converted) {
                setStatus('这个 MPD 没有分片列表，无法下载', 'error');
                return;
            }

            // 有视频轨 + 音频轨才谈得上合并。纯视频或纯音频的清单
            // 显示这个按钮只会让人困惑。
            if (els.btnMergeTracks) {
                const hasV = tracks.some((t) => t.type === 'video');
                const hasA = tracks.some((t) => t.type === 'audio');
                els.btnMergeTracks.hidden = !(hasV && hasA);
            }

            text = converted;
            currentFileName = 'video';
        }

        const parsed = JTM3u8.parse(text, baseUrl);

        if (!parsed.ok) {
            setStatus('解析失败：' + (parsed.error || '未知错误'), 'error');
            return;
        }

        if (parsed.isMaster) {
            // 主播放列表：展示码率供选择
            setStatus(`识别为多码率清单，共 ${parsed.levels.length} 个档位，请选择画质`, 'ok');
            renderLevels(parsed.levels);
            return;
        }

        // 媒体播放列表：直接展示分片
        renderSegments(parsed, text);
    }

    /**
     * 渲染码率列表
     * @param {Array} levels
     */
    function renderLevels(levels) {
        els.levelsCard.hidden = false;
        els.levelList.textContent = '';

        levels.forEach((level, i) => {
            const row = document.createElement('div');
            row.className = 'level-item' + (i === 0 ? ' is-active' : '');

            const left = document.createElement('div');
            const name = document.createElement('div');
            name.className = 'level-name';
            name.textContent = level.resolution || level.name || `档位 ${i + 1}`;
            left.appendChild(name);

            const right = document.createElement('div');
            right.className = 'level-meta';
            const parts = [];
            if (level.bandwidth) {
                parts.push((level.bandwidth / 1000).toFixed(0) + ' kbps');
            }
            if (level.codecs) {
                parts.push(level.codecs);
            }
            right.textContent = parts.join(' · ') || '—';

            row.append(left, right);

            row.addEventListener('click', () => {
                for (const el of els.levelList.querySelectorAll('.level-item')) {
                    el.classList.toggle('is-active', el === row);
                }
                loadLevel(level.url);
            });

            els.levelList.appendChild(row);
        });

        // 自动加载最高码率
        if (levels.length > 0) {
            loadLevel(levels[0].url);
        }
    }

    /**
     * 加载某个码率的清单
     * @param {string} url
     */
    async function loadLevel(url) {
        setStatus('正在加载所选画质的分片列表…');
        els.segmentsCard.hidden = true;
        els.downloadCard.hidden = true;

        try {
            const text = await fetchPlaylist(url);
            const parsed = JTM3u8.parse(text, url);

            if (!parsed.ok) {
                setStatus('解析失败：' + (parsed.error || '未知错误'), 'error');
                return;
            }

            currentBaseUrl = url;
            renderSegments(parsed, text);
        } catch (e) {
            setStatus('加载失败：' + e.message, 'error');
        }
    }

    /**
     * 渲染分片列表
     * @param {Object} parsed
     */
    /**
     * 渲染分片列表
     * @param {Object} parsed 解析结果
     * @param {string} [rawText] 服务器返回的原始文本
     */
    function renderSegments(parsed, rawText) {
        currentSegments = parsed.segments;

        // 存下来：切换「隐藏已下载」时要拿它重画
        lastParsed = parsed;
        lastRawText = rawText || '';

        // 存下原始文本：解析结果不对时要能回头看服务器返回了什么。
        if (typeof rawText === 'string' && rawText) {
            currentRawText = rawText;
            if (els.rawCard) els.rawCard.hidden = false;
            if (els.rawText) els.rawText.value = rawText;
        }
        currentInitSegment = parsed.initSegment || null;

        const info = [];
        info.push(`共 ${parsed.segments.length} 个分片`);
        if (parsed.totalDuration > 0) {
            info.push(`总时长 ${JTUtils.secToTime(parsed.totalDuration)}`);
        }
        if (parsed.hasEncryption) {
            info.push(`加密方式 ${parsed.keyMethod}`);
        }
        if (parsed.initSegment) {
            info.push('含初始化段');
        }
        if (!parsed.isEndList) {
            info.push('注意：该清单未标记结束（可能是直播流）');
        }

        setStatus(info.join(' · '), 'ok');

        // 分片列表
        els.segmentsCard.hidden = false;
        els.segmentCount.textContent = String(parsed.segments.length);
        els.segmentList.textContent = '';

        // 默认全选。
        selectedSegs.clear();
        for (const seg of parsed.segments) selectedSegs.add(seg.index);

        // 范围输入框默认覆盖全部
        if (els.segRangeStart) els.segRangeStart.value = '1';
        if (els.segRangeEnd) els.segRangeEnd.value = String(parsed.segments.length);
        updateSelectionHint();

        // 分片列表：分批渲染。
        const PAGE_SIZE = 200;
        let rendered = 0;

        function buildRow(seg) {
            // 勾了「隐藏已下载」的话，已经拿到手的分片就不渲染了
            if (hideDownloaded() && downloadedSegs.has(seg.index)) {
                return null;
            }

            const row = document.createElement('div');
            row.className = 'segment-item' + (seg.key ? ' is-encrypted' : '');

            // 勾选框：长清单里往往只有几片有问题，
            // 全量重下既慢又可能反复挂在同一处
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.className = 'segment-check';
            check.checked = selectedSegs.has(seg.index);
            check.title = '是否下载这一片';
            // 全选/反选后要按这个下标把界面同步回来
            check.dataset.index = String(seg.index);

            check.addEventListener('change', function () {
                if (check.checked) {
                    selectedSegs.add(seg.index);
                } else {
                    selectedSegs.delete(seg.index);
                }
                updateSelectionHint();
            });

            row.appendChild(check);

            const index = document.createElement('span');
            index.className = 'segment-index';
            index.textContent = String(seg.index + 1);

            const url = document.createElement('span');
            url.className = 'segment-url';
            url.textContent = seg.url;
            url.title = seg.url;

            const duration = document.createElement('span');
            duration.className = 'segment-duration';
            duration.textContent = seg.duration ? seg.duration.toFixed(1) + 's' : '';

            row.append(index, url, duration);
            return row;
        }

        function appendSegments(from, count) {
            const fragment = document.createDocumentFragment();
            const end = Math.min(from + count, parsed.segments.length);

            for (let i = from; i < end; i++) {
                // buildRow 在「隐藏已下载」开着时会对已下载的分片返回 null
                const el = buildRow(parsed.segments[i]);
                if (el) fragment.appendChild(el);
            }

            els.segmentList.appendChild(fragment);
            rendered = end;
        }

        // 「加载更多」按钮在 HTML 里（id: btnLoadMoreSegments），
        const moreBtn = els.btnLoadMoreSegments;

        if (moreBtn) {
            moreBtn.onclick = function () {
                appendSegments(rendered, PAGE_SIZE);
                updateLoadMore();
            };
        }

        function updateLoadMore() {
            if (!moreBtn) return;

            const remaining = parsed.segments.length - rendered;

            if (remaining > 0) {
                moreBtn.hidden = false;
                moreBtn.textContent = '加载更多（还有 ' + remaining + ' 条）';
            } else {
                moreBtn.hidden = true;
            }
        }

        appendSegments(0, PAGE_SIZE);
        updateLoadMore();

        // 下载区
        els.downloadCard.hidden = false;
        els.btnDownload.disabled = false;
        els.btnAbort.hidden = true;
    }

    /**
     * 从 URL 猜测文件名
     * @param {string} url
     * @returns {string}
     */
    function guessFileName(url) {
        try {
            const u = new URL(url);
            const parts = u.pathname.split('/').filter(Boolean);
            // 取倒数第二段（最后一段通常是 index.m3u8）
            let name = parts.length >= 2 ? parts[parts.length - 2] : parts[0] || 'video';
            name = decodeURIComponent(name).replace(/\.(m3u8|m3u)$/i, '');
            return JTUtils.sanitizeFileName(name) || 'video';
        } catch (e) {
            return 'video';
        }
    }

    // ============================================================
    // 下载
    // ============================================================

    /** 开始下载 */
    async function startDownload() {
        if (currentSegments.length === 0) {
            setStatus('没有可下载的分片', 'error');
            return;
        }

        const threads = parseInt(els.threadSelect.value, 10) || 4;

        // 跳过解密：直接把分片上的密钥摘掉，下载器就不会去解密。
        const skipDecrypt = els.skipDecrypt ? els.skipDecrypt.checked : false;

        // 只下被选中的分片。
        let baseSegments = currentSegments.filter(function (seg) {
            return selectedSegs.has(seg.index);
        });

        if (baseSegments.length === 0) {
            setStatus("没有选中任何分片", "error");
            return;
        }

        // 注意：这里必须用 baseSegments（已按勾选过滤过）。
        if (skipDecrypt) {
            baseSegments = baseSegments.map(function (seg) {
                return Object.assign({}, seg, { key: null });
            });
        }

        // 手动指定的密钥：覆盖清单里自带的那个。
        const rawKey = els.decryptKey ? els.decryptKey.value : '';

        if (!skipDecrypt && rawKey && rawKey.trim()) {
            const keyBytes = parseKeyInput(rawKey);

            if (!keyBytes) {
                // 格式不对就停下，用错的 key 只会解出一堆垃圾，
                // 用户还以为是扩展坏了
                setStatus('密钥格式不对：需要 32 位十六进制或 24 位 base64', 'error');
                return;
            }

            baseSegments = baseSegments.map(function (seg) {
                if (!seg.key) return seg;
                return Object.assign({}, seg, {
                    key: Object.assign({}, seg.key, { key: keyBytes })
                });
            });
        }

        // 组装待下载列表。
        let segments = baseSegments;
        const output = JTM3u8.suggestOutput({ initSegment: currentInitSegment });
        const outputExt = output.ext;

        if (currentInitSegment && currentInitSegment.url) {
            const reindexed = baseSegments.map((seg, i) =>
                Object.assign({}, seg, { index: i + 1 })
            );
            const initSeg = {
                index: 0,
                url: currentInitSegment.url,
                duration: 0,
                title: '',
                byteRange: currentInitSegment.byteRange,
                key: skipDecrypt
                    ? null
                    : (baseSegments[0] ? baseSegments[0].key : null),
                sequence: 0
            };
            segments = [initSeg].concat(reindexed);
        }

        els.btnDownload.disabled = true;
        els.btnAbort.hidden = false;
        els.progressWrap.hidden = false;
        els.progressFill.style.width = '0%';
        els.progressText.textContent = '准备中…';

        activeDownloader = new JTDownloader.Downloader(segments, {
            threads: threads,
            headers: currentHeaders,
            onProgress: (p) => {
                els.progressFill.style.width = p.percent + '%';
                els.progressText.textContent =
                    `${p.completed}/${p.total} 分片 · ${JTUtils.byteToSize(p.bytes)} · ` +
                    `${JTUtils.byteToSize(p.speed)}/s` +
                    (p.failed > 0 ? ` · 失败 ${p.failed}` : '');
            }
        });

        try {
            const result = await activeDownloader.start();

            if (result.aborted) {
                setStatus('下载已中止', 'error');
                return;
            }

            if (result.parts.length === 0) {
                setStatus('下载失败：没有取到任何数据', 'error');
                return;
            }

            // 合并导出。容器类型由清单本身决定，不提供"改扩展名"式的假选项
            const blob = JTDownloader.Downloader.merge(result.parts, output.mime);

            const fileName = `${currentFileName}.${outputExt}`;
            triggerDownload(blob, fileName);

            // 成功的分片记下来。下次渲染时如果开着「隐藏已下载」就不显示了。
            // parts 里没有索引，所以按「选中的减去失败的」来算。
            for (const idx of selectedSegs) {
                downloadedSegs.add(idx);
            }
            for (const f of (result.failed || [])) {
                const idx = (f && typeof f.index === 'number') ? f.index : -1;
                if (idx >= 0) downloadedSegs.delete(idx);
            }

            const failedNote = result.failed.length > 0
                ? `，其中 ${result.failed.length} 个分片失败`
                : '';
            setStatus(
                `下载完成：${result.parts.length} 个分片，${JTUtils.byteToSize(blob.size)}${failedNote}`,
                result.failed.length > 0 ? 'error' : 'ok'
            );

            // 自动关闭只在完全成功时才关，
            // 有分片失败的话页面得留着，否则用户连哪里出错都看不到
            const autoClose = els.autoCloseWhenDone ? els.autoCloseWhenDone.checked : false;

            if (autoClose && result.failed.length === 0) {
                // 留一拍让用户看到"下载完成"，也确保下载确实已经开始
                setTimeout(function () { window.close(); }, 1200);
            }
        } catch (e) {
            setStatus('下载出错：' + e.message, 'error');
        } finally {
            els.btnDownload.disabled = false;
            els.btnAbort.hidden = true;
            activeDownloader = null;
        }
    }

    /**
     * 当前是否要隐藏已下载的分片
     * @returns {boolean}
     */
    function hideDownloaded() {
        if (els.hideDownloaded) return els.hideDownloaded.checked;
        return JTConfig.get('hideDownloadedSegments') === true;
    }

    /**
     * 把一条轨道完整下下来，拼成连续的字节
     * @param {Object} track
     * @returns {Promise<Uint8Array>}
     */
    async function downloadTrackData(track) {
        const m3u8Text = JTMpd.toM3u8(track);
        if (!m3u8Text) throw new Error('这条轨道没有分片列表');

        const parsed = JTM3u8.parse(m3u8Text, currentBaseUrl);
        if (!parsed.ok || !parsed.segments.length) {
            throw new Error('轨道解析失败：' + (parsed.error || '没有分片'));
        }

        // fMP4 的初始化段必须排在最前，否则拼出来的文件播不了，
        let segments = parsed.segments;

        if (parsed.initSegment && parsed.initSegment.url) {
            // 重新编号：init 占 0，原来的分片往后挪一位，
            // 否则下载器按 index 写数组时会出现负索引
            const reindexed = parsed.segments.map((seg, i) =>
                Object.assign({}, seg, { index: i + 1 })
            );

            segments = [{
                index: 0,
                url: parsed.initSegment.url,
                duration: 0,
                title: '',
                byteRange: parsed.initSegment.byteRange,
                key: parsed.segments[0] ? parsed.segments[0].key : null,
                sequence: 0
            }].concat(reindexed);
        }

        const dl = new JTDownloader.Downloader(segments, {
            threads: 4,
            headers: currentHeaders
        });

        const result = await dl.start();

        if (!result.parts || result.parts.length === 0) {
            throw new Error('没有取到任何分片');
        }

        // 拼成一个连续 buffer。
        // 分片顺序由下载器保证（init segment 已排在最前），这里只按序拼。
        let total = 0;
        for (const part of result.parts) total += part.byteLength;

        const out = new Uint8Array(total);
        let offset = 0;
        for (const part of result.parts) {
            out.set(new Uint8Array(part), offset);
            offset += part.byteLength;
        }

        return out;
    }

    /** 合并下载：把视频轨和音频轨都下下来，合成一个文件 */
    async function mergeAllTracks() {
        if (!currentTracks || currentTracks.length < 2) {
            setStatus('这个清单只有一条轨道，不需要合并', 'error');
            return;
        }

        const video = currentTracks.filter((t) => t.type === 'video')[0];
        const audio = currentTracks.filter((t) => t.type === 'audio')[0];

        if (!video || !audio) {
            setStatus('没有同时找到视频轨和音频轨', 'error');
            return;
        }

        if (!JTFfmpeg.isSupported()) {
            setStatus('当前环境不支持本地合并（需要 WebAssembly Worker）', 'error');
            return;
        }

        const btn = els.btnMergeTracks;
        if (btn) btn.disabled = true;

        try {
            setStatus('正在下载视频轨…');
            const videoData = await downloadTrackData(video);

            setStatus('正在下载音频轨…');
            const audioData = await downloadTrackData(audio);

            setStatus('正在合并（首次要加载 ffmpeg 核心，稍等）…');

            const merged = await JTFfmpeg.mergeTracks(
                videoData, audioData, 0,
                function (percent) {
                    setStatus('合并中 ' + percent + '%');
                }
            );

            if (!merged || merged.byteLength === 0) {
                setStatus('合并结果为空', 'error');
                return;
            }

            const name = (currentFileName || 'merged') + '.mp4';
            triggerDownload(new Blob([merged], { type: 'video/mp4' }), name);

            setStatus('合并完成：' + JTUtils.byteToSize(merged.byteLength), 'ok');
        } catch (e) {
            setStatus('合并失败：' + ((e && e.message) || e), 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /** 更新「已选 N 片」提示，并把可见行的勾选框同步到当前选择 */
    function updateSelectionHint() {
        const hint = els.segSelectedHint;
        const total = currentSegments.length;

        if (hint) {
            hint.textContent = selectedSegs.size === total
                ? '已全选（' + total + ' 片）'
                : '已选 ' + selectedSegs.size + ' / ' + total + ' 片';
        }

        if (!els.segmentList) return;

        const boxes = els.segmentList.querySelectorAll('.segment-check');

        for (let i = 0; i < boxes.length; i++) {
            const idx = Number(boxes[i].dataset.index);
            if (!isNaN(idx)) boxes[i].checked = selectedSegs.has(idx);
        }
    }

    /** 全选 */
    function selectAll() {
        for (const seg of currentSegments) selectedSegs.add(seg.index);
        updateSelectionHint();
    }

    /** 全不选 */
    function selectNone() {
        selectedSegs.clear();
        updateSelectionHint();
    }

    /** 反选：只下失败的几片时很好用 */
    function selectInvert() {
        for (const seg of currentSegments) {
            if (selectedSegs.has(seg.index)) {
                selectedSegs.delete(seg.index);
            } else {
                selectedSegs.add(seg.index);
            }
        }
        updateSelectionHint();
    }

    /**
     * 解析用户手填的密钥
     * @param {string} text
     * @returns {ArrayBuffer|null}
     */
    function parseKeyInput(text) {
        if (!text) return null;
        const trimmed = text.trim();

        // 32 个十六进制字符 = 16 字节
        if (/^[0-9a-fA-F]{32}$/.test(trimmed)) {
            const bytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) {
                bytes[i] = parseInt(trimmed.substr(i * 2, 2), 16);
            }
            return bytes.buffer;
        }

        // base64 形式
        try {
            const raw = atob(trimmed);
            if (raw.length === 16) {
                const bytes = new Uint8Array(16);
                for (let i = 0; i < 16; i++) bytes[i] = raw.charCodeAt(i);
                return bytes.buffer;
            }
        } catch (e) {
            // 不是合法 base64，继续往下
        }

        return null;
    }

    /** 按序号范围选定 */
    function selectRange() {
        const start = parseInt(els.segRangeStart.value, 10) || 1;
        const end = parseInt(els.segRangeEnd.value, 10) || currentSegments.length;

        const from = Math.max(1, Math.min(start, end));
        const to = Math.min(currentSegments.length, Math.max(start, end));

        selectedSegs.clear();

        // 界面上的序号从 1 开始，内部 index 从 0 开始
        for (let n = from; n <= to; n++) selectedSegs.add(n - 1);

        updateSelectionHint();
    }

    /**
     * 触发浏览器下载
     * @param {Blob} blob
     * @param {string} fileName
     */
    function triggerDownload(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        setTimeout(() => URL.revokeObjectURL(url), 15000);
    }

    // ============================================================
    // 初始化
    // ============================================================

    function init() {
        JTUtils.setTitle('pageM3u8', 'M3U8 解析');

        els.btnParseUrl.addEventListener('click', () => {
            parseFromUrl(els.urlInput.value.trim());
        });

        els.btnParseText.addEventListener('click', () => {
            parseFromText(els.textInput.value);
        });

        els.urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                parseFromUrl(els.urlInput.value.trim());
            }
        });

        els.btnDownload.addEventListener('click', startDownload);

        // DASH 多轨合并
        if (els.btnMergeTracks) {
            els.btnMergeTracks.addEventListener('click', mergeAllTracks);
        }

        // ---------- 分片选择 ----------
        els.btnSegSelectAll.addEventListener('click', selectAll);
        els.btnSegSelectNone.addEventListener('click', selectNone);
        els.btnSegInvert.addEventListener('click', selectInvert);
        els.btnSegApplyRange.addEventListener('click', selectRange);

        // 「隐藏已下载」：初始状态读配置，改了就重画列表。
        if (els.hideDownloaded) {
            els.hideDownloaded.checked = JTConfig.get('hideDownloadedSegments') === true;

            els.hideDownloaded.addEventListener('change', function () {
                if (!lastParsed) return;

                const keep = new Set(selectedSegs);

                renderSegments(lastParsed, lastRawText);

                // renderSegments 会把选择重置成全选，这里恢复回去
                selectedSegs.clear();
                for (const i of keep) selectedSegs.add(i);
                updateSelectionHint();
            });
        }

        // 范围输入框回车即应用
        els.segRangeStart.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') selectRange();
        });
        els.segRangeEnd.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') selectRange();
        });

        // ---------- 原始清单 ----------
        //
        // 默认折叠：绝大多数时候用不上，占着整屏反而碍事。
        // 需要排查问题时再展开。
        els.btnToggleRaw.addEventListener('click', function () {
            // 原来这里写反了：拿 hidden 当"已折叠"，
            const expanded = !els.rawText.hidden;

            els.rawText.hidden = expanded;
            els.btnToggleRaw.textContent = expanded ? '展开' : '折叠';
        });

        els.btnCopyRaw.addEventListener('click', function () {
            if (!currentRawText) return;

            navigator.clipboard.writeText(currentRawText).then(function () {
                const original = els.btnCopyRaw.textContent;
                els.btnCopyRaw.textContent = '已复制';
                setTimeout(function () { els.btnCopyRaw.textContent = original; }, 1200);
            }).catch(function () {
                // 剪贴板不可用时不打扰用户，文本还在框里可以手动复制
            });
        });

        els.btnAbort.addEventListener('click', () => {
            if (activeDownloader) {
                activeDownloader.abort();
            }
        });

        // 若通过 URL 参数传入地址（例如从弹窗跳转过来），自动解析
        const params = new URLSearchParams(location.search);
        const presetUrl = params.get('url');
        if (presetUrl) {
            els.urlInput.value = presetUrl;

            const parsing = parseFromUrl(presetUrl);

            // autodown=1：解析完立刻开始下载，不用再点一次。
            // 批量下十几个的时候，每个页面都要点一下「开始下载」很烦。
            if (params.get('autodown') === '1' && parsing && typeof parsing.then === 'function') {
                parsing.then(function () {
                    // 解析失败时 currentSegments 是空的，这时保持手动，
                    // 自动重试只会让用户在毫不知情的情况下反复发起请求
                    if (currentSegments.length > 0) {
                        startDownload();
                    }
                }).catch(function () {
                    setStatus('自动下载失败：清单解析未完成，可手动再试', 'error');
                });
            }
        }
    }

    // 脚本位于 body 末尾，DOMContentLoaded 可能已触发，需按 readyState 判断
    /** 初始化失败时的回退处理 */
    function showInitError(e) {
        console.error('[鲸吞] 页面初始化失败:', e);

        try {
            const box = document.createElement('div');
            box.style.cssText =
                'padding:24px;text-align:center;color:#c0392b;' +
                'font:13px/1.6 system-ui,sans-serif';
            box.textContent =
                '页面初始化失败：' + ((e && e.message) || e) + '（按 F12 查看控制台）';

            const host = document.querySelector('main') ||
                document.querySelector('.wrap') ||
                document.querySelector('.container') ||
                document.body;

            if (host) {
                host.textContent = '';
                host.appendChild(box);
            }
        } catch (err) {
            // 回退处理再失败时只能报错
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            Promise.resolve(init()).catch(showInitError);
        });
    } else {
        Promise.resolve(init()).catch(showInitError);
    }
})();
