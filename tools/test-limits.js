/** 边界与性能测试 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

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

/** 在沙箱里加载一个库（这些库都是 IIFE + 挂到 self 上） */
function loadLib(file, extra) {
    const sandbox = Object.assign({
        console: console,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        Promise: Promise,
        Date: Date,
        Math: Math,
        JSON: JSON,
        RegExp: RegExp,
        Set: Set,
        Map: Map,
        Array: Array,
        Object: Object,
        String: String,
        Number: Number,
        Error: Error,
        isNaN: isNaN
    }, extra || {});

    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;

    const ctx = vm.createContext(sandbox);
    vm.runInContext(read(file), ctx, { filename: file });

    return sandbox;
}

// ============================================================
console.log('=== 1. 工具函数：极端输入 ===');
// ============================================================

{
    const lib = loadLib('js/lib/utils.js');
    const U = lib.JTUtils;

    check('JTUtils 加载成功', !!U);

    if (U) {
        // --- byteToSize ---
        const sizeCases = [
            [0, /0|B/],
            [1, /B/],
            [1023, /B/],
            [1024, /KB/i],
            [1048576, /MB/i],
            [1073741824, /GB/i],
            [1099511627776, /TB/i]
        ];

        for (const [bytes, expect] of sizeCases) {
            const got = String(U.byteToSize(bytes));
            check('byteToSize(' + bytes + ') → ' + got, expect.test(got));
        }

        // 负数与 NaN 不该崩
        check('byteToSize 对负数不崩', typeof U.byteToSize(-1) === 'string');
        check('byteToSize 对 NaN 不崩', typeof U.byteToSize(NaN) === 'string');
        check('byteToSize 对 undefined 不崩', typeof U.byteToSize(undefined) === 'string');

        // --- quickExt ---
        const extCases = [
            ['https://a.com/v.mp4', 'mp4'],
            ['https://a.com/v.mp4?a=1&b=2', 'mp4'],
            ['https://a.com/v.MP4', 'mp4'],
            ['https://a.com/a/b/c.m3u8#frag', 'm3u8'],
            ['https://a.com/noext', ''],
            ['not a url', ''],
            ['', '']
        ];

        for (const [url, expect] of extCases) {
            const got = U.quickExt(url);
            check('quickExt(' + JSON.stringify(url.slice(0, 32)) + ') = ' + JSON.stringify(got),
                got === expect, '期望 ' + JSON.stringify(expect));
        }

        // 超长 URL 不该卡住
        const longUrl = 'https://a.com/' + 'x'.repeat(100000) + '.mp4';
        const t0 = Date.now();
        U.quickExt(longUrl);
        check('quickExt 处理 100KB 的 URL 不超时', Date.now() - t0 < 500,
            (Date.now() - t0) + 'ms');

        // --- sanitizeFileName ---
        const dirty = 'a/b\\c:d*e?f"g<h>i|j\u0000k\u001fl';
        const clean = U.sanitizeFileName(dirty);
        check('sanitizeFileName 去掉所有非法字符',
            !/[\\/:*?"<>|\u0000-\u001f]/.test(clean), clean);

        check('sanitizeFileName 处理超长输入',
            U.sanitizeFileName('x'.repeat(5000)).length <= 5000);

        // --- safeHostname ---
        check('safeHostname 对畸形输入不抛错',
            typeof U.safeHostname('http://[bad') === 'string');
        check('safeHostname 对 null 不抛错',
            typeof U.safeHostname(null) === 'string');

        // --- secToTime ---
        check('secToTime(0)', /0/.test(String(U.secToTime(0))));
        check('secToTime(3661) 含 1:01:01 或类似',
            /1.*01.*01/.test(String(U.secToTime(3661))), String(U.secToTime(3661)));
        check('secToTime 对超大值不崩',
            typeof U.secToTime(999999999) === 'string');
    }
}

// ============================================================
console.log('\n=== 2. 匹配器：病态输入 ===');
// 用户会写各种正则，包括能把自己卡死的
// ============================================================

{
    const lib = loadLib('js/lib/matcher.js', {
        JTUtils: loadLib('js/lib/utils.js').JTUtils
    });
    const M = lib.JTMatcher;

    check('JTMatcher 加载成功', !!M);

    if (M) {
        // 畸形正则不该抛
        const badPatterns = ['[', '(', '*', '(?<', '\\', '[a-', 'a{2,1}'];
        for (const p of badPatterns) {
            let threw = false;
            try {
                M.test ? M.test(p, 'sample') : null;
            } catch (e) {
                threw = true;
            }
            check('畸形正则 ' + JSON.stringify(p) + ' 不抛错', !threw);
        }

        // 超长输入不该卡住
        if (M.test) {
            const t0 = Date.now();
            try {
                M.test('.*', 'x'.repeat(200000));
            } catch (e) { /* 允许失败 */ }
            check('超长输入不卡住', Date.now() - t0 < 2000, (Date.now() - t0) + 'ms');
        }
    }
}

// ============================================================
console.log('\n=== 3. 存储：大列表与边界 ===');
// ============================================================

{
    // store 依赖 chrome.storage，用桩代替
    const storage = {};
    const listeners = [];

    const lib = loadLib('js/lib/store.js', {
        JTConfig: {
            get: () => ({ maxItems: 5000, checkDuplicates: true }),
            onChange: function () {},
            on: function () {}
        },
        chrome: {
            storage: {
                local: {
                    get: function (keys, cb) {
                        const out = {};
                        if (typeof keys === 'string') out[keys] = storage[keys];
                        else if (Array.isArray(keys)) keys.forEach((k) => { out[k] = storage[k]; });
                        else Object.assign(out, storage);
                        if (cb) { cb(out); return; }
                        return Promise.resolve(out);
                    },
                    set: function (obj, cb) {
                        Object.assign(storage, obj);
                        if (cb) cb();
                        return Promise.resolve();
                    },
                    remove: function (keys, cb) {
                        (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete storage[k]);
                        if (cb) cb();
                        return Promise.resolve();
                    }
                },
                onChanged: {
                    addListener: function (fn) { listeners.push(fn); }
                }
            }
        }
    });

    const S = lib.JTStore;
    check('JTStore 加载成功', !!S);

    if (S) {
        // --- 大量插入 ---
        const N = 2000;
        const t0 = Date.now();

        for (let i = 0; i < N; i++) {
            S.add(1, {
                url: 'https://a.com/v' + i + '.mp4',
                name: 'v' + i + '.mp4',
                ext: 'mp4',
                size: i,
                time: Date.now()
            });
        }

        const insertMs = Date.now() - t0;
        const list = S.get(1) || [];

        check('插入 ' + N + ' 条耗时合理', insertMs < 5000, insertMs + 'ms');
        check('插入后条数正确', list.length === N, '实际 ' + list.length);

        // --- 大量查询 ---
        const t1 = Date.now();
        for (let i = 0; i < 1000; i++) {
            S.get(1);
        }
        const getMs = Date.now() - t1;
        check('1000 次 get 不慢', getMs < 2000, getMs + 'ms');

        // --- 去重 ---
        S.add(1, {
            url: 'https://a.com/v0.mp4',
            name: 'dup.mp4', ext: 'mp4', size: 1, time: Date.now()
        });
        check('重复地址被去重', (S.get(1) || []).length === N,
            '实际 ' + (S.get(1) || []).length);

        // --- 删不存在的 ---
        let threw = false;
        try {
            S.removeByUrls(['https://nonexistent.com/x.mp4']);
            S.remove(999999);
        } catch (e) {
            threw = true;
        }
        check('删不存在的条目不抛错', !threw);

        // --- 畸形条目 ---
        threw = false;
        try {
            S.add(1, {});
            S.add(1, null);
            S.add(1, { url: '' });
            S.add(1, { url: 'https://a.com/' + 'x'.repeat(50000) + '.mp4' });
        } catch (e) {
            threw = true;
        }
        check('插入畸形条目不抛错', !threw);

        // --- 计数 ---
        check('count 与 get 一致',
            S.count(1) === (S.get(1) || []).length);

        // --- 清空 ---
        S.remove(1);
        check('清空后为 0', (S.get(1) || []).length === 0);
    }
}

// ============================================================
console.log('\n=== 4. 模板渲染：注入与畸形输入 ===');
// ============================================================

{
    const lib = loadLib('js/lib/template.js');
    const T = lib.JTTemplate;

    check('JTTemplate 加载成功', !!T);

    if (T && T.render) {
        // 变量不存在时不该崩，也不该输出 undefined
        const out = String(T.render('${missing}', {}));
        check('缺失变量不输出 undefined', out.indexOf('undefined') === -1, out);

        // 超长模板
        let threw = false;
        try {
            T.render('x'.repeat(50000), {});
        } catch (e) {
            threw = true;
        }
        check('超长模板不抛错', !threw);

        // 畸形模板
        threw = false;
        try {
            T.render('${unclosed', {});
            T.render('${', {});
            T.render('$', {});
        } catch (e) {
            threw = true;
        }
        check('畸形模板不抛错', !threw);

        // null / undefined
        threw = false;
        try {
            T.render(null, {});
            T.render(undefined, {});
        } catch (e) {
            threw = true;
        }
        check('null/undefined 模板不抛错', !threw);
    }
}

// ============================================================
console.log('\n=== 5. 配置：极端值 ===');
// ============================================================

{
    const storage = {};

    const lib = loadLib('js/lib/config.js', {
        chrome: {
            storage: {
                local: {
                    get: function (keys, cb) {
                        const out = {};
                        if (typeof keys === 'string') out[keys] = storage[keys];
                        else if (Array.isArray(keys)) keys.forEach((k) => { out[k] = storage[k]; });
                        else Object.assign(out, storage);
                        if (cb) { cb(out); return; }
                        return Promise.resolve(out);
                    },
                    set: function (obj, cb) {
                        Object.assign(storage, obj);
                        if (cb) cb();
                        return Promise.resolve();
                    }
                },
                onChanged: { addListener: function () {} }
            },
            runtime: { lastError: null }
        }
    });

    const C = lib.JTConfig;
    check('JTConfig 加载成功', !!C);

    if (C) {
        // 默认值应该齐全
        const def = C.get();
        check('默认配置是个对象', def && typeof def === 'object');
        check('默认配置有不少键', Object.keys(def || {}).length > 10,
            Object.keys(def || {}).length + ' 个');

        // 写极端值不该崩
        let threw = false;
        try {
            C.set({
                downloadDir: 'x'.repeat(10000),
                maxItems: -1,
                someUnknownKey: { nested: { deep: true } }
            });
        } catch (e) {
            threw = true;
        }
        check('写极端值不抛错', !threw);

        // 读不存在的键
        check('读不存在的键返回 undefined',
            C.get('__definitely_not_here__') === undefined);

        // 传 null 不该崩
        threw = false;
        try {
            C.set(null);
        } catch (e) {
            threw = true;
        }
        check('set(null) 不抛错', !threw);
    }
}

// ============================================================

console.log('\n' + '='.repeat(46));
console.log(failed === 0
    ? '全部通过（' + passed + ' 项）'
    : '通过 ' + passed + ' 项，失败 ' + failed + ' 项');

process.exit(failed === 0 ? 0 : 1);
