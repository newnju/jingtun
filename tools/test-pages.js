/** 所有扩展页面的真实渲染测试 */
const path = require('path');
const fs = require('fs');
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
        console.log('    [v] ' + name);
    } else {
        failed++;
        console.log('    [x] ' + name + (detail ? '  → ' + detail : ''));
    }
}

// ---------------------------------------------------------------
// 每个页面：要检查哪些元素、有没有可点的交互
// ---------------------------------------------------------------

const PAGES = [
    {
        file: 'options.html',
        name: '设置页',
        // enableToggle 在弹窗里，设置页没有它
        mustHave: ['externalPlayer', 'autoClearOnNavigate', 'notifyOnDrm', 'contextMenusEnable'],
        interact: ['autoClearOnNavigate', 'notifyOnDrm']
    },
    {
        file: 'm3u8.html',
        name: 'M3U8 / MPD 解析',
        mustHave: ['rawText', 'btnParseUrl', 'btnParseText', 'urlInput', 'textInput'],
        interact: [],
        // 粘一段清单进去，验证解析链路真的通
        parseTest: {
            inputId: 'textInput',
            buttonId: 'btnParseText',
            sample: [
                '#EXTM3U',
                '#EXT-X-VERSION:3',
                '#EXT-X-TARGETDURATION:10',
                '#EXTINF:10.0,',
                'https://example.com/seg0.ts',
                '#EXTINF:10.0,',
                'https://example.com/seg1.ts',
                '#EXT-X-ENDLIST'
            ].join('\n'),
            // 解析成功后应该出现分片列表
            expectId: 'segmentCount'
        }
    },
    {
        file: 'manage.html',
        name: '资源管理页',
        mustHave: ['list'],
        interact: []
    },
    {
        file: 'json.html',
        name: 'JSON 查看器',
        mustHave: ['rawInput'],
        interact: []
    },
    {
        file: 'downloader.html',
        name: '下载器',
        mustHave: [],
        interact: []
    },
    {
        file: 'install.html',
        name: '使用说明',
        mustHave: [],
        interact: []
    }
];

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

    const userDataDir = path.join(os.tmpdir(), 'jingtun-pages-' + Date.now());

    const context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: CHROME,
        headless: true,
        viewport: { width: 900, height: 700 },
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
        console.log('[FAIL] 扩展没加载起来');
        // context.close() 偶尔会挂住（Chromium 进程不响应）。
    // 加个超时保护，关不掉就直接往下走，别拖死整个测试。
    await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 15000))
    ]);
        process.exit(1);
    }

    const extId = sw.url().split('/')[2];
    console.log('扩展 id: ' + extId + '\n');

    for (const spec of PAGES) {
        console.log('=== ' + spec.name + ' (' + spec.file + ') ===');

        const page = await context.newPage();

        const errors = [];
        page.on('console', (m) => {
            if (m.type() === 'error') errors.push(m.text());
        });
        page.on('pageerror', (e) => errors.push('未捕获异常: ' + e.message));

        const url = 'chrome-extension://' + extId + '/' + spec.file;

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(1500);   // 等异步初始化
        } catch (e) {
            check('能打开', false, e.message.slice(0, 60));
            await page.close();
            continue;
        }

        // ---------- 有没有渲染出东西 ----------
        const render = await page.evaluate(() => {
            const body = document.body;
            return {
                elementCount: document.querySelectorAll('*').length,
                textLength: (body.innerText || '').trim().length,
                // 有没有卡在初始化错误
                hasInitError: /初始化失败|初始化出错/.test(body.innerText || '')
            };
        });

        check('页面有内容（不是空白页）',
            render.elementCount > 10 && render.textLength > 10,
            render.elementCount + ' 元素 / ' + render.textLength + ' 字');

        check('没有卡在初始化错误', !render.hasInitError);

        // ---------- 关键元素 ----------
        if (spec.mustHave.length > 0) {
            const present = await page.evaluate((ids) => {
                const out = {};
                ids.forEach((id) => { out[id] = !!document.getElementById(id); });
                return out;
            }, spec.mustHave);

            for (const [id, ok] of Object.entries(present)) {
                check('元素 #' + id + ' 存在', ok);
            }
        }

        // ---------- 交互 ----------
        for (const id of spec.interact) {
            try {
                // 开关类的 input 被 .switch 的样式藏起来了（视觉上是那个滑块），
                await page.evaluate((elId) => {
                    const el = document.getElementById(elId);
                    if (!el) return;
                    el.checked = !el.checked;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }, id);
                await page.waitForTimeout(300);

                // 切回来
                await page.evaluate((elId) => {
                    const el = document.getElementById(elId);
                    if (!el) return;
                    el.checked = !el.checked;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }, id);
                await page.waitForTimeout(300);

                check('切换 #' + id + ' 不报错', true);
            } catch (e) {
                check('切换 #' + id + ' 不报错', false, e.message.slice(0, 50));
            }
        }

        // ---------- 解析链路 ----------
        if (spec.parseTest) {
            const t = spec.parseTest;
            try {
                await page.fill('#' + t.inputId, t.sample);
                await page.click('#' + t.buttonId);
                await page.waitForTimeout(1200);

                const parsed = await page.evaluate((expectId) => {
                    const el = document.getElementById(expectId);
                    return {
                        exists: !!el,
                        text: el ? el.textContent.trim() : '',
                        bodyHasSeg: /seg0\.ts|seg1\.ts/.test(document.body.innerText || '')
                    };
                }, t.expectId);

                check('粘贴清单后解析出分片',
                    parsed.bodyHasSeg || /\d/.test(parsed.text),
                    '计数元素: ' + (parsed.text || '(空)'));
            } catch (e) {
                check('粘贴清单后解析出分片', false, e.message.slice(0, 60));
            }
        }

        // ---------- 报错 ----------
        if (errors.length === 0) {
            check('无控制台报错', true);
        } else {
            errors.slice(0, 5).forEach((e) => console.log('      ! ' + e.slice(0, 110)));
            check('无控制台报错', false, errors.length + ' 条');
        }

        await page.close();
        console.log('');
    }

    // context.close() 偶尔会挂住（Chromium 进程不响应）。
    // 加个超时保护，关不掉就直接往下走，别拖死整个测试。
    await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 15000))
    ]);
    // 临时目录异步清理，不等待，
    fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});

    console.log('='.repeat(46));
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
