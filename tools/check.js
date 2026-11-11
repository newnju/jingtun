/** 鲸吞：静态一致性检查 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let problems = 0;

function rel(p) {
    return path.relative(ROOT, p).replace(/\\/g, '/');
}

function fail(msg) {
    problems++;
    console.log('  [x] ' + msg);
}

function ok(msg) {
    console.log('  [v] ' + msg);
}

/** 提示：不算问题，但值得人工确认 */
function warn(msg) {
    console.log('  [!] ' + msg);
}

/** 取 HTML 中所有 id="..." */
function htmlIds(htmlPath) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const ids = new Set();
    const re = /\sid\s*=\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) ids.add(m[1]);
    return ids;
}

/** 取 JS 中引用的元素 id */
function jsIdRefs(jsPath) {
    const src = fs.readFileSync(jsPath, 'utf8');
    const refs = new Set();
    // $('xxx')，页面里普遍这么取
    let re = /\$\('([^']+)'\)/g;
    let m;
    while ((m = re.exec(src)) !== null) refs.add(m[1]);
    // getElementById('xxx')
    re = /getElementById\('([^']+)'\)/g;
    while ((m = re.exec(src)) !== null) refs.add(m[1]);
    return refs;
}

// ---------------------------------------------------------------
// 1. 页面 ↔ 脚本 的 id 对应
// ---------------------------------------------------------------

const PAGES = [
    { html: 'popup.html', scripts: ['js/lib/utils.js', 'js/popup.js'] },
    { html: 'm3u8.html', scripts: ['js/lib/utils.js', 'js/m3u8.js', 'js/downloader.js', 'js/m3u8-ui.js'] },
    { html: 'preview.html', scripts: ['js/lib/utils.js', 'js/preview.js'] },
    { html: 'options.html', scripts: ['js/lib/utils.js', 'js/lib/config.js', 'js/options.js'] },
    // 下面两个是后加的页面。加页面时容易忘了往这里补，
    // 结果新页面完全不进检查，等于白写。
    { html: 'manage.html', scripts: ['js/lib/utils.js', 'js/lib/config.js', 'js/manage.js'] },
    { html: 'json.html', scripts: ['js/lib/utils.js', 'js/json.js'] },
    { html: 'downloader.html', scripts: ['js/lib/utils.js', 'js/downloader-page.js'] }
];

console.log('== 1. 元素 id 一致性 ==');
for (const page of PAGES) {
    const htmlPath = path.join(ROOT, page.html);
    const ids = htmlIds(htmlPath);
    let bad = 0;

    for (const s of page.scripts) {
        // 只检查业务脚本，lib 不碰 DOM
        if (s.indexOf('js/lib/') === 0) continue;

        const jsPath = path.join(ROOT, s);
        for (const id of jsIdRefs(jsPath)) {
            if (!ids.has(id)) {
                fail(`${s} 引用了 ${page.html} 中不存在的 id: #${id}`);
                bad++;
            }
        }
    }
    if (bad === 0) ok(`${page.html}：${ids.size} 个 id，脚本引用全部命中`);
}

// ---------------------------------------------------------------
// 1b. els 对象：用了但没定义
//
// 页面脚本普遍写成 `const els = { btnSave: $('btnSave'), ... }`，
// 然后到处 els.btnSave。
//
// 如果漏把某个元素放进 els，`els.btnXxx` 就是 undefined，
// 后面 `els.btnXxx.addEventListener(...)` 直接抛 TypeError，
// 而这行往往在初始化函数的前几行，整个页面无法继续初始化。
//
// 这类问题很阴：id 检查（上一节）查不出来，因为压根没写 $('btnXxx')；
// 语法检查也过，因为 undefined 是合法值。只有运行时才炸。
// ---------------------------------------------------------------

console.log('\n== 1b. els 对象定义完整性 ==');

for (const page of PAGES) {
    for (const s of page.scripts) {
        if (s.indexOf('js/lib/') === 0) continue;

        const jsPath = path.join(ROOT, s);
        if (!fs.existsSync(jsPath)) continue;

        const src = fs.readFileSync(jsPath, 'utf8');

        // 找 els 对象字面量
        const start = src.indexOf('const els = {');
        if (start === -1) continue;

        const end = src.indexOf('};', start);
        if (end === -1) continue;

        const block = src.slice(start, end);

        // els 里定义了哪些 key
        const defined = new Set();
        for (const mm of block.matchAll(/^\s+(\w+)\s*:/gm)) defined.add(mm[1]);

        // 全局用到了哪些 els.xxx
        const used = new Set();
        for (const mm of src.matchAll(/\bels\.(\w+)/g)) used.add(mm[1]);

        const undef = [...used].filter((k) => !defined.has(k));

        if (undef.length > 0) {
            fail(
                `${s} 用了未定义的 els 成员，运行时会抛 TypeError 导致页面空白：` +
                undef.map((k) => 'els.' + k).join(', ')
            );
        } else {
            ok(`${s}：els 定义 ${defined.size} 个成员，引用全部有定义`);
        }
    }
}

