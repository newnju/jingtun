/**
 * 鲸吞：下载器测试
 *
 * 这里不启动浏览器，用一个可编程的 fetch 替身覆盖网络行为：
 * 重试判定、超时、取消、Range 校验、自适应并发、密钥优先级。
 * 网络那一层的细节由 test-e2e.js 在真实浏览器里补。
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

// ============================================================
// 载入被测模块
// ============================================================

const m3u8Src = fs.readFileSync(path.join(ROOT, 'js/m3u8.js'), 'utf8');

/**
 * 建一个隔离的沙箱，fetch 由调用方注入
 * @param {Function} fetchImpl
 * @returns {{sandbox: Object, JTDownloader: Object, JTM3u8: Object}}
 */
function loadDownloader(fetchImpl) {
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
        Error: Error
    };
    vm.createContext(sandbox);

    vm.runInContext(m3u8Src, sandbox);

    const src = fs.readFileSync(path.join(ROOT, 'js/downloader.js'), 'utf8');
    vm.runInContext(src, sandbox);

    return {
        sandbox: sandbox,
        JTDownloader: sandbox.JTDownloader,
        JTM3u8: sandbox.JTM3u8
    };
}

/** 造一个分片 */
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

/** 造一串分片 */
function segs(count, prefix) {
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push(seg(i, (prefix || 'https://cdn.example.com') + '/seg' + i + '.ts'));
    }
    return out;
}

/** 计数用的 fetch 替身工厂 */
function recorder(handler) {
    const calls = [];
    const fn = function (url, init) {
        calls.push({ url: String(url), init: init || {} });
        return handler(String(url), init || {}, calls.length);
    };
    fn.calls = calls;
    return fn;
}

/** 永远返回同样状态的响应 */
function always(status, body, headers) {
    return recorder(function () {
        if (status >= 400) {
            return Promise.resolve(new Response('', { status: status }));
        }
        return Promise.resolve(new Response(body || 'x', {
            status: status,
            headers: headers || {}
        }));
    });
}

/**
 * 造一个合法的 AES-128-CBC 密文响应。
 * 解密必须走真实的填充校验，随手拿几个字节当密文只会得到 OperationError。
 * @param {Uint8Array} keyBytes
 * @param {Uint8Array} plain
 * @returns {Promise<Response>}
 */
function encryptResponse(keyBytes, plain) {
    const iv = new Uint8Array(16);
    return crypto.subtle
        .importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt'])
        .then((cryptoKey) => crypto.subtle.encrypt(
            { name: 'AES-CBC', iv: iv }, cryptoKey, plain))
        .then((buffer) => new Response(buffer, { status: 200 }));
}

// ============================================================

console.log('== 基本流程 ==');

