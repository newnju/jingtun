/** 鲸吞：预览播放器逻辑 */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    const els = {
        video: $('video'),
        overlay: $('overlay'),
        overlayText: $('overlayText'),
        urlInput: $('urlInput'),
        btnLoad: $('btnLoad'),
        btnStop: $('btnStop'),
        speedSelect: $('speedSelect'),
        volumeRange: $('volumeRange'),
        volumeValue: $('volumeValue'),
        infoState: $('infoState'),
        infoLevel: $('infoLevel'),
        infoResolution: $('infoResolution'),
        infoDuration: $('infoDuration'),
        infoBuffer: $('infoBuffer'),
        infoBitrate: $('infoBitrate'),
        errorLine: $('errorLine')
    };

    /** 当前 hls.js 实例 */
    let hls = null;
    /** 信息刷新定时器 */
    let infoTimer = null;

    // ============================================================
    // 界面辅助
    // ============================================================

    /**
     * 设置状态文本
     * @param {string} text
     */
    function setState(text) {
        els.infoState.textContent = text;
    }

    /**
     * 显示错误
     * @param {string} text
     */
    function showError(text) {
        els.errorLine.hidden = false;
        els.errorLine.textContent = text;
    }

    /** 清除错误 */
    function clearError() {
        els.errorLine.hidden = true;
        els.errorLine.textContent = '';
    }

    /**
     * 显示遮罩提示
     * @param {string} text
     */
    function showOverlay(text) {
        els.overlayText.textContent = text;
        els.overlay.hidden = false;
    }

    /** 隐藏遮罩 */
    function hideOverlay() {
        els.overlay.hidden = true;
    }

    // ============================================================
    // 请求头继承
    // ============================================================

    /** fetch / XHR 不允许设置的头 */
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
    // 播放
    // ============================================================

    /**
     * 加载并播放一个 HLS 地址
     * @param {string} url
     */
    async function load(url) {
        if (!url) {
            showError('请输入 M3U8 链接');
            return;
        }

        clearError();
        destroy();
        showOverlay('正在加载…');
        setState('加载中');

        // 继承嗅探时捕获的请求头：播放清单与分片常校验 Authorization / x-*
        const headers = await lookupHeaders(url);

        // 优先使用 hls.js
        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            hls = new Hls({
                enableWorker: true,        // 解析放入 Worker，避免阻塞界面
                lowLatencyMode: false,
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                manifestLoadingTimeOut: 15000,
                manifestLoadingMaxRetry: 3,
                fragLoadingMaxRetry: 4,
                // 让清单与分片的请求带上捕获到的头，并携带 Cookie
                withCredentials: true,
                xhrSetup: headers
                    ? function (xhr) {
                        for (const key of Object.keys(headers)) {
                            try { xhr.setRequestHeader(key, headers[key]); }
                            catch (e) { /* 个别头不允许设置，跳过 */ }
                        }
                    }
                    : undefined
            });

            hls.loadSource(url);
            hls.attachMedia(els.video);

            hls.on(Hls.Events.MANIFEST_PARSED, function (event, data) {
                hideOverlay();
                setState('就绪');

                if (data && data.levels && data.levels.length > 0) {
                    els.infoLevel.textContent = String(data.levels.length) + ' 个档位';
                }

                els.video.play().catch(() => {
                    // 自动播放被拦截时，等待用户手动点击
                    setState('就绪（点击播放）');
                });
            });

            hls.on(Hls.Events.LEVEL_SWITCHED, function (event, data) {
                if (!hls || !hls.levels) return;
                const level = hls.levels[data.level];
                if (!level) return;

                els.infoResolution.textContent =
                    (level.width && level.height) ? `${level.width}×${level.height}` : '—';
                els.infoBitrate.textContent =
                    level.bitrate ? Math.round(level.bitrate / 1000) + ' kbps' : '—';
            });

            hls.on(Hls.Events.ERROR, function (event, data) {
                if (!data) return;

                if (data.fatal) {
                    let message = '播放失败：';

                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            message += '网络错误。可能是跨域限制、链接已失效或需要 Referer。';
                            // 尝试恢复
                            try { hls.startLoad(); } catch (e) { /* 忽略 */ }
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            message += '媒体错误，正在尝试恢复…';
                            try { hls.recoverMediaError(); } catch (e) { /* 忽略 */ }
                            break;
                        default:
                            message += data.details || '未知错误';
                            destroy();
                            break;
                    }

                    showError(message);
                    setState('出错');
                }
            });

            return;
        }

        // 降级：Safari 等原生支持 HLS 的浏览器
        if (els.video.canPlayType('application/vnd.apple.mpegurl')) {
            els.video.src = url;
            els.video.addEventListener('loadedmetadata', function onLoaded() {
                els.video.removeEventListener('loadedmetadata', onLoaded);
                hideOverlay();
                setState('就绪');
                els.video.play().catch(() => { /* 忽略 */ });
            });
            return;
        }

        showError('当前浏览器不支持 HLS 播放（缺少 Media Source Extensions）');
        setState('不支持');
        showOverlay('浏览器不支持播放');
    }

    /** 停止播放并释放资源 */
    function destroy() {
        if (hls) {
            try {
                hls.destroy();
            } catch (e) { /* 忽略 */ }
            hls = null;
        }

        try {
            els.video.pause();
            els.video.removeAttribute('src');
            els.video.load();
        } catch (e) { /* 忽略 */ }

        els.btnStop.disabled = true;
        els.infoLevel.textContent = '—';
        els.infoResolution.textContent = '—';
        els.infoDuration.textContent = '—';
        els.infoBuffer.textContent = '—';
        els.infoBitrate.textContent = '—';
    }

    // ============================================================
    // 信息刷新
    // ============================================================

    /** 刷新播放信息 */
    function refreshInfo() {
        const video = els.video;

        // 时长
        if (video.duration && isFinite(video.duration)) {
            els.infoDuration.textContent = JTUtils.secToTime(video.duration);
        }

        // 已缓冲范围
        try {
            if (video.buffered && video.buffered.length > 0) {
                const end = video.buffered.end(video.buffered.length - 1);
                els.infoBuffer.textContent =
                    JTUtils.secToTime(video.currentTime) + ' / ' + JTUtils.secToTime(end);
            }
        } catch (e) { /* 忽略 */ }

        // 播放状态
        if (!video.paused && video.currentTime > 0) {
            setState('播放中');
        } else if (video.paused && video.currentTime > 0) {
            setState('已暂停');
        }
    }

    // ============================================================
    // 初始化
    // ============================================================

    function init() {
        JTUtils.setTitle('pagePreview', '预览播放');

        // 加载按钮
        els.btnLoad.addEventListener('click', () => {
            const url = els.urlInput.value.trim();
            if (url) {
                els.btnStop.disabled = false;
                load(url);
            }
        });

        // 回车加载
        els.urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                els.btnLoad.click();
            }
        });

        // 停止
        els.btnStop.addEventListener('click', () => {
            destroy();
            showOverlay('已停止播放');
            setState('已停止');
        });

        // 倍速
        els.speedSelect.addEventListener('change', () => {
            els.video.playbackRate = parseFloat(els.speedSelect.value) || 1;
        });

        // 音量
        els.volumeRange.addEventListener('input', () => {
            const value = parseInt(els.volumeRange.value, 10);
            els.video.volume = value / 100;
            els.volumeValue.textContent = String(value);
        });

        // 播放开始后隐藏遮罩
        els.video.addEventListener('playing', () => {
            hideOverlay();
        });

        // 定期刷新信息
        infoTimer = setInterval(refreshInfo, 800);

        // 支持通过 URL 参数直接加载（从弹窗跳转）
        const params = new URLSearchParams(location.search);
        const presetUrl = params.get('url');
        if (presetUrl) {
            els.urlInput.value = presetUrl;
            els.btnStop.disabled = false;
            load(presetUrl);
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

    // 页面卸载时释放资源
    window.addEventListener('beforeunload', () => {
        if (infoTimer) clearInterval(infoTimer);
        destroy();
    });
})();