// ---------------------------------------------------------------
// 1c. 跨模块调用：JTxxx.foo() 是否真的存在
//
// 和 1b 是同一类问题：调用了一个不存在的东西。
// `JTUtils.foo()` 里 foo 没导出 → TypeError → 页面停住。
//
// 比 1b 更阴的是：有时调用方写了 `A.b ? A.b(x) : y` 这种守卫，
// 于是不报错，只是那个分支永远走不到，功能静默缺失，
// 控制台也没有报错。
// ---------------------------------------------------------------

console.log('\n== 1c. 跨模块调用 ==');

/** 命名空间 → 模块文件 */
const MODULES = {
    JTUtils: 'js/lib/utils.js',
    JTConfig: 'js/lib/config.js',
    JTStore: 'js/lib/store.js',
    JTTemplate: 'js/lib/template.js',
    JTMatcher: 'js/lib/matcher.js',
    JTFfmpeg: 'js/lib/ffmpeg.js',
    JTDownloader: 'js/downloader.js',
    JTM3u8: 'js/m3u8.js',
    JTMpd: 'js/mpd.js'
};

/** 模块里所有「可被导出的名字」 */
const moduleMembers = {};

for (const [ns, rel] of Object.entries(MODULES)) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) {
        moduleMembers[ns] = null;
        continue;
    }

    const text = fs.readFileSync(full, 'utf8');
    const set = new Set();

    for (const mm of text.matchAll(/(?:^|[\s;{])function\s+([A-Za-z_$][\w$]*)/g)) set.add(mm[1]);
    for (const mm of text.matchAll(/(?:^|[\s;{])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) set.add(mm[1]);
    for (const mm of text.matchAll(/(?:^|[\s;{])([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g)) set.add(mm[1]);
    for (const mm of text.matchAll(/(?:^|[\s;{])class\s+([A-Za-z_$][\w$]*)/g)) set.add(mm[1]);

    moduleMembers[ns] = set;
}

/** 内置/继承来的成员，不参与检查 */
const BUILTIN_MEMBERS = new Set([
    'prototype', 'name', 'length', 'call', 'apply', 'bind',
    'toString', 'valueOf', 'constructor'
]);

const callIssues = new Map();   // 'NS.member' -> Set(文件)

(function walkJs(dir) {
    for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);

        if (fs.statSync(p).isDirectory()) {
            walkJs(p);
            continue;
        }
        if (!f.endsWith('.js')) continue;
        if (p.indexOf('lib/ffmpeg') !== -1) continue;   // 第三方
        if (p.indexOf('tools') !== -1) continue;

        const text = fs.readFileSync(p, 'utf8');

        for (const [ns, members] of Object.entries(moduleMembers)) {
            if (!members) continue;

            const re = new RegExp('\\b' + ns + '\\.([A-Za-z_$][\\w$]*)', 'g');

            for (const mm of text.matchAll(re)) {
                const member = mm[1];
                if (BUILTIN_MEMBERS.has(member)) continue;
                if (members.has(member)) continue;

                const key = ns + '.' + member;
                if (!callIssues.has(key)) callIssues.set(key, new Set());
                callIssues.get(key).add(rel(p));
            }
        }
    }
})(path.join(ROOT, 'js'));

if (callIssues.size === 0) {
    ok('跨模块调用全部有对应定义');
} else {
    for (const [key, files] of callIssues) {
        fail(
            `${key} 在模块里找不到定义，会抛 TypeError，` +
            `或（若调用方有守卫）静默失效：${[...files].join(', ')}`
        );
    }
}

// ---------------------------------------------------------------
// 2. 消息类型：发出方 ↔ 后台处理
// ---------------------------------------------------------------

console.log('\n== 2. 消息类型一致性 ==');

const bgSrc = fs.readFileSync(path.join(ROOT, 'js/background.js'), 'utf8');
const handled = new Set();
let m2;
const caseRe = /case\s+'([^']+)'\s*:/g;
while ((m2 = caseRe.exec(bgSrc)) !== null) handled.add(m2[1]);

// 各页面/脚本发出的消息
const SENDERS = [
    'js/popup.js', 'js/m3u8-ui.js', 'js/preview.js', 'js/options.js',
    'js/content-script.js', 'js/offscreen.js'
];
const sent = new Map();   // type -> [文件]
for (const s of SENDERS) {
    const src = fs.readFileSync(path.join(ROOT, s), 'utf8');
    let mm;

    // 只在 sendMessage 的参数里找 type。
    const re = /sendMessage\s*\(\s*\{([^}]*)\}/g;

    while ((mm = re.exec(src)) !== null) {
        const typeMatch = mm[1].match(/type:\s*'([^']+)'/);
        if (!typeMatch) continue;

        const t = typeMatch[1];

        // 排除 Blob / File 的 MIME 之类，它们不是消息类型
        if (t.indexOf('/') !== -1) continue;

        if (!sent.has(t)) sent.set(t, []);
        sent.get(t).push(s);
    }

    // 三元表达式：type: cond ? 'a' : 'b'
    // 只认字面量的话，这种写法会被误判成"后台有分支却没人发"
    const reTernary = /type:\s*[^,\n]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g;
    while ((mm = reTernary.exec(src)) !== null) {
        for (const t of [mm[1], mm[2]]) {
            if (!sent.has(t)) sent.set(t, []);
            sent.get(t).push(s);
        }
    }

    // 有些脚本用内部包装函数间接发送，形如 report('xxx', payload)。
    // 只认 type: '...' 的话，这些会被误判成"后台有分支却没人发"。
    const reIndirect = /\breport\(\s*'([^']+)'/g;
    while ((mm = reIndirect.exec(src)) !== null) {
        const t = mm[1];
        if (!sent.has(t)) sent.set(t, []);
        sent.get(t).push(s);
    }
}