{
    const fetchImpl = recorder(() => Promise.resolve(new Response('payload')));
    const { JTDownloader } = loadDownloader(fetchImpl);

    const dl = new JTDownloader.Downloader(segs(10), { threads: 4, retries: 1 });

    const events = [];
    dl.onProgress = (p) => events.push(p);

    dl.start().then((result) => {
        checkTrue('全部成功', result.ok === true);
        check('分片数一致', result.parts.length, 10);
        check('下载字节数正确', result.bytes, 10 * 'payload'.length);
        check('失败列表为空', result.failed.length, 0);
        checkTrue('分片是 Blob（少一次内存拷贝）',
            result.parts[0] instanceof Blob);

        // 结果必须按 index 排好，否则拼出来的文件是乱序的
        const sizes = result.parts.map((b) => b.size);
        checkTrue('每一片都有内容', sizes.every((s) => s > 0));

        // ============================================================
        console.log('\n== 顺序与合并 ==');

        {
            // 故意把延迟反过来：后面的分片先返回，
            // 如果下载器按完成顺序写数组，顺序就错了
            const order = [];
            const fetchImpl2 = recorder((url) => {
                const n = parseInt(/seg(\d+)/.exec(url)[1], 10);
                order.push(n);
                const delay = (10 - n) * 5;
                return new Promise((resolve) => {
                    setTimeout(() => resolve(new Response(String(n))), delay);
                });
            });

            const mod = loadDownloader(fetchImpl2);
            const dl2 = new mod.JTDownloader.Downloader(segs(10), { threads: 10, retries: 0 });

            dl2.start().then((r2) => {
                checkTrue('乱序返回也能成功', r2.ok === true);

                const texts = [];
                Promise.all(r2.parts.map((b) => b.text())).then((values) => {
                    check('结果按分片顺序排列',
                        values.join(','), '0,1,2,3,4,5,6,7,8,9');

                    runRetryTests();
                });
            });
        }

        function runRetryTests() {
            // ============================================================
            console.log('\n== 重试判定 ==');

            // 5xx 值得重试
            {
                let attempts = 0;
                const fetchImpl3 = recorder(() => {
                    attempts++;
                    if (attempts <= 2) return Promise.resolve(new Response('', { status: 503 }));
                    return Promise.resolve(new Response('ok'));
                });

                const mod = loadDownloader(fetchImpl3);
                const dl3 = new mod.JTDownloader.Downloader([seg(0)], {
                    retries: 3,
                    retryDelay: 1
                });

                dl3.start().then((r3) => {
                    checkTrue('5xx 重试后成功', r3.ok === true);
                    check('共请求 3 次（1 次 + 2 次重试）', attempts, 3);
                    runNoRetryTests();
                });
            }

            function runNoRetryTests() {
                // 403 不该重试，重试只是白白浪费时间和请求配额
                {
                    let attempts = 0;
                    const fetchImpl4 = recorder(() => {
                        attempts++;
                        return Promise.resolve(new Response('', { status: 403 }));
                    });

                    const mod = loadDownloader(fetchImpl4);
                    const dl4 = new mod.JTDownloader.Downloader([seg(0)], {
                        retries: 3,
                        retryDelay: 1,
                        // 关掉限流感知：单个 403 就是没权限，不该重试
                        throttleAware: false
                    });

                    dl4.start().then((r4) => {
                        checkTrue('403 视为最终失败', r4.ok === false);
                        check('403 只请求一次，不重试', attempts, 1);
                        check('失败记录带上了原因',
                            r4.failed.length === 1 && !!r4.failed[0].error, true);
                        runRetryExhaustedTests();
                    });
                }
            }

            function runRetryExhaustedTests() {
                // 重试次数上限：retries=2 → 总共 3 次
                {
                    let attempts = 0;
                    const fetchImpl5 = recorder(() => {
                        attempts++;
                        return Promise.resolve(new Response('', { status: 500 }));
                    });

                    const mod = loadDownloader(fetchImpl5);
                    const dl5 = new mod.JTDownloader.Downloader([seg(0)], {
                        retries: 2,
                        retryDelay: 1
                    });

                    dl5.start().then(() => {
                        check('retries=2 共请求 3 次', attempts, 3);
                        runRetryAfterTests();
                    });
                }
            }

            function runRetryAfterTests() {
                // 服务器让等 1 秒，就应该真的等
                {
                    let attempts = 0;
                    const fetchImpl6 = recorder(() => {
                        attempts++;
                        if (attempts === 1) {
                            return Promise.resolve(new Response('', {
                                status: 429,
                                headers: { 'retry-after': '1' }
                            }));
                        }
                        return Promise.resolve(new Response('ok'));
                    });

                    const mod = loadDownloader(fetchImpl6);
                    const dl6 = new mod.JTDownloader.Downloader([seg(0)], {
                        retries: 2,
                        retryDelay: 1
                    });

                    const started = Date.now();
                    dl6.start().then((r6) => {
                        const elapsed = Date.now() - started;

                        checkTrue('429 后重试成功', r6.ok === true);
                        checkTrue('尊重 Retry-After（至少等了 900ms）', elapsed >= 900);

                        check('Retry-After 解析：秒',
                            mod.JTDownloader.Downloader.parseRetryAfter('120'), 120000);
                        check('Retry-After 解析：非法值', 
                            mod.JTDownloader.Downloader.parseRetryAfter('abc'), 0);
                        check('Retry-After 解析：HTTP 日期',
                            mod.JTDownloader.Downloader.parseRetryAfter(
                                new Date(Date.now() + 5000).toUTCString()) > 3000, true);

                        runTimeoutTests(mod.JTDownloader);
                    });
                }
            }
        }
    });
}

