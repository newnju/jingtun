/** 注入层文案的测试 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'js/inject/i18n.js');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
    if (cond) {
        passed++;
    } else {
        failed++;
        console.log('  [x] ' + name + (detail ? '  → ' + detail : ''));
    }
}

/**
 * 在沙箱里加载 i18n.js 并取回字典
 * @param {string} lang navigator.language 的值
 * @returns {Object} { lang, get }
 */
function loadDict(lang) {
    const code = fs.readFileSync(SRC, 'utf8');

    const sandbox = {
        navigator: { language: lang, languages: [lang] },
        self: null,
        console: console
    };
    sandbox.self = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    return sandbox.self.__JINGTUN_I18N__;
}

// ============================================================
// 1. 语言选择
// ============================================================

const zh = loadDict('zh-CN');
const en = loadDict('en-US');

check('zh-CN 应选中中文', zh && zh.lang === 'zh', zh && zh.lang);
check('en-US 应选中英文', en && en.lang === 'en', en && en.lang);
check('zh-TW 也应选中中文（都算 zh）', loadDict('zh-TW').lang === 'zh');
check('不认识的语言退回英文', loadDict('de-DE').lang === 'en');

// ============================================================
// 2. 两个字典的 key 必须完全一致
//
// 这是最要紧的一项：key 对不上意味着某个语言下会露出 key 原文。
// ============================================================

// 从源码里分别抓出 ZH 和 EN 两个对象的 key
const src = fs.readFileSync(SRC, 'utf8');

const zhBlock = src.slice(src.indexOf('const ZH = {'), src.indexOf('const EN = {'));
const enBlock = src.slice(src.indexOf('const EN = {'), src.indexOf('function pickTable'));

function keysOf(block) {
    const set = new Set();
    for (const m of block.matchAll(/'([a-z]+\.[a-zA-Z]+)':/g)) set.add(m[1]);
    return set;
}

const zhKeys = keysOf(zhBlock);
const enKeys = keysOf(enBlock);

check('中文字典非空', zhKeys.size > 0, zhKeys.size + ' 条');
check('英文字典非空', enKeys.size > 0, enKeys.size + ' 条');

const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k));
const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k));

check('中文有、英文没有的 key', onlyZh.length === 0, onlyZh.join(', '));
check('英文有、中文没有的 key', onlyEn.length === 0, onlyEn.join(', '));

// ============================================================
// 3. 占位符必须两边对得上
//
// 中文写了 {msg} 英文漏了，英文下就看不到具体错误信息。
// ============================================================

function placeholdersOf(block) {
    const map = new Map();
    for (const m of block.matchAll(/'([a-z]+\.[a-zA-Z]+)':\s*'((?:[^'\\]|\\.)*)'/g)) {
        const names = [...m[2].matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
        map.set(m[1], names.join(','));
    }
    return map;
}

const zhPh = placeholdersOf(zhBlock);
const enPh = placeholdersOf(enBlock);

const phMismatch = [];
for (const [key, names] of zhPh) {
    if (enPh.has(key) && enPh.get(key) !== names) {
        phMismatch.push(key + ' (中:[' + names + '] 英:[' + enPh.get(key) + '])');
    }
}

check('中英占位符一致', phMismatch.length === 0, phMismatch.join('; '));

// ============================================================
// 4. 取值与替换
// ============================================================

check('取得到中文文案', zh.get('panel.export') === '导出', zh.get('panel.export'));
check('取得到英文文案', en.get('panel.export') === 'Export', en.get('panel.export'));

check(
    '未知 key 返回 key 本身（便于发现漏翻）',
    zh.get('nope.missing') === 'nope.missing',
    zh.get('nope.missing')
);

check(
    '中文占位符替换',
    zh.get('panel.captured', { size: '12 MB', part: 2 }) === '已捕获 12 MB · 第 2 段',
    zh.get('panel.captured', { size: '12 MB', part: 2 })
);

check(
    '英文占位符替换',
    en.get('panel.captured', { size: '12 MB', part: 2 }) === 'Captured 12 MB · part 2',
    en.get('panel.captured', { size: '12 MB', part: 2 })
);

check(
    '缺参数时保留占位符原样，不出现 undefined',
    zh.get('panel.captured', { size: '1 MB' }).indexOf('undefined') === -1,
    zh.get('panel.captured', { size: '1 MB' })
);

// ============================================================
// 5. 幂等：重复注入不应覆盖已有字典
// ============================================================

const sandbox2 = {
    navigator: { language: 'en-US', languages: ['en-US'] },
    self: null,
    console: console
};
sandbox2.self = sandbox2;
vm.createContext(sandbox2);

const code = fs.readFileSync(SRC, 'utf8');
vm.runInContext(code, sandbox2);
const first = sandbox2.self.__JINGTUN_I18N__;
vm.runInContext(code, sandbox2);
const second = sandbox2.self.__JINGTUN_I18N__;

check('重复注入不覆盖已有字典', first === second);

// ============================================================

console.log('\n' + '='.repeat(46));
if (failed === 0) {
    console.log('全部通过（' + passed + ' 项）');
} else {
    console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
}
process.exit(failed === 0 ? 0 : 1);
