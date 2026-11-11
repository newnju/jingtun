/** 验证内置 FFmpeg 核心能完成 TS 转封装与音视频合并 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const CORE_DIR = path.join(__dirname, '..', 'lib', 'ffmpeg');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ffmpeg');

function checkMp4(buffer, label) {
    assert(buffer.length > 10000, label + ' 输出过小');
    assert(buffer.indexOf(Buffer.from('ftyp')) !== -1, label + ' 缺少 ftyp');
    assert(buffer.indexOf(Buffer.from('moov')) !== -1, label + ' 缺少 moov');
}

function tryUnlink(core, name) {
    try {
        core.FS.unlink(name);
    } catch (e) {
        // 文件可能已经不存在
    }
}

async function main() {
    const corePath = path.join(CORE_DIR, 'ffmpeg-core.js');
    const { default: createFFmpegCore } = await import(pathToFileURL(corePath).href);

    const logs = [];
    const core = await createFFmpegCore({
        locateFile: (file) => path.join(CORE_DIR, file)
    });

    core.setLogger((line) => {
        if (line) logs.push(typeof line === 'string' ? line : JSON.stringify(line));
    });

    try {
        core.FS.writeFile('in.ts', fs.readFileSync(path.join(FIXTURE_DIR, 'test.ts')));

        core.exec(
            '-hide_banner', '-i', 'in.ts',
            '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
            '-movflags', '+faststart', 'out.mp4'
        );
        assert.strictEqual(core.ret, 0, 'TS 转封装失败：' + logs.slice(-3).join(' / '));
        checkMp4(Buffer.from(core.FS.readFile('out.mp4')), 'TS 转封装');
        tryUnlink(core, 'in.ts');
        tryUnlink(core, 'out.mp4');
        console.log('  [v] TS 转 MP4');

        core.FS.writeFile('v.mp4', fs.readFileSync(path.join(FIXTURE_DIR, 'v.mp4')));
        core.FS.writeFile('a.mp4', fs.readFileSync(path.join(FIXTURE_DIR, 'a.mp4')));

        core.exec(
            '-hide_banner', '-i', 'v.mp4', '-i', 'a.mp4',
            '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0',
            '-movflags', '+faststart', 'merged.mp4'
        );
        assert.strictEqual(core.ret, 0, '音视频合并失败：' + logs.slice(-3).join(' / '));
        checkMp4(Buffer.from(core.FS.readFile('merged.mp4')), '音视频合并');
        tryUnlink(core, 'v.mp4');
        tryUnlink(core, 'a.mp4');
        tryUnlink(core, 'merged.mp4');
        console.log('  [v] 音视频合并');

        console.log('\nFFmpeg 转封装与合并测试通过');
    } finally {
        tryUnlink(core, 'in.ts');
        tryUnlink(core, 'out.mp4');
        tryUnlink(core, 'v.mp4');
        tryUnlink(core, 'a.mp4');
        tryUnlink(core, 'merged.mp4');
    }
}

main().catch((e) => {
    console.error('\n[x] 失败:', e && e.message ? e.message : e);
    process.exit(1);
});