// 后台自己发出的（给弹窗/内容脚本），不算未处理
const FROM_BG = new Set(['media:add', 'capture:stop', 'jt:start', 'jt:stop']);

let missing = 0;
for (const [type, files] of sent) {
    if (handled.has(type)) continue;
    if (FROM_BG.has(type)) continue;
    fail(`消息 ${type}（来自 ${files.join(', ')}）在 background.js 中没有处理分支`);
    missing++;
}
if (missing === 0) {
    ok(`发出 ${sent.size} 种消息，后台均有对应处理`);
}

// 后台注册了但没人发的分支，多半是遗留，提示一下
const MENU_ACTION_IDS = new Set([
    'toggle-capture', 'deep-search', 'toggle-enable', 'clear-list'
]);

const unused = [];
for (const t of handled) {
    if (sent.has(t)) continue;
    if (t.indexOf('inject:') === 0) continue;
    if (t.indexOf('content:') === 0) continue;
    if (MENU_ACTION_IDS.has(t)) continue;
    unused.push(t);
}
if (unused.length > 0) {
    console.log('  [!] 后台有处理分支但未见调用（可能是注入脚本通过转发触发，需人工确认）:');
    console.log('      ' + unused.join(', '));
}

// ---------------------------------------------------------------
// 3. HTML 引用的资源是否存在
// ---------------------------------------------------------------

console.log('\n== 3. 资源引用 ==');

for (const file of fs.readdirSync(ROOT)) {
    if (!file.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const re = /(?:src|href)\s*=\s*"([^"]+)"/g;
    let mm;
    let bad = 0;
    while ((mm = re.exec(html)) !== null) {
        const ref = mm[1];
        if (/^(https?:|data:|#)/.test(ref)) continue;
        if (!fs.existsSync(path.join(ROOT, ref))) {
            fail(`${file} 引用了不存在的文件: ${ref}`);
            bad++;
        }
    }
    if (bad === 0) ok(`${file}：引用的本地资源均存在`);
}

// ---------------------------------------------------------------
// 3b. HTML 用的 class 是否都有样式
//
// 缺样式的表现不是报错，而是"能用但看着不对劲"：
// 说明文字和正文一样大、按钮挤成一坨、文本框没有边框。
// 这类问题不会有人主动报 bug，只会让人觉得"这软件有点糙"。
// ---------------------------------------------------------------

console.log('\n== 3b. 样式类完整性 ==');

for (const page of PAGES) {
    const cssRel = page.html.replace('.html', '.css');
    const cssPath = path.join(ROOT, 'css', path.basename(cssRel));

    if (!fs.existsSync(cssPath)) continue;

    const htmlText = fs.readFileSync(path.join(ROOT, page.html), 'utf8');
    const cssText = fs.readFileSync(cssPath, 'utf8');

    const usedClasses = new Set();
    for (const mm of htmlText.matchAll(/class="([^"]+)"/g)) {
        for (const c of mm[1].split(/\s+/)) {
            if (c) usedClasses.add(c);
        }
    }

    const definedClasses = new Set();
    for (const mm of cssText.matchAll(/\.([a-zA-Z][\w-]*)/g)) definedClasses.add(mm[1]);

    const missing = [...usedClasses].filter((c) => !definedClasses.has(c));

    if (missing.length > 0) {
        console.log(`  [!] ${page.html} 用了但 css 里没定义的 class: ${missing.join(', ')}`);
    } else {
        ok(`${page.html}：${usedClasses.size} 个 class 都有样式`);
    }
}

// ---------------------------------------------------------------
// 3c. hidden 属性保护
//
// `hidden` 依赖浏览器默认样式 `[hidden] { display: none }`。
// 作者样式优先级更高，如果 CSS 里写了
// `.drm-banner { display: flex }`，hidden 就会失效。
//
// 每个页面的样式表都需要补一条 [hidden] 规则。
// ---------------------------------------------------------------

console.log('\n== 3c. hidden 保护规则 ==');

