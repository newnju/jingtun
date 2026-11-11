/** 鲸吞：后台下载任务（运行在 offscreen document 中） */
(function () {
    'use strict';

    /** 正在跑的任务：taskId -> Downloader 实例（用于取消） */
    const tasks = new Map();

    /** 最近一次完成的下载任务 */
    let lastTask = null;

    /**
     * 回传消息给后台
     * @param {string} type
     * @param {Object} payload
     */
    function report(type, payload) {
        try {
            chrome.runtime.sendMessage({
                target: 'background',
                type: type,
                payload: payload
            }, function () {
                // 后台可能正在重启，此时无人接收，属正常情况
                if (chrome.runtime.lastError) { /* 忽略 */ }
            });
        } catch (e) {
            // 扩展上下文失效，忽略
        }
    }

    /**
     * 执行一次下载任务
     * @param {Object} payload
     */
    async function runDownload(payload) {
        const taskId = payload.taskId;

        if (!taskId) return;

        try {
            const parsed = JTM3u8.parse(payload.text, payload.baseUrl);

            if (!parsed.ok) {
                report('offscreen:error', { taskId: taskId, error: parsed.error || '清单解析失败' });
                return;
            }
            if (parsed.isMaster) {
                // 弹窗应该先让用户选码率，把媒体播放列表传进来
                report('offscreen:error', { taskId: taskId, error: '收到的是主播放列表，请先选定码率' });
                return;
            }
            if (parsed.segments.length === 0) {
                report('offscreen:error', { taskId: taskId, error: '清单里没有可下载的分片' });
                return;
            }

            // 组装下载列表。
            let segments = parsed.segments;
            if (parsed.initSegment && parsed.initSegment.url) {
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

            const output = JTM3u8.suggestOutput(parsed);
            const threads = Math.max(1, Math.min(Number(payload.threads) || 4, 16));

            const downloader = new JTDownloader.Downloader(segments, {
                threads: threads,
                headers: payload.headers || null,
                keyFallback: payload.keyFallback || null,
                onProgress: function (p) {
                    report('offscreen:progress', {
                        taskId: taskId,
                        percent: p.percent,
                        completed: p.completed,
                        total: p.total,
                        bytes: p.bytes,
                        speed: p.speed,
                        failed: p.failed
                    });
                }
            });

            tasks.set(taskId, downloader);

            const result = await downloader.start();
            tasks.delete(taskId);

            if (result.aborted) {
                report('offscreen:error', { taskId: taskId, error: '已取消', aborted: true });
                return;
            }
            if (result.parts.length === 0) {
                report('offscreen:error', { taskId: taskId, error: '没有取到任何数据' });
                return;
            }

            let blob = JTDownloader.Downloader.merge(result.parts, output.mime);
            let ext = output.ext;

            // 转封装：分片合并出来通常是 TS，兼容性差（很多播放器不认）。
            // 用本地 ffmpeg 换成 MP4，只换容器不重编码，速度取决于磁盘。
            if (payload.convertToMp4 && ext === 'ts' && JTFfmpeg.isSupported()) {
                try {
                    report('offscreen:progress', {
                        taskId: taskId, percent: 99, phase: 'converting'
                    });

                    const source = await blob.arrayBuffer();
                    const converted = await JTFfmpeg.remuxToMp4(source, 0);

                    blob = new Blob([converted], { type: 'video/mp4' });
                    ext = 'mp4';
                } catch (e) {
                    // 转封装失败就保留原始文件，不能因为锦上添花的功能
                    // 让用户连原始文件都拿不到
                    console.warn('[鲸吞] 转封装失败，保留原始文件:', e.message);
                }
            }

            const baseName = JTUtils.sanitizeFileName(payload.fileName || 'video', 120);
            const fileName = baseName + '.' + ext;

            await saveBlob(blob, fileName);

            // 留着供「重试失败分片」使用：下载器里还有完整的 segments、
            // 已成功的 buffer 和失败清单，重试只要重跑失败的那几个
            lastTask = {
                downloader: downloader,
                output: output,
                fileName: fileName,
                directory: payload.directory,
                taskId: taskId
            };

            report('offscreen:done', {
                taskId: taskId,
                size: blob.size,
                fileName: fileName,
                parts: result.parts.length,
                failedCount: result.failed.length
            });
        } catch (e) {
            tasks.delete(taskId);
            report('offscreen:error', { taskId: taskId, error: e.message || String(e) });
        }
    }

    /**
     * 把合并好的 Blob 存成文件
     * @param {Blob} blob
     * @param {string} fileName
     * @param {string} [directory] 下载子目录
     */
    /**
     * 把合并好的数据存成文件
     * @param {Blob} blob
     * @param {string} fileName
     */
    /**
     * 把一条流取成 ArrayBuffer
     * @param {Object} track { url, pageUrl, requestHeaders }
     * @returns {Promise<ArrayBuffer|null>}
     */
    async function fetchTrack(track) {
        if (!track || !track.url) return null;

        const headers = {};
        const captured = track.requestHeaders || {};
        const SKIP = new Set([
            'host', 'cookie', 'content-length', 'connection',
            'referer', 'origin',
            'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
            // range 要单独处理，见下面
            'range'
        ]);

        for (const key of Object.keys(captured)) {
            if (SKIP.has(String(key).toLowerCase())) continue;
            const v = captured[key];
            if (v !== undefined && v !== null && v !== '') headers[key] = String(v);
        }

        // 强制从头取整段。
        headers.Range = 'bytes=0-';

        try {
            const res = await fetch(track.url, {
                credentials: 'include',
                headers: headers,
                cache: 'no-cache'
            });

            if (!res.ok) {
                console.warn('[鲸吞] 取流失败 HTTP ' + res.status);
                return null;
            }

            return await res.arrayBuffer();
        } catch (e) {
            console.warn('[鲸吞] 取流异常：' + ((e && e.message) || e));
            return null;
        }
    }

    async function saveBlob(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');

        anchor.href = url;
        anchor.download = fileName;
        anchor.style.display = 'none';

        document.body.appendChild(anchor);
        anchor.click();

        // 交给浏览器下载管理器接管之后就可以清理了。
        // 留一分钟余量，避免下载还没真正开始就把地址撤掉。
        setTimeout(function () {
            if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
            URL.revokeObjectURL(url);
        }, 60000);
    }

    // ============================================================
    // 重试
    // ============================================================

    /**
     * 重试上一次任务的失败分片
     * @returns {Promise<Object>}
     */
    async function retryLastTask() {
        if (!lastTask) {
            return { ok: false, error: '没有可重试的任务' };
        }

        const task = lastTask;

        if (!task.downloader || task.downloader.failed.length === 0) {
            return { ok: false, error: '没有失败的分片需要重试' };
        }

        try {
            const result = await task.downloader.retryFailed();

            if (result.parts.length === 0) {
                return { ok: false, error: '重试后仍未取到数据' };
            }

            const blob = JTDownloader.Downloader.merge(result.parts, task.output.mime);
            await saveBlob(blob, task.fileName);

            report('offscreen:done', {
                taskId: task.taskId,
                size: blob.size,
                fileName: task.fileName,
                parts: result.parts.length,
                failedCount: result.failed.length,
                retried: true
            });

            return { ok: true, failedCount: result.failed.length };
        } catch (e) {
            return { ok: false, error: e.message || String(e) };
        }
    }

    /**
     * 合并音视频两条轨
     * @param {Object} payload { video, audio, fileName, directory, taskId }
     * @returns {Promise<Object>}
     */
    let lastSizes = '';

    async function mergeTracks(payload) {
        if (!JTFfmpeg.isSupported()) {
            return { ok: false, error: '当前环境不支持本地转码' };
        }

        if (!payload || !payload.video || !payload.audio) {
            return { ok: false, error: '缺少音频或视频数据' };
        }

        try {
            // 自己把两条流取下来。
            const videoBuf = await fetchTrack(payload.video);
            const audioBuf = await fetchTrack(payload.audio);

            const sizes = 'video=' + (videoBuf ? videoBuf.byteLength : 'null') +
                ' audio=' + (audioBuf ? audioBuf.byteLength : 'null');
            lastSizes = sizes;

            if (!videoBuf || !audioBuf) {
                return { ok: false, error: '有一条流没取到数据（' + sizes + '）' };
            }

            const merged = await JTFfmpeg.mergeTracks(
                videoBuf,
                audioBuf,
                0,
                function (percent) {
                    report('offscreen:progress', {
                        taskId: payload.taskId || 'merge',
                        percent: percent,
                        phase: 'merging'
                    });
                }
            );

            const blob = new Blob([merged], { type: 'video/mp4' });
            const fileName = JTUtils.sanitizeFileName(payload.fileName || 'merged', 120) + '.mp4';

            await saveBlob(blob, fileName);

            return { ok: true, size: blob.size, fileName: fileName };
        } catch (e) {
            return { ok: false, error: (e.message || String(e)) + '  【' + lastSizes + '】' };
        }
    }

    // ============================================================
    // 消息入口
    // ============================================================

    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
        // 只处理明确发给 offscreen 的消息，
        // 否则会把自己发出的回传消息再收一遍
        if (!message || message.target !== 'offscreen') return;

        switch (message.type) {
            case 'offscreen:download':
                runDownload(message.payload || {});
                sendResponse({ ok: true });
                return true;

            case 'offscreen:abort': {
                const taskId = message.payload && message.payload.taskId;
                const downloader = tasks.get(taskId);
                if (downloader) {
                    downloader.abort();
                    tasks.delete(taskId);
                }
                sendResponse({ ok: true });
                return true;
            }

            case 'offscreen:retryFailed':
                retryLastTask().then(sendResponse);
                return true;

            case 'offscreen:mergeTracks':
                mergeTracks(message.payload).then(sendResponse);
                return true;

            case 'offscreen:checkFfmpeg':
                sendResponse({ ok: true, supported: JTFfmpeg.isSupported() });
                return true;

            default:
                return false;
        }
    });
})();
