/** 鲸吞：弹窗逻辑 */
(function () {
    'use strict';

    // ============================================================
    // 状态
    // ============================================================

    let currentTabId = null;
    let items = [];
    let config = null;
    let captureActive = false;
    let recordingActive = false;
    /** 批量选中的 URL */
    const selectedUrls = new Set();
    /** 正则筛选文本 */
    let filterRegexText = '';

    /** 每批渲染多少条 */
    const RENDER_PAGE_SIZE = 100;
    /** 当前已渲染上限，点「加载更多」时递增 */
    let renderLimit = RENDER_PAGE_SIZE;

    // ============================================================
    // DOM 引用
    // ============================================================

    const $ = (id) => document.getElementById(id);

    const els = {
        count: $('count'),
        enableToggle: $('enableToggle'),
        drmBanner: $('drmBanner'),
        drmSystem: $('drmSystem'),
        drmClose: $('drmClose'),
        keyBanner: $('keyBanner'),
        keyCount: $('keyCount'),
        keyList: $('keyList'),
        keyClose: $('keyClose'),
        scope: $('scope'),
        btnMore: $('btnMore'),
        morePanel: $('morePanel'),
        btnMobile: $('btnMobile'),
        btnExpandAll: $('btnExpandAll'),
        btnCollapseAll: $('btnCollapseAll'),
        btnDedupe: $('btnDedupe'),
        btnBatchSend: $('btnBatchSend'),
        btnBatchMerge: $('btnBatchMerge'),
        btnPopup: $('btnPopup'),
        toolbar: $('toolbar'),
        list: $('list'),
        status: $('status'),
        btnSearch: $('btnSearch'),
        btnCapture: $('btnCapture'),
        btnRecord: $('btnRecord'),
        btnExport: $('btnExport'),
        btnClear: $('btnClear'),
        btnM3u8: $('btnM3u8'),
        btnDownloader: $('btnDownloader'),
        btnManage: $('btnManage'),
        btnOptions: $('btnOptions'),
        btnGuide: $('btnGuide'),

        // 流媒体详情面板
        detail: $('detail'),
        btnBack: $('btnBack'),
        detailTitle: $('detailTitle'),
        playerWrap: $('playerWrap'),
        video: $('video'),
        detailInfo: $('detailInfo'),
        levels: $('levels'),
        levelList: $('levelList'),
        progressWrap: $('progressWrap'),
        progressFill: $('progressFill'),
        progressText: $('progressText'),
        mergeHint: $('mergeHint'),
        mergeCmd: $('mergeCmd'),
        btnCopyMerge: $('btnCopyMerge'),
        btnStreamDownload: $('btnStreamDownload'),
        btnStreamPlay: $('btnStreamPlay'),
        btnStreamCopy: $('btnStreamCopy'),
        btnQrcode: $('btnQrcode'),
        qrMask: $('qrMask'),
        qrImg: $('qrImg'),
        qrTitle: $('qrTitle'),
        btnCopyM3u8dl: $('btnCopyM3u8dl'),
        btnCopyFfmpeg: $('btnCopyFfmpeg'),
        btnStreamJson: $('btnStreamJson'),
        btnStreamExternal: $('btnStreamExternal'),
        btnStreamTab: $('btnStreamTab'),
        btnWebrtc: $('btnWebrtc'),
        btnRegion: $('btnRegion'),
        btnRetryFailed: $('btnRetryFailed'),
        mediaBar: $('mediaBar'),
        btnMediaToggle: $('btnMediaToggle'),
        mediaIndex: $('mediaIndex'),
        mediaSpeed: $('mediaSpeed'),
        mediaVolume: $('mediaVolume'),
        btnMediaMuted: $('btnMediaMuted'),
        btnMediaLoop: $('btnMediaLoop'),
        btnMediaPip: $('btnMediaPip'),
        btnMediaFull: $('btnMediaFull'),
        btnMediaShot: $('btnMediaShot'),
        mediaSeek: $('mediaSeek'),
        mediaTime: $('mediaTime'),
        filterRegex: $('filterRegex'),
        batchBar: $('batchBar'),
        batchCount: $('batchCount'),
        btnSelectAll: $('btnSelectAll'),
        btnSelectReverse: $('btnSelectReverse'),
        btnBatchClear: $('btnBatchClear'),
        btnBatchDownload: $('btnBatchDownload')
    };

    // ============================================================
    // 详情面板状态
    // ============================================================

    /** 当前详情面板对应的资源 */
    let detailItem = null;
    /** 当前生效的媒体播放列表解析结果 */
    let detailParsed = null;
    /** 主列表里的码率档位 */
    let detailLevels = [];
    /** 用户选定的码率地址（媒体播放列表） */
    let selectedLevelUrl = '';
    /** 从嗅探记录继承的请求头，供播放时携带 */
    let detailHeaders = null;
    /** 当前页面捞到的密钥数量 */
    let detailKeyCount = 0;
    /** DASH（MPD）解析结果 */
    let detailMpd = null;
    /** 当前选中的 DASH 轨道索引 */
    let detailTrackIndex = -1;
    /** 当前 DASH 轨道转写成的 m3u8 文本，下载时直接用它 */
    let detailDashText = '';
    /** hls.js 实例 */
    let hls = null;
    /** hls.js 懒加载 Promise，避免重复插入 script */
    let hlsLoading = null;
    /** 正在跑的下载任务 id（非空时「下载」按钮变成「取消」） */
    let activeTaskId = null;

    /** fetch / XHR 不允许设置的头 */
    const FORBIDDEN_HEADERS = [
        'referer', 'origin', 'cookie', 'user-agent', 'host',
        'connection', 'content-length', 'accept-encoding', 'expect'
    ];

    // ============================================================
    // 工具
    // ============================================================

    /**
     * 设置底部状态文本
     * @param {string} text
     * @param {'info'|'ok'|'error'} [kind]
     */
    function setStatus(text, kind) {
        els.status.textContent = text;
        els.status.className = 'status' + (kind ? ' is-' + kind : '');
    }

    /**
     * 对资源分类，用于筛选
     * @param {Object} item
     * @returns {'stream'|'video'|'audio'|'other'}
     */
    function classify(item) {
        const ext = String(item.ext || '').toLowerCase();
        const mime = String(item.mime || '').toLowerCase();

        const streamExts = ['m3u8', 'm3u', 'mpd', 'ts', 'm4s', 'cmfv', 'cmfa'];
        const videoExts = ['mp4', 'm4v', 'flv', 'f4v', 'hlv', 'mkv', 'webm',
            'mov', 'avi', 'wmv', 'asf', 'mpeg', 'mpg', 'ogv', '3gp', 'divx'];
        const audioExts = ['mp3', 'm4a', 'aac', 'acc', 'wav', 'wma', 'ogg',
            'oga', 'opus', 'flac', 'weba'];

        if (streamExts.includes(ext)) return 'stream';
        if (videoExts.includes(ext)) return 'video';
        if (audioExts.includes(ext)) return 'audio';

        if (mime.startsWith('video/')) return 'video';
        if (mime.startsWith('audio/')) return 'audio';

        return 'other';
    }

    /** 分类对应的显示标签 */
    const CLASS_LABEL = {
        stream: '流',
        video: '视频',
        audio: '音频',
        other: '其他',
        drm: 'DRM'
    };

    // ============================================================
    // 渲染
    // ============================================================

    /** 重新渲染列表 */
    function render() {
        // 列表要重建了，先把旧的播放器停掉，
        // 否则它还在后台拉流，而 DOM 里的元素已经被丢掉了
        detachInlinePlayer();

        const filtered = items.filter((item) => {
            // DRM 条目不进列表，有专门的提示条
            return item.type !== 'drm';
        }).filter(matchesRegexFilter);

        // 倒序：最新的在最上面
        const ordered = config && config.reverseOrder
            ? filtered.slice()
            : filtered.slice().reverse();

        els.list.textContent = '';
        pendingPlayers.length = 0;   // 上一轮的残留丢掉

        if (ordered.length === 0) {
            els.list.appendChild(buildEmpty());
        } else {
            // 分批渲染。
            const page = ordered.slice(0, renderLimit);

            const fragment = document.createDocumentFragment();
            const groupOn = config && config.showGroup;
            const maxGap = (Number(config && config.groupTime) || 3) * 1000;

            for (let i = 0; i < page.length; i++) {
                const el = buildItem(page[i]);

                // 分组：时间挨着的连成一块。
                if (groupOn && i > 0 && page[i - 1] && page[i].time - page[i - 1].time <= maxGap) {
                    el.classList.add('is-grouped');
                }

                fragment.appendChild(el);
            }
            els.list.appendChild(fragment);

            const remaining = ordered.length - page.length;

            if (remaining > 0) {
                const more = document.createElement('button');
                more.className = 'act';
                more.style.cssText = 'display:block;width:100%;margin:10px 0;padding:8px';
                more.textContent = '加载更多（还有 ' + remaining + ' 条）';

                more.addEventListener('click', function () {
                    renderLimit += RENDER_PAGE_SIZE;
                    render();
                });

                els.list.appendChild(more);
            }
        }

        els.count.textContent = String(items.filter((i) => i.type !== 'drm').length);

        updateBatchBar();

        // 列表已经进 DOM 了，现在才能挂播放器。
        for (const pending of pendingPlayers) {
            attachInlinePlayer(pending.player, pending.item);
        }
        pendingPlayers.length = 0;
    }

    /**
     * 按用户输入的正则筛选
     * @param {Object} item
     * @returns {boolean}
     */
    function matchesRegexFilter(item) {
        if (!filterRegexText) return true;

        try {
            return new RegExp(filterRegexText, 'i').test(item.url);
        } catch (e) {
            return true;
        }
    }

    /** 更新批量操作条 */
    function updateBatchBar() {
        const count = selectedUrls.size;
        els.batchBar.hidden = count === 0;

        if (count > 0) {
            els.batchCount.textContent = '已选 ' + count + ' 项';
        }
    }

    /**
     * 切换某一项的选中状态
     * @param {string} url
     * @param {boolean} checked
     */
    function toggleSelect(url, checked) {
        if (checked) selectedUrls.add(url);
        else selectedUrls.delete(url);
        updateBatchBar();
    }

    /**
     * 批量选中 / 反选 / 取消
     * @param {'all'|'reverse'|'none'} mode
     */
    function batchSelect(mode) {
        // 只对当前可见（通过筛选）的项生效，否则「全选」会选中
        // 用户根本看不到的东西，那是惊吓不是功能
        const visible = items.filter((item) => {
            if (item.type === 'drm') return false;
            // 类型筛选已去掉，这里不再过滤 DRM，由上面的 render 统一处理
            return matchesRegexFilter(item);
        });

        if (mode === 'all') {
            for (const item of visible) selectedUrls.add(item.url);
        } else if (mode === 'reverse') {
            for (const item of visible) {
                if (selectedUrls.has(item.url)) selectedUrls.delete(item.url);
                else selectedUrls.add(item.url);
            }
        } else {
            selectedUrls.clear();
        }

        render();
    }

    /** 下载所有选中的资源 */
    async function batchDownload() {
        const targets = items.filter((item) => selectedUrls.has(item.url));

        if (targets.length === 0) {
            setStatus('没有选中任何资源', 'error');
            return;
        }

        els.btnBatchDownload.disabled = true;
        let done = 0;

        for (const item of targets) {
            try {
                await chrome.runtime.sendMessage({ type: 'popup:download', item: item });
                done++;
                setStatus(`正在下载 ${done} / ${targets.length}`);
            } catch (e) {
                // 单条失败不影响其余
            }

            // 错开发起，避免触发浏览器的并发下载限制
            await new Promise((resolve) => setTimeout(resolve, 300));
        }

        els.btnBatchDownload.disabled = false;
        setStatus(`已发起 ${done} 个下载`, 'ok');
        selectedUrls.clear();
        render();
    }

    /** 构造空状态节点 */
    function buildEmpty() {
        const wrap = document.createElement('div');
        wrap.className = 'empty';

        const mark = document.createElement('div');
        mark.className = 'empty-mark';

        const title = document.createElement('p');
        title.className = 'empty-title';
        title.textContent = '暂无捕获到的资源';

        const hint = document.createElement('p');
        hint.className = 'empty-hint';
        hint.textContent = '播放页面中的视频，或点击「深度搜索」主动探测';

        wrap.append(mark, title, hint);
        return wrap;
    }

    /**
     * 构造单条资源节点
     * @param {Object} item
     * @returns {HTMLElement}
     */
    function buildItem(item) {
        const row = document.createElement('div');
        row.className = 'item';

        // --- 来源网站图标 ---
        if (config && config.showWebIco && item.favIconUrl && item.type !== 'drm') {
            const ico = document.createElement('img');
            ico.className = 'item-ico';
            ico.src = item.favIconUrl;
            ico.alt = '';
            // 图标加载失败（站点没 favicon、被墙）就隐藏，别留个破图占位
            ico.addEventListener('error', function () { ico.hidden = true; });
            row.appendChild(ico);
        }

        // 点整行展开 / 收起。
        row.classList.add("is-clickable");
        row.addEventListener("click", function (e) {
            // 点在操作按钮或选择框上不算，那是要执行动作，不是展开
            if (e.target.closest(".item-actions")) return;
            if (e.target.closest(".item-check")) return;

            if (expandedSet.has(item.url)) expandedSet.delete(item.url);
            else expandedSet.add(item.url);
            render();
        });

        // --- 选择框（批量操作用）---
        // DRM 记录不是可下载资源，不给选择框
        if (item.type !== 'drm') {
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.className = 'item-check';
            check.checked = selectedUrls.has(item.url);
            check.addEventListener('change', () => {
                toggleSelect(item.url, check.checked);
            });
            // 点框本身别触发整行的点击
            check.addEventListener('click', (e) => e.stopPropagation());
            row.appendChild(check);
        }

        // --- 类型徽章 ---
        const badge = document.createElement('div');
        const cls = item.type === 'drm' ? 'drm' : classify(item);
        badge.className = 'item-badge' + (cls === 'stream' ? ' is-stream' : '') +
            (cls === 'drm' ? ' is-drm' : '');
        // 不打类型徽章。
        badge.hidden = true;
        row.appendChild(badge);

        // --- 主体信息 ---
        const main = document.createElement('div');
        main.className = 'item-main';

        const name = document.createElement('div');
        name.className = 'item-name';
        name.textContent = item.type === 'drm'
            ? '受 DRM 保护的内容，无法直接下载'
            : (item.name || item.url);
        name.title = item.url;

        main.appendChild(name);

        const meta = document.createElement('div');
        meta.className = 'item-meta';

        if (item.size) {
            meta.appendChild(makeMeta('大小', JTUtils.byteToSize(item.size)));
        }
        if (item.ext) {
            meta.appendChild(makeMeta('格式', item.ext.toUpperCase()));
        }
        if (item.drmSystem) {
            meta.appendChild(makeMeta('系统', item.drmSystem));
        }

        main.appendChild(meta);

        // --- 展开后显示的完整信息 ---
        if (expandedSet.has(item.url)) {
            const detail = document.createElement('div');
            detail.className = 'item-detail';

            // 能直接播的，先把播放器放最上面，
            // 点开就是为了看，不该让人先滚过一堆元信息
            if (isPlayableExt(item.ext)) {
                const player = document.createElement('video');
                player.className = 'item-player';
                player.controls = true;
                player.preload = 'metadata';
                player.playsInline = true;
                detail.appendChild(player);

                // 先排队，等整个列表进 DOM 后再挂，见 pendingPlayers 的注释
                pendingPlayers.push({ player: player, item: item });
            }

            const urlLine = document.createElement('div');
            urlLine.className = 'item-detail-url';
            urlLine.textContent = item.url;
            detail.appendChild(urlLine);

            // 页面标题：列表里的文件名常是一串 hash，光看名字认不出是哪一集。
            // 默认不显示，列表里的东西已经够多了，需要的人自己去设置里开。
            if (config && config.showPageTitle && item.pageTitle) {
                detail.appendChild(makeDetailLine('页面', item.pageTitle));
            }

            // 来源是排查用的技术细节，列表行上没它的位置，
            // 放展开区正合适
            if (item.source) {
                const sourceLabel = {
                    'deep-search': '深度搜索',
                    'xhr': 'XHR',
                    'fetch': 'Fetch',
                    'inline-m3u8': '内联 M3U8',
                    'inline-mpd': '内联 MPD',
                    'drm-detect': 'DRM 检测'
                }[item.source] || item.source;
                detail.appendChild(makeDetailLine('来源', sourceLabel));
            }

            if (item.referer) {
                detail.appendChild(makeDetailLine('Referer', item.referer));
            }
            if (item.headers && typeof item.headers === 'object') {
                for (const key of Object.keys(item.headers)) {
                    detail.appendChild(makeDetailLine(key, item.headers[key]));
                }
            }

            main.appendChild(detail);
        }

        row.appendChild(main);

        // --- 操作按钮 ---
        const actions = document.createElement('div');
        actions.className = 'item-actions';

        if (item.type === 'drm') {
            const hint = makeIconButton('capture', '去捕获（录制播放数据）');
            hint.addEventListener('click', handleCapture);
            actions.appendChild(hint);
        } else {
            // 只有播放列表才需要进详情面板解析。
            // 单个分片（ts / m4s）本身就是完整文件，直接下载即可。
            const ext = String(item.ext || '').toLowerCase();
            const isPlaylist = ext === 'm3u8' || ext === 'm3u' || ext === 'mpd';

            if (isPlaylist) {
                // hls.js 只认 m3u8；mpd 是 DASH，清单结构完全不同
                if (ext === 'm3u8' || ext === 'm3u') {
                    const playBtn = makeIconButton('play', '在弹窗内预览（支持 AES-128 加密）');
                    playBtn.addEventListener('click', () => openDetail(item, 'play'));
                    actions.appendChild(playBtn);
                }

                const dlBtn = makeIconButton('download', '解析分片并下载合并（可关闭弹窗）');
                dlBtn.classList.add('is-primary');
                dlBtn.addEventListener('click', () => openDetail(item, 'download'));
                actions.appendChild(dlBtn);

                const copyBtn = makeIconButton('copy', '复制地址');
                copyBtn.addEventListener('click', () => handleCopy(renderCopyText(item), copyBtn));
                actions.appendChild(copyBtn);
            } else {
                // 普通媒体文件与单个分片：直接交给浏览器下载
                if (isPlayableExt(item.ext)) {
                    const playBtn = makeIconButton('play', '就地展开播放');
                    playBtn.addEventListener('click', () => {
                        expandedSet.add(item.url);
                        render();
                    });
                    actions.appendChild(playBtn);
                }

                const downloadBtn = makeIconButton('download', '下载');
                downloadBtn.classList.add('is-primary');
                downloadBtn.addEventListener('click', () => handleDownload(item, downloadBtn));
                actions.appendChild(downloadBtn);

                const copyBtn = makeIconButton('copy', '复制地址');
                copyBtn.addEventListener('click', () => handleCopy(renderCopyText(item), copyBtn));
                actions.appendChild(copyBtn);
            }
        }

        // 删除单项。
        const delBtn = makeIconButton('remove',
            '从列表中移除这一条（不影响已下载的文件）');
        delBtn.addEventListener('click', () => removeItem(item, delBtn));
        actions.appendChild(delBtn);

        row.appendChild(actions);
        return row;
    }

    /**
     * 从列表中移除一条
     * @param {Object} item
     * @param {HTMLElement} btn 点击的按钮，用于禁用防连点
     */
    async function removeItem(item, btn) {
        if (!item || !item.url) return;

        if (btn) btn.disabled = true;

        try {
            await chrome.runtime.sendMessage({
                type: 'popup:removeItems',
                urls: [item.url]
            });

            // 本地列表同步移除，不必等后台回传
            items = items.filter((i) => i.url !== item.url);
            render();
        } catch (e) {
            if (btn) btn.disabled = false;
            setStatus('移除失败：' + ((e && e.message) || e), 'error');
        }
    }

    /**
     * 构造一条元信息
     * @param {string} label
     * @param {string} value
     * @returns {HTMLElement}
     */
    /** 能在弹窗里直接播的扩展名 */
    const PLAYABLE_EXTS = new Set([
        'm3u8', 'm3u', 'mp4', 'm4v', 'webm', 'ogg', 'ogv', 'mov'
    ]);

    function isPlayableExt(ext) {
        return PLAYABLE_EXTS.has(String(ext || '').toLowerCase());
    }

    /** 内嵌播放器 → hls 实例 */
    const inlineHlsMap = new WeakMap();

    /** 待挂载的播放器 */
    const pendingPlayers = [];

    /**
     * 给展开的条目挂一个播放器
     * @param {HTMLVideoElement} player
     * @param {Object} item
     */
    async function attachInlinePlayer(player, item) {
        const ext = String(item.ext || '').toLowerCase();

        // 普通文件：浏览器自己能放，直接给地址
        if (ext !== 'm3u8' && ext !== 'm3u') {
            player.src = item.url;
            return;
        }

        // HLS 要 hls.js
        const ok = await loadHls();

        // 等库加载的这段时间里用户可能已经折叠了，
        // 别往一个已经脱离文档的元素上挂
        if (!ok || !player.isConnected) return;

        try {
            const instance = new Hls({
                enableWorker: true,
                // 带上 Cookie，很多站点的清单有会话校验
                withCredentials: true,
                maxBufferLength: 30
            });

            instance.loadSource(item.url);
            instance.attachMedia(player);

            inlineHlsMap.set(player, instance);
        } catch (e) {
            // 播不了就算了，地址还在下面，用户可以复制走
        }
    }

    /** 停掉所有内嵌播放器 */
    function detachInlinePlayer() {
        for (const player of document.querySelectorAll('.item-player')) {
            const instance = inlineHlsMap.get(player);

            if (instance) {
                try { instance.destroy(); } catch (e) { /* 忽略 */ }
                inlineHlsMap.delete(player);
            }

            try {
                player.removeAttribute('src');
                player.load();
            } catch (e) { /* 忽略 */ }
        }
    }

/** 操作图标 */
const ICONS = {
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.6v10.8L13 8z"/></svg>',
    download: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v8.2M4.8 6.8L8 10l3.2-3.2M2.5 13.2h11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 5.5V3.6A1.6 1.6 0 008.9 2H3.6A1.6 1.6 0 002 3.6v5.3a1.6 1.6 0 001.6 1.6h1.9" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    remove: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    capture: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2"/></svg>'
};

/**
 * 造一个图标按钮
 * @param {string} icon ICONS 里的键
 * @param {string} title 悬停提示
 * @returns {HTMLButtonElement}
 */
function makeIconButton(icon, title) {
    const btn = document.createElement('button');
    btn.className = 'icon-act';
    // 用的是文件里写死的常量，不含任何用户数据
    btn.innerHTML = ICONS[icon] || '';
    btn.title = title;
    return btn;
}

    /**
     * 构造一行「标签：值」的详情
     * @param {string} label
     * @param {string} value
     * @returns {HTMLElement}
     */
    function makeDetailLine(label, value) {
        const line = document.createElement("div");
        line.className = "item-detail-line";

        const k = document.createElement("span");
        k.className = "item-detail-key";
        k.textContent = label;

        const v = document.createElement("span");
        v.className = "item-detail-val";
        v.textContent = String(value === undefined || value === null ? "" : value);

        line.append(k, v);
        return line;
    }

    function makeMeta(label, value) {
        const span = document.createElement('span');
        span.textContent = `${label} ${value}`;
        return span;
    }

    // ============================================================
    // 交互
    // ============================================================

    /**
     * 下载资源
     * @param {Object} item
     * @param {HTMLButtonElement} button
     */
    /**
     * 按钮的短暂状态反馈
     * @param {HTMLElement} button
     * @param {string} state is-busy / is-ok / is-fail
     * @param {number} [ms] 多少毫秒后自动恢复；不传就一直保持
     */
    function flashButton(button, state, ms) {
        if (!button) return;

        button.classList.remove('is-busy', 'is-ok', 'is-fail');
        button.classList.add(state);

        // busy 之外的状态都不该禁用按钮，用户可能想马上再点一次
        button.disabled = state === 'is-busy';

        if (ms) {
            setTimeout(() => {
                button.classList.remove(state);
                button.disabled = false;
            }, ms);
        }
    }

    /**
     * 下载资源
     * @param {Object} item
     * @param {HTMLButtonElement} button
     */
    async function handleDownload(item, button) {
        flashButton(button, 'is-busy');

        try {
            const result = await chrome.runtime.sendMessage({
                type: 'popup:download',
                item: item
            });

            if (result && result.ok) {
                setStatus('已开始下载', 'ok');
                flashButton(button, 'is-ok', 1500);
            } else {
                setStatus('下载失败：' + ((result && result.error) || '未知错误'), 'error');
                flashButton(button, 'is-fail', 1500);
            }
        } catch (e) {
            setStatus('下载失败：' + e.message, 'error');
            flashButton(button, 'is-fail', 1500);
        }
    }

    /**
     * 复制链接到剪贴板
     * @param {string} text
     * @param {HTMLButtonElement} button
     */
    /**
     * 按复制模板渲染要复制的内容
     * @param {Object} item
     * @returns {string}
     */
    /**
     * 显示二维码浮层
     * @param {string} text
     */
    function showQrcode(text) {
        if (!text) return;

        // 地址太长二维码会密到扫不出来，不如直接说清楚
        if (text.length > 1000) {
            setStatus('地址太长（' + text.length + ' 字符），二维码可能扫不出，建议用「复制链接」', 'error');
            return;
        }

        if (typeof qrcode !== 'function') {
            setStatus('二维码组件没加载，无法生成', 'error');
            return;
        }

        try {
            // typeNumber 0 = 自动选择最小可容纳的版本
            // 'M' = 中等纠错（约 15% 容错），扫码体验和密度的平衡点
            const qr = qrcode(0, 'M');
            qr.addData(text);
            qr.make();

            els.qrImg.innerHTML = qr.createImgTag(4, 8);
            els.qrTitle.textContent = '扫码在手机上打开';
            els.qrMask.hidden = false;
        } catch (e) {
            // 数据超出版本容量时会抛错
            setStatus('生成二维码失败：' + (e.message || e), 'error');
        }
    }

    /**
     * 按命令模板渲染一条完整的命令行
     * @param {string} key 配置项名（m3u8dlArg / ffmpegArg）
     * @param {string} program 程序名
     * @param {Object} item
     * @returns {string}
     */
    function renderCommand(key, program, item) {
        // 显式列出两个模板，而不是 config[key]，
        const templates = {
            m3u8dlArg: (config && config.m3u8dlArg) || '',
            ffmpegArg: (config && config.ffmpegArg) || ''
        };

        const template = templates[key] || '';
        if (!template) return program;

        const args = JTUtils.renderTemplate(template, {
            url: item.url || '',
            referer: item.pageUrl || '',
            pageUrl: item.pageUrl || '',
            origin: (function () {
                try { return new URL(item.pageUrl || item.url).origin; }
                catch (e) { return ''; }
            })(),
            title: item.pageTitle || item.name || 'video',
            name: item.name || '',
            ext: item.ext || 'mp4',
            size: item.size || 0
        });

        return program + ' ' + args;
    }

    function renderCopyText(item) {
        const template = (config && config.copyTemplate) || '${url}';

        return JTUtils.renderTemplate(template, {
            url: item.url || '',
            referer: item.pageUrl || '',
            pageUrl: item.pageUrl || '',
            title: item.pageTitle || item.name || '',
            name: item.name || '',
            ext: item.ext || ''
        });
    }

    /**
     * 复制文本，并在按钮上给个反馈
     * @param {string} text
     * @param {HTMLElement} [button]
     */
    async function handleCopy(text, button) {
        try {
            await navigator.clipboard.writeText(text);

            if (button) {
                if (button.classList.contains('icon-act')) {
                    button.classList.add('is-ok');
                    setTimeout(() => button.classList.remove('is-ok'), 1200);
                } else {
                    const original = button.textContent;
                    button.textContent = '已复制';
                    setTimeout(() => { button.textContent = original; }, 1200);
                }
            }

            setStatus('链接已复制', 'ok');
        } catch (e) {
            setStatus('复制失败', 'error');
        }
    }

    /**
     * 在新标签页打开扩展内置工具页，并把资源地址带过去
     * @param {string} page 页面文件名，如 m3u8.html
     * @param {string} url  要处理的媒体地址
     */
    async function openTool(page, url) {
        const target = chrome.runtime.getURL(page) + '?url=' + encodeURIComponent(url);

        // 新标签页开在当前标签右边，而不是一路堆到最右边，
        // 标签栏一长，用户回来时要满世界找
        let index;
        try {
            const tab = await chrome.tabs.get(currentTabId);
            if (tab && typeof tab.index === 'number') index = tab.index + 1;
        } catch (e) {
            // 拿不到就交给浏览器决定，不影响功能
        }

        chrome.tabs.create(index === undefined
            ? { url: target }
            : { url: target, index: index });

        window.close();
    }

    // ============================================================
    // 流媒体详情面板
    // ============================================================

    /**
     * 打开详情面板
     * @param {Object} item 资源
     * @param {'play'|'download'} [action] 打开后自动执行的动作
     */
    async function openDetail(item, action) {
        detailItem = item;
        detailParsed = null;
        detailLevels = [];
        selectedLevelUrl = '';
        detailHeaders = null;
        detailMpd = null;
        detailTrackIndex = -1;
        detailDashText = '';
        els.mergeHint.hidden = true;
        els.btnRetryFailed.hidden = true;

        // 列表与详情互斥；工具栏在详情下没有意义
        els.list.hidden = true;
        els.toolbar.hidden = true;
        els.detail.hidden = false;

        els.detailTitle.textContent = item.name || item.url;
        els.detailTitle.title = item.url;
        els.playerWrap.hidden = true;
        els.levels.hidden = true;
        els.levelList.textContent = '';
        els.progressWrap.hidden = true;
        els.progressFill.style.width = '0%';
        setInfo([{ label: '状态', value: '正在获取播放清单…' }]);

        // 目前只实现了 HLS。DASH 的清单结构（XML）与分片组织方式完全不同，
        // 与其让用户等半天看到一句"解析失败"，不如直接说清楚。
        const ext = String(item.ext || '').toLowerCase();

        // 继承嗅探时捕获的请求头，播放与下载都用得上
        detailHeaders = await lookupFetchHeaders(item.url);
        detailKeyCount = await lookupKeyCount();

        // DASH 走另一条路：先解析 MPD，把选中的轨道转写成 m3u8，
        // 之后就完全复用 HLS 那条链路
        if (ext === 'mpd') {
            els.btnStreamPlay.disabled = true;
            els.btnStreamPlay.title = 'DASH 暂不支持在弹窗内播放，可下载后用本地播放器打开';
            await openDashDetail(item, action);
            return;
        }

        els.btnStreamPlay.disabled = false;
        els.btnStreamPlay.title = '在弹窗内预览（支持带 AES-128 加密的流）';

        if (ext && ext !== 'm3u8' && ext !== 'm3u') {
            setInfo([{ label: '暂不支持', value: '仅支持 HLS（m3u8）与 DASH（mpd）清单', warn: true }]);
            return;
        }

        const parsed = await loadPlaylist(item.url, item.inlineText);
        if (!parsed) return;

        if (parsed.isMaster) {
            detailLevels = parsed.levels;
            if (detailLevels.length === 0) {
                setInfo([{ label: '状态', value: '主列表里没有可用画质', warn: true }]);
                return;
            }
            renderLevels();
            await selectLevel(detailLevels[0].url);
        } else {
            detailParsed = parsed;
            renderInfo(parsed);
        }

        if (action === 'play') handleStreamPlay();
        if (action === 'download') handleStreamDownload();
    }

    /** 返回列表视图 */
    function closeDetail() {
        destroyHls();
        detailItem = null;
        detailParsed = null;
        detailLevels = [];
        selectedLevelUrl = '';
        detailHeaders = null;
        detailMpd = null;
        detailTrackIndex = -1;
        detailDashText = '';
        els.mergeHint.hidden = true;
        // 下载任务本身继续跑，只是这个面板不再跟踪它
        activeTaskId = null;
        els.btnStreamDownload.textContent = '下载';

        els.detail.hidden = true;
        els.list.hidden = false;
        els.toolbar.hidden = false;
        render();
        setStatus('就绪');
    }

    /**
     * 取某个地址在嗅探时捕获的请求头
     * @param {string} url
     * @returns {Promise<Object|null>}
     */
    async function lookupFetchHeaders(url) {
        try {
            const res = await chrome.runtime.sendMessage({ type: 'tool:getItem', url: url });
            const headers = res && res.item && res.item.requestHeaders;
            if (!headers) return null;

            const out = {};
            for (const key of Object.keys(headers)) {
                const lower = key.toLowerCase();
                if (FORBIDDEN_HEADERS.indexOf(lower) !== -1) continue;
                if (lower.indexOf('sec-') === 0 || lower.indexOf('proxy-') === 0) continue;
                out[key] = headers[key];
            }
            return Object.keys(out).length > 0 ? out : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * 查询当前标签页捞到的密钥数量
     * @returns {Promise<number>}
     */
    async function lookupKeyCount() {
        try {
            const res = await chrome.runtime.sendMessage({
                type: 'popup:getKeys',
                tabId: currentTabId
            });
            return res && res.ok && Array.isArray(res.keys) ? res.keys.length : 0;
        } catch (e) {
            return 0;
        }
    }

    /**
     * 取清单原文
     * @param {string} url
     * @param {string} [inlineText] 嗅探时已抓到的原文（内联清单只能靠它）
     * @returns {Promise<string|null>}
     */
    async function fetchPlaylistText(url, inlineText) {
        if (inlineText) return inlineText;

        try {
            const res = await chrome.runtime.sendMessage({ type: 'tool:fetchText', url: url });
            if (!res || !res.ok) {
                setInfo([{ label: '获取失败', value: (res && res.error) || '未知错误', warn: true }]);
                return null;
            }
            return res.text;
        } catch (e) {
            setInfo([{ label: '获取失败', value: e.message || String(e), warn: true }]);
            return null;
        }
    }

    /**
     * 取播放清单文本并解析
     * @param {string} url
     * @param {string} [inlineText] 嗅探时已经拿到的清单原文。
     * @returns {Promise<Object|null>}
     */
    async function loadPlaylist(url, inlineText) {
        const text = await fetchPlaylistText(url, inlineText);
        if (!text) return null;

        const parsed = JTM3u8.parse(text, url);
        if (!parsed.ok) {
            setInfo([{ label: '解析失败', value: parsed.error || '未知错误', warn: true }]);
            return null;
        }
        return parsed;
    }

    // ============================================================
    // DASH（MPD）
    // ============================================================

    /**
     * 打开 DASH 详情
     * @param {Object} item
     * @param {'play'|'download'} [action]
     */
    async function openDashDetail(item, action) {
        setInfo([{ label: '状态', value: '正在获取 MPD 清单…' }]);

        const text = await fetchPlaylistText(item.url, item.inlineText);
        if (!text) return;

        const mpd = JTMpd.parse(text, item.url);
        if (!mpd.ok) {
            setInfo([{ label: '解析失败', value: mpd.error || '未知错误', warn: true }]);
            return;
        }

        detailMpd = mpd;

        if (mpd.hasDrm) {
            setInfo([{
                label: '受保护内容',
                value: mpd.drmSystems.join(' / ') + '，下载后无法解密',
                warn: true
            }]);
        }

        renderTracks(mpd);

        // 默认选第一条视频轨；没有视频轨就选第一条
        let initial = mpd.tracks.findIndex((t) => t.type === 'video');
        if (initial < 0) initial = 0;
        selectTrack(initial);

        if (action === 'download') handleStreamDownload();
    }

    /** 渲染 DASH 轨道列表 */
    function renderTracks(mpd) {
        els.levelList.textContent = '';
        els.levels.hidden = false;

        const title = els.levels.querySelector('.levels-title');
        if (title) title.textContent = '选择轨道';

        mpd.tracks.forEach((track, index) => {
            const btn = document.createElement('button');
            btn.className = 'level';
            btn.dataset.index = String(index);
            btn.addEventListener('click', () => selectTrack(index));

            const left = document.createElement('span');
            left.className = 'level-res';
            const prefix = track.type === 'video' ? '视频 '
                : track.type === 'audio' ? '音频 ' : '';
            left.textContent = prefix + JTMpd.trackLabel(track);

            const right = document.createElement('span');
            right.className = 'level-rate';
            right.textContent = track.bandwidth
                ? Math.round(track.bandwidth / 1000) + ' kbps'
                : '';

            btn.appendChild(left);
            btn.appendChild(right);
            els.levelList.appendChild(btn);
        });
    }

    /**
     * 选中一条 DASH 轨道
     * @param {number} index
     */
    function selectTrack(index) {
        if (!detailMpd || !detailMpd.tracks[index]) return;

        detailTrackIndex = index;
        const track = detailMpd.tracks[index];

        for (const btn of els.levelList.children) {
            btn.classList.toggle('is-active', Number(btn.dataset.index) === index);
        }

        detailDashText = JTMpd.toM3u8(track);

        // 转写后的地址都是绝对的，baseUrl 只用于回退
        const base = track.segments[0] ? track.segments[0].url : '';
        const parsed = JTM3u8.parse(detailDashText, base);

        if (!parsed.ok) {
            setInfo([{ label: '轨道解析失败', value: parsed.error || '未知错误', warn: true }]);
            return;
        }

        detailParsed = parsed;
        renderInfo(parsed);
    }

    /** 渲染码率档位列表 */
    function renderLevels() {
        els.levelList.textContent = '';
        els.levels.hidden = false;

        const title = els.levels.querySelector('.levels-title');
        if (title) title.textContent = '选择画质';

        for (const level of detailLevels) {
            const btn = document.createElement('button');
            btn.className = 'level';
            btn.dataset.url = level.url;
            btn.addEventListener('click', () => selectLevel(level.url));

            const res = document.createElement('span');
            res.className = 'level-res';
            res.textContent = level.resolution || level.name || '未知画质';

            const rate = document.createElement('span');
            rate.className = 'level-rate';
            rate.textContent = level.bandwidth
                ? Math.round(level.bandwidth / 1000) + ' kbps'
                : '';

            btn.appendChild(res);
            btn.appendChild(rate);
            els.levelList.appendChild(btn);
        }
    }

    /**
     * 选定一个码率，拉取对应的分片列表
     * @param {string} levelUrl
     */
    async function selectLevel(levelUrl) {
        selectedLevelUrl = levelUrl;

        for (const btn of els.levelList.children) {
            btn.classList.toggle('is-active', btn.dataset.url === levelUrl);
        }

        setInfo([{ label: '状态', value: '正在获取分片列表…' }]);
        const parsed = await loadPlaylist(levelUrl);
        if (parsed) {
            detailParsed = parsed;
            renderInfo(parsed);
        }
    }

    /**
     * 渲染清单概况
     * @param {Object} parsed
     */
    function renderInfo(parsed) {
        const output = JTM3u8.suggestOutput(parsed);

        const items = [
            { label: '分片', value: parsed.segments.length + ' 个' },
            { label: '时长', value: parsed.totalDuration ? JTUtils.secToTime(parsed.totalDuration) : '未知' },
            { label: '输出', value: output.ext.toUpperCase() }
        ];

        if (parsed.hasEncryption) {
            items.push({
                label: '加密',
                value: parsed.keyMethod || 'AES-128',
                warn: !!(parsed.keyMethod && parsed.keyMethod !== 'AES-128')
            });
        }
        // 没有 EXT-X-ENDLIST 说明是直播，下不了整段
        if (!parsed.isEndList) {
            items.push({ label: '类型', value: '直播流（无终点）', warn: true });
        }

        // 页面里捞到过密钥就说明白，密钥请求失败时它会顶上
        if (detailKeyCount > 0) {
            items.push({ label: '已捕获密钥', value: detailKeyCount + ' 个' });
        }

        // DASH 的 DRM 信息在 MPD 里，转写成 m3u8 之后就看不到了
        if (detailMpd && detailMpd.hasDrm) {
            items.push({
                label: 'DRM',
                value: detailMpd.drmSystems.join(' / '),
                warn: true
            });
        }

        setInfo(items);
    }

    /**
     * 渲染信息行
     * @param {Array<{label: string, value: string, warn?: boolean}>} items
     */
    function setInfo(items) {
        els.detailInfo.textContent = '';

        for (const it of items) {
            const wrap = document.createElement('span');
            wrap.className = 'info-item';

            const label = document.createElement('span');
            label.className = 'info-label';
            label.textContent = it.label;

            const value = document.createElement('span');
            if (it.warn) value.className = 'info-warn';
            value.textContent = it.value;
            value.title = it.value;

            wrap.appendChild(label);
            wrap.appendChild(value);
            els.detailInfo.appendChild(wrap);
        }
    }

    /**
     * 按需加载 hls.js
     * @returns {Promise<boolean>}
     */
    function loadHls() {
        if (typeof Hls !== 'undefined') return Promise.resolve(true);
        if (hlsLoading) return hlsLoading;

        hlsLoading = new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = 'lib/hls.min.js';
            script.onload = () => resolve(typeof Hls !== 'undefined');
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });
        return hlsLoading;
    }

    /** 销毁播放器 */
    function destroyHls() {
        if (hls) {
            try { hls.destroy(); } catch (e) { /* 忽略 */ }
            hls = null;
        }
        try {
            els.video.removeAttribute('src');
            els.video.load();
        } catch (e) { /* 忽略 */ }
    }

    /** 在弹窗内播放 */
    async function handleStreamPlay() {
        if (!detailItem) return;

        els.btnStreamPlay.disabled = true;
        setStatus('正在准备播放…');

        try {
            const ok = await loadHls();
            if (!ok) {
                setStatus('播放器加载失败，可改用「新标签页」', 'error');
                return;
            }

            // 主列表交给 hls.js 自适应选码率；已经选定了就播那一档
            const playUrl = detailLevels.length > 0
                ? detailItem.url
                : (selectedLevelUrl || detailItem.url);

            destroyHls();
            els.playerWrap.hidden = false;

            hls = new Hls({
                enableWorker: true,
                lowLatencyMode: false,
                maxBufferLength: 30,
                // 让清单与分片的请求带上捕获到的头，并携带 Cookie
                withCredentials: true,
                xhrSetup: detailHeaders
                    ? function (xhr) {
                        for (const key of Object.keys(detailHeaders)) {
                            try { xhr.setRequestHeader(key, detailHeaders[key]); }
                            catch (e) { /* 个别头不允许设置，跳过 */ }
                        }
                    }
                    : undefined
            });

            hls.loadSource(playUrl);
            hls.attachMedia(els.video);

            hls.on(Hls.Events.MANIFEST_PARSED, function () {
                setStatus('就绪，点播放键开始', 'ok');
                els.video.play().catch(() => {
                    // 自动播放被拦下，等用户手动点，不算错误
                });
            });

            hls.on(Hls.Events.ERROR, function (event, data) {
                if (!data || !data.fatal) return;

                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                    setStatus('网络错误，重试中…', 'error');
                    hls.startLoad();
                } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    setStatus('媒体错误，尝试恢复…', 'error');
                    hls.recoverMediaError();
                } else {
                    setStatus('播放失败：' + (data.details || '未知错误'), 'error');
                    destroyHls();
                }
            });
        } catch (e) {
            setStatus('播放失败：' + (e.message || e), 'error');
        } finally {
            els.btnStreamPlay.disabled = false;
        }
    }

    /** 下载流媒体；已有任务在跑时，这次点击是取消 */
    async function handleStreamDownload() {
        if (!detailItem) return;

        // 已在下载 → 取消
        if (activeTaskId) {
            const taskId = activeTaskId;
            activeTaskId = null;
            els.btnStreamDownload.textContent = '下载';
            els.progressWrap.hidden = true;
            setStatus('已取消下载');

            try {
                await chrome.runtime.sendMessage({ type: 'popup:abortStream', taskId: taskId });
            } catch (e) { /* 任务可能刚好结束了，忽略 */ }
            return;
        }

        // 另存为：下载前问一次文件名。
        if (config && config.saveAs) {
            const suggested = (detailItem.name || '') + (detailItem.ext ? '.' + detailItem.ext : '');
            const input = window.prompt('保存为（留空用默认名）', suggested);

            // 点了取消就别下了，用户是在反悔，不是要继续
            if (input === null) return;

            if (input.trim()) {
                // 去掉用户可能额外输入的扩展名，避免变成 xxx.mp4.mp4
                detailItem.name = input.trim().replace(/\.[a-z0-9]{1,6}$/i, '');
            }
        }

        els.btnStreamDownload.disabled = true;
        els.progressWrap.hidden = false;
        els.progressFill.style.width = '0%';
        els.progressText.textContent = '正在获取播放清单…';

        try {
            const res = await chrome.runtime.sendMessage({
                type: 'popup:downloadStream',
                url: detailItem.url,
                levelUrl: selectedLevelUrl || '',
                // 内联清单、以及 DASH 转写出的清单，文本要一起送过去，
                // 前者的地址取不到，后者的地址根本不是 m3u8
                inlineText: detailDashText || detailItem.inlineText || '',
                fileName: String(detailItem.name || 'video').replace(/\.(m3u8|m3u|mpd)$/i, '')
            });

            if (res && res.ok) {
                activeTaskId = res.taskId;
                els.btnStreamDownload.textContent = '取消';
                els.progressText.textContent = '准备中…';
                setStatus('下载已开始，可关闭弹窗', 'ok');
            } else {
                els.progressWrap.hidden = true;
                setStatus('下载失败：' + ((res && res.error) || '未知错误'), 'error');
            }
        } catch (e) {
            els.progressWrap.hidden = true;
            setStatus('下载失败：' + (e.message || e), 'error');
        } finally {
            els.btnStreamDownload.disabled = false;
        }
    }

    /** 复制当前流媒体的地址 */
    function handleStreamCopy() {
        if (detailItem) handleCopy(renderCopyText(detailItem), els.btnStreamCopy);
    }

    /** 各播放器的协议前缀 */
    const PLAYER_SCHEMES = {
        vlc: 'vlc://',
        potplayer: 'potplayer://',
        iina: 'iina://weblink?url=',
        mpv: 'mpv://'
    };

    /** 用外部播放器打开 */
    function handleExternalPlayer() {
        if (!detailItem) return;

        const player = config && config.externalPlayer;

        if (!player) {
            setStatus('未配置外部播放器，可到设置里选一个', 'error');
            return;
        }

        const prefix = PLAYER_SCHEMES[player];
        if (!prefix) {
            setStatus('未知的外部播放器：' + player, 'error');
            return;
        }

        try {
            const anchor = document.createElement('a');
            anchor.href = prefix + detailItem.url;
            anchor.style.display = 'none';

            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);

            setStatus('已尝试用 ' + player + ' 打开（没反应可能是没装这个播放器）');
        } catch (e) {
            setStatus('打开失败：' + (e.message || e), 'error');
        }
    }

    /** 在新标签页打开解析器 */
    function handleStreamTab() {
        if (detailItem) openTool('m3u8.html', detailItem.url);
    }

    /** 用 JSON 查看器打开 */
    function handleStreamJson() {
        if (detailItem) openTool('json.html', detailItem.url);
    }

    /** 下载进度 */
    function showStreamProgress(p) {
        if (!p) return;

        // 状态栏始终更新，这样即使用户退回了列表也知道还在下
        setStatus(`下载中 ${p.percent || 0}% · ${JTUtils.byteToSize(p.bytes || 0)}`);

        if (els.detail.hidden) return;
        els.progressWrap.hidden = false;
        els.progressFill.style.width = (p.percent || 0) + '%';
        els.progressText.textContent =
            `${p.completed}/${p.total} 分片 · ${JTUtils.byteToSize(p.bytes || 0)} · ` +
            `${JTUtils.byteToSize(p.speed || 0)}/s` +
            (p.failed > 0 ? ` · 失败 ${p.failed}` : '');
    }

    /** 下载完成 */
    function showStreamDone(p) {
        if (!p) return;
        // 不是当前面板正在等的那个任务就忽略，避免串台
        if (activeTaskId && p.taskId && p.taskId !== activeTaskId) return;

        activeTaskId = null;
        els.btnStreamDownload.textContent = '下载';
        setStatus('下载完成：' + (p.fileName || ''), 'ok');

        if (els.detail.hidden) return;
        els.progressFill.style.width = '100%';
        els.progressText.textContent =
            `完成 · ${p.fileName} · ${JTUtils.byteToSize(p.size || 0)}` +
            (p.failedCount > 0 ? ` · ${p.failedCount} 个分片失败` : '');

        // 有失败分片就给个重试入口，网络抖动导致的失败重跑一次往往就过了，
        // 不必从头再来
        els.btnRetryFailed.hidden = !(p.failedCount > 0);

        // 下载完就移出列表：长时间挂着一堆"已经下过了"的条目，
        if (config && config.downAutoClose && !(p.failedCount > 0)) {
            removeItemByUrl(p.url || (detailItem && detailItem.url));
        }
    }

    /** 开启 WebRTC 捕获 */
    async function handleWebrtc() {
        try {
            const res = await chrome.runtime.sendMessage({
                type: 'popup:inject',
                script: 'webrtc'
            });

            if (res && res.reloaded) {
                setStatus('正在刷新页面…WebRTC 捕获需要从页面加载起就 hook');
            } else if (res && res.ok) {
                setStatus('WebRTC 捕获已开启，建立通话后即可录制');
            } else {
                setStatus('开启失败：' + ((res && res.error) || '未知原因'), 'error');
            }
        } catch (e) {
            setStatus('开启失败：' + (e.message || e), 'error');
        }
    }

    /** 开启区域录制 */
    async function handleRegion() {
        try {
            const res = await chrome.runtime.sendMessage({
                type: 'popup:inject',
                script: 'region'
            });

            if (res && res.ok) {
                setStatus('已显示选择框：框好区域后点「开始录制」（需要授权屏幕共享）');
            } else {
                setStatus('开启失败：' + ((res && res.error) || '未知原因'), 'error');
            }
        } catch (e) {
            setStatus('开启失败：' + (e.message || e), 'error');
        }
    }

    /**
     * 按地址从列表中移除一条
     * @param {string} url
     */
    function removeItemByUrl(url) {
        if (!url) return;

        const before = items.length;
        items = items.filter(function (i) { return i.url !== url; });

        if (items.length !== before) {
            render();
            chrome.runtime.sendMessage({
                type: 'popup:removeItems',
                urls: [url]
            }).catch(function () {
                // 后台可能忙，列表已经刷过了，不影响观感
            });
        }
    }

    /** 重试失败的分片 */
    async function handleRetryFailed() {
        els.btnRetryFailed.disabled = true;
        setStatus('正在重试失败的分片…');

        try {
            const res = await chrome.runtime.sendMessage({ type: 'popup:retryStreamFailed' });

            if (res && res.ok) {
                els.btnRetryFailed.hidden = true;
                setStatus(
                    '重试完成' + (res.failedCount > 0 ? `，仍有 ${res.failedCount} 个失败` : ''),
                    'ok'
                );
            } else {
                setStatus('重试失败：' + ((res && res.error) || '未知错误'), 'error');
            }
        } catch (e) {
            setStatus('重试失败：' + (e.message || e), 'error');
        } finally {
            els.btnRetryFailed.disabled = false;
        }
    }

    /** 下载出错 */
    function showStreamError(p) {
        if (!p) return;
        if (activeTaskId && p.taskId && p.taskId !== activeTaskId) return;

        activeTaskId = null;
        els.btnStreamDownload.textContent = '下载';
        setStatus('下载失败：' + (p.error || '未知错误'), 'error');

        if (els.detail.hidden) return;
        els.progressWrap.hidden = true;
    }

    /** 触发深度搜索 */
    async function handleSearch() {        if (!currentTabId) return;
        setStatus('正在注入深度搜索…');

        try {
            const result = await chrome.runtime.sendMessage({
                type: 'popup:inject',
                tabId: currentTabId,
                script: 'deep-search'
            });

            if (result && result.ok) {
                els.btnSearch.classList.add('is-on');
                setStatus('深度搜索已启用，页面刷新中…', 'ok');
                // 刷新后弹窗会关闭，属于预期行为
            } else {
                setStatus('启用失败：' + ((result && result.error) || '未知错误'), 'error');
            }
        } catch (e) {
            setStatus('启用失败：' + e.message, 'error');
        }
    }

    /** 触发流媒体捕获 */
    async function handleCapture() {
        if (!currentTabId) return;

        if (captureActive) {
            // 已开启则停止。缓冲不清空，用户仍可导出
            await chrome.runtime.sendMessage({
                type: 'popup:stopCapture',
                tabId: currentTabId
            });
            captureActive = false;
            els.btnCapture.classList.remove('is-on');
            setStatus('捕获已停止，可继续导出已录内容');
            return;
        }

        setStatus('正在启用流媒体捕获…');
        try {
            const result = await chrome.runtime.sendMessage({
                type: 'popup:inject',
                tabId: currentTabId,
                script: 'mse-capture'
            });

            if (result && result.ok) {
                captureActive = true;
                els.btnCapture.classList.add('is-on');
                els.btnExport.hidden = false;
                setStatus('捕获已启用，播放视频即可录制', 'ok');
            } else {
                setStatus('启用失败：' + ((result && result.error) || '未知错误'), 'error');
            }
        } catch (e) {
            setStatus('启用失败：' + e.message, 'error');
        }
    }

    /** 导出捕获到的数据 */
    async function handleExport() {
        if (!currentTabId) return;

        els.btnExport.disabled = true;
        setStatus('正在合并捕获数据…');

        try {
            const result = await chrome.runtime.sendMessage({
                type: 'popup:exportCapture',
                tabId: currentTabId
            });

            if (result && result.ok) {
                setStatus('已开始导出，请留意下载列表', 'ok');
            } else {
                const error = (result && result.error) || '未知错误';
                setStatus('导出失败：' + error, 'error');
                // 脚本已失效，按钮不该继续摆在那里
                if (error.indexOf('失效') !== -1) {
                    captureActive = false;
                    els.btnCapture.classList.remove('is-on');
                    els.btnExport.hidden = true;
                }
            }
        } catch (e) {
            setStatus('导出失败：' + e.message, 'error');
        } finally {
            els.btnExport.disabled = false;
        }
    }

    /** 切换录制 */
    async function handleRecord() {
        if (!currentTabId) return;

        const stopping = recordingActive;
        els.btnRecord.disabled = true;
        setStatus(stopping ? '正在停止录制…' : '正在启动录制…');

        try {
            const res = await chrome.runtime.sendMessage({
                type: stopping ? 'popup:stopRecord' : 'popup:startRecord',
                tabId: currentTabId
            });

            // 真正的结果由页面异步回传（record:result），这里只处理送达失败
            if (!res || !res.ok) {
                setStatus('操作失败：' + ((res && res.error) || '未知错误'), 'error');
            }
        } catch (e) {
            setStatus('操作失败：' + (e.message || e), 'error');
        } finally {
            els.btnRecord.disabled = false;
        }
    }

    // ============================================================
    // 媒体控制
    // ============================================================

    /** 正在拖动进度条时暂停同步，否则拖到一半会被轮询覆盖 */
    /** 当前数据源：current（本页）/ all（其他标签页） */
    let scope = "current";

    /** 展开了完整地址的条目（存 url） */
    const expandedSet = new Set();

    /** 当前选中的扩展名筛选（空表示不筛） */
    /** 用户手动关掉了密钥提示条 */
    let keyBannerClosed = false;

    /** 用户手动关掉了 DRM 提示条 */
    let drmBannerClosed = false;

    let mediaSeeking = false;
    /** 最近一次拿到的媒体状态 */
    let mediaState = null;

    /** 当前要控制的媒体序号 */
    let mediaIndex = 0;

    /**
     * 渲染媒体选择下拉
     * @param {Object} state getState 返回的状态
     */
    function renderMediaPicker(state) {
        const list = state.items || [];

        if (list.length <= 1) {
            els.mediaIndex.hidden = true;
            return;
        }

        els.mediaIndex.hidden = false;

        // 只在选项数量变了时重建，每秒轮询一次，
        // 每次都重建会让下拉在用户操作时闪
        if (els.mediaIndex.options.length !== list.length) {
            els.mediaIndex.textContent = '';

            for (const info of list) {
                const opt = document.createElement('option');
                opt.value = String(info.index);

                // 没分辨率的（纯音频）标出来，其余带上尺寸便于辨认
                const label = info.width && info.height
                    ? info.width + '×' + info.height
                    : '音频';

                const seconds = info.duration ? Math.round(info.duration) : 0;
                opt.textContent = '#' + (info.index + 1) + ' ' + label +
                    (seconds ? ' · ' + JTUtils.secToTime(seconds) : '');

                els.mediaIndex.appendChild(opt);
            }
        }

        els.mediaIndex.value = String(mediaIndex);
    }
    /** 状态轮询定时器 */
    let mediaPollTimer = null;

    /** 启动状态轮询 */
    function startMediaPoll() {
        if (mediaPollTimer) return;
        mediaPollTimer = setInterval(refreshMediaState, 1000);
    }

    /** 停止轮询 */
    function stopMediaPoll() {
        if (mediaPollTimer) {
            clearInterval(mediaPollTimer);
            mediaPollTimer = null;
        }
    }

    /**
     * 发一条媒体控制指令
     * @param {string} command
     * @param {Object} [payload]
     */
    async function sendMedia(command, payload) {
        if (!currentTabId) return;

        // 每条指令都带上当前选中的媒体序号，
        // 页面有多个视频时，不带的话脚本只能猜「最大的那个」
        payload = Object.assign({ index: mediaIndex }, payload || {});

        try {
            await chrome.runtime.sendMessage({
                type: 'popup:mediaCommand',
                tabId: currentTabId,
                command: command,
                payload: payload
            });
        } catch (e) {
            // 页面可能已经关闭，忽略
        }
    }

    /**
     * 把页面回传的状态应用到界面
     * @param {Object} state
     */
    function applyMediaState(state) {
        if (!state || !state.ok) {
            els.mediaBar.hidden = true;
            stopMediaPoll();
            return;
        }

        els.mediaBar.hidden = false;
        mediaState = state;

        // 确认页面上确实有媒体，才开始轮询，
        // 没有媒体的页面没必要每秒打扰一次
        startMediaPoll();

        els.btnMediaToggle.textContent = state.paused ? '播放' : '暂停';
        els.btnMediaMuted.textContent = state.muted ? '开声音' : '静音';
        els.btnMediaLoop.classList.toggle('is-on', !!state.loop);

        // 用户正在拖动时不要抢方向盘
        if (!mediaSeeking) {
            const duration = state.duration || 0;
            els.mediaSeek.value = duration > 0
                ? String(Math.round((state.currentTime || 0) / duration * 1000))
                : '0';
            els.mediaTime.textContent =
                JTUtils.secToTime(state.currentTime || 0) + ' / ' + JTUtils.secToTime(duration);
        }

        els.mediaVolume.value = String(state.volume === undefined ? 1 : state.volume);
        // 倍速可能是用户自定义的（不在预设里），
        // 这时要补一个临时选项，否则下拉设不上去、显示成空白
        const rate = state.playbackRate || 1;
        const hasOpt = Array.prototype.some.call(
            els.mediaSpeed.options,
            (o) => parseFloat(o.value) === rate
        );

        if (!hasOpt) {
            const opt = document.createElement("option");
            opt.value = String(rate);
            opt.textContent = rate + "×";

            const custom = Array.prototype.find.call(
                els.mediaSpeed.options,
                (o) => o.value === "custom"
            );
            els.mediaSpeed.insertBefore(opt, custom || null);
        }

        els.mediaSpeed.value = String(rate);

        renderMediaPicker(state);
    }

    /** 查询一次当前状态 */
    function refreshMediaState() {
        sendMedia('getState');
    }

    /** 清空当前标签页列表 */
    async function handleClear() {        if (!currentTabId) return;
        await chrome.runtime.sendMessage({ type: 'popup:clear', tabId: currentTabId });
        items = [];
        render();
        setStatus('已清空');
    }


    /** 切换启用状态 */
    async function handleToggle() {
        const enabled = els.enableToggle.checked;
        config = await chrome.runtime.sendMessage({
            type: 'popup:setConfig',
            config: { enable: enabled }
        }).then((r) => r && r.config);

        setStatus(enabled ? '嗅探已启用' : '嗅探已停用');
    }

    /** 关闭 DRM 提示 */
    function handleDrmClose() {
        els.drmBanner.hidden = true;
        // 记下来，别再自动弹回去
        drmBannerClosed = true;
    }

    // ============================================================
    // 数据加载
    // ============================================================

    /** 模拟移动端 UA */
    async function handleMobileUA() {
        if (!currentTabId) {
            setStatus('没有可用的标签页', 'error');
            return;
        }

        // 常见做法：用一个通用的 Android Chrome UA
        const MOBILE_UA =
            'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

        try {
            const res = await chrome.runtime.sendMessage({
                type: 'popup:mobileUA',
                tabId: currentTabId,
                userAgent: MOBILE_UA
            });

            if (res && res.ok) {
                setStatus(res.applied ? '已切换为移动端 UA，正在刷新…' : '已取消移动端模拟');
            } else {
                setStatus('切换失败：' + ((res && res.error) || '未知原因'), 'error');
            }
        } catch (e) {
            setStatus('切换失败：' + ((e && e.message) || e), 'error');
        }
    }

    /**
     * 展开 / 折叠全部条目
     * @param {boolean} expanded
     */
    function setAllExpanded(expanded) {
        for (const item of items) {
            if (expanded) expandedSet.add(item.url);
            else expandedSet.delete(item.url);
        }
        render();
    }

    /** 去除文件名重复的条目 */
    async function handleDedupe() {
        if (items.length === 0) {
            setStatus('列表是空的');
            return;
        }

        const seen = new Set();
        const dupUrls = [];

        for (const item of items) {
            // 没有文件名的（分片、接口）不参与去重，它们本来就该各算各的
            const name = item.name || '';
            if (!name) continue;

            if (seen.has(name)) dupUrls.push(item.url);
            else seen.add(name);
        }

        if (dupUrls.length === 0) {
            setStatus('没有重名的条目');
            return;
        }

        try {
            await chrome.runtime.sendMessage({
                type: 'popup:removeItems',
                urls: dupUrls
            });

            const removed = new Set(dupUrls);
            items = items.filter((i) => !removed.has(i.url));
            render();
            setStatus('已移除 ' + dupUrls.length + ' 条重名');
        } catch (e) {
            setStatus('去重失败：' + ((e && e.message) || e), 'error');
        }
    }

    /** 切换数据源：当前页面 / 其他标签页 */
    async function handleScope(event) {
        const btn = event.target.closest('.scope-btn');
        if (!btn) return;

        const next = btn.dataset.scope;
        if (next === scope) return;

        scope = next;

        // 换了视图，之前的关闭决定不再适用
        drmBannerClosed = false;
        keyBannerClosed = false;

        for (const el of els.scope.querySelectorAll('.scope-btn')) {
            el.classList.toggle('is-active', el === btn);
        }

        await loadData();
    }

    /** 把选中项发送到本地服务 */
    async function handleBatchSend() {
        const picked = items.filter((i) => selectedSet.has(i.url));

        if (picked.length === 0) {
            setStatus('先选中要发送的条目', 'error');
            return;
        }

        if (!config || !config.send2localEnable || !config.send2localURL) {
            setStatus('还没配置本地服务地址，请到设置里填写', 'error');
            return;
        }

        try {
            const res = await chrome.runtime.sendMessage({
                type: 'popup:send2local',
                items: picked
            });

            if (res && res.ok) {
                setStatus('已发送 ' + picked.length + ' 条到本地服务');
            } else {
                setStatus('发送失败：' + ((res && res.error) || '未知原因'), 'error');
            }
        } catch (e) {
            setStatus('发送失败：' + ((e && e.message) || e), 'error');
        }
    }

    /** 合并下载选中的分片 */
    /**
     * 判断选中的两条是不是「同一个视频的音视频对」
     * @param {Array} picked
     * @returns {boolean}
     */
    function looksLikeTrackPair(picked) {
        if (picked.length !== 2) return false;

        const exts = picked.map((i) => String(i.ext || '').toLowerCase());
        if (!exts.every((e) => e === 'm4s' || e === 'mp4' || e === 'm4a' || e === 'm4v')) {
            return false;
        }

        // 去掉末尾的数字段（含扩展名），看前缀是否相同
        function stem(item) {
            const name = String(item.name || item.url || '');
            return name
                .replace(/\.[a-z0-9]+$/i, '')      // 去扩展名
                .replace(/[-_]\d+$/, '');         // 去末尾的数字段
        }

        const a = stem(picked[0]);
        const b = stem(picked[1]);

        if (!a || !b) return false;
        if (a !== b) return false;

        // 末尾数字必须不同，相同说明是同一个文件的重复条目
        const numA = String(picked[0].name || '').match(/(\d+)\.[a-z0-9]+$/i);
        const numB = String(picked[1].name || '').match(/(\d+)\.[a-z0-9]+$/i);

        if (numA && numB && numA[1] === numB[1]) return false;

        return true;
    }

    async function handleBatchMerge() {
        const picked = items.filter((i) => selectedSet.has(i.url));

        if (picked.length < 2) {
            setStatus('至少选两条才能合并', 'error');
            return;
        }

        // 音视频对走合并音轨，其余按分片合并
        const isTracks = looksLikeTrackPair(picked);

        try {
            if (isTracks) {
                setStatus('正在取音视频流…');

                const res = await chrome.runtime.sendMessage({
                    type: 'popup:mergeTracks',
                    items: picked
                });

                if (res && res.ok) {
                    setStatus('正在合并音视频，完成后会自动保存');
                } else {
                    setStatus('合并失败：' + ((res && res.error) || '未知原因'), 'error');
                }
                return;
            }

            const res = await chrome.runtime.sendMessage({
                type: 'popup:mergeSegments',
                items: picked,
                tabId: currentTabId
            });

            if (res && res.ok) {
                setStatus('已开始合并 ' + picked.length + ' 个分片');
            } else {
                setStatus('合并失败：' + ((res && res.error) || '未知原因'), 'error');
            }
        } catch (e) {
            setStatus('合并失败：' + ((e && e.message) || e), 'error');
        }
    }

    /** 刷新密钥候选 */
    async function refreshKeys() {
        if (!currentTabId) return;

        try {
            const res = await chrome.runtime.sendMessage({
                type: 'popup:getKeys',
                tabId: currentTabId
            });

            const keys = (res && res.keys) || [];

            // 用户关过就不再打扰，每轮刷新都弹回来很烦
            if (keys.length === 0 || keyBannerClosed) {
                els.keyBanner.hidden = true;
                return;
            }

            els.keyBanner.hidden = false;
            els.keyCount.textContent = String(keys.length);
            els.keyList.textContent = '';

            for (const k of keys) {
                const row = document.createElement('div');
                row.className = 'key-row';

                const hex = document.createElement('code');
                hex.className = 'key-value';
                hex.textContent = k.hex;
                hex.title = '点一下复制（十六进制）';

                // 复制 hex 还是 base64？不同工具要的不一样，给两个按钮
                const copyHex = document.createElement('button');
                copyHex.className = 'act';
                copyHex.textContent = '复制';
                copyHex.addEventListener('click', () => {
                    handleCopy(k.hex, copyHex);
                });

                const copyB64 = document.createElement('button');
                copyB64.className = 'act';
                copyB64.textContent = 'base64';
                copyB64.title = '有些工具要 base64 格式的密钥';
                copyB64.addEventListener('click', () => {
                    handleCopy(k.base64, copyB64);
                });

                row.append(hex, copyHex, copyB64);
                els.keyList.appendChild(row);
            }
        } catch (e) {
            // 拿不到密钥不影响主流程
            els.keyBanner.hidden = true;
        }
    }

    /** 从后台加载数据并渲染 */
    async function loadData() {
        try {
            // 数据源：只看本页，还是把所有标签页汇总起来
            if (scope === 'all') {
                const response = await chrome.runtime.sendMessage({ type: 'popup:listAll' });

                if (response && response.ok) {
                    // 后台按标签页分组返回，这里摊平，
                    // 用户看的是一个列表，不是一叠分组
                    const flat = [];
                    for (const tab of response.tabs || []) {
                        for (const it of tab.items || []) {
                            flat.push(Object.assign({}, it, {
                                pageTitle: tab.pageTitle,
                                pageUrl: tab.pageUrl
                            }));
                        }
                    }
                    items = flat;
                    render();
                    updateDrmBanner();
                }

                // 其他页面的媒体没法用这条控制条操作（脚本在别的标签页里），
                // 所以切到「其他页面」时把它收起来
                els.mediaBar.hidden = true;
                stopMediaPoll();
                return;
            }

            const response = await chrome.runtime.sendMessage({
                type: 'popup:getData',
                tabId: currentTabId
            });

            if (response && response.ok) {
                items = response.items || [];
                render();
                updateDrmBanner();

                // 弹窗每次打开都是新实例，捕获状态要从后台恢复，
                // 否则重新打开弹窗后「导出」按钮就找不到了
                captureActive = response.capturing === true;
                els.btnCapture.classList.toggle('is-on', captureActive);
                // 停止录制后缓冲仍在，仍可导出
                els.btnExport.hidden = response.canExport !== true;
            }
        } catch (e) {
            setStatus('加载失败：' + e.message, 'error');
        }

        refreshKeys();

        // 同时检查页面上有没有可控制的媒体。
        // 有的话控制条会自动出现，并开始轮询状态。
        refreshMediaState();
    }


    /** 根据数据决定是否显示 DRM 提示条 */
    function updateDrmBanner() {
        const drm = items.filter((item) => item.type === 'drm')[0];

        // 用户关过就不再打扰
        if (!drm || drmBannerClosed) {
            els.drmBanner.hidden = true;
            return;
        }

        els.drmBanner.hidden = false;

        // 带上系统名（Widevine / PlayReady / FairPlay）。
        // 用户拿这个名字去搜方案，比搜"DRM"精确得多。
        els.drmSystem.textContent = drm.drmSystem && drm.drmSystem !== '未知'
            ? '（' + drm.drmSystem + '）'
            : '';
    }

    // ============================================================
    // 实时更新
    // ============================================================

    chrome.runtime.onMessage.addListener(function (message) {
        if (!message || !message.type) return;

        if (message.type === 'media:add') {
            const payload = message.payload;
            if (!payload || payload.tabId !== currentTabId) return;

            // 去重后追加
            const exists = items.some((i) => i.url === payload.url);
            if (!exists) {
                items.push(payload);
                render();
                updateDrmBanner();
            }
            return;
        }

        if (message.type === 'capture:progress') {
            showCaptureProgress(message.payload);
            return;
        }

        if (message.type === 'stream:progress') {
            showStreamProgress(message.payload);
            return;
        }

        if (message.type === 'stream:done') {
            showStreamDone(message.payload);
            return;
        }

        if (message.type === 'stream:error') {
            showStreamError(message.payload);
            return;
        }

        if (message.type === 'download:failed') {
            const p = message.payload || {};
            // 说明失败原因，光一句"下载失败"用户没法判断该做什么
            setStatus('下载失败：' + (p.hint || p.reason || '未知原因'), 'error');
            return;
        }

        // ---------- 录制 ----------

        if (message.type === 'record:result') {
            const p = message.payload || {};

            if (p.action === 'stop') {
                recordingActive = false;
                els.btnRecord.classList.remove('is-on');
                setStatus(p.ok ? '录制已停止，正在导出…' : '停止失败：' + (p.error || '未知错误'),
                    p.ok ? 'ok' : 'error');
                return;
            }

            if (p.ok) {
                recordingActive = true;
                els.btnRecord.classList.add('is-on');
                const res = (p.width && p.height) ? ` · ${p.width}×${p.height}` : '';
                setStatus('录制中，请保持页面播放' + res, 'ok');
            } else {
                recordingActive = false;
                els.btnRecord.classList.remove('is-on');
                setStatus('录制失败：' + (p.error || '未知错误'), 'error');
            }
            return;
        }

        if (message.type === 'record:progress') {
            const p = message.payload || {};
            if (!p.recording) return;
            // 弹窗重开时靠这条消息恢复按钮状态
            recordingActive = true;
            els.btnRecord.classList.add('is-on');
            setStatus(
                `录制中 ${JTUtils.secToTime(p.duration || 0)} · ${JTUtils.byteToSize(p.bytes || 0)}`
            );
            return;
        }

        if (message.type === 'record:done') {
            const p = message.payload || {};
            if (p.empty) {
                setStatus('录制结束，没有录到数据', 'error');
            } else {
                setStatus(
                    `已导出第 ${p.part} 段 · ${JTUtils.byteToSize(p.size || 0)} · ` +
                    `时长 ${JTUtils.secToTime(p.duration || 0)}`,
                    'ok'
                );
            }
            return;
        }

        if (message.type === 'record:error') {
            const p = message.payload || {};
            setStatus('录制出错：' + (p.error || '未知错误'), 'error');
            return;
        }

        if (message.type === 'capture:warning') {            const p = message.payload || {};
            // 这类问题现在说比下载完再说有用得多，
            // 等文件下下来才发现打不开，用户白等一场
            setStatus(p.message || '捕获遇到问题', 'error');
            return;
        }

        if (message.type === 'capture:merged') {
            const p = message.payload || {};

            if (p.ok) {
                setStatus(
                    '已合并音视频：' + (p.fileName || 'merged.mp4') +
                    ' · ' + JTUtils.byteToSize(p.size || 0),
                    'ok'
                );
            } else {
                // 合并失败了也不能让用户两手空空，
                // 告诉他可以关掉这个开关拿两个单轨文件
                setStatus(
                    '合并失败：' + (p.error || '未知原因') +
                    '。可在设置里关掉「捕获后自动合并」，会分别导出音视频两个文件。',
                    'error'
                );
            }
            return;
        }

        // ---------- WebRTC 录制的回传 ----------
        //
        // 录制是在页面里进行的，用户很可能已经切走弹窗。
        // 后台把结果推过来，这里负责让他回来时能看到。
        if (message.type === 'webrtc:done') {
            const p = message.payload || {};

            setStatus(
                'WebRTC 录制完成：' + (p.fileName || 'webm') +
                (p.size ? ' · ' + JTUtils.byteToSize(p.size) : ''),
                'ok'
            );
            return;
        }

        if (message.type === 'webrtc:state') {
            const p = message.payload || {};

            if (p.recording) {
                setStatus('WebRTC 录制中…');
            } else if (p.error) {
                setStatus('WebRTC：' + p.error, 'error');
            }
            return;
        }

        // ---------- 捕获到新密钥 ----------
        //
        // 密钥是边播边捞的，捕获到的时候用户可能正开着弹窗。
        // 刷新一下提示条，免得他以为没抓到。
        if (message.type === 'media:key') {
            const p = message.payload || {};
            if (p.tabId === currentTabId) refreshKeys();
            return;
        }

        // ---------- 媒体控制 ----------

        if (message.type === 'media:state') {
            const p = message.payload || {};

            // 截图结果要给个反馈，否则用户不知道点没点上
            if (p.command === 'screenshot') {
                setStatus(p.ok ? '已保存截图' : ('截图失败：' + (p.error || '未知原因')),
                    p.ok ? 'ok' : 'error');
            }

            applyMediaState(p);
        }
    });

    /**
     * 在状态栏显示捕获进度
     * @param {Object} payload
     */
    function showCaptureProgress(payload) {
        if (!payload) return;

        if (payload.part !== undefined) {
            // 缺容器头是最要命的情况：文件能下下来，但双击打不开。
            // 必须说清楚，并且给出可操作的建议。
            if (payload.missingHeader > 0) {
                setStatus(
                    '已导出，但缺少视频头信息，文件可能无法直接播放。' +
                    '请在页面里从头播放一遍后重新捕获。',
                    'error'
                );
                return;
            }

            const parts = ['已导出第 ' + payload.part + ' 段'];
            parts.push(JTUtils.byteToSize(payload.size || 0));

            if (payload.removedChunks > 0) {
                parts.push('已清理 ' + payload.removedChunks + ' 块重复头部');
            }

            // 说明文件是不是完整可播的，用户最关心的就是这个
            const allPlayable = Array.isArray(payload.tracks) &&
                payload.tracks.every((t) => t.playable !== false);

            if (allPlayable) {
                parts.push('文件完整，可直接播放');
            }

            setStatus(parts.join(' · '), 'ok');

            if (payload.needsMerge) {
                showMergeHint(payload.tracks);
            }
            return;
        }

        if (typeof payload.totalSize !== 'number') return;

        const used = JTUtils.byteToSize(payload.totalSize);
        const limit = payload.limit ? ' / ' + JTUtils.byteToSize(payload.limit) : '';
        const chunks = payload.chunks ? ` · ${payload.chunks} 块` : '';
        setStatus(`捕获中 ${used}${limit}${chunks}`);
    }

    /**
     * 显示音视频合并指引
     * @param {Array<{fileName: string, type: string}>} tracks
     */
    function showMergeHint(tracks) {
        if (!Array.isArray(tracks)) return;

        const video = tracks.find((t) => t.type === 'video');
        const audio = tracks.find((t) => t.type === 'audio');
        if (!video || !audio) return;

        els.mergeCmd.textContent =
            'ffmpeg -i "' + video.fileName + '" -i "' + audio.fileName + '" -c copy merged.mp4';
        els.mergeHint.hidden = false;
    }

    // ============================================================
    // 初始化
    // ============================================================

    async function init() {
        JTUtils.setTitle();

        // 绑定事件
        els.btnSearch.addEventListener('click', handleSearch);
        els.btnCapture.addEventListener('click', handleCapture);
        els.btnRecord.addEventListener('click', handleRecord);
        els.btnWebrtc.addEventListener('click', handleWebrtc);
        els.btnRegion.addEventListener('click', handleRegion);

        // ---------- 筛选与批量 ----------
        // 边输边筛，不等回车，列表不大，实时反馈更直接
        els.filterRegex.addEventListener('input', () => {
            filterRegexText = els.filterRegex.value.trim();
            // 换了筛选条件就回到第一批，否则可能一上来就渲染几千条
            renderLimit = RENDER_PAGE_SIZE;
            render();
        });

        els.btnSelectAll.addEventListener('click', () => batchSelect('all'));
        els.btnSelectReverse.addEventListener('click', () => batchSelect('reverse'));
        els.btnBatchClear.addEventListener('click', () => batchSelect('none'));
        els.btnBatchDownload.addEventListener('click', batchDownload);

        // ---------- 媒体控制 ----------
        els.btnMediaToggle.addEventListener('click', () => sendMedia('toggle'));

        // 切换控制的媒体
        els.mediaIndex.addEventListener('change', () => {
            mediaIndex = parseInt(els.mediaIndex.value, 10) || 0;
            sendMedia('getState');
        });

        els.mediaSpeed.addEventListener('change', () => {
            const val = els.mediaSpeed.value;
            const current = (mediaState && mediaState.playbackRate) || 1;

            // 自定义：预设里没有的倍速（1.8×、4× 这类）
            if (val === 'custom') {
                const input = prompt('输入播放倍速（0.1 – 16）', String(current));

                // 取消或填了非法值就拨回原值，
                // 别让下拉停在"自定义…"上，那看着像设成功了
                if (input === null) {
                    els.mediaSpeed.value = String(current);
                    return;
                }

                const rate = parseFloat(input);
                if (!isFinite(rate) || rate < 0.1 || rate > 16) {
                    setStatus('倍速要在 0.1 到 16 之间', 'error');
                    els.mediaSpeed.value = String(current);
                    return;
                }

                sendMedia('speed', { value: rate });
                return;
            }

            sendMedia('speed', { value: parseFloat(val) });
        });

        els.mediaVolume.addEventListener('input', () => {
            sendMedia('volume', { value: parseFloat(els.mediaVolume.value) });
        });

        els.btnMediaMuted.addEventListener('click', () => {
            sendMedia('muted', { value: els.btnMediaMuted.textContent === '静音' });
        });

        els.btnMediaLoop.addEventListener('click', () => {
            // 状态以页面为准，别用本地变量记，页面自己也可能改 loop
            const next = !(mediaState && mediaState.loop);
            sendMedia('loop', { value: next });
        });

        els.btnMediaPip.addEventListener('click', () => sendMedia('pip'));
        els.btnMediaFull.addEventListener('click', () => sendMedia('fullscreen'));
        els.btnMediaShot.addEventListener('click', () => {
            sendMedia('screenshot');
            setStatus('正在截图…');
        });

        // 拖动进度条：按下时停止同步，松开才真正跳转，
        // 否则每移动一像素都发一次 seek，页面会卡
        els.mediaSeek.addEventListener('input', () => {
            mediaSeeking = true;
        });

        els.mediaSeek.addEventListener('change', () => {
            mediaSeeking = false;
            const duration = (mediaState && mediaState.duration) || 0;
            const ratio = parseInt(els.mediaSeek.value, 10) / 1000;
            sendMedia('seek', { value: ratio * duration });
        });
        els.btnExport.addEventListener('click', handleExport);
        els.btnClear.addEventListener('click', handleClear);
        els.enableToggle.addEventListener('change', handleToggle);

        // 详情面板
        els.btnBack.addEventListener('click', closeDetail);
        els.btnStreamPlay.addEventListener('click', handleStreamPlay);
        els.btnStreamDownload.addEventListener('click', handleStreamDownload);
        els.btnStreamCopy.addEventListener('click', handleStreamCopy);

        // 二维码：把地址画成码，手机扫一下就能打开。
        // 比复制地址再发到手机上省事，尤其是地址很长的时候。
        els.btnQrcode.addEventListener('click', function () {
            if (detailItem) showQrcode(detailItem.url);
        });

        // 点浮层任意处关闭
        els.qrMask.addEventListener('click', function () {
            els.qrMask.hidden = true;
        });

        // 命令行模板：把地址、Referer 一起拼成可粘贴的完整命令。
        // 有自己下载工具链的用户，粘一条命令比手拼参数省事得多。
        els.btnCopyM3u8dl.addEventListener('click', function () {
            if (!detailItem) return;
            handleCopy(renderCommand('m3u8dlArg', 'N_m3u8DL-RE', detailItem),
                els.btnCopyM3u8dl);
        });

        els.btnCopyFfmpeg.addEventListener('click', function () {
            if (!detailItem) return;
            handleCopy(renderCommand('ffmpegArg', 'ffmpeg', detailItem),
                els.btnCopyFfmpeg);
        });
        els.btnStreamTab.addEventListener('click', handleStreamTab);
        els.btnStreamJson.addEventListener('click', handleStreamJson);
        els.btnStreamExternal.addEventListener('click', handleExternalPlayer);
        els.btnCopyMerge.addEventListener('click', () => {
            handleCopy(els.mergeCmd.textContent, els.btnCopyMerge);
        });
        els.btnRetryFailed.addEventListener('click', handleRetryFailed);
        // 关窗时释放播放器，别把解码资源留着
        window.addEventListener('beforeunload', destroyHls);
        els.drmClose.addEventListener('click', handleDrmClose);

        // 关掉就不再自动弹，用户明确表示不想看
        els.keyClose.addEventListener('click', () => {
            els.keyBanner.hidden = true;
            keyBannerClosed = true;
        });

        els.btnOptions.addEventListener('click', () => {
            chrome.runtime.openOptionsPage();
        });

        els.btnGuide.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('install.html') });
        });

        // ---------- 独立窗口 ----------
        // 弹窗太小、又不想为它开一个标签页时的折中
        els.btnPopup.addEventListener('click', () => {
            chrome.windows.create({
                url: chrome.runtime.getURL('popup.html'),
                type: 'popup',
                width: 420,
                height: 620
            });
            window.close();
        });

        // ---------- 模拟移动端 ----------
        els.btnMobile.addEventListener('click', handleMobileUA);

        // 「⋯」面板：只切换高亮状态，不改按钮文字，
        // 改了的话那个省略号图标就被文字顶掉了
        els.btnMore.addEventListener('click', () => {
            const open = els.morePanel.hidden;
            els.morePanel.hidden = !open;
            els.btnMore.classList.toggle('is-on', open);
        });

        // ---------- 列表工具条 ----------
        els.btnExpandAll.addEventListener('click', () => setAllExpanded(true));
        els.btnCollapseAll.addEventListener('click', () => setAllExpanded(false));
        els.btnDedupe.addEventListener('click', handleDedupe);

        // ---------- 数据源切换 ----------
        els.scope.addEventListener('click', handleScope);

        // ---------- 批量：发送到本地 / 合并下载 ----------
        els.btnBatchSend.addEventListener('click', handleBatchSend);
        els.btnBatchMerge.addEventListener('click', handleBatchMerge);

        els.btnM3u8.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('m3u8.html') });
        });

        // 这两个页面本来就有，只是弹窗里一直没有入口，只能靠手输地址访问
        els.btnDownloader.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html') });
        });

        els.btnManage.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
        });

        // 取当前标签页
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs[0]) {
                currentTabId = tabs[0].id;
            }
        } catch (e) {
            setStatus('无法获取当前标签页', 'error');
            return;
        }

        // 读取配置
        try {
            const response = await chrome.runtime.sendMessage({ type: 'popup:getConfig' });
            if (response && response.ok && response.config) {
                config = response.config;
                // 加守卫：万一 config 拿到的不是对象，这里会抛错，
                // 而它后面就是 loadData()，一抛就无法继续初始化
                els.enableToggle.checked = config.enable !== false;
            }
        } catch (e) {
            // 配置读取失败不阻塞主流程
        }

        await loadData();
        setStatus('就绪');
    }

    /** 初始化失败时的回退处理 */
    function showInitError(e) {
        console.error('[鲸吞] 弹窗初始化失败:', e);

        try {
            setStatus('初始化失败：' + ((e && e.message) || e), 'error');
        } catch (err) {
            // 连 setStatus 都用不了，往下走直接改 DOM
        }

        // 列表区也放一条，否则空白区域看着像"这个页面没有资源"
        try {
            const list = document.getElementById('list');
            if (list && list.children.length === 0) {
                list.textContent = '初始化失败，请按 F12 查看控制台报错';
                list.style.cssText =
                    'padding:24px;text-align:center;color:#c0392b;font-size:12px';
            }
        } catch (err) {
            // 回退处理再失败时只能报错
        }
    }

    // 脚本位于 body 末尾，DOMContentLoaded 可能已触发，需按 readyState 判断
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            init().catch(showInitError);
        });
    } else {
        init().catch(showInitError);
    }
})();
