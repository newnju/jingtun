/** 用真实浏览器调试弹窗 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

const EXT = path.resolve(__dirname, '..');
const PW = process.env.PLAYWRIGHT_CORE || 'playwright-core';
const { chromium } = require(PW);
const CHROME = process.env.CHROME_PATH || chromium.executablePath();

// ---------------------------------------------------------------
// 测试页：放几种典型的媒体引用
// ---------------------------------------------------------------

const TEST_PAGE = [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8"><title>鲸吞测试页</title></head>',
    '<body style="font:14px system-ui;padding:20px">',
    '  <h1>测试页</h1>',
    '  <p>这个页面引用了几个媒体地址，用来验证扩展的嗅探。</p>',
    '  <video id="v1" width="320" controls preload="auto">',
    '    <source src="/media/sample.mp4" type="video/mp4">',
    '  </video>',
    '  <video id="v2" width="320" controls preload="auto">',
    '    <source src="/media/sample.m3u8" type="application/vnd.apple.mpegurl">',
    '  </video>',
    '</body></html>'
].join('\n');

function startServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.url === '/' || req.url === '/index.html') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(TEST_PAGE);
                return;
            }

            if (req.url === '/media/sample.mp4') {
                res.writeHead(200, {
                    'Content-Type': 'video/mp4',
                    'Content-Length': '2048',
                    'Content-Disposition': 'inline; filename="sample.mp4"'
                });
                res.end(Buffer.alloc(2048));
                return;
            }

            if (req.url === '/media/sample.m3u8') {
                res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
                res.end([
                    '#EXTM3U',
                    '#EXT-X-VERSION:3',
                    '#EXT-X-TARGETDURATION:10',
                    '#EXT-X-MEDIA-SEQUENCE:0',
                    '#EXTINF:10.0,',
                    '/media/seg0.ts',
                    '#EXTINF:10.0,',
                    '/media/seg1.ts',
                    '#EXT-X-ENDLIST'
                ].join('\n'));
                return;
            }

            res.writeHead(404);
            res.end('not found');
        });

        server.listen(0, '127.0.0.1', () => {
            resolve({ server: server, port: server.address().port });
        });
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
        console.log('找不到 Chromium: ' + CHROME);
        process.exit(1);
    }

    const started = await startServer();
    const server = started.server;
    const testUrl = 'http://127.0.0.1:' + started.port + '/';
    console.log('测试页: ' + testUrl);

    const userDataDir = path.join(os.tmpdir(), 'jingtun-debug-' + Date.now());

    const context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: CHROME,
        headless: true,
        viewport: { width: 400, height: 620 },   // 弹窗的真实尺寸
        args: [
            '--disable-extensions-except=' + EXT,
            '--load-extension=' + EXT,
            '--no-first-run',
            '--no-default-browser-check'
        ]
    });

    // ---------- 拿扩展 id ----------
    let sw = context.serviceWorkers()[0];
    if (!sw) {
        sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    }

    if (!sw) {
        console.log('[FAIL] Service Worker 没起来，扩展可能加载失败');
        // context.close() 偶尔会挂住（Chromium 进程不响应）。
    // 加个超时保护，关不掉就直接往下走，别拖死整个测试。
    await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 15000))
    ]);
        server.close();
        process.exit(1);
    }

    const extId = sw.url().split('/')[2];
    console.log('扩展 id: ' + extId);

    const bgErrors = [];
    sw.on('console', (m) => { if (m.type() === 'error') bgErrors.push(m.text()); });

    // ---------- 打开测试页，让扩展嗅探 ----------
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('  测试页异常: ' + e.message));

    console.log('\n打开测试页…');
    await page.goto(testUrl, { waitUntil: 'load', timeout: 15000 });

    // 触发媒体请求，让 webRequest 看得到
    await page.evaluate(() => {
        document.querySelectorAll('video').forEach((v) => { v.load(); });
    });

    await page.waitForTimeout(3500);

    // ---------- 先从后台看看嗅探到没有 ----------
    //
    // 注意：popup 在新标签页里打开时，activeTab 会变成它自己，
    // 所以不能靠弹窗去查当前页， 得直接问后台。
    console.log('\n=== 后台的捕获结果 ===');

    const bgStore = await sw.evaluate(() => {
        try {
            const all = JTStore.getAll() || {};
            const out = [];
            for (const tabId of Object.keys(all)) {
                const list = all[tabId] || [];
                out.push({
                    tabId: Number(tabId),
                    count: list.length,
                    items: list.slice(0, 5).map((i) => ({
                        name: i.name, ext: i.ext, url: String(i.url).slice(0, 60)
                    }))
                });
            }
            return { ok: true, tabs: out };
        } catch (e) {
            return { ok: false, error: String(e && e.message || e) };
        }
    });

    if (!bgStore.ok) {
        console.log('  读不到 store: ' + bgStore.error);
    } else if (bgStore.tabs.length === 0) {
        console.log('  后台没有捕获到任何资源');
    } else {
        bgStore.tabs.forEach((t) => {
            console.log('  标签页 ' + t.tabId + ': ' + t.count + ' 条');
            t.items.forEach((i) => console.log('    - ' + (i.name || '(无名)') + '  [' + (i.ext || '?') + ']'));
        });
    }

    // ---------- 打开弹窗 ----------
    console.log('\n打开弹窗…');

    // 真实场景里 popup 是「扩展弹窗」，不是标签页，
    let popup = null;
    const popupErrors = [];

    try {
        await sw.evaluate(() => chrome.action.openPopup());
    } catch (e) {
        console.log("  openPopup 调用失败: " + e.message);
    }

    // 等 popup 页面出现
    for (let i = 0; i < 40 && !popup; i++) {
        popup = context.pages().find((pg) => pg.url().indexOf(extId) !== -1 &&
            pg.url().indexOf("popup.html") !== -1);
        if (!popup) await new Promise((r) => setTimeout(r, 250));
    }

    if (!popup) {
        console.log("[FAIL] chrome.action.openPopup() 没打开弹窗");
        console.log("  （headless 下可能不支持，这是环境限制，不是扩展的问题）");
        // context.close() 偶尔会挂住（Chromium 进程不响应）。
    // 加个超时保护，关不掉就直接往下走，别拖死整个测试。
    await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 15000))
    ]);
        server.close();
        // 临时目录异步清理，不等待，
    fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
        process.exit(0);
    }

    popup.on("console", (m) => { if (m.type() === "error") popupErrors.push(m.text()); });
    popup.on("pageerror", (e) => popupErrors.push("未捕获异常: " + e.message));

    await popup.waitForTimeout(3000);

    // ---------- 读结果 ----------
    const state = await popup.evaluate(() => {
        const list = document.getElementById('list');
        const rows = list ? Array.prototype.slice.call(list.querySelectorAll('.item')) : [];
        const names = rows.map((r) => {
            const n = r.querySelector('.item-name');
            return n ? n.textContent.trim().slice(0, 60) : '(无名)';
        });
        const countEl = document.getElementById('count');
        const emptyEl = document.getElementById('empty');

        return {
            count: countEl ? countEl.textContent : '?',
            rowCount: rows.length,
            names: names,
            emptyText: emptyEl ? emptyEl.innerText.replace(/\n/g, ' | ') : '(无空状态元素)'
        };
    });

    console.log('\n=== 列表结果 ===');
    console.log('  计数显示: ' + state.count);
    console.log('  列表行数: ' + state.rowCount);

    if (state.rowCount > 0) {
        console.log('  条目:');
        state.names.forEach((n) => console.log('    - ' + n));
    } else {
        console.log('  空状态: ' + state.emptyText);
    }

    // ---------- 有数据就试展开 ----------
    if (state.rowCount > 0) {
        console.log('\n=== 展开测试（点第一行）===');

        await popup.click('.item');
        await popup.waitForTimeout(900);

        const expanded = await popup.evaluate(() => {
            const detail = document.querySelector('.item-detail');
            const player = document.querySelector('.item-player');
            return {
                hasDetail: !!detail,
                hasPlayer: !!player,
                playerSrc: player ? String(player.src || player.getAttribute('src') || '(无 src)').slice(0, 70) : null,
                detailText: detail ? detail.innerText.slice(0, 150).replace(/\n/g, ' | ') : ''
            };
        });

        console.log('  展开区出现: ' + expanded.hasDetail);
        console.log('  播放器出现: ' + expanded.hasPlayer);
        if (expanded.playerSrc) console.log('  播放器 src: ' + expanded.playerSrc);
        if (expanded.detailText) console.log('  展开区内容: ' + expanded.detailText);

        // ---------- 试试图标按钮 ----------
        console.log('\n=== 图标按钮测试 ===');

        const iconCheck = await popup.evaluate(() => {
            const btns = document.querySelectorAll('.icon-act');
            return {
                count: btns.length,
                hasSvg: btns.length > 0 ? btns[0].querySelector('svg') !== null : false,
                titles: Array.prototype.slice.call(btns).map((b) => b.title).slice(0, 6)
            };
        });

        console.log('  图标按钮数: ' + iconCheck.count);
        console.log('  含 SVG: ' + iconCheck.hasSvg);
        console.log('  提示文字: ' + iconCheck.titles.join(' / '));
    }

    // ---------- 截图 ----------
    const shot = path.join(os.tmpdir(), 'jingtun-debug-popup.png');
    await popup.screenshot({ path: shot });
    console.log('\n截图: ' + shot);

    // ---------- 报错 ----------
    console.log('\n=== 控制台报错 ===');
    if (popupErrors.length === 0) {
        console.log('  弹窗: 无');
    } else {
        popupErrors.forEach((e) => console.log('  弹窗: ' + e));
    }

    if (bgErrors.length > 0) {
        console.log('  后台:');
        bgErrors.slice(0, 8).forEach((e) => console.log('    ' + e));
    }

    // context.close() 偶尔会挂住（Chromium 进程不响应）。
    // 加个超时保护，关不掉就直接往下走，别拖死整个测试。
    await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 15000))
    ]);
    server.close();
    // 临时目录异步清理，不等待，
    fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});

    console.log('\n' + '='.repeat(46));
    const bad = popupErrors.length + bgErrors.length;
    console.log(bad === 0 ? '没有报错' : '共 ' + bad + ' 个报错');
}

main().catch((e) => {
    console.error('调试脚本出错: ' + e.message);
    process.exit(1);
});
