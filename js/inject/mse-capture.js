/** 鲸吞：流媒体捕获脚本（注入至页面 MAIN world） */
(function __JINGTUN_MSE_CAPTURE__() {
    'use strict';

    const SELF = typeof self !== 'undefined' ? self : this;

    if (SELF.__JINGTUN_MSE_CAPTURE__) return;
    SELF.__JINGTUN_MSE_CAPTURE__ = true;

    // ============================================================
    // 配置与状态
    // ============================================================

    /** 内存上限（字节）。超过后自动落盘并清空缓冲区。 */
    let memoryLimit = 256 * 1024 * 1024;   // 默认 256MB

    /** 合并的体积上限（字节） */
    const MERGE_SIZE_LIMIT = 400 * 1024 * 1024;

    /** 捕获开关 */
    let enabled = true;

    /** 捕获后自动合并音视频 */
    let autoMerge = false;

    /** 捕获的缓冲区列表。 */
    const captures = [];   // { mimeType, chunks: ArrayBuffer[], size: number }

    /** 累计字节数 */
    let totalSize = 0;

    /** 是否已经上报过"捕获完成" */
    let completedReported = false;

    /** 文件序号（分段落盘时递增） */
    let partIndex = 0;

    // ============================================================
    // 上报
    // ============================================================

    /**
     * 上报状态到内容脚本
     * @param {string} action
     * @param {Object} payload
     */
    /** 原生的 postMessage */
    const nativePostMessage = (typeof SELF.postMessage === 'function')
        ? SELF.postMessage.bind(SELF)
        : null;

    function report(action, payload) {
        try {
            nativePostMessage({ action: action, payload: payload }, SELF.location.origin);
        } catch (e) {
            // 忽略
        }
    }

    /** 取一条文案 */
    function t(key, params, fallback) {
        const dict = SELF.__JINGTUN_I18N__;
        if (dict && typeof dict.get === 'function') return dict.get(key, params);
        return fallback || key;
    }

    /** 上报当前捕获进度 */
    function reportProgress() {
        // 同时刷新面板，进度上报本来就是定期触发的，
        // 不必再开一个定时器
        updatePanel();

        report('jt:captureChunk', {
            totalSize: totalSize,
            buffers: captures.length,
            chunks: captures.reduce((sum, c) => sum + c.chunks.length, 0),
            limit: memoryLimit,
            href: SELF.location.href
        });
    }

    // ============================================================
    // 工具
    // ============================================================

    /**
     * 根据 MIME 推断文件扩展名
     * @param {string} mimeType
     * @returns {string}
     */
    function extFromMime(mimeType) {
        if (!mimeType) return 'bin';
        const mime = mimeType.toLowerCase();

        if (mime.includes('webm')) {
            return mime.startsWith('audio') ? 'weba' : 'webm';
        }
        if (mime.includes('mp4')) {
            return mime.startsWith('audio') ? 'm4a' : 'mp4';
        }
        if (mime.includes('mp2t')) return 'ts';
        if (mime.includes('mpeg')) return 'mp3';
        if (mime.includes('ogg')) return 'ogg';
        if (mime.includes('aac')) return 'aac';
        return 'bin';
    }

    /**
     * 判断一段数据是不是容器初始化段
     * @param {ArrayBuffer} data
     * @returns {boolean}
     */
    function looksLikeInitSegment(data) {
        if (!data || data.byteLength < 8) return false;

        const view = new Uint8Array(data);

        if (view.length > 8 &&
            view[4] === 0x66 && view[5] === 0x74 &&
            view[6] === 0x79 && view[7] === 0x70) {
            return true;
        }

        if (view.length > 4 &&
            view[0] === 0x1A && view[1] === 0x45 &&
            view[2] === 0xDF && view[3] === 0xA3) {
            return true;
        }

        return false;
    }

    /**
     * 按实际容器签名推断扩展名
     * @param {ArrayBuffer} firstChunk
     * @param {string} mimeType
     * @returns {string}
     */
    function detectExt(firstChunk, mimeType) {
        const isAudio = !!(mimeType && mimeType.indexOf('audio') === 0);

        if (firstChunk && firstChunk.byteLength >= 8) {
            const view = new Uint8Array(firstChunk);

            // fMP4
            if (view[4] === 0x66 && view[5] === 0x74 &&
                view[6] === 0x79 && view[7] === 0x70) {
                return isAudio ? 'm4a' : 'mp4';
            }

            // WebM
            if (view.length > 4 &&
                view[0] === 0x1A && view[1] === 0x45 &&
                view[2] === 0xDF && view[3] === 0xA3) {
                return isAudio ? 'weba' : 'webm';
            }

            // TS 同步字节
            if (view[0] === 0x47) return 'ts';
        }

        return extFromMime(mimeType);
    }

    /**
     * 生成文件名
     * @param {number} index
     * @param {string} ext
     * @returns {string}
     */
    function buildFileName(index, ext) {
        let title = 'capture';
        try {
            title = document.title || SELF.location.hostname || 'capture';
        } catch (e) { /* 忽略 */ }

        // 清理非法字符
        title = String(title)
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120) || 'capture';

        const suffix = index > 0 ? `_part${index + 1}` : '';
        return `${title}${suffix}.${ext}`;
    }

    /**
     * 触发浏览器下载
     * @param {Blob} blob
     * @param {string} fileName
     */
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
            // 延迟释放，确保下载已开始
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            return true;
        } catch (e) {
            return false;
        }
    }

    // ============================================================
    // 数据落盘
    // ============================================================

    /**
     * 清理重复的容器头部
     * @param {Array<ArrayBuffer>} chunks
     * @returns {{chunks: Array<ArrayBuffer>, removed: number, kind: string}}
     */
    function stripDuplicateHeaders(chunks) {
        if (!chunks || chunks.length <= 1) {
            return { chunks: chunks || [], removed: 0, kind: '' };
        }

        let lastHeaderIndex = -1;
        let kind = '';

        for (let i = 0; i < chunks.length; i++) {
            if (!chunks[i]) continue;
            const view = new Uint8Array(chunks[i]);

            // MP4 / fMP4：第 4~7 字节是 'ftyp'
            if (view.length > 8 &&
                view[4] === 0x66 && view[5] === 0x74 &&
                view[6] === 0x79 && view[7] === 0x70) {
                lastHeaderIndex = i;
                kind = 'mp4';
                continue;
            }

            // WebM / Matroska：EBML 魔数 1A 45 DF A3
            if (view.length > 4 &&
                view[0] === 0x1A && view[1] === 0x45 &&
                view[2] === 0xDF && view[3] === 0xA3) {
                lastHeaderIndex = i;
                kind = 'webm';
            }
        }

        // -1 没找到头部；0 表示头部就在第一块，都无需处理
        if (lastHeaderIndex <= 0) {
            return { chunks: chunks, removed: 0, kind: kind };
        }

        return {
            chunks: chunks.slice(lastHeaderIndex),
            removed: lastHeaderIndex,
            kind: kind
        };
    }

    /**
     * 把当前捕获的数据合并并下载
     * @param {boolean} [keepBuffer] 是否保留缓冲区（分段落盘时保留）
     * @returns {boolean} 是否成功产出文件
     */
    function flushToFile(keepBuffer) {
        const usable = captures.filter((c) => c.chunks.length > 0);
        if (usable.length === 0) return false;

        let success = false;
        let totalRemoved = 0;
        let missingHeader = 0;
        /** 本次导出的总字节数 */
        let exportedSize = 0;
        /** 本次构建出的轨道，先全部攒着，决定怎么落地 */
        const built = [];

        for (const capture of usable) {
            try {
                const mimeType = capture.mimeType || 'video/mp4';
                const cleaned = stripDuplicateHeaders(capture.chunks);

                if (cleaned.removed > 0) {
                    totalRemoved += cleaned.removed;
                    console.warn(
                        `[鲸吞] ${capture.mimeType}：检测到 ${cleaned.removed + 1} 个容器头部，` +
                        `已丢弃前 ${cleaned.removed} 块以保证可播放`
                    );
                }

                let chunks = cleaned.chunks;

                // 清理后仍然没有容器头，说明捕获是从播放中途开始的。
                // 把之前记下的初始化段补到最前面，没有它，文件双击打不开。
                if (!looksLikeInitSegment(chunks[0]) && capture.initSegment) {
                    chunks = [capture.initSegment].concat(chunks);
                    console.warn('[鲸吞] 补回初始化段，否则文件无法播放');
                }

                // 补完还是没有头，那数据本身就不完整。照常导出（用户可能想
                // 用别的工具抢救），但要明确告诉他，别让他对着打不开的文件发愣。
                if (!looksLikeInitSegment(chunks[0])) {
                    missingHeader++;
                    console.warn(
                        '[鲸吞] 捕获的数据缺少容器头，导出的文件可能无法直接播放。' +
                        '建议在页面里从头开始播放后重新捕获。'
                    );
                }

                // 扩展名按实际容器签名定，而不是按 MIME，
                // 扩展名错了系统就不知道用什么打开
                const ext = detectExt(chunks[0], mimeType);
                const blob = new Blob(chunks, { type: mimeType });
                const fileName = buildFileName(partIndex, ext);

                // 先只构建，不急着下载，要不要合并得等所有轨都就绪才知道
                built.push({
                    blob: blob,
                    fileName: fileName,
                    mime: mimeType,
                    type: mimeType.indexOf('audio') === 0 ? 'audio' : 'video',
                    size: blob.size,
                    playable: looksLikeInitSegment(chunks[0])
                });
            } catch (e) {
                console.error('[鲸吞] 合并数据失败:', e);
            }
        }

        if (built.length === 0) return false;

        // 音视频来自两个独立的 SourceBuffer，只能分别导出。
        // 用户拿到的是「有画无声 + 有声无画」两个文件。
        const hasVideo = built.some((b) => b.type === 'video');
        const hasAudio = built.some((b) => b.type === 'audio');

        // ---------- 合并路径 ----------
        //
        // 开了自动合并就交给本地 ffmpeg 合成一个文件，不再分头下载。
        // 这条路径要经消息把数据传给 offscreen，所以只适合中等体积；
        // 超大文件还是分别下载更稳。
        if (hasVideo && hasAudio && autoMerge) {
            const video = built.find((b) => b.type === 'video');
            const audio = built.find((b) => b.type === 'audio');

            if (video && audio && (video.size + audio.size) <= MERGE_SIZE_LIMIT) {
                report('jt:mergeRequest', {
                    // Blob 能被结构化克隆，跨消息传递没问题
                    videoBlob: video.blob,
                    audioBlob: audio.blob,
                    part: partIndex,
                    href: SELF.location.href
                });

                partIndex++;
                if (!keepBuffer) clearBuffers();
                return true;
            }

            // 数据要经消息传给 offscreen，体积太大传不过去。
            if (video && audio) {
                console.warn(
                    '[鲸吞] 数据超过 ' + (MERGE_SIZE_LIMIT / 1048576) + 'MB，' +
                    '跳过合并，分别导出音视频'
                );
            }
        }

        // ---------- 分别下载 ----------
        for (const b of built) {
            if (triggerDownload(b.blob, b.fileName)) {
                success = true;
                exportedSize += b.size;
            }
        }

        if (success) {
            partIndex++;
            if (!keepBuffer) {
                clearBuffers();
            }

            report('jt:captureDone', {
                // 上报刚导出的实际大小，不是清理后的剩余缓冲
                size: exportedSize,
                part: partIndex,
                href: SELF.location.href,
                // 让界面能提示"丢掉了多少"，而不是默默少一段
                removedChunks: totalRemoved,
                // 有文件缺容器头：界面要明确告知，否则用户对着打不开的文件发愣
                missingHeader: missingHeader,
                tracks: built.map(function (b) {
                    return {
                        fileName: b.fileName,
                        mime: b.mime,
                        type: b.type,
                        size: b.size,
                        playable: b.playable
                    };
                }),
                needsMerge: hasVideo && hasAudio
            });
        }

        return success;
    }

    /** 捕获刚开启时检查有没有错过初始化段 */
    /** 检查有没有错过初始化段 */
    /** 是否移除页面 iframe 的 sandbox 限制 */
    let removeSandbox = false;

    /** 移除 iframe 的 sandbox 限制 */
    function stripIframeSandbox() {
        if (!removeSandbox) return;

        function process(iframe) {
            if (!iframe || !iframe.hasAttribute || !iframe.hasAttribute('sandbox')) return;

            try {
                const cloned = iframe.cloneNode(true);
                cloned.removeAttribute('sandbox');

                if (iframe.parentNode) {
                    iframe.parentNode.replaceChild(cloned, iframe);
                }
            } catch (e) {
                // 个别站点会拦截 replaceChild，跳过这个 iframe
            }
        }

        try {
            const frames = document.querySelectorAll('iframe');
            for (let i = 0; i < frames.length; i++) process(frames[i]);
        } catch (e) {
            // 忽略
        }

        // 后续动态插入的 iframe 也要处理
        try {
            if (!sandboxObserver && typeof MutationObserver !== 'undefined') {
                sandboxObserver = new MutationObserver(function (mutations) {
                    for (const mutation of mutations) {
                        for (const node of mutation.addedNodes) {
                            if (!node || node.nodeType !== 1) continue;

                            if (node.nodeName === 'IFRAME') {
                                process(node);
                            } else if (node.querySelectorAll) {
                                const inner = node.querySelectorAll('iframe');
                                for (let i = 0; i < inner.length; i++) process(inner[i]);
                            }
                        }
                    }
                });

                sandboxObserver.observe(
                    document.body || document.documentElement,
                    { childList: true, subtree: true }
                );
            }
        } catch (e) {
            // 忽略
        }
    }

    /** @type {MutationObserver|null} */
    let sandboxObserver = null;

    /** 自动跳缓冲尾 */
    let autoToBuffered = false;

    /** 流结束后自动导出（长视频不用守着） */
    let autoDownloadOnComplete = false;
    /** @type {WeakSet<HTMLVideoElement>} 已经挂过监听的 video */
    const bufferedBound = new WeakSet();

    function bindAutoToBuffered() {
        if (!autoToBuffered) return;

        let videos;
        try {
            videos = document.querySelectorAll('video');
        } catch (e) {
            return;
        }

        for (const video of videos) {
            if (bufferedBound.has(video)) continue;
            bufferedBound.add(video);

            video.addEventListener('progress', function () {
                // 只在捕获期间动手，否则会干扰用户正常观看
                if (!autoToBuffered || !enabled) return;

                try {
                    if (!video.buffered || video.buffered.length === 0) return;

                    const bufferedEnd = video.buffered.end(0);
                    const duration = video.duration;

                    // duration 可能是 Infinity（直播），这种情况不跳
                    if (!isFinite(duration) || bufferedEnd >= duration) return;

                    video.currentTime = Math.max(0, bufferedEnd - 5);
                } catch (e) {
                    // 有些站点的 video 是只读代理，忽略
                }
            });
        }
    }

    let headerWarned = false;

    function warnIfHeaderMissed() {
        setTimeout(function () {
            if (!enabled || headerWarned) return;

            for (const capture of captures) {
                // 已经有数据，却始终没见过初始化段，基本可以确定错过了
                if (capture.chunks.length > 0 && !capture.initSegment) {
                    headerWarned = true;

                    report('jt:captureWarning', {
                        reason: 'missingInitSegment',
                        message: '捕获到的数据缺少视频头信息，导出的文件可能无法播放。' +
                            '建议刷新页面，从头开始播放后再捕获。',
                        href: SELF.location.href
                    });
                    return;
                }
            }
        }, 4000);
    }

    /** 清空缓冲区 */
    function clearBuffers() {
        for (const capture of captures) {
            if (capture.chunks.length > 1) {
                const head = capture.chunks[0];
                capture.chunks = [head];
                capture.size = head ? head.byteLength : 0;
            } else {
                capture.size = capture.chunks.reduce((sum, c) => sum + c.byteLength, 0);
            }
        }
        totalSize = captures.reduce((sum, c) => sum + c.size, 0);
    }

    /** 检查内存占用，超限则自动落盘 */
    function checkMemory() {
        if (totalSize >= memoryLimit) {
            console.warn(
                `[鲸吞] 捕获数据达到内存上限 ${(memoryLimit / 1024 / 1024).toFixed(0)}MB，自动落盘并清空`
            );
            flushToFile(false);
            reportProgress();
        }
    }

    // ============================================================
    // 核心：代理 MediaSource
    // ============================================================

    /** 代理 MediaSource 的两个关键方法。 */
    function patchMediaSource() {
        if (typeof MediaSource === 'undefined') return false;

        const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
        if (typeof originalAddSourceBuffer !== 'function') return false;

        /** SourceBuffer 实例 → 对应的捕获记录 */
        const captureByBuffer = new WeakMap();

        /**
         * 取得（必要时补建）某个 SourceBuffer 的捕获记录
         * @param {SourceBuffer} sourceBuffer
         * @param {string} [mimeType]
         * @returns {Object}
         */
        function ensureCapture(sourceBuffer, mimeType) {
            let capture = captureByBuffer.get(sourceBuffer);

            if (capture) {
                // 后到的 mimeType 可以补上（先建的可能没带）
                if (mimeType && !capture.mimeType) capture.mimeType = mimeType;
                return capture;
            }

            capture = {
                mimeType: mimeType || '',
                chunks: [],
                size: 0,
                /** 初始化段（ftyp+moov 或 EBML 头） */
                initSegment: null
            };

            captureByBuffer.set(sourceBuffer, capture);
            captures.push(capture);
            return capture;
        }

        // ---------- 第一层：从 addSourceBuffer 取到 mimeType ----------
        MediaSource.prototype.addSourceBuffer = new Proxy(originalAddSourceBuffer, {
            apply(target, thisArg, args) {
                let sourceBuffer;
                try {
                    sourceBuffer = Reflect.apply(target, thisArg, args);
                } catch (e) {
                    // 创建失败必须原样抛出，否则页面行为会被改变
                    throw e;
                }

                try {
                    ensureCapture(sourceBuffer, args && args[0] ? String(args[0]) : '');
                } catch (e) {
                    // 捕获逻辑出错绝不能影响播放
                }

                return sourceBuffer;
            }
        });

        // ---------- 第二层：hook 原型上的 appendBuffer ----------
        //
        // 挂在原型而不是实例上，这样对「脚本注入之前就已创建的
        // SourceBuffer」同样生效。挂在实例上会漏掉那一批，
        // 导致点了捕获却什么都抓不到。
        if (typeof SourceBuffer !== 'undefined' && SourceBuffer.prototype.appendBuffer) {
            const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;

            SourceBuffer.prototype.appendBuffer = new Proxy(originalAppendBuffer, {
                apply(appendTarget, appendThisArg, appendArgs) {
                    // 先执行原始逻辑，确保播放不受影响
                    const result = Reflect.apply(appendTarget, appendThisArg, appendArgs);

                    try {
                        const data = appendArgs && appendArgs[0];

                        if (data && data.byteLength > 0) {
                            const capture = ensureCapture(appendThisArg, '');

                            // 初始化段始终记录，不受捕获开关影响。
                            if (!capture.initSegment && looksLikeInitSegment(data)) {
                                capture.initSegment = data;
                            }

                            // 媒体段只在捕获开启时累积
                            if (enabled) {
                                capture.chunks.push(data);
                                capture.size += data.byteLength;
                                totalSize += data.byteLength;
                                checkMemory();
                            }
                        }
                    } catch (e) {
                        // 抄录失败绝不能影响播放
                    }

                    return result;
                }
            });
        }

        // ---------- 辅助：监听流结束，用于判断"捕获完成" ----------
        const originalEndOfStream = MediaSource.prototype.endOfStream;
        if (typeof originalEndOfStream === 'function') {
            MediaSource.prototype.endOfStream = new Proxy(originalEndOfStream, {
                apply(target, thisArg, args) {
                    const result = Reflect.apply(target, thisArg, args);

                    try {
                        if (enabled && !completedReported) {
                            completedReported = true;
                            report('jt:captureDone', {
                                size: totalSize,
                                complete: true,
                                href: SELF.location.href
                            });

                            // 流结束了就自动导出。
                            if (autoDownloadOnComplete) {
                                setTimeout(function () {
                                    try {
                                        flushToFile(false);
                                    } catch (e) {
                                        console.warn('[鲸吞] 自动导出失败:', e);
                                    }
                                }, 500);
                            }
                        }
                    } catch (e) { /* 忽略 */ }

                    return result;
                }
            });
        }

        return true;
    }

    const patched = patchMediaSource();

    // ============================================================
    // 接收指令
    // ============================================================

    SELF.addEventListener('message', function (event) {
        const data = event && event.data;
        if (!data || typeof data !== 'object') return;

        switch (data.action) {
            case 'jt:stop':
                enabled = false;
                // 刻意不清空缓冲：停止只是不再录新的，
                reportProgress();
                break;

            case 'jt:start':
                enabled = true;
                completedReported = false;
                // 面板在这里建：捕获一开用户就需要看到状态，
                // 弹窗关了也不至于两眼一抹黑
                buildPanel();
                bindAutoToBuffered();
                reportProgress();
                warnIfHeaderMissed();
                break;

            case 'jt:stop':
                enabled = false;
                destroyPanel();
                break;

            case 'jt:setAutoDownOnComplete':
                autoDownloadOnComplete = !!(data.payload && data.payload.enabled);
                break;

            case 'jt:setAutoToBuffered':
                autoToBuffered = !!(data.payload && data.payload.enabled);
                if (autoToBuffered) bindAutoToBuffered();
                break;

            case 'jt:setSandboxRemoval':
                removeSandbox = !!(data.payload && data.payload.enabled);
                if (removeSandbox) stripIframeSandbox();
                break;

            case 'jt:setAutoMerge':
                autoMerge = !!(data.payload && data.payload.enabled);
                break;

            case 'jt:downloadCapture':
                flushToFile(false);
                break;

            case 'jt:setCaptureLimit': {
                const mb = Number(data.payload && data.payload.mb);
                if (!isNaN(mb) && mb > 0) {
                    memoryLimit = mb * 1024 * 1024;
                    reportProgress();
                }
                break;
            }

            default:
                break;
        }
    }, false);

    // ============================================================
    // 页面内的浮动面板
    //
    // 弹窗一关，用户就两眼一抹黑，不知道捕获有没有在工作、
    // 攒了多少、什么时候该导出。这个小面板就是为此存在的。
    // ============================================================

    /** @type {HTMLElement|null} 面板宿主 */
    let panelHost = null;
    /** @type {ShadowRoot|null} */
    let panelRoot = null;
    /** 面板是否被用户收起 */
    let panelCollapsed = false;

    /**
     * 安全地创建 Shadow DOM
     * @param {HTMLElement} element
     * @param {string} [mode]
     * @returns {ShadowRoot|HTMLElement} 失败时返回元素本身，当普通容器用
     */
    function createSecureShadowRoot(element, mode) {
        mode = mode || 'closed';

        // 先看主文档上的方法是不是原生的
        let attach = null;

        try {
            const fn = Element.prototype.attachShadow;
            if (fn && fn.toString().indexOf('[native code]') !== -1) {
                attach = fn.bind(element);
            }
        } catch (e) {
            // 取不到就往下走 iframe 方案
        }

        // 被劫持（或取不到）：从未被修改的 iframe 里捞一个原生方法
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
                // iframe 也拿不到（可能被 CSP 限制），继续降级
            }
        }

        if (attach) {
            try {
                return attach({ mode: mode });
            } catch (e) {
                // 落到降级分支
            }
        }

        // 最后的退路：返回元素本身当普通容器。
        // 样式可能被页面影响，但功能还在，总比整个面板建不出来强。
        return element;
    }

    /** 建浮动面板 */
    function buildPanel() {
        if (panelHost || !document.body) return;

        const host = document.createElement('div');
        host.style.cssText =
            'position:fixed;right:16px;bottom:16px;z-index:2147483646;' +
            'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;';

        // closed 模式：页面拿不到内部结构，不会误改。
        panelRoot = createSecureShadowRoot(host, 'closed');

        const style = document.createElement('style');
        style.textContent = [
            '.p{background:#1c1c1ee6;color:#e8e8ea;border-radius:10px;',
            'box-shadow:0 6px 24px rgba(0,0,0,.35);overflow:hidden;',
            'min-width:190px;backdrop-filter:blur(6px)}',
            '.h{display:flex;align-items:center;gap:6px;padding:7px 10px;',
            'cursor:move;background:#00000040;user-select:none}',
            '.dot{width:8px;height:8px;border-radius:50%;background:#e05a4f;flex:0 0 auto}',
            '.dot.on{background:#4ec97e}',
            '.t{font-size:12px;font-weight:600;flex:1 1 auto}',
            '.x{background:none;border:none;color:#9a9aa0;font-size:15px;',
            'cursor:pointer;padding:0 2px;line-height:1}',
            '.x:hover{color:#e8e8ea}',
            '.b{padding:8px 10px;display:flex;flex-direction:column;gap:7px}',
            '.info{font-size:11px;color:#a8a8ae;font-variant-numeric:tabular-nums}',
            '.row{display:flex;gap:6px}',
            '.btn{flex:1 1 auto;padding:5px 8px;border:1px solid #4a4a50;',
            'border-radius:5px;background:#2f2f34;color:#e8e8ea;font-size:12px;cursor:pointer}',
            '.btn:hover{background:#3a3a40;border-color:#5a5a60}',
            '.btn.pri{background:#2f7cf6;border-color:#2f7cf6;color:#fff}',
            '.btn.pri:hover{background:#4a8ef7}',
            '.btn:disabled{opacity:.5;cursor:default}',
            '.hide{display:none}'
        ].join('');

        panelRoot.appendChild(style);

        const box = document.createElement('div');
        box.className = 'p';

        // --- 标题栏（可拖动）---
        const head = document.createElement('div');
        head.className = 'h';

        const dot = document.createElement('span');
        dot.className = 'dot on';

        const title = document.createElement('span');
        title.className = 't';
        title.textContent = t('panel.title', null, '鲸吞：捕获中');

        const toggle = document.createElement('button');
        toggle.className = 'x';
        toggle.textContent = '－';
        toggle.title = t('panel.collapse', null, '收起 / 展开');

        const close = document.createElement('button');
        close.className = 'x';
        close.textContent = '×';
        close.title = t('panel.close', null, '停止并关闭');

        head.append(dot, title, toggle, close);

        // --- 主体 ---
        const body = document.createElement('div');
        body.className = 'b';

        const info = document.createElement('div');
        info.className = 'info';
        info.textContent = t('panel.waiting', null, '等待数据…');

        const row = document.createElement('div');
        row.className = 'row';

        const btnSave = document.createElement('button');
        btnSave.className = 'btn pri';
        btnSave.textContent = t('panel.export', null, '导出');

        const btnClear = document.createElement('button');
        btnClear.className = 'btn';
        btnClear.textContent = t('panel.clear', null, '清空');

        row.append(btnSave, btnClear);
        body.append(info, row);

        box.append(head, body);
        panelRoot.appendChild(box);

        document.body.appendChild(host);
        panelHost = host;

        // --- 交互 ---
        toggle.addEventListener('click', function () {
            panelCollapsed = !panelCollapsed;
            body.classList.toggle('hide', panelCollapsed);
            toggle.textContent = panelCollapsed ? '＋' : '－';
        });

        close.addEventListener('click', function () {
            enabled = false;
            destroyPanel();
            report('jt:captureWarning', {
                reason: 'closedByPanel',
                message: t('panel.stopped', null, '已停止捕获'),
                href: SELF.location.href
            });
        });

        btnSave.addEventListener('click', function () {
            const ok = flushToFile(false);
            setStatus(ok ? t('panel.exported', null, '已导出') : t('panel.nothingToExport', null, '没有可导出的数据'));
        });

        btnClear.addEventListener('click', function () {
            clearBuffers();
            setStatus(t('panel.cleared', null, '已清空缓冲'));
        });

        // 拖动：按住标题栏移动
        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        head.addEventListener('mousedown', function (e) {
            dragging = true;
            offsetX = e.clientX - host.getBoundingClientRect().left;
            offsetY = e.clientY - host.getBoundingClientRect().top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            host.style.left = (e.clientX - offsetX) + 'px';
            host.style.top = (e.clientY - offsetY) + 'px';
            host.style.right = 'auto';
            host.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', function () {
            dragging = false;
        });
    }

    /** 更新面板上的信息 */
    function updatePanel() {
        if (!panelRoot) return;

        const box = panelRoot.querySelector('.p');
        if (!box) return;

        const info = box.querySelector('.info');
        const dot = box.querySelector('.dot');
        if (!info) return;

        const kb = totalSize / 1024;
        const sizeText = kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb.toFixed(0) + ' KB';

        info.textContent = totalSize > 0
            ? t('panel.captured',
                { size: sizeText, part: partIndex + 1 },
                '已捕获 ' + sizeText + ' · 第 ' + (partIndex + 1) + ' 段')
            : t('panel.waiting', null, '等待数据…');

        if (dot) dot.classList.toggle('on', enabled);
    }

    function destroyPanel() {
        if (panelHost && panelHost.parentNode) panelHost.parentNode.removeChild(panelHost);
        panelHost = null;
        panelRoot = null;
    }

    // 启动时上报一次，让后台知道捕获脚本已就位
    reportProgress();

    // 同时检查一次：如果脚本注入时页面已经在播放，
    // 初始化段多半已经错过，早点告诉用户，别等下载完才发现打不开
    warnIfHeaderMissed();
})();
