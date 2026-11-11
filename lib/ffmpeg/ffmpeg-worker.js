/**
 * 鲸吞 · ffmpeg Worker
 *
 * Emscripten 的 exec() 是同步阻塞的。放在主线程跑，转码期间页面
 * 完全卡死，连进度都没法更新。放进 Worker 里跑，主线程才能收到
 * 进度并响应取消。
 *
 * 这里不用 @ffmpeg/ffmpeg 那层封装：它默认从 CDN 拉 core，
 * 而我们要的是完全本地。直接用 ffmpeg-core 更可控。
 */

import createFFmpegCore from './ffmpeg-core.js';

let core = null;

/**
 * ffmpeg 最近的输出行
 *
 * 出错时一起回传 —— 否则上层只看到「返回码 1」，
 * 不知道 ffmpeg 到底在抱怨什么。
 */
const recentLogs = [];
/** 当前任务的进度信息，供 logger 解析 */
let progressHint = { duration: 0 };

/**
 * 从 ffmpeg 的输出行里解析已处理时长
 *
 * 输出形如：
 *   frame=  120 fps= 30 q=28.0 size=  1024kB time=00:00:04.00 bitrate=...
 *
 * @param {string} line
 * @returns {number|null} 秒
 */
function parseTime(line) {
    const m = /time=\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
    if (!m) return null;

    return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

/**
 * 加载 core
 * @returns {Promise<Object>}
 */
async function loadCore() {
    if (core) return core;

    if (typeof createFFmpegCore !== 'function') {
        throw new Error('ffmpeg-core.js 未正确加载');
    }

    core = await createFFmpegCore({
        // wasm 与 core.js 同目录，用 worker 自身的位置做基准，
        // 这样扩展换个安装路径也不受影响
        locateFile: (file) => new URL(file, self.location.href).href

        // 不要传 mainScriptUrlOrBlob。
        //
        // Emscripten 拿到它之后会做：
        //   JSON.parse(atob(x.slice(x.lastIndexOf('#') + 1)))
        // 也就是期望它是「# 后面跟一段 base64 编码的 JSON」（pthread 场景用）。
        // 我们传的是普通 URL，没有 #，于是 atob 拿到整个 URL 字符串直接抛错 ——
        // 表现就是 "Failed to execute 'atob' on 'WorkerGlobalScope'"。
        //
        // 这里不需要它：wasm 由 locateFile 定位，走普通 fetch。
    });

    core.setLogger(function (line) {
        const seconds = parseTime(line);

        if (seconds !== null && progressHint.duration > 0) {
            const percent = Math.min(99, Math.round((seconds / progressHint.duration) * 100));
            self.postMessage({ type: 'progress', percent: percent, time: seconds });
        } else if (line) {
            // 留最近几行，出错时一起回传 —— 否则用户只看到"返回码 1"，
            // 不知道 ffmpeg 到底在抱怨什么
            // Emscripten 的 logger 有时传对象（不只是字符串），得转一下
            const text = (typeof line === 'string') ? line : JSON.stringify(line);
            recentLogs.push(String(text).slice(0, 200));
            if (recentLogs.length > 8) recentLogs.shift();

            // 只转发有意义的行，避免刷屏
            self.postMessage({ type: 'log', line: String(typeof line === 'string' ? line : JSON.stringify(line)).slice(0, 200) });
        }
    });

    return core;
}

// ============================================================
// 消息处理
// ============================================================

self.onmessage = async function (event) {
    const msg = event.data;
    if (!msg || !msg.id) return;

    const { id, type, payload } = msg;

    try {
        switch (type) {
            case 'load': {
                await loadCore();
                self.postMessage({ id: id, ok: true });
                break;
            }

            case 'write': {
                const c = await loadCore();
                c.FS.writeFile(payload.path, payload.data);
                self.postMessage({ id: id, ok: true });
                break;
            }

            case 'read': {
                const c = await loadCore();
                const data = c.FS.readFile(payload.path);
                // 把 buffer 转移给主线程，避免复制整份数据
                self.postMessage({ id: id, ok: true, data: data }, [data.buffer]);
                break;
            }

            case 'delete': {
                const c = await loadCore();
                try {
                    c.FS.unlink(payload.path);
                } catch (e) {
                    // 文件本来就不在，忽略
                }
                self.postMessage({ id: id, ok: true });
                break;
            }

            case 'exec': {
                const c = await loadCore();
                progressHint.duration = payload.duration || 0;

                const args = payload.args || [];
                c.exec.apply(c, args);

                const ret = c.ret;

                // 每次执行后重置，避免残留状态影响下一次
                try { c.reset(); } catch (e) { /* 忽略 */ }

                // 失败时把 ffmpeg 的输出一起带回去，方便定位
                self.postMessage({
                    id: id,
                    ok: ret === 0,
                    ret: ret,
                    logs: ret === 0 ? null : recentLogs.slice(-8)
                });
                recentLogs.length = 0;
                break;
            }

            default:
                self.postMessage({ id: id, ok: false, error: '未知指令：' + type });
        }
    } catch (e) {
        self.postMessage({
            id: id,
            ok: false,
            error: (e && e.message) ? e.message : String(e)
        });
    }
};
