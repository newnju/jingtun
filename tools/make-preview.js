/** 鲸吞：界面预览生成器 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'preview');

// ---------------------------------------------------------------
// 桩数据
// ---------------------------------------------------------------

/** 模拟一条嗅探到的资源 */
function item(over) {
    return Object.assign({
        requestId: 'req_' + Math.random().toString(36).slice(2, 8),
        url: 'https://cdn.example.com/media/video.mp4',
        name: 'video.mp4',
        ext: 'mp4',
        mime: 'video/mp4',
        size: 1024 * 1024 * 86,
        type: 'media',
        tabId: 1,
        pageUrl: 'https://example.com/watch/12345',
        pageTitle: '示例页面标题',
        time: Date.now()
    }, over || {});
}

const SAMPLE_ITEMS = [
    item({
        url: 'https://cdn.example.com/hls/master_1080p.m3u8?sign=abc123&t=1758000000',
        name: 'master_1080p.m3u8',
        ext: 'm3u8',
        mime: 'application/vnd.apple.mpegurl',
        size: 4096,
        source: 'deep-search'
    }),
    item({
        url: 'https://cdn.example.com/media/episode_01_1080p.mp4',
        name: 'episode_01_1080p.mp4',
        ext: 'mp4',
        size: 1024 * 1024 * 512
    }),
    item({
        url: 'https://cdn.example.com/media/episode_01.mp4',
        name: 'episode_01.mp4',
        ext: 'mp4',
        size: 1024 * 1024 * 186
    }),
    item({
        url: 'https://cdn.example.com/audio/track_01.m4a',
        name: 'track_01.m4a',
        ext: 'm4a',
        mime: 'audio/mp4',
        size: 1024 * 1024 * 8.4
    }),
    item({
        url: 'https://cdn.example.com/hls/chunklist.m3u8',
        name: 'chunklist.m3u8',
        ext: 'm3u8',
        mime: 'application/vnd.apple.mpegurl',
        size: 2048,
        source: 'fetch'
    }),
    item({
        url: 'https://drm.example.com/protected/stream',
        name: 'stream',
        ext: '',
        type: 'drm',
        drmSystem: 'Widevine',
        source: 'drm-detect'
    }),
    item({
        url: 'https://cdn.example.com/img/poster.jpg',
        name: 'poster.jpg',
        ext: 'jpg',
        mime: 'image/jpeg',
        size: 1024 * 240
    })
];

const SAMPLE_CONFIG = {
    enable: true,
    checkDuplicates: true,
    maxPerTab: 2000,
    captureMimeTypes: true,
    blockList: ['ads.example.com', '*.tracker.net'],
    badgeNumber: true,
    showSize: true,
    showType: true,
    reverseOrder: false,
    autoDownload: false,
    downloadDir: 'jingtun',
    fileNameTemplate: '${title}.${ext}',
    deepSearchAlwaysOn: false,
    captureMemoryLimit: 256,
    notifyOnDrm: true
};

/** 给详情面板喂一份真实的清单，否则预览里只会显示"获取失败"， */
const SAMPLE_MASTER = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
    '1080p/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
    '720p/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480,CODECS="avc1.42c01e,mp4a.40.2"',
    '480p/index.m3u8'
].join('\n');

const SAMPLE_MEDIA = (function () {
    const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:10',
        '#EXT-X-MEDIA-SEQUENCE:0'
    ];
    for (let i = 0; i < 24; i++) {
        lines.push('#EXTINF:10.000,');
        lines.push('seg-' + i + '.ts');
    }
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n');
})();

// ---------------------------------------------------------------
// 桩代码
// ---------------------------------------------------------------

