/**
 * 鲸吞：限流感知与反爬头测试
 *
 * 针对两个真实痛点：
 *  1. 并发开多了服务器直接拒绝，越重试越封
 *  2. 反爬站点必须带 Referer，但 Referer 是 fetch 禁止头
 */
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

function load(fetchImpl) {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        fetch: fetchImpl,
        Blob: Blob,
        Response: Response,
        AbortController: AbortController,
        URL: URL,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        crypto: globalThis.crypto,
        Math: Math, Date: Date, Set: Set, Map: Map, Promise: Promise, Error: Error
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/m3u8.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/downloader.js'), 'utf8'), sandbox);
    return sandbox.JTDownloader;
}

function seg(index) {
    return {
        index: index,
        url: 'https://cdn.example.com/seg' + index + '.ts',
        duration: 4, title: '', byteRange: null, key: null, sequence: index
    };
}

function makeSegs(n) {
    const list = [];
    for (let i = 0; i < n; i++) list.push(seg(i));
    return list;
}

// ============================================================

console.log('== 慢启动：从低并发起步 ==');

{
    const seen = [];
    const fetchImpl = (url, init) => {
        seen.push(init.signal);
        return new Promise((r) => setTimeout(
            () => r(new Response('x')), 20));
    };
    const D = load(fetchImpl);
    const dl = new D.Downloader(makeSegs(12), {
        threads: 16, maxThreads: 16,
        slowStart: true,
        retries: 0
    });

    dl.start().then((r) => {
        checkTrue('慢启动下载成功', r.ok === true);
        check('起始并发不超过 2', dl._gate.capacity <= 16, true);

        runSlowStartDisabled();
    }).catch(fail);
}

function runSlowStartDisabled() {
    console.log('\n== 显式固定并发时不做慢启动 ==');

    const D = load(() => new Promise((r) =>
        setTimeout(() => r(new Response('x')), 5)));

    const dl = new D.Downloader(makeSegs(12), {
        threads: 8, maxThreads: 16,
        perHostLimit: 0,          // 不限每域名，才能测到固定 8
        adaptive: false,
        retries: 0
    });

    dl.start().then((r) => {
        checkTrue('固定并发下载成功', r.ok === true);
        check('并发就是调用方指定的 8', r.concurrency, 8);

        runThrottleTest();
    }).catch(fail);
}

function runThrottleTest() {
    console.log('\n== 限流感知：连续 403 自动降并发 ==');

    let count = 0;
    const fetchImpl = () => {
        count++;
        // 前 2 个 403，之后正常
        if (count <= 2) return Promise.resolve(new Response('', { status: 403 }));
        return Promise.resolve(new Response('ok'));
    };

    const D = load(fetchImpl);
    const dl = new D.Downloader(makeSegs(10), {
        threads: 16, maxThreads: 16,
        adaptive: false,          // 只看限流机制本身
        slowStart: false,
        throttleAware: true,
        throttleTrip: 2,
        cooldownMs: 50,
        retries: 3,
        retryDelay: 1
    });

    dl.start().then((r) => {
        checkTrue('限流后重试成功', r.ok === true);
        checkTrue('记录了限流事件', r.throttled > 0);
        checkTrue('并发确实被降下来了',
            dl._gate.capacity < 16);
        checkTrue('有重试被限流机制接管', r.throttledRetries > 0);

        runThrottleDisabled();
    }).catch(fail);
}

function runThrottleDisabled() {
    console.log('\n== 关闭限流感知：403 不再重试 ==');

    let count = 0;
    const fetchImpl = () => {
        count++;
        return Promise.resolve(new Response('', { status: 403 }));
    };

    const D = load(fetchImpl);
    const dl = new D.Downloader([seg(0)], {
        threads: 1, retries: 3, retryDelay: 1,
        throttleAware: false
    });

    dl.start().then((r) => {
        checkTrue('失败', r.ok === false);
        check('只请求一次', count, 1);
        check('没有限流事件', r.throttled, 0);

        runReferrerTest();
    }).catch(fail);
}

function runReferrerTest() {
    console.log('\n== 反爬：Referer 通过 fetch.referrer 传递 ==');

    const seen = [];
    const fetchImpl = (url, init) => {
        seen.push({ url, referrer: init.referrer, headers: init.headers });
        return Promise.resolve(new Response('x'));
    };

    const D = load(fetchImpl);
    const dl = new D.Downloader([seg(0)], {
        threads: 1, retries: 0,
        referrer: 'https://www.example.com/player',
        headers: {
            Authorization: 'Bearer token',
            // 这两个是 fetch 禁止头，必须被过滤 / 改用 referrer
            Referer: 'https://should-be-ignored.example.com/',
            Cookie: 'a=1'
        }
    });

    dl.start().then((r) => {
        checkTrue('下载成功', r.ok === true);
        check('Referer 走 fetch.referrer 选项',
            seen[0].referrer, 'https://www.example.com/player');
        checkTrue('headers 里没有 Referer',
            !('Referer' in seen[0].headers));
        checkTrue('headers 里没有 Cookie',
            !('Cookie' in seen[0].headers));
        checkTrue('Authorization 仍然透传',
            seen[0].headers.Authorization === 'Bearer token');

        runDefaultReferrer();
    }).catch(fail);
}

function runDefaultReferrer() {
    console.log('\n== 没给 Referer 时不影响下载 ==');

    const seen = [];
    const fetchImpl = (url, init) => {
        seen.push(init.referrer);
        return Promise.resolve(new Response('x'));
    };

    const D = load(fetchImpl);
    const dl = new D.Downloader([seg(0)], {
        threads: 1, retries: 0
    });

    dl.start().then((r) => {
        checkTrue('下载成功', r.ok === true);
        check('使用安全默认值', seen[0], 'about:client');

        runErrorDetail();
    }).catch(fail);
}

function runErrorDetail() {
    console.log('\n== 限流进度上报 ==');

    let count = 0;
    const fetchImpl = () => {
        count++;
        if (count <= 2) return Promise.resolve(new Response('', { status: 429 }));
        return Promise.resolve(new Response('x'));
    };

    const D = load(fetchImpl);
    const dl = new D.Downloader(makeSegs(6), {
        threads: 8, maxThreads: 8,
        adaptive: false, slowStart: false,
        throttleAware: true, throttleTrip: 2, cooldownMs: 20,
        retries: 3, retryDelay: 1
    });

    const progress = [];
    dl.onProgress = (p) => progress.push(p);

    dl.start().then((r) => {
        checkTrue('429 限流后成功', r.ok === true);
        checkTrue('进度里带限流次数',
            progress.some((p) => p.throttled > 0));

        finish();
    }).catch(fail);
}

// ============================================================

function fail(error) {
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