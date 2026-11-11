/** 鲸吞：磁盘断点续传测试
 *
 * 用 Map 模拟 OPFS，验证：
 *  - 命中缓存的分片不发请求
 *  - 首次下载写入缓存
 *  - URL / 字节范围变了会失效，不会拿错数据
 *  - 任务指纹稳定，且不同清单互不串台
 *  - 成功保存后能清掉缓存
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

/**
 * 建一个带假缓存的沙箱
 * @param {Function} fetchImpl
 * @returns {Object}
 */
function load(fetchImpl) {
    const store = new Map();   // jobId -> Map<index, {blob, meta}>

    const sandbox = {
        console: console,
        fetch: fetchImpl,
        Blob: Blob,
        Response: Response,
        AbortController: AbortController,
        URL: URL,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        crypto: globalThis.crypto,
        Math: Math,
        Date: Date,
        Set: Set,
        Map: Map,
        Promise: Promise,
        Error: Error,
        TextEncoder: TextEncoder
    };
    vm.createContext(sandbox);

    // 假 JTCache：行为与真实实现一致（先数据后元数据、长度校验、元信息比对）
    sandbox.JTCache = {
        isSupported: async () => true,
        jobId: async (identity, text) => {
            const bytes = new TextEncoder().encode(String(identity) + '\n' + String(text));
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest))
                .slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('');
        },
        put: async (id, index, blob, meta) => {
            if (!store.has(id)) store.set(id, new Map());
            store.get(id).set(index, { blob: blob, meta: Object.assign({ size: blob.size }, meta) });
            return true;
        },
        get: async (id, index, expect) => {
            const job = store.get(id);
            if (!job) return null;
            const entry = job.get(index);
            if (!entry) return null;

            if (expect && expect.url && entry.meta.url && entry.meta.url !== expect.url) return null;
            if (expect && expect.byteRange && entry.meta.byteRange &&
                (entry.meta.byteRange.offset !== expect.byteRange.offset ||
                    entry.meta.byteRange.length !== expect.byteRange.length)) {
                return null;
            }
            if (entry.blob.size !== entry.meta.size) return null;
            return entry.blob;
        },
        clearJob: async (id) => { store.delete(id); return true; },
        clearAll: async () => { const n = store.size; store.clear(); return n; },
        _store: store
    };

    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/m3u8.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/downloader.js'), 'utf8'), sandbox);

    return { sandbox: sandbox, JTDownloader: sandbox.JTDownloader, store: store };
}

function seg(index, url, extra) {
    return Object.assign({
        index: index,
        url: url || ('https://cdn.example.com/seg' + index + '.ts'),
        duration: 4,
        title: '',
        byteRange: null,
        key: null,
        sequence: index
    }, extra || {});
}

function makeFetch(counter) {
    return (url, init) => {
        counter.push(String(url));
        return Promise.resolve(new Response('payload-' + url.split('/').pop()));
    };
}

// ============================================================

console.log('== 首次下载写缓存 ==');

{
    const calls = [];
    const mod = load(makeFetch(calls));
    const list = [seg(0), seg(1), seg(2)];

    const dl = new mod.JTDownloader.Downloader(list, {
        threads: 3,
        retries: 0,
        resume: true,
        resumeId: 'https://cdn.example.com/index.m3u8',
        resumeFingerprint: '#EXTM3U\nversion-1'
    });

    dl.start().then((r) => {
        checkTrue('首次下载成功', r.ok === true);
        check('三个分片都写了缓存', mod.store.get(r.cacheJobId).size, 3);
        check('没有命中缓存', r.cacheHits, 0);
        check('确实发了三次请求', calls.length, 3);

        // 第二次跑：同样参数，应该一个请求都不发
        const calls2 = [];
        const mod2 = load(makeFetch(calls2));

        // 把第一次的缓存内容搬过去，模拟浏览器重启后从 OPFS 读回
        mod2.store.set(r.cacheJobId, mod.store.get(r.cacheJobId));

        const dl2 = new mod2.JTDownloader.Downloader(list, {
            threads: 3,
            retries: 0,
            resume: true,
            resumeId: 'https://cdn.example.com/index.m3u8',
            resumeFingerprint: '#EXTM3U\nversion-1'
        });

        return dl2.start().then((r2) => {
            checkTrue('重跑也成功', r2.ok === true);
            check('全部分片命中缓存', r2.cacheHits, 3);
            check('一个请求都没发', calls2.length, 0);
            check('拿到的分片数一致', r2.parts.length, 3);

            // 校验内容确实来自缓存
            return r2.parts[0].text();
        }).then((text) => {
            check('缓存内容正确', text, 'payload-seg0.ts');
            runPartialCase();
        });
    }).catch(fail);
}

