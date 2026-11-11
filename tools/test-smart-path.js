/** 验证：下载路径智能选择 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PW = process.env.PLAYWRIGHT_CORE || 'playwright-core';
const { chromium } = require(PW);
const CHROME = process.env.CHROME_PATH || chromium.executablePath();

const watchdog = setTimeout(() => { console.error('[看门狗] 超时'); process.exit(2); }, 180000);

let pass = 0, fail = 0;
function ok(n, d) { pass++; console.log('  [v] ' + n + (d ? '，' + d : '')); }
function no(n, d) { fail++; console.log('  [x] ' + n + (d ? '，' + d : '')); }

const MEDIA = Buffer.alloc(200000, 0x41);   // 200KB 假媒体

async function main() {
    const work = path.join(os.tmpdir(), 'jt-smart-' + Date.now());
    fs.mkdirSync(work, { recursive: true });

    console.log('下载路径智能选择');
    console.log('='.repeat(50));

    // ---------- 服务 ----------
    // /open，正常站点，任何请求都放行
    // /locked，防盗链，只认本站 Referer
    const server = http.createServer((req, res) => {
        const url = req.url.split('?')[0];

        if (url === '/page') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body>' +
                '<video id="a" muted preload="auto"><source src="/open/movie.mp4" type="video/mp4"></video>' +
                '<video id="b" muted preload="auto"><source src="/locked/movie.mp4" type="video/mp4"></video>' +
                // 稍等一下再触发，页面刚加载时扩展可能还没准备好
                '<script>setTimeout(function(){' +
                'document.querySelectorAll("video").forEach(function(v){try{v.load();}catch(e){}});' +
                '}, 800);</script></body></html>');
            return;
        }

        if (url === '/locked/movie.mp4') {
            const ref = req.headers['referer'] || '';
            if (ref.indexOf('127.0.0.1') === -1 && ref.indexOf('localhost') === -1) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('forbidden');
                return;
            }
        }

        if (url === '/open/movie.mp4' || url === '/locked/movie.mp4') {
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Content-Length': MEDIA.length,
                'Access-Control-Allow-Origin': '*'
            });
            res.end(MEDIA);
            return;
        }

        res.writeHead(404); res.end();
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = 'http://127.0.0.1:' + port;
    console.log('\n服务: ' + base);

    // ---------- 浏览器 ----------
    const ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), {
        executablePath: CHROME, headless: true,
        acceptDownloads: true,
        args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT,
               '--no-first-run', '--no-default-browser-check']
    });

    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    if (!sw) { console.log('扩展没起来'); process.exit(1); }

    const extId = sw.url().split('/')[2];

    const logs = [];
    sw.on('console', (m) => logs.push(m.text()));

    // ---------- 页面先请求一遍，让扩展嗅探到 ----------
    const page = await ctx.newPage();
    await page.goto(base + '/page', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(5000);

    const store = await sw.evaluate(() => {
        const all = JTStore.getAll() || {};
        const out = [];
        for (const t of Object.keys(all)) out.push(...(all[t] || []));
        return out.map((i) => ({
            name: i.name, ext: i.ext, url: i.url, size: i.size,
            pageUrl: i.pageUrl || '', requestHeaders: i.requestHeaders || null
        }));
    });

    console.log('  嗅探到 ' + store.length + ' 条');
    store.forEach((i) => console.log('    ' + i.url.replace(base, '')));

    const openItem = store.find((i) => i.url.indexOf('/open/') !== -1);
    const lockedItem = store.find((i) => i.url.indexOf('/locked/') !== -1);

    if (!openItem || !lockedItem) {
        no('嗅探到两个资源', JSON.stringify({ open: !!openItem, locked: !!lockedItem }));
        return finish(ctx, work, server);
    }
    ok('嗅探到两个资源');

    const sender = await ctx.newPage();
    await sender.goto('chrome-extension://' + extId + '/options.html',
        { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sender.waitForTimeout(500);

    // ---------- 场景 A：正常站点，不该被跳过 ----------
    console.log('\n【A】正常站点（没有失败记录）');
    logs.length = 0;

    await sender.evaluate(async (item) => {
        return chrome.runtime.sendMessage({ type: 'popup:download', item: item });
    }, openItem);

    await new Promise((r) => setTimeout(r, 6000));

    const skippedA = logs.some((l) => /直接走页面身份/.test(l));
    if (!skippedA) ok('没有跳过直接下载（符合预期）');
    else no('没有跳过直接下载', '被误跳过了');

    // 统计里应该记了成功
    const statsA = await sw.evaluate(() => JTConfig.get('downloadStats') || {});
    const hostA = Object.keys(statsA).find((h) => h.indexOf('127.0.0.1') === 0);
    if (hostA && statsA[hostA].ok > 0) ok('记下了成功', JSON.stringify(statsA[hostA]));
    else no('记下了成功', JSON.stringify(statsA));

    // ---------- 场景 B：设成"连续失败过"，应该被跳过 ----------
    console.log('\n【B】已知下不动的域名');
    await sw.evaluate(() => {
        JTConfig.set('downloadStats', { '127.0.0.1': { ok: 0, fail: 3, time: Date.now() } });
    });
    await new Promise((r) => setTimeout(r, 500));

    logs.length = 0;

    const t0 = Date.now();
    await sender.evaluate(async (item) => {
        return chrome.runtime.sendMessage({ type: 'popup:download', item: item });
    }, lockedItem);

    await new Promise((r) => setTimeout(r, 5000));

    const skippedB = logs.some((l) => /直接走页面身份/.test(l));
    if (skippedB) ok('跳过了直接下载，走页面身份', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    else no('跳过了直接下载', '日志: ' + logs.filter((l) => /下载/.test(l)).slice(0, 3).join(' | '));

    // ---------- 场景 C：成功过就不该跳过 ----------
    console.log('\n【C】失败过但成功过（站点可能修好了）');
    await sw.evaluate(() => {
        JTConfig.set('downloadStats', { '127.0.0.1': { ok: 2, fail: 5, time: Date.now() } });
    });
    await new Promise((r) => setTimeout(r, 500));

    logs.length = 0;

    await sender.evaluate(async (item) => {
        return chrome.runtime.sendMessage({ type: 'popup:download', item: item });
    }, openItem);

    await new Promise((r) => setTimeout(r, 6000));

    const skippedC = logs.some((l) => /直接走页面身份/.test(l));
    if (!skippedC) ok('没跳过（成功过就还给机会）');
    else no('没跳过', '被跳过了');

    // ---------- 收尾 ----------
    console.log('\n【D】统计表内容');
    const finalStats = await sw.evaluate(() => JTConfig.get('downloadStats') || {});
    console.log('  ' + JSON.stringify(finalStats));

    return finish(ctx, work, server);
}

async function finish(ctx, work, server) {
    clearTimeout(watchdog);
    if (ctx) await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 12000))]);
    if (server) { try { server.close(); } catch (e) {} }
    fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    console.log('\n' + '='.repeat(50));
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(0);
}

main().catch((e) => { console.error('脚本出错: ' + e.message); process.exit(1); });
