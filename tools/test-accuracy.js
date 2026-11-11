/** 准确率基准 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PW = process.env.PLAYWRIGHT_CORE || 'playwright-core';
const { chromium } = require(PW);
const CHROME = process.env.CHROME_PATH || chromium.executablePath();

// ---------------------------------------------------------------
// 样本定义
// ---------------------------------------------------------------

/** 该抓到的（真阳性） */
const SHOULD_CATCH = [
    ['/media/movie.mp4', 'video/mp4', '标准 mp4'],
    ['/media/stream.m3u8', 'application/vnd.apple.mpegurl', 'HLS 清单'],
    ['/media/seg0.ts', 'video/mp2t', 'TS 分片'],
    ['/media/video.m4s', 'video/mp4', 'DASH 分片'],
    ['/media/clip.flv', 'video/x-flv', 'FLV'],
    ['/media/show.mkv', 'video/x-matroska', 'MKV'],
    ['/media/web.webm', 'video/webm', 'WebM'],
    ['/media/song.mp3', 'audio/mpeg', 'MP3'],
    ['/media/audio.m4a', 'audio/mp4', 'M4A'],
    ['/media/dash.mpd', 'application/dash+xml', 'DASH 清单'],
    ['/download/movie.mp4', 'application/octet-stream', '无 MIME 但有扩展名'],
    ['/stream?file=clip.mp4&token=abc', 'application/octet-stream', '附件名带参数'],
    ['/media/movie.mp4?sign=xxx&t=123', 'video/mp4', '带查询串']
];

/** 不该抓到的（真阴性） */
const SHOULD_NOT_CATCH = [
    ['/index.html', 'text/html', '页面'],
    ['/app.js', 'application/javascript', '脚本'],
    ['/style.css', 'text/css', '样式'],
    ['/data.json', 'application/json', '数据'],
    ['/logo.png', 'image/png', '图片'],
    ['/bg.jpg', 'image/jpeg', '图片'],
    ['/icon.gif', 'image/gif', '图片'],
    ['/sprite.svg', 'image/svg+xml', '矢量图'],
    ['/font.woff2', 'font/woff2', '字体'],
    ['/api/user', 'application/json', '接口'],
    ['/analytics.gif', 'image/gif', '埋点'],
    ['/report', 'text/plain', '文本']
];

// ---------------------------------------------------------------

function startServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = req.url.split('?')[0];

            if (url === '/' || url === '/index.html') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>准确率基准</title></head><body><div id="host"></div></body></html>');
                return;
            }

            // 按样本表返回对应的 Content-Type
            const all = SHOULD_CATCH.concat(SHOULD_NOT_CATCH);
            const hit = all.find(([p]) => p === req.url || req.url.indexOf(p + '?') === 0);

            if (hit) {
                const headers = {
                    'Content-Type': hit[1],
                    'Access-Control-Allow-Origin': '*'
                };

                // 这条样本专门测「从附件名识别」，
                if (req.url.indexOf('/stream?') === 0) {
                    headers['Content-Disposition'] = 'attachment; filename="clip.mp4"';
                }

                res.writeHead(200, headers);
                // 返回一点内容，让请求看起来真实
                res.end(Buffer.alloc(512));
                return;
            }

            res.writeHead(404);
            res.end();
        });

        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

async function main() {
    console.log('准确率基准');
    console.log('='.repeat(50));
    console.log('样本: 该抓 ' + SHOULD_CATCH.length + ' 条 / 不该抓 ' + SHOULD_NOT_CATCH.length + ' 条\n');

    const work = path.join(os.tmpdir(), 'jt-acc-' + Date.now());
    const started = await startServer();
    const base = 'http://127.0.0.1:' + started.port;

    const ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), {
        executablePath: CHROME, headless: true,
        args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT,
               '--no-first-run', '--no-default-browser-check']
    });

    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    if (!sw) { console.log('扩展没起来'); process.exit(1); }

    const page = await ctx.newPage();
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1200);

    // 让页面把每个样本都请求一遍
    console.log('【1】页面发起请求');
    const requested = await page.evaluate(async (urls) => {
        const ok = [];
        for (const u of urls) {
            try {
                const r = await fetch(u, { mode: 'no-cors' });
                ok.push({ url: u, done: true });
            } catch (e) {
                ok.push({ url: u, done: false });
            }
        }
        return ok.length;
    }, SHOULD_CATCH.map(([p]) => base + p).concat(SHOULD_NOT_CATCH.map(([p]) => base + p)));

    console.log('  已请求 ' + requested + ' 条');
    await page.waitForTimeout(3000);

    // 读扩展捕获结果
    const captured = await sw.evaluate(() => {
        const all = JTStore.getAll() || {};
        const out = [];
        for (const t of Object.keys(all)) out.push(...(all[t] || []));
        return out.map((i) => ({ url: i.url, name: i.name, ext: i.ext, mime: i.mime || '' }));
    });

    const hit = (pathPart) => captured.some((c) =>
        c.url.indexOf(base + pathPart) === 0 ||
        c.url.indexOf(pathPart) === 0 ||
        (c.name && c.name === pathPart.split('/').pop()));

    // ---------- 漏抓 ----------
    console.log('\n【2】该抓的抓到了吗');
    let missed = 0;
    SHOULD_CATCH.forEach(([p, , label]) => {
        const got = hit(p);
        if (!got) missed++;
        console.log('  ' + (got ? '[v]' : '[x]') + ' ' + label.padEnd(22) + p);
    });

    // ---------- 误抓 ----------
    console.log('\n【3】不该抓的抓了吗');
    let wrong = 0;
    SHOULD_NOT_CATCH.forEach(([p, , label]) => {
        const got = hit(p);
        if (got) wrong++;
        console.log('  ' + (got ? '[x]' : '[v]') + ' ' + label.padEnd(22) + p);
    });

    // ---------- 指标 ----------
    const totalPos = SHOULD_CATCH.length;
    const totalNeg = SHOULD_NOT_CATCH.length;

    const missRate = (missed / totalPos * 100).toFixed(1);
    const wrongRate = (wrong / totalNeg * 100).toFixed(1);
    const recall = ((totalPos - missed) / totalPos * 100).toFixed(1);
    const precision = captured.length > 0
        ? (((totalPos - missed) / Math.max(1, captured.length)) * 100).toFixed(1)
        : '—';

    console.log('\n' + '='.repeat(50));
    console.log('指标');
    console.log('  漏抓率（该抓没抓）  ' + missRate + '%   （' + missed + '/' + totalPos + '）');
    console.log('  误抓率（不该抓却抓）' + wrongRate + '%   （' + wrong + '/' + totalNeg + '）');
    console.log('  召回率              ' + recall + '%');
    console.log('  捕获总数            ' + captured.length + ' 条');
    console.log();
    console.log('  （漏抓率越低越好，误抓率越低越好）');

    // 实际抓到的（用于排查）
    console.log('\n实际捕获明细:');
    captured.forEach((c) => console.log('  [' + (c.ext || '?') + '] ' + c.url.replace(base, '').slice(0, 70)));

    await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 12000))]);
    started.server.close();
    fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});

    // 有漏抓或误抓就算失败
    process.exit((missed === 0 && wrong === 0) ? 0 : 1);
}

main().catch((e) => { console.error('脚本出错: ' + e.message); process.exit(1); });
