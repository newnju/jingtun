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
     * 取可读的错误文本
     * @param {*} error
     * @returns {string}
     */
    function errorMessage(error) {
        if (!error) return '未知错误';
        if (typeof error === 'string') return error;
        return error.message || String(error);
    }

    // ============================================================
    // 保存
    //
    // offscreen 文档只能用 chrome.runtime —— chrome.downloads 在这里是
    // undefined。所以这里只负责造 Blob 地址，落盘交给后台。
    // 顺带说一句：直接点隐藏 <a download> 也能触发下载，但没有用户手势，
    // 连续下几个文件之后浏览器会静默丢掉后面几个。
    // ============================================================

    /** 等后台确认接手的最长时间：后台 service worker 可能正在被唤醒 */
    const SAVE_HANDOFF_TIMEOUT = 25000;

    /**
     * 往后台发一条消息并等回复
     * @param {string} type
     * @param {Object} payload
     * @param {number} [timeout]
     * @returns {Promise<Object>}
     */
    function sendToBackground(type, payload, timeout) {
        const limit = timeout || SAVE_HANDOFF_TIMEOUT;

        return new Promise(function (resolve) {
            let settled = false;

            const finish = function (value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            };

            const timer = setTimeout(function () {
                finish({ ok: false, error: '后台没有响应' });
            }, limit);

            try {
                chrome.runtime.sendMessage({
                    target: 'background',
                    type: type,
                    payload: payload
                }, function (response) {
                    if (chrome.runtime.lastError) {
                        finish({ ok: false, error: chrome.runtime.lastError.message });
                        return;
                    }
                    finish(response || { ok: false, error: '后台没有响应' });
                });
            } catch (e) {
                finish({ ok: false, error: errorMessage(e) });
            }
        });
    }

    /**
     * 把合并好的数据存成文件
     * @param {Blob} blob
     * @param {string} fileName
     * @param {string} [directory] 下载子目录
     * @returns {Promise<{ok: boolean, via: string}>}
     */
    async function saveBlob(blob, fileName, directory) {
        const url = URL.createObjectURL(blob);

        // Blob 地址必须活到浏览器把数据读进下载队列；
        // 后台确认接手后就可以放心释放了
        const release = function () {
            setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        };

        const result = await sendToBackground('offscreen:saveFile', {
            url: url,
            fileName: fileName,
            directory: directory || ''
        });

        if (result && result.ok) {
            release();
            return { ok: true, via: 'downloads' };
        }

        console.warn('[鲸吞] 后台保存失败，改用页面下载:',
            (result && result.error) || '未知原因');

        // 兜底：后台没能接手时，仍然要把文件交出去
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.style.display = 'none';

        document.body.appendChild(anchor);
        anchor.click();

        setTimeout(function () {
            if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
        }, 1000);

        release();
        return { ok: true, via: 'anchor' };
    }

    // ============================================================
    // 直播
    // ============================================================

    /**
     * 取一份播放清单文本（带超时）
     * @param {string} url
     * @param {Object|null} headers
     * @param {number} timeout
     * @returns {Promise<string>}
     */
    async function fetchPlaylistText(url, headers, timeout) {
        const child = new AbortController();
        const limit = timeout > 0 ? timeout : 20000;
        const timer = setTimeout(() => child.abort(), limit);

        try {
            const response = await fetch(url, {
                signal: child.signal,
                credentials: 'include',
                cache: 'no-store',
                headers: headers || undefined
            });

            if (!response.ok) {
                throw new Error('清单请求失败 HTTP ' + response.status);
            }

            return await response.text();
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 直播下载：跟着清单滚动，边收边下
     * @param {Object} payload
     * @param {Object} parsed 首份清单的解析结果
     */
    async function runLiveDownload(payload, parsed) {
        const taskId = payload.taskId;
        const headers = payload.headers || null;
        const baseUrl = payload.baseUrl;
        const threads = Math.max(1, Math.min(Number(payload.threads) || 4, 32));

        const maxDuration = Math.max(0, Number(payload.maxDuration) || 0);
        const maxSegments = Math.max(0, Number(payload.maxSegments) || 0);
        const timeout = Number(payload.timeout) > 0 ? Number(payload.timeout) : 0;

        /** 已下载的分片，按到达顺序 */
        const parts = [];
        let totalBytes = 0;
        /** 当前正在下载的批次 */
        let current = null;
        /** 首份清单文本直接用，省一次往返 */
        let firstRound = true;

        const options = {
            threads: threads,
            headers: headers,
            keyFallback: payload.keyFallback || null
        };
        if (timeout > 0) options.timeout = timeout;

        const loader = new JTLive.LiveLoader({
            url: baseUrl,
            baseUrl: baseUrl,
            maxDuration: maxDuration,
            maxSegments: maxSegments,
            fetchPlaylist: function (url, ms) {
                if (firstRound) {
                    firstRound = false;
                    return Promise.resolve(payload.text || '');
                }
                return fetchPlaylistText(url, headers, ms);
            },
            onBatch: async function (batch) {
                const task = new JTDownloader.Downloader(batch, Object.assign({}, options, {
                    onProgress: function (p) {
                        report('offscreen:progress', {
                            taskId: taskId,
                            percent: p.percent,
                            completed: p.completed,
                            total: p.total,
                            bytes: p.bytes,
                            speed: p.speed,
                            failed: p.failed,
                            live: true
                        });
                    }
                }));

                current = task;

                try {
                    const result = await task.start();

                    if (result.aborted) {
                        loader.stop(result.abortReason || '已取消');
                        return;
                    }

                    for (const part of result.parts) {
                        parts.push(part);
                        totalBytes += part.size;
                    }

                    report('offscreen:progress', {
                        taskId: taskId,
                        percent: maxDuration > 0
                            ? Math.min(99, Math.round((loader.duration / maxDuration) * 100))
                            : 0,
                        completed: loader.count,
                        total: loader.count,
                        bytes: totalBytes,
                        speed: result.avgSpeed || 0,
                        failed: result.failed.length,
                        live: true,
                        duration: Math.round(loader.duration)
                    });
                } finally {
                    task.dispose();
                    if (current === task) current = null;
                }
            },
            onError: function (e) {
                console.warn('[鲸吞] 直播清单刷新失败:', errorMessage(e));
                report('offscreen:error', {
                    taskId: taskId,
                    error: '清单刷新失败：' + errorMessage(e),
                    partial: true
                });
            }
        });

        // 取消时既要停刷新，也要停正在跑的那一批
        tasks.set(taskId, {
            abort: function (reason) {
                loader.stop(reason || '已取消');
                if (current) current.abort(reason);
            }
        });

        try {
            const result = await loader.run();
            tasks.delete(taskId);

            // fMP4 直播流有初始化段，必须拼在最前面
            if (parsed.initSegment && parsed.initSegment.url) {
                const initTask = new JTDownloader.Downloader([{
                    index: 0,
                    url: parsed.initSegment.url,
                    duration: 0,
                    title: '',
                    byteRange: parsed.initSegment.byteRange,
                    key: parsed.segments[0] ? parsed.segments[0].key : null,
                    sequence: 0
                }], {
                    threads: 1,
                    headers: headers,
                    keyFallback: payload.keyFallback || null
                });

                try {
                    const initResult = await initTask.start();
                    if (initResult.parts.length > 0) {
                        parts.unshift(initResult.parts[0]);
                        totalBytes += initResult.parts[0].size;
                    }
                } finally {
                    initTask.dispose();
                }
            }

            if (parts.length === 0) {
                report('offscreen:error', {
                    taskId: taskId,
                    error: result.reason || '直播流没有取到任何数据',
                    aborted: loader.isStopped() && !result.ended
                });
                return;
            }

            const output = JTM3u8.suggestOutput(parsed);
            let blob = JTDownloader.Downloader.merge(parts, output.mime);
            let ext = output.ext;

            if (payload.convertToMp4 && ext === 'ts' && JTFfmpeg.isSupported()) {
                try {
                    const source = await blob.arrayBuffer();
                    const converted = await JTFfmpeg.remuxToMp4(source, 0);
                    blob = new Blob([converted], { type: 'video/mp4' });
                    ext = 'mp4';
                } catch (e) {
                    console.warn('[鲸吞] 直播流转封装失败，保留原始文件:', e.message);
                }
            }

            const baseName = JTUtils.sanitizeFileName(payload.fileName || 'live', 120);
            const fileName = baseName + '.' + ext;

            const saved = await saveBlob(blob, fileName, payload.directory);

            report('offscreen:done', {
                taskId: taskId,
                size: blob.size,
                fileName: fileName,
                parts: parts.length,
                failedCount: 0,
                elapsed: Math.round(loader.duration || 0),
                live: true,
                segments: result.count,
                gaps: result.gaps,
                reason: result.reason,
                via: saved.via
            });
        } catch (e) {
            tasks.delete(taskId);
            report('offscreen:error', { taskId: taskId, error: errorMessage(e) });
        }
    }

    // ============================================================
    // 下载任务
    // ============================================================

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

            // 直播清单没有 ENDLIST，直接下载只会拿到开头几分钟。
            // 交给 LiveLoader 跟着刷新，才能把整场流收下来。
            if (parsed.isLive && payload.live !== false && !parsed.iFramesOnly) {
                await runLiveDownload(payload, parsed);
                return;
            }

            if (parsed.iFramesOnly) {
                report('offscreen:error', {
                    taskId: taskId,
                    error: '这是只含 I 帧的播放列表（拖动进度条用的），没有完整画面'
                });
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
            const threads = Math.max(1, Math.min(Number(payload.threads) || 4, 32));

            const options = {
                threads: threads,
                headers: payload.headers || null,
                // Referer 必须走 fetch 的 referrer 选项，塞 headers 里会被静默丢掉
                referrer: payload.referrer || '',
                keyFallback: payload.keyFallback || null,
                // 限流感知：并发过高被拒时自动降并发 + 冷却
                throttleAware: payload.throttleAware !== false,
                throttleTrip: payload.throttleTrip || 2,
                // 磁盘断点续传：同一份清单重跑时跳过已经落盘的分片。
                // 用清单原文做指纹，换码率/换清单就是新任务，不会串台。
                resume: payload.resume !== false,
                resumeId: payload.resumeId || payload.baseUrl || '',
                resumeFingerprint: payload.resumeFingerprint || payload.text || '',
                onProgress: function (p) {
                    report('offscreen:progress', {
                        taskId: taskId,
                        percent: p.percent,
                        completed: p.completed,
                        total: p.total,
                        bytes: p.bytes,
                        speed: p.speed,
                        eta: p.eta,
                        concurrency: p.concurrency,
                        failed: p.failed
                    });
                }
            };

            // 调用方没给就不传，避免用 undefined 覆盖掉默认超时
            const timeout = Number(payload.timeout);
            if (timeout > 0) options.timeout = timeout;

            const task = new JTDownloader.Downloader(segments, options);

            tasks.set(taskId, task);

            const result = await task.start();
            tasks.delete(taskId);

            if (result.aborted) {
                report('offscreen:error', {
                    taskId: taskId,
                    error: result.abortReason || '已取消',
                    aborted: true
                });
                return;
            }
            if (result.parts.length === 0) {
                report('offscreen:error', { taskId: taskId, error: '没有取到任何数据' });
                return;
            }

            let blob = JTDownloader.Downloader.merge(result.parts, output.mime);
            let ext = output.ext;

            // 合并完就把分片交还给内存。
            // 几 GB 的 Blob 继续挂在下载器上没有任何意义。
            task.dispose();

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

            const saved = await saveBlob(blob, fileName, payload.directory);

            // 文件已经交出去，磁盘上的分片缓存就没用了，清掉避免占用空间。
            // 清失败也不影响用户拿到的文件。
            if (result.cacheJobId && typeof JTCache !== 'undefined' && JTCache.clearJob) {
                Promise.resolve(JTCache.clearJob(result.cacheJobId)).catch(function () {});
            }

            // 留着供「重试失败分片」使用：下载器里还有完整的 segments、
            // 已成功的 buffer 和失败清单，重试只要重跑失败的那几个
            lastTask = {
                downloader: task,
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
                failedCount: result.failed.length,
                elapsed: Math.round(result.elapsed || 0),
                cacheHits: result.cacheHits || 0,
                via: saved.via
            });
        } catch (e) {
            tasks.delete(taskId);
            report('offscreen:error', { taskId: taskId, error: errorMessage(e) });
        }
    }

    /**
     * 把一条流取成 Blob（用于合并音视频轨）
     *
     * 复用下载器的重试与超时逻辑：以前这里是一个裸 fetch，
     * 网络抖一下整条轨就没了，而且没有超时，卡住会一直挂着。
     * @param {Object} track { url, pageUrl, requestHeaders }
     * @param {Function} [onProgress]
     * @returns {Promise<Blob|null>}
     */
    async function fetchTrack(track, onProgress) {
        if (!track || !track.url) return null;

        const headers = {};
        const captured = track.requestHeaders || {};

        for (const key of Object.keys(captured)) {
            const v = captured[key];
            if (v !== undefined && v !== null && v !== '') headers[key] = String(v);
        }

        try {
            const task = new JTDownloader.Downloader([{
                index: 0,
                url: track.url,
                duration: 0,
                title: '',
                byteRange: null,
                key: null,
                sequence: 0
            }], {
                threads: 1,
                retries: 3,
                timeout: 60000,
                headers: headers,
                onProgress: function (p) {
                    if (onProgress) onProgress(p);
                }
            });

            const result = await task.start();
            task.dispose();

            if (result.aborted || !result.parts || result.parts.length === 0) {
                console.warn('[鲸吞] 取流失败：' + (result.abortReason ||
                    (result.failed[0] && errorMessage(result.failed[0].error)) || '没有数据'));
                return null;
            }

            return result.parts[0];
        } catch (e) {
            console.warn('[鲸吞] 取流异常：' + errorMessage(e));
            return null;
        }
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

            if (result.aborted) {
                return { ok: false, error: result.abortReason || '已取消' };
            }
            if (result.parts.length === 0) {
                return { ok: false, error: '重试后仍未取到数据' };
            }

            const blob = JTDownloader.Downloader.merge(result.parts, task.output.mime);
            const saved = await saveBlob(blob, task.fileName, task.directory);

            report('offscreen:done', {
                taskId: task.taskId,
                size: blob.size,
                fileName: task.fileName,
                parts: result.parts.length,
                failedCount: result.failed.length,
                retried: true,
                via: saved.via
            });

            return { ok: true, failedCount: result.failed.length };
        } catch (e) {
            return { ok: false, error: errorMessage(e) };
        }
    }

    // ============================================================
    // 合并音视频轨
    // ============================================================

    /** 最近一次取流的大小，失败时一并报出来，便于定位 */
    let lastSizes = '';

    /**
     * 合并音视频两条轨
     * @param {Object} payload { video, audio, fileName, directory, taskId }
     * @returns {Promise<Object>}
     */
    async function mergeTracks(payload) {
        if (!JTFfmpeg.isSupported()) {
            return { ok: false, error: '当前环境不支持本地转码' };
        }

        if (!payload || !payload.video || !payload.audio) {
            return { ok: false, error: '缺少音频或视频数据' };
        }

        try {
            const videoBuf = await fetchTrack(payload.video);
            const audioBuf = await fetchTrack(payload.audio);

            lastSizes = 'video=' + (videoBuf ? videoBuf.size + 'B' : 'null') +
                ' audio=' + (audioBuf ? audioBuf.size + 'B' : 'null');

            if (!videoBuf || !audioBuf) {
                return { ok: false, error: '有一条流没取到数据（' + lastSizes + '）' };
            }

            const merged = await JTFfmpeg.mergeTracks(
                await videoBuf.arrayBuffer(),
                await audioBuf.arrayBuffer(),
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

            await saveBlob(blob, fileName, payload.directory);

            return { ok: true, size: blob.size, fileName: fileName };
        } catch (e) {
            return { ok: false, error: errorMessage(e) + '  【' + lastSizes + '】' };
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
                const task = tasks.get(taskId);
                if (task) {
                    const reason = (message.payload && message.payload.reason) || '已取消';
                    task.abort(reason);
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