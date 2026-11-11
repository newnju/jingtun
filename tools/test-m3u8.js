/** 鲸吞：M3U8 解析器测试（含 LL-HLS / 直播 / 备用轨道） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        passed++;
        console.log('  [v] ' + name);
    } else {
        failed++;
        console.log('  [x] ' + name + '\n          期望 ' + JSON.stringify(expected) +
            '，实际 ' + JSON.stringify(actual));
    }
}

function checkTrue(name, value) {
    if (value) {
        passed++;
        console.log('  [v] ' + name);
    } else {
        failed++;
        console.log('  [x] ' + name);
    }
}

const src = fs.readFileSync(path.join(ROOT, 'js/m3u8.js'), 'utf8');
const sandbox = { console: console, crypto: globalThis.crypto, URL: URL };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const JTM3u8 = sandbox.JTM3u8;

const BASE = 'https://cdn.example.com/live/index.m3u8';

// ============================================================

console.log('== 点播基线（回归） ==');

const VOD = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:9.009,',
    'seg0.ts',
    '#EXTINF:9.009,',
    'seg1.ts',
    '#EXT-X-ENDLIST'
].join('\n');

{
    const p = JTM3u8.parse(VOD, BASE);
    checkTrue('解析成功', p.ok);
    check('分片数', p.segments.length, 2);
    checkTrue('点播不是直播', p.isLive === false);
    checkTrue('有 ENDLIST', p.isEndList === true);
    check('总时长', Math.round(p.totalDuration * 1000) / 1000, 18.018);
    check('相对地址补全', p.segments[0].url,
        'https://cdn.example.com/live/seg0.ts');
    check('建议容器为 ts', JTM3u8.suggestOutput(p).ext, 'ts');
}

console.log('\n== 直播与事件型清单 ==');

{
    const live = JTM3u8.parse([
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:100',
        '#EXTINF:4.000,',
        'a.ts',
        '#EXTINF:4.000,',
        'b.ts'
    ].join('\n'), BASE);

    checkTrue('没有 ENDLIST 判为直播', live.isLive === true);
    checkTrue('直播不是事件型', live.isEvent === false);
    check('媒体序号', live.mediaSequence, 100);
    check('分片序号从媒体序号算起', live.segments[0].sequence, 100);
    check('第二片序号', live.segments[1].sequence, 101);

    const event = JTM3u8.parse([
        '#EXTM3U',
        '#EXT-X-PLAYLIST-TYPE:EVENT',
        '#EXT-X-TARGETDURATION:4',
        '#EXTINF:4.000,',
        'a.ts'
    ].join('\n'), BASE);

    checkTrue('EVENT 清单被识别', event.isEvent === true);
    check('playlistType', event.playlistType, 'EVENT');
}

console.log('\n== 备用音轨与字幕（EXT-X-MEDIA） ==');

const MASTER = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="中文",LANGUAGE="zh",DEFAULT=YES,AUTOSELECT=YES,URI="audio-zh.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=NO,URI="audio-en.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="中文",LANGUAGE="zh",URI="sub-zh.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"',
    'v360.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"',
    'v720.m3u8'
].join('\n');

{
    const p = JTM3u8.parse(MASTER, BASE);

    checkTrue('主播放列表解析成功', p.ok && p.isMaster);
    check('码率档位数', p.levels.length, 2);
    check('按码率从高到低排序', p.levels[0].bandwidth, 2400000);
    check('档位带音频组', p.levels[0].audioGroup, 'aud');
    check('档位带上了组内音轨', p.levels[0].audioRenditions.length, 2);

    check('备用轨道数', p.renditions.length, 3);
    check('音轨数', p.renditions.filter((r) => r.type === 'AUDIO').length, 2);
    check('字幕数', p.renditions.filter((r) => r.type === 'SUBTITLES').length, 1);
    check('音轨地址补全', p.renditions[0].uri,
        'https://cdn.example.com/live/audio-zh.m3u8');

    const zh = JTM3u8.pickRendition(p, 'AUDIO', 'zh');
    checkTrue('能按语言挑音轨', !!zh && zh.language === 'zh');

    const en = JTM3u8.pickRendition(p, 'AUDIO', 'en');
    checkTrue('能挑到英文轨', !!en && en.language === 'en');

    const fallback = JTM3u8.pickRendition(p, 'AUDIO', 'ja');
    checkTrue('指定语言但不存在时不猜，返回 null', fallback === null);

    checkTrue('没有字幕轨时返回 null', JTM3u8.pickRendition(p, 'SUBTITLES', 'ja') === null);
    checkTrue('类型不存在时返回 null', JTM3u8.pickRendition(p, 'VIDEO') === null);

    // 不指定语言时才回落到默认轨
    const anyAudio = JTM3u8.pickRendition(p, 'AUDIO');
    checkTrue('不指定语言时回落到默认轨',
        !!anyAudio && anyAudio.language === 'zh');
}

console.log('\n== 会话级密钥与密钥格式 ==');

{
    const p = JTM3u8.parse([
        '#EXTM3U',
        '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key.bin"',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXTINF:4.0,',
        'a.ts',
        '#EXT-X-ENDLIST'
    ].join('\n'), BASE);

    check('会话密钥数量', p.sessionKeys.length, 1);
    check('会话密钥地址', p.sessionKeys[0].uri,
        'https://cdn.example.com/live/key.bin');
    checkTrue('标记为加密', p.hasEncryption === true);
    checkTrue('会话密钥不会漏到每个分片上', p.segments[0].key === null);
}

{
    const p = JTM3u8.parse([
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:4.0,',
        'a.m4s',
        '#EXT-X-ENDLIST'
    ].join('\n'), BASE);

    checkTrue('SAMPLE-AES 被识别', p.sampleEncrypted === true);
    check('分片上的方法', p.segments[0].key.method, 'SAMPLE-AES');
    checkTrue('分片被标记为样本级加密', p.segments[0].key.sampleEncrypted === true);
    checkTrue('非 identity 的 KEYFORMAT 被标记为不支持',
        p.segments[0].key.unsupported === true);
}

{
    const p = JTM3u8.parse([
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789abcdef0123456789abcdef',
        '#EXT-X-MEDIA-SEQUENCE:10',
        '#EXTINF:4.0,',
        'a.ts',
        '#EXT-X-ENDLIST'
    ].join('\n'), BASE);

    check('IV 原样保留', p.segments[0].key.iv, '0x0123456789abcdef0123456789abcdef');
    check('序号 = 媒体序号', p.segments[0].sequence, 10);
}

console.log('\n== 低延迟 HLS（EXT-X-PART / PRELOAD-HINT） ==');

{
    const p = JTM3u8.parse([
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-PART:DURATION=1.0,URI="part0.mp4",INDEPENDENT=YES',
        '#EXT-X-PART:DURATION=1.0,URI="part1.mp4"',
        '#EXTINF:4.0,',
        'full0.mp4',
        '#EXT-X-PART:DURATION=1.0,URI="part2.mp4"',
        '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part3.mp4"'
    ].join('\n'), BASE);

    check('分片数', p.segments.length, 1);
    check('第一段带上了 2 个片段', p.segments[0].parts.length, 2);
    check('片段地址补全', p.segments[0].parts[0].url,
        'https://cdn.example.com/live/part0.mp4');
    check('片段时长', p.segments[0].parts[0].duration, 1.0);
    checkTrue('第一个片段标记为独立', p.segments[0].parts[0].independent === true);

    checkTrue('有预加载提示', !!p.preloadHint);
    check('预加载地址', p.preloadHint.url,
        'https://cdn.example.com/live/part3.mp4');
    check('预加载类型', p.preloadHint.type, 'PART');
}

console.log('\n== 差分清单与不连续点 ==');

{
    const p = JTM3u8.parse([
        '#EXTM3U',
        '#EXT-X-SKIP:SKIPPED-SEGMENTS=20',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:20',
        '#EXTINF:4.0,',
        'a.ts',
        '#EXT-X-ENDLIST'
    ].join('\n'), BASE);

    checkTrue('识别为差分清单', p.isDelta === true);
    check('跳过的分片数', p.skippedSegments, 20);
}

{
    const p = JTM3u8.parse([
        '#EXTM3U',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:4.0,',
        'a.m4s',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-MAP:URI="init2.mp4"',
        '#EXTINF:4.0,',
        'b.m4s',
        '#EXTINF:4.0,',
        'c.m4s',
        '#EXT-X-ENDLIST'
    ].join('\n'), BASE);

    checkTrue('第二片标记在不连续点之后', p.segments[1].discontinuity === true);
    checkTrue('第一片不在不连续点', p.segments[0].discontinuity === false);
    check('不连续点后的初始化段变了', p.segments[1].initSegment.url,
        'https://cdn.example.com/live/init2.mp4');
    checkTrue('第一片仍用第一个初始化段', p.segments[0].initSegment !== p.segments[1].initSegment);
}

console.log('\n== 占位段、I 帧清单、起始位置 ==');

{
    const p = JTM3u8.parse([
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        '#EXTINF:4.0,',
        'a.ts',
        '#EXT-X-GAP',
        '#EXTINF:4.0,',
        'b.ts',
        '#EXT-X-ENDLIST'
    ].join('\n'), BASE);

    checkTrue('占位段被标记', p.segments[1].gap === true);
    checkTrue('正常段没有占位标记', p.segments[0].gap === false);
}

{
    const p = JTM3u8.parse([
        '#EXTM3U',
        '#EXT-X-I-FRAMES-ONLY',
        '#EXT-X-TARGETDURATION:4',
        '#EXTINF:4.0,',
        'a.ts',
        '#EXT-X-ENDLIST'
    ].join('\n'), BASE);

    checkTrue('识别为 I 帧清单', p.iFramesOnly === true);
}

{
    const p = JTM3u8.parse([
        '#EXTM3U',
        '#EXT-X-START:TIME-OFFSET=30',
        '#EXT-X-TARGETDURATION:4',
        '#EXTINF:4.0,',
        'a.ts',
        '#EXT-X-ENDLIST'
    ].join('\n'), BASE);

    check('起始位置', p.startPosition, 30);
}

console.log('\n== 边界 ==');

checkTrue('空文本', !JTM3u8.parse('', BASE).ok);
checkTrue('没有 EXTM3U 头', !JTM3u8.parse('<html></html>', BASE).ok);
checkTrue('主播放列表没有档位', !JTM3u8.parse(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n', BASE).ok);
checkTrue('未知标签被忽略', JTM3u8.parse(
    '#EXTM3U\n#EXT-X-WHATEVER:x\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST', BASE).ok);
check('绝对地址不被改写',
    JTM3u8.parse('#EXTM3U\n#EXTINF:4,\nhttps://other.example.com/a.ts\n#EXT-X-ENDLIST', BASE)
        .segments[0].url,
    'https://other.example.com/a.ts');
check('协议相对地址',
    JTM3u8.parse('#EXTM3U\n#EXTINF:4,\n//other.example.com/a.ts\n#EXT-X-ENDLIST', BASE)
        .segments[0].url,
    'https://other.example.com/a.ts');

console.log('\n== 属性解析 ==');

check('引号里的逗号不切分',
    JTM3u8.parseAttributes('CODECS="avc1.4d401f,mp4a.40.2",BANDWIDTH=1').CODECS,
    'avc1.4d401f,mp4a.40.2');
check('无引号值', JTM3u8.parseAttributes('METHOD=AES-128').METHOD, 'AES-128');

// ============================================================

console.log('\n' + '='.repeat(46));
if (failed === 0) {
    console.log(`全部通过（${passed} 项）`);
} else {
    console.log(`通过 ${passed} 项，失败 ${failed} 项`);
}
process.exit(failed === 0 ? 0 : 1);