/** 真实网站测试：bilibili */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PW = process.env.PLAYWRIGHT_CORE || 'playwright-core';
const { chromium } = require(PW);
const CHROME = process.env.CHROME_PATH || chromium.executablePath();

const EXT = ROOT;
const TEST_URL = process.argv.slice(2).filter((a) => a.indexOf('--') !== 0)[0] ||
    'https://www.bilibili.com/video/BV1GJ411x7h7';

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
    if (cond) {
        passed++;
        console.log('  [v] ' + name);
    } else {
        failed++;
        console.log('  [x] ' + name + (detail ? '\n        → ' + detail : ''));
    }
}

function info(msg) {
    console.log('      ' + msg);
}

async function main() {
    if (!fs.existsSync(CHROME)) {
        console.log('找不到 Chromium');
        process.exit(1);
    }

    console.log('测试地址: ' + TEST_URL);

    const userDataDir = path.join(os.tmpdir(), 'jt-bili-' + Date.now());

    // 加 --headed 就用真实窗口跑，用来判断某些失败是不是 headless 特有的
    const HEADED = process.argv.indexOf('--headed') !== -1;
    if (HEADED) console.log('（headed 模式）');

    const context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: CHROME,
        headless: !HEADED,
        viewport: { width: 1280, height: 800 },
        args: [
            '--disable-extensions-except=' + EXT,
            '--load-extension=' + EXT,
            '--no-first-run',
            '--no-default-browser-check',
            '--autoplay-policy=no-user-gesture-required',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // ---------- 扩展 ----------
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);

    if (!sw) {
        console.log('[FAIL] 扩展没加载');
        await context.close();
        process.exit(1);
    }

    const extId = sw.url().split('/')[2];
    const bgErrors = [];
    const bgWarns = [];
    sw.on('console', (m) => {
        if (m.type() === 'error') bgErrors.push(m.text());
        if (m.type() === 'warning') bgWarns.push(m.text());
    });

    console.log('扩展 id: ' + extId);

    // ---------- 打开视频页 ----------
    console.log('\n=== 1. 打开视频页 ===');

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    try {
        await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    } catch (e) {
        check('能打开 B 站', false, e.message.slice(0, 100));
        await context.close();
        process.exit(1);
    }

    check('能打开 B 站', true);
    info('标题: ' + (await page.title()));

    await page.waitForTimeout(4000);

    // ---------- 让它播起来 ----------
    console.log('\n=== 2. 触发播放 ===');

    try {
        await page.click('video', { timeout: 8000 });
    } catch (e) {
        await page.evaluate(() => {
            const v = document.querySelector('video');
            if (v) { v.muted = true; v.play().catch(() => {}); }
        });
    }

    let playing = false;
    for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(2500);
        const st = await page.evaluate(() => {
            const v = document.querySelector('video');
            return v ? { t: v.currentTime, rs: v.readyState } : null;
        });
        if (st && st.t > 1) { playing = true; break; }
    }

    check('页面视频开始播放', playing);

    // ---------- 捕获 ----------
    console.log('\n=== 3. 扩展捕获到了什么 ===');

    const store = await sw.evaluate(() => {
        const all = JTStore.getAll() || {};
        const out = [];
        for (const tabId of Object.keys(all)) {
            const list = all[tabId] || [];
            if (list.length) out.push(list);
        }
        return out.flat().map((i) => ({
            name: i.name,
            ext: i.ext,
            url: i.url,
            size: i.size,
            pageUrl: i.pageUrl || '',
            requestHeaders: i.requestHeaders || null,
            time: i.time
        }));
    });

    check('扩展捕获到了资源', store.length > 0, store.length + ' 条');

    if (store.length === 0) {
    await finish(context, userDataDir, page, bgErrors, pageErrors, bgWarns);
        return;
    }

    const exts = {};
    store.forEach((i) => { exts[i.ext] = (exts[i.ext] || 0) + 1; });
    info('扩展名分布: ' + JSON.stringify(exts));
    info('明细:');
    store.slice(0, 8).forEach((i) => {
        info('  [' + (i.ext || '?') + '] ' + (i.name || '(无名)') +
            (i.size ? ' (' + (i.size / 1024 / 1024).toFixed(1) + 'MB)' : ''));
    });

    check('捕获到 m4s（B 站 DASH 的标志）',
        store.some((i) => i.ext === 'm4s'),
        '实际: ' + Object.keys(exts).join(','));
    check('捕获到 B 站的域名',
        store.some((i) => /bilivideo|bilibili|hdslb|mountaintoys/.test(i.url)));
    check('解析出了文件名', store.some((i) => i.name && i.name.length > 0));
    check('记下了 pageUrl（防盗链补头要用）',
        store.some((i) => i.pageUrl && i.pageUrl.length > 0));
    check('记下了请求头',
        store.some((i) => i.requestHeaders && Object.keys(i.requestHeaders).length > 0));

    // ---------- 立即下载 ----------
    console.log('\n=== 4. 立刻用扩展的下载功能下一条 ===');
    // 趁 URL 新鲜，B 站的签名有时效，隔太久会 403

    const target = store.find((i) => /-1-1\d{4,5}\.m4s/.test(i.name || '')) || store[0];
    const ageSec = ((Date.now() - (target.time || Date.now())) / 1000).toFixed(1);
    info('选中: ' + target.name + '（捕获于 ' + ageSec + ' 秒前）');

    const sender = await context.newPage();
    await sender.goto('chrome-extension://' + extId + '/options.html',
        { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sender.waitForTimeout(400);

    // 必须从扩展页面发，SW 给自己发不会触发自己的监听器
    const started = await sender.evaluate(async (item) => {
        try {
            return await chrome.runtime.sendMessage({ type: 'popup:download', item: item });
        } catch (e) {
            return { ok: false, error: String(e && e.message || e) };
        }
    }, {
        url: target.url,
        name: target.name,
        ext: target.ext,
        pageUrl: target.pageUrl,
        requestHeaders: target.requestHeaders
    });

    // 先用 fetch 试，区分「下载方式」和「URL 本身」的问题
    const viaFetch = await sender.evaluate(async ({ url, headers }) => {
        const attempts = [];
        const tries = [
            { label: '裸 fetch', h: {} },
            { label: '带捕获的头', h: headers || {} },
            { label: '带 Range', h: Object.assign({ Range: 'bytes=0-' }, headers || {}) },
            { label: '带 sec-fetch', h: Object.assign({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors' }, headers || {}) }
        ];
        for (const t of tries) {
            try {
                const r = await fetch(url, { headers: t.h, credentials: 'include' });
                let bytes = 0;
                if (r.ok) {
                    const b = await r.arrayBuffer();
                    bytes = b.byteLength;
                }
                attempts.push({ label: t.label, status: r.status, bytes: bytes });
            } catch (e) {
                attempts.push({ label: t.label, error: String(e && e.message || e).slice(0, 60) });
            }
        }
        return attempts;
    }, { url: target.url, headers: target.requestHeaders });

    info('fetch 对照:');
    viaFetch.forEach((a) => info('  ' + a.label + ' → ' +
        (a.error ? 'ERR ' + a.error : 'HTTP ' + a.status + (a.bytes ? ' / ' + a.bytes + ' 字节' : ''))));

    // 拦截实际请求，看 DNR 补的头到底生效没有
    const seen = [];
    const cdp = await context.newCDPSession(sender);
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', (e) => {
        const u = e.request.url || '';
        if (/\.m4s|mountaintoys/.test(u)) {
            const h = e.request.headers || {};
            seen.push({
                referer: h['Referer'] || h['referer'] || '(无)',
                origin: h['Origin'] || h['origin'] || '(无)',
                secSite: h['Sec-Fetch-Site'] || '(无)',
                secMode: h['Sec-Fetch-Mode'] || '(无)',
                ua: (h['User-Agent'] || '(无)').slice(0, 40)
            });
        }
    });

    info('后台返回: ' + JSON.stringify(started));
    check('扩展接受了下载请求', !!(started && started.ok), JSON.stringify(started));

    // 查下载状态（不用 Playwright 的 download 事件，那是页面触发的才有）
    let state = null;
    for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        state = await sender.evaluate(async (id) => {
            const l = await chrome.downloads.search({ id: id });
            return l && l[0] ? {
                state: l[0].state,
                bytes: l[0].bytesReceived,
                total: l[0].totalBytes,
                error: l[0].error || null
            } : null;
        }, started.downloadId);
        if (state && (state.state === 'complete' || state.state === 'interrupted')) break;
    }

    await sender.close();

    if (state) {
        info('实际发出的请求头（' + seen.length + ' 条）:');
        seen.slice(0, 2).forEach((h) => {
            info('  Referer: ' + String(h.referer).slice(0, 60));
            info('  Origin: ' + h.origin);
            info('  Sec-Fetch-Site: ' + h.secSite);
            info('  Sec-Fetch-Mode: ' + h.secMode);
        });

        info('chrome.downloads 的结果: ' + JSON.stringify(state));

        // 这里不要求成功，B 站这类防盗链站点，chrome.downloads
        const expectedFail = state.state === 'interrupted' &&
            /FORBIDDEN|UNAUTHORIZED|BAD_CONTENT/.test(state.error || '');

        check('chrome.downloads 按预期失败（交给回退处理）', expectedFail,
            expectedFail ? '' : '状态 ' + state.state + '，错误 ' + state.error);

        if (expectedFail) {
            info('  → 设计如此：防盗链站点必须走页面身份重试');
        }
    } else {
        check('chrome.downloads 按预期失败（交给回退处理）', false, '查不到记录');
    }

    // ---------- 直接用下载器页下（扩展的正路）----------
    console.log('\n=== 4c. 直接用下载器页下 ===');
    // 下载器页才是真正的重试通道：chrome.downloads 失败后后台会打开它。
    // 这里直接开，省掉中间一步。

    {
    const dlPage = await context.newPage();
    const dlErrors = [];
    dlPage.on('pageerror', (e) => dlErrors.push(e.message));

    const payload = {
        url: target.url,
        filename: target.name,
        referrer: target.pageUrl || TEST_URL,
        requestHeaders: target.requestHeaders || {}
    };

    try {
        await dlPage.goto(
            'chrome-extension://' + extId + '/downloader.html?JSON=' +
            encodeURIComponent(JSON.stringify(payload)),
            { waitUntil: 'domcontentloaded', timeout: 20000 }
        );
    } catch (e) {
        check('能打开下载器页', false, e.message.slice(0, 80));
        await finish(context, userDataDir, page, bgErrors, pageErrors, bgWarns);
        return;
    }

    // 等它跑完（重试阶梯最多三步，每步之间还有 300ms 间隔）
    let uiState = null;
    for (let i = 0; i < 20; i++) {
        await dlPage.waitForTimeout(1500);
        uiState = await dlPage.evaluate(() => ({
            title: (document.getElementById('title') || {}).textContent || '',
            desc: (document.getElementById('desc') || {}).textContent || '',
            err: (document.getElementById('err') || {}).hidden === false
                ? (document.getElementById('err') || {}).textContent : ''
        }));
        if (uiState.title.indexOf('完成') !== -1 || uiState.err) break;
    }

    info('下载器页: ' + uiState.title + ' / ' + uiState.desc);
    if (uiState.err) info('  错误: ' + uiState.err.slice(0, 120));

    check('下载器页下载成功', uiState.title.indexOf('完成') !== -1,
        uiState.err || uiState.title);
    check('下载器页无异常', dlErrors.length === 0, dlErrors.slice(0, 2).join(' | '));

    await dlPage.close();
    }


    // ---------- 回退机制 ----------
    console.log('\n=== 4b2. 回退机制 ===');
    // chrome.downloads 失败后，后台应该自动开下载器页重试。

    {
        let sawRetry = false;
        for (let i = 0; i < 25 && !sawRetry; i++) {
            await page.waitForTimeout(1000);
            sawRetry = bgWarns.some((w) => /改用页面身份重试/.test(w));
        }

        check('失败后触发了回退（改用页面身份重试）', sawRetry,
            sawRetry ? '' : '后台日志里没有回退记录。已捕获的日志: ' +
                bgWarns.filter((w) => /下载/.test(w)).slice(0, 3).join(' | '));

        if (sawRetry) {
            info('后台日志: ' + bgWarns.filter((w) => /下载|重下/.test(w)).slice(-2).join(' / '));
        }
    }

    await finish(context, userDataDir, page, bgErrors, pageErrors, bgWarns);
}

async function finish(context, userDataDir, page, bgErrors, pageErrors, bgWarns) {
    console.log('\n=== 5. 报错 ===');

    if (bgWarns && bgWarns.length) {
        console.log('  后台警告:');
        bgWarns.slice(0, 5).forEach((w) => info(w.slice(0, 120)));
    }

    check('扩展后台无报错', bgErrors.length === 0, bgErrors.slice(0, 2).join(' | '));

    if (pageErrors.length) {
        console.log('  页面报错（多半与扩展无关）:');
        pageErrors.slice(0, 3).forEach((e) => info(e.slice(0, 100)));
    }

    const shot = path.join(os.tmpdir(), 'jingtun-bilibili-test.png');
    try { await page.screenshot({ path: shot }); info('截图: ' + shot); } catch (e) { /* 忽略 */ }

    await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 15000))
    ]);
    fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});

    console.log('\n' + '='.repeat(46));
    console.log(failed === 0
        ? '全部通过（' + passed + ' 项）'
        : '通过 ' + passed + ' 项，失败 ' + failed + ' 项');

    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('测试脚本出错: ' + e.message);
    process.exit(1);
});
