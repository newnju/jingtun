/** 鲸吞：捕获数据可播性测试 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'js/inject/mse-capture.js');

// ============================================================
// 载入真实脚本
// ============================================================

let src = fs.readFileSync(SRC, 'utf8');

// 在 IIFE 结束前把内部函数挂出来。
// 匹配最后一个 `})();`，脚本末尾就是它。
const lastClose = src.lastIndexOf('})();');
if (lastClose === -1) {
    console.error('[x] 找不到脚本结尾，无法注入导出语句');
    process.exit(1);
}

const EXPORT_LINE = `
    self.__TEST_EXPORT__ = {
        looksLikeInitSegment: looksLikeInitSegment,
        stripDuplicateHeaders: stripDuplicateHeaders,
        detectExt: detectExt,
        extFromMime: extFromMime
    };
`;

src = src.slice(0, lastClose) + EXPORT_LINE + src.slice(lastClose);

// 最小环境：脚本只用这几个全局
const sandbox = {
    self: {},
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Uint8Array: Uint8Array,
    Blob: function () {},
    URL: URL
};
sandbox.self.location = { href: 'https://example.com/watch' };
sandbox.self.postMessage = function () {};
sandbox.self.addEventListener = function () {};

vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const T = sandbox.self.__TEST_EXPORT__;

if (!T) {
    console.error('[x] 导出失败，函数没挂上');
    process.exit(1);
}

// ============================================================
// 断言
// ============================================================

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        passed++;
        console.log('  [v] ' + label);
    } else {
        failed++;
        console.log('  [x] ' + label);
        console.log('      期望: ' + JSON.stringify(expected));
        console.log('      实际: ' + JSON.stringify(actual));
    }
}

function checkTrue(label, value) {
    check(label, !!value, true);
}

// ============================================================
// 构造测试数据
// ============================================================

/**
 * 造一段带 ftyp 头的 fMP4 初始化段
 * @returns {ArrayBuffer}
 */
function makeFtyp(size) {
    const buf = new Uint8Array(size || 32);
    // 前 4 字节是 box 长度，第 4~7 字节是 'ftyp'
    buf[0] = 0;
    buf[1] = 0;
    buf[2] = 0;
    buf[3] = 32;
    buf[4] = 0x66;  // f
    buf[5] = 0x74;  // t
    buf[6] = 0x79;  // y
    buf[7] = 0x70;  // p
    return buf.buffer;
}

/** 造一段普通媒体数据（moof+mdat，无 ftyp） */
function makeMedia(size) {
    const buf = new Uint8Array(size || 64);
    buf[0] = 0x6D;  // m
    buf[1] = 0x6F;  // o
    buf[2] = 0x6F;  // o
    buf[3] = 0x66;  // f
    return buf.buffer;
}

/** 造一段 WebM 初始化段 */
function makeEbml(size) {
    const buf = new Uint8Array(size || 32);
    buf[0] = 0x1A;
    buf[1] = 0x45;
    buf[2] = 0xDF;
    buf[3] = 0xA3;
    return buf.buffer;
}

/** 造一段 TS 数据 */
function makeTs(size) {
    const buf = new Uint8Array(size || 188);
    buf[0] = 0x47;
    return buf.buffer;
}

// ============================================================
// 测试
// ============================================================

console.log('== 初始化段识别 ==');

checkTrue('ftyp 开头 → 是初始化段', T.looksLikeInitSegment(makeFtyp()));
checkTrue('EBML 开头 → 是初始化段', T.looksLikeInitSegment(makeEbml()));
checkTrue('moof 开头 → 不是初始化段', !T.looksLikeInitSegment(makeMedia()));
checkTrue('TS 同步字节 → 不是初始化段', !T.looksLikeInitSegment(makeTs()));
checkTrue('空数据 → 不是', !T.looksLikeInitSegment(null));
checkTrue('太短的数据 → 不是', !T.looksLikeInitSegment(new Uint8Array(4).buffer));

console.log('\n== 扩展名推断（按实际容器，不看 MIME）==');

