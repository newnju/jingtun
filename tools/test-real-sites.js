/** 真实站点覆盖 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PW = process.env.PLAYWRIGHT_CORE || 'playwright-core';
const { chromium } = require(PW);
const CHROME = process.env.CHROME_PATH || chromium.executablePath();
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const watchdog = setTimeout(() => { console.error('[看门狗] 超时'); process.exit(2); }, 420000);

const results = [];

function probe(file) {
    try {
        const out = execFileSync(FFPROBE, [
            '-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
            '-of', 'json', file
        ], { encoding: 'utf8', timeout: 40000 });
        return JSON.parse(out);
    } catch (e) { return { error: (e.message || '').slice(0, 150) }; }
}

/** 测试源 */
const SOURCES = [
    {
        label: 'mp4 直链',
        url: 'https://media.w3.org/2010/05/sintel/trailer.mp4',
        kind: 'direct'
    },
    {
        label: 'HLS 多码率',
        url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
        kind: 'hls'
    },
    {
        label: 'DASH 分离',
        url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd',
        kind: 'dash'
    }
];

async function main() {
    const custom = process.argv.slice(2).filter((a) => a.indexOf('--') !== 0);
    const sources = custom.length > 0
        ? custom.map((u) => ({
            label: u.split('/').pop().slice(0, 30),
            url: u,
            kind: /\.mpd($|\?)/.test(u) ? 'dash' : (/\.m3u8($|\?)/.test(u) ? 'hls' : 'direct')
        }))
        : SOURCES;

    console.log('真实站点覆盖（依赖外网）');
    console.log('='.repeat(50));
    console.log('源: ' + sources.length + ' 个\n');

    const work = path.join(os.tmpdir(), 'jt-real-' + Date.now());
    fs.mkdirSync(work, { recursive: true });

    // ---------- 本地页面（引用远程资源） ----------
    const server = http.createServer((req, res) => {
        const url = req.url.split('?')[0];
        if (url === '/' || url === '/index.html') {
            const vids = sources.map((s) =>
                '<video muted preload="auto" data-src="' + s.url + '"></video>').join('');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>real</title></head><body>' +
                vids +
                '<script>setTimeout(function(){' +
                'document.querySelectorAll("video").forEach(function(v){' +
                'v.src=v.dataset.src;try{v.load();}catch(e){}});' +
                '},800);</script></body></html>');
            return;
        }
        res.writeHead(404); res.end();
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    console.log('本地页面: ' + base);

    // ---------- 浏览器 ----------
    const ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), {
        executablePath: CHROME, headless: true,
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT,
               '--no-first-run', '--no-default-browser-check',
               '--autoplay-policy=no-user-gesture-required']
    });

    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    if (!sw) { console.log('扩展没起来'); process.exit(1); }

    const extId = sw.url().split('/')[2];

    const page = await ctx.newPage();
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(12000);   // 远程资源慢，多等一会儿

    // ---------- 逐个源 ----------
    for (const src of sources) {
        console.log('\n' + '-'.repeat(50));
        console.log('【' + src.label + '】');
        console.log('  ' + src.url);

        const r = { label: src.label, caught: 0, download: 'skip', playable: 'skip' };

        try {
            // 找到这个源的嗅探结果
            const store = await sw.evaluate(() => {
                const all = JTStore.getAll() || {};
                const out = [];
                for (const t of Object.keys(all)) out.push(...(all[t] || []));
                return out.map((i) => ({
                    name: i.name, ext: i.ext, url: i.url, size: i.size,
                    pageUrl: i.pageUrl || '', requestHeaders: i.requestHeaders || null
                }));
            });

            const host = new URL(src.url).hostname;
            const mine = store.filter((i) => i.url.indexOf(host) !== -1);
            r.caught = mine.length;

            console.log('  嗅探: ' + mine.length + ' 条');
            mine.slice(0, 5).forEach((i) =>
                console.log('    [' + (i.ext || '?') + '] ' + String(i.name).slice(0, 50)));

            if (mine.length === 0) {
                r.download = 'no-catch';
                results.push(r);
                continue;
            }

            // 下载：清单类走 m3u8 页，直链走 popup
            const sender = await ctx.newPage();
            await sender.goto('chrome-extension://' + extId + '/options.html',
                { waitUntil: 'domcontentloaded', timeout: 15000 });
            await sender.waitForTimeout(400);

            let dlOk = false;

            let m3u8PageRef = null;

            if (src.kind === 'direct') {
                const item = mine.find((i) => /\.mp4/.test(i.name || '')) || mine[0];

                const beforeId = await maxDownloadId(sender);

                await sender.evaluate(async (it) => {
                    return chrome.runtime.sendMessage({ type: 'popup:download', item: it });
                }, item);

                dlOk = await waitForDownload(sender, 60000, beforeId);
            } else {
                // HLS / DASH 走 m3u8 页
                const m3u8Page = await ctx.newPage();
                m3u8PageRef = m3u8Page;
                await m3u8Page.goto('chrome-extension://' + extId + '/m3u8.html',
                    { waitUntil: 'domcontentloaded', timeout: 20000 });
                await m3u8Page.waitForTimeout(700);

                await m3u8Page.fill('#urlInput', src.url);
                await m3u8Page.click('#btnParseUrl');

                let segs = 0;
                for (let i = 0; i < 20; i++) {
                    await m3u8Page.waitForTimeout(1500);
                    segs = await m3u8Page.evaluate(() =>
                        document.querySelectorAll('#segmentList .segment-item').length);
                    if (segs > 0) break;
                }

                console.log('  解析: ' + segs + ' 分片');

                if (segs === 0) {
                    r.download = '解析失败';
                    results.push(r);
                    await m3u8Page.close();
                    await sender.close();
                    continue;
                }

                // DASH 优先用合并下载，HLS 用普通下载
                const btnId = src.kind === 'dash' ? '#btnMergeTracks' : '#btnDownload';
                const useBtn = await m3u8Page.evaluate((id) => {
                    const b = document.querySelector(id);
                    return b && !b.hidden;
                }, btnId);

                const beforeId = await maxDownloadId(m3u8Page);

                await m3u8Page.click(useBtn ? btnId : '#btnDownload', { timeout: 8000 });

                dlOk = await waitForDownload(m3u8Page, 240000, beforeId);
                await m3u8Page.close();
            }

            await sender.close();

            if (dlOk) {
                r.download = 'ok';
                console.log('  下载: [OK]');

                if (dlOk.file && fs.existsSync(dlOk.file)) {
                    const info = probe(dlOk.file);
                    if (info.error) {
                        r.playable = 'ffprobe 失败';
                    } else {
                        const ks = (info.streams || []).map((x) => x.codec_type);
                        const hv = ks.indexOf('video') !== -1, ha = ks.indexOf('audio') !== -1;
                        r.playable = hv && ha ? '音视频齐全' : (hv ? '只有视频' : '只有音频');
                    }
                    console.log('  产物: ' + r.playable + '  (' + (dlOk.bytes / 1024 / 1024).toFixed(1) + 'MB)');
                    console.log('  来自: ' + dlOk.url);
                } else {
                    r.playable = '找不到文件';
                }
            } else {
                r.download = 'fail';
                console.log('  下载: [FAIL]');
                // 状态在 m3u8 页上，不在那个本地页面
                try {
                    const st = await m3u8PageRef.evaluate(() => {
                        const t = document.body.innerText || '';
                        const i = Math.max(t.indexOf('下载'), t.indexOf('失败'));
                        return i >= 0 ? t.slice(i, i + 200) : t.slice(-200);
                    });
                    console.log('  m3u8 页状态: ' + st.replace(/\n+/g, ' | ').slice(0, 160));
                } catch (e) {}
            }
        } catch (e) {
            r.download = 'error: ' + String(e.message || e).slice(0, 50);
            console.log('  出错: ' + r.download);
        }

        results.push(r);
    }

    // ---------- 汇总 ----------
    console.log('\n' + '='.repeat(50));
    console.log('汇总\n');
    console.log('  ' + '源'.padEnd(16) + '嗅探'.padEnd(8) + '下载'.padEnd(12) + '产物');
    console.log('  ' + '-'.repeat(48));
    results.forEach((r) => {
        console.log('  ' + String(r.label).padEnd(16) +
            String(r.caught).padEnd(8) +
            String(r.download).padEnd(12) +
            r.playable);
    });

    const good = results.filter((r) => r.download === 'ok').length;
    console.log('\n  ' + good + '/' + results.length + ' 个源下载成功');

    clearTimeout(watchdog);
    await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 12000))]);
    server.close();
    fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    process.exit(0);
}

