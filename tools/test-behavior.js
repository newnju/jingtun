/** 行为测试：验证"点了之后真的发生了什么" */
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
        console.log('  [v] ' + name);
    } else {
        failed++;
        console.log('  [x] ' + name + (detail ? '\n        → ' + detail : ''));
    }
}

/** 打开一个扩展页面，返回 { page, errors } */
async function openPage(context, extId, file) {
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('未捕获异常: ' + e.message));

    await page.goto('chrome-extension://' + extId + '/' + file, {
        waitUntil: 'domcontentloaded', timeout: 15000
    });
    await page.waitForTimeout(1200);

    return { page, errors };
}

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

    const userDataDir = path.join(os.tmpdir(), 'jingtun-behavior-' + Date.now());

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
        console.log('[FAIL] 扩展没加载');
        // context.close() 偶尔会挂住（Chromium 进程不响应）。
    // 加个超时保护，关不掉就直接往下走，别拖死整个测试。
    await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 15000))
    ]);
        process.exit(1);
    }

    const extId = sw.url().split('/')[2];

    // ============================================================
    console.log('=== A. 设置页：改开关 → 真的写进配置 ===');
    // ============================================================

    {
        const { page, errors } = await openPage(context, extId, 'options.html');

        // 先把某个开关设成已知状态
        const before = await sw.evaluate(() => JTConfig.get().notifyOnDrm);

        await page.evaluate(() => {
            const el = document.getElementById('notifyOnDrm');
            el.checked = !el.checked;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(900);   // 等防抖/写存储

        const after = await sw.evaluate(() => JTConfig.get().notifyOnDrm);

        check('切换开关后配置真的变了', before !== after,
            'before=' + before + ' after=' + after);

        // 改回去
        await page.evaluate(() => {
            const el = document.getElementById('notifyOnDrm');
            el.checked = !el.checked;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(900);

        const restored = await sw.evaluate(() => JTConfig.get().notifyOnDrm);
        check('改回后配置恢复', restored === before, 'restored=' + restored);

        check('设置页无报错', errors.length === 0, errors.slice(0, 2).join(' | '));
        await page.close();
    }

    // ============================================================
    console.log('\n=== B. M3U8 页：解析 → 分片数与内容正确 ===');
    // ============================================================

    {
        const { page, errors } = await openPage(context, extId, 'm3u8.html');

        const SEG_COUNT = 3;
        const sample = [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            '#EXT-X-TARGETDURATION:10',
            '#EXT-X-MEDIA-SEQUENCE:0'
        ];
        for (let i = 0; i < SEG_COUNT; i++) {
            sample.push('#EXTINF:10.0,');
            sample.push('https://example.com/seg' + i + '.ts');
        }
        sample.push('#EXT-X-ENDLIST');

        await page.fill('#textInput', sample.join('\n'));
        await page.click('#btnParseText');
        await page.waitForTimeout(1500);

        const result = await page.evaluate(() => {
            const list = document.getElementById('segList');
            const rows = list ? list.querySelectorAll('*[class*="seg"]') : [];
            const count = document.getElementById('segmentCount');
            return {
                countText: count ? count.textContent.trim() : '',
                bodyText: document.body.innerText,
                // 分片地址有没有渲染出来
                hasSeg0: /seg0\.ts/.test(document.body.innerText),
                hasSeg2: /seg2\.ts/.test(document.body.innerText),
                // 不该出现不存在的分片
                hasSeg9: /seg9\.ts/.test(document.body.innerText)
            };
        });

        check('解析出 3 个分片（不是别的数字）',
            result.countText.indexOf(String(SEG_COUNT)) !== -1,
            '计数显示: ' + JSON.stringify(result.countText));

        check('第一个分片地址渲染出来了', result.hasSeg0);
        check('最后一个分片地址渲染出来了', result.hasSeg2);
        check('没有凭空多出分片', !result.hasSeg9);

        // 原始清单：内容在解析时就填进 textarea 了（默认 hidden 而已），
        // 所以直接读 value 就能验证。
        const raw = await page.evaluate(() => {
            const t = document.getElementById('rawText');
            return t ? t.value : '';
        });

        check('原始清单内容正确',
            raw.indexOf('#EXTM3U') !== -1 && raw.indexOf('seg1.ts') !== -1,
            '长度 ' + raw.length);

        // 展开按钮：切换的是 textarea 本身（不是外层卡片）
        const toggle = await page.evaluate(() => {
            const t = document.getElementById('rawText');
            const btn = document.getElementById('btnToggleRaw');
            if (!t || !btn) return null;

            const beforeHidden = t.hidden;
            const beforeLabel = btn.textContent.trim();

            btn.click();
            const midHidden = t.hidden;
            const midLabel = btn.textContent.trim();

            btn.click();
            const afterHidden = t.hidden;
            const afterLabel = btn.textContent.trim();

            return { beforeHidden, beforeLabel, midHidden, midLabel, afterHidden, afterLabel };
        });

        check('展开按钮真的切换了显隐',
            toggle && toggle.beforeHidden !== toggle.midHidden,
            toggle ? JSON.stringify(toggle) : '找不到元素');

        check('按钮文字跟着状态走（不反向）',
            toggle && (
                (toggle.beforeHidden && toggle.midLabel === '折叠') ||
                (!toggle.beforeHidden && toggle.midLabel === '展开')
            ),
            toggle ? '收起后文字=' + toggle.midLabel : '');

        check('再点一次能切回来',
            toggle && toggle.afterHidden === toggle.beforeHidden,
            toggle ? JSON.stringify(toggle) : '');

        check('M3U8 页无报错', errors.length === 0, errors.slice(0, 2).join(' | '));
        await page.close();
    }

    // ============================================================
    console.log('\n=== C. M3U8 页：异常输入不该崩 ===');
    // ============================================================

    {
        const { page, errors } = await openPage(context, extId, 'm3u8.html');

        const badInputs = [
            { name: '空内容', text: '' },
            { name: '纯垃圾文本', text: '这不是一个清单文件，只是一段中文。' },
            { name: '只有头没有分片', text: '#EXTM3U\n#EXT-X-VERSION:3\n' },
            { name: '畸形地址', text: '#EXTM3U\n#EXTINF:10,\nht!tp://[[[bad\n#EXT-X-ENDLIST' }
        ];

        for (const bad of badInputs) {
            try {
                await page.fill('#textInput', bad.text);
                await page.click('#btnParseText');
                await page.waitForTimeout(700);

                // 只要页面还活着、没抛未捕获异常，就算过
                const alive = await page.evaluate(() => document.querySelectorAll('*').length > 10);
                check('喂「' + bad.name + '」不崩', alive);
            } catch (e) {
                check('喂「' + bad.name + '」不崩', false, e.message.slice(0, 50));
            }
        }

        const realErrors = errors.filter((e) => !/解析失败|无法解析|格式/.test(e));
        check('异常输入没引发未捕获异常', realErrors.length === 0,
            realErrors.slice(0, 2).join(' | '));

        await page.close();
    }

    // ============================================================
    console.log('\n=== D. JSON 查看器：解析 → 树结构正确 ===');
    // ============================================================

    {
        const { page, errors } = await openPage(context, extId, 'json.html');

        const json = '{"code":0,"data":{"name":"测试","list":[1,2,3]}}';

        await page.fill('#rawInput', json);
        await page.waitForTimeout(500);

        // 找解析按钮（id 可能不同，用文字回退）
        const clicked = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const b = btns.find((x) => /解析|格式化|查看/.test(x.textContent));
            if (b) { b.click(); return b.textContent.trim(); }
            return null;
        });

        await page.waitForTimeout(1000);

        const result = await page.evaluate(() => {
            const tree = document.getElementById('tree');
            const text = document.body.innerText;
            return {
                // 第一层默认展开，所以 code / data 应该看得到
                hasKey: /code/.test(text) && /data/.test(text),
                // 树容器里应该有节点
                nodeCount: tree ? tree.querySelectorAll('*').length : 0,
                // 值在深层，需要手动展开才可见，这里只验证树建起来了
                treeBuilt: tree ? tree.children.length > 0 : false
            };
        });

        check('JSON 第一层键渲染出来了', result.hasKey);
        check('树结构建起来了', result.treeBuilt && result.nodeCount > 5,
            '节点数 ' + result.nodeCount);

        check('JSON 页无报错', errors.length === 0, errors.slice(0, 2).join(' | '));
        await page.close();
    }

    // ============================================================
    console.log('\n=== E. 管理页：空列表 → 显示空状态 ===');
    // ============================================================

    {
        const { page, errors } = await openPage(context, extId, 'manage.html');

        const state = await page.evaluate(() => {
            const list = document.getElementById('list');
            const text = (document.body.innerText || '');
            return {
                hasList: !!list,
                childCount: list ? list.children.length : -1,
                hasEmptyHint: /没有|暂无|空/.test(text),
                textLen: text.trim().length
            };
        });

        check('管理页渲染了内容', state.textLen > 10, state.textLen + ' 字');
        check('空列表时有提示', state.hasEmptyHint || state.childCount > 0,
            '子元素 ' + state.childCount);

        check('管理页无报错', errors.length === 0, errors.slice(0, 2).join(' | '));
        await page.close();
    }

    // ============================================================
    console.log('\n=== F. 后台：列表操作的完整闭环 ===');
    // ============================================================

    {
        // 先塞几条数据进去
        const seeded = await sw.evaluate(() => {
            const tabId = 777001;
            JTStore.remove(tabId);

            // 注意：JTStore 默认会去重（相同 url 只存一条），
            const items = [
                { url: 'https://t.com/a.mp4', name: 'a.mp4', ext: 'mp4', size: 1000, time: Date.now() },
                { url: 'https://t.com/b.mp4', name: 'b.mp4', ext: 'mp4', size: 2000, time: Date.now() },
                { url: 'https://t.com/a.mp4', name: 'a.mp4', ext: 'mp4', size: 1000, time: Date.now() }
            ];
            items.forEach((i) => JTStore.add(tabId, i));

            return (JTStore.get(tabId) || []).length;
        });

        check('相同地址被自动去重（塞 3 条留 2 条）', seeded === 2, '实际 ' + seeded);

        // 按地址删一条
        const afterRemove = await sw.evaluate(() => {
            JTStore.removeByUrls(['https://t.com/b.mp4']);
            return (JTStore.get(777001) || []).length;
        });
        check('按地址删除后剩 1 条', afterRemove === 1, '实际 ' + afterRemove);

        // 查全部
        const all = await sw.evaluate(() => {
            const map = JTStore.getAll() || {};
            return Object.keys(map).length;
        });
        check('getAll 能列出标签页', all >= 1, all + ' 个');

        // 清空
        const afterClear = await sw.evaluate(() => {
            JTStore.remove(777001);
            return (JTStore.get(777001) || []).length;
        });
        check('清空后 0 条', afterClear === 0, '实际 ' + afterClear);
    }

    // ============================================================
    console.log('\n=== G. 后台：配置的边界 ===');
    // ============================================================

    {
        const cfg = await sw.evaluate(async () => {
            const out = {};

            // 写一个不存在的键不该崩
            try {
                await JTConfig.set({ __nonexistent_key__: 1 });
                out.unknownKeyOk = true;
            } catch (e) { out.unknownKeyOk = false; }

            // 读不存在的键返回 undefined 而不是抛错
            try {
                out.missing = JTConfig.get('__definitely_missing__') === undefined;
            } catch (e) { out.missing = false; }

            // 恢复默认
            try {
                await JTConfig.reset();
                out.resetOk = true;
            } catch (e) { out.resetOk = false; }

            return out;
        });

        check('写未知键不崩', cfg.unknownKeyOk);
        check('读未知键返回 undefined', cfg.missing);
        check('能恢复默认配置', cfg.resetOk);
    }

    // ============================================================

    // context.close() 偶尔会挂住（Chromium 进程不响应）。
    // 加个超时保护，关不掉就直接往下走，别拖死整个测试。
    await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 15000))
    ]);
    // 临时目录异步清理，不等待，
    fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});

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
