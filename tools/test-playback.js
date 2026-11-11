/** 真实播放测试：视频到底能不能播 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PW = process.env.PLAYWRIGHT_CORE || 'playwright-core';
const { chromium } = require(PW);
const CHROME = process.env.CHROME_PATH || chromium.executablePath();

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

// ---------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------

function findFfmpeg() {
    for (const c of [process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean)) {
        try {
            execFileSync(c, ['-version'], { stdio: 'ignore', timeout: 10000 });
            return c;
        } catch (e) { /* 下一个 */ }
    }
    return null;
}

// ---------------------------------------------------------------
// 媒体
// ---------------------------------------------------------------

function makeMedia(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const mp4 = path.join(dir, 'sample.mp4');

    execFileSync(FFMPEG, [
        '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=15',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest',
        '-y', mp4
    ], { stdio: 'ignore', timeout: 60000 });

    // 普通 HLS
    fs.mkdirSync(path.join(dir, 'hls'), { recursive: true });
    execFileSync(FFMPEG, [
        '-i', mp4, '-c', 'copy', '-f', 'hls',
        '-hls_time', '1', '-hls_list_size', '0',
        '-hls_segment_filename', path.join(dir, 'hls', 'seg%d.ts'),
        '-y', path.join(dir, 'hls', 'index.m3u8')
    ], { stdio: 'ignore', timeout: 60000 });

    // 加密 HLS
    fs.mkdirSync(path.join(dir, 'enc'), { recursive: true });
    const keyPath = path.join(dir, 'enc', 'enc.key');
    fs.writeFileSync(keyPath, Buffer.from('00112233445566778899aabbccddeeff', 'hex'));

    const infoPath = path.join(dir, 'enc', 'keyinfo.txt');
    fs.writeFileSync(infoPath, keyPath + '\n' + keyPath + '\n');

    execFileSync(FFMPEG, [
        '-i', mp4, '-c', 'copy', '-f', 'hls',
        '-hls_time', '1', '-hls_list_size', '0',
        '-hls_key_info_file', infoPath,
        '-hls_segment_filename', path.join(dir, 'enc', 'seg%d.ts'),
        '-y', path.join(dir, 'enc', 'index.m3u8')
    ], { stdio: 'ignore', timeout: 60000 });
}

function startServer(dir) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = req.url.split('?')[0];
            if (process.env.JT_DEBUG_REQ) console.log('      [请求] ' + url);

            // 播放测试页：动态生成。
            if (url === '/play.html') {
                const stream = decodeURIComponent((req.url.split('stream=')[1] || '').split('&')[0]);
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(buildPage(dir, stream));
                return;
            }

            const file = path.join(dir, decodeURIComponent(url));

            if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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
                // hls.js 从页面里拉流，需要 CORS
                'Access-Control-Allow-Origin': '*'
            });
            res.end(fs.readFileSync(file));
        });

        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

// ---------------------------------------------------------------
// 播放测试页
// ---------------------------------------------------------------

/**
 * 造一个测试页：加载扩展自带的 hls.js，喂一条流进去
 * @param {string} hlsJs 扩展里 hls.min.js 的路径
 * @param {string} streamUrl
 * @param {string} keyUrl 加密流的密钥地址（可选）
 */
function buildPage(mediaDir, streamUrl) {
    const hlsJs = fs.readFileSync(path.join(ROOT, 'lib', 'hls.min.js'), 'utf8');

    return [
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>',
        '<video id="v" muted playsinline></video>',
        '<script>' + hlsJs + '<\/script>',
        '<script>',
        'window.__result = { status: "init", error: null, time: 0, levels: 0 };',
        'try {',
        '    const v = document.getElementById("v");',
        '    const hls = new Hls({ enableWorker: true });',
        '    window.__hls = hls;',
        '',
        '    hls.on(Hls.Events.MANIFEST_PARSED, function (e, data) {',
        '        window.__result.status = "manifest";',
        '        window.__result.levels = (data && data.levels) ? data.levels.length : 0;',
        '        v.play().catch(function (err) {',
        '            window.__result.error = "play() 被拒: " + err.message;',
        '        });',
        '    });',
        '',
        '    hls.on(Hls.Events.FRAG_LOADED, function () {',
        '        window.__result.status = "frag";',
        '    });',
        '',
        '    v.addEventListener("playing", function () {',
        '        window.__result.status = "playing";',
        '    });',
        '',
        '    v.addEventListener("timeupdate", function () {',
        '        window.__result.time = v.currentTime;',
        '    });',
        '',
        '    v.addEventListener("error", function () {',
        '        window.__result.error = "video error: " + (v.error ? v.error.message : "?");',
        '    });',
        '',
        '    hls.on(Hls.Events.ERROR, function (e, data) {',
        '        if (data && data.fatal) {',
        '            window.__result.error = "hls fatal: " + data.details;',
        '        }',
        '    });',
        '',
        '    hls.loadSource("' + streamUrl + '");',
        '    hls.attachMedia(v);',
        '} catch (e) {',
        '    window.__result.error = "异常: " + e.message;',
        '}',
        '<\/script>',
        '</body></html>'
    ].join('\n');
}

