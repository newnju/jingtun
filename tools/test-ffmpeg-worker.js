/** 单独测：ffmpeg Worker 到底能不能加载 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PW = process.env.PLAYWRIGHT_CORE || 'playwright-core';
const { chromium } = require(PW);
const CHROME = process.env.CHROME_PATH || chromium.executablePath();

const watchdog = setTimeout(() => { console.error('[看门狗] 超时'); process.exit(2); }, 120000);

async function main() {
    const work = path.join(os.tmpdir(), 'jt-ff-' + Date.now());

    const ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), {
        executablePath: CHROME, headless: true,
        args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT, '--no-first-run']
    });

    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    if (!sw) { console.log('扩展没起来'); process.exit(1); }

    const extId = sw.url().split('/')[2];
    console.log('扩展 id: ' + extId);

    // 用一个扩展页当宿主（offscreen 也是扩展页，环境一样）
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

    await page.goto('chrome-extension://' + extId + '/offscreen.html',
        { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(async () => {
        // offscreen.html 可能不能直接打开（它是 offscreen 文档），退回 options
        await page.goto('chrome-extension://' + extId + '/options.html',
            { waitUntil: 'domcontentloaded', timeout: 15000 });
    });
    await page.waitForTimeout(1000);

    console.log('\n=== 1. 检查 ffmpeg-core.js 能不能取到 ===');
    const fetchCheck = await page.evaluate(async () => {
        const url = chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.js');
        try {
            const r = await fetch(url);
            const t = await r.text();
            return { ok: r.ok, status: r.status, len: t.length };
        } catch (e) { return { error: String(e.message || e) }; }
    });
    console.log('  ' + JSON.stringify(fetchCheck));

    const wasmCheck = await page.evaluate(async () => {
        const url = chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.wasm');
        try {
            const r = await fetch(url);
            const b = await r.arrayBuffer();
            return { ok: r.ok, status: r.status, bytes: b.byteLength };
        } catch (e) { return { error: String(e.message || e) }; }
    });
    console.log('  wasm: ' + JSON.stringify(wasmCheck));

    console.log('\n=== 2. 建 Worker 并让它 load ===');
    const workerTest = await page.evaluate(() => {
        return new Promise((resolve) => {
            const out = { steps: [] };
            let w;

            try {
                const url = chrome.runtime.getURL('lib/ffmpeg/ffmpeg-worker.js');
                out.steps.push('worker url: ' + url);
                w = new Worker(url, { type: 'module' });
                out.steps.push('Worker 已创建');
            } catch (e) {
                out.steps.push('创建失败: ' + e.message);
                resolve(out);
                return;
            }

            const timer = setTimeout(() => {
                out.steps.push('超时（30s 没响应）');
                try { w.terminate(); } catch (e) {}
                resolve(out);
            }, 30000);

            w.addEventListener('error', (e) => {
                out.steps.push('Worker error: ' + (e.message || '?') +
                    (e.filename ? ' @ ' + e.filename : ''));
            });

            w.addEventListener('message', (e) => {
                const m = e.data;
                if (!m) return;
                out.steps.push('收到消息: ' + JSON.stringify(m).slice(0, 150));

                if (m.type === 'log') return;   // ffmpeg 的日志，继续等

                clearTimeout(timer);
                try { w.terminate(); } catch (e2) {}
                resolve(out);
            });

            w.postMessage({ id: 1, type: 'load' });
            out.steps.push('已发出 load 请求');
        });
    });

    console.log('  过程:');
    workerTest.steps.forEach((s) => console.log('    ' + s));

    console.log('\n=== 3. 页面报错 ===');
    if (errors.length) errors.slice(0, 6).forEach((e) => console.log('  ' + e.slice(0, 140)));
    else console.log('  无');

    clearTimeout(watchdog);
    await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 12000))]);
    fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    process.exit(0);
}

main().catch((e) => { console.error('出错: ' + e.message); process.exit(1); });