const STUB = `
<script>
/* ===== 预览桩：模拟扩展运行环境，仅用于界面核对 ===== */
(function () {
    const ITEMS = ${JSON.stringify(SAMPLE_ITEMS, null, 2)};
    const CONFIG = ${JSON.stringify(SAMPLE_CONFIG, null, 2)};
    const MASTER = ${JSON.stringify(SAMPLE_MASTER)};
    const MEDIA = ${JSON.stringify(SAMPLE_MEDIA)};

    // 页面注册的消息监听器。预览里手动触发，用来演示下载进度。
    const messageListeners = [];

    const responses = {
        // 让预览展示"捕获进行中"的完整状态：捕获按钮高亮 + 导出按钮出现
        'popup:getData': { ok: true, tabId: 1, items: ITEMS,
            counts: { total: ITEMS.length }, keepAlive: true,
            capturing: true, canExport: true },
        'popup:getConfig': { ok: true, config: CONFIG },
        'popup:setConfig': { ok: true, config: CONFIG },
        'popup:clear': { ok: true },
        'popup:clearAll': { ok: true },
        'popup:inject': { ok: true },
        'popup:stopCapture': { ok: true },
        'popup:download': { ok: true },
        'popup:downloadStream': { ok: true, taskId: 'demo-task' },
        'popup:abortStream': { ok: true },
        'tool:getItem': { ok: true, item: ITEMS[0] }
    };

    // 与 _locales/zh_CN/messages.json 保持一致
    const MESSAGES = {
        extName: '鲸吞',
        extDesc: '浏览器媒体资源嗅探与下载扩展',
        pageOptions: '设置',
        pageM3u8: 'M3U8 解析',
        pagePreview: '预览播放'
    };

    window.chrome = {
        i18n: {
            getMessage: (key) => MESSAGES[key] || ''
        },
        runtime: {
            lastError: null,
            getManifest: () => ({ version: '1.0.0', name: '鲸吞' }),
            getURL: (p) => p,
            openOptionsPage: () => console.log('[预览] openOptionsPage'),
            sendMessage: (msg, cb) => {
                const type = typeof msg === 'string' ? msg : msg && msg.type;
                let res;

                if (type === 'tool:fetchText') {
                    // 地址里带 master 的当主列表，其余当媒体列表，
                    // 这样详情面板能走完"选码率 → 看分片"的完整流程
                    const url = (msg && msg.url) || '';
                    res = { ok: true, via: 'extension',
                        text: url.indexOf('master') !== -1 ? MASTER : MEDIA };
                } else {
                    res = responses[type] || { ok: true };
                }

                if (cb) { setTimeout(() => cb(res), 0); return; }
                return Promise.resolve(res);
            },
            onMessage: { addListener: (fn) => messageListeners.push(fn) }
        },
        tabs: {
            query: () => Promise.resolve([{ id: 1, title: '示例页面标题',
                url: 'https://example.com/watch/12345' }]),
            create: (o) => console.log('[预览] tabs.create', o.url),
            sendMessage: (id, m, cb) => { if (cb) cb({ ok: true }); }
        },
        storage: {
            local: {
                get: () => Promise.resolve({}),
                set: () => Promise.resolve()
            }
        },
        downloads: { download: () => Promise.resolve(1) }
    };

    // 让按钮点击有可见反馈，而不是静默无事发生
    document.addEventListener('click', function (e) {
        const btn = e.target.closest && e.target.closest('button');
        if (!btn) return;
        console.log('[预览] 点击:', btn.id || btn.textContent.trim());
    }, true);

    // 详情面板预览：由 popup-detail.html 设置 __PREVIEW_VIEW__
    if (window.__PREVIEW_VIEW__ === 'detail') {
        setTimeout(function () {
            // 找到第一个流媒体条目，点它的主操作按钮进详情
            const rows = document.querySelectorAll('.item');
            for (const row of rows) {
                const badge = row.querySelector('.item-badge');
                if (!badge || badge.textContent.trim() !== '流') continue;
                const btn = row.querySelector('.act.is-primary');
                if (btn) { btn.click(); break; }
            }

            // 再补一次进度推送，让进度条有内容可看
            setTimeout(function () {
                const payload = {
                    taskId: 'demo-task', percent: 42, completed: 10, total: 24,
                    bytes: 1024 * 1024 * 38, speed: 1024 * 1024 * 3.2, failed: 0
                };
                for (const fn of messageListeners) {
                    fn({ type: 'stream:progress', payload: payload });
                }
            }, 900);
        }, 200);
    }
})();
<\/script>
`;

// ---------------------------------------------------------------
// 生成
// ---------------------------------------------------------------

/** 把桩代码插到页面第一个 <script> 之前（业务脚本必须先看到 chrome） */
function injectStub(html, extraHead) {
    const block = (extraHead || '') + STUB;
    const idx = html.indexOf('<script');
    if (idx === -1) {
        // 没有脚本的页面插到 body 末尾
        return html.replace('</body>', block + '</body>');
    }
    return html.slice(0, idx) + block + '\n' + html.slice(idx);
}

/**
 * 把页面里的相对路径改写成内联内容
 * @param {string} html
 * @returns {string}
 */