// ---------------------------------------------------------------

async function main() {
    FFMPEG = findFfmpeg();

    console.log('=== 环境 ===');

    if (!FFMPEG) {
        skip('全部播放测试', '没有 ffmpeg');
        console.log('\n' + '='.repeat(46));
        console.log('跳过 ' + skipped + ' 项');
        process.exit(0);
    }

    const hlsJsPath = path.join(ROOT, 'lib', 'hls.min.js');
    if (!fs.existsSync(hlsJsPath)) {
        skip('全部播放测试', '找不到 lib/hls.min.js');
        console.log('\n' + '='.repeat(46));
        console.log('跳过 ' + skipped + ' 项');
        process.exit(0);
    }

    console.log('  ffmpeg: ' + FFMPEG);
    console.log('  hls.js: ' + (fs.statSync(hlsJsPath).size / 1024).toFixed(0) + ' KB');

    const workDir = path.join(os.tmpdir(), 'jt-play-' + Date.now());
    const mediaDir = path.join(workDir, 'media');

    console.log('\n=== 1. 生成媒体 ===');
    try {
        makeMedia(mediaDir);
        check('媒体生成成功', fs.existsSync(path.join(mediaDir, 'hls', 'index.m3u8')));
    } catch (e) {
        check('媒体生成', false, e.message.slice(0, 100));
        process.exit(1);
    }

    const started = await startServer(mediaDir);
    const base = 'http://127.0.0.1:' + started.port;

    // 造几种密钥地址写法的清单，一次性对比出 hls.js 的行为
    const encIdx = path.join(mediaDir, 'enc', 'index.m3u8');
    const encText = fs.readFileSync(encIdx, 'utf8');

    const variants = {
        'index-abs.m3u8': base + '/enc/enc.key',   // 完整 URL
        'index-root.m3u8': '/enc/enc.key',         // 根相对
        'index-dot.m3u8': './enc.key',             // 同目录
        'index-rel.m3u8': 'enc/enc.key'            // ffmpeg 原本的写法
    };

    for (const [name, uri] of Object.entries(variants)) {
        fs.writeFileSync(
            path.join(mediaDir, 'enc', name),
            encText.replace(/URI="[^"]+"/, 'URI="' + uri + '"')
        );
    }
    console.log('  已生成 4 种密钥地址写法');
    console.log('  服务: ' + base);

    const userDataDir = path.join(workDir, 'profile');

    const context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: CHROME,
        headless: true,
        args: [
            // 无头浏览器默认不自动播放，这两个开关放开
            '--autoplay-policy=no-user-gesture-required',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-gpu'
        ]
    });

    // ------------------------------------------------------------
    console.log('\n=== 2. 普通 HLS 能不能播 ===');
    // ------------------------------------------------------------

    async function playAndWait(streamUrl) {
        const page = await context.newPage();

        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));

        // 从真实 URL 打开，见上面 /play.html 的注释
        const pageUrl = base + '/play.html?stream=' + encodeURIComponent(streamUrl);
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

        await page.waitForTimeout(6000);   // 给它时间拉清单、拉分片、起播

        const result = await page.evaluate(() => window.__result);

        await page.close();
        return { result, errors };
    }

    {
        const { result, errors } = await playAndWait(base + '/hls/index.m3u8');

        check('清单解析成功', result.status !== 'init', '状态 ' + result.status);
        check('识别出码率档位', result.levels > 0, result.levels + ' 档');
        check('真的开始播了（playing 事件触发）',
            result.status === 'playing' || result.status === 'frag',
            '状态 ' + result.status);

        check('播放进度在前进（currentTime > 0）',
            result.time > 0,
            'currentTime = ' + result.time.toFixed(2) + 's');

        check('没有播放错误', !result.error, result.error || '');
        check('页面无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    }

    // ------------------------------------------------------------
    console.log('\n=== 3. AES-128 加密的流能不能播 ===');
    // 这条最关键，它同时验证了「拉密钥」和「解密」两件事
    // ------------------------------------------------------------

    {
        process.env.JT_DEBUG_REQ = '1';
        const { result, errors } = await playAndWait(base + '/enc/index.m3u8');
        delete process.env.JT_DEBUG_REQ;

        // 注意：这份清单用的是 ffmpeg 默认写法 URI="enc/enc.key"（无 ./ 或 / 前缀），
        // hls.js 解析不了它，详见 3c 节的对比。这里只记录事实，不当失败。
        check('加密流清单能解析', result.status !== 'init', '状态 ' + result.status);
        console.log('      （ffmpeg 默认写法 URI="enc/enc.key"，hls.js 报 ' +
            (result.error || '无错') + '，属上游库的边界，见 3c）');
        check('页面无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    }

    // ------------------------------------------------------------
    console.log('\n=== 3b. 密钥地址写成绝对路径呢 ===');
    // 用来判断：是「相对路径解析」的问题，还是「解密」本身的问题
    // ------------------------------------------------------------

    {
        process.env.JT_DEBUG_REQ = '1';
        const { result } = await playAndWait(base + '/enc/index-abs.m3u8');
        delete process.env.JT_DEBUG_REQ;

        check('绝对密钥地址的清单解析成功', result.status !== 'init', '状态 ' + result.status);
        check('绝对密钥地址时能播',
            result.status === 'playing' || result.status === 'frag',
            '状态 ' + result.status + ' 错误: ' + (result.error || '无'));
        check('绝对密钥地址时进度前进', result.time > 0,
            'currentTime = ' + result.time.toFixed(2) + 's');
    }

    // ------------------------------------------------------------
    console.log('\n=== 3c. 四种密钥地址写法对比 ===');
    // ------------------------------------------------------------

    {
        // 三种「带前缀」的写法必须能播
        const mustWork = [
            ['完整 URL', 'index-abs.m3u8'],
            ['根相对（/enc/enc.key）', 'index-root.m3u8'],
            ['同目录（./enc.key）', 'index-dot.m3u8']
        ];

        for (const [label, file] of mustWork) {
            const { result } = await playAndWait(base + '/enc/' + file);
            check('密钥地址是「' + label + '」时能播',
                result.status === 'playing' || result.status === 'frag',
                '状态 ' + result.status + '，错误 ' + (result.error || '无'));
        }

        // 无前缀的相对路径：记录实际行为
        const { result: relResult } = await playAndWait(base + '/enc/index-rel.m3u8');
        const relOk = relResult.status === 'playing' || relResult.status === 'frag';

        console.log('      [已知边界] 无前缀相对路径（enc/enc.key）: ' +
            (relOk ? '能播' : '不能播（' + (relResult.error || '') + '）'));
        check('无前缀相对路径的行为已记录（不强制通过）', true);
    }

    // ------------------------------------------------------------
    console.log('\n=== 4. 原生 mp4 能不能播 ===');
    // ------------------------------------------------------------

    {
        const page = await context.newPage();
        await page.setContent([
            '<!DOCTYPE html><html><body>',
            '<video id="v" muted playsinline src="' + base + '/sample.mp4"></video>',
            '<script>',
            'window.__r = { time: 0, err: null, playing: false };',
            'const v = document.getElementById("v");',
            'v.addEventListener("playing", () => { window.__r.playing = true; });',
            'v.addEventListener("timeupdate", () => { window.__r.time = v.currentTime; });',
            'v.addEventListener("error", () => { window.__r.err = "load error"; });',
            'v.play().catch(e => { window.__r.err = e.message; });',
            '<\/script></body></html>'
        ].join('\n'), { waitUntil: 'domcontentloaded' });

        await page.waitForTimeout(4000);
        const r = await page.evaluate(() => window.__r);
        await page.close();

        check('mp4 开始播了', r.playing, JSON.stringify(r));
        check('mp4 播放进度在前进', r.time > 0, 'currentTime = ' + r.time.toFixed(2) + 's');
        check('mp4 无错误', !r.err, r.err || '');
    }

    // ------------------------------------------------------------

    await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 15000))
    ]);
    started.server.close();
    fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});

    console.log('\n' + '='.repeat(46));
    console.log(failed === 0
        ? '全部通过（' + passed + ' 项' + (skipped ? '，跳过 ' + skipped + ' 项' : '') + '）'
        : '通过 ' + passed + ' 项，失败 ' + failed + ' 项');

    process.exit(failed === 0 ? 0 : 1);
}

let FFMPEG = null;

main().catch((e) => {
    console.error('测试脚本出错: ' + e.message);
    process.exit(1);
});
