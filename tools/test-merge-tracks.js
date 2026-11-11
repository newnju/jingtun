/** 真实测试：B 站音视频自动合并 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/** 用 ffprobe 看产物里到底有什么流 */
function probe(file) {
    try {
        const out = execFileSync(FFPROBE, [
            '-v', 'error',
            '-show_entries', 'stream=codec_type,codec_name,width,height',
            '-show_entries', 'format=duration,format_name',
            '-of', 'json', file
        ], { encoding: 'utf8', timeout: 30000 });
        return JSON.parse(out);
    } catch (e) {
        return { error: (e.message || '').slice(0, 200) };
    }
}
const PW = process.env.PLAYWRIGHT_CORE || 'playwright-core';
const { chromium } = require(PW);
const CHROME = process.env.CHROME_PATH || chromium.executablePath();

const TEST_URL = 'https://www.bilibili.com/video/BV1GJ411x7h7';

let pass = 0, fail = 0;
function ok(n, d) { pass++; console.log('  [v] ' + n + (d ? '，' + d : '')); }
function no(n, d) { fail++; console.log('  [x] ' + n + (d ? '，' + d : '')); }

const watchdog = setTimeout(() => {
    console.error('\n[看门狗] 超时强制退出');
    process.exit(2);
}, 280000);

async function main() {
    console.log('B 站音视频自动合并测试');
    console.log('='.repeat(50) + '\n');

    const work = path.join(os.tmpdir(), 'jt-merge-' + Date.now());

    const ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), {
        executablePath: CHROME, headless: true,
        viewport: { width: 1280, height: 800 },
        args: [
            '--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT,
            '--no-first-run', '--no-default-browser-check',
            '--autoplay-policy=no-user-gesture-required',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    if (!sw) { console.log('扩展没起来'); process.exit(1); }

    const extId = sw.url().split('/')[2];
    const warns = [];
    sw.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()); });

    // offscreen 是独立页面，它的 console 得单独听，
    // 否则合并失败时看不到里面的日志
    const offLogs = [];
    ctx.on('page', (pg) => {
        pg.on('console', (m) => {
            offLogs.push('[' + m.type() + '] ' + m.text());
        });
        pg.on('pageerror', (e) => offLogs.push('[pageerror] ' + e.message));
    });

    // ---------- 打开 B 站 ----------
    console.log('【1】打开视频并捕获');
    const page = await ctx.newPage();
    await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(3500);

    try { await page.click('video', { timeout: 6000 }); } catch (e) {
        await page.evaluate(() => {
            const v = document.querySelector('video');
            if (v) { v.muted = true; v.play().catch(() => {}); }
        });
    }

    for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(2200);
        const t = await page.evaluate(() => {
            const v = document.querySelector('video');
            return v ? v.currentTime : 0;
        });
        if (t > 1) break;
    }

    const store = await sw.evaluate(() => {
        const all = JTStore.getAll() || {};
        const out = [];
        for (const t of Object.keys(all)) out.push(...(all[t] || []));
        return out.map((i) => ({
            name: i.name, ext: i.ext, url: i.url, size: i.size,
            pageUrl: i.pageUrl || '', pageTitle: i.pageTitle || '',
            requestHeaders: i.requestHeaders || null
        }));
    });

    const video = store.find((i) => /-1-1\d{4,5}\.m4s/.test(i.name || ''));
    const audio = store.find((i) => /-1-30\d{3}\.m4s/.test(i.name || ''));

    if (!video || !audio) {
        no('找到音视频对', JSON.stringify({ v: !!video, a: !!audio }));
        return finish(ctx, work);
    }
    ok('找到音视频对', video.name + ' + ' + audio.name);
    console.log('    视频 ' + (video.size / 1024 / 1024).toFixed(1) + 'MB，音频 ' + (audio.size / 1024 / 1024).toFixed(1) + 'MB');

    // ---------- 触发合并 ----------
    console.log('\n【2】触发合并（走 popup:mergeTracks）');

    const sender = await ctx.newPage();
    await sender.goto('chrome-extension://' + extId + '/options.html',
        { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sender.waitForTimeout(400);

    console.log('  正在取流并合并…（ffmpeg.wasm 首次加载要几十秒）');

    const t0 = Date.now();
    const res = await sender.evaluate(async ({ v, a }) => {
        try {
            return await chrome.runtime.sendMessage({
                type: 'popup:mergeTracks',
                items: [v, a]
            });
        } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }, { v: video, a: audio });

    console.log('  返回: ' + JSON.stringify(res) + '  （' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');

    if (res && res.ok) ok('合并请求被接受');
    else no('合并请求被接受', JSON.stringify(res));

    // ---------- 等下载完成 ----------
    console.log('\n【3】等合并产物落盘');

    let st = null;
    for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const list = await sender.evaluate(async () => {
            const l = await chrome.downloads.search({ limit: 3, orderBy: ['-startTime'] });
            return l.map((d) => ({
                state: d.state, bytes: d.bytesReceived, err: d.error,
                file: (d.filename || '').split(/[\\/]/).pop()
            }));
        });
        if (list && list.length) {
            st = list[0];
            if (st.state === 'complete' || st.state === 'interrupted') break;
        }
    }

    if (st) {
        console.log('  下载记录: ' + JSON.stringify(st));
        if (st.state === 'complete' && st.bytes > 100000) {
            ok('合并产物已保存', st.bytes + ' 字节  ' + st.file);
        } else {
            no('合并产物已保存', JSON.stringify(st));
        }
    } else {
        no('合并产物已保存', '没有下载记录');
    }

    // ---------- 关键：产物能不能播 ----------
    console.log('\n【3b】产物可播性（ffprobe）');

    const full = await sender.evaluate(async () => {
        const l = await chrome.downloads.search({ limit: 1, orderBy: ['-startTime'] });
        return l[0] ? l[0].filename : null;
    });

    if (full && fs.existsSync(full)) {
        const info = probe(full);
        if (info.error) {
            no('ffprobe 能解析产物', info.error);
        } else {
            const streams = (info.streams || []).map((x) =>
                x.codec_type + (x.width ? ' ' + x.width + 'x' + x.height : '') +
                ' (' + x.codec_name + ')');

            console.log('  流: ' + streams.join('  |  '));
            console.log('  时长: ' + ((info.format || {}).duration || '?') + 's');

            const hasVideo = (info.streams || []).some((x) => x.codec_type === 'video');
            const hasAudio = (info.streams || []).some((x) => x.codec_type === 'audio');

            if (hasVideo && hasAudio) {
                ok('产物同时有画面和声音（音视频合并成功）');
            } else {
                no('产物同时有画面和声音',
                    '只有 ' + (hasVideo ? '视频' : '') + (hasAudio ? '音频' : '') + '，合并不完整');
            }
        }
    } else {
        console.log('  （拿不到产物路径，跳过：' + String(full).slice(0, 80) + '）');
    }

    // ---------- 日志 ----------
    console.log('\n【4】后台日志');
    const logs = warns.filter((w) => /合并|merge|ffmpeg|转码|取流|诊断/i.test(w));
    if (logs.length) logs.slice(-6).forEach((l) => console.log('  SW: ' + l.slice(0, 120)));
    else console.log('  （SW 没有相关日志）');

    console.log('  （offscreen 日志 ' + offLogs.length + ' 条，已略）');

    await sender.close();
    return finish(ctx, work);
}

async function finish(ctx, work) {
    clearTimeout(watchdog);
    await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 12000))]);
    fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    console.log('\n' + '='.repeat(50));
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(0);
}

main().catch((e) => { console.error('脚本出错: ' + e.message); process.exit(1); });
