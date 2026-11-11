/**
 * 鲸吞 · ffmpeg 封装（本地执行）
 */
var JTFfmpeg = (function () {
    'use strict';

    /** Worker 实例，全局只建一个，避免重复加载较大的 wasm */
    let worker = null;
    /** 已加载完成 */
    let loaded = false;
    /** 请求 id 自增 */
    let nextId = 1;
    /** 未完成的请求：id -> {resolve, reject, onProgress} */
    const pending = new Map();

    /**
 * 环境是否支持
 * @returns {boolean}
 */
    function isSupported() {
        return typeof Worker !== 'undefined' &&
            typeof WebAssembly !== 'undefined' &&
            typeof chrome !== 'undefined' &&
            chrome.runtime && typeof chrome.runtime.getURL === 'function';
    }

    /** 创建 Worker 并挂上消息处理 */
    function ensureWorker() {
        if (worker) return worker;

        if (!isSupported()) {
            throw new Error('当前环境不支持 WebAssembly Worker');
        }

        const url = chrome.runtime.getURL('lib/ffmpeg/ffmpeg-worker.js');
        worker = new Worker(url, { type: 'module' });

        worker.addEventListener('message', function (event) {
            const msg = event.data;
            if (!msg) return;

            // 进度是广播，不属于某个请求
            if (msg.type === 'progress') {
                for (const entry of pending.values()) {
                    if (entry.onProgress) entry.onProgress(msg.percent, msg.time);
                }
                return;
            }

            if (msg.type === 'log') return;

            const entry = pending.get(msg.id);
            if (!entry) return;

            pending.delete(msg.id);

            if (msg.ok) {
                entry.resolve(msg);
            } else {
                // 失败时把 ffmpeg 的输出一起报出来。
                // 只说「返回码 1」等于没说 —— 用户和我们都不知道它在抱怨什么。
                const detail = (msg.logs && msg.logs.length)
                    ? '：' + msg.logs.slice(-3).join(' / ')
                    : '';

                entry.reject(new Error(
                    msg.error || ('ffmpeg 返回码 ' + msg.ret + detail)));
            }
        });

        worker.addEventListener('error', function (event) {
            // Worker 整体崩了，所有等待中的请求都要放掉，否则永远挂着
            const error = new Error('ffmpeg Worker 异常：' + (event.message || '未知'));
            for (const entry of pending.values()) entry.reject(error);
            pending.clear();

            worker = null;
            loaded = false;
        });

        return worker;
    }

    /**
 * 发一条指令给 Worker
 * @param {string} type
 * @param {Object} [payload]
 * @param {Function} [onProgress]
 * @returns {Promise<Object>}
 */
    function call(type, payload, onProgress) {
        return new Promise(function (resolve, reject) {
            const w = ensureWorker();
            const id = nextId++;

            pending.set(id, { resolve: resolve, reject: reject, onProgress: onProgress });
            w.postMessage({ id: id, type: type, payload: payload || {} });
        });
    }

    /** 加载 core（幂等） */
    async function load() {
        if (loaded) return;
        await call('load');
        loaded = true;
    }

    /** 是否已加载 */
    function isLoaded() {
        return loaded;
    }

    /**
 * 执行一条 ffmpeg 命令
 * @param {Array<string>} args 不含可执行文件名的参数
 * @param {number} [duration] 预期总时长（秒），用于计算进度
 * @param {Function} [onProgress]
 * @returns {Promise<number>} 返回码
 */
    async function exec(args, duration, onProgress) {
        await load();
        const res = await call('exec', { args: args, duration: duration || 0 }, onProgress);
        return res.ret;
    }

    /**
 * 转封装 TS → MP4
 * @param {ArrayBuffer|Uint8Array} input
 * @param {number} [duration] 秒
 * @param {Function} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
    async function remuxToMp4(input, duration, onProgress) {
        await load();

        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

        await call('write', { path: 'in.ts', data: bytes });
        await exec([
            '-hide_banner',
            '-i', 'in.ts',
            '-c', 'copy',
            '-bsf:a', 'aac_adtstoasc',
            '-movflags', '+faststart',
            'out.mp4'
        ], duration, onProgress);

        const result = await call('read', { path: 'out.mp4' });

        await call('delete', { path: 'in.ts' });
        await call('delete', { path: 'out.mp4' });

        return new Uint8Array(result.data);
    }

    /**
 * 合并音视频两条轨
 * @param {ArrayBuffer|Uint8Array} videoData
 * @param {ArrayBuffer|Uint8Array} audioData
 * @param {number} [duration]
 * @param {Function} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
    async function mergeTracks(videoData, audioData, duration, onProgress) {
        await load();

        const videoBytes = videoData instanceof Uint8Array ? videoData : new Uint8Array(videoData);
        const audioBytes = audioData instanceof Uint8Array ? audioData : new Uint8Array(audioData);

        await call('write', { path: 'v.mp4', data: videoBytes });
        await call('write', { path: 'a.mp4', data: audioBytes });

        await exec([
            '-hide_banner',
            '-i', 'v.mp4',
            '-i', 'a.mp4',
            '-c', 'copy',
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-movflags', '+faststart',
            'merged.mp4'
        ], duration, onProgress);

        const result = await call('read', { path: 'merged.mp4' });

        await call('delete', { path: 'v.mp4' });
        await call('delete', { path: 'a.mp4' });
        await call('delete', { path: 'merged.mp4' });

        return new Uint8Array(result.data);
    }

    /**
 * 从视频里抽出音轨
 * @param {ArrayBuffer|Uint8Array} input
 * @param {Function} [onProgress]
 * @returns {Promise<Uint8Array>} m4a
 */
    async function extractAudio(input, onProgress) {
        await load();

        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

        await call('write', { path: 'src.mp4', data: bytes });
        await exec([
            '-hide_banner',
            '-i', 'src.mp4',
            '-vn',
            '-c:a', 'copy',
            'audio.m4a'
        ], 0, onProgress);

        const result = await call('read', { path: 'audio.m4a' });

        await call('delete', { path: 'src.mp4' });
        await call('delete', { path: 'audio.m4a' });

        return new Uint8Array(result.data);
    }

    /**
 * 终止 Worker
 */
    function terminate() {
        if (worker) {
            worker.terminate();
            worker = null;
        }
        loaded = false;

        const error = new Error('任务已取消');
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
    }

    return {
        isSupported,
        isLoaded,
        load,
        exec,
        remuxToMp4,
        mergeTracks,
        extractAudio,
        terminate
    };
})();