const cssFiles = fs.existsSync(path.join(ROOT, 'css'))
    ? fs.readdirSync(path.join(ROOT, 'css')).filter((f) => f.endsWith('.css'))
    : [];

let missingGuard = 0;

for (const f of cssFiles) {
    const text = fs.readFileSync(path.join(ROOT, 'css', f), 'utf8');

    // 匹配 [hidden] { ... display: none ... }
    const hasGuard = /\[hidden\][^{]*\{[^}]*display\s*:\s*none/.test(text);

    if (!hasGuard) {
        fail(`css/${f} 缺 [hidden] 保护规则，带 display 的元素会关不掉`);
        missingGuard++;
    }
}

if (missingGuard === 0) {
    ok(`${cssFiles.length} 个样式表都有 [hidden] 保护规则`);
}

// ---------------------------------------------------------------
// 3d. 品牌标识必须是真图标，不能用 emoji
//
// 曾经用 emoji 当 logo，不同系统的显示效果不一致，
// 而且和工具栏里的真图标对不上，看起来像两个产品。
//
// 品牌位置（.mark / .brand / .logo）只认 icons/ 下的图。
// 静音、关闭这类功能图标不在此列。
// ---------------------------------------------------------------

console.log('\n== 3d. 品牌标识 ==');

const BRAND_CLASSES = /class="(mark|brand|logo|brand-icon|empty-icon)"/;

(function walkHtml(dir) {
    for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);

        if (fs.statSync(full).isDirectory()) {
            if (f === 'tools' || f === 'lib') continue;
            walkHtml(full);
            continue;
        }
        if (!f.endsWith('.html')) continue;

        const text = fs.readFileSync(full, 'utf8');
        const lines = text.split('\n');
        const bad = [];

        lines.forEach((line, i) => {
            if (!BRAND_CLASSES.test(line)) return;
            // 品牌区里出现了 emoji
            if (/[\u{1F300}-\u{1FAFF}]/u.test(line)) {
                bad.push((i + 1) + ': ' + line.trim().slice(0, 60));
            }
        });

        if (bad.length > 0) {
            fail(`${rel(full)} 的品牌区用了 emoji 而不是真图标：\n      ${bad.join('\n      ')}`);
        }
    }
})(ROOT);

ok('品牌标识都用的真图标');

// ---------------------------------------------------------------
// 4. manifest 引用的文件
// ---------------------------------------------------------------

console.log('\n== 4. manifest 引用 ==');

const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const mfRefs = [];
mfRefs.push(mf.background.service_worker);
mfRefs.push(mf.action.default_popup);
mfRefs.push(mf.options_ui.page);
for (const size of Object.keys(mf.icons)) mfRefs.push(mf.icons[size]);
for (const cs of mf.content_scripts) for (const f of cs.js) mfRefs.push(f);

let mfBad = 0;
for (const r of mfRefs) {
    if (!r) continue;
    if (!fs.existsSync(path.join(ROOT, r))) {
        fail(`manifest.json 引用了不存在的文件: ${r}`);
        mfBad++;
    }
}
if (mfBad === 0) ok(`manifest 引用的 ${mfRefs.length} 个文件均存在`);

// 权限与用到的 API 对照
/** API 前缀 → 所需权限 */
const API_PERMISSION = [
    { api: 'chrome.webRequest', perm: 'webRequest' },
    { api: 'chrome.downloads', perm: 'downloads' },
    { api: 'chrome.scripting', perm: 'scripting' },
    { api: 'chrome.tabs', perm: 'tabs' },
    { api: 'chrome.storage', perm: 'storage' },
    { api: 'chrome.webNavigation', perm: 'webNavigation' },
    { api: 'chrome.alarms', perm: 'alarms' },
    { api: 'chrome.offscreen', perm: 'offscreen' },
    { api: 'chrome.declarativeNetRequest', perm: 'declarativeNetRequest' },
    { api: 'chrome.contextMenus', perm: 'contextMenus' },
    { api: 'chrome.sidePanel', perm: 'sidePanel' },
    { api: 'chrome.cookies', perm: 'cookies' },
    { api: 'chrome.notifications', perm: 'notifications' },
    { api: 'chrome.declarativeContent', perm: 'declarativeContent' },
    { api: 'chrome.management', perm: 'management' },
    { api: 'chrome.bookmarks', perm: 'bookmarks' },
    { api: 'chrome.history', perm: 'history' },
    { api: 'chrome.idle', perm: 'idle' }
];

const allJs = [];
(function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.js')) allJs.push(p);
    }
})(path.join(ROOT, 'js'));

const combined = allJs.map((p) => fs.readFileSync(p, 'utf8')).join('\n');
for (const { api, perm } of API_PERMISSION) {
    if (combined.indexOf(api) !== -1 && mf.permissions.indexOf(perm) === -1) {
        fail(`代码用到 ${api}，但 manifest 未声明 ${perm} 权限`);
    }
}
ok('权限声明与代码所用 API 一致');

