/** 鲸吞：MPD 解析器测试 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ============================================================
// 最小 XML 解析器（只为测试而写，不追求完整）
// ============================================================

class XmlNode {
    constructor(name) {
        this.nodeType = 1;
        this.nodeName = name;
        this.localName = name.indexOf(':') === -1 ? name : name.split(':').pop();
        this.attributes = {};
        this.children = [];
    }

    getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name)
            ? this.attributes[name]
            : null;
    }

    /** 与真实 DOM 一致：getElementsByTagName 匹配 qualified name（nodeName）。 */
    getElementsByTagName(name) {
        const out = [];
        (function walk(node) {
            for (const child of node.children) {
                if (name === '*' || child.nodeName === name) out.push(child);
                walk(child);
            }
        })(this);
        return out;
    }

    /** NS 版本按 localName 匹配 */
    getElementsByTagNameNS(ns, name) {
        const out = [];
        (function walk(node) {
            for (const child of node.children) {
                if (name === '*' || child.localName === name) out.push(child);
                walk(child);
            }
        })(this);
        return out;
    }
}

function parseAttrs(str) {
    const attrs = {};
    const re = /([^\s=]+)\s*=\s*"([^"]*)"|([^\s=]+)\s*=\s*'([^']*)'/g;
    let m;
    while ((m = re.exec(str)) !== null) {
        attrs[m[1] || m[3]] = m[2] !== undefined ? m[2] : m[4];
    }
    return attrs;
}

function parseXml(source) {
    const text = String(source)
        .replace(/<\?[\s\S]*?\?>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<!DOCTYPE[^>]*>/g, '');

    const root = new XmlNode('#document');
    const stack = [root];
    let i = 0;

    while (i < text.length) {
        const lt = text.indexOf('<', i);
        if (lt === -1) break;
        const gt = text.indexOf('>', lt);
        if (gt === -1) break;

        const raw = text.slice(lt + 1, gt);

        if (raw.charAt(0) === '/') {
            if (stack.length > 1) stack.pop();
            i = gt + 1;
            continue;
        }

        const selfClosing = raw.charAt(raw.length - 1) === '/';
        const inner = selfClosing ? raw.slice(0, -1) : raw;
        const m = /^([^\s]+)([\s\S]*)$/.exec(inner);
        const name = m ? m[1] : inner;

        const el = new XmlNode(name);
        el.attributes = parseAttrs(m ? m[2] : '');

        stack[stack.length - 1].children.push(el);
        if (!selfClosing) stack.push(el);

        i = gt + 1;
    }

    return root;
}

class FakeDOMParser {
    parseFromString(text) {
        return parseXml(text);
    }
}

// ============================================================
// 载入被测模块
// ============================================================

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js/mpd.js'), 'utf8');

