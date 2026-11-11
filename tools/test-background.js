/** 后台逻辑的真实集成测试 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

const EXT = path.resolve(__dirname, '..');
const PW = process.env.PLAYWRIGHT_CORE || 'playwright-core';
const { chromium } = require(PW);
const CHROME = process.env.CHROME_PATH || chromium.executablePath();

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
    if (cond) {
        passed++;
        console.log('  [v] ' + name);
    } else {
        failed++;
        console.log('  [x] ' + name + (detail ? '  → ' + detail : ''));
    }
}

// ---------------------------------------------------------------
// 测试页
// ---------------------------------------------------------------

const PAGE = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>后台测试页</title></head>',
    '<body>',
    '  <video preload="auto"><source src="/media/a.mp4" type="video/mp4"></video>',
    '  <video preload="auto"><source src="/media/b.m3u8" type="application/vnd.apple.mpegurl"></video>',
    '</body></html>'
].join('\n');

function startServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(PAGE);
                return;
            }
            if (req.url === '/media/a.mp4') {
                res.writeHead(200, {
                    'Content-Type': 'video/mp4',
                    'Content-Length': '2048',
                    'Content-Disposition': 'inline; filename="a.mp4"'
                });
                res.end(Buffer.alloc(2048));
                return;
            }
            if (req.url === '/media/b.m3u8') {
                res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
                res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\n/seg0.ts\n#EXT-X-ENDLIST');
                return;
            }
            res.writeHead(404);
            res.end('');
        });

        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

// ---------------------------------------------------------------

// __WATCHDOG__
const WATCHDOG_MS = 150000;
const watchdog = setTimeout(() => {
    console.error("\n[看门狗] 超过 " + (WATCHDOG_MS / 1000) + " 秒仍未结束，强制退出");
    process.exit(2);
}, WATCHDOG_MS);

async function main() {
    if (!fs.existsSync(CHROME)) {
        console.log('找不到 Chromium');
        process.exit(1);
    }

    const started = await startServer();
    const server = started.server;
    const url = 'http://127.0.0.1:' + started.port + '/';

    const userDataDir = path.join(os.tmpdir(), 'jingtun-bg-' + Date.now());

    const context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: CHROME,
        headless: true,
        args: [
            '--disable-extensions-except=' + EXT,
            '--load-extension=' + EXT,
            '--no-first-run',
            '--no-default-browser-check'
        ]
    });

    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);

    if (!sw) {
        console.log('[FAIL] Service Worker 没起来');
        // context.close() 偶尔会挂住（Chromium 进程不响应）。
    // 加个超时保护，关不掉就直接往下走，别拖死整个测试。
    await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 15000))
    ]);
        server.close();
        process.exit(1);
    }

    const bgErrors = [];
    sw.on('console', (m) => { if (m.type() === 'error') bgErrors.push(m.text()); });
    sw.on('pageerror', (e) => bgErrors.push('SW 异常: ' + e.message));

    console.log('扩展已加载\n');

    // ============================================================
    console.log('=== 1. 后台模块是否就绪 ===');
    // ============================================================

    const modules = await sw.evaluate(() => {
        const names = ['JTConfig', 'JTStore', 'JTUtils', 'JTMatcher', 'JTTemplate'];
        const out = {};
        for (const n of names) {
            out[n] = typeof self[n] !== 'undefined';
        }
        return out;
    });

    for (const [name, ok] of Object.entries(modules)) {
        check(name + ' 已加载', ok);
    }

    // ============================================================
    console.log('\n=== 2. 配置读写 ===');
    // ============================================================

    const cfg = await sw.evaluate(async () => {
        const before = JTConfig.get();
        await JTConfig.set({ checkDuplicates: true });
        const after = JTConfig.get();
        await JTConfig.set({ checkDuplicates: before.checkDuplicates });
        return {
            hasDefaults: before && typeof before === 'object',
            keyCount: before ? Object.keys(before).length : 0,
            writeWorked: after.checkDuplicates === true
        };
    });

    check('能读到默认配置', cfg.hasDefaults && cfg.keyCount > 10, cfg.keyCount + ' 个键');
    check('配置能写进去', cfg.writeWorked);

    // ============================================================
    console.log('\n=== 3. 嗅探：真的去请求一个页面 ===');
    // ============================================================

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 15000 });
    await page.evaluate(() => document.querySelectorAll('video').forEach((v) => v.load()));
    await page.waitForTimeout(3500);

    const store = await sw.evaluate(() => {
        const all = JTStore.getAll() || {};
        const out = [];
        for (const tabId of Object.keys(all)) {
            const list = all[tabId] || [];
            out.push({
                tabId: Number(tabId),
                items: list.map((i) => ({ name: i.name, ext: i.ext, url: i.url, size: i.size }))
            });
        }
        return out;
    });

    const total = store.reduce((n, t) => n + t.items.length, 0);
    check('嗅探到了资源', total > 0, total + ' 条');

    const allItems = store.reduce((acc, t) => acc.concat(t.items), []);

    check(
        '识别出 mp4',
        allItems.some((i) => i.ext === 'mp4'),
        allItems.map((i) => i.ext).join(',')
    );

    check(
        '识别出 m3u8',
        allItems.some((i) => i.ext === 'm3u8'),
        allItems.map((i) => i.ext).join(',')
    );

    check(
        '文件名有解析出来',
        allItems.some((i) => i.name && i.name.length > 0),
        allItems.map((i) => i.name).join(' / ')
    );

    // ============================================================
    console.log('\n=== 4. 列表操作 ===');
    // ============================================================

    const ops = await sw.evaluate(() => {
        const all = JTStore.getAll() || {};
        const tabIds = Object.keys(all);
        if (tabIds.length === 0) return { skipped: true };

        const tabId = Number(tabIds[0]);
        const before = (JTStore.get(tabId) || []).length;

        // 删除第一条
        const list = JTStore.get(tabId) || [];
        if (list.length > 0) {
            JTStore.removeByUrls([list[0].url]);
        }
        const afterRemove = (JTStore.get(tabId) || []).length;

        // 清空整个标签页
        JTStore.remove(tabId);
        const afterClear = (JTStore.get(tabId) || []).length;

        return { skipped: false, before, afterRemove, afterClear };
    });

    if (ops.skipped) {
        console.log('  （没有数据，跳过）');
    } else {
        check('按地址删除生效', ops.afterRemove === ops.before - 1,
            ops.before + ' → ' + ops.afterRemove);
        check('清空标签页生效', ops.afterClear === 0, '剩 ' + ops.afterClear + ' 条');
    }

    // ============================================================
    console.log('\n=== 5. 后台消息处理 ===');
    // ============================================================

    // 注意：Service Worker 给自己发消息不会触发自己的监听器（Chrome 的机制），
    // 所以必须从一个扩展页面发。这里借用 options.html。
    const extId = sw.url().split("/")[2];
    const sender = await context.newPage();
    await sender.goto("chrome-extension://" + extId + "/options.html",
        { waitUntil: "domcontentloaded", timeout: 15000 });
    await sender.waitForTimeout(800);

    const msgs = await sender.evaluate(async () => {
        const results = {};

        async function ask(name, msg) {
            try {
                const r = await chrome.runtime.sendMessage(msg);
                return r;
            } catch (e) {
                return { __err: String(e && e.message || e) };
            }
        }

        let r;

        r = await ask("getConfig", { type: "popup:getConfig" });
        results.getConfig = !!(r && r.ok && r.config);

        r = await ask("getData", { type: "popup:getData", tabId: 999999 });
        results.getData = !!(r && r.ok);

        r = await ask("listAll", { type: "popup:listAll" });
        results.listAll = !!(r && r.ok && Array.isArray(r.tabs));

        r = await ask("getKeys", { type: "popup:getKeys", tabId: 999999 });
        results.getKeys = !!(r && r.ok && Array.isArray(r.keys));

        return results;
    });

    await sender.close();
    for (const [name, ok] of Object.entries(msgs)) {
        check('消息 ' + name + ' 有响应', ok);
    }

    // ============================================================
    console.log('\n=== 6. 工具函数（在 SW 环境里跑）===');
    // ============================================================

    const utils = await sw.evaluate(() => {
        return {
            quickExt: JTUtils.quickExt('https://a.com/v.mp4?a=1'),
            byteToSize: JTUtils.byteToSize(1048576),
            sanitize: JTUtils.sanitizeFileName('a/b:c*d?.mp4'),
            hostname: JTUtils.safeHostname('https://a.com/x'),
            template: JTUtils.renderTemplate('${url}', { url: 'U' }),
            // 非法输入不该抛
            badHost: JTUtils.safeHostname('not a url')
        };
    });

    check('quickExt', utils.quickExt === 'mp4', utils.quickExt);
    check('byteToSize', /MB/i.test(utils.byteToSize), utils.byteToSize);
    check('sanitizeFileName 去掉非法字符', utils.sanitize.indexOf(':') === -1, utils.sanitize);
    check('safeHostname', utils.hostname === 'a.com', utils.hostname);
    check('safeHostname 对畸形输入不抛错', typeof utils.badHost === 'string', utils.badHost);
    check('renderTemplate', utils.template === 'U', utils.template);

    // ============================================================
    console.log('\n=== 7. 后台报错 ===');
    // ============================================================

    if (bgErrors.length === 0) {
        check('后台无报错', true);
    } else {
        bgErrors.slice(0, 10).forEach((e) => console.log('    ' + e));
        check('后台无报错', false, bgErrors.length + ' 条');
    }

    // ============================================================

    // context.close() 偶尔会挂住（Chromium 进程不响应）。
    // 加个超时保护，关不掉就直接往下走，别拖死整个测试。
    const T0 = Date.now();
    const stamp = (m) => console.log('[收尾 ' + ((Date.now() - T0) / 1000).toFixed(1) + 's] ' + m);

    stamp('开始关 context');
    await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 15000))
    ]);
    stamp('context 已关');

    server.close();
    stamp('HTTP 服务已关');
    stamp('收尾完成（临时目录交给系统清理）');

    console.log('\n' + '='.repeat(46));
    console.log(failed === 0
        ? '全部通过（' + passed + ' 项）'
        : '通过 ' + passed + ' 项，失败 ' + failed + ' 项');

    clearTimeout(watchdog);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('测试脚本出错: ' + e.message);
    process.exit(1);
});
