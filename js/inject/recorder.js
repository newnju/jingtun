/** 鲸吞：录制模式（注入至页面 MAIN world） */
(function __JINGTUN_RECORDER__() {
    'use strict';

    const SELF = typeof self !== 'undefined' ? self : this;

    // 防重复注入
    if (SELF.__JINGTUN_RECORDER__) return;
    SELF.__JINGTUN_RECORDER__ = true;

    /** 单段最大体积 */
    const MAX_SEGMENT_BYTES = 500 * 1024 * 1024;

    /** 向 MediaRecorder 请求数据的间隔 */
    const CHUNK_INTERVAL_MS = 10000;

    let recorder = null;
    let recordedChunks = [];
    let startedAt = 0;
    let totalBytes = 0;
    let segmentIndex = 0;
    let progressTimer = null;

    // ============================================================
    // 上报
    // ============================================================

    /**
     * 上报到内容脚本
     * @param {string} action
     * @param {Object} payload
     */
    /** 原生的 postMessage */
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
        try {
            nativePostMessage({ action: action, payload: payload }, SELF.location.origin);
        } catch (e) {
            // 忽略
        }
    }

    // ============================================================
    // 工具
    // ============================================================

    /**
     * 找到页面上正在播放的 video 元素
     * @returns {HTMLVideoElement|null}
     */
    /**
     * 找到页面上正在播放的媒体元素
     * @returns {HTMLMediaElement|null}
     */
    function findMedia() {
        const all = Array.prototype.slice.call(document.querySelectorAll('video, audio'));
        if (all.length === 0) return null;

        const playing = all.filter((el) => !el.paused && el.currentTime > 0);
        if (playing.length > 0) {
            // 多个在播时挑画面最大的（音频元素没有尺寸，排到最后）
            return playing.sort(function (a, b) {
                const areaA = (a.videoWidth || 0) * (a.videoHeight || 0);
                const areaB = (b.videoWidth || 0) * (b.videoHeight || 0);
                return areaB - areaA;
            })[0];
        }

        const withDuration = all.filter((el) => el.duration > 0 && isFinite(el.duration));
        if (withDuration.length > 0) return withDuration[0];

        return all[0];
    }

    /**
     * 取媒体流的 captureStream
     * @param {HTMLMediaElement} el
     * @returns {MediaStream|null}
     */
    function captureStreamOf(el) {
        try {
            if (typeof el.captureStream === 'function') return el.captureStream();
            if (typeof el.mozCaptureStream === 'function') return el.mozCaptureStream();
            if (typeof el.webkitCaptureStream === 'function') return el.webkitCaptureStream();
        } catch (e) {
            return null;
        }
        return null;
    }

    /**
     * 挑一个浏览器支持的录制容器
     * @returns {string}
     */
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

    /**
     * 构造文件名
     * @param {number} index
     * @param {string} ext
     * @returns {string}
     */
    function buildFileName(index, ext) {
        const base = String(document.title || 'recording')
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .trim()
            .slice(0, 80) || 'recording';

        return base + t('rec.fileSuffix', null, '_录制') + (index > 1 ? '_' + index : '') + '.' + ext;
    }

    // ============================================================
    // 录制
    // ============================================================

    /** 开始录制 */
    function start() {
        if (recorder && recorder.state === 'recording') {
            return { ok: false, error: t('rec.already', null, '已在录制中') };
        }

        const media = findMedia();
        if (!media) {
            return { ok: false, error: t('rec.noElement', null, '页面上没有找到可录制的媒体元素') };
        }

        const stream = captureStreamOf(media);
        if (!stream) {
            return { ok: false, error: t('rec.noCaptureStream', null, '当前浏览器不支持 captureStream，无法录制') };
        }

        const mimeType = pickMimeType();
        if (!mimeType) {
            return { ok: false, error: t('rec.noRecorder', null, '当前浏览器不支持 MediaRecorder') };
        }

        try {
            recorder = new MediaRecorder(stream, {
                mimeType: mimeType,
                videoBitsPerSecond: 8 * 1000 * 1000
            });
        } catch (e) {
            return { ok: false, error: t('rec.createFail', null, '创建录制器失败：') + (e.message || e) };
        }

        recordedChunks = [];
        totalBytes = 0;
        segmentIndex = 0;
        startedAt = Date.now();

        recorder.addEventListener('dataavailable', function (event) {
            if (!event.data || event.data.size === 0) return;

            recordedChunks.push(event.data);
            totalBytes += event.data.size;

            // 到体积上限就立刻导出这一段，然后继续录下一段。
            if (totalBytes >= MAX_SEGMENT_BYTES) {
                exportChunks();
            }
        });

        // 停止时把最后一段也导出去
        recorder.addEventListener('stop', function () {
            exportChunks();
            stopProgressTimer();
        });

        recorder.addEventListener('error', function (event) {
            report('jt:recordError', {
                error: String((event.error && event.error.name) || 'unknown')
            });
            stopProgressTimer();
        });

        try {
            recorder.start(CHUNK_INTERVAL_MS);
        } catch (e) {
            return { ok: false, error: t('rec.startFail', null, '启动录制失败：') + (e.message || e) };
        }

        startProgressTimer();
        reportProgress();

        return {
            ok: true,
            mimeType: mimeType,
            width: media.videoWidth || 0,
            height: media.videoHeight || 0
        };
    }

    /** 停止录制 */
    function stop() {
        if (!recorder || recorder.state === 'inactive') {
            return { ok: false, error: t('rec.notRecording', null, '当前没有在录制') };
        }

        try {
            recorder.stop();
        } catch (e) {
            return { ok: false, error: e.message || String(e) };
        }

        return { ok: true };
    }

    /** 把录到的数据导出成文件 */
    function exportChunks() {
        if (recordedChunks.length === 0) {
            report('jt:recordDone', { size: 0, empty: true, href: SELF.location.href });
            return;
        }

        const mimeType = (recorder && recorder.mimeType) || 'video/webm';
        const ext = mimeType.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
        const blob = new Blob(recordedChunks, { type: mimeType });
        const size = blob.size;

        segmentIndex++;
        recordedChunks = [];
        totalBytes = 0;

        try {
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = buildFileName(segmentIndex, ext);
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();

            setTimeout(function () {
                if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
                URL.revokeObjectURL(url);
            }, 10000);
        } catch (e) {
            report('jt:recordError', { error: e.message || String(e) });
            return;
        }

        report('jt:recordDone', {
            size: size,
            part: segmentIndex,
            duration: Math.round((Date.now() - startedAt) / 1000),
            href: SELF.location.href
        });
    }

    function startProgressTimer() {
        stopProgressTimer();
        progressTimer = setInterval(reportProgress, 2000);
    }

    function stopProgressTimer() {
        if (progressTimer) {
            clearInterval(progressTimer);
            progressTimer = null;
        }
    }

    /** 上报当前进度 */
    function reportProgress() {
        report('jt:recordProgress', {
            recording: !!(recorder && recorder.state === 'recording'),
            bytes: totalBytes,
            duration: Math.round((Date.now() - startedAt) / 1000),
            href: SELF.location.href
        });
    }

    // ============================================================
    // 接收指令
    // ============================================================

    SELF.addEventListener('message', function (event) {
        const data = event && event.data;
        if (!data || typeof data !== 'object') return;

        let result = null;

        switch (data.action) {
            case 'jt:recordStart':
                result = start();
                break;

            case 'jt:recordStop':
                result = stop();
                break;

            default:
                return;
        }

        if (result) {
            // 带上动作名：start 与 stop 都会回这一条，
            // 界面要靠它区分该把按钮切成什么状态
            result.action = data.action === 'jt:recordStart' ? 'start' : 'stop';
            report('jt:recordResult', result);
        }
    }, false);
})();
