/** 鲸吞：资源管理页 */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    const els = {
        summary: $('summary'),
        list: $('list'),
        empty: $('empty'),
        searchInput: $('searchInput'),
        sortSelect: $('sortSelect'),
        reverseOrder: $('reverseOrder'),
        typeFilters: $('typeFilters'),
        btnRefresh: $('btnRefresh'),
        btnSelectAll: $('btnSelectAll'),
        btnInvert: $('btnInvert'),
        btnCopy: $('btnCopy'),
        btnDownload: $('btnDownload'),
        btnDelete: $('btnDelete'),
        status: $('status'),
        selectedCount: $('selectedCount'),
        hoverPreview: $('hoverPreview'),
        hoverImg: $('hoverImg'),
        hoverVideo: $('hoverVideo')
    };

    /** 原始数据：按标签页分组 */
    let tabs = [];
    /** 当前筛选类型 */
    let activeType = 'all';
    /** 选中的资源（按 url 去重） */
    let selected = new Set();
    /** 加载自后台的配置 */
    let config = {};

    // ============================================================
    // 数据
    // ============================================================

    async function load() {
        setStatus('正在加载…');

        try {
            const [listRes, cfgRes] = await Promise.all([
                chrome.runtime.sendMessage({ type: 'popup:listAll' }),
                chrome.runtime.sendMessage({ type: 'popup:getConfig' })
            ]);

            tabs = (listRes && listRes.tabs) || [];
            config = (cfgRes && cfgRes.config) || cfgRes || {};

            // 已关闭的标签页里，资源已经下不了了，清掉它们的选中状态
            const aliveUrls = new Set();
            for (const tab of tabs) {
                for (const item of tab.items) aliveUrls.add(item.url);
            }
            for (const url of Array.from(selected)) {
                if (!aliveUrls.has(url)) selected.delete(url);
            }

            render();
            setStatus('已加载 ' + countAll() + ' 条资源');
        } catch (e) {
            setStatus('加载失败：' + (e.message || e), true);
        }
    }

    function countAll() {
        let n = 0;
        for (const tab of tabs) n += tab.items.length;
        return n;
    }

    // ============================================================
    // 筛选与排序
    // ============================================================

    /** 归入弹窗里的分类，与 classify 保持一致 */
    function classify(item) {
        if (item.type === 'drm') return 'other';

        const ext = (item.ext || '').toLowerCase();
        if (ext === 'm3u8' || ext === 'm3u' || ext === 'mpd') return 'stream';
        if (ext === 'mp4' || ext === 'webm' || ext === 'mkv' || ext === 'flv' ||
            ext === 'mov' || ext === 'm4v' || ext === 'ts') return 'video';
        if (ext === 'mp3' || ext === 'm4a' || ext === 'aac' || ext === 'flac' ||
            ext === 'wav' || ext === 'ogg') return 'audio';
        return 'other';
    }

    /**
     * 当前可见的资源（已筛选、已排序）
     * @returns {Array<{tab: Object, item: Object}>}
     */
    function visibleEntries() {
        const keyword = els.searchInput.value.trim();
        let regex = null;

        if (keyword) {
            try {
                regex = new RegExp(keyword, 'i');
            } catch (e) {
                // 用户正在输入一个还不完整的正则，先不做过滤
                regex = null;
            }
        }

        const entries = [];

        for (const tab of tabs) {
            for (const item of tab.items) {
                if (activeType !== 'all' && classify(item) !== activeType) continue;

                if (regex) {
                    const hay = (item.name || '') + ' ' + (item.url || '');
                    if (!regex.test(hay)) continue;
                } else if (keyword) {
                    // 正则没写成，退回普通子串匹配
                    const hay = ((item.name || '') + ' ' + (item.url || '')).toLowerCase();
                    if (hay.indexOf(keyword.toLowerCase()) === -1) continue;
                }

                entries.push({ tab: tab, item: item });
            }
        }

        const sortBy = els.sortSelect.value;

        entries.sort(function (a, b) {
            switch (sortBy) {
                case 'name':
                    return String(a.item.name || '').localeCompare(String(b.item.name || ''));
                case 'size':
                    return (b.item.size || 0) - (a.item.size || 0);
                default:
                    return (b.item.time || 0) - (a.item.time || 0);
            }
        });

        if (els.reverseOrder.checked) entries.reverse();

        return entries;
    }

    // ============================================================
    // 渲染
    // ============================================================

    function render() {
        const entries = visibleEntries();

        els.list.textContent = '';
        els.empty.hidden = entries.length > 0;

        // 按标签页分组展示，用户需要知道资源来自哪个页面
        const byTab = new Map();

        for (const entry of entries) {
            if (!byTab.has(entry.tab.tabId)) byTab.set(entry.tab.tabId, []);
            byTab.get(entry.tab.tabId).push(entry);
        }

        for (const [tabId, list] of byTab) {
            const tab = list[0].tab;

            const group = document.createElement('section');
            group.className = 'group';

            const head = document.createElement('div');
            head.className = 'group-head';

            if (tab.favIconUrl) {
                const ico = document.createElement('img');
                ico.className = 'group-ico';
                ico.src = tab.favIconUrl;
                ico.alt = '';
                ico.addEventListener('error', function () { ico.hidden = true; });
                head.appendChild(ico);
            }

            const title = document.createElement('span');
            title.className = 'group-title';
            title.textContent = tab.pageTitle || tab.pageUrl || ('标签页 ' + tabId);
            title.title = tab.pageUrl || '';
            head.appendChild(title);

            const count = document.createElement('span');
            count.className = 'group-count';
            count.textContent = list.length + ' 条';
            head.appendChild(count);

            group.appendChild(head);

            for (const entry of list) {
                group.appendChild(buildRow(entry.item));
            }

            els.list.appendChild(group);
        }

        els.summary.textContent = tabs.length + ' 个页面 · ' + countAll() + ' 条资源';
        updateSelectionUI();
    }

    function buildRow(item) {
        const row = document.createElement('div');
        row.className = 'row-item type-' + classify(item);

        // --- 勾选 ---
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'row-check';
        check.checked = selected.has(item.url);
        check.addEventListener('change', function () {
            if (check.checked) selected.add(item.url);
            else selected.delete(item.url);
            updateSelectionUI();
        });
        row.appendChild(check);

        // --- 类型徽章 ---
        const badge = document.createElement('span');
        badge.className = 'badge';
        const names = { video: '视频', audio: '音频', stream: '流媒体', other: '其他' };
        badge.textContent = names[classify(item)] || '其他';
        row.appendChild(badge);

        // --- 名称 ---
        const name = document.createElement('span');
        name.className = 'row-name';
        name.textContent = item.name || JTUtils.parseFileName(item.url) || '(无名)';
        name.title = item.name || '';
        row.appendChild(name);

        // --- 大小 ---
        const size = document.createElement('span');
        size.className = 'row-size';
        size.textContent = item.size ? JTUtils.byteToSize(item.size) : '—';
        row.appendChild(size);

        // --- 时间 ---
        const time = document.createElement('span');
        time.className = 'row-time';
        time.textContent = item.time ? formatTime(item.time) : '';
        row.appendChild(time);

        // --- 地址（可点开，也便于肉眼核对）---
        const url = document.createElement('span');
        url.className = 'row-url';
        url.textContent = item.url;
        url.title = item.url;
        row.appendChild(url);

        // --- 操作 ---
        const actions = document.createElement('span');
        actions.className = 'row-actions';

        actions.appendChild(miniButton('下载', function () {
            downloadItem(item);
        }));

        actions.appendChild(miniButton('复制', function () {
            copyText(item.url);
        }));

        actions.appendChild(miniButton('打开', function () {
            chrome.tabs.create({ url: chrome.runtime.getURL('preview.html') + '?url=' + encodeURIComponent(item.url) });
        }));

        row.appendChild(actions);

        // --- 悬停预览 ---
        bindHoverPreview(row, item);

        return row;
    }

    function miniButton(text, onClick) {
        const btn = document.createElement('button');
        btn.className = 'mini';
        btn.textContent = text;
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    function formatTime(ts) {
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    // ============================================================
    // 悬停预览
    //
    // 光看文件名分不清哪个是哪个，悬停一下直接看内容，
    // 比一个个点开快得多。
    // ============================================================

    let hoverTimer = null;

    function bindHoverPreview(row, item) {
        const ext = (item.ext || '').toLowerCase();

        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].indexOf(ext) !== -1;
        const isVideo = ['mp4', 'webm', 'ogg', 'mov', 'm4v'].indexOf(ext) !== -1;

        if (!isImage && !isVideo) return;

        row.addEventListener('mouseenter', function () {
            hoverTimer = setTimeout(function () { showPreview(item, isImage); }, 400);
        });

        row.addEventListener('mouseleave', function () {
            clearTimeout(hoverTimer);
            hidePreview();
        });
    }

    function showPreview(item, isImage) {
        const box = els.hoverPreview;
        box.hidden = false;

        // 跟着鼠标放到右下角，别挡住列表
        box.style.right = '24px';
        box.style.bottom = '60px';

        if (isImage) {
            els.hoverImg.hidden = false;
            els.hoverVideo.hidden = true;
            els.hoverVideo.pause();
            els.hoverImg.src = item.url;
        } else {
            els.hoverImg.hidden = true;
            els.hoverVideo.hidden = false;
            els.hoverVideo.src = item.url;
            els.hoverVideo.play().catch(function () {
                // 自动播放可能被浏览器拦，用户手动点一下即可
            });
        }
    }

    function hidePreview() {
        els.hoverPreview.hidden = true;
        els.hoverImg.removeAttribute('src');
        els.hoverVideo.pause();
        els.hoverVideo.removeAttribute('src');
    }

    // ============================================================
    // 选择
    // ============================================================

    function updateSelectionUI() {
        const n = selected.size;

        els.selectedCount.textContent = n > 0 ? ('已选 ' + n + ' 项') : '';
        els.btnCopy.disabled = n === 0;
        els.btnDownload.disabled = n === 0;
        els.btnDelete.disabled = n === 0;

        // 同步所有行的勾选框
        const boxes = els.list.querySelectorAll('.row-check');
        for (let i = 0; i < boxes.length; i++) {
            const item = boxes[i].closest('.row-item');
            const url = item ? item.querySelector('.row-url').textContent : '';
            boxes[i].checked = selected.has(url);
        }
    }

    function selectAll() {
        for (const entry of visibleEntries()) selected.add(entry.item.url);
        updateSelectionUI();
    }

    function selectInvert() {
        for (const entry of visibleEntries()) {
            if (selected.has(entry.item.url)) selected.delete(entry.item.url);
            else selected.add(entry.item.url);
        }
        updateSelectionUI();
    }

    /** 当前选中的完整条目 */
    function selectedItems() {
        const out = [];
        for (const tab of tabs) {
            for (const item of tab.items) {
                if (selected.has(item.url)) out.push(item);
            }
        }
        return out;
    }

    // ============================================================
    // 操作
    // ============================================================

    function downloadItem(item) {
        chrome.runtime.sendMessage({
            type: 'popup:download',
            item: item
        }).catch(function (e) {
            setStatus('下载失败：' + (e.message || e), true);
        });
    }

    async function downloadSelected() {
        const items = selectedItems();
        if (items.length === 0) return;

        // 批量下载要排队，一次全发会把下载队列冲垮，
        // 也容易触发站点的频率限制
        setStatus('正在下载 ' + items.length + ' 项…');

        let done = 0;
        let failed = 0;

        for (const item of items) {
            try {
                await chrome.runtime.sendMessage({ type: 'popup:download', item: item });
                done++;
            } catch (e) {
                failed++;
            }
        }

        setStatus(
            '已提交 ' + done + ' 项' + (failed > 0 ? ('，' + failed + ' 项失败') : ''),
            failed > 0
        );
    }

    function copyText(text) {
        navigator.clipboard.writeText(text).then(function () {
            setStatus('已复制到剪贴板');
        }).catch(function () {
            setStatus('复制失败', true);
        });
    }

    async function copySelected() {
        const items = selectedItems();
        if (items.length === 0) return;

        // 按用户配置的模板渲染，和弹窗里的「复制」保持一致
        const tpl = config.copyTemplate || '${url}';

        const lines = items.map(function (item) {
            let host = '';
            try { host = new URL(item.pageUrl || item.url).hostname; } catch (e) { /* 忽略 */ }

            return JTUtils.renderTemplate(tpl, {
                url: item.url,
                referer: item.pageUrl || '',
                pageUrl: item.pageUrl || '',
                title: item.pageTitle || item.name || '',
                name: item.name || '',
                ext: item.ext || '',
                host: host
            });
        });

        copyText(lines.join('\n'));
        setStatus('已复制 ' + lines.length + ' 条');
    }

    async function deleteSelected() {
        const items = selectedItems();
        if (items.length === 0) return;

        if (!confirm('从列表中移除选中的 ' + items.length + ' 项？\n（只影响列表，不会删除已下载的文件）')) return;

        try {
            await chrome.runtime.sendMessage({
                type: 'popup:removeItems',
                urls: items.map(function (i) { return i.url; })
            });
            selected.clear();
            await load();
            setStatus('已移除 ' + items.length + ' 项');
        } catch (e) {
            setStatus('删除失败：' + (e.message || e), true);
        }
    }

    function setStatus(text, isError) {
        els.status.textContent = text;
        els.status.className = isError ? 'is-error' : '';
    }

    // ============================================================
    // 事件绑定
    // ============================================================

    els.btnRefresh.addEventListener('click', load);
    els.btnSelectAll.addEventListener('click', selectAll);
    els.btnInvert.addEventListener('click', selectInvert);
    els.btnCopy.addEventListener('click', copySelected);
    els.btnDownload.addEventListener('click', downloadSelected);
    els.btnDelete.addEventListener('click', deleteSelected);

    els.searchInput.addEventListener('input', render);
    els.sortSelect.addEventListener('change', render);
    els.reverseOrder.addEventListener('change', render);

    els.typeFilters.addEventListener('click', function (e) {
        const chip = e.target.closest('.chip');
        if (!chip) return;

        activeType = chip.dataset.type;

        const chips = els.typeFilters.querySelectorAll('.chip');
        for (let i = 0; i < chips.length; i++) {
            chips[i].classList.toggle('is-on', chips[i] === chip);
        }

        render();
    });

    // 资源是在后台不断新增的，隔一会儿自动刷新一次
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

    setInterval(load, 5000);

    Promise.resolve(load()).catch(showInitError);
})();