check('fMP4 + video MIME → mp4', T.detectExt(makeFtyp(), 'video/mp4'), 'mp4');
check('fMP4 + audio MIME → m4a', T.detectExt(makeFtyp(), 'audio/mp4'), 'm4a');
check('WebM + video MIME → webm', T.detectExt(makeEbml(), 'video/webm'), 'webm');
check('WebM + audio MIME → weba', T.detectExt(makeEbml(), 'audio/webm'), 'weba');
check('TS → ts', T.detectExt(makeTs(), 'video/mp2t'), 'ts');

// 关键：MIME 是错的也要按实际数据来
check('MIME 说是 mp4 但数据是 WebM → webm',
    T.detectExt(makeEbml(), 'video/mp4'), 'webm');

// 没有可识别签名时才退回 MIME
check('无签名 → 退回 MIME 推断',
    T.detectExt(null, 'video/mp4'), 'mp4');

console.log('\n== 重复头部清理 ==');

// 正常情况：只有开头一个头部，不该动
const normal = [makeFtyp(), makeMedia(), makeMedia()];
const r1 = T.stripDuplicateHeaders(normal);
check('单个头部 → 不清理', r1.removed, 0);
check('单个头部 → 数据块数不变', r1.chunks.length, 3);

// 播放器重新初始化：中途又出现一个头部
const duplicated = [makeFtyp(), makeMedia(), makeFtyp(), makeMedia(), makeMedia()];
const r2 = T.stripDuplicateHeaders(duplicated);
check('重复头部 → 丢掉前 2 块', r2.removed, 2);
check('重复头部 → 保留 3 块', r2.chunks.length, 3);
checkTrue('清理后第一块是头部', T.looksLikeInitSegment(r2.chunks[0]));

// 完全没有头部：不该乱动（由上层决定是否补 initSegment）
const noHeader = [makeMedia(), makeMedia()];
const r3 = T.stripDuplicateHeaders(noHeader);
check('无头部 → 不清理', r3.removed, 0);
check('无头部 → 数据块数不变', r3.chunks.length, 2);

// 边界
check('空数组 → 不崩', T.stripDuplicateHeaders([]).chunks.length, 0);
check('单块 → 不清理', T.stripDuplicateHeaders([makeFtyp()]).removed, 0);
check('null → 不崩', T.stripDuplicateHeaders(null).chunks.length, 0);

console.log('\n== 补回初始化段的效果 ==');

// 模拟「用户中途开始捕获」：只有媒体段，但之前记下了初始化段
// 这正是 flushToFile 里那段补救逻辑要处理的场景
const missedInit = [makeMedia(), makeMedia(), makeMedia()];
const initSegment = makeFtyp();

let chunks = T.stripDuplicateHeaders(missedInit).chunks;
checkTrue('补之前：没有头部（文件打不开）', !T.looksLikeInitSegment(chunks[0]));

// 模拟补回
chunks = [initSegment].concat(chunks);
checkTrue('补之后：有头部（文件可播放）', T.looksLikeInitSegment(chunks[0]));
check('补之后：数据块数 +1', chunks.length, 4);
check('补之后：扩展名能正确识别为 mp4',
    T.detectExt(chunks[0], 'video/mp4'), 'mp4');

console.log('\n== MIME 回退 ==');

check('空 MIME → bin', T.extFromMime(''), 'bin');
check('video/mp4 → mp4', T.extFromMime('video/mp4'), 'mp4');
check('audio/mp4 → m4a', T.extFromMime('audio/mp4'), 'm4a');
check('video/webm → webm', T.extFromMime('video/webm'), 'webm');
check('video/mp2t → ts', T.extFromMime('video/mp2t'), 'ts');
check('带 codecs 参数也能识别',
    T.extFromMime('video/mp4; codecs="avc1.640028"'), 'mp4');

// ============================================================

console.log('\n' + '='.repeat(46));
if (failed === 0) {
    console.log(`全部通过（${passed} 项）`);
} else {
    console.log(`通过 ${passed} 项，失败 ${failed} 项`);
}
process.exit(failed === 0 ? 0 : 1);
