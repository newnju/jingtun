/** 鲸吞：直播清单加载器测试 */
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

const sandbox = {
    console: console,
    URL: URL,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/m3u8.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/live.js'), 'utf8'), sandbox);

const JTLive = sandbox.JTLive;
const BASE = 'https://cdn.example.com/live/index.m3u8';

/**
 * 造一份媒体播放列表
 * @param {number} start 起始序号
 * @param {number} count 分片数
 * @param {boolean} [endList]
 * @param {string} [playlistType]
 * @returns {string}
 */
function playlist(start, count, endList, playlistType) {
    const lines = ['#EXTM3U'];
    if (playlistType) lines.push('#EXT-X-PLAYLIST-TYPE:' + playlistType);
    lines.push('#EXT-X-TARGETDURATION:4');
    lines.push('#EXT-X-MEDIA-SEQUENCE:' + start);

    for (let i = 0; i < count; i++) {
        lines.push('#EXTINF:4.000,');
        lines.push('seg' + (start + i) + '.ts');
    }

    if (endList) lines.push('#EXT-X-ENDLIST');
    return lines.join('\n');
}

/**
 * 让 fetchPlaylist 按顺序返回给定的几份清单。
 * 用完后重复最后一份 —— 真实直播就是这样滚动的。
 * @param {Array<string>} texts
 * @param {Object} [options]
 * @returns {{loader: Object, batches: Array, calls: Array, progress: Array}}
 */
function scriptedLoader(texts, options) {
    const calls = [];
    const batches = [];
    const progress = [];
    let index = 0;

    const fetchPlaylist = function (url) {
        calls.push(url);
        const text = texts[Math.min(index, texts.length - 1)];
        index++;
        return Promise.resolve(text);
    };

    const loader = new JTLive.LiveLoader(Object.assign({
        url: BASE,
        baseUrl: BASE,
        fetchPlaylist: fetchPlaylist,
        minInterval: 200,
        maxIdleRounds: 2,
        onBatch: function (batch) {
            batches.push(batch.map((s) => s.url.split('/').pop()));
        },
        onProgress: function (p) {
            progress.push(p);
        }
    }, options || {}));

    return { loader: loader, batches: batches, calls: calls, progress: progress };
}

/**
 * 跑一轮，超过 20 秒就判定测试本身写错了
 * @param {Object} loader
 * @returns {Promise<Object>}
 */
function runBounded(loader) {
    return Promise.race([
        loader.run(),
        new Promise((resolve, reject) => {
            setTimeout(
                () => reject(new Error('直播加载器 20 秒内没有结束，测试没有设上限')),
                20000);
        })
    ]);
}

// ============================================================

console.log('== 跟着清单滚动 ==');

const t0 = scriptedLoader([
    playlist(0, 3, false),
    playlist(1, 3, false),
    playlist(2, 3, false),
    playlist(2, 3, false)
], { maxSegments: 5 });

runBounded(t0.loader).then((result) => {
    // 三轮里出现的分片是 0..4，去重后正好 5 个
    check('去重后的分片数', result.count, 5);
    check('第一批', t0.batches[0], ['seg0.ts', 'seg1.ts', 'seg2.ts']);
    check('第二批只收新的', t0.batches[1], ['seg3.ts']);
    check('第三批也只收新的', t0.batches[2], ['seg4.ts']);
    check('达到上限后停止', result.reason, '已达到下载上限');
    checkTrue('没有 ENDLIST 时不算正常结束', result.ended === false);

    runEndListTest();
}).catch(failRun);

function runEndListTest() {
    console.log('\n== 遇到 ENDLIST 就停 ==');

    const ctx = scriptedLoader([
        playlist(0, 2, false),
        playlist(1, 2, true)      // 第 2 轮带上 ENDLIST
    ]);

    return runBounded(ctx.loader).then((result) => {
        checkTrue('以流结束收尾', result.ended === true);
        check('分片总数', result.count, 3);
        check('停止原因', result.reason, '流已结束');
        return runEventTest();
    }).catch(failRun);
}

function runEventTest() {
    console.log('\n== 事件型清单（只追加） ==');

    const ctx = scriptedLoader([
        playlist(0, 3, false, 'EVENT'),
        playlist(3, 3, true, 'EVENT')
    ]);

    return runBounded(ctx.loader).then((result) => {
        checkTrue('识别为事件型', result.isEvent === true);
        check('分片总数', result.count, 6);
        checkTrue('正常结束', result.ended === true);
        return runLimitTest();
    }).catch(failRun);
}

function runLimitTest() {
    console.log('\n== 上限 ==');

    const byCount = scriptedLoader([
        playlist(0, 2, false),
        playlist(2, 2, false),
        playlist(4, 2, false)
    ], { maxSegments: 3 });

    return runBounded(byCount.loader).then((r1) => {
        check('按分片数封顶（会多收完当前这一批）', r1.count, 4);
        check('达到上限的原因', r1.reason, '已达到下载上限');

        const byDuration = scriptedLoader([
            playlist(0, 1, false),
            playlist(1, 1, false),
            playlist(2, 1, false)
        ], { maxDuration: 10 });    // 每片 4 秒，三片 12 秒越线

        return runBounded(byDuration.loader);
    }).then((r2) => {
        check('按时长封顶', r2.count, 3);
        check('累计时长', r2.duration, 12);
        return runGapTest();
    }).catch(failRun);
}

function runGapTest() {
    console.log('\n== 空洞检测 ==');

    // 第一轮拿到 0、1，第二轮直接从 3 开始：
    // 说明 2 已经滚出窗口，文件中间缺了一块
    const ctx = scriptedLoader([
        playlist(0, 2, false),
        playlist(3, 2, false),
        playlist(4, 1, true)
    ]);

    return runBounded(ctx.loader).then((result) => {
        check('仍然把拿到的分片收齐', result.count, 4);
        check('检测到 1 个空洞', result.gaps, 1);
        return runIdleTest();
    }).catch(failRun);
}

function runIdleTest() {
    console.log('\n== 清单不变 ==');

    // 默认不因为「内容没变」就收工：正常直播里分片较长时
    // 连续几轮没有变化是常有的事。用 maxSegments 兜住测试。
    const ctx = scriptedLoader([
        playlist(0, 2, false),
        playlist(0, 2, false)
    ], { maxSegments: 2 });

    return runBounded(ctx.loader).then((result) => {
        check('清单不变时不重复下载', result.count, 2);

        // 显式开启「长时间不变就收工」
        const stale = scriptedLoader([
            playlist(0, 2, false),
            playlist(0, 2, false),
            playlist(0, 2, false)
        ], { maxUnchangedRounds: 2 });

        return runBounded(stale.loader);
    }).then((r2) => {
        checkTrue('长时间不更新会判定断流', /没有更新/.test(r2.reason));
        check('判定断流前已经收下的分片', r2.count, 2);
        return runFetchFailTest();
    }).catch(failRun);
}

function runFetchFailTest() {
    console.log('\n== 刷新失败 ==');

    // 先给一份清单，之后全部失败；失败超过 maxIdleRounds 就该收手
    let calls = 0;
    const loader = new JTLive.LiveLoader({
        url: BASE,
        baseUrl: BASE,
        minInterval: 200,
        maxIdleRounds: 1,
        fetchRetries: 0,
        fetchPlaylist: function () {
            calls++;
            if (calls === 1) return Promise.resolve(playlist(0, 2, false));
            return Promise.reject(new Error('网络不可达'));
        },
        onBatch: function () {},
        onError: function () {}
    });

    return runBounded(loader).then((result) => {
        check('断流时保留已下载的部分', result.count, 2);
        checkTrue('断流被判定为结束', /断流/.test(result.reason));
        return runSegmentKeyTest();
    }).catch(failRun);
}

function runSegmentKeyTest() {
    console.log('\n== 分片标识 ==');

    check('普通地址',
        JTLive.segmentKey({ url: 'https://a/1.ts', byteRange: null }),
        'https://a/1.ts|');

    check('字节范围要带上区间',
        JTLive.segmentKey({
            url: 'https://a/1.ts',
            byteRange: { offset: 100, length: 50 }
        }),
        'https://a/1.ts|100-50');

    return runEdgeTest();
}

function runEdgeTest() {
    console.log('\n== 边界 ==');

    // 空清单：解析失败，不应该无限刷新
    const noSegments = new JTLive.LiveLoader({
        url: BASE,
        baseUrl: BASE,
        minInterval: 200,
        fetchPlaylist: () => Promise.resolve('#EXTM3U\n#EXT-X-TARGETDURATION:4\n')
    });

    return runBounded(noSegments).then((r) => {
        checkTrue('空清单返回 ok=false', r.ok === false);
        checkTrue('空清单会停下而不是一直刷', /没有解析到/.test(r.reason));

        // 主播放列表必须先选码率
        const master = new JTLive.LiveLoader({
            url: BASE,
            baseUrl: BASE,
            minInterval: 200,
            fetchPlaylist: () => Promise.resolve(
                '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n')
        });

        return runBounded(master);
    }).then((r2) => {
        checkTrue('主播放列表会被拒绝', /码率/.test(r2.reason));

        // 停止后再跑不该继续
        const stopped = scriptedLoader([playlist(0, 1, false)]);
        stopped.loader.stop('用户点了停止');
        checkTrue('已经停止', stopped.loader.isStopped());
        check('停止原因', stopped.loader.stopReason, '用户点了停止');

        finish();
    }).catch(failRun);
}

// ============================================================

function failRun(error) {
    failed++;
    console.log('  [x] ' + (error && error.message ? error.message : error));
    finish();
}

function finish() {
    console.log('\n' + '='.repeat(46));
    if (failed === 0) {
        console.log(`全部通过（${passed} 项）`);
    } else {
        console.log(`通过 ${passed} 项，失败 ${failed} 项`);
    }
    process.exit(failed === 0 ? 0 : 1);
}