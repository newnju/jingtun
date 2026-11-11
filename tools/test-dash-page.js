/** 验证：m3u8 页的「合并下载」（DASH 多轨） */
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

const watchdog = setTimeout(() => { console.error('[看门狗] 超时'); process.exit(2); }, 300000);

let pass = 0, fail = 0;
function ok(n, d) { pass++; console.log('  [v] ' + n + (d ? '，' + d : '')); }
function no(n, d) { fail++; console.log('  [x] ' + n + (d ? '，' + d : '')); }

function probe(file) {
    try {
        const out = execFileSync(FFPROBE, [
            '-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
            '-of', 'json', file
        ], { encoding: 'utf8', timeout: 30000 });
        return JSON.parse(out);
    } catch (e) { return { error: (e.message || '').slice(0, 150) }; }
}

async function main() {
    try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); }
    catch (e) { console.log('没有 ffmpeg'); process.exit(0); }

    const work = path.join(os.tmpdir(), 'jt-dashm-' + Date.now());
    const media = path.join(work, 'media');
    fs.mkdirSync(media, { recursive: true });

    console.log('DASH 多轨合并下载');
    console.log('='.repeat(50));

    // ---------- 造素材 ----------
    console.log('\n【1】生成 DASH 素材');
    const mp4 = path.join(work, 'movie.mp4');
    execFileSync(FFMPEG, [
        '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=15',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', '-y', mp4
    ], { stdio: 'ignore', timeout: 90000 });

    execFileSync(FFMPEG, [
        '-i', mp4, '-map', '0:v', '-map', '0:a',
        '-c:v', 'libx264', '-preset', 'ultrafast',
        '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
        '-c:a', 'aac',
        '-f', 'dash', '-seg_duration', '2', '-use_timeline', '0', '-use_template', '1',
        // Windows 上 DASH muxer 用绝对路径会静默失败（只写 mpd、不报错）
        '-y', 'manifest.mpd'
    ], { stdio: 'ignore', timeout: 90000, cwd: media });

    const files = fs.readdirSync(media);
    console.log('  生成: ' + files.length + ' 个文件');

    if (files.length < 3) {
        no('素材生成完整', files.join(', '));
        console.log('\n（素材不完整，后面测不了）');
        return finish(null, work, null);
    }
    ok('素材生成完整', files.filter((f) => f.endsWith('.m4s')).length + ' 个 m4s');

    // ---------- 服务 ----------
    const server = http.createServer((req, res) => {
        const f = path.join(media, decodeURIComponent(req.url.split('?')[0]));
        if (!f.startsWith(media) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
        const ext = path.extname(f).toLowerCase();
        const type = { '.mpd': 'application/dash+xml', '.m4s': 'video/mp4',
                       '.mp4': 'video/mp4' }[ext] || 'application/octet-stream';
        const buf = fs.readFileSync(f);

        // 支持 Range，真实 CDN 都支持，扩展也会带 Range
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

        res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length,
            'Access-Control-Allow-Origin': '*' });
        res.end(buf);
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    console.log('  服务: ' + base);

    // ---------- 浏览器 ----------
    const ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), {
        executablePath: CHROME, headless: true,
        viewport: { width: 1280, height: 900 },
        acceptDownloads: true,
        args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT,
               '--no-first-run', '--no-default-browser-check']
    });

    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    if (!sw) { console.log('扩展没起来'); process.exit(1); }

    const extId = sw.url().split('/')[2];

    // ---------- 解析 ----------
    console.log('\n【2】解析 mpd');
    const page = await ctx.newPage();
    const pageLogs = [];
    page.on('console', (m) => pageLogs.push('[' + m.type() + '] ' + m.text()));
    page.on('pageerror', (e) => pageLogs.push('[pageerror] ' + e.message));

    await page.goto('chrome-extension://' + extId + '/m3u8.html',
        { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(800);

    await page.fill('#urlInput', base + '/manifest.mpd');
    await page.click('#btnParseUrl');

    let segCount = 0;
    for (let i = 0; i < 15; i++) {
        await page.waitForTimeout(1200);
        segCount = await page.evaluate(() =>
            document.querySelectorAll('#segmentList .segment-item').length);
        if (segCount > 0) break;
    }

    if (segCount > 0) ok('解析出分片', segCount + ' 条');
    else {
        no('解析出分片');
        console.log('\n页面日志:');
        pageLogs.slice(-6).forEach((l) => console.log('  ' + l.slice(0, 130)));
        return finish(ctx, work, server);
    }

    // ---------- 合并按钮 ----------
    const btnState = await page.evaluate(() => {
        const b = document.getElementById('btnMergeTracks');
        return b ? { exists: true, hidden: b.hidden, text: b.textContent.trim() } : { exists: false };
    });

    if (btnState.exists && !btnState.hidden) ok('「合并下载」按钮可见', btnState.text);
    else no('「合并下载」按钮可见', JSON.stringify(btnState));

    // ---------- 点合并 ----------
    console.log('\n【3】点合并下载');
    const t0 = Date.now();

    try {
        await page.click('#btnMergeTracks', { timeout: 8000 });
        console.log('  已点');
    } catch (e) {
        no('点得到合并按钮', e.message.slice(0, 80));
        return finish(ctx, work, server);
    }

    // 等产物（ffmpeg 首次加载要几十秒）
    let state = null;
    for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(2000);

        const l = await page.evaluate(async () => {
            const x = await chrome.downloads.search({ limit: 3, orderBy: ['-startTime'] });
            return x.map((d) => ({ state: d.state, bytes: d.bytesReceived, err: d.error, file: d.filename }));
        });

        const done = l.find((x) => x.state === 'complete' && x.bytes > 30000);
        if (done) { state = done; break; }

        if (i % 5 === 4) {
            const st = await page.evaluate(() => {
                const t = document.body.innerText || '';
                const m = t.match(/(正在|合并)[^\n]{0,40}/);
                return m ? m[0] : '';
            });
            console.log('    ' + ((Date.now() - t0) / 1000).toFixed(0) + 's: ' + st.slice(0, 300));
        }
    }

    if (state) {
        ok('合并产物已保存', state.bytes + ' 字节  ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    } else {
        const full = await page.evaluate(async () => {
            const x = await chrome.downloads.search({ limit: 3, orderBy: ['-startTime'] });
            return x.map((d) => ({ state: d.state, bytes: d.bytesReceived, err: d.error }));
        });
        no('合并产物已保存', JSON.stringify(full));
        const detail = await page.evaluate(() => {
            const t = document.body.innerText || '';
            // 不用正则，转义层数太多，容易把文件写坏
            const idx = Math.max(t.indexOf('合并失败'), t.indexOf('失败'));
            return idx >= 0 ? t.slice(idx, idx + 400) : t.slice(-400);
        });
        console.log('  失败详情: ' + detail);
    }

    // ---------- 验证产物 ----------
    if (state && state.file && fs.existsSync(state.file)) {
        console.log('\n【4】产物可播性');
        const info = probe(state.file);

        if (info.error) {
            no('ffprobe 能解析', info.error);
        } else {
            const kinds = (info.streams || []).map((x) => x.codec_type + '(' + x.codec_name + ')');
            console.log('  流: ' + kinds.join('  |  '));

            const hasV = kinds.some((k) => k.indexOf('video') === 0);
            const hasA = kinds.some((k) => k.indexOf('audio') === 0);

            if (hasV && hasA) ok('产物音视频齐全（多轨合并成功）');
            else no('产物音视频齐全', '只有 ' + kinds.join(', '));
        }
    }

    console.log('\n【5】页面日志');
    if (pageLogs.length) pageLogs.slice(-8).forEach((l) => console.log('  ' + l.slice(0, 140)));
    else console.log('  （无）');

    return finish(ctx, work, server);
}

async function finish(ctx, work, server) {
    clearTimeout(watchdog);
    if (ctx) await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 12000))]);
    if (server) { try { server.close(); } catch (e) {} }
    fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    console.log('\n' + '='.repeat(50));
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(0);
}

main().catch((e) => { console.error('脚本出错: ' + e.message); process.exit(1); });