function inlineAssets(html) {
    // <link rel="stylesheet" href="xxx.css"> → <style>...</style>
    html = html.replace(
        /<link[^>]*rel\s*=\s*"stylesheet"[^>]*href\s*=\s*"([^"]+)"[^>]*>/g,
        (match, ref) => {
            if (/^(https?:|\/\/|data:)/.test(ref)) return match;
            const p = path.join(ROOT, ref);
            if (!fs.existsSync(p)) return match;
            return '<style>\n' + fs.readFileSync(p, 'utf8') + '\n</style>';
        }
    );

    // <script src="xxx.js"></script> → <script>...</script>
    html = html.replace(
        /<script[^>]*src\s*=\s*"([^"]+)"[^>]*>\s*<\/script>/g,
        (match, ref) => {
            if (/^(https?:|\/\/|data:)/.test(ref)) return match;
            const p = path.join(ROOT, ref);
            if (!fs.existsSync(p)) return match;

            let code = fs.readFileSync(p, 'utf8');
            // 内联脚本里出现 </script> 会提前结束标签，必须打断
            code = code.replace(/<\/script>/gi, '<\\/script>');
            return '<script>\n' + code + '\n</script>';
        }
    );

    // <img src="xxx.png"> → data URI
    html = html.replace(
        /<img([^>]*?)src\s*=\s*"([^"]+)"([^>]*?)>/g,
        (match, pre, ref, post) => {
            if (/^(https?:|\/\/|data:)/.test(ref)) return match;
            const p = path.join(ROOT, ref);
            if (!fs.existsSync(p)) return match;
            const ext = path.extname(ref).slice(1).toLowerCase();
            const mime = ext === 'svg' ? 'image/svg+xml' : 'image/' + ext;
            const b64 = fs.readFileSync(p).toString('base64');
            return `<img${pre}src="data:${mime};base64,${b64}"${post}>`;
        }
    );

    return html;
}

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const PAGES = ['popup.html', 'm3u8.html', 'preview.html', 'options.html'];
let count = 0;

for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    // 顺序要紧：先内联资源，再插桩，桩必须排在业务脚本之前
    const inlined = inlineAssets(html);
    const out = injectStub(inlined);
    const target = path.join(OUT, page);

    fs.writeFileSync(target, out, 'utf8');
    const kb = (fs.statSync(target).size / 1024).toFixed(0);
    console.log('  [v] ' + path.relative(ROOT, target).replace(/\\/g, '/') + '  ' + kb + 'KB');
    count++;

    // 弹窗额外生成一份"已打开详情面板"的版本，
    // 否则详情面板在预览里永远是隐藏的，看不到
    if (page === 'popup.html') {
        const detailOut = injectStub(
            inlined,
            '<script>window.__PREVIEW_VIEW__ = "detail";<\/script>'
        );
        const detailTarget = path.join(OUT, 'popup-detail.html');
        fs.writeFileSync(detailTarget, detailOut, 'utf8');
        console.log('  [v] ' + path.relative(ROOT, detailTarget).replace(/\\/g, '/'));
        count++;
    }
}

// 附一个索引页，方便逐个打开
const index = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>鲸吞：界面预览</title>
<style>
body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
       background: #f5f7f9; color: #1a1d21; max-width: 640px; margin: 0 auto; padding: 40px 24px; }
h1 { font-size: 20px; margin-bottom: 6px; }
p.sub { color: #8b949e; font-size: 13px; margin-bottom: 24px; }
a { display: block; padding: 14px 18px; margin-bottom: 10px; background: #fff;
    border: 1px solid #e2e7ec; border-radius: 8px; color: #1b6ca8;
    text-decoration: none; font-size: 14px; }
a:hover { border-color: #1b6ca8; }
a span { display: block; color: #8b949e; font-size: 12px; margin-top: 3px; }
</style>
</head>
<body>
<h1>鲸吞：界面预览</h1>
<p class="sub">用桩数据渲染的真实页面，用于核对样式与布局。按钮点击不会真的下载或改配置。</p>
<a href="popup.html">弹窗 · 资源列表<span>筛选、深度搜索、流媒体捕获入口</span></a>
<a href="popup-detail.html">弹窗 · 流媒体详情<span>内嵌播放器、画质选择、后台下载进度</span></a>
<a href="m3u8.html">M3U8 解析<span>链接/文本双入口、码率选择、分片列表、下载控制</span></a>
<a href="preview.html">预览播放<span>hls.js 播放器与流信息</span></a>
<a href="options.html">设置<span>全部配置项与文件名模板预览</span></a>
</body>
</html>
`;
fs.writeFileSync(path.join(OUT, 'index.html'), index, 'utf8');
console.log('  [v] ' + path.relative(ROOT, path.join(OUT, 'index.html')).replace(/\\/g, '/'));
count++;

console.log(`\n共生成 ${count} 个文件，直接双击 tools/preview/index.html 即可查看`);