// ============================================================

function runTimeoutTests(JTDownloader) {
    console.log('\n== 超时 ==');

    // 一个永不返回的请求：靠信号中断
    const hanging = recorder((url, init) => new Promise((resolve, reject) => {
        const signal = init.signal;
        const onAbort = () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
    }));

    const mod = loadDownloader(hanging);
    const dl = new mod.JTDownloader.Downloader([seg(0)], {
        retries: 0,
        timeout: 120,
        retryDelay: 1
    });

    const started = Date.now();
    dl.start().then((r) => {
        const elapsed = Date.now() - started;

        checkTrue('挂死的请求会超时失败', r.ok === false);
        checkTrue('超时在预期时间内返回（<3s）', elapsed < 3000);
        checkTrue('超时错误信息说清了原因',
            /超时/.test(String(r.failed[0] && r.failed[0].error &&
                r.failed[0].error.message)));

        runAbortTests();
    });
}

function runAbortTests() {
    console.log('\n== 取消 ==');

    const fetchImpl = recorder((url) => new Promise((resolve) => {
        // 慢速返回，给 abort 留出时间
        setTimeout(() => resolve(new Response('data')), 400);
    }));

    const mod = loadDownloader(fetchImpl);
    const dl = new mod.JTDownloader.Downloader(segs(20), { threads: 4, retries: 5 });

    const p = dl.start();

    setTimeout(() => dl.abort('用户点了停止'), 80);

    p.then((r) => {
        checkTrue('中止后 aborted 为真', r.aborted === true);
        checkTrue('中止原因被带出来', r.abortReason === '用户点了停止');
        checkTrue('中止后不会继续请求所有分片',
            fetchImpl.calls.length < 20);
    }).then(runRangeTests);
}

// ============================================================

