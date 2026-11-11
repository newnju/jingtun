/** 检查内置 FFmpeg 核心是否为 LGPL 构建，且保留转封装所需能力 */
const fs = require('fs');
const path = require('path');

const CORE_DIR = path.join(__dirname, '..', 'lib', 'ffmpeg');
const wasmPath = path.join(CORE_DIR, 'ffmpeg-core.wasm');
const jsPath = path.join(CORE_DIR, 'ffmpeg-core.js');

let failed = 0;

function ok(name, detail) {
    console.log('  [v] ' + name + (detail ? '：' + detail : ''));
}

function bad(name, detail) {
    failed++;
    console.log('  [x] ' + name + (detail ? '：' + detail : ''));
}

console.log('== FFmpeg 核心许可与能力 ==');

if (!fs.existsSync(wasmPath) || !fs.existsSync(jsPath)) {
    console.log('  [x] 缺少 ffmpeg-core.js 或 ffmpeg-core.wasm');
    process.exit(1);
}

const wasm = fs.readFileSync(wasmPath);
const js = fs.readFileSync(jsPath, 'utf8');
const text = wasm.toString('latin1');

const configAt = text.indexOf('--target-os=none');
const configEnd = configAt === -1 ? -1 : text.indexOf('\0', configAt);
const config = configAt === -1
    ? ''
    : text.slice(configAt, configEnd === -1 ? configAt + 3000 : configEnd);

if (!config) {
    bad('找到 configure 字符串');
} else {
    ok('找到 configure 字符串');
}

const forbidden = [
    ['--enable-gpl', 'GPL 构建'],
    ['--enable-nonfree', 'nonfree 构建'],
    ['--enable-libx264', 'x264 GPL 组件'],
    ['--enable-libx265', 'x265 GPL 组件']
];

for (const [flag, label] of forbidden) {
    if (config.indexOf(flag) === -1) {
        ok('未启用 ' + label);
    } else {
        bad('启用了 ' + label, flag);
    }
}

if (config.indexOf('--disable-gpl') !== -1) {
    ok('显式关闭 GPL');
} else {
    bad('缺少 --disable-gpl');
}

if (config.indexOf('--disable-nonfree') !== -1) {
    ok('显式关闭 nonfree');
} else {
    bad('缺少 --disable-nonfree');
}

for (const capability of ['mpegts', 'aac_adtstoasc']) {
    if (text.indexOf(capability) !== -1) {
        ok('包含能力 ' + capability);
    } else {
        bad('缺少能力 ' + capability);
    }
}

if (js.indexOf('createFFmpegCore') !== -1 && js.indexOf('export default') !== -1) {
    ok('ES 模块导出可用');
} else {
    bad('ES 模块导出缺失');
}

console.log(failed === 0 ? '\nFFmpeg 核心检查通过' : '\nFFmpeg 核心检查失败');
process.exit(failed === 0 ? 0 : 1);
