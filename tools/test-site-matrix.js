/** 站点矩阵 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PW = process.env.PLAYWRIGHT_CORE || 'playwright-core';
const { chromium } = require(PW);
const CHROME = process.env.CHROME_PATH || chromium.executablePath();
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const results = [];

function probe(file) {
    try {
        const out = execFileSync(FFPROBE, [
            '-v', 'error',
            '-show_entries', 'stream=codec_type,codec_name',
            '-of', 'json', file
        ], { encoding: 'utf8', timeout: 30000 });
        return JSON.parse(out);
    } catch (e) { return { error: (e.message || '').slice(0, 150) }; }
}

// ---------------------------------------------------------------
// 素材
// ---------------------------------------------------------------

function buildMedia(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const mp4 = path.join(dir, 'movie.mp4');

    execFileSync(FFMPEG, [
        '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=15',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', '-y', mp4
    ], { stdio: 'ignore', timeout: 90000 });

    // HLS
    fs.mkdirSync(path.join(dir, 'hls'), { recursive: true });
    execFileSync(FFMPEG, [
        '-i', mp4, '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
        '-hls_segment_filename', path.join(dir, 'hls', 'seg%d.ts'),
        '-y', path.join(dir, 'hls', 'index.m3u8')
    ], { stdio: 'ignore', timeout: 90000 });

    // 加密 HLS
    fs.mkdirSync(path.join(dir, 'enc'), { recursive: true });
    const key = path.join(dir, 'enc', 'enc.key');
    fs.writeFileSync(key, Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
    fs.writeFileSync(path.join(dir, 'enc', 'keyinfo'), key + '\n' + key + '\n');
    execFileSync(FFMPEG, [
        '-i', mp4, '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
        '-hls_key_info_file', path.join(dir, 'enc', 'keyinfo'),
        '-hls_segment_filename', path.join(dir, 'enc', 'seg%d.ts'),
        '-y', path.join(dir, 'enc', 'index.m3u8')
    ], { stdio: 'ignore', timeout: 90000 });

    // DASH（音视频分离）
    fs.mkdirSync(path.join(dir, 'dash'), { recursive: true });
    execFileSync(FFMPEG, [
        '-i', mp4, '-map', '0:v', '-map', '0:a',
        // 重编码并强制每 2 秒一个关键帧，DASH 按关键帧切分片，
        // -c copy 时关键帧不够就切不开，mpd 里声明 3 片实际只生成 1 片
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
        '-c:a', 'aac',
        '-f', 'dash', '-seg_duration', '2', '-use_timeline', '0', '-use_template', '1',
        // Windows 上 DASH muxer 用绝对路径会静默失败（只写 mpd、不报错），
        // 所以设 cwd 到输出目录、用相对路径
        '-y', 'manifest.mpd'
    ], { stdio: 'ignore', timeout: 90000, cwd: path.join(dir, 'dash') });

    return mp4;
}

// ---------------------------------------------------------------
// 服务：带防盗链
// ---------------------------------------------------------------

const SITES = {
    '/direct': 'direct',
    '/hls': 'hls',
    '/enc': 'enc',
    '/dash': 'dash',
    '/locked': 'locked'
};

function startServer(mediaDir) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = req.url.split('?')[0];

            // ---------- 站点页面 ----------
            if (SITES[url]) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(renderSitePage(SITES[url], url));
                return;
            }

            // ---------- 防盗链 ----------
            const locked = url.indexOf('/locked/') === 0;
            if (locked) {
                const ref = req.headers['referer'] || '';
                // 只认本站页面发起的请求
                if (ref.indexOf('127.0.0.1') === -1 && ref.indexOf('localhost') === -1) {
                    res.writeHead(403, { 'Content-Type': 'text/plain' });
                    res.end('forbidden');
                    return;
                }
            }

            // ---------- 素材 ----------
            // 剥掉站点前缀再找文件，/direct/movie.mp4 对应 media/movie.mp4
            let rel = url;
            if (url.indexOf('/locked/') === 0) rel = url.replace('/locked', '');
            else if (url.indexOf('/direct/') === 0) rel = url.replace('/direct', '');
            const file = path.join(mediaDir, decodeURIComponent(rel));

            if (!file.startsWith(mediaDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
                res.writeHead(404); res.end(); return;
            }

            const ext = path.extname(file).toLowerCase();
            const type = {
                '.mp4': 'video/mp4', '.m3u8': 'application/vnd.apple.mpegurl',
                '.ts': 'video/mp2t', '.key': 'application/octet-stream',
                '.mpd': 'video/dash+xml', '.m4s': 'video/mp4', '.mp4v': 'video/mp4'
            }[ext] || 'application/octet-stream';

            const buf = fs.readFileSync(file);

            // 支持 Range（真实 CDN 都支持）
            const range = req.headers['range'];
            if (range) {
                const m = /bytes=(\d+)-(\d*)/.exec(range);
                if (m) {
                    const start = parseInt(m[1], 10);
                    const end = m[2] ? parseInt(m[2], 10) : buf.length - 1;
                    const slice = buf.slice(start, Math.min(end + 1, buf.length));
                    res.writeHead(206, {
                        'Content-Type': type,
                        'Content-Range': 'bytes ' + start + '-' + (start + slice.length - 1) + '/' + buf.length,
                        'Content-Length': slice.length,
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(slice);
                    return;
                }
            }

            res.writeHead(200, {
                'Content-Type': type,
                'Content-Length': buf.length,
                'Access-Control-Allow-Origin': '*'
            });
            res.end(buf);
        });

        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function renderSitePage(kind, prefix) {
    const head = '<!DOCTYPE html><html><head><meta charset=utf-8><title>' + kind +
        '</title></head><body><div id=log></div>';

    // 用 fetch 模拟播放器的请求序列。
    const scripts = {
        direct: 'fetch("' + prefix + '/movie.mp4", {headers:{"Range":"bytes=0-65535"}}).catch(function(){});',

        hls: 'fetch("' + prefix + '/index.m3u8").then(function(r){return r.text()}).then(function(t){' +
             'var m=t.split("\\n").filter(function(x){return x && x.charAt(0)!=="#"});' +
             'm.slice(0,3).forEach(function(f){fetch("' + prefix + '/"+f.trim()).catch(function(){});});' +
             '}).catch(function(){});',

        enc: 'fetch("' + prefix + '/index.m3u8").then(function(r){return r.text()}).then(function(t){' +
             'fetch("' + prefix + '/enc.key").catch(function(){});' +
             'var m=t.split("\\n").filter(function(x){return x && x.charAt(0)!=="#"});' +
             'm.slice(0,3).forEach(function(f){fetch("' + prefix + '/"+f.trim()).catch(function(){});});' +
             '}).catch(function(){});',
        dash: 'fetch("' + prefix + '/manifest.mpd").then(function(r){return r.text()}).then(function(t){' +
              'var m=t.match(/[^"<> ]+\\.m4s/g)||[];' +
              'm.slice(0,4).forEach(function(f){fetch("' + prefix + '/"+f).catch(function(){});});' +
              '}).catch(function(){});',
        locked: 'fetch("' + prefix + '/movie.mp4", {headers:{Range:/bytes=0-65535/}}).catch(function(){});'
    };

    return head + '<video id="v" muted></video>' +
        '<script>' + (scripts[kind] || '') + '</script></body></html>';
}

// ---------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------

async function main() {
    try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); }
    catch (e) { console.log('没有 ffmpeg'); process.exit(0); }

    console.log('站点矩阵测试');
    console.log('='.repeat(50));

    const work = path.join(os.tmpdir(), 'jt-matrix-' + Date.now());
    const media = path.join(work, 'media');
    const dlDir = path.join(work, 'dl');
    fs.mkdirSync(dlDir, { recursive: true });

    console.log('\n【准备】生成素材');
    buildMedia(media);
    console.log('  完成');

    const started = await startServer(media);
    const base = 'http://127.0.0.1:' + started.port;
    console.log('  服务: ' + base);

    const ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), {
        executablePath: CHROME, headless: true,
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        downloadsPath: dlDir,
        args: [
            '--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT,
            '--no-first-run', '--no-default-browser-check',
            '--autoplay-policy=no-user-gesture-required',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    if (!sw) { console.log('扩展没起来'); process.exit(1); }

    const extId = sw.url().split('/')[2];
    const bgWarns = [];
    sw.on('console', (m) => { if (m.type() === 'warning') bgWarns.push(m.text()); });

    // 逐个站点
    for (const [prefix, kind] of Object.entries(SITES)) {
        const label = { direct: '直链站', hls: 'HLS 站', enc: '加密 HLS', dash: 'DASH 站', locked: '防盗链站' }[kind];
        console.log('\n' + '-'.repeat(50));
        console.log('【' + label + '】' + prefix);

        const r = { label, caught: 0, download: 'skip', playable: 'skip' };

        try {
            // 清掉上一轮的数据，避免串味
            // 清掉上一轮，否则嗅探结果会累积，看不出每个站点各自抓到什么
            await sw.evaluate(() => {
                try {
                    const all = JTStore.getAll() || {};
                    for (const t of Object.keys(all)) {
                        JTStore.clear(t);
                    }
                } catch (e) {}
            });

            const page = await ctx.newPage();
            await page.goto(base + prefix, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await page.waitForTimeout(2500);

            // 等请求发出去、扩展嗅探到
            await page.waitForTimeout(4000);

            // 嗅探结果
            const store = await sw.evaluate(() => {
                const all = JTStore.getAll() || {};
                const out = [];
                for (const t of Object.keys(all)) out.push(...(all[t] || []));
                return out.map((i) => ({
                    name: i.name, ext: i.ext, url: i.url, size: i.size,
                    pageUrl: i.pageUrl || '', requestHeaders: i.requestHeaders || null
                }));
            });

            r.caught = store.length;
            console.log('  嗅探: ' + store.length + ' 条');
            store.slice(0, 4).forEach((i) =>
                console.log('    [' + (i.ext || '?') + '] ' + String(i.name).slice(0, 55)));

            if (store.length === 0) {
                r.download = 'no-catch';
                results.push(r);
                await page.close();
                continue;
            }

            // 下载
            const sender = await ctx.newPage();
            await sender.goto('chrome-extension://' + extId + '/options.html',
                { waitUntil: 'domcontentloaded', timeout: 15000 });
            await sender.waitForTimeout(300);

            // ---------- DASH 走另一条路 ----------
            //
            // mpd 不是「一个文件」，而是「分片清单」， 直接下它只会得到
            // 一个几 KB 的 xml。正确路径是去 m3u8 页解析，然后
            // 用「合并下载」把视频轨和音频轨一次下完并合成。
            if (kind === 'dash') {
                const mpdPage = await ctx.newPage();
                await mpdPage.goto('chrome-extension://' + extId + '/m3u8.html',
                    { waitUntil: 'domcontentloaded', timeout: 20000 });
                await mpdPage.waitForTimeout(800);

                await mpdPage.fill('#urlInput', base + '/dash/manifest.mpd');
                await mpdPage.click('#btnParseUrl');

                let segs = 0;
                for (let i = 0; i < 15; i++) {
                    await mpdPage.waitForTimeout(1200);
                    segs = await mpdPage.evaluate(() =>
                        document.querySelectorAll('#segmentList .segment-item').length);
                    if (segs > 0) break;
                }

                if (segs === 0) {
                    r.download = 'mpd 解析失败';
                    console.log('  解析: [FAIL]');
                    results.push(r);
                    await mpdPage.close();
                    await page.close();
                    continue;
                }

                // 点合并下载
                try {
                    await mpdPage.click('#btnMergeTracks', { timeout: 8000 });
                } catch (e) {
                    r.download = '没有合并按钮';
                    results.push(r);
                    await mpdPage.close();
                    await page.close();
                    continue;
                }

                let merged = null;
                for (let i = 0; i < 45; i++) {
                    await mpdPage.waitForTimeout(2000);
                    const l = await mpdPage.evaluate(async () => {
                        const x = await chrome.downloads.search({ limit: 3, orderBy: ['-startTime'] });
                        return x.map((d) => ({ state: d.state, bytes: d.bytesReceived, file: d.filename }));
                    });
                    const done = l.find((x) => x.state === 'complete' && x.bytes > 30000);
                    if (done) { merged = done; break; }
                }

                if (merged) {
                    r.download = 'ok (' + (merged.bytes / 1024).toFixed(0) + 'KB)';
                    console.log('  合并下载: [OK] ' + r.download);

                    if (merged.file && fs.existsSync(merged.file)) {
                        const info = probe(merged.file);
                        if (!info.error) {
                            const ks = (info.streams || []).map((x) => x.codec_type);
                            const hv = ks.indexOf('video') !== -1, ha = ks.indexOf('audio') !== -1;
                            r.playable = hv && ha ? '音视频齐全' : (hv ? '只有视频' : '只有音频');
                        } else r.playable = 'ffprobe 失败';
                    }
                    console.log('  产物: ' + r.playable);
                } else {
                    r.download = 'fail';
                    console.log('  合并下载: [FAIL]');
                }

                await mpdPage.close();
                results.push(r);
                await page.close();
                continue;
            }

            // 挑一条：优先 m3u8，否则第一条
            const pick = store.find((i) => /\.m3u8$/.test(i.name || '')) || store[0];

            const dl = await sender.evaluate(async (item) => {
                try {
                    return await chrome.runtime.sendMessage({ type: 'popup:download', item: item });
                } catch (e) { return { ok: false, error: String(e.message || e) }; }
            }, pick);

            // 等下载结束（含回退）
            let state = null;
            for (let i = 0; i < 30; i++) {
                await new Promise((rr) => setTimeout(rr, 1500));
                const l = await sender.evaluate(async () => {
                    const x = await chrome.downloads.search({ limit: 3, orderBy: ['-startTime'] });
                    return x.map((d) => ({ state: d.state, bytes: d.bytesReceived, err: d.error, file: d.filename }));
                });
                const done = l.find((x) => x.state === 'complete' && x.bytes > 50000);
                if (done) { state = done; break; }
                if (l[0] && l[0].state === 'interrupted') { state = l[0]; }
            }

            await sender.close();

            if (!(state && state.state === 'complete' && state.bytes > 50000)) {
                // 失败时把完整记录打出来，只报个错误码看不出所以然
                const full = await sw.evaluate(async () => {
                    const x = await chrome.downloads.search({ limit: 3, orderBy: ['-startTime'] });
                    return x.map((d) => ({
                        state: d.state, bytes: d.bytesReceived,
                        err: d.error, mime: d.mime,
                        url: (d.url || '').slice(0, 90),
                        file: (d.filename || '').split(/[\\/]/).pop()
                    }));
                });
                console.log('    下载记录: ' + JSON.stringify(full, null, 2).split('\n').join('\n      '));
            }

            if (state && state.state === 'complete' && state.bytes > 50000) {
                r.download = 'ok (' + (state.bytes / 1024).toFixed(0) + 'KB)';
                console.log('  下载: [OK] ' + r.download);

                // 验证产物
                if (state.file && fs.existsSync(state.file)) {
                    const info = probe(state.file);
                    if (info.error) {
                        r.playable = 'ffprobe 失败';
                    } else {
                        const kinds = (info.streams || []).map((x) => x.codec_type);
                        const hasV = kinds.indexOf('video') !== -1;
                        const hasA = kinds.indexOf('audio') !== -1;
                        r.playable = hasV && hasA ? '音视频齐全' : (hasV ? '只有视频' : (hasA ? '只有音频' : '空'));
                    }
                } else {
                    r.playable = '找不到文件';
                }
                console.log('  产物: ' + r.playable);
            } else {
                r.download = 'fail (' + ((state && (state.err || state.state)) || '超时') + ')';
                console.log('  下载: [FAIL] ' + r.download);
            }

            await page.close();
        } catch (e) {
            r.download = 'error: ' + String(e.message || e).slice(0, 60);
            console.log('  出错: ' + r.download);
        }

        results.push(r);
    }

    // ---------- 汇总 ----------
    console.log('\n' + '='.repeat(50));
    console.log('汇总');
    console.log();
    console.log('  ' + '站点'.padEnd(12) + '嗅探'.padEnd(8) + '下载'.padEnd(20) + '产物');
    console.log('  ' + '-'.repeat(52));
    results.forEach((r) => {
        console.log('  ' + r.label.padEnd(12) +
            String(r.caught).padEnd(8) +
            String(r.download).padEnd(20) +
            r.playable);
    });

    const good = results.filter((r) => String(r.download).indexOf('ok') === 0).length;
    console.log();
    console.log('  ' + good + '/' + results.length + ' 个站点下载成功');

    await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 12000))]);
    started.server.close();
    fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});

    process.exit(0);
}

main().catch((e) => { console.error('脚本出错: ' + e.message); process.exit(1); });
