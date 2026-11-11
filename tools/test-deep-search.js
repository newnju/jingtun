/** 鲸吞：字节级 hook 测试 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'js/inject/deep-search.js');

// ============================================================
// 载入真实脚本
// ============================================================

let src = fs.readFileSync(SRC, 'utf8');

const lastClose = src.lastIndexOf('})();');
if (lastClose === -1) {
    console.error('[x] 找不到脚本结尾');
    process.exit(1);
}

const EXPORT_LINE = `
    self.__TEST_EXPORT__ = {
        looksLikeBase64Key: looksLikeBase64Key,
        extractRepeatedUnit: extractRepeatedUnit,
        reportKeyBytes: reportKeyBytes,
        checkBinaryForKey: checkBinaryForKey
    };
    self.__CAPTURED_KEYS__ = [];
`;

src = src.slice(0, lastClose) + EXPORT_LINE + src.slice(lastClose);

// ============================================================
// 最小环境
// ============================================================

const sandbox = {
    self: {},
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Uint8Array: Uint8Array,
    Uint16Array: Uint16Array,
    Uint32Array: Uint32Array,
    Int8Array: Int8Array,
    Uint8ClampedArray: Uint8ClampedArray,
    ArrayBuffer: ArrayBuffer,
    DataView: DataView,
    TextDecoder: TextDecoder,
    TextEncoder: TextEncoder,
    URL: URL,
    Blob: function () {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64')
};

sandbox.self.location = { href: 'https://example.com/watch', origin: 'https://example.com', protocol: 'https:' };
sandbox.self.addEventListener = function () {};
sandbox.self.postMessage = function (msg) {
    // 把上报的密钥收集起来，供断言用
    if (msg && msg.action === 'jt:addKey' && msg.payload && msg.payload.key) {
        sandbox.self.__CAPTURED_KEYS__.push(msg.payload.key);
    }
};

// requestIdleCallback 的回退
sandbox.requestIdleCallback = function (fn) { setTimeout(fn, 0); };

vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const T = sandbox.self.__TEST_EXPORT__;

if (!T) {
    console.error('[x] 导出失败');
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
// 测试数据
// ============================================================

/** 造一个 16 字节的「密钥」（内容各不相同，避开全零过滤） */
function makeKey(seed) {
    const buf = new Uint8Array(16);
    for (let i = 0; i < 16; i++) buf[i] = (seed + i * 7) & 0xff;
    return buf;
}

// ============================================================
// 测试
// ============================================================

console.log('== base64 密钥识别 ==');

// 16 字节的 base64 恰好 24 字符且以 == 结尾
const key16 = makeKey(3);
const b64 = Buffer.from(key16).toString('base64');
check('16 字节的 base64 长度是 24', b64.length, 24);
checkTrue('以 == 结尾', b64.slice(22) === '==');
checkTrue('识别为密钥形式', T.looksLikeBase64Key(b64));

check('长度不对 → 不是', T.looksLikeBase64Key('YWJj'), false);
check('不以 == 结尾 → 不是', T.looksLikeBase64Key('YWJjZGVmZ2hpamtsbW5v'), false);
check('非字符串 → 不是', T.looksLikeBase64Key(null), false);
check('空字符串 → 不是', T.looksLikeBase64Key(''), false);

console.log('\n== 重复扩展检测 ==');

// 16 字节重复 2 次 = 32 字节
const unit = makeKey(5);
const repeated32 = new Uint8Array(32);
repeated32.set(unit, 0);
repeated32.set(unit, 16);

const found32 = T.extractRepeatedUnit(repeated32, 16);
checkTrue('32 字节重复单元 → 能识别', !!found32);
check('提取出的单元长度正确', found32 ? found32.byteLength : 0, 16);
check('提取出的内容与原单元一致',
    found32 ? Array.from(new Uint8Array(found32)) : null,
    Array.from(unit));

// 16 字节重复 16 次 = 256 字节
const repeated256 = new Uint8Array(256);
for (let i = 0; i < 16; i++) repeated256.set(unit, i * 16);
checkTrue('256 字节重复单元 → 能识别', !!T.extractRepeatedUnit(repeated256, 16));

// 不是重复的
const notRepeated = new Uint8Array(32);
for (let i = 0; i < 32; i++) notRepeated[i] = i + 1;
check('内容不同 → 返回 null', T.extractRepeatedUnit(notRepeated, 16), null);

// 长度不是整数倍
check('长度不是整数倍 → null', T.extractRepeatedUnit(new Uint8Array(20), 16), null);
check('空数据 → null', T.extractRepeatedUnit(new Uint8Array(0), 16), null);

console.log('\n== 密钥上报与误报过滤 ==');

sandbox.self.__CAPTURED_KEYS__.length = 0;

// 正常的 16 字节密钥应该被上报
T.reportKeyBytes(makeKey(9));
check('16 字节随机内容 → 上报', sandbox.self.__CAPTURED_KEYS__.length, 1);
check('上报的内容长度是 16', sandbox.self.__CAPTURED_KEYS__[0].length, 16);

sandbox.self.__CAPTURED_KEYS__.length = 0;

// 全零不该被当成密钥
T.reportKeyBytes(new Uint8Array(16));
check('全零 → 不上报', sandbox.self.__CAPTURED_KEYS__.length, 0);

// MP4 的 ftyp 头不该被当成密钥
const ftyp = new Uint8Array(16);
ftyp[4] = 0x66; ftyp[5] = 0x74; ftyp[6] = 0x79; ftyp[7] = 0x70;
T.reportKeyBytes(ftyp);
check('ftyp 头 → 不上报', sandbox.self.__CAPTURED_KEYS__.length, 0);

// 长度不对的不上报
T.reportKeyBytes(new Uint8Array(8));
T.reportKeyBytes(new Uint8Array(32));
check('长度不是 16 → 不上报', sandbox.self.__CAPTURED_KEYS__.length, 0);

// null / undefined 不该崩
T.reportKeyBytes(null);
T.reportKeyBytes(undefined);
check('null/undefined → 不崩也不上报', sandbox.self.__CAPTURED_KEYS__.length, 0);

console.log('\n== 视图偏移处理 ==');

sandbox.self.__CAPTURED_KEYS__.length = 0;

// 关键场景：视图只是整个 buffer 的一段。
// 不做 byteOffset 处理的话，取到的是 buffer 开头而不是视图内容。
const bigBuffer = new Uint8Array(64);
for (let i = 0; i < 64; i++) bigBuffer[i] = 0xAA;   // 先填成会被过滤的内容
const realKey = makeKey(11);
bigBuffer.set(realKey, 32);                          // 密钥放在中间

const view = new Uint8Array(bigBuffer.buffer, 32, 16);
T.reportKeyBytes(view);

check('带偏移的视图 → 正确提取', sandbox.self.__CAPTURED_KEYS__.length, 1);
check('提取的是视图内容，不是 buffer 开头',
    sandbox.self.__CAPTURED_KEYS__[0],
    Array.from(realKey));

// ============================================================

console.log('\n' + '='.repeat(46));
if (failed === 0) {
    console.log(`全部通过（${passed} 项）`);
} else {
    console.log(`通过 ${passed} 项，失败 ${failed} 项`);
}
process.exit(failed === 0 ? 0 : 1);
