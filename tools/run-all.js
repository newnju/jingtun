/** 跑一遍所有检查与测试 */
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const fast = process.argv.indexOf('--fast') !== -1;

// playwright-core 装在隔离的 workspace 里
const WORKSPACE = process.env.PLAYWRIGHT_MODULES || path.join(ROOT, 'node_modules');

const STATIC = [
    { file: 'tools/check.js', name: '静态一致性（15 类）' },
    { file: 'tools/check-messages.js', name: '消息链路闭环' },
    { file: 'tools/test-regression.js', name: '回归（历史问题）' },
    { file: 'tools/check-coverage.js', name: '模块覆盖率' },
    { file: 'tools/check-ffmpeg-license.js', name: 'FFmpeg 核心许可与能力' }
];

const UNIT = [
    { file: 'tools/test-capture.js', name: 'MSE 捕获' },
    { file: 'tools/test-mpd.js', name: 'MPD 解析' },
    { file: 'tools/test-deep-search.js', name: '深度搜索' },
    { file: 'tools/test-i18n.js', name: '注入层文案' },
    { file: 'tools/test-inline-player.js', name: '内嵌播放器时序' },
    { file: 'tools/test-inject-modules.js', name: '注入脚本与兼容层' },
    { file: 'tools/test-limits.js', name: '边界与性能' },
    { file: 'tools/test-ffmpeg-remux.js', name: 'FFmpeg 转封装与合并' }
];

const INTEGRATION = [
    { file: 'tools/test-background.js', name: '后台集成（真实浏览器）', timeout: 90000 },
    { file: 'tools/test-pages.js', name: '各页面渲染（真实浏览器）', timeout: 120000 },
    { file: 'tools/test-behavior.js', name: '行为验证（操作后状态对不对）', timeout: 120000 },
    { file: 'tools/test-e2e.js', name: '端到端（真媒体/真解密）', timeout: 180000 },
    { file: 'tools/test-playback.js', name: '真实播放（真视频/真起播）', timeout: 240000 }
];

let allOk = true;
const summary = [];

function run(group, items) {
    if (items.length === 0) return;

    console.log('\n' + '─'.repeat(50));
    console.log(group);
    console.log('─'.repeat(50));

    for (const item of items) {
        const started = Date.now();

        try {
            const out = execFileSync(NODE, [item.file], {
                cwd: ROOT,
                encoding: 'utf8',
                env: Object.assign({}, process.env, { NODE_PATH: WORKSPACE }),
                timeout: item.timeout || 90000,
                // stdin 显式忽略：默认的 'pipe' 会让子进程以为还有人给它喂输入，
                // 集成测试里启动的 Chromium 有时会因此不退出（实测踩过）。
                stdio: ['ignore', 'pipe', 'pipe'],
                maxBuffer: 16 * 1024 * 1024
            });

            // 取最后一行非空输出当作结论
            const lines = out.trim().split('\n').filter(Boolean);
            const last = lines[lines.length - 1] || '';
            const ms = Date.now() - started;

            console.log('  [OK] ' + item.name.padEnd(26) + last + '  (' + (ms / 1000).toFixed(1) + 's)');
            summary.push({ name: item.name, ok: true, result: last });
        } catch (e) {
            const ms = Date.now() - started;
            const out = (e.stdout || '') + (e.stderr || '');
            const lines = out.trim().split('\n').filter(Boolean);
            const last = lines[lines.length - 1] || '失败';

            const why = e.signal === 'SIGTERM' || e.killed
                ? '超时 ' + ((item.timeout || 90000) / 1000) + 's'
                : last;

            console.log('  [FAIL] ' + item.name.padEnd(26) + why + '  (' + (ms / 1000).toFixed(1) + 's)');
            summary.push({ name: item.name, ok: false, result: last });
            allOk = false;

            // 失败时把关键行也打出来
            const bad = lines.filter((l) => /\[x\]|失败|Error/.test(l)).slice(0, 6);
            bad.forEach((l) => console.log('      ' + l.trim()));
        }
    }
}

console.log('鲸吞：全量检查');
if (fast) console.log('（--fast 模式：跳过集成测试）');

run('一、静态检查', STATIC);
run('二、纯逻辑测试', UNIT);

if (!fast) {
    run('三、集成测试（真启动浏览器）', INTEGRATION);
}

console.log('\n' + '='.repeat(50));

const okCount = summary.filter((s) => s.ok).length;
console.log(allOk
    ? '全部通过（' + okCount + ' 组）'
    : okCount + '/' + summary.length + ' 组通过，有失败');

if (!allOk) {
    console.log('\n失败的组:');
    summary.filter((s) => !s.ok).forEach((s) => console.log('  - ' + s.name + ': ' + s.result));
}

process.exit(allOk ? 0 : 1);