function runRangeTests() {
    console.log('\n== 字节范围 ==');

    // 正常 206
    {
        const seen = [];
        const fetchImpl = recorder((url, init) => {
            seen.push(init.headers ? init.headers.Range : undefined);
            return Promise.resolve(new Response('0123456789', {
                status: 206,
                headers: { 'content-range': 'bytes 100-109/1000' }
            }));
        });

        const mod = loadDownloader(fetchImpl);
        const dl = new mod.JTDownloader.Downloader([
            seg(0, 'https://cdn.example.com/file.ts', {
                byteRange: { offset: 100, length: 10 }
            })
        ], { retries: 0 });

        dl.start().then((r) => {
            checkTrue('带 Range 的分片下载成功', r.ok === true);
            check('Range 头正确', seen[0], 'bytes=100-109');
            checkTrue('返回的是 Blob', r.parts[0] instanceof Blob);

            runRangeIgnoredTest(mod.JTDownloader);
        });
    }

    function runRangeIgnoredTest(JTDownloader) {
        // 服务器把 Range 当普通请求，回 200 全量内容。
        // 这种情况必须失败，否则拼出来的文件是静默损坏的。
        {
            const fetchImpl2 = recorder(() =>
                Promise.resolve(new Response('x'.repeat(1000), { status: 200 })));

            const mod2 = loadDownloader(fetchImpl2);
            const dl2 = new mod2.JTDownloader.Downloader([
                seg(0, 'https://cdn.example.com/f.ts', {
                    byteRange: { offset: 0, length: 100 }
                })
            ], { retries: 0 });

            dl2.start().then((r2) => {
                checkTrue('服务器忽略 Range 时判为失败', r2.ok === false);
                checkTrue('失败原因是 Range 不符',
                    r2.failed.length === 1 &&
                    /Range/.test(String(r2.failed[0].error && r2.failed[0].error.message)));

                runRangeMismatchTest(mod2.JTDownloader);
            });
        }
    }

    function runRangeMismatchTest(JTDownloader) {
        // 206 但起点被服务器「纠正」了
        {
            const fetchImpl3 = recorder(() =>
                Promise.resolve(new Response('0123456789', {
                    status: 206,
                    headers: { 'content-range': 'bytes 200-209/1000' }
                })));

            const mod3 = loadDownloader(fetchImpl3);
            const dl3 = new mod3.JTDownloader.Downloader([
                seg(0, 'https://cdn.example.com/f.ts', {
                    byteRange: { offset: 100, length: 10 }
                })
            ], { retries: 0 });

            dl3.start().then((r3) => {
                checkTrue('起点不符时判为失败', r3.ok === false);

                runRangeVerificationToggle(mod3.JTDownloader);
            });
        }
    }

    function runRangeVerificationToggle(JTDownloader) {
        // 显式关掉校验时应当放行（给个别行为特殊的服务器留后路）
        {
            const fetchImpl4 = recorder(() =>
                Promise.resolve(new Response('0123456789', { status: 200 })));

            const mod4 = loadDownloader(fetchImpl4);
            const dl4 = new mod4.JTDownloader.Downloader([
                seg(0, 'https://cdn.example.com/f.ts', {
                    byteRange: { offset: 0, length: 10 }
                })
            ], { retries: 0, verifyRange: false });

            dl4.start().then((r4) => {
                checkTrue('关闭校验后允许 200 全量', r4.ok === true);

                runKeyTests();
            });
        }
    }
}

// ============================================================