// 声明了但完全没用到的权限，属于冗余
for (const perm of mf.permissions) {
    const hit = API_PERMISSION.find((x) => x.perm === perm);
    if (hit && combined.indexOf(hit.api) === -1) {
        console.log(`  [!] 声明了 ${perm} 权限但代码中未使用，可考虑移除`);
    }
}

// offscreen document 是运行时创建的，manifest 里看不到它，
// 路径写错要等到真正用到那一刻才暴露，这里提前查出来
const offscreenRefs = [];
{
    const re = /createDocument\(\s*\{[\s\S]{0,300}?url:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(combined)) !== null) offscreenRefs.push(m[1]);
}
for (const r of offscreenRefs) {
    if (!fs.existsSync(path.join(ROOT, r))) {
        fail(`代码用 offscreen.createDocument 引用了不存在的文件: ${r}`);
    }
}
if (offscreenRefs.length > 0) {
    ok(`offscreen 文档路径有效：${offscreenRefs.join(', ')}`);
}

// ---------------------------------------------------------------
// 5. 多语言
// ---------------------------------------------------------------

console.log('\n== 5. 多语言 ==');

const mfRaw = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
const localesDir = path.join(ROOT, '_locales');

if (mfRaw.indexOf('__MSG_') !== -1) {
    // 用了 __MSG_ 就必须有 default_locale，否则 Chrome 直接拒绝加载
    if (!mf.default_locale) {
        fail('manifest 使用了 __MSG_ 但未声明 default_locale，Chrome 会拒绝加载');
    } else if (!fs.existsSync(path.join(localesDir, mf.default_locale, 'messages.json'))) {
        fail(`default_locale 为 ${mf.default_locale}，但 _locales/${mf.default_locale}/messages.json 不存在`);
    } else {
        ok(`default_locale = ${mf.default_locale}`);
    }

    // 收集 manifest 里用到的所有键
    const usedKeys = new Set();
    let km;
    const keyRe = /__MSG_([A-Za-z0-9_]+)__/g;
    while ((km = keyRe.exec(mfRaw)) !== null) usedKeys.add(km[1]);

    // 代码里用到的键
    for (const jsPath of allJs) {
        const src = fs.readFileSync(jsPath, 'utf8');
        let gm;
        // 直接调用
        const directRe = /getMessage\(\s*'([^']+)'/g;
        while ((gm = directRe.exec(src)) !== null) usedKeys.add(gm[1]);
        // 经 JTUtils.setTitle(key, fallback) 间接使用，键名同样是字面量
        const titleRe = /setTitle\(\s*'([^']+)'/g;
        while ((gm = titleRe.exec(src)) !== null) usedKeys.add(gm[1]);
    }

    // 各语言包是否覆盖了这些键
    if (fs.existsSync(localesDir)) {
        for (const lang of fs.readdirSync(localesDir)) {
            const msgPath = path.join(localesDir, lang, 'messages.json');
            if (!fs.existsSync(msgPath)) {
                fail(`_locales/${lang}/ 缺少 messages.json`);
                continue;
            }
            let msgs;
            try {
                msgs = JSON.parse(fs.readFileSync(msgPath, 'utf8'));
            } catch (e) {
                fail(`_locales/${lang}/messages.json 不是合法 JSON：${e.message}`);
                continue;
            }
            const missing = [];
            for (const k of usedKeys) {
                if (!msgs[k] || !msgs[k].message) missing.push(k);
            }
            if (missing.length > 0) {
                fail(`_locales/${lang} 缺少文案：${missing.join(', ')}`);
            } else {
                ok(`_locales/${lang}：${Object.keys(msgs).length} 条文案，覆盖全部 ${usedKeys.size} 个引用键`);
            }

            // 定义了但没人引用的键，多半是改名后的遗留
            const unusedKeys = Object.keys(msgs).filter((k) => !usedKeys.has(k));
            if (unusedKeys.length > 0) {
                console.log(`  [!] _locales/${lang} 有未被引用的文案：${unusedKeys.join(', ')}`);
            }
        }
    } else {
        fail('manifest 使用了 __MSG_ 但 _locales 目录不存在');
    }

    // 描述长度：Chrome 商店限制 132 字符
    for (const lang of fs.existsSync(localesDir) ? fs.readdirSync(localesDir) : []) {
        const msgPath = path.join(localesDir, lang, 'messages.json');
        if (!fs.existsSync(msgPath)) continue;
        const desc = JSON.parse(fs.readFileSync(msgPath, 'utf8')).extDesc;
        if (desc && desc.message && desc.message.length > 132) {
            fail(`_locales/${lang} 的描述 ${desc.message.length} 字符，超过 Chrome 商店的 132 上限`);
        }
    }
} else {
    ok('未使用 __MSG_，跳过');
}

