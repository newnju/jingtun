/** 消息链路闭环检查 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const bg = read('js/background.js');
const popup = read('js/popup.js');
const cs = read('js/content-script.js');

// ---------------------------------------------------------------
// 收集
// ---------------------------------------------------------------

/** 从源码里抓 sendMessage({ type: 'xxx' }) 的 type */
function sentTypes(src) {
    const set = new Set();
    // 跨行也要能匹配，所以用 [\s\S] 而不是 .
    const re = /sendMessage\(\s*\{[\s\S]{0,200}?type:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) set.add(m[1]);
    return set;
}

const bgHandled = new Set();
for (const m of bg.matchAll(/case\s+'([^']+)'\s*:/g)) bgHandled.add(m[1]);

const popupSent = sentTypes(popup);
const bgPushed = sentTypes(bg);
const bgHandledByMsg = new Set();
for (const m of bg.matchAll(/message\.type === '([^']+)'/g)) bgHandledByMsg.add(m[1]);

// popup 监听的
const popupListened = new Set();
for (const m of popup.matchAll(/message\.type === '([^']+)'/g)) popupListened.add(m[1]);
for (const m of popup.matchAll(/case\s+'([^']+)'\s*:/g)) popupListened.add(m[1]);

// ---------------------------------------------------------------
// 1. popup 发的 → 后台处理
// ---------------------------------------------------------------

console.log('=== 1. 弹窗发出的消息 ===');
const orphanSent = [...popupSent].filter((t) => !bgHandled.has(t));

if (orphanSent.length === 0) {
    console.log('  [v] ' + popupSent.size + ' 种消息都有后台处理分支');
} else {
    console.log('  [x] 没有处理分支（点了会没反应）:');
    orphanSent.forEach((t) => console.log('      ' + t));
}

// ---------------------------------------------------------------
// 2. 后台推送的 → 有页面监听
// ---------------------------------------------------------------

console.log('\n=== 2. 后台推送的消息 ===');

// 有些是推给内容脚本 / 工具页的，不一定要 popup 听
const TO_OTHER_PAGES = new Set([
    'media:command', 'capture:autoToBuffered', 'capture:sandbox',
    'capture:autoDownOnComplete', 'webrtc:start', 'region:open',
    'jt:captureChunk'
]);

const orphanPushed = [...bgPushed].filter(
    (t) => !popupListened.has(t) && !TO_OTHER_PAGES.has(t)
);

if (orphanPushed.length === 0) {
    console.log('  [v] ' + bgPushed.size + ' 种推送都有接收方');
} else {
    console.log('  [!] 没有接收方的（可能是别的页面在听）:');
    orphanPushed.forEach((t) => console.log('      ' + t));
}

// ---------------------------------------------------------------
// 3. 内容脚本的转发表
// ---------------------------------------------------------------

console.log('\n=== 3. 内容脚本转发表 ===');

// INBOUND_ACTIONS：注入脚本上报 → 转给后台
const inbound = new Set();
const inMatch = cs.match(/INBOUND_ACTIONS[\s\S]*?\]\);/);
if (inMatch) {
    for (const m of inMatch[0].matchAll(/'([^']+)'/g)) inbound.add(m[1]);
}

// 注入脚本实际上报的动作
const injectReports = new Set();
const injectDir = path.join(ROOT, 'js/inject');
for (const f of fs.readdirSync(injectDir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(injectDir, f), 'utf8');
    for (const m of src.matchAll(/report\(\s*'([^']+)'/g)) injectReports.add(m[1]);
}

const notForwarded = [...injectReports].filter((t) => !inbound.has(t));

if (notForwarded.length === 0) {
    console.log('  [v] 注入脚本上报的 ' + injectReports.size + ' 种动作都能转发到后台');
} else {
    console.log('  [x] 没进转发表（上报了也没人管）:');
    notForwarded.forEach((t) => console.log('      ' + t));
}

// ---------------------------------------------------------------
// 4. 后台的 case 是否有实际触发源
// ---------------------------------------------------------------

console.log('\n=== 4. 后台处理分支的来源 ===');

const allSenders = new Set([...popupSent, ...bgPushed]);
// 注入脚本经内容脚本转发过来的，也在 inbound 里
for (const t of inbound) allSenders.add(t);

const neverCalled = [...bgHandled].filter((t) => {
    if (allSenders.has(t)) return false;
    if (bgHandledByMsg.has(t)) return false;   // 同一个文件内部转发
    return true;
});

if (neverCalled.length === 0) {
    console.log('  [v] ' + bgHandled.size + ' 个分支都有来源');
} else {
    console.log('  [!] 找不到触发源的（可能是右键菜单等入口）:');
    neverCalled.forEach((t) => console.log('      ' + t));
}

console.log('\n' + '='.repeat(46));
