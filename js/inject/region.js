/** 鲸吞：区域录制（注入至页面 MAIN world） */
(function __JINGTUN_REGION__() {
    'use strict';

    const SELF = typeof self !== 'undefined' ? self : this;

    if (SELF.__JINGTUN_REGION__) return;
    SELF.__JINGTUN_REGION__ = true;

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

    /** 是否支持区域捕获 */
    const canCrop = typeof CropTarget !== 'undefined' &&
        typeof CropTarget.fromElement === 'function';

    let overlay = null;
    let recording = false;
    let recorder = null;
    let chunks = [];
    let startedAt = 0;

    // ============================================================
    // 选择框
    // ============================================================

    function buildOverlay() {
        if (overlay || !document.body) return overlay;

        const box = document.createElement('div');
        box.style.cssText = [
            'position:fixed',
            // 初始对着第一个 video 元素，省得用户自己拖
            'left:10%', 'top:10%', 'width:60%', 'height:50%',
            'z-index:2147483644',
            'border:2px dashed #2f7cf6',
            'border-radius:4px',
            'box-shadow:0 0 0 9999px rgba(0,0,0,.35)',
            'cursor:move',
            'min-width:80px', 'min-height:60px'
        ].join(';');

        // 右下角缩放把手
        const handle = document.createElement('div');
        handle.style.cssText = [
            'position:absolute', 'right:-6px', 'bottom:-6px',
            'width:14px', 'height:14px',
            'background:#2f7cf6', 'border-radius:2px',
            'cursor:se-resize'
        ].join(';');
        box.appendChild(handle);

        // 工具条
        const bar = document.createElement('div');
        bar.style.cssText = [
            'position:absolute', 'top:-32px', 'left:0',
            'display:flex', 'gap:6px', 'align-items:center',
            'font:12px system-ui,sans-serif', 'white-space:nowrap'
        ].join(';');

        const btnStart = document.createElement('button');
        btnStart.textContent = t('region.start', null, '开始录制');
        btnStart.style.cssText = btnStyle('#2f7cf6', '#fff');

        const btnClose = document.createElement('button');
        btnClose.textContent = '×';
        btnClose.title = t('region.close', null, '关闭');
        btnClose.style.cssText = btnStyle('#444', '#eee');

        const tip = document.createElement('span');
        tip.style.cssText = 'color:#eee;background:#00000099;padding:2px 6px;border-radius:3px';
        tip.textContent = canCrop
            ? t('region.hint', null, '拖动框选要录的区域')
            : t('region.hintNoCrop', null, '当前浏览器不支持区域捕获，将录制整个标签页');

        bar.append(btnStart, tip, btnClose);
        box.appendChild(bar);

        document.body.appendChild(box);
        overlay = box;

        // --- 拖动 ---
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let originLeft = 0;
        let originTop = 0;

        box.addEventListener('mousedown', function (e) {
            if (e.target === handle) return;   // 把手单独处理
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            originLeft = box.offsetLeft;
            originTop = box.offsetTop;
            e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            box.style.left = (originLeft + e.clientX - startX) + 'px';
            box.style.top = (originTop + e.clientY - startY) + 'px';
        });

        document.addEventListener('mouseup', function () { dragging = false; });

        // --- 缩放 ---
        let resizing = false;
        let resizeStartW = 0;
        let resizeStartH = 0;

        handle.addEventListener('mousedown', function (e) {
            resizing = true;
            startX = e.clientX;
            startY = e.clientY;
            resizeStartW = box.offsetWidth;
            resizeStartH = box.offsetHeight;
            e.stopPropagation();
            e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
            if (!resizing) return;
            box.style.width = Math.max(80, resizeStartW + e.clientX - startX) + 'px';
            box.style.height = Math.max(60, resizeStartH + e.clientY - startY) + 'px';
        });

        document.addEventListener('mouseup', function () { resizing = false; });

        btnStart.addEventListener('click', function () {
            if (recording) stopRecording();
            else startRecording();
            btnStart.textContent = recording ? t('region.stop', null, '停止并保存') : t('region.start', null, '开始录制');
        });

        btnClose.addEventListener('click', function () {
            if (recording) stopRecording();
            destroyOverlay();
        });

        // 初始位置对着第一个 video，省得用户自己拖
        const first = document.querySelector('video');
        if (first) {
            const r = first.getBoundingClientRect();
            if (r.width > 40 && r.height > 40) {
                box.style.left = r.left + 'px';
                box.style.top = r.top + 'px';
                box.style.width = r.width + 'px';
                box.style.height = r.height + 'px';
            }
        }

        return box;
    }

    function btnStyle(bg, color) {
        return 'padding:3px 10px;border:none;border-radius:4px;' +
            'background:' + bg + ';color:' + color +
            ';font-size:12px;cursor:pointer';
    }

    function destroyOverlay() {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        overlay = null;
    }

    // ============================================================
    // 录制
    // ============================================================

    async function startRecording() {
        if (recording) return;

        let stream;

        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                preferCurrentTab: true,
                video: { cursor: 'never' },
                audio: true
            });
        } catch (e) {
            report('jt:regionError', {
                error: t('region.noPermission', { msg: e.message || e }, '没有拿到屏幕共享权限：' + (e.message || e))
            });
            return;
        }

        // 把画面裁到选中的区域
        if (canCrop && overlay) {
            try {
                const target = await CropTarget.fromElement(overlay);
                const [track] = stream.getVideoTracks();
                if (track && typeof track.cropTo === 'function') {
                    await track.cropTo(target);
                }
            } catch (e) {
                // 裁剪失败就录整屏，总比录不了强
                report('jt:regionError', {
                    error: t('region.cropFail', { msg: e.message || e }, '区域裁剪失败，将录制整个页面：' + (e.message || e))
                });
            }
        }

        const mimeType = pickMimeType();

        try {
            recorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : undefined);
        } catch (e) {
            report('jt:regionError', { error: t('region.createFail', { msg: e.message || e }, '创建录制器失败：' + (e.message || e)) });
            return;
        }

        chunks = [];
        startedAt = Date.now();
        recording = true;

        recorder.addEventListener('dataavailable', function (event) {
            if (event.data && event.data.size > 0) chunks.push(event.data);
        });

        recorder.addEventListener('stop', function () {
            exportChunks();
            // 录完要把共享轨道关掉，否则浏览器会一直显示"正在共享"
            for (const track of stream.getTracks()) track.stop();
        });

        // 用户在浏览器自带的"停止共享"上点了停止
        const [videoTrack] = stream.getVideoTracks();
        if (videoTrack) {
            videoTrack.addEventListener('ended', function () {
                if (recording) stopRecording();
            });
        }

        try {
            recorder.start(10000);
            report('jt:regionState', { recording: true });
        } catch (e) {
            recording = false;
            report('jt:regionError', { error: t('region.startFail', { msg: e.message || e }, '启动失败：' + (e.message || e)) });
        }
    }

    function stopRecording() {
        if (!recorder || !recording) return;

        recording = false;
        try {
            recorder.stop();
        } catch (e) {
            // 忽略
        }
        recorder = null;
        report('jt:regionState', { recording: false });
    }

    function exportChunks() {
        if (chunks.length === 0) return;

        const blob = new Blob(chunks, { type: 'video/webm' });
        chunks = [];

        const seconds = Math.round((Date.now() - startedAt) / 1000);
        const name = 'region-' + new Date().toISOString().slice(0, 19).replace(/[-:]/g, '') +
            '-' + seconds + 's.webm';

        try {
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = name;
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
        } catch (e) {
            report('jt:regionError', { error: t('region.exportFail', { msg: e.message || e }, '导出失败：' + (e.message || e)) });
        }

        report('jt:regionDone', { fileName: name, size: blob.size, seconds: seconds });
    }

    function pickMimeType() {
        if (typeof MediaRecorder === 'undefined') return '';

        const candidates = [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm'
        ];

        for (const type of candidates) {
            if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        }
        return '';
    }

    // ============================================================
    // 指令
    // ============================================================

    SELF.addEventListener('message', function (event) {
        if (!event.data || event.source !== SELF) return;

        if (event.data.action === 'jt:regionOpen') {
            buildOverlay();
        }
    });

    // 页面卸载时收尾
    SELF.addEventListener('beforeunload', function () {
        if (recording) stopRecording();
    });
})();