// ---------------------------------------------------------------
// 6. 跨环境消息链路
//
// 页面 ↔ 内容脚本 ↔ 后台 ↔ 注入脚本，中间隔着三张映射表和两套
// 消息命名（jt:xxx / inject:xxx / capture:xxx）。任何一处对不上，
// 消息就静默消失，不报错，只是功能没反应，最难排查。
// ---------------------------------------------------------------

console.log('\n== 6. 跨环境消息链路 ==');

const CS_PATH = 'js/content-script.js';
const INJECT_DIR = 'js/inject';

/** 从 src 中截取从 startMarker 到其后第一个 endMarker 之间的文本 */
function slice(src, startMarker, endMarker) {
    const i = src.indexOf(startMarker);
    if (i === -1) return '';
    const j = src.indexOf(endMarker, i);
    return j === -1 ? src.slice(i) : src.slice(i, j);
}

/** 提取文本中所有单引号字符串字面量 */
function strings(text) {
    const out = [];
    const re = /'([^']+)'/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
}

/** 提取 'a': 'b' 形式的映射 */
function pairs(text) {
    const out = new Map();
    const re = /'([^']+)'\s*:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(text)) !== null) out.set(m[1], m[2]);
    return out;
}

const csSrc = fs.readFileSync(path.join(ROOT, CS_PATH), 'utf8');

const inbound = new Set(strings(slice(csSrc, 'INBOUND_ACTIONS = new Set([', ']);')));
const actionToMsg = pairs(slice(csSrc, 'ACTION_TO_MESSAGE = {', '};'));
const msgToAction = pairs(slice(csSrc, 'MESSAGE_TO_ACTION = {', '};'));

// 注入脚本：上报了哪些 action、处理了哪些 action
const reported = new Set();
/** JS 里的类型名。出现在 `typeof x === 'string'` 里，不是动作名。 */
const JS_TYPE_NAMES = new Set([
    'string', 'number', 'boolean', 'object', 'function', 'undefined', 'symbol', 'bigint'
]);

const handledActions = new Set();
for (const f of fs.readdirSync(path.join(ROOT, INJECT_DIR))) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(ROOT, INJECT_DIR, f), 'utf8');
    let m;

    // report('jt:xxx', ...) 或 postMessage({ action: 'jt:xxx'
    const reReport = /report\(\s*'([^']+)'/g;
    while ((m = reReport.exec(src)) !== null) reported.add(m[1]);
    const reAction = /action:\s*'([^']+)'/g;
    while ((m = reAction.exec(src)) !== null) reported.add(m[1]);

    // switch (data.action) 下的 case
    for (const c of strings(slice(src, 'switch (data.action)', 'default:'))) {
        handledActions.add(c);
    }

    // if (data.action === 'jt:xxx') 或 if (data.action !== 'jt:xxx') return
    // 只认 switch 的话，这种写法会被误判成「没有注入脚本处理」
    const reIfAction = /action\s*[!=]==?\s*'([^']+)'/g;
    while ((m = reIfAction.exec(src)) !== null) {
        const name = m[1];

        // 排除类型名：`typeof data.action === 'string'` 里的 'string'
        // 不是动作名，是类型判断
        if (JS_TYPE_NAMES.has(name)) continue;

        handledActions.add(name);
    }
}

// 后台发给内容脚本的消息类型
const bgToContent = new Set();
{
    const re = /tabs\.sendMessage\([^,]+,\s*\{\s*type:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(bgSrc)) !== null) bgToContent.add(m[1]);
}

// 有些指令是通过辅助函数间接发的（形如 sendRecordCommand(tabId, 'xxx')），
// 上面的正则抓不到，不补这一条就会误报"功能未接完"
const INDIRECT_SENDERS = ['sendRecordCommand'];
for (const fn of INDIRECT_SENDERS) {
    const re = new RegExp(fn + "\\([^,]+,\\s*'([^']+)'", 'g');
    let m;
    while ((m = re.exec(bgSrc)) !== null) bgToContent.add(m[1]);
}

const downActions = new Set(msgToAction.values());
let linkBad = 0;

// a. 注入脚本上报的 action 必须在白名单内，否则内容脚本直接丢弃
for (const a of reported) {
    if (!inbound.has(a)) {
        fail(`注入脚本上报 ${a}，但不在 INBOUND_ACTIONS 白名单中，消息会被内容脚本丢弃`);
        linkBad++;
    }
}

// b. 白名单里的每项都要有上行映射，否则收到也转发不出去
for (const a of inbound) {
    if (!actionToMsg.has(a)) {
        fail(`白名单中的 ${a} 没有 ACTION_TO_MESSAGE 映射，收到了也转发不出去`);
        linkBad++;
    }
}

// c. 上行映射的目标必须在后台有处理分支
for (const [action, msgType] of actionToMsg) {
    if (!inbound.has(action)) {
        fail(`ACTION_TO_MESSAGE 的键 ${action} 不在白名单中`);
        linkBad++;
    }
    if (!handled.has(msgType)) {
        fail(`ACTION_TO_MESSAGE 把 ${action} 映射到 ${msgType}，但后台没有该分支`);
        linkBad++;
    }
}