function runKeyTests() {
    console.log('\n== 密钥优先级 ==');

    // 手填的密钥必须真的被用上。
    // 以前这里只会去请求 key.uri，手填等于没生效。
    {
        const manualKey = new Uint8Array(16);
        for (let i = 0; i < 16; i++) manualKey[i] = i;

        const keyCalls = [];
        const fetchImpl = recorder((url) => {
            if (url.indexOf('key.bin') !== -1) {
                keyCalls.push(url);
                return Promise.resolve(new Response('K'.repeat(16)));
            }
            return encryptResponse(manualKey, new Uint8Array(16).fill(9));
        });

        const mod = loadDownloader(fetchImpl);

        const dl = new mod.JTDownloader.Downloader([
            seg(0, 'https://cdn.example.com/enc.ts', {
                key: {
                    method: 'AES-128',
                    uri: 'https://cdn.example.com/key.bin',
                    iv: '',
                    key: manualKey
                }
            })
        ], { retries: 0 });

        dl.start().then((r) => {
            checkTrue('加密分片下载成功', r.ok === true);
            check('手填密钥时不再请求密钥地址', keyCalls.length, 0);
            checkTrue('分片被解密回原文长度',
                r.parts[0] && r.parts[0].size === 16);

            // 解密结果必须真的是原文，不能只是「长度对」
            return r.parts[0].arrayBuffer().then((buf) => {
                const bytes = new Uint8Array(buf);
                check('解密结果内容正确',
                    bytes[0], 9);

                runKeyCacheTest(mod.JTDownloader);
            });
        });
    }

    function runKeyCacheTest(JTDownloader) {
        // 同一个密钥地址只取一次
        {
            const keyBytes = new Uint8Array(16).fill(75);   // 'K'
            let keyRequests = 0;

            const fetchImpl2 = recorder((url) => {
                if (url.indexOf('key.bin') !== -1) {
                    keyRequests++;
                    return Promise.resolve(new Response(
                        String.fromCharCode.apply(null, keyBytes)));
                }
                return encryptResponse(keyBytes, new Uint8Array(16).fill(9));
            });

            const mod = loadDownloader(fetchImpl2);
            const list = [];
            for (let i = 0; i < 5; i++) {
                list.push(seg(i, 'https://cdn.example.com/s' + i + '.ts', {
                    key: {
                        method: 'AES-128',
                        uri: 'https://cdn.example.com/key.bin',
                        iv: '',
                        key: null
                    }
                }));
            }

            const dl2 = new mod.JTDownloader.Downloader(list, {
                threads: 5,
                retries: 0
            });

            dl2.start().then((r2) => {
                checkTrue('多片共用密钥时全部成功', r2.ok === true);
                check('密钥只请求一次（并发去重 + 缓存）', keyRequests, 1);

                runSampleAesTest(mod.JTDownloader);
            });
        }
    }

    function runSampleAesTest(JTDownloader) {
        // SAMPLE-AES 必须明确报错，而不是解出乱码
        {
            const fetchImpl3 = recorder(() =>
                Promise.resolve(new Response('M'.repeat(32))));

            const mod = loadDownloader(fetchImpl3);
            const dl = new mod.JTDownloader.Downloader([
                seg(0, 'https://cdn.example.com/s.ts', {
                    key: {
                        method: 'SAMPLE-AES',
                        uri: 'https://cdn.example.com/key.bin',
                        iv: '',
                        key: null
                    }
                })
            ], { retries: 0 });

            dl.start().then((r) => {
                checkTrue('SAMPLE-AES 判为失败', r.ok === false);
                checkTrue('错误信息点明是 SAMPLE-AES',
                    /SAMPLE-AES/.test(String(r.failed[0] && r.failed[0].error)));

                runConcurrencyTests();
            });
        }
    }
}

// ============================================================

function runConcurrencyTests() {
    console.log('\n== 并发与自适应 ==');

    // 单域名时并发受 perHostLimit 约束：
    // 浏览器对同一域名的连接数本来就有限，开再多也只是排队
    {
        const fetchImpl = recorder(() => new Promise((resolve) => {
            setTimeout(() => resolve(new Response('x')), 20);
        }));

        const mod = loadDownloader(fetchImpl);
        const dl = new mod.JTDownloader.Downloader(segs(40), {
            threads: 16,
            maxThreads: 16,
            perHostLimit: 6,
            adaptive: false,
            retries: 0
        });

        let maxObserved = 0;
        dl.onProgress = (p) => {
            if (p.concurrency > maxObserved) maxObserved = p.concurrency;
        };

        dl.start().then((r) => {
            checkTrue('下载完成', r.ok === true);
            checkTrue('并发被限制在域名上限内（<=6）',
                r.concurrency <= 6);
            checkTrue('并发不低于下限', r.concurrency >= 1);
            checkTrue('进度里带并发数', maxObserved >= 1);

            runConcurrencyAcrossHosts();
        });
    }

    function runConcurrencyAcrossHosts() {
        // 跨多个域名时上限按域名数放大
        const list = [];
        for (let i = 0; i < 12; i++) {
            list.push(seg(i, 'https://host' + (i % 3) + '.example.com/s' + i + '.ts'));
        }

        const fetchImpl2 = recorder(() => new Promise((resolve) => {
            setTimeout(() => resolve(new Response('x')), 10);
        }));

        const mod = loadDownloader(fetchImpl2);
        const dl = new mod.JTDownloader.Downloader(list, {
            threads: 16,
            maxThreads: 16,
            perHostLimit: 6,
            adaptive: false,
            retries: 0
        });

        dl.start().then((r2) => {
            checkTrue('多域名下载完成', r2.ok === true);
            checkTrue('并发可放大到域名数 × 每域名上限（<=16）',
                r2.concurrency <= 16);
            checkTrue('并发确实超过了单域名上限',
                r2.concurrency > 6);

            runProgressTests();
        });
    }
}

