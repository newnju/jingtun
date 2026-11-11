/** 端到端测试：真的能下、真的能解 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, cond, detail) {
    if (cond) {
        passed++;
        console.log('  [v] ' + name);
    } else {
        failed++;
        console.log('  [x] ' + name + (detail ? '\n        → ' + detail : ''));
    }
}

function skip(name, why) {
    skipped++;
    console.log('  [-] ' + name + '（跳过：' + why + '）');
}

// ============================================================
// 找 ffmpeg / ffprobe
// ============================================================

const FFMPEG_CANDIDATES = [process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean);

let FFMPEG = null;
for (const c of FFMPEG_CANDIDATES) {
    try {
        execFileSync(c, ['-version'], { stdio: 'ignore', timeout: 10000 });
        FFMPEG = c;
        break;
    } catch (e) { /* 试下一个 */ }
}

const FFPROBE = FFMPEG ? FFMPEG.replace(/ffmpeg(\.exe)?$/, (m) => m.indexOf('.exe') !== -1 ? 'ffprobe.exe' : 'ffprobe') : null;

function hasProbe() {
    if (!FFPROBE) return false;
    try {
        execFileSync(FFPROBE, ['-version'], { stdio: 'ignore', timeout: 10000 });
        return true;
    } catch (e) {
        return false;
    }
}

// ============================================================
// 生成媒体
// ============================================================

function makeMedia(dir) {
    fs.mkdirSync(dir, { recursive: true });

    // 3 秒的测试视频（画面 + 声音）
    execFileSync(FFMPEG, [
        '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
        '-c:v', 'libx264', '-preset', 'ultrafast',
        '-c:a', 'aac', '-shortest',
        '-y', path.join(dir, 'sample.mp4')
    ], { stdio: 'ignore', timeout: 60000 });

    // 普通 HLS
    fs.mkdirSync(path.join(dir, 'hls'), { recursive: true });
    execFileSync(FFMPEG, [
        '-i', path.join(dir, 'sample.mp4'),
        '-c', 'copy', '-f', 'hls',
        '-hls_time', '1', '-hls_list_size', '0',
        '-hls_segment_filename', path.join(dir, 'hls', 'seg%d.ts'),
        '-y', path.join(dir, 'hls', 'index.m3u8')
    ], { stdio: 'ignore', timeout: 60000 });

    // AES-128 加密的 HLS
    fs.mkdirSync(path.join(dir, 'enc'), { recursive: true });
    const KEY_HEX = '00112233445566778899aabbccddeeff';
    const keyPath = path.join(dir, 'enc', 'enc.key');
    fs.writeFileSync(keyPath, Buffer.from(KEY_HEX, 'hex'));

    const infoPath = path.join(dir, 'enc', 'keyinfo.txt');
    fs.writeFileSync(infoPath, keyPath + '\n' + keyPath + '\n');

    execFileSync(FFMPEG, [
        '-i', path.join(dir, 'sample.mp4'),
        '-c', 'copy', '-f', 'hls',
        '-hls_time', '1', '-hls_list_size', '0',
        '-hls_key_info_file', infoPath,
        '-hls_segment_filename', path.join(dir, 'enc', 'seg%d.ts'),
        '-y', path.join(dir, 'enc', 'index.m3u8')
    ], { stdio: 'ignore', timeout: 60000 });

    return { keyHex: KEY_HEX };
}

// ============================================================
// 本地服务
// ============================================================

function startServer(dir) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = req.url.split('?')[0];
            const file = path.join(dir, decodeURIComponent(url));

            // 防目录穿越
            if (!file.startsWith(dir)) {
                res.writeHead(403); res.end(); return;
            }

            if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
                res.writeHead(404); res.end(); return;
            }

            const ext = path.extname(file).toLowerCase();
            const type = {
                '.mp4': 'video/mp4',
                '.m3u8': 'application/vnd.apple.mpegurl',
                '.ts': 'video/mp2t',
                '.key': 'application/octet-stream'
            }[ext] || 'application/octet-stream';

            res.writeHead(200, {
                'Content-Type': type,
                'Access-Control-Allow-Origin': '*'
            });
            res.end(fs.readFileSync(file));
        });

        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port });
        });
    });
}