// d. 下行映射的目标必须有注入脚本处理
for (const [msgType, action] of msgToAction) {
    // 纯上报用的动作不算「处理」。
    if (reported.has(action)) continue;

    if (!handledActions.has(action)) {
        fail(`MESSAGE_TO_ACTION 把 ${msgType} 映射到 ${action}，但没有注入脚本处理它`);
        linkBad++;
    }
    // e. 下行映射的键必须真的有人发。
    //    映射表是开发者写下的意图，写了却不发 = 功能没接完，算失败。
    if (!bgToContent.has(msgType)) {
        fail(`MESSAGE_TO_ACTION 声明了 ${msgType}，但后台没有任何地方发送它，功能未接完`);
        linkBad++;
    }
}

// 注入脚本处理的 action 是否有来源（可能是刻意保留的能力，只提示）
for (const a of handledActions) {
    // 纯上报用的动作不需要下行指令，它自己就是消息的起点。
    if (reported.has(a)) continue;

    if (!downActions.has(a)) {
        warn(`注入脚本处理 ${a}，但 MESSAGE_TO_ACTION 中无对应项，没有指令会到达它`);
    }
}

// offscreen 消息链路：后台发过去的指令，offscreen 必须认得。
// 这条链路不走内容脚本，容易被漏掉。
const offscreenPath = path.join(ROOT, 'js/offscreen.js');
if (fs.existsSync(offscreenPath)) {
    const osSrc = fs.readFileSync(offscreenPath, 'utf8');
    const osHandled = new Set(strings(slice(osSrc, 'switch (message.type)', 'default:')));

    const bgToOffscreen = new Set();
    const reOs = /type:\s*'(offscreen:[^']+)'/g;
    let mo;
    while ((mo = reOs.exec(bgSrc)) !== null) bgToOffscreen.add(mo[1]);

    for (const t of bgToOffscreen) {
        if (!osHandled.has(t)) {
            fail(`后台发送 ${t}，但 js/offscreen.js 没有处理它`);
            linkBad++;
        }
    }
}

if (linkBad === 0) {
    ok(`链路自洽：${reported.size} 个上报 / ${actionToMsg.size} 个上行 / ${msgToAction.size} 个下行`);
}

// ---------------------------------------------------------------
// 7. 配置项是否有读取方
//
// 配置定义得好好的、设置页也有开关，但没有任何代码读取它，
// 用户改了设置却不生效，而且从代码上完全看不出来（定义、UI、
// 保存链路都是对的，只是没人用）。
// 反向查一遍引用就能抓出来，正向读代码几乎发现不了。
// ---------------------------------------------------------------

console.log('\n== 7. 配置项有效性 ==');

const configPath = path.join(ROOT, 'js/lib/config.js');

if (!fs.existsSync(configPath)) {
    ok('没有集中式配置文件，跳过');
} else {
    const cfgSrc = fs.readFileSync(configPath, 'utf8');
    const defaultsMatch = /const DEFAULTS = \{([\s\S]*?)\n    \};/.exec(cfgSrc);

    if (!defaultsMatch) {
        warn('找不到 DEFAULTS 定义，跳过');
    } else {
        const keys = [];
        const keyRe = /^\s{8}(\w+):/gm;
        let km;
        while ((km = keyRe.exec(defaultsMatch[1])) !== null) keys.push(km[1]);

        // config.js 自身的实现不算「读取方」
        const readers = allJs
            .filter((p) => !p.endsWith('config.js'))
            .map((p) => fs.readFileSync(p, 'utf8'));

        const optionsHtml = fs.existsSync(path.join(ROOT, 'options.html'))
            ? fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8')
            : '';

        const dead = [];
        const noUi = [];

        for (const key of keys) {
            // 外部文件直接读取
            let used = readers.some((src) => {
                const re = new RegExp("get\\(['\"]" + key + "['\"]|\\.\\b" + key + "\\b");
                return re.test(src);
            });

            // 有些配置是经由 config.js 内部的辅助方法生效的
            if (!used) {
                used = new RegExp("\\.\\b" + key + "\\b").test(cfgSrc);
            }

            if (!used) dead.push(key);

            if (optionsHtml.indexOf('id="' + key + '"') === -1) noUi.push(key);
        }

        if (dead.length > 0) {
            fail(`以下配置项没有任何代码读取，改了不生效：${dead.join(', ')}`);
        }
        if (noUi.length > 0) {
            warn(`以下配置项没有设置页 UI：${noUi.join(', ')}`);
        }
        if (dead.length === 0 && noUi.length === 0) {
            ok(`${keys.length} 个配置项全部有读取方与设置界面`);
        }
    }
}