function runProgressTests() {
    console.log('\n== 进度与估算 ==');

    const fetchImpl = recorder(() => new Promise((resolve) => {
        setTimeout(() => resolve(new Response('y'.repeat(1024))), 15);
    }));

    const mod = loadDownloader(fetchImpl);
    const dl = new mod.JTDownloader.Downloader(segs(12), {
        threads: 4,
        retries: 0,
        adaptWindow: 3
    });

    const seen = [];
    dl.onProgress = (p) => seen.push(p);

    dl.start().then((r) => {
        checkTrue('下载完成', r.ok === true);

        const last = seen[seen.length - 1];
        checkTrue('有进度上报', seen.length > 0);
        check('最后一次进度是 100%', last.percent, 100);
        checkTrue('进度包含速度', typeof last.speed === 'number' && last.speed >= 0);
        checkTrue('进度包含剩余时间', typeof last.eta === 'number');
        checkTrue('进度包含已用时间', last.elapsed > 0);
        checkTrue('总字节数正确', r.bytes === 12 * 1024);

        runPlanTests(mod.JTDownloader);
    });
}

// ============================================================

function runPlanTests(JTDownloader) {
    console.log('\n== 分段规划（单文件多线程） ==');

    const plan = JTDownloader.Downloader.buildRangePlan(
        'https://cdn.example.com/movie.mp4', 25 * 1024 * 1024, 8 * 1024 * 1024);

    check('25MB / 8MB → 4 段', plan.length, 4);
    check('第一段偏移', plan[0].byteRange.offset, 0);
    check('第一段长度', plan[0].byteRange.length, 8 * 1024 * 1024);
    check('第二段偏移', plan[1].byteRange.offset, 8 * 1024 * 1024);
    check('最后一段长度', plan[3].byteRange.length, 25 * 1024 * 1024 - 24 * 1024 * 1024);

    // 覆盖必须完整无缝：所有段加起来正好等于文件大小
    let covered = 0;
    for (const s of plan) {
        checkTrue('第 ' + s.index + ' 段偏移连续',
            s.byteRange.offset === covered);
        covered += s.byteRange.length;
    }
    check('总覆盖字节数等于文件大小', covered, 25 * 1024 * 1024);

    // 取不到大小时退化为整文件单段
    const single = JTDownloader.Downloader.buildRangePlan(
        'https://cdn.example.com/movie.mp4', 0);
    check('未知大小时只有一段', single.length, 1);
    check('整文件段不带 Range', single[0].byteRange, null);

    runProbeTests(JTDownloader);
}

function runProbeTests(JTDownloader) {
    console.log('\n== 探测文件大小 ==');

    // 支持 HEAD
    {
        const fetchImpl = recorder((url, init) => {
            if (init.method === 'HEAD') {
                return Promise.resolve(new Response(null, {
                    status: 200,
                    headers: { 'content-length': '12345' }
                }));
            }
            return Promise.resolve(new Response(''));
        });

        const mod = loadDownloader(fetchImpl);
        mod.JTDownloader.Downloader.probeSize(
            'https://cdn.example.com/a.mp4'
        ).then((size) => {
            check('HEAD 能拿到大小', size, 12345);

            // 不支持 HEAD，用 Range 探
            const fetchImpl2 = recorder((url, init) => {
                if (init.method === 'HEAD') {
                    return Promise.resolve(new Response('', { status: 405 }));
                }
                return Promise.resolve(new Response('', {
                    status: 206,
                    headers: { 'content-range': 'bytes 0-0/67890' }
                }));
            });

            const mod2 = loadDownloader(fetchImpl2);
            return mod2.JTDownloader.Downloader.probeSize(
                'https://cdn.example.com/a.mp4'
            ).then((size2) => {
                check('HEAD 不行时用 Range 探', size2, 67890);
                runHelperTests();
            });
        });
    }
}