// ============================================================
// 用扩展自己的解析器解析 m3u8
// ============================================================

function loadParser(file) {
    const vm = require('vm');
    const sandbox = {
        console: console,
        setTimeout: setTimeout,
        Promise: Promise,
        JSON: JSON,
        RegExp: RegExp,
        Math: Math,
        Date: Date,
        String: String,
        Number: Number,
        Array: Array,
        Object: Object,
        Error: Error,
        isNaN: isNaN,
        parseFloat: parseFloat,
        parseInt: parseInt,
        encodeURIComponent: encodeURIComponent,
        decodeURIComponent: decodeURIComponent,
        TextDecoder: TextDecoder,
        TextEncoder: TextEncoder,
        Uint8Array: Uint8Array,
        ArrayBuffer: ArrayBuffer,
        // decryptAes128 用 WebCrypto；node 18+ 有全局 crypto
        crypto: crypto
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;

    const ctx = vm.createContext(sandbox);

    // m3u8.js 可能依赖 utils
    vm.runInContext(read('js/lib/utils.js'), ctx, { filename: 'utils.js' });
    vm.runInContext(read(file), ctx, { filename: file });

    return sandbox;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
    console.log('=== 环境 ===');

    if (!FFMPEG) {
        skip('全部端到端测试', '系统里没有 ffmpeg');
        console.log('\n' + '='.repeat(46));
        console.log('跳过 ' + skipped + ' 项（缺 ffmpeg）');
        process.exit(0);
    }

    console.log('  ffmpeg: ' + FFMPEG);
    console.log('  ffprobe: ' + (hasProbe() ? FFPROBE : '不可用'));

    const workDir = path.join(os.tmpdir(), 'jt-e2e-' + Date.now());
    const mediaDir = path.join(workDir, 'media');

    console.log('\n=== 1. 生成真实媒体 ===');

    let media;
    try {
        media = makeMedia(mediaDir);
        check('生成了 mp4', fs.existsSync(path.join(mediaDir, 'sample.mp4')));
        check('生成了普通 HLS', fs.existsSync(path.join(mediaDir, 'hls', 'index.m3u8')));
        check('生成了加密 HLS', fs.existsSync(path.join(mediaDir, 'enc', 'index.m3u8')));
    } catch (e) {
        check('生成媒体', false, e.message.slice(0, 120));
        console.log('\n' + '='.repeat(46));
        process.exit(1);
    }

    const started = await startServer(mediaDir);
    const base = 'http://127.0.0.1:' + started.port;
    console.log('  服务地址: ' + base);

    // ------------------------------------------------------------
    console.log('\n=== 2. 用扩展的解析器解析清单 ===');
    // ------------------------------------------------------------

    const lib = loadParser('js/m3u8.js');
    const P = lib.JTM3u8;

    check('JTM3u8 加载成功', !!P);

    if (P && P.parse) {
        const plainText = fs.readFileSync(path.join(mediaDir, 'hls', 'index.m3u8'), 'utf8');
        const parsed = P.parse(plainText, base + '/hls/index.m3u8');

        check('解析出分片', parsed && parsed.segments && parsed.segments.length > 0,
            parsed && parsed.segments ? parsed.segments.length + ' 个' : 'null');

        if (parsed && parsed.segments) {
            check('分片地址是绝对地址',
                /^https?:\/\//.test(parsed.segments[0].url),
                parsed.segments[0].url);

            check('总时长合理（约 3 秒）',
                parsed.totalDuration > 2 && parsed.totalDuration < 6,
                parsed.totalDuration + 's');

            check('未加密的清单 hasEncryption 为 false',
                parsed.hasEncryption === false || !parsed.hasEncryption,
                String(parsed.hasEncryption));
        }

        // --- 加密清单 ---
        const encText = fs.readFileSync(path.join(mediaDir, 'enc', 'index.m3u8'), 'utf8');
        const encParsed = P.parse(encText, base + '/enc/index.m3u8');

        check('加密清单识别出 hasEncryption',
            encParsed && encParsed.hasEncryption === true,
            encParsed ? String(encParsed.hasEncryption) : 'null');

        check('识别出加密方式 AES-128',
            encParsed && /AES-128/i.test(String(encParsed.keyMethod)),
            encParsed ? String(encParsed.keyMethod) : 'null');

        // 密钥信息挂在每个 segment 上（同一条流的不同分片可能用不同密钥）
        const firstSeg = encParsed && encParsed.segments ? encParsed.segments[0] : null;

        check('分片带上了密钥信息',
            !!(firstSeg && firstSeg.key),
            firstSeg ? JSON.stringify(firstSeg.key) : 'null');

        check('密钥地址已解析成绝对地址',
            !!(firstSeg && firstSeg.key && /^https?:\/\//.test(firstSeg.key.uri)),
            firstSeg && firstSeg.key ? String(firstSeg.key.uri) : 'null');

        check('密钥方法正确',
            !!(firstSeg && firstSeg.key && /AES-128/i.test(firstSeg.key.method)),
            firstSeg && firstSeg.key ? String(firstSeg.key.method) : 'null');
    }

    // ------------------------------------------------------------
    console.log('\n=== 3. 解密：解出来的数据到底对不对 ===');
    // 这是最关键的一步，前面都是"解析出了地址"，
    // 这里要证明"解密后真的是一段能播的视频"。
    // ------------------------------------------------------------

    if (P && P.decryptAes128) {
        // 拿真实的密钥和密文
        const keyBuf = fs.readFileSync(path.join(mediaDir, 'enc', 'enc.key'));
        const segBuf = fs.readFileSync(path.join(mediaDir, 'enc', 'seg0.ts'));

        check('密钥是 16 字节', keyBuf.length === 16, keyBuf.length + ' 字节');

        // 密文和明文不该一样（证明真的加密了）
        const plainSeg = fs.readFileSync(path.join(mediaDir, 'hls', 'seg0.ts'));
        check('加密后的分片与明文不同',
            !segBuf.equals(plainSeg),
            '两者长度 ' + segBuf.length + ' vs ' + plainSeg.length);

        // 用扩展的解密函数
        // 自己解析一次加密清单拿 IV，上一节的变量出了作用域
        const encText2 = fs.readFileSync(path.join(mediaDir, 'enc', 'index.m3u8'), 'utf8');
        const enc2 = P.parse(encText2, base + '/enc/index.m3u8');
        const seg0key = (enc2 && enc2.segments && enc2.segments[0] && enc2.segments[0].key) || {};

        // decryptAes128(data, key, ivHex, sequence)，async，用 WebCrypto
        let decrypted = null;
        try {
            const ivHex = seg0key.iv || '';
            const keyArr = new Uint8Array(keyBuf);
            const dataArr = new Uint8Array(segBuf);

            decrypted = await P.decryptAes128(dataArr, keyArr, ivHex, 0);
        } catch (e) {
            check('调用 decryptAes128', false, e.message.slice(0, 120));
        }

        if (decrypted) {
            // 可能是 ArrayBuffer / TypedArray / Uint8Array
            const out = Buffer.isBuffer(decrypted)
                ? decrypted
                : Buffer.from(decrypted instanceof ArrayBuffer ? new Uint8Array(decrypted) : decrypted);

            check('解密后有数据', out.length > 0, out.length + ' 字节');

            // 解密结果应该和明文分片基本一致
            // （HLS 加密是整段加密，解密后应与原分片相同）
            const sameLength = Math.abs(out.length - plainSeg.length) <= 16;
            check('解密结果长度与明文接近',
                sameLength,
                out.length + ' vs ' + plainSeg.length);

            // 最强断言：拿解密结果去问 ffprobe
            if (hasProbe() && sameLength) {
                const probeFile = path.join(workDir, 'decrypted.ts');
                fs.writeFileSync(probeFile, out);

                try {
                    const probe = execFileSync(FFPROBE, [
                        '-v', 'error',
                        '-show_entries', 'stream=codec_type',
                        '-of', 'csv=p=0',
                        probeFile
                    ], { encoding: 'utf8', timeout: 20000 });

                    const hasVideo = /video/.test(probe);
                    const hasAudio = /audio/.test(probe);

                    check('解密出来的数据是有效视频（ffprobe 认可）',
                        hasVideo || hasAudio,
                        'ffprobe 输出: ' + JSON.stringify(probe.trim()));
                } catch (e) {
                    check('解密出来的数据是有效视频（ffprobe 认可）', false,
                        'ffprobe 拒绝: ' + (e.message || '').slice(0, 80));
                }
            } else if (!hasProbe()) {
                skip('ffprobe 验证解密结果', 'ffprobe 不可用');
            }
        }
    } else if (P) {
        skip('解密测试', 'JTM3u8 没有暴露 decryptAes128');
    }

    // ------------------------------------------------------------
    console.log('\n=== 4. 下载：真的能拿到文件 ===');
    // ------------------------------------------------------------

    {
        // 模拟扩展的下载流程：取清单 → 取分片 → 拼接
        async function fetchBuf(url) {
            return new Promise((resolve, reject) => {
                http.get(url, (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                }).on('error', reject);
            });
        }

        try {
            const listText = (await fetchBuf(base + '/hls/index.m3u8')).toString('utf8');
            check('能取到清单', listText.indexOf('#EXTM3U') !== -1);

            const segs = [...listText.matchAll(/^(seg\d+\.ts)$/gm)].map((m) => m[1]);
            check('清单里有分片', segs.length > 0, segs.length + ' 个');

            const bufs = [];
            for (const s of segs) {
                bufs.push(await fetchBuf(base + '/hls/' + s));
            }

            const merged = Buffer.concat(bufs);
            check('分片能全部取到', merged.length > 0, merged.length + ' 字节');

            // 拼起来问 ffprobe
            if (hasProbe()) {
                const mergedFile = path.join(workDir, 'merged.ts');
                fs.writeFileSync(mergedFile, merged);

                try {
                    const probe = execFileSync(FFPROBE, [
                        '-v', 'error',
                        '-show_entries', 'format=duration',
                        '-of', 'csv=p=0',
                        mergedFile
                    ], { encoding: 'utf8', timeout: 20000 });

                    const dur = parseFloat(probe.trim());
                    check('拼接后的分片是有效视频，时长约 3 秒',
                        dur > 2 && dur < 6,
                        'ffprobe 报 ' + probe.trim() + ' 秒');
                } catch (e) {
                    check('拼接后的分片是有效视频', false,
                        (e.message || '').slice(0, 80));
                }
            }
        } catch (e) {
            check('下载流程', false, e.message.slice(0, 100));
        }
    }

    // ------------------------------------------------------------

    started.server.close();
    try {
        fs.rmSync(workDir, { recursive: true, force: true });
    } catch (e) { /* 忽略 */ }

    console.log('\n' + '='.repeat(46));
    console.log(failed === 0
        ? '全部通过（' + passed + ' 项' + (skipped ? '，跳过 ' + skipped + ' 项' : '') + '）'
        : '通过 ' + passed + ' 项，失败 ' + failed + ' 项');

    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('测试脚本出错: ' + e.message);
    process.exit(1);
});
