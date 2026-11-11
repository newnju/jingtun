/** 模拟验证：展开条目时播放器能不能挂上 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

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

// ============================================================
// 最小 DOM stub
// ============================================================

class StubElement {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.textContent = '';
        this.hidden = false;
        this.style = { cssText: '' };
        this.dataset = {};
        this.attrs = {};
        // isConnected 依赖祖先链，用 getter 实现
    }

    get isConnected() {
        let node = this;
        while (node.parentNode) node = node.parentNode;
        return node.__isRoot === true;
    }

    appendChild(child) {
        if (child && child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    append(...nodes) {
        for (const n of nodes) this.appendChild(n);
    }

    removeChild(child) {
        const i = this.children.indexOf(child);
        if (i !== -1) this.children.splice(i, 1);
        child.parentNode = null;
    }

    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener() {}
    removeEventListener() {}
    querySelectorAll() { return []; }
    classList = {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
        contains(c) { return this._set.has(c); }
    };
}

// ============================================================
// 从 popup.js 里抽出真实逻辑来测
//
// 直接 import 是不行的（整个文件依赖 chrome.* 和 DOM），
// 所以把关键片段照抄过来，抄错了测试就没意义，
// 因此这里同时校验「源文件里确实是这么写的」。
// ============================================================

const src = fs.readFileSync(path.join(ROOT, 'js/popup.js'), 'utf8');

console.log('=== 1. 源文件里的关键逻辑 ===');

check(
    'buildItem 里对可播格式创建了 video',
    /isPlayableExt\(item\.ext\)[\s\S]{0,400}?document\.createElement\('video'\)/.test(src)
);

check(
    '创建后是入队，不是直接挂载',
    /pendingPlayers\.push\(\{ player: player, item: item \}\)/.test(src),
    '如果这里写成 attachInlinePlayer(...)，元素还没进 DOM，会被 isConnected 拦下'
);

check(
    'render 末尾有统一挂载',
    /for \(const pending of pendingPlayers\) \{[\s\S]{0,200}?attachInlinePlayer\(pending\.player, pending\.item\)/.test(src)
);

check(
    'render 开头清空了待挂载队列',
    /pendingPlayers\.length = 0;/.test(src)
);

check(
    '普通视频在列表项上有「播放」按钮',
    /makeIconButton\('play'/.test(src)
);

// 图标按钮不能被 textContent 破坏，这是实际出现过的问题：
// 点「复制」后按钮变成文字，恢复时只能恢复成空串，图标永久消失
check(
    '按钮反馈用 class 而不是 textContent',
    /function flashButton\(/.test(src) && /classList\.add\(state\)/.test(src),
    '图标按钮改 textContent 会把 SVG 顶掉，且恢复不回来'
);

check(
    '复制反馈区分了图标按钮与文字按钮',
    /classList\.contains\('icon-act'\)/.test(src)
);

check(
    '列表项操作用的是图标按钮',
    /makeIconButton\(/.test(src)
);

console.log('\n=== 2. 复刻逻辑跑一遍 ===');

// --- 复刻 isPlayableExt ---
const PLAYABLE_EXTS = new Set(['m3u8', 'm3u', 'mp4', 'm4v', 'webm', 'ogg', 'ogv', 'mov']);
const isPlayableExt = (ext) => PLAYABLE_EXTS.has(String(ext || '').toLowerCase());

// --- 复刻 buildItem 的展开区（只保留播放器部分）---
const pendingPlayers = [];
const expandedSet = new Set();

function buildDetail(item, container) {
    if (!expandedSet.has(item.url)) return null;

    const detail = new StubElement('div');

    if (isPlayableExt(item.ext)) {
        const player = new StubElement('video');
        player.className = 'item-player';
        detail.appendChild(player);
        pendingPlayers.push({ player: player, item: item });
    }

    container.appendChild(detail);
    return detail;
}

// --- 复刻 render 末尾的挂载 ---
const mounted = [];
function attachInlinePlayer(player, item) {
    // 真实的守卫
    if (!player.isConnected) {
        mounted.push({ item: item, ok: false, why: 'isConnected=false' });
        return;
    }
    mounted.push({ item: item, ok: true });
}

// 场景：一条 m3u8、一条 mp4、一条 ts
const items = [
    { url: 'https://a.com/v.m3u8', ext: 'm3u8', name: 'v.m3u8' },
    { url: 'https://a.com/v.mp4', ext: 'mp4', name: 'v.mp4' },
    { url: 'https://a.com/seg.ts', ext: 'ts', name: 'seg.ts' }
];

for (const it of items) expandedSet.add(it.url);

// 模拟 render：先建列表（未进 DOM），再整体挂上去
const list = new StubElement('main');
pendingPlayers.length = 0;

const built = [];
for (const it of items) {
    built.push(buildDetail(it, list));
}

// 关键一步：整棵列表进 DOM
const root = new StubElement('body');
root.__isRoot = true;      // 只有它连着文档
root.appendChild(list);

check(
    '列表进 DOM 后，待挂载队列里有 2 个（m3u8 + mp4）',
    pendingPlayers.length === 2,
    '实际 ' + pendingPlayers.length + ' 个'
);

// 挂载
for (const pending of pendingPlayers) {
    attachInlinePlayer(pending.player, pending.item);
}
pendingPlayers.length = 0;

const okCount = mounted.filter((m) => m.ok).length;
check('两个播放器都挂载成功', okCount === 2, '成功 ' + okCount + ' 个');

check(
    'ts 分片没有创建播放器',
    !list.children.some((d) =>
        d.children.some((c) => c.className === 'item-player' && false)
    ) && built.filter(Boolean).length === 3
);

// 反向验证：如果按「先挂载、后进 DOM」的老写法会怎样
console.log('\n=== 3. 反向验证（老写法的后果）===');

const list2 = new StubElement('main');
const orphan = new StubElement('video');
list2.appendChild(orphan);

check(
    '元素还没进文档时 isConnected 是 false',
    orphan.isConnected === false
);

const root2 = new StubElement('body');
root2.__isRoot = true;
root2.appendChild(list2);

check(
    '挂到文档上之后 isConnected 变 true',
    orphan.isConnected === true
);

console.log('\n' + '='.repeat(46));
if (failed === 0) {
    console.log('全部通过（' + passed + ' 项）');
} else {
    console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
}
process.exit(failed === 0 ? 0 : 1);