// ---------------------------------------------------------------
// 8. 运行环境与扩展 API 的匹配
//
// 每个运行环境能用的扩展 API 是不一样的，用错了不会报错在明面上，
// 而是运行时才炸（甚至静默失败）：
//
//   · offscreen document，官方明确：只暴露 chrome.runtime，
//     其他一律不暴露。调 chrome.downloads 会直接 TypeError。
//   · 注入脚本（MAIN world）， 页面世界，任何扩展 API 都没有。
//   · Service Worker，无 DOM，没有 createObjectURL / localStorage。
//
// 这类问题人工审查很容易漏，扫一遍就出来了。
// ---------------------------------------------------------------

console.log('\n== 8. 运行环境与扩展 API 匹配 ==');

/** offscreen document 里唯一可用的扩展 API 命名空间 */
const OFFSCREEN_ALLOWED = ['chrome.runtime.'];

/** 收集一个文件里用到的所有扩展 API */
function collectApis(file) {
    const src = fs.readFileSync(file, 'utf8');
    const found = new Set();
    const re = /chrome\.[a-zA-Z]+\.[a-zA-Z]+/g;
    let m;
    while ((m = re.exec(src)) !== null) found.add(m[0]);
    return Array.from(found);
}

// --- offscreen 环境 ---
const OFFSCREEN_FILES = ['js/offscreen.js', 'js/lib/ffmpeg.js', 'js/downloader.js', 'js/m3u8.js', 'js/lib/utils.js'];
let envBad = 0;

for (const file of OFFSCREEN_FILES) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;

    const bad = collectApis(full).filter(
        (api) => !OFFSCREEN_ALLOWED.some((prefix) => api.startsWith(prefix))
    );

    if (bad.length > 0) {
        fail(`offscreen 里用了不可用的扩展 API：${file} → ${bad.join(', ')}`);
        envBad++;
    }
}

// --- 注入脚本环境（MAIN world，不该出现任何扩展 API）---
const injectDir = path.join(ROOT, 'js/inject');

if (fs.existsSync(injectDir)) {
    for (const f of fs.readdirSync(injectDir)) {
        if (!f.endsWith('.js')) continue;

        const full = path.join(injectDir, f);
        const used = collectApis(full);

        if (used.length > 0) {
            fail(`注入脚本运行在页面世界，用不了扩展 API：js/inject/${f} → ${used.join(', ')}`);
            envBad++;
        }
    }
}

if (envBad === 0) {
    ok('offscreen 与注入脚本都只用了各自环境允许的 API');
}

// ---------------------------------------------------------------
// 9. 注入脚本的文案 key 是否都在字典里
//
// 注入脚本拿不到 chrome.i18n，用的是自带的 i18n.js 字典。
// 用了字典里没有的 key，界面上就会直接显示 key 本身（比如 "panel.export"），
// 静态就能查出来，不该等用户发现。
// ---------------------------------------------------------------

console.log('\n== 9. 注入脚本文案 ==');

const i18nPath = path.join(ROOT, 'js/inject/i18n.js');

if (!fs.existsSync(i18nPath)) {
    console.log('  [!] 没有 i18n.js，跳过');
} else {
    const dictText = fs.readFileSync(i18nPath, 'utf8');

    // 从字典里抓出所有 key（形如 'panel.export':）
    const defined = new Set();
    for (const m of dictText.matchAll(/'([a-z]+\.[a-zA-Z]+)':/g)) {
        defined.add(m[1]);
    }

    // 收集各脚本实际用到的 key
    const used = new Map();   // key -> [文件]

    for (const f of fs.readdirSync(injectDir)) {
        if (!f.endsWith('.js') || f === 'i18n.js') continue;

        const full = path.join(injectDir, f);
        const text = fs.readFileSync(full, 'utf8');

        // 匹配 t('xxx.yyy') 形式
        for (const m of text.matchAll(/\bt\(\s*'([a-z]+\.[a-zA-Z]+)'/g)) {
            if (!used.has(m[1])) used.set(m[1], []);
            used.get(m[1]).push(f);
        }
    }

    const missing = [];
    for (const [key, files] of used) {
        if (!defined.has(key)) missing.push(key + '  (' + [...new Set(files)].join(', ') + ')');
    }

    if (missing.length > 0) {
        fail('用了字典里没有的文案 key，界面上会直接显示 key：' + missing.join('; '));
    } else {
        ok('用到的 ' + used.size + ' 个文案 key 都在字典里（字典共 ' + defined.size + ' 条）');
    }

    // 反向：字典里定义了但没人用的（可能是删代码时忘了清）
    const unused = [...defined].filter((k) => !used.has(k));
    if (unused.length > 0) {
        console.log('  [!] 字典里 ' + unused.length + ' 条没被用到，可考虑清理：' + unused.slice(0, 6).join(', '));
    }
}

// ---------------------------------------------------------------

console.log('\n' + '='.repeat(46));
if (problems === 0) {
    console.log('全部检查通过');
} else {
    console.log(`发现 ${problems} 个问题`);
}
process.exit(problems === 0 ? 0 : 1);