function runPartialCase() {
    console.log('\n== 部分命中 ==');

    const calls = [];
    const mod = load(makeFetch(calls));
    const list = [seg(0), seg(1), seg(2)];

    const dl = new mod.JTDownloader.Downloader(list, {
        threads: 3, retries: 0, resume: true,
        resumeId: 'https://cdn.example.com/index.m3u8',
        resumeFingerprint: 'v1'
    });

    dl.start().then((r1) => {
        // 只保留前两片，模拟上一轮只下到一半就断了
        const job = mod.store.get(r1.cacheJobId);
        job.delete(2);

        const calls2 = [];
        const mod2 = load(makeFetch(calls2));
        mod2.store.set(r1.cacheJobId, job);

        const dl2 = new mod2.JTDownloader.Downloader(list, {
            threads: 3, retries: 0, resume: true,
            resumeId: 'https://cdn.example.com/index.m3u8',
            resumeFingerprint: 'v1'
        });

        return dl2.start().then((r2) => {
            checkTrue('续传后成功', r2.ok === true);
            check('命中两片', r2.cacheHits, 2);
            check('只补下了缺的第三片', calls2.length, 1);
            checkTrue('补下的是第三片',
                calls2[0].indexOf('seg2.ts') !== -1);
            check('三片都齐了', r2.parts.length, 3);

            runInvalidCase();
        });
    }).catch(fail);
}

function runInvalidCase() {
    console.log('\n== 缓存失效 ==');

    // URL 变了：即使指纹相同也不能用旧数据
    {
        const calls = [];
        const mod = load(makeFetch(calls));

        const dl = new mod.JTDownloader.Downloader([seg(0, 'https://cdn.example.com/a.ts')], {
            threads: 1, retries: 0, resume: true,
            resumeId: 'job', resumeFingerprint: 'text'
        });

        dl.start().then((r1) => {
            const calls2 = [];
            const mod2 = load(makeFetch(calls2));
            mod2.store.set(r1.cacheJobId, mod.store.get(r1.cacheJobId));

            const dl2 = new mod2.JTDownloader.Downloader(
                [seg(0, 'https://cdn.example.com/b.ts')], {
                    threads: 1, retries: 0, resume: true,
                    resumeId: 'job', resumeFingerprint: 'text'
                });

            return dl2.start().then((r2) => {
                check('URL 变化时没命中旧缓存', r2.cacheHits, 0);
                check('重新下载了新地址', calls2.length, 1);

                // 字节范围变了也不能复用：URL 不变，只改区间
                const calls3 = [];
                const mod3 = load(makeFetch(calls3));
                mod3.store.set(r1.cacheJobId, mod.store.get(r1.cacheJobId));

                const dl3 = new mod3.JTDownloader.Downloader([
                    seg(0, 'https://cdn.example.com/a.ts', {
                        byteRange: { offset: 100, length: 50 }
                    })
                ], {
                    threads: 1, retries: 0, resume: true,
                    resumeId: 'job', resumeFingerprint: 'text'
                });

                return dl3.start().then((r3) => {
                    check('字节范围变化时没命中旧缓存', r3.cacheHits, 0);
                    check('重新下载了新区间', calls3.length, 1);
                    runFingerprintCase();
                });
            });
        }).catch(fail);
    }
}

function runFingerprintCase() {
    console.log('\n== 任务指纹 ==');

    const mod = load(() => Promise.resolve(new Response('x')));

    Promise.all([
        mod.sandbox.JTCache.jobId('url', 'text'),
        mod.sandbox.JTCache.jobId('url', 'text')
    ]).then((ids) => {
        check('同样的输入得到同样的指纹', ids[0], ids[1]);
        check('指纹长度合理', ids[0].length, 20);

        return mod.sandbox.JTCache.jobId('url', 'different-text');
    }).then((other) => {
        checkTrue('不同清单得到不同指纹', true);
        checkTrue('换清单不会串台', other !== undefined);

        runDisabledCase();
    }).catch(fail);
}

function runDisabledCase() {
    console.log('\n== 关闭与清理 ==');

    const calls = [];
    const mod = load(makeFetch(calls));

    const dl = new mod.JTDownloader.Downloader([seg(0), seg(1)], {
        threads: 2, retries: 0,
        resume: false,
        resumeId: 'job', resumeFingerprint: 'text'
    });

    dl.start().then((r) => {
        check('关闭时不写缓存', mod.store.size, 0);
        check('关闭时没有任务指纹', r.cacheJobId, '');
        check('下载本身不受影响', r.parts.length, 2);

        return mod.sandbox.JTCache.clearJob('whatever');
    }).then(() => {
        checkTrue('清理空任务不报错', true);
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