/**
 * 等下载完成
 * @param {Object} page
 * @param {number} timeoutMs
 * @param {number} beforeId 调用前记录的最大下载 id
 */
async function waitForDownload(page, timeoutMs, beforeId) {
    const t0 = Date.now();

    while (Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 2000));

        const l = await page.evaluate(async (minId) => {
            const x = await chrome.downloads.search({ limit: 5, orderBy: ['-startTime'] });
            return x.filter((d) => d.id > minId).map((d) => ({
                id: d.id, state: d.state, bytes: d.bytesReceived,
                file: d.filename, url: (d.url || '').slice(0, 80)
            }));
        }, beforeId);

        const done = l.find((x) => x.state === 'complete' && x.bytes > 50000);
        if (done) return done;

        // 有失败且不再变化就放弃
        const bad = l.find((x) => x.state === 'interrupted');
        if (bad && Date.now() - t0 > 20000) return null;
    }
    return null;
}

/** 记下当前最大的下载 id，用来区分这次和上次 */
async function maxDownloadId(page) {
    return page.evaluate(async () => {
        const x = await chrome.downloads.search({ limit: 1, orderBy: ['-startTime'] });
        return x[0] ? x[0].id : 0;
    });
}

main().catch((e) => { console.error('脚本出错: ' + e.message); process.exit(1); });
