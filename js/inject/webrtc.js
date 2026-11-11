/** 鲸吞：WebRTC 捕获（注入至页面 MAIN world） */
(function __JINGTUN_WEBRTC__() {
    'use strict';

    const SELF = typeof self !== 'undefined' ? self : this;

    if (SELF.__JINGTUN_WEBRTC__) return;
    SELF.__JINGTUN_WEBRTC__ = true;

    // 原生 postMessage：页面可能劫持它，抢先抓住引用
    const nativePostMessage = (typeof SELF.postMessage === 'function')
        ? SELF.postMessage.bind(SELF)
        : null;

    /** 取一条文案 */
    function t(key, params, fallback) {
        const dict = SELF.__JINGTUN_I18N__;
        if (dict && typeof dict.get === 'function') return dict.get(key, params);
        return fallback || key;
    }
    function report(action, payload) {
        if (!nativePostMessage) return;
        try {
            nativePostMessage({ action: action, payload: payload }, SELF.location.origin);
        } catch (e) {
            // 忽略
        }
    }

    /** 收集到的轨道池 */
    const pool = { video: [], audio: [] };

    let recorder = null;
    let chunks = [];
    let startedAt = 0;
    let segmentIndex = 0;

    /** 单段最长时长：避免长时间录制产生超大单文件 */
    const CHUNK_INTERVAL_MS = 10000;

    // ============================================================
    // 轨道收集
    // ============================================================

    function addTrack(track, streamId) {
        if (!track || typeof track.kind !== 'string') return;

        const kind = track.kind === 'video' ? 'video' :
            (track.kind === 'audio' ? 'audio' : null);
        if (!kind) return;

        // 同一条轨道可能被反复触发（重连、替换流），按 id 去重
        if (pool[kind].some(function (t) { return t.track.id === track.id; })) return;

        pool[kind].push({
            track: track,
            streamId: streamId || '',
            label: track.label || (kind + ' ' + (pool[kind].length + 1))
        });

        report('jt:webrtcTrack', {
            kind: kind,
            label: track.label || '',
            videoCount: pool.video.length,
            audioCount: pool.audio.length
        });

        updatePanelInfo();
    }

    // ============================================================
    // 录制
    // ============================================================

    function pickMimeType() {
        if (typeof MediaRecorder === 'undefined') return '';

        const candidates = [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
            'video/mp4'
        ];

        for (const type of candidates) {
            if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        }
        return '';
    }

    /** 开始录制（默认第一条视频轨 + 第一条音频轨） */
    function start(videoIndex, audioIndex) {
        if (recorder) return { ok: false, error: t('rtc.alreadyRecording', null, '已经在录制了') };

        const video = pool.video[videoIndex || 0];
        const audio = pool.audio[audioIndex === undefined ? 0 : audioIndex];

        if (!video && !audio) {
            return { ok: false, error: t('rtc.noTracks', null, '还没有捕获到任何轨道') };
        }

        const stream = new MediaStream();
        if (video) stream.addTrack(video.track);
        if (audio) stream.addTrack(audio.track);

        const mimeType = pickMimeType();

        try {
            recorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : undefined);
        } catch (e) {
            return { ok: false, error: t('rtc.createFail', { msg: e.message || e }, '创建录制器失败：' + (e.message || e)) };
        }

        chunks = [];
        segmentIndex = 0;
        startedAt = Date.now();

        recorder.addEventListener('dataavailable', function (event) {
            if (event.data && event.data.size > 0) chunks.push(event.data);
        });

        recorder.addEventListener('stop', function () {
            exportChunks();
        });

        recorder.addEventListener('error', function (event) {
            report('jt:webrtcError', {
                error: String((event.error && event.error.name) || 'unknown')
            });
        });

        try {
            recorder.start(CHUNK_INTERVAL_MS);
        } catch (e) {
            recorder = null;
            return { ok: false, error: t('rtc.startFail', { msg: e.message || e }, '启动失败：' + (e.message || e)) };
        }

        report('jt:webrtcState', { recording: true });
        updatePanelInfo();

        return { ok: true };
    }

    function stop() {
        if (!recorder) return { ok: false, error: t('rtc.notRecording', null, '没有在录制') };

        try {
            recorder.stop();
        } catch (e) {
            return { ok: false, error: t('rtc.stopFail', { msg: e.message || e }, '停止失败：' + (e.message || e)) };
        }

        // 停止所有轨道，否则浏览器的录制指示灯一直亮着
        for (const item of pool.video) {
            if (item.track.readyState === 'live') item.track.stop();
        }
        for (const item of pool.audio) {
            if (item.track.readyState === 'live') item.track.stop();
        }

        recorder = null;
        report('jt:webrtcState', { recording: false });
        updatePanelInfo();

        return { ok: true };
    }

    function exportChunks() {
        if (chunks.length === 0) return;

        const type = recorder ? recorder.mimeType : 'video/webm';
        const blob = new Blob(chunks, { type: type || 'video/webm' });
        chunks = [];
        segmentIndex++;

        const seconds = Math.round((Date.now() - startedAt) / 1000);
        const ext = (type && type.indexOf('mp4') !== -1) ? 'mp4' : 'webm';
        const name = 'webrtc-' + new Date().toISOString().slice(0, 19).replace(/[-:]/g, '') +
            '-' + seconds + 's.' + ext;

        triggerDownload(blob, name);

        report('jt:webrtcDone', {
            fileName: name,
            size: blob.size,
            seconds: seconds
        });
    }

    function triggerDownload(blob, fileName) {
        try {
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = fileName;
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
        } catch (e) {
            report('jt:webrtcError', { error: t('rtc.exportFail', { msg: e.message || e }, '导出失败：' + (e.message || e)) });
        }
    }

    // ============================================================
    // 页面内面板
    // ============================================================

    let panelHost = null;
    let panelRoot = null;

    /**
     * 安全地创建 Shadow DOM
     * @param {HTMLElement} element
     * @param {string} [mode]
     * @returns {ShadowRoot|HTMLElement}
     */
    function createSecureShadowRoot(element, mode) {
        mode = mode || 'closed';

        let attach = null;

        try {
            const fn = Element.prototype.attachShadow;
            if (fn && fn.toString().indexOf('[native code]') !== -1) {
                attach = fn.bind(element);
            }
        } catch (e) {
            // 往下走 iframe 方案
        }

        if (!attach) {
            try {
                const iframe = document.createElement('iframe');
                iframe.style.cssText = 'display:none;width:0;height:0;border:0';
                (document.body || document.documentElement).appendChild(iframe);

                const pristine = iframe.contentDocument &&
                    iframe.contentDocument.createElement('div').attachShadow;

                iframe.remove();

                if (pristine) attach = pristine.bind(element);
            } catch (e) {
                // iframe 也拿不到，继续降级
            }
        }

        if (attach) {
            try {
                return attach({ mode: mode });
            } catch (e) {
                // 落到降级分支
            }
        }

        // 退路：返回元素本身当普通容器
        return element;
    }

    function buildPanel() {
        if (panelHost || !document.body) return;

        const host = document.createElement('div');
        host.style.cssText =
            'position:fixed;right:16px;bottom:16px;z-index:2147483645;' +
            'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;';

        // closed 模式：页面拿不到内部结构，不会误改。
        panelRoot = createSecureShadowRoot(host, 'closed');

        const style = document.createElement('style');
        style.textContent = [
            '.p{background:#1c1c1ee6;color:#e8e8ea;border-radius:10px;',
            'box-shadow:0 6px 24px rgba(0,0,0,.35);overflow:hidden;min-width:180px}',
            '.h{display:flex;align-items:center;gap:6px;padding:7px 10px;',
            'background:#00000040;user-select:none}',
            '.dot{width:8px;height:8px;border-radius:50%;background:#e05a4f}',
            '.dot.on{background:#4ec97e}',
            '.t{font-size:12px;font-weight:600;flex:1 1 auto}',
            '.x{background:none;border:none;color:#9a9aa0;font-size:15px;cursor:pointer}',
            '.x:hover{color:#e8e8ea}',
            '.b{padding:8px 10px;display:flex;flex-direction:column;gap:7px}',
            '.info{font-size:11px;color:#a8a8ae}',
            '.row{display:flex;gap:6px}',
            '.btn{flex:1 1 auto;padding:5px 8px;border:1px solid #4a4a50;',
            'border-radius:5px;background:#2f2f34;color:#e8e8ea;font-size:12px;cursor:pointer}',
            '.btn:hover{background:#3a3a40}',
            '.btn.pri{background:#2f7cf6;border-color:#2f7cf6;color:#fff}',
            '.btn:disabled{opacity:.5;cursor:default}'
        ].join('');

        panelRoot.appendChild(style);

        const box = document.createElement('div');
        box.className = 'p';

        const head = document.createElement('div');
        head.className = 'h';

        const dot = document.createElement('span');
        dot.className = 'dot';

        const title = document.createElement('span');
        title.className = 't';
        title.textContent = t('rtc.title', null, '鲸吞：WebRTC');

        const close = document.createElement('button');
        close.className = 'x';
        close.textContent = '×';
        close.title = t('region.close', null, '关闭');

        head.append(dot, title, close);

        const body = document.createElement('div');
        body.className = 'b';

        const info = document.createElement('div');
        info.className = 'info';
        info.textContent = t('rtc.waiting', null, '等待轨道…');

        const row = document.createElement('div');
        row.className = 'row';

        const btnRec = document.createElement('button');
        btnRec.className = 'btn pri';
        btnRec.textContent = t('rtc.start', null, '开始录制');

        row.appendChild(btnRec);
        body.append(info, row);

        box.append(head, body);
        panelRoot.appendChild(box);
        document.body.appendChild(host);
        panelHost = host;

        let recording = false;

        btnRec.addEventListener('click', function () {
            const result = recording ? stop() : start(0, 0);

            if (result && result.ok) {
                recording = !recording;
                btnRec.textContent = recording ? t('rtc.stop', null, '停止并保存') : t('rtc.start', null, '开始录制');
                dot.classList.toggle('on', recording);
            } else if (result && result.error) {
                info.textContent = result.error;
            }
        });

        close.addEventListener('click', function () {
            if (recording) stop();
            destroyPanel();
        });
    }

    function updatePanelInfo() {
        if (!panelRoot) return;
        const info = panelRoot.querySelector('.info');
        if (!info) return;

        info.textContent = t('rtc.tracks',
            { video: pool.video.length, audio: pool.audio.length },
            '视频 ' + pool.video.length + ' 条 · 音频 ' + pool.audio.length + ' 条') +
            (pool.video.length + pool.audio.length === 0 ? t('rtc.tracksWaiting', null, '（等待中）') : '');
    }

    function destroyPanel() {
        if (panelHost && panelHost.parentNode) panelHost.parentNode.removeChild(panelHost);
        panelHost = null;
        panelRoot = null;
    }

    // ============================================================
    // Hook：RTCPeerConnection
    // ============================================================

    if (typeof SELF.RTCPeerConnection === 'function') {
        const Original = SELF.RTCPeerConnection;

        const Patched = new Proxy(Original, {
            construct(target, args, newTarget) {
                const pc = Reflect.construct(target, args, newTarget);

                try {
                    // 收到远端轨道时收集起来
                    pc.addEventListener('track', function (event) {
                        try {
                            if (event.streams && event.streams[0]) {
                                addTrack(event.track, event.streams[0].id);
                            } else {
                                addTrack(event.track, '');
                            }
                        } catch (e) {
                            // 忽略
                        }
                    });

                    // 连接断开时，如果正在录制就自动停，
                    // 否则会一直录着最后的静止画面，文件白白变大
                    pc.addEventListener('iceconnectionstatechange', function () {
                        try {
                            if (pc.iceConnectionState === 'disconnected' ||
                                pc.iceConnectionState === 'failed') {
                                if (recorder) stop();
                            }
                        } catch (e) {
                            // 忽略
                        }
                    });
                } catch (e) {
                    // 某些实现不支持 addEventListener，忽略
                }

                return pc;
            }
        });

        Patched.toString = function () { return Original.toString(); };
        SELF.RTCPeerConnection = Patched;
    }

    // 页面卸载时停止录制，避免留下半个文件
    SELF.addEventListener('beforeunload', function () {
        if (recorder) {
            try { recorder.stop(); } catch (e) { /* 忽略 */ }
        }
    });

    // ============================================================
    // 接收指令
    // ============================================================

    SELF.addEventListener('message', function (event) {
        if (!event.data || event.source !== SELF) return;

        if (event.data.action === 'jt:webrtcStart') {
            buildPanel();
            const result = start(0, 0);
            report('jt:webrtcResult', result);
        }
    });
})();