function runHelperTests() {
    console.log('\n== 辅助函数 ==');

    const mod = loadDownloader(always(200));
    const D = mod.JTDownloader.Downloader;

    check('503 可重试', D.isRetryableStatus(503), true);
    check('429 可重试', D.isRetryableStatus(429), true);
    check('408 可重试', D.isRetryableStatus(408), true);
    check('404 不重试', D.isRetryableStatus(404), false);
    check('403 不重试', D.isRetryableStatus(403), false);
    check('401 不重试', D.isRetryableStatus(401), false);

    const cleaned = D.cleanHeaders({
        'Referer': 'https://a.example.com/',
        'Cookie': 'a=1',
        'Range': 'bytes=0-10',
        'User-Agent': 'x',
        'Sec-Fetch-Mode': 'cors',
        'Authorization': 'Bearer t',
        'X-Custom': 'v'
    });

    checkTrue('过滤掉 Referer', !('Referer' in cleaned));
    checkTrue('过滤掉 Cookie', !('Cookie' in cleaned));
    checkTrue('过滤掉 Range（由分片自己决定）', !('Range' in cleaned));
    checkTrue('过滤掉 UA', !('User-Agent' in cleaned));
    checkTrue('过滤掉 Sec-*', !('Sec-Fetch-Mode' in cleaned));
    checkTrue('保留 Authorization', cleaned.Authorization === 'Bearer t');
    checkTrue('保留自定义头', cleaned['X-Custom'] === 'v');

    console.log('\n== 合并与释放 ==');

    const merged = mod.JTDownloader.Downloader.merge([
        new Blob(['ab']),
        new Blob(['cd'])
    ], 'video/mp2t');

    check('merge 拼接后的体积', merged.size, 4);
    check('merge 的 MIME', merged.type, 'video/mp2t');

    // dispose 之后不应该还攥着几 GB 数据
    {
        const dl = new mod.JTDownloader.Downloader(segs(3), { retries: 0 });
        dl.dispose();
        check('dispose 清空结果', dl.results.length, 0);
        check('dispose 清空密钥缓存', dl.keyCache.size, 0);
    }

    console.log('\n== 参数兜底 ==');

    // 调用方经常传 `undefined` 表示「用默认」。
    // `undefined | 0` 会变成 0，把默认值悄悄改掉 —— 这里守住这条。
    {
        const dl = new mod.JTDownloader.Downloader(segs(1), {
            timeout: undefined,
            retries: undefined,
            retryDelay: undefined,
            threads: undefined
        });

        check('undefined 超时不覆盖默认', dl.timeout, 30000);
        check('undefined 重试次数不覆盖默认', dl.retries, 3);
        check('undefined 重试延迟不覆盖默认', dl.retryDelay, 800);
        check('undefined 并发不覆盖默认', dl.threads, 4);

        const zero = new mod.JTDownloader.Downloader(segs(1), { perHostLimit: 0 });
        check('perHostLimit=0 表示不限制', zero.perHostLimit, 0);
    }

    console.log('\n== 边界 ==');

    Promise.resolve().then(() => {
        const empty = new mod.JTDownloader.Downloader([], {});
        return empty.start();
    }).then((r) => {
        checkTrue('空列表返回失败但不抛异常', r.ok === false);
        check('空列表没有分片', r.parts.length, 0);
        finish();
    });
}

// ============================================================

function finish() {
    console.log('\n' + '='.repeat(46));
    if (failed === 0) {
        console.log(`全部通过（${passed} 项）`);
    } else {
        console.log(`通过 ${passed} 项，失败 ${failed} 项`);
    }
    process.exit(failed === 0 ? 0 : 1);
}