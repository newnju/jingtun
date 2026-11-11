/** 注入脚本与兼容层的测试 */
const fs = require('fs');
const path = require('path');

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

/**
 * 从源码里抠出一个函数（含函数体，靠花括号配对）
 * @param {string} src
 * @param {string} name
 * @returns {string|null}
 */
function extractFn(src, name) {
    const sig = 'function ' + name + '(';
    const start = src.indexOf(sig);
    if (start === -1) return null;

    let depth = 0;
    let i = src.indexOf('{', start);
    if (i === -1) return null;

    for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    return null;
}

/** 把抠出来的函数编译成可调用的 */
function compile(fnSrc, deps) {
    const names = Object.keys(deps || {});
    const values = names.map((n) => deps[n]);
    return new Function(names.join(','), 'return (' + fnSrc + ');')(...values);
}

// ============================================================
console.log('=== 1. media-control：截图文件名 ===');
// 依赖：document.title
// 要防的问题：标题里有 / : * ? " < > | 时，文件名会非法（Windows 直接拒绝保存）
// ============================================================

{
    const src = read('js/inject/media-control.js');
    const fnSrc = extractFn(src, 'buildShotName');

    check('抠出了 buildShotName', !!fnSrc);

    if (fnSrc) {
        const mk = (title) => {
            const doc = { title: title };
            const fn = compile(fnSrc, { document: doc });
            return fn;
        };

        const fn = mk('测试视频');
        const name = fn(65);   // 65 秒 = 01m05s

        check('基本格式正确', /^测试视频_01m05s\.png$/.test(name), name);

        // 时/分/秒的进位
        const fn2 = mk('x');
        check('满一小时带 h', /_1h00m00s\.png$/.test(fn2(3600)), fn2(3600));
        check('59 分钟不进位', /_59m59s\.png$/.test(fn2(3599)), fn2(3599));
        check('0 秒', /_00m00s\.png$/.test(fn2(0)), fn2(0));

        // 非法字符必须被替换
        const fn3 = mk('a/b:c*d?e"f<g>h|i');
        const dirty = fn3(1);
        check('非法字符被替换成下划线',
            !/[\\/:*?"<>|]/.test(dirty) && dirty.indexOf('_') !== -1, dirty);

        // 空标题要有默认值
        const fn4 = mk('');
        check('空标题有回退', /^screenshot_/.test(fn4(1)), fn4(1));

        const fn5 = mk('   ');
        check('纯空格标题也有回退', /^screenshot_/.test(fn5(1)), fn5(1));

        // 超长标题要截断（否则文件名超长会失败）
        const fn6 = mk('あ'.repeat(200));
        const long = fn6(1);
        check('超长标题被截断', long.length < 100, '长度 ' + long.length);
    }
}

// ============================================================
console.log('\n=== 2. recorder：MIME 选择与文件名 ===');
// 要防的问题：挑了一个浏览器不支持的 MIME，录出来是 0 字节
// ============================================================

{
    const src = read('js/inject/recorder.js');

    // --- pickMimeType ---
    const pickSrc = extractFn(src, 'pickMimeType');
    check('抠出了 pickMimeType', !!pickSrc);

    if (pickSrc) {
        // 场景 A：全都支持 → 应该挑最优先的（vp9）
        const allYes = {
            MediaRecorder: {
                isTypeSupported: () => true
            }
        };
        const pick1 = compile(pickSrc, allYes);
        check('全支持时选 vp9', /vp9/.test(pick1()), pick1());

        // 场景 B：只支持 webm（不带 codecs）
        const onlyWebm = {
            MediaRecorder: {
                isTypeSupported: (t) => t === 'video/webm'
            }
        };
        const pick2 = compile(pickSrc, onlyWebm);
        check('只支持裸 webm 时选它', pick2() === 'video/webm', pick2());

        // 场景 C：只支持 mp4
        const onlyMp4 = {
            MediaRecorder: {
                isTypeSupported: (t) => t === 'video/mp4'
            }
        };
        const pick3 = compile(pickSrc, onlyMp4);
        check('只支持 mp4 时选它', pick3() === 'video/mp4', pick3());

        // 场景 D：什么都不支持 → 返回空串（而不是抛错）
        const none = {
            MediaRecorder: {
                isTypeSupported: () => false
            }
        };
        const pick4 = compile(pickSrc, none);
        check('都不支持时返回空串', pick4() === '', JSON.stringify(pick4()));

        // 场景 E：MediaRecorder 根本不存在 → 也返回空串
        const noApi = {};
        const pick5 = compile(pickSrc, noApi);
        check('没有 MediaRecorder 时返回空串', pick5() === '', JSON.stringify(pick5()));

        // 场景 F：没有 isTypeSupported（老浏览器）→ 返回空串而不是抛错
        const noCheck = { MediaRecorder: {} };
        const pick6 = compile(pickSrc, noCheck);
        check('缺 isTypeSupported 时不抛错', pick6() === '', JSON.stringify(pick6()));
    }

    // --- buildFileName ---
    const nameSrc = extractFn(src, 'buildFileName');
    check('抠出了 buildFileName', !!nameSrc);

    if (nameSrc) {
        const mkName = (title, index, ext) => {
            const doc = { title: title };
            const t = (key, params, fallback) => fallback;
            const fn = compile(nameSrc, { document: doc, t: t });
            return fn(index, ext);
        };

        check('单文件不带序号', mkName('片子', 1, 'webm') === '片子_录制.webm',
            mkName('片子', 1, 'webm'));
        check('多文件带序号', mkName('片子', 2, 'webm') === '片子_录制_2.webm',
            mkName('片子', 2, 'webm'));

        const dirty = mkName('a/b:c*d?e', 1, 'webm');
        check('文件名净化非法字符', !/[\\/:*?"<>|]/.test(dirty), dirty);

        check('空标题有回退', /^recording/.test(mkName('', 1, 'webm')),
            mkName('', 1, 'webm'));
    }
}

// ============================================================
console.log('\n=== 3. region：MIME 选择 ===');
// 区域录制和普通录制是两份独立实现，得分别测，
// 修了一处忘了另一处，是这类重复代码的经典问题。
// ============================================================

{
    const src = read('js/inject/region.js');
    const pickSrc = extractFn(src, 'pickMimeType');

    check('抠出了 pickMimeType', !!pickSrc);

    if (pickSrc) {
        const yes = { MediaRecorder: { isTypeSupported: () => true } };
        const no = { MediaRecorder: { isTypeSupported: () => false } };

        check('全支持时有返回值', /webm|mp4/.test(compile(pickSrc, yes)()));
        check('都不支持时返回空串', compile(pickSrc, no)() === '');
        check('缺 API 时不抛错', compile(pickSrc, {})() === '');
    }

    // 两份实现的行为要一致
    const recorderSrc = read('js/inject/recorder.js');
    const rPick = extractFn(recorderSrc, 'pickMimeType');
    if (pickSrc && rPick) {
        const env = { MediaRecorder: { isTypeSupported: (t) => t.indexOf('vp8') !== -1 } };
        const a = compile(pickSrc, env)();
        const b = compile(rPick, env)();
        check('recorder 与 region 的 MIME 选择一致', a === b,
            'recorder=' + JSON.stringify(b) + ' region=' + JSON.stringify(a));
    }
}

// ============================================================
console.log('\n=== 4. polyfill：缺 API 时的回退 ===');
// 这是"让扩展在残缺环境里活下来"的最后一道防线。
// 回退本身写错，等于没有。
// ============================================================

{
    const src = read('js/lib/polyfill.js');

    // 在沙箱里跑整个 polyfill
    function runPolyfill(chromeStub) {
        const sandbox = {
            chrome: chromeStub,
            document: {
                createElement: () => ({
                    style: {},
                    click: function () { this.__clicked = true; },
                    setAttribute: function () {}
                }),
                body: {
                    appendChild: function () {},
                    removeChild: function () {}
                }
            },
            setTimeout: setTimeout,
            console: console
        };

        const vm = require('vm');
        const ctx = vm.createContext(sandbox);
        vm.runInContext(src, ctx);
        return sandbox.chrome;
    }

    // --- i18n 回退 ---
    {
        const chrome = runPolyfill({});
        check('补出了 chrome.i18n', !!chrome.i18n);
        check('i18n.getMessage 存在', typeof chrome.i18n.getMessage === 'function');
        check('i18n.getMessage 返回键名而不是 undefined',
            chrome.i18n.getMessage('someKey') === 'someKey',
            chrome.i18n.getMessage('someKey'));
        check('i18n.getMessage 对空输入不抛错',
            typeof chrome.i18n.getMessage('') === 'string');
    }

    // --- downloads 回退 ---
    {
        const chrome = runPolyfill({});
        check('补出了 chrome.downloads', !!chrome.downloads);
        check('downloads.download 存在', typeof chrome.downloads.download === 'function');

        // 调一下，看会不会抛
        let called = false;
        let arg;
        try {
            chrome.downloads.download({ url: 'https://a.com/x.mp4', filename: 'x.mp4' },
                function (id) { called = true; arg = id; });
        } catch (e) {
            // 不该走到这
        }
        check('downloads.download 能调用且回调被触发', called);

        check('downloads.onChanged 有 addListener',
            chrome.downloads.onChanged && typeof chrome.downloads.onChanged.addListener === 'function');
        check('downloads.showDefaultFolder 存在',
            typeof chrome.downloads.showDefaultFolder === 'function');
    }

    // --- 已有 API 不该被覆盖 ---
    {
        const original = function () { return 'original'; };
        const chrome = runPolyfill({
            i18n: { getMessage: original },
            downloads: { download: original }
        });

        check('已有的 i18n.getMessage 不被覆盖',
            chrome.i18n.getMessage('x') === 'original');
        check('已有的 downloads.download 不被覆盖',
            chrome.downloads.download() === 'original');
    }

    // --- 没有 chrome 对象时不该抛错 ---
    {
        const vm = require('vm');
        let threw = false;
        try {
            vm.runInNewContext(src, { console: console });
        } catch (e) {
            threw = true;
        }
        check('chrome 不存在时安全退出', !threw);
    }
}

// ============================================================
console.log('\n=== 5. install 页脚本 ===');
// 很小，但也要保证「点按钮能关掉」这条路径是通的
// ============================================================

{
    const src = read('js/install.js');

    check('有 btnOk 的绑定', /btnOk/.test(src));
    check('绑的是 click', /addEventListener\('click'/.test(src));

    // 不该引用不存在的元素
    const ids = [...src.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
    const html = read('install.html');
    const missing = ids.filter((id) => html.indexOf('id="' + id + '"') === -1);
    check('引用的元素在 HTML 里都存在', missing.length === 0, missing.join(', '));

    // 沙箱里跑一遍，确认不抛错
    const vm = require('vm');
    const sandbox = {
        document: {
            getElementById: () => ({
                addEventListener: function () {},
                textContent: '',
                hidden: false
            }),
            querySelectorAll: () => [],
            body: { classList: { add: function () {} } }
        },
        chrome: { tabs: { create: function () {}, getCurrent: function () {} } },
        window: { close: function () {} },
        console: console
    };

    let threw = false;
    try {
        vm.runInNewContext(src, sandbox);
    } catch (e) {
        threw = true;
        console.log('        ' + e.message.slice(0, 80));
    }
    check('install.js 在沙箱里不抛错', !threw);
}

// ============================================================

console.log('\n' + '='.repeat(46));
console.log(failed === 0
    ? '全部通过（' + passed + ' 项）'
    : '通过 ' + passed + ' 项，失败 ' + failed + ' 项');

process.exit(failed === 0 ? 0 : 1);