const sandbox = {
    DOMParser: FakeDOMParser,
    URL: URL,
    console: console
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const JTMpd = sandbox.JTMpd;

// ============================================================
// 断言
// ============================================================

let failed = 0;
let passed = 0;

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
// 样例
// ============================================================

const BASE = 'https://cdn.example.com/dash/manifest.mpd';

/** 常见形态：SegmentTemplate + 音视频分离 */
const SEGMENT_TEMPLATE_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"
     mediaPresentationDuration="PT30S" minBufferTime="PT2S">
  <Period id="0">
    <AdaptationSet mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate timescale="1000" duration="5000" startNumber="1"
        initialization="video/init-$RepresentationID$.mp4"
        media="video/$RepresentationID$/$Number$.m4s"/>
      <Representation id="v1" bandwidth="3000000" width="1920" height="1080" codecs="avc1.640028"/>
      <Representation id="v2" bandwidth="1500000" width="1280" height="720" codecs="avc1.4d401f"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="zh">
      <SegmentTemplate timescale="1000" duration="5000" startNumber="1"
        initialization="audio/init.mp4"
        media="audio/$Number$.m4s"/>
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;

/** SegmentList 寻址 */
const SEGMENT_LIST_MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="r1" bandwidth="800000" width="640" height="360">
        <SegmentList timescale="1000" duration="5000">
          <Initialization sourceURL="init.mp4"/>
          <SegmentURL media="seg-1.m4s"/>
          <SegmentURL media="seg-2.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

/** 带 DRM */
const DRM_MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>
      <SegmentTemplate timescale="1000" duration="5000" startNumber="1" media="$Number$.m4s"/>
      <Representation id="v1" bandwidth="1000000" width="1280" height="720"/>
    </AdaptationSet>
  </Period>
</MPD>`;

/** 直播（dynamic） */
const LIVE_MPD = `<?xml version="1.0"?>
<MPD type="dynamic" mediaPresentationDuration="PT600S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <SegmentTemplate timescale="1000" duration="4000" startNumber="1" media="$Number$.m4s"/>
      <Representation id="v1" bandwidth="2000000" width="1280" height="720"/>
    </AdaptationSet>
  </Period>
</MPD>`;

/** 带命名空间前缀 */
const NS_PREFIX_MPD = `<?xml version="1.0"?>
<mpd:MPD xmlns:mpd="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S">
  <mpd:Period>
    <mpd:AdaptationSet mimeType="video/mp4">
      <mpd:SegmentTemplate timescale="1000" duration="4000" startNumber="1" media="$Number$.m4s"/>
      <mpd:Representation id="v1" bandwidth="500000" width="640" height="360"/>
    </mpd:AdaptationSet>
  </mpd:Period>
</mpd:MPD>`;

// ============================================================
// 测试
// ============================================================

console.log('== SegmentTemplate（最常见） ==');

const t1 = JTMpd.parse(SEGMENT_TEMPLATE_MPD, BASE);
checkTrue('解析成功', t1.ok);
check('总时长 30 秒', t1.duration, 30);
check('轨道数 3（2 视频 + 1 音频）', t1.tracks.length, 3);
check('第一条是视频轨', t1.tracks[0].type, 'video');
check('第三条是音频轨', t1.tracks[2].type, 'audio');
check('分辨率', [t1.tracks[0].width, t1.tracks[0].height], [1920, 1080]);
check('码率', t1.tracks[0].bandwidth, 3000000);
check('分片数 = ceil(30/5) = 6', t1.tracks[0].segments.length, 6);
check('初始化段地址（$RepresentationID$ 已展开）',
    t1.tracks[0].initUrl, 'https://cdn.example.com/dash/video/init-v1.mp4');
check('第一个分片地址（相对路径已补全）',
    t1.tracks[0].segments[0].url, 'https://cdn.example.com/dash/video/v1/1.m4s');
check('最后一个分片编号是 6',
    t1.tracks[0].segments[5].url, 'https://cdn.example.com/dash/video/v1/6.m4s');
check('分片时长（5000/1000）', t1.tracks[0].segments[0].duration, 5);
check('音频轨语言', t1.tracks[2].lang, 'zh');

console.log('\n== SegmentList ==');

const t2 = JTMpd.parse(SEGMENT_LIST_MPD, BASE);
checkTrue('解析成功', t2.ok);
check('分片数 2', t2.tracks[0].segments.length, 2);
check('初始化段', t2.tracks[0].initUrl, 'https://cdn.example.com/dash/init.mp4');
check('分片地址', t2.tracks[0].segments[1].url, 'https://cdn.example.com/dash/seg-2.m4s');
check('总时长累加 = 10', t2.tracks[0].totalDuration, 10);

console.log('\n== DRM 识别 ==');

const t3 = JTMpd.parse(DRM_MPD, BASE);
checkTrue('解析成功', t3.ok);
checkTrue('标记为受保护', t3.hasDrm);
check('识别出两个系统', t3.drmSystems, ['Widevine', 'PlayReady']);

console.log('\n== 直播 ==');

const t4 = JTMpd.parse(LIVE_MPD, BASE);
checkTrue('解析成功', t4.ok);
checkTrue('标记为直播', t4.isLive);

console.log('\n== 命名空间前缀 ==');

const t5 = JTMpd.parse(NS_PREFIX_MPD, BASE);
checkTrue('解析成功（<mpd:MPD> 这类写法）', t5.ok);
check('轨道数 1', t5.tracks.length, 1);
check('分片数 = ceil(8/4) = 2', t5.tracks[0].segments.length, 2);

console.log('\n== 转写成 m3u8 ==');

const m3u8 = JTMpd.toM3u8(t1.tracks[0]);
const lines = m3u8.split('\n');

checkTrue('以 #EXTM3U 开头', lines[0] === '#EXTM3U');
checkTrue('含 #EXT-X-MAP（fMP4 标记）',
    lines.some((l) => l.indexOf('#EXT-X-MAP:URI="https://cdn.example.com/dash/video/init-v1.mp4"') === 0));
checkTrue('含 #EXT-X-ENDLIST（点播）', lines.indexOf('#EXT-X-ENDLIST') !== -1);
check('EXTINF 数量 = 分片数', lines.filter((l) => l.indexOf('#EXTINF:') === 0).length, 6);

// 转写结果必须能被现有的 m3u8 解析器吃掉，这是复用的前提
const m3u8Src = fs.readFileSync(path.join(ROOT, 'js/m3u8.js'), 'utf8');
const sandbox2 = { console: console, crypto: crypto };
vm.createContext(sandbox2);
vm.runInContext(m3u8Src, sandbox2);
const JTM3u8 = sandbox2.JTM3u8;

const reparsed = JTM3u8.parse(m3u8, BASE);
checkTrue('转写结果能被 HLS 解析器解析', reparsed.ok);
check('解析出的分片数一致', reparsed.segments.length, 6);
checkTrue('识别出初始化段', !!reparsed.initSegment);
check('建议输出容器为 mp4（因为有 EXT-X-MAP）',
    JTM3u8.suggestOutput(reparsed).ext, 'mp4');
check('分片地址正确',
    reparsed.segments[0].url, 'https://cdn.example.com/dash/video/v1/1.m4s');

console.log('\n== 边界情况 ==');

checkTrue('空文本不崩', !JTMpd.parse('', BASE).ok);
checkTrue('非 MPD 内容不崩', !JTMpd.parse('<html></html>', BASE).ok);
checkTrue('无分片信息时不崩', !JTMpd.parse(
    '<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation id="x"/></AdaptationSet></Period></MPD>',
    BASE
).ok);

check('ISO 时长 PT1H30M', JTMpd.parseIsoDuration('PT1H30M'), 5400);
check('ISO 时长 PT45.5S', JTMpd.parseIsoDuration('PT45.5S'), 45.5);
check('ISO 时长 PT2M30S', JTMpd.parseIsoDuration('PT2M30S'), 150);

// ============================================================

console.log('\n' + '='.repeat(46));
if (failed === 0) {
    console.log(`全部通过（${passed} 项）`);
} else {
    console.log(`通过 ${passed} 项，失败 ${failed} 项`);
}
process.exit(failed === 0 ? 0 : 1);
