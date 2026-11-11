/** 验证：B 站的 m4s 是不是完整流 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PW = process.env.PLAYWRIGHT_CORE || 'playwright-core';
const { chromium } = require(PW);
const CHROME = process.env.CHROME_PATH || chromium.executablePath();

const TEST_URL = process.argv.slice(2).filter((a) => a.indexOf('--') !== 0)[0] ||
    'https://www.bilibili.com/video/BV1GJ411x7h7';

let pass = 0, fail = 0;
function ok(n, d) { pass++; console.log('  [v] ' + n + (d ? '，' + d : '')); }
function no(n, d) { fail++; console.log('  [x] ' + n + (d ? '，' + d : '')); }

// 异常退出
const watchdog = setTimeout(() => {
    console.error('\n[看门狗] 超时强制退出');
    process.exit(2);
}, 150000);

async function main() {
    console.log('B 站下载结果可播性验证');
    console.log('='.repeat(50));
    console.log('视频: ' + TEST_URL + '\n');

    const work = path.join(os.tmpdir(), 'jt-vb-' + Date.now());

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

    console.log('【1】打开视频页');
    const page = await ctx.newPage();
    await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(3500);

    try { await page.click('video', { timeout: 6000 }); } catch (e) {
        await page.evaluate(() => {
            const v = document.querySelector('video');
            if (v) { v.muted = true; v.play().catch(() => {}); }
        });
    }

    // 等它播起来
    let playing = false;
    for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(2200);
        const t = await page.evaluate(() => {
            const v = document.querySelector('video');
            return v ? v.currentTime : 0;
        });
        if (t > 1) { playing = true; break; }
    }
    if (playing) ok('页面视频在播'); else no('页面视频在播');

    console.log('\n【2】扩展捕获');
    const store = await sw.evaluate(() => {
        const all = JTStore.getAll() || {};
        const out = [];
        for (const t of Object.keys(all)) out.push(...(all[t] || []));
        return out.map((i) => ({ name: i.name, ext: i.ext, url: i.url, size: i.size }));
    });

    if (store.length === 0) { no('捕获到资源'); return finish(ctx, work); }
    ok('捕获到资源', store.length + ' 条');
    store.slice(0, 6).forEach((i) =>
        console.log('    [' + i.ext + '] ' + i.name + '  ' + ((i.size || 0) / 1024 / 1024).toFixed(1) + 'MB'));

    const videoItem = store.find((i) => /-1-1\d{4,5}\.m4s/.test(i.name || ''));
    const audioItem = store.find((i) => /-1-30\d{3}\.m4s/.test(i.name || ''));

    if (videoItem) ok('识别出视频流', videoItem.name);
    else no('识别出视频流');

    if (audioItem) ok('识别出音频流（DASH 音视频分离）', audioItem.name);
    else no('识别出音频流');

    // ---------- 关键：看前 32 字节 ----------
    console.log('\n【3】关键验证：文件头是什么 box');

    async function checkHead(item, label) {
        if (!item) { console.log('  跳过 ' + label); return; }

        // 只取前 64 字节，够判断 box 类型，不用下整个文件
        const r = await page.evaluate(async (url) => {
            try {
                const res = await fetch(url, {
                    credentials: 'include',
                    headers: { Range: 'bytes=0-63' }
                });
                if (!res.ok && res.status !== 206) return { status: res.status };
                const b = await res.arrayBuffer();
                return { ok: true, bytes: Array.from(new Uint8Array(b)), size: b.byteLength };
            } catch (e) { return { error: String(e.message || e).slice(0, 80) }; }
        }, item.url);

        if (!r.ok) {
            console.log('  ' + label + ': 取头失败 ' + JSON.stringify(r));
            console.log('    （B 站签名可能过期，或被反爬拦下）');
            return;
        }

        const buf = Buffer.from(r.bytes);
        const firstBox = buf.slice(4, 8).toString('ascii');

        // 往后找有没有 ftyp（有些文件前面有 free/其他 box）
        let foundFtyp = false;
        for (let i = 0; i + 8 <= buf.length; i += 4) {
            const t = buf.slice(i + 4, i + 8).toString('ascii');
            if (/^[a-z]{4}$/.test(t) && t === 'ftyp') { foundFtyp = true; break; }
            const size = buf.readUInt32BE(i);
            if (size < 8 || i + size > buf.length) break;
            i += size - 4;
        }

        console.log('  ' + label + ' (' + (item.size / 1024 / 1024).toFixed(1) + 'MB):');
        console.log('    第一个 box: "' + firstBox + '"');
        console.log('    前 32 字节: ' + buf.slice(0, 32).toString('hex'));

        if (firstBox === 'ftyp' || foundFtyp) {
            ok(label + ' 是完整 fMP4（能直接播）', 'box=' + (foundFtyp ? 'ftyp' : firstBox));
        } else if (firstBox === 'styp' || firstBox === 'moof') {
            no(label + ' 只是分片', 'box=' + firstBox + '，需要 init segment 才能播');
        } else {
            console.log('    （box 类型 ' + firstBox + ' 不在预期内）');
        }
    }

    await checkHead(videoItem, '视频流');
    await checkHead(audioItem, '音频流');

    console.log('\n【4】结论');
    if (videoItem && audioItem) {
        console.log('  B 站是 DASH 流：视频、音频各一条独立文件。');
        console.log('  要得到能看的片子，需要：');
        console.log('    1. 两条流都下下来');
        console.log('    2. 用 ffmpeg 合并成一个文件');
        console.log('  鲸吞有本地 ffmpeg（lib/ffmpeg），理论上能做到。');
    }

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
