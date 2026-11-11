/** 鲸吞：独立下载页 */
(function () {
    'use strict';

    const els = {
        title: document.getElementById('title'),
        desc: document.getElementById('desc'),
        fill: document.getElementById('fill'),
        err: document.getElementById('err'),
        hint: document.getElementById('hint')
    };

    /** 超过这个大小就建议流式写盘 */
    const STREAM_THRESHOLD = 500 * 1024 * 1024;

    /** 超过这个大小就不允许走内存了 */
    const MEMORY_LIMIT = 1.5 * 1024 * 1024 * 1024;

    /** 能不能流式写盘 */
    function canStreamToDisk() {
        return typeof window.showSaveFilePicker === 'function';
    }

    /**
     * 解析 URL 参数
     * @returns {Object|null}
     */
    function readParams() {
        const query = location.search.slice(1);
        const match = /(?:^|&)JSON=([^&]*)/.exec(query);

        if (!match) return null;

        try {
            return JSON.parse(decodeURIComponent(match[1]));
        } catch (e) {
            return null;
        }
    }

    /**
     * 显示错误
     * @param {string} message
     */
    function showError(message) {
        els.title.textContent = '下载失败';
        els.desc.textContent = '';
        els.err.textContent = message;
        els.err.hidden = false;
    }

    /**
     * 用 declarativeNetRequest 给接下来的请求补上头
     * @param {string} url 目标地址
     * @param {Object} headers { 头名: 值 }
     * @returns {Promise<number>} 规则 id
     */
    async function applyHeaders(url, headers) {
        if (!chrome.declarativeNetRequest) return 0;

        const ruleId = Math.floor(Math.random() * 900000) + 100000;

        const requestHeaders = [];
        for (const key of Object.keys(headers || {})) {
            const value = headers[key];
            if (value === undefined || value === null || value === '') continue;
            requestHeaders.push({
                header: key,
                operation: 'set',
                value: String(value)
            });
        }

        if (requestHeaders.length === 0) return 0;

        // urlFilter 用 origin + path，查询串里可能有 urlFilter 的通配符
        let filterUrl = url;
        try {
            const u = new URL(url);
            filterUrl = u.origin + u.pathname;
        } catch (e) { /* 用原值 */ }

        try {
            await chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: [ruleId],
                addRules: [{
                    id: ruleId,
                    priority: 2,
                    action: { type: 'modifyHeaders', requestHeaders: requestHeaders },
                    condition: {
                        urlFilter: filterUrl,
                        resourceTypes: ['xmlhttprequest', 'media', 'other']
                    }
                }]
            });
            return ruleId;
        } catch (e) {
            console.warn('[鲸吞] 下载页补头规则失败:', e.message || e);
            return 0;
        }
    }

    /** 撤掉补头规则 */
    function clearHeaders(ruleId) {
        if (!ruleId || !chrome.declarativeNetRequest) return;
        chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] })
            .catch(function () { /* 忽略 */ });
    }

    /**
     * 带重试阶梯地取数据
     * @param {string} url
     * @param {Object} params
     * @returns {Promise<Response>}
     */
    async function fetchWithRetry(url, params) {
        const base = Object.assign({}, params.requestHeaders || {});

        // 丢掉捕获到的 Range。
        delete base.range;
        delete base.Range;

        const steps = [
            { label: '直接取', headers: base },
            {
                label: '加 Range',
                headers: Object.assign({}, base, { Range: 'bytes=0-' })
            },
            {
                label: '补页面特征',
                headers: Object.assign({}, base, {
                    'sec-fetch-mode': 'no-cors',
                    'sec-fetch-site': 'same-site'
                })
            }
        ];

        let lastError = null;

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const ruleId = await applyHeaders(url, step.headers);

            try {
                const response = await fetch(url, {
                    // 带上 Cookie：很多站点的鉴权靠它
                    credentials: 'include',
                    // 带上页面地址作为 Referer
                    referrer: params.referrer || undefined,
                    // 头都走 DNR 了，这里不再重复设置（受限头设了也没用）
                    cache: 'no-cache'
                });

                if (response.ok) {
                    if (i > 0) {
                        console.info('[鲸吞] 第 ' + (i + 1) + ' 步（' + step.label + '）成功');
                    }
                    // 成功的话规则留着，下载还没读完，中途撤掉会断
                    return { response: response, ruleId: ruleId };
                }

                lastError = new Error('HTTP ' + response.status);
                clearHeaders(ruleId);
            } catch (e) {
                lastError = e;
                clearHeaders(ruleId);
            }

            // 下一步之前稍等一下，避免被当成重放攻击
            if (i < steps.length - 1) {
                await new Promise(function (r) { setTimeout(r, 300); });
            }
        }

        throw lastError || new Error('请求失败');
    }

    /**
     * 下载数据
     * @param {Object} params
     */
    async function download(params) {
        const url = params.url;
        if (!url) {
            showError('缺少下载地址');
            return;
        }

        els.title.textContent = '正在获取…';
        els.desc.textContent = JTUtils.safeHostname ? JTUtils.safeHostname(url) : url;

        let got;
        try {
            got = await fetchWithRetry(url, params);
        } catch (e) {
            showError('请求失败：' + (e.message || e) +
                '（已试过补 Range 与页面特征，仍被拒绝。可能是地址已过期或需要登录）');
            return;
        }

        const response = got.response;
        const ruleId = got.ruleId;

        const total = parseInt(response.headers.get('content-length') || '0', 10);

        // 大文件先问一句，别直接往内存里灌
        if (total > STREAM_THRESHOLD && canStreamToDisk()) {
            clearHeaders(ruleId);
            offerStreaming(response, params.filename, total);
            return;
        }

        // 文件大到内存放不下，又不支持流式写盘，说清楚，别让它崩
        if (total > MEMORY_LIMIT && !canStreamToDisk()) {
            clearHeaders(ruleId);
            showError('文件约 ' + JTUtils.byteToSize(total) +
                '，超出内存下载的安全范围。当前浏览器不支持流式写盘，' +
                '建议改用 aria2，或在设置里配好 aria2 后重试。');
            return;
        }

        let blob;
        try {
            if (response.body && response.body.getReader) {
                blob = await readStream(response, total);
            } else {
                blob = await response.blob();
                els.fill.style.width = '100%';
            }
        } catch (e) {
            showError('读取数据失败：' + (e.message || e));
            return;
        } finally {
            // 数据读完了，补头规则可以撤了
            clearHeaders(ruleId);
        }

        if (!blob || blob.size === 0) {
            showError('服务器返回了空内容');
            return;
        }

        await save(blob, params.filename);
    }

    /**
     * 询问用户是否用流式保存
     * @param {Response} response
     * @param {string} filename
     * @param {number} total
     */
    function offerStreaming(response, filename, total) {
        els.title.textContent = '文件较大';
        els.desc.textContent = '约 ' + JTUtils.byteToSize(total) +
            '，建议直接写盘保存（不占内存）';

        const btn = document.getElementById('streamBtn');
        if (!btn) {
            showError('文件约 ' + JTUtils.byteToSize(total) + '，超出内存范围');
            return;
        }

        btn.hidden = false;
        btn.textContent = '保存到磁盘';

        btn.addEventListener('click', async function () {
            btn.disabled = true;
            els.title.textContent = '正在保存…';

            try {
                await streamToDisk(response, filename, total);
                els.title.textContent = '下载完成';
                els.desc.textContent = JTUtils.byteToSize(total);
                els.hint.hidden = false;
            } catch (e) {
                // 用户取消文件选择不算错误
                if (e && e.name === 'AbortError') {
                    els.title.textContent = '已取消';
                    els.desc.textContent = '';
                    btn.disabled = false;
                    return;
                }
                showError('保存失败：' + (e.message || e));
            }
        }, { once: true });
    }

    /**
     * 边收边写盘
     * @param {Response} response
     * @param {string} filename
     * @param {number} total
     */
    async function streamToDisk(response, filename, total) {
        const handle = await window.showSaveFilePicker({
            suggestedName: sanitizeName(filename || 'download.bin')
        });

        const writable = await handle.createWritable();
        const reader = response.body.getReader();

        let received = 0;

        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                await writable.write(value);
                received += value.length;

                if (total > 0) {
                    els.fill.style.width = Math.round(received / total * 100) + '%';
                    els.desc.textContent =
                        JTUtils.byteToSize(received) + ' / ' + JTUtils.byteToSize(total);
                } else {
                    els.desc.textContent = '已写入 ' + JTUtils.byteToSize(received);
                }
            }

            await writable.close();
            els.fill.style.width = '100%';
        } catch (e) {
            // 中途失败要把半截文件清掉，别留个坏文件让用户以为下好了
            try { await writable.abort(); } catch (e2) { /* 忽略 */ }
            throw e;
        }
    }

    /** 去掉文件名里的非法字符 */
    function sanitizeName(name) {
        return String(name)
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .trim()
            .slice(0, 150) || 'download.bin';
    }

    /**
     * 流式读取响应，边读边更新进度
     * @param {Response} response
     * @param {number} total 总字节数，0 表示未知
     * @returns {Promise<Blob>}
     */
    async function readStream(response, total) {
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            chunks.push(value);
            received += value.length;

            if (total > 0) {
                els.fill.style.width = Math.round(received / total * 100) + '%';
                els.desc.textContent =
                    JTUtils.byteToSize(received) + ' / ' + JTUtils.byteToSize(total);
            } else {
                els.desc.textContent = '已接收 ' + JTUtils.byteToSize(received);
            }
        }

        els.fill.style.width = '100%';

        // 合并成一个 Blob。用 Uint8Array 拼比 Blob 数组更快，
        // 也避免某些浏览器对 Blob 数组的处理差异。
        const merged = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }

        const type = response.headers.get('content-type') || 'application/octet-stream';
        return new Blob([merged], { type: type });
    }

    /**
     * 把 Blob 交给浏览器下载
     * @param {Blob} blob
     * @param {string} [filename]
     */
    async function save(blob, filename) {
        els.title.textContent = '正在保存…';

        try {
            const objectUrl = URL.createObjectURL(blob);

            const downloadId = await chrome.downloads.download({
                url: objectUrl,
                filename: filename || undefined,
                saveAs: false
            });

            if (!downloadId) throw new Error('下载器没有接受这个任务');

            els.title.textContent = '下载完成';
            els.desc.textContent = '';
            els.hint.hidden = false;

            // 给下载器一点时间把流接过去再释放
            setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 60000);

            // 自动关闭：这个页面本来就是临时的，不该留在标签栏里
            setTimeout(function () {
                window.close();
            }, 1500);
        } catch (e) {
            showError('保存失败：' + (e.message || e));
        }
    }

    // ============================================================

    const params = readParams();

    if (!params) {
        showError('缺少下载参数，这个页面不能直接打开');
    } else {
            Promise.resolve(download(params)).catch(showInitError);
    }
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

})();
