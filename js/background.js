/** 鲸吞：后台嗅探中枢（MV3 Service Worker） */

importScripts(
    '/js/lib/polyfill.js',
    '/js/lib/utils.js',
    '/js/lib/template.js',
    '/js/lib/matcher.js',
    '/js/lib/store.js',
    '/js/lib/config.js'
);

// MQTT 库单独加载，它可能依赖 window，在 Service Worker 里会挂。
// 用 try 包住：加载失败只是没这个功能，不该影响嗅探和下载。
try {
    importScripts('/lib/mqtt.min.js');
} catch (e) {
    console.warn('[鲸吞] MQTT 库加载失败（不影响其他功能）:', e.message || e);
}

// ============================================================
// 全局状态
// ============================================================

/** requestId -> 请求头数组（用于下载时携带 Referer/Cookie） */
const requestHeaders = new Map();
/** 已否决的 requestId（正则黑名单命中） */
const blockedRequests = new Set();
/** tabId -> { title, favIconUrl, url, ts } */
const tabInfoCache = new Map();
/** 当前活动的 tabId（部分场景 data.tabId 为 -1 时回退） */
let activeTabId = -1;
/** 已完成初始化的标志 */
let bootstrapped = false;
/** 初始化等待队列（未就绪时的请求暂存） */
const pendingQueue = [];
/** 已注入捕获脚本的 tabId。 */
const captureReady = new Set();
/** 正在录制的 tabId（决定「捕获」按钮的开关态） */
const captureActive = new Set();

const TAB_CACHE_TTL = 5000;

// ============================================================
// 按需保活
// ============================================================

/** 保活控制器。 */
const keepAlive = (function () {
    let timer = null;
    let active = false;

    function tick() {
        // 调用一个轻量 API 即可重置空闲计时器
        chrome.runtime.getPlatformInfo(() => {
            if (chrome.runtime.lastError) { /* 忽略 */ }
        });
    }

    return {
        start() {
            if (active) return;
            active = true;
            tick();
            // 间隔略小于 30 秒，确保在空闲计时器触发前续命
            timer = setInterval(tick, 25000);
        },
        stop() {
            if (!active) return;
            active = false;
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        },
        isActive() {
            return active;
        }
    };
})();

// ============================================================
// 工具函数
// ============================================================

/**
 * 判断是否为浏览器内部页面（不应处理）
 * @param {string} url
 * @returns {boolean}
 */
function isSpecialPage(url) {
    if (!url) return true;
    return url.startsWith('chrome://') ||
        url.startsWith('chrome-extension://') ||
        url.startsWith('edge://') ||
        url.startsWith('about:') ||
        url.startsWith('devtools://') ||
        url.startsWith('moz-extension://') ||
        url.startsWith('data:') ||
        url.startsWith('blob:');
}

/**
 * 获取标签页元信息（带缓存）
 * @param {number} tabId
 * @returns {Promise<{title: string, favIconUrl: string, url: string}>}
 */
async function getTabInfo(tabId) {
    const cached = tabInfoCache.get(tabId);
    if (cached && Date.now() - cached.ts < TAB_CACHE_TTL) {
        return cached;
    }

    try {
        const tab = await chrome.tabs.get(tabId);
        const info = {
            title: tab.title || '',
            favIconUrl: tab.favIconUrl || '',
            url: tab.url || '',
            ts: Date.now()
        };
        tabInfoCache.set(tabId, info);
        return info;
    } catch (e) {
        // 标签页可能已关闭
        return { title: '', favIconUrl: '', url: '', ts: Date.now() };
    }
}

/** 使某个标签页的缓存失效 */
function invalidateTabCache(tabId) {
    tabInfoCache.delete(tabId);
}

/**
 * 从请求头中筛选出下载所需的关键头
 * @param {Array<{name: string, value: string}>} headers
 * @returns {Object|undefined}
 */
const DIRECT_HEADERS = new Set([
    'referer', 'origin', 'cookie', 'authorization',
    'user-agent', 'range',
    // sec-fetch-* 系列。现代浏览器每个请求都会带，有些站点
    'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user',
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    // 非 x- 前缀的鉴权头。各站点的命名五花八门，漏掉一个就是 403，
    // 而这些名字本身很罕见，多收几个没有副作用。
    'auth', 'key', 'token', 'access-token', 'api-key',
    'app-token', 'authtoken', 'session-id'
]);
const AUTH_HEADER_PATTERN = /(auth|token|sign|key|ticket|session)/;

function pickRequestHeaders(headers) {
    if (!Array.isArray(headers) || headers.length === 0) return undefined;

    const picked = {};
    let hasAny = false;

    for (const item of headers) {
        if (!item || !item.name || item.value === undefined) continue;
        const name = item.name.toLowerCase();

        // 白名单直收，其余按名字里的关键词收。
        // 不再要求 x- 前缀，api-key / access-token 这类命名同样常见。
        if (DIRECT_HEADERS.has(name) || AUTH_HEADER_PATTERN.test(name)) {
            picked[name] = item.value;
            hasAny = true;
        }
    }

    return hasAny ? picked : undefined;
}

/**
 * 用用户配置的正则从 URL 里还原真实地址
 * @param {string} url
 * @returns {string} 还原后的地址；没命中则返回原地址
 */
function applyUrlRewrite(url) {
    const rules = JTConfig.get('urlRewriteRules');
    if (!Array.isArray(rules) || rules.length === 0) return url;

    for (const rule of rules) {
        if (!rule) continue;

        let re;
        try {
            re = new RegExp(rule, 'i');
        } catch (e) {
            continue;   // 用户写错了正则，跳过这一条
        }

        const m = re.exec(url);
        if (!m || !m[1]) continue;

        // 捕获组里的内容往往是编码过的
        let candidate = m[1];
        try {
            candidate = decodeURIComponent(candidate);
        } catch (e) { /* 不是编码内容，原样使用 */ }

        if (/^https?:\/\//i.test(candidate)) return candidate;
    }

    return url;
}

/**
 * 构造判定器的用户配置
 * @returns {Object}
 */
function buildMatcherConfig() {
    const config = {
        allowExt: null,
        denyExt: null,
        allowMime: null,
        denyMime: null,
        extRules: null,
        mimeRules: null
    };

    // --- 后缀表 ---
    const extRows = parseTableRows(JTConfig.get('extTable'));
    if (extRows.length > 0) {
        config.allowExt = new Set();
        config.extRules = new Map();

        for (const row of extRows) {
            const ext = row[0].toLowerCase().replace(/^\./, '');
            if (!ext) continue;

            config.allowExt.add(ext);

            // 第二个字段是操作符时才算大小条件
            if (row[1] && row[2]) {
                config.extRules.set(ext, {
                    operator: row[1],
                    size: parseFloat(row[2]) || 0,
                    unit: row[3] || 'KB'
                });
            }
        }
    }

    // --- MIME 表 ---
    const mimeRows = parseTableRows(JTConfig.get('mimeTable'));
    if (mimeRows.length > 0) {
        config.allowMime = new Set();
        config.mimeRules = new Map();

        for (const row of mimeRows) {
            const mime = row[0].toLowerCase();
            if (!mime) continue;

            config.allowMime.add(mime);

            if (row[1] && row[2]) {
                config.mimeRules.set(mime, {
                    operator: row[1],
                    size: parseFloat(row[2]) || 0,
                    unit: row[3] || 'KB'
                });
            }
        }
    }

    return config;
}

/**
 * 把设置页里的多行文本解析成字段数组
 * @param {Array<string>|string} source
 * @returns {Array<Array<string>>}
 */
function parseTableRows(source) {
    if (!source) return [];

    const lines = Array.isArray(source) ? source : String(source).split('\n');
    const rows = [];

    for (const line of lines) {
        const trimmed = String(line).trim();
        if (!trimmed || trimmed.charAt(0) === '#') continue;

        const fields = trimmed.split(/[,，\t]/).map((f) => f.trim());
        if (fields.length > 0 && fields[0]) rows.push(fields);
    }

    return rows;
}

/**
 * 用用户配置的正则表判定 URL
 * @param {string} url
 * @returns {string|null} 命中的扩展名；未命中返回 null
 */
function judgeByUserRegex(url) {
    const rows = parseTableRows(JTConfig.get('regexTable'));
    if (rows.length === 0 || !url) return null;

    for (const row of rows) {
        const pattern = row[0];
        if (!pattern) continue;

        // 第三个字段写 black 表示这是黑名单：命中就明确排除
        const isBlackList = String(row[2] || '').toLowerCase().indexOf('black') !== -1;

        let matched = false;
        try {
            matched = new RegExp(pattern, 'i').test(url);
        } catch (e) {
            // 用户写错了正则，跳过这一条而不是整体失败
            continue;
        }

        if (!matched) continue;
        if (isBlackList) return null;

        return String(row[1] || '').toLowerCase().replace(/^\./, '') || 'mp4';
    }

    return null;
}

// ============================================================
// 网络监听
// ============================================================

/**
 * 注册 webRequest 监听器，并争取拿到敏感请求头
 * @param {Object} event webRequest 事件对象
 * @param {Function} handler 回调
 * @param {Array<string>} baseSpec 不含 extraHeaders 的 spec
 */
function addListenerSafe(event, handler, baseSpec) {
    const filter = { urls: ['<all_urls>'] };

    try {
        event.addListener(handler, filter, baseSpec.concat(['extraHeaders']));
    } catch (e) {
        console.warn(
            '[鲸吞] 当前浏览器不支持 extraHeaders，Cookie / Referer 可能拿不全:',
            e.message
        );
        event.addListener(handler, filter, baseSpec);
    }
}

addListenerSafe(chrome.webRequest.onSendHeaders, function (data) {
    // 记录请求头，供后续解析、播放、下载时还原
    if (data.requestHeaders && data.requestHeaders.length) {
        requestHeaders.set(data.requestId, data.requestHeaders);
    }
}, ['requestHeaders']);

addListenerSafe(chrome.webRequest.onResponseStarted, function (data) {
    handleResponse(data);
}, ['responseHeaders']);

chrome.webRequest.onErrorOccurred.addListener(
    function (data) {
        // 清理，避免 Map 长期增长
        requestHeaders.delete(data.requestId);
        blockedRequests.delete(data.requestId);
    },
    { urls: ['<all_urls>'] }
);

/**
 * 处理一个已开始的响应
 * @param {Object} data webRequest 回调数据
 */
function handleResponse(data) {
    if (!bootstrapped) {
        // 初始化未完成：暂存后重试（限制队列长度避免内存增长）
        if (pendingQueue.length < 200) pendingQueue.push(data);
        return;
    }

    if (!JTConfig.get('enable')) return;
    if (data.method === 'OPTIONS') return;
    if (isSpecialPage(data.url)) return;
    if (JTConfig.isBlocked(data.url)) return;

    // 第一步：提取响应头关键字段（廉价，纯数组遍历）
    const headerInfo = JTMatcher.extractHeaders(data.responseHeaders);

    // 第二步：快速提取扩展名（纯字符串操作，不构造 URL）
    const ext = JTUtils.quickExt(data.url);

    // 第三步：三态判定
    const captureMime = JTConfig.get('captureMimeTypes');
    let verdict = JTMatcher.judge({
        url: data.url,
        ext: ext,
        mime: captureMime ? headerInfo.type : '',
        size: headerInfo.size,
        disposition: headerInfo.disposition
    }, buildMatcherConfig());

    // 第四步：URL 改写
    if (verdict.result !== JTMatcher.HIT) {
        const rewritten = applyUrlRewrite(data.url);

        if (rewritten !== data.url) {
            const rewrittenExt = JTUtils.quickExt(rewritten);
            const rewrittenVerdict = JTMatcher.judge({
                url: rewritten,
                ext: rewrittenExt,
                mime: captureMime ? headerInfo.type : '',
                size: headerInfo.size,
                disposition: headerInfo.disposition
            }, buildMatcherConfig());

            if (rewrittenVerdict.result === JTMatcher.HIT) {
                data = Object.assign({}, data, { url: rewritten });
                verdict = rewrittenVerdict;
            }
        }
    }

    // 第五步：用户正则表
    if (verdict.result !== JTMatcher.HIT) {
        const regexExt = judgeByUserRegex(data.url);
        if (regexExt) {
            verdict = {
                result: JTMatcher.HIT,
                ext: regexExt,
                mime: headerInfo.type || '',
                size: headerInfo.size,
                fileName: ''
            };
        }
    }

    // 第六步：浏览器自己的归类回退
    if (verdict.result !== JTMatcher.HIT && data.type === 'media') {
        verdict = { result: JTMatcher.HIT, ext: ext, mime: headerInfo.type || '', size: headerInfo.size, fileName: '' };
    }

    if (verdict.result !== JTMatcher.HIT) return;

    // 第七步：体积下限
    const minSizeKb = Number(JTConfig.get('minMediaSize')) || 0;
    if (minSizeKb > 0 && headerInfo.size > 0 && headerInfo.size < minSizeKb * 1024) return;

    collectMedia(data, verdict, headerInfo);
}

/**
 * 收集一条命中资源
 * @param {Object} data
 * @param {Object} verdict 判定结果
 * @param {Object} headerInfo 响应头信息
 */
async function collectMedia(data, verdict, headerInfo) {
    // tabId 在部分场景下为 -1，用当前活动标签回退
    let tabId = data.tabId;
    if (tabId === undefined || tabId === null || tabId < 0) {
        tabId = activeTabId;
    }
    if (tabId === undefined || tabId < 0) return;

    const tabInfo = await getTabInfo(tabId);

    // 补全扩展名：URL 无扩展名时从 MIME 推断
    let ext = verdict.ext;
    if (!ext && headerInfo.type) {
        ext = JTMatcher.mimeToExt(headerInfo.type);
    }

    // 生成显示用文件名
    let fileName = verdict.fileName;
    if (!fileName) {
        const parsed = JTUtils.parseFileName(safePathname(data.url));
        fileName = parsed[0] || '';
    }

    const requestHeadersPicked = pickRequestHeaders(requestHeaders.get(data.requestId));
    requestHeaders.delete(data.requestId);

    const item = {
        requestId: data.requestId || JTUtils.uid('req'),
        url: data.url,
        name: fileName,
        ext: ext || '',
        mime: headerInfo.type || '',
        size: headerInfo.size,
        type: data.type || '',          // 浏览器归类：media / xhr / other
        initiator: data.initiator || '',
        requestHeaders: requestHeadersPicked,
        tabId: tabId,
        pageUrl: tabInfo.url,
        pageTitle: tabInfo.title,
        favIconUrl: tabInfo.favIconUrl,
        time: Date.now()
    };

    commitMedia(tabId, item);
    updateBadge(tabId);
    notifyPopup(item);
}

/**
 * 资源入库，并处理后续动作
 * @param {number} tabId
 * @param {Object} item
 * @returns {{item: Object, isNew: boolean}}
 */
function commitMedia(tabId, item) {
    const added = JTStore.add(tabId, item);

    // 条目无效（缺 url 之类）时到此为止，
    // 往下推送一条没有地址的资源，弹窗那边只会显示个空行。
    if (!added.item) return added;

    updateBadge(tabId);
    notifyPopup(item);

    // 自动下载只对新增资源触发，同一条被反复嗅探时不该重复下载
    if (added.isNew && JTConfig.get('autoDownload')) {
        autoDownloadItem(item);
    }

    // 推送到本地服务。同样只对新增的推，
    if (added.isNew) {
        sendToLocal(item);
        sendToMqtt(item);
    }

    return added;
}

/**
 * 自动下载一条刚嗅探到的资源
 * @param {Object} item
 */
function autoDownloadItem(item) {
    const ext = String(item.ext || '').toLowerCase();
    if (ext === 'm3u8' || ext === 'm3u' || ext === 'mpd') return;

    handleDownload({ item: item }).catch(function () {
        // 单条失败不影响其余资源
    });
}

/**
 * 安全地从 URL 中取出 origin
 * @param {string} url
 * @returns {string}
 */
function safeOrigin(url) {
    try {
        return new URL(url).origin;
    } catch (e) {
        return '';
    }
}

/**
 * 安全地从 URL 中取出 pathname
 * @param {string} url
 * @returns {string}
 */
function safePathname(url) {
    const q = url.indexOf('?');
    const withoutQuery = q === -1 ? url : url.slice(0, q);
    const hash = withoutQuery.indexOf('#');
    const clean = hash === -1 ? withoutQuery : withoutQuery.slice(0, hash);
    const slash = clean.lastIndexOf('/');
    return slash === -1 ? clean : clean.slice(slash);
}

/**
 * 通知弹窗有新数据
 * @param {Object} item
 */
function notifyPopup(item) {
    chrome.runtime.sendMessage({
        type: 'media:add',
        payload: item
    }, () => {
        // 弹窗未打开时会报错，属正常情况
        if (chrome.runtime.lastError) { /* 忽略 */ }
    });
}

/**
 * 更新扩展图标徽章
 * @param {number} tabId
 */
function updateBadge(tabId) {
    if (!JTConfig.get('badgeNumber')) return;

    const count = JTStore.count(tabId);
    const text = count === 0 ? '' : (count > 999 ? '999+' : String(count));

    chrome.action.setBadgeText({ text, tabId }, () => {
        if (chrome.runtime.lastError) { /* 标签页可能已关闭 */ }
    });
    chrome.action.setBadgeBackgroundColor({ color: '#1B6CA8', tabId }, () => {
        if (chrome.runtime.lastError) { /* 忽略 */ }
    });
}

/**
 * 配置变更后的副作用处理
 * @param {Object} before 变更前配置
 * @param {Object} after  变更后配置
 */
function applyConfigSideEffects(before, after) {
    // 存储上限由 JTConfig.onChange 统一同步，此处不重复处理

    // --- 去重开关 ---
    if (before.checkDuplicates !== after.checkDuplicates) {
        JTStore.setDedupe(after.checkDuplicates);
    }

    // --- 角标 ---
    if (before.badgeNumber !== after.badgeNumber) {
        const tabs = Array.from(tabInfoCache.keys());
        if (after.badgeNumber) {
            for (const tabId of tabs) updateBadge(tabId);
        } else {
            // 关闭后需要主动擦掉已有角标，否则会一直挂在图标上
            for (const tabId of tabs) {
                chrome.action.setBadgeText({ text: '', tabId }, () => {
                    if (chrome.runtime.lastError) { /* 标签页可能已关闭 */ }
                });
            }
        }
    }

    // --- 常开深度搜索：开启时立刻给已打开的页面补注入 ---
    if (!before.deepSearchAlwaysOn && after.deepSearchAlwaysOn) {
        chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, function (tabs) {
            if (chrome.runtime.lastError) return;
            for (const tab of tabs) {
                if (tab.id !== undefined) injectAfterLoad(tab.id, 'deep-search');
            }
        });
    }

    // --- 右键菜单：开关一变就重建 ---
    // 不重建的话用户得自己去"重新加载扩展"，很容易以为开关没生效
    if (before.contextMenusEnable !== after.contextMenusEnable) {
        initContextMenus();
    }

    // --- 移动端 UA ---
    if (before.mobileUserAgent !== after.mobileUserAgent) {
        applyMobileUserAgent(after.mobileUserAgent === true);
    }

    // --- 总开关关闭：清掉所有角标，避免残留数字误导 ---
    if (before.enable !== false && after.enable === false) {
        for (const tabId of Array.from(tabInfoCache.keys())) {
            chrome.action.setBadgeText({ text: '', tabId }, () => {
                if (chrome.runtime.lastError) { /* 忽略 */ }
            });
        }
    }
}

// ============================================================
// 标签页生命周期
// ============================================================

chrome.tabs.onRemoved.addListener(function (tabId) {
    invalidateTabCache(tabId);
    JTStore.remove(tabId);
    captureReady.delete(tabId);
    captureActive.delete(tabId);
    capturedKeys.delete(tabId);
});

chrome.tabs.onActivated.addListener(function (info) {
    activeTabId = info.tabId;
});

chrome.webNavigation.onCommitted.addListener(function (details) {
    // 页面导航后标签元信息（标题等）会变化，使缓存失效
    if (details.frameId === 0) {
        invalidateTabCache(details.tabId);
        // 注入的捕获脚本随页面卸载而消失，登记也要跟着清掉，
        // 否则「导出」按钮会指向一个不存在的脚本
        captureReady.delete(details.tabId);
        captureActive.delete(details.tabId);
        // 换了页面，上一页捞到的密钥不再适用
        capturedKeys.delete(details.tabId);

        // 清掉上一页的媒体列表。
        if (JTConfig.get('autoClearOnNavigate') !== false) {
            const SKIP = ['auto_subframe', 'manual_subframe', 'form_submit'];

            if (SKIP.indexOf(details.transitionType) === -1) {
                JTStore.remove(details.tabId);
                updateBadge(details.tabId);
            }
        }
    }
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
    if (changeInfo.status === 'loading' && changeInfo.url) {
        invalidateTabCache(tabId);
    }
});

// ============================================================
// 脚本注入调度
// ============================================================

/** 可注入的捕获脚本清单 */
const INJECT_SCRIPTS = {
    'deep-search': {
        files: ['js/inject/i18n.js', 'js/inject/deep-search.js'],
        key: 'deepSearch',
        label: '深度搜索',
        world: 'MAIN',
        reload: true       // 需要从头开始才能 hook 到全部请求
    },
    'mse-capture': {
        files: ['js/inject/i18n.js', 'js/inject/mse-capture.js'],
        key: 'mseCapture',
        label: '流媒体捕获',
        world: 'MAIN',
        reload: false
    },
    'recorder': {
        files: ['js/inject/i18n.js', 'js/inject/recorder.js'],
        key: 'recorder',
        label: '录制',
        world: 'MAIN',
        reload: false
    },
    'media-control': {
        files: ['js/inject/i18n.js', 'js/inject/media-control.js'],
        key: 'mediaControl',
        label: '媒体控制',
        world: 'MAIN',
        reload: false
    },
    'webrtc': {
        files: ['js/inject/i18n.js', 'js/inject/webrtc.js'],
        key: 'webrtc',
        label: 'WebRTC 捕获',
        world: 'MAIN',
        // 必须在页面建立连接之前就 hook 上 RTCPeerConnection，
        // 否则早期的轨道收集不到
        reload: true
    },
    'region': {
        files: ['js/inject/i18n.js', 'js/inject/region.js'],
        key: 'region',
        label: '区域录制',
        world: 'MAIN',
        reload: false
    }
};

/**
 * 向指定标签页注入捕获脚本
 * @param {number} tabId
 * @param {string} name INJECT_SCRIPTS 的键
 * @param {boolean} [forceReload] 强制刷新页面
 * @param {number} [frameId] 只注入指定框架；不传则注入所有框架
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function injectScript(tabId, name, forceReload, frameId) {
    const script = INJECT_SCRIPTS[name];
    if (!script) return { ok: false, error: '未知脚本: ' + name };

    try {
        const tab = await chrome.tabs.get(tabId);
        if (isSpecialPage(tab.url)) {
            return { ok: false, error: '当前页面不支持注入' };
        }

        if (forceReload || script.reload) {
            // 深度搜索必须从页面加载起点开始 hook，
            // 否则早期的请求已经发出，无法捕获。
            keepAlive.start();
            await chrome.tabs.reload(tabId, { bypassCache: false });
            return { ok: true, reloaded: true };
        }

        const target = typeof frameId === 'number'
            ? { tabId: tabId, frameIds: [frameId] }
            : { tabId: tabId, allFrames: true };

        await chrome.scripting.executeScript({
            target: target,
            files: script.files || [script.file],
            injectImmediately: true,
            world: script.world
        });

        // 用户自定义的 CSS：隐藏遮挡元素、适配移动端布局等。
        const customCSS = JTConfig.get('customCSS');

        if (customCSS && chrome.scripting && chrome.scripting.insertCSS) {
            try {
                await chrome.scripting.insertCSS({
                    target: target,
                    css: customCSS
                });
            } catch (e) {
                console.warn('[鲸吞] 自定义 CSS 注入失败:', e.message || e);
            }
        }

        keepAlive.start();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
}

/**
 * 把配置里的捕获内存上限同步给页面里的捕获脚本
 * @param {number} tabId
 */
function applyCaptureLimit(tabId) {
    const mb = Number(JTConfig.get('captureMemoryLimit'));
    if (!mb || mb <= 0) return;

    chrome.tabs.sendMessage(tabId, {
        type: 'capture:setLimit',
        payload: { mb: mb }
    }, () => {
        if (chrome.runtime.lastError) { /* 脚本可能刚被卸载，忽略 */ }
    });
}

/**
 * 把「捕获后自动合并音视频」的配置同步给页面侧脚本
 * @param {number} tabId
 */
function applyCaptureAutoMerge(tabId) {
    if (tabId === undefined || tabId < 0) return;

    chrome.tabs.sendMessage(tabId, {
        type: 'capture:autoMerge',
        payload: { enabled: JTConfig.get('autoMergeCapture') === true }
    }, () => {
        if (chrome.runtime.lastError) { /* 脚本可能刚被卸载，忽略 */ }
    });
}

/**
 * 打开区域录制的选择框
 * @param {number} tabId
 */
function openRegionPicker(tabId) {
    if (tabId === undefined || tabId < 0) return;

    chrome.tabs.sendMessage(tabId, { type: 'region:open' }, () => {
        if (chrome.runtime.lastError) {
            // 脚本可能还没跑起来，忽略
        }
    });
}

/**
 * 启动 WebRTC 捕获
 * @param {number} tabId
 */
function startWebrtcCapture(tabId) {
    if (tabId === undefined || tabId < 0) return;

    chrome.tabs.sendMessage(tabId, { type: 'webrtc:start' }, () => {
        if (chrome.runtime.lastError) {
            // 脚本可能还没跑起来（页面刚刷新），忽略即可
        }
    });
}

/**
 * 同步「移除 iframe sandbox」开关给页面侧脚本
 * @param {number} tabId
 */
function applyAutoDownOnComplete(tabId) {
    if (tabId === undefined || tabId < 0) return;

    const enabled = JTConfig.get('autoDownOnComplete') === true;
    if (!enabled) return;

    chrome.tabs.sendMessage(tabId, {
        type: 'capture:autoDownOnComplete',
        payload: { enabled: true }
    }, () => {
        if (chrome.runtime.lastError) { /* 脚本可能刚被卸载 */ }
    });
}

function applyAutoToBuffered(tabId) {
    if (tabId === undefined || tabId < 0) return;

    const enabled = JTConfig.get('autoToBuffered') === true;
    if (!enabled) return;   // 关着不用发消息

    chrome.tabs.sendMessage(tabId, {
        type: 'capture:autoToBuffered',
        payload: { enabled: true }
    }, () => {
        if (chrome.runtime.lastError) { /* 脚本可能刚被卸载 */ }
    });
}

/** 同步「移除 iframe sandbox」开关给页面侧脚本 */
function applyCaptureSandbox(tabId) {
    if (tabId === undefined || tabId < 0) return;

    const enabled = JTConfig.get('removeIframeSandbox') === true;
    if (!enabled) return;   // 关着就不用发消息了

    chrome.tabs.sendMessage(tabId, {
        type: 'capture:sandbox',
        payload: { enabled: true }
    }, () => {
        if (chrome.runtime.lastError) { /* 脚本可能刚被卸载 */ }
    });
}

/**
 * 在页面刷新完成后补注入脚本
 * @param {number} tabId
 * @param {string} name
 */
async function injectAfterLoad(tabId, name) {
    const script = INJECT_SCRIPTS[name];
    if (!script) return;

    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId, allFrames: true },
            files: [script.file],
            injectImmediately: true,
            world: script.world
        });
    } catch (e) {
        console.warn('[鲸吞] 注入失败:', name, e.message);
    }
}

/** 待注入队列：刷新后需要补注入的脚本 */
const pendingInject = new Map();   // tabId -> Set<scriptName>

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
    if (changeInfo.status !== 'complete') return;
    const waiting = pendingInject.get(tabId);
    if (!waiting || waiting.size === 0) return;

    for (const name of waiting) {
        injectAfterLoad(tabId, name);
    }
    pendingInject.delete(tabId);
});

// ============================================================
// 工具页取文本（M3U8 解析 / 预览播放共用）
// ============================================================

/** 取文本的大小上限：清单文件通常几十 KB，8MB 已是极端冗余 */
const TOOL_FETCH_MAX = 8 * 1024 * 1024;

/**
 * 从 URL 取文本，供 M3U8 解析器和预览播放器使用
 * @param {string} url
 * @param {number} [maxBytes]
 * @returns {Promise<{ok:boolean, text?:string, via?:string, status?:number, error?:string}>}
 */
async function fetchTextForTool(url, maxBytes) {
    if (!url) return { ok: false, error: '缺少 URL' };

    const limit = Math.min(maxBytes || TOOL_FETCH_MAX, TOOL_FETCH_MAX);
    const item = JTStore.findByUrl(url);
    const headers = pickFetchableHeaders(item && item.requestHeaders);

    // --- 通道 1：扩展源 ---
    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: headers,
            credentials: 'include',
            cache: 'no-store'
        });

        if (res.ok) {
            const text = await readTextLimited(res, limit);
            if (text !== null) return { ok: true, text: text, via: 'extension' };
        } else if (res.status !== 403 && res.status !== 401) {
            // 404 / 500 之类换通道也救不回来，直接报错省一次往返
            return { ok: false, status: res.status, error: 'HTTP ' + res.status };
        } else {
            console.warn('[鲸吞] 扩展源请求被拒（' + res.status + '），改用页面上下文重试');
        }
    } catch (e) {
        console.warn('[鲸吞] 扩展源请求异常，改用页面上下文重试:', e.message);
    }

    // --- 通道 2：原页面主世界 ---
    const tabId = item && typeof item.tabId === 'number' ? item.tabId : activeTabId;
    if (typeof tabId === 'number' && tabId >= 0) {
        const viaPage = await fetchInPageContext(tabId, url, limit);
        if (viaPage.ok) return viaPage;
        return { ok: false, error: viaPage.error || '两种方式均未能取到内容' };
    }

    return { ok: false, error: '请求失败，且原页面已关闭，无法在页面上下文中重试' };
}

/**
 * 过滤出 fetch 允许设置的请求头
 * @param {Object} [headers]
 * @returns {Object}
 */
function pickFetchableHeaders(headers) {
    const FORBIDDEN = [
        'referer', 'origin', 'cookie', 'user-agent', 'host',
        'connection', 'content-length', 'accept-encoding', 'expect'
    ];
    const out = {};
    if (!headers || typeof headers !== 'object') return out;

    for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (FORBIDDEN.indexOf(lower) !== -1) continue;
        if (lower.indexOf('sec-') === 0 || lower.indexOf('proxy-') === 0) continue;
        out[key] = headers[key];
    }
    return out;
}

/**
 * 按字节上限读取响应文本，超限返回 null
 * @param {Response} res
 * @param {number} limit
 * @returns {Promise<string|null>}
 */
async function readTextLimited(res, limit) {
    const length = parseInt(res.headers.get('content-length') || '0', 10);
    if (length && length > limit) {
        console.warn('[鲸吞] 响应过大，放弃读取:', length);
        return null;
    }
    const text = await res.text();
    return text.length > limit ? null : text;
}

/**
 * 在原页面的主世界里发起 fetch
 * @param {number} tabId
 * @param {string} url
 * @param {number} limit
 * @returns {Promise<{ok:boolean, text?:string, via?:string, error?:string}>}
 */
async function fetchInPageContext(tabId, url, limit) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: 'MAIN',
            injectImmediately: true,
            args: [url, limit],
            func: async (targetUrl, maxLen) => {
                try {
                    const res = await fetch(targetUrl, { credentials: 'include' });
                    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
                    const text = await res.text();
                    if (text.length > maxLen) return { ok: false, error: '响应内容过大' };
                    return { ok: true, text: text };
                } catch (e) {
                    return { ok: false, error: e.message || String(e) };
                }
            }
        });

        const first = results && results[0];
        if (first && first.result && first.result.ok) {
            return { ok: true, text: first.result.text, via: 'page' };
        }
        return { ok: false, error: (first && first.result && first.result.error) || '页面上下文请求失败' };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
}

// ============================================================
// 流媒体下载（交给 offscreen document 执行）
// ============================================================

/** 下载放到 offscreen 的原因： */
let offscreenCreated = false;
let creatingOffscreen = null;
let offscreenCloseTimer = null;

/** 当前是否真的存在 offscreen document */
async function hasOffscreen() {
    try {
        if (chrome.runtime.getContexts) {
            const contexts = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT']
            });
            return contexts.length > 0;
        }
    } catch (e) {
        // 查询失败就按标志位判断
    }
    return offscreenCreated;
}

/**
 * 确保 offscreen document 就绪
 * @returns {Promise<boolean>}
 */
async function ensureOffscreen() {
    if (creatingOffscreen) {
        await creatingOffscreen;
        return true;
    }

    if (await hasOffscreen()) {
        offscreenCreated = true;
        return true;
    }

    creatingOffscreen = (async function () {
        try {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['BLOBS'],
                justification: '合并 HLS 分片并保存为文件，需要 DOM 环境与 Blob 支持'
            });
            offscreenCreated = true;
        } catch (e) {
            // 已存在时 createDocument 会抛错，这种情况视为成功
            const msg = String((e && e.message) || e);
            if (msg.indexOf('single offscreen') !== -1) {
                offscreenCreated = true;
            } else {
                throw e;
            }
        } finally {
            creatingOffscreen = null;
        }
    })();

    await creatingOffscreen;
    return true;
}

/** 安排在一段空闲后关闭 offscreen document */
function scheduleOffscreenClose() {
    if (offscreenCloseTimer) clearTimeout(offscreenCloseTimer);

    offscreenCloseTimer = setTimeout(async function () {
        offscreenCloseTimer = null;
        try {
            if (await hasOffscreen()) {
                await chrome.offscreen.closeDocument();
            }
            offscreenCreated = false;
        } catch (e) {
            // 已经关掉了，忽略
        }
    }, 30000);
}

/**
 * 启动一次流媒体下载
 * @param {Object} message
 * @returns {Promise<Object>}
 */
async function startStreamDownload(message) {
    // 用户选定的码率地址优先，没选就用原始地址
    const playlistUrl = message.levelUrl || message.url;
    if (!playlistUrl) return { ok: false, error: '缺少播放清单地址' };

    // 请求头从最初嗅探到的那个地址继承，
    // 子清单与分片通常同域，令牌头一致
    const item = JTStore.findByUrl(message.url);
    const headers = pickFetchableHeaders(item && item.requestHeaders);

    let text = '';

    if (!message.levelUrl && message.inlineText) {
        // 内联清单：文本在嗅探时就抓到了，而且相对路径已经补全。
        // 它的地址只存在于页面里（甚至是个占位地址），取不到，只能用文本。
        text = message.inlineText;
    } else {
        const fetched = await fetchTextForTool(playlistUrl);
        if (!fetched.ok) {
            return { ok: false, error: fetched.error || '无法获取播放清单' };
        }
        text = fetched.text;
    }

    try {
        await ensureOffscreen();
    } catch (e) {
        return { ok: false, error: '后台任务启动失败：' + ((e && e.message) || e) };
    }

    // 有新任务了，取消待执行的关闭
    if (offscreenCloseTimer) {
        clearTimeout(offscreenCloseTimer);
        offscreenCloseTimer = null;
    }

    const taskId = JTUtils.uid('task');

    // 页面里捞到的密钥，作为取密钥失败时的回退
    const tabId = item && typeof item.tabId === 'number' ? item.tabId : activeTabId;
    const keyFallback = typeof tabId === 'number' ? latestCapturedKey(tabId) : null;

    try {
        await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'offscreen:download',
            payload: {
                taskId: taskId,
                text: text,
                baseUrl: playlistUrl,
                fileName: message.fileName || 'video',
                threads: message.threads || 4,
                headers: headers,
                keyFallback: keyFallback,
                directory: JTConfig.get('downloadDir') || ''
            }
        });
    } catch (e) {
        return { ok: false, error: '任务派发失败：' + ((e && e.message) || e) };
    }

    return { ok: true, taskId: taskId };
}

/**
 * 让 offscreen 重试上一次任务的失败分片
 * @returns {Promise<Object>}
 */
async function retryStreamFailed() {
    try {
        await ensureOffscreen();

        const res = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'offscreen:retryFailed'
        });

        return res || { ok: false, error: '后台任务没有响应' };
    } catch (e) {
        return { ok: false, error: '重试失败：' + ((e && e.message) || e) };
    }
}

// ============================================================
// 录制模式
// ============================================================

/**
 * 向页面发一条录制指令
 * @param {number} tabId
 * @param {string} type
 * @returns {Promise<Object>}
 */
async function sendRecordCommand(tabId, type) {
    if (tabId === undefined || tabId < 0) {
        return { ok: false, error: '没有可用的标签页' };
    }

    try {
        await chrome.tabs.sendMessage(tabId, { type: type });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: '录制脚本未就绪：' + ((e && e.message) || e) };
    }
}

/**
 * 开始录制
 * @param {number} tabId
 * @returns {Promise<Object>}
 */
async function startRecording(tabId) {
    const injected = await injectScript(tabId, 'recorder', false);
    if (!injected.ok) return injected;

    return sendRecordCommand(tabId, 'record:start');
}

// ============================================================
// 移动端 UA
// ============================================================

/** 用移动端 UA 请求 */
const UA_RULE_ID = 900001;
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * 按配置启用 / 停用移动 UA
 * @param {boolean} enabled
 */
async function applyMobileUserAgent(enabled) {
    if (!chrome.declarativeNetRequest) return;

    try {
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [UA_RULE_ID],
            addRules: enabled ? [{
                id: UA_RULE_ID,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [{
                        header: 'User-Agent',
                        operation: 'set',
                        value: MOBILE_UA
                    }]
                },
                condition: {
                    resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'other']
                }
            }] : []
        });
    } catch (e) {
        console.warn('[鲸吞] 设置移动端 UA 失败:', e.message);
    }
}

/**
 * 向页面发一条媒体控制指令
 * @param {number} tabId
 * @param {string} command play / pause / speed / volume / seek / pip / fullscreen / screenshot
 * @param {Object} [payload]
 * @returns {Promise<Object>}
 */
async function sendMediaCommand(tabId, command, payload) {
    if (tabId === undefined || tabId < 0) {
        return { ok: false, error: '没有可用的标签页' };
    }

    // 首次调用时注入，之后靠脚本自身的防重复守卫
    const injected = await injectScript(tabId, 'media-control', false);
    if (!injected.ok) return injected;

    try {
        await chrome.tabs.sendMessage(tabId, {
            type: 'media:command',
            payload: Object.assign({ command: command }, payload || {})
        });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: '控制脚本未就绪：' + ((e && e.message) || e) };
    }
}

// ============================================================
// 右键菜单与快捷键
//
// 两者共用同一套动作分发，菜单项 id 与命令名一一对应，
// 不必把同样的逻辑写两遍。
// ============================================================

/** 可触发的动作。id 同时用作右键菜单项 id 和快捷键命令名。 */
const MENU_ACTIONS = [
    { id: 'toggle-capture', title: '开始 / 停止捕获' },
    { id: 'deep-search', title: '深度搜索' },
    { id: 'preview', title: '打开管理页' },
    { id: 'image-save', title: '下载这张图片', contexts: ['image'] },
    { id: 'auto-down', title: '切换自动下载' },
    { id: 'toggle-enable', title: '启用 / 停用嗅探' },
    { id: 'clear-list', title: '清空列表' }
];

/** 除图片菜单外，其余菜单适用的上下文 */
const MENU_CONTEXTS = ['page', 'video', 'audio', 'image', 'link'];

/** 创建右键菜单 */
function initContextMenus() {
    if (!chrome.contextMenus) return;

    // 用户在设置里关掉了：清掉之前建的。
    // 装了一堆扩展后右键栏会很长，有些人希望把它收起来。
    if (JTConfig.get('contextMenusEnable') === false) {
        chrome.contextMenus.removeAll(function () {});
        return;
    }

    // 先清空：扩展更新后菜单项可能残留旧的
    chrome.contextMenus.removeAll(function () {
        chrome.contextMenus.create({
            id: 'jingtun-root',
            title: '鲸吞',
            contexts: MENU_CONTEXTS
        });

        for (const item of MENU_ACTIONS) {
            chrome.contextMenus.create({
                id: item.id,
                parentId: 'jingtun-root',
                title: item.title,
                // 每项可以有自己的上下文（比如「下载图片」只在图片上出现）
                contexts: item.contexts || MENU_CONTEXTS
            });
        }
    });
}

/**
 * 执行一个动作
 * @param {string} action
 * @param {number} [tabId]
 */
async function runCommand(action, tabId, info) {
    const id = tabId !== undefined ? tabId : activeTabId;
    if (id === undefined || id < 0) return;

    try {
        switch (action) {
            case 'toggle-capture':
                // 捕获的启停由页面侧脚本自己管状态，这里直接转发
                await chrome.tabs.sendMessage(id, { type: 'capture:start' });
                break;

            case 'deep-search':
                await injectScript(id, 'deep-search', false);
                break;

            case 'preview':
                // 打开管理页，大屏上批量操作比弹窗舒服得多
                chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
                break;

            case 'image-save': {
                // 保存右键点中的那张图片
                const src = info && info.srcUrl;
                if (!src) break;

                const tabInfo = await getTabInfo(id);
                await handleDownload({
                    item: {
                        url: src,
                        ext: JTUtils.quickExt(src) || 'jpg',
                        pageUrl: tabInfo.url,
                        pageTitle: tabInfo.title,
                        name: ''
                    }
                });
                break;
            }

            case 'auto-down': {
                const next = JTConfig.get('autoDownload') !== true;
                await JTConfig.set('autoDownload', next);

                // 这是个开关型动作，用户点完看不到任何变化会以为没生效，
                // 用角标闪一下告诉他是开还是关
                flashBadge(id, next ? '自动开' : '自动关');
                break;
            }

            case 'toggle-enable': {
                const next = JTConfig.get('enable') !== true;
                await JTConfig.set('enable', next);

                chrome.runtime.sendMessage({
                    type: 'config:changed',
                    payload: { enable: next }
                }, function () {
                    if (chrome.runtime.lastError) { /* 弹窗没开着 */ }
                });
                break;
            }

            case 'clear-list':
                JTStore.remove(id);
                updateBadge(id);
                notifyPopup({ type: 'command', action: action });
                break;

            default:
                break;
        }
    } catch (e) {
        // 页面可能不支持该操作（比如 chrome:// 页面），静默跳过
        console.warn('[鲸吞] 执行动作失败:', action, e.message || e);
    }
}

/**
 * 在角标上短暂显示一段文字
 * @param {number} tabId
 * @param {string} text
 */
function flashBadge(tabId, text) {
    try {
        chrome.action.setBadgeText({ tabId: tabId, text: text });
        chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#2f7cf6' });

        setTimeout(function () {
            updateBadge(tabId);
        }, 1500);
    } catch (e) {
        // 角标在某些浏览器上不可用，忽略
    }
}

// 右键菜单点击
if (chrome.contextMenus && chrome.contextMenus.onClicked) {
    chrome.contextMenus.onClicked.addListener(function (info, tab) {
        // 只管自己创建的菜单项，别去响应别人的
        const known = MENU_ACTIONS.some(function (a) { return a.id === info.menuItemId; });
        if (!known) return;

        // info 要传下去：「下载这张图片」需要 info.srcUrl
        runCommand(info.menuItemId, tab ? tab.id : undefined, info);
    });
}

// 快捷键
if (chrome.commands && chrome.commands.onCommand) {
    chrome.commands.onCommand.addListener(function (command) {
        runCommand(command);
    });
}

// ============================================================
// 安装与更新
// ============================================================

if (chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener(function (details) {
        // 不再自动打开引导页。
        if (details.reason === 'update' || details.reason === 'install') {
            initContextMenus();
        }
    });
}

// ============================================================
// 消息路由
// ============================================================

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return;

    // 发给 offscreen 的指令不归这里管。
    // 后台自己发出的消息自己也会收到，不过滤的话会绕成回环。
    if (message.target === 'offscreen') return;

    switch (message.type) {
        // ---------- 来自弹窗 ----------
        case 'popup:getData': {
            const tabId = message.tabId ?? activeTabId;
            sendResponse({
                ok: true,
                tabId: tabId,
                items: JTStore.get(tabId),
                counts: JTStore.count(tabId),
                keepAlive: keepAlive.isActive(),
                // 弹窗每次打开都是新实例，捕获状态只能问后台
                capturing: captureActive.has(tabId),
                canExport: captureReady.has(tabId)
            });
            return true;
        }

        case 'popup:clear': {
            const tabId = message.tabId ?? activeTabId;
            JTStore.remove(tabId);
            updateBadge(tabId);
            sendResponse({ ok: true });
            return true;
        }

        case 'popup:clearAll': {
            JTStore.clear();
            const tabs = Array.from(tabInfoCache.keys());
            for (const tabId of tabs) updateBadge(tabId);
            sendResponse({ ok: true });
            return true;
        }

        // 管理页用：一次拿全部标签页的资源。
        case 'popup:listAll': {
            const all = JTStore.getAll() || {};
            const tabs = [];

            for (const rawTabId of Object.keys(all)) {
                const items = all[rawTabId];
                if (!items || items.length === 0) continue;

                const tabId = Number(rawTabId);
                const info = tabInfoCache.get(tabId) || {};

                tabs.push({
                    tabId: tabId,
                    pageUrl: info.url || '',
                    pageTitle: info.title || '',
                    favIconUrl: info.favIconUrl || '',
                    // 最新的排前面，与弹窗保持一致
                    items: items.slice().reverse()
                });
            }

            sendResponse({ ok: true, tabs: tabs });
            return true;
        }

        // 弹窗里的「密钥候选」：列出这个标签页捞到的所有 AES 密钥
        case 'popup:getKeys': {
            const tabId = message.tabId;
            const bucket = capturedKeys.get(tabId);

            if (!bucket || bucket.size === 0) {
                sendResponse({ ok: true, keys: [] });
                return true;
            }

            const keys = [];
            for (const [hex, info] of bucket) {
                keys.push({
                    hex: hex,
                    // 也给出 base64 形式，不同工具要的格式不一样
                    base64: btoa(String.fromCharCode.apply(null, info.key)),
                    href: info.href || '',
                    time: info.time || 0
                });
            }

            // 新的排前面
            keys.sort((a, b) => b.time - a.time);

            sendResponse({ ok: true, keys: keys });
            return true;
        }

        // 弹窗里的「发送到本地」：把选中项推送到用户配置的服务。
        case 'popup:send2local': {
            const list = Array.isArray(message.items) ? message.items : [];

            if (JTConfig.get('send2localEnable') !== true) {
                sendResponse({ ok: false, error: '还没启用本地推送' });
                return true;
            }

            if (!JTConfig.get('send2localURL')) {
                sendResponse({ ok: false, error: '还没配置本地服务地址' });
                return true;
            }

            // 逐条推，别用 Promise.all，用户自己搭的服务多半扛不住并发，
            // 而且失败信息也会混在一起分不清是哪条
            (async function () {
                let sent = 0;
                for (const item of list) {
                    try {
                        await sendToLocal(item);
                        sent++;
                    } catch (e) {
                        // 单条失败不影响其余
                    }
                }
                sendResponse({ ok: true, sent: sent });
            })();

            return true;   // 异步响应
        }

        // 模拟移动端 UA
        case 'popup:mobileUA': {
            const tabId = message.tabId;
            const ua = message.userAgent;

            if (tabId === undefined || tabId < 0) {
                sendResponse({ ok: false, error: '没有可用的标签页' });
                return true;
            }

            if (!chrome.declarativeNetRequest) {
                sendResponse({ ok: false, error: '当前浏览器不支持改写请求头' });
                return true;
            }

            (async function () {
                try {
                    const RULE_ID = 9001;

                    // 先清掉旧规则：再点一次就是取消
                    const existing = await chrome.declarativeNetRequest.getSessionRules();
                    const has = existing.some((r) => r.id === RULE_ID);

                    await chrome.declarativeNetRequest.updateSessionRules({
                        removeRuleIds: [RULE_ID]
                    });

                    if (has) {
                        // 取消模拟
                        await chrome.tabs.reload(tabId);
                        sendResponse({ ok: true, applied: false });
                        return;
                    }

                    await chrome.declarativeNetRequest.updateSessionRules({
                        addRules: [{
                            id: RULE_ID,
                            priority: 1,
                            action: {
                                type: 'modifyHeaders',
                                requestHeaders: [{
                                    header: 'user-agent',
                                    operation: 'set',
                                    value: ua
                                }]
                            },
                            condition: {
                                tabIds: [tabId],
                                resourceTypes: [
                                    'main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'other'
                                ]
                            }
                        }]
                    });

                    await chrome.tabs.reload(tabId);
                    sendResponse({ ok: true, applied: true });
                } catch (e) {
                    sendResponse({ ok: false, error: (e && e.message) || String(e) });
                }
            })();

            return true;
        }

        // 合并选中的分片
        case 'popup:mergeSegments': {
            const list = Array.isArray(message.items) ? message.items : [];

            if (list.length < 2) {
                sendResponse({ ok: false, error: '至少需要两个分片' });
                return true;
            }

            (async function () {
                try {
                    const res = await mergeSegments(list);
                    sendResponse(res);
                } catch (e) {
                    sendResponse({ ok: false, error: (e && e.message) || String(e) });
                }
            })();

            return true;
        }

        // 管理页的「删除所选」
        case 'popup:removeItems': {
            const urls = Array.isArray(message.urls) ? message.urls : [];
            const removed = JTStore.removeByUrls(urls);

            // 角标要跟着更新，否则数字还挂着已删掉的条目
            for (const tabId of tabInfoCache.keys()) updateBadge(tabId);

            sendResponse({ ok: true, removed: removed });
            return true;
        }

        case 'popup:inject': {
            const tabId = message.tabId ?? activeTabId;

            // 捕获脚本已在页面上：不重复注入（脚本自身会拒绝），
            // 改发一条 capture:start 把录制开关打开
            if (message.script === 'mse-capture' && captureReady.has(tabId)) {
                chrome.tabs.sendMessage(tabId, { type: 'capture:start' }, () => {
                    if (chrome.runtime.lastError) {
                        // 脚本已经失效（页面可能刷新过），清掉登记让下次重新注入
                        captureReady.delete(tabId);
                        captureActive.delete(tabId);
                        sendResponse({ ok: false, error: '捕获脚本已失效，请重试' });
                        return;
                    }
                    captureActive.add(tabId);
                    sendResponse({ ok: true, resumed: true });
                });
                return true;
            }

            injectScript(tabId, message.script, message.forceReload).then((result) => {
                if (result.ok) {
                    if (message.script === 'mse-capture') {
                        captureReady.add(tabId);
                        captureActive.add(tabId);
                        // 脚本内的内存上限是硬编码默认值，这里同步用户配置，
                        // 否则设置页那一项等于摆设
                        applyCaptureLimit(tabId);
                        // 同上：自动合并开关也要同步
                        applyCaptureAutoMerge(tabId);
                        // 同上：iframe sandbox 处理也要同步
                        applyCaptureSandbox(tabId);
                        applyAutoToBuffered(tabId);
                        applyAutoDownOnComplete(tabId);
                    }

                    // 区域录制：注入后直接把选择框显示出来
                    if (message.script === 'region') {
                        openRegionPicker(tabId);
                    }

                    // WebRTC 脚本注入后要显式启动：它 hook 完 RTCPeerConnection
                    // 只是"准备好了"，得再发一条指令才建面板、开始收轨道
                    if (message.script === 'webrtc') {
                        startWebrtcCapture(tabId);
                    }
                    if (result.reloaded) {
                        if (!pendingInject.has(tabId)) pendingInject.set(tabId, new Set());
                        pendingInject.get(tabId).add(message.script);
                    }
                }
                sendResponse(result);
            });
            return true;
        }

        case 'popup:stopCapture': {
            keepAlive.stop();
            const tabId = message.tabId ?? activeTabId;
            captureActive.delete(tabId);
            // 注意：不清 captureReady，脚本仍在页面上，缓冲也还留着，
            // 用户可能只是想停止录制，之后还要导出
            chrome.tabs.sendMessage(tabId, { type: 'capture:stop' }, () => {
                if (chrome.runtime.lastError) { /* 忽略 */ }
            });
            sendResponse({ ok: true });
            return true;
        }

        case 'popup:exportCapture': {
            const tabId = message.tabId ?? activeTabId;
            if (!captureReady.has(tabId)) {
                sendResponse({ ok: false, error: '当前标签页未启用捕获' });
                return true;
            }

            // 真正的合并与下载发生在页面上下文（数据在那儿），
            // 这里只负责把指令递过去，并如实回报是否送达。
            chrome.tabs.sendMessage(tabId, { type: 'capture:download' }, () => {
                if (chrome.runtime.lastError) {
                    captureReady.delete(tabId);
                    captureActive.delete(tabId);
                    sendResponse({
                        ok: false,
                        error: '捕获脚本已失效（页面可能已刷新），请重新启用捕获'
                    });
                    return;
                }
                sendResponse({ ok: true });
            });
            return true;
        }

        case 'popup:download': {
            handleDownload(message).then(sendResponse);
            return true;
        }

        case 'popup:getConfig': {
            sendResponse({ ok: true, config: JTConfig.get() });
            return true;
        }

        case 'popup:setConfig': {
            const before = JTConfig.get();
            const task = message.reset
                ? JTConfig.reset()
                : JTConfig.set(message.config || message.patch || {});

            task.then(() => {
                const after = JTConfig.get();
                applyConfigSideEffects(before, after);
                sendResponse({ ok: true, config: after });
            });
            return true;
        }

        // ---------- 来自工具页（M3U8 解析 / 预览播放）----------
        case 'tool:getItem': {
            sendResponse({ ok: true, item: JTStore.findByUrl(message.url) });
            return true;
        }

        case 'tool:fetchText': {
            fetchTextForTool(message.url, message.maxBytes).then(sendResponse);
            return true;
        }

        case 'popup:getKeys': {
            const tabId = message.tabId ?? activeTabId;
            const bucket = capturedKeys.get(tabId);
            const keys = bucket
                ? Array.from(bucket.entries()).map(function (entry) {
                    return { hex: entry[0], href: entry[1].href, time: entry[1].time };
                })
                : [];
            sendResponse({ ok: true, keys: keys });
            return true;
        }

        // ---------- 流媒体下载（交给 offscreen 执行）----------
        case 'popup:downloadStream': {
            startStreamDownload(message).then(sendResponse);
            return true;
        }

        case 'popup:abortStream': {
            const taskId = message.taskId;
            if (taskId) {
                chrome.runtime.sendMessage({
                    target: 'offscreen',
                    type: 'offscreen:abort',
                    payload: { taskId: taskId }
                }, function () {
                    if (chrome.runtime.lastError) { /* offscreen 已关闭 */ }
                });
            }
            sendResponse({ ok: true });
            return true;
        }

        case 'popup:retryStreamFailed': {
            retryStreamFailed().then(sendResponse);
            return true;
        }

        // ---------- 来自 offscreen 的进度回传 ----------
        case 'offscreen:progress':
        case 'offscreen:done':
        case 'offscreen:error': {
            const kind = message.type.split(':')[1];   // progress / done / error

            // 转发给弹窗。弹窗没开着时会报错，属正常情况
            chrome.runtime.sendMessage({
                type: 'stream:' + kind,
                payload: message.payload
            }, function () {
                if (chrome.runtime.lastError) { /* 忽略 */ }
            });

            if (kind !== 'progress') {
                scheduleOffscreenClose();
            }
            sendResponse({ ok: true });
            return true;
        }

        // ---------- 来自内容脚本 ----------
        case 'content:ready': {
            // 内容脚本在每个框架加载时都会报到。
            if (JTConfig.get('deepSearchAlwaysOn') && sender.tab && sender.tab.id !== undefined) {
                if (!isSpecialPage(sender.tab.url)) {
                    // 只注入报到的那个框架，避免每个框架都触发一次全框架注入
                    injectScript(sender.tab.id, 'deep-search', false, sender.frameId).catch(() => {
                        // 单个框架注入失败不影响其他框架
                    });
                }
            }
            sendResponse({ ok: true });
            return true;
        }

        // ---------- 来自注入脚本（经内容脚本转发）----------
        case 'inject:media': {
            handleInjectedMedia(message.payload, sender);
            sendResponse({ ok: true });
            return true;
        }

        case 'inject:key': {
            // AES 密钥，供 m3u8 解密使用
            handleInjectedKey(message.payload, sender);
            sendResponse({ ok: true });
            return true;
        }

        case 'inject:drm': {
            handleDrmDetected(message.payload, sender);
            sendResponse({ ok: true });
            return true;
        }

        case 'inject:captureChunk': {
            handleCaptureChunk(message.payload, sender);
            sendResponse({ ok: true });
            return true;
        }

        case 'inject:captureWarning': {
            // 捕获过程中发现的问题（比如错过了初始化段），直接转给弹窗
            chrome.runtime.sendMessage({
                type: 'capture:warning',
                payload: message.payload
            }, function () {
                if (chrome.runtime.lastError) { /* 弹窗没开着，忽略 */ }
            });
            sendResponse({ ok: true });
            return true;
        }

        // ---------- DASH 音视频合并 ----------
        //
        // 勾选两条流（一条视频一条音频），下下来合成一个文件。
        // 自动合并音视频，避免用户手动打开终端执行 ffmpeg 命令。
        case 'popup:mergeTracks': {
            const tracks = message.items || [];
            if (tracks.length < 2) {
                sendResponse({ ok: false, error: '需要两条流才能合并' });
                return true;
            }

            const pair = tracks.slice(0, 2);

            // 只传地址，不传数据。
            const taskId = JTUtils.uid('merge');
            const title = pair[0].pageTitle || pair[0].name || 'merged';
            const fileName = JTUtils.sanitizeFileName(
                String(title).replace(/\.[a-z0-9]+$/i, ''), 120);

            const toPayload = function (it) {
                return {
                    url: it.url,
                    pageUrl: it.pageUrl || '',
                    requestHeaders: it.requestHeaders || null
                };
            };

            // 先把补头规则挂上。
            Promise.all(pair.map(function (it) {
                return applyDownloadHeaders(it).catch(function (e) {
                    console.warn('[诊断] applyDownloadHeaders 失败: ' +
                        ((e && e.stack) || e) + '  item.url=' + String(it.url).slice(0, 60));
                    return 0;
                });
            })).then(function (ruleIds) {
                const live = ruleIds.filter(function (id) { return !!id; });

                return ensureOffscreen().then(function () {
                    return new Promise(function (resolve) {
                        chrome.runtime.sendMessage({
                            target: 'offscreen',
                            type: 'offscreen:mergeTracks',
                            payload: {
                                video: toPayload(pair[0]),
                                audio: toPayload(pair[1]),
                                fileName: fileName,
                                taskId: taskId
                            }
                        }, function (r) {
                            if (chrome.runtime.lastError) {
                                resolve({ ok: false, error: chrome.runtime.lastError.message });
                            } else {
                                resolve(r || { ok: true });
                            }
                        });
                    });
                }).finally(function () {
                    // 取完就撤，别让规则一直挂在那儿影响别的请求
                    live.forEach(function (id) { removeDownloadHeaders(id); });
                });
            }).then(function (r) {
                sendResponse(r || { ok: true });
            }).catch(function (e) {
                sendResponse({ ok: false, error: (e && e.message) || String(e) });
            });

            return true;
        }

        case 'inject:mergeRequest': {
            // 捕获的音视频分轨，页面侧请求合并成一个文件。
            // 数据是 Blob，能被结构化克隆，直接转发给 offscreen。
            const p = message.payload || {};

            ensureOffscreen()
                .then(function () {
                    return chrome.runtime.sendMessage({
                        target: 'offscreen',
                        type: 'offscreen:mergeTracks',
                        payload: {
                            video: p.videoBlob,
                            audio: p.audioBlob,
                            fileName: 'merged-' + (p.part || 0),
                            taskId: 'capture-merge-' + Date.now()
                        }
                    });
                })
                .then(function (result) {
                    chrome.runtime.sendMessage({
                        type: 'capture:merged',
                        payload: result || { ok: false, error: '合并无响应' }
                    }, function () {
                        if (chrome.runtime.lastError) { /* 弹窗没开着 */ }
                    });
                })
                .catch(function (e) {
                    chrome.runtime.sendMessage({
                        type: 'capture:merged',
                        payload: { ok: false, error: e.message || String(e) }
                    }, function () {
                        if (chrome.runtime.lastError) { /* 忽略 */ }
                    });
                });

            sendResponse({ ok: true });
            return true;
        }

        case 'inject:webrtc': {
            const p = message.payload || {};

            // 轨道收集进度与录制状态转给弹窗；
            if (p.fileName) {
                chrome.runtime.sendMessage({
                    type: 'webrtc:done',
                    payload: p
                }, function () {
                    if (chrome.runtime.lastError) { /* 弹窗没开着 */ }
                });
            } else {
                chrome.runtime.sendMessage({
                    type: 'webrtc:state',
                    payload: p
                }, function () {
                    if (chrome.runtime.lastError) { /* 忽略 */ }
                });
            }

            sendResponse({ ok: true });
            return true;
        }

        // ---------- 区域录制的回传 ----------

        case 'inject:region': {
            const p = message.payload || {};

            chrome.runtime.sendMessage({
                type: p.fileName ? 'region:done' : 'region:state',
                payload: p
            }, function () {
                if (chrome.runtime.lastError) { /* 弹窗没开着 */ }
            });

            sendResponse({ ok: true });
            return true;
        }

        // ---------- 录制模式的回传 ----------
        case 'inject:recordProgress':
        case 'inject:recordDone':
        case 'inject:recordError':
        case 'inject:recordResult': {
            // 显式映射，比字符串拼拆清楚
            const RECORD_FORWARD = {
                'inject:recordProgress': 'record:progress',
                'inject:recordDone': 'record:done',
                'inject:recordError': 'record:error',
                'inject:recordResult': 'record:result'
            };

            chrome.runtime.sendMessage({
                type: RECORD_FORWARD[message.type],
                payload: message.payload
            }, function () {
                if (chrome.runtime.lastError) { /* 弹窗没开着，忽略 */ }
            });
            sendResponse({ ok: true });
            return true;
        }

        // ---------- 录制指令 ----------
        case 'popup:startRecord': {
            startRecording(message.tabId ?? activeTabId).then(sendResponse);
            return true;
        }

        case 'popup:stopRecord': {
            sendRecordCommand(message.tabId ?? activeTabId, 'record:stop').then(sendResponse);
            return true;
        }

        // ---------- 媒体控制 ----------
        case 'popup:mediaCommand': {
            sendMediaCommand(message.tabId ?? activeTabId, message.command, message.payload)
                .then(sendResponse);
            return true;
        }

        case 'inject:mediaState': {
            // 页面侧执行完的回执，转发给弹窗
            chrome.runtime.sendMessage({
                type: 'media:state',
                payload: message.payload
            }, function () {
                if (chrome.runtime.lastError) { /* 弹窗没开着，忽略 */ }
            });
            sendResponse({ ok: true });
            return true;
        }

        default:
            return;
    }
});

/**
 * 处理来自注入脚本的媒体资源
 * @param {Object} payload
 * @param {Object} sender
 */
/**
 * 按用户配置的标题规则生成显示名
 * @param {Object} item 含 url / name / ext / pageTitle / pageUrl
 * @returns {string} 没配规则时返回空串，由调用方回退到默认
 */
function applyTitleRule(item) {
    const rule = JTConfig.get('titleName');
    if (!rule) return '';

    let host = '';
    try {
        host = new URL(item.pageUrl || item.url).hostname;
    } catch (e) {
        // 地址解析不出来就留空，不影响其他变量
    }

    return JTUtils.renderTemplate(rule, {
        title: item.pageTitle || '',
        name: item.name || '',
        host: host,
        ext: item.ext || ''
    });
}

/**
 * 合并若干分片为一个文件
 * @param {Array<Object>} list 分片条目，需含 url
 * @returns {Promise<Object>}
 */
async function mergeSegments(list) {
    const parts = [];

    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (!item || !item.url) continue;

        let res;
        try {
            // 带上 Referer：很多站点的分片有防盗链，
            // 不带的话第二片开始就 403 了
            res = await fetch(item.url, {
                credentials: 'include',
                headers: item.referer ? { Referer: item.referer } : undefined
            });
        } catch (e) {
            return { ok: false, error: '第 ' + (i + 1) + ' 片请求失败：' + ((e && e.message) || e) };
        }

        if (!res.ok) {
            return { ok: false, error: '第 ' + (i + 1) + ' 片返回 ' + res.status };
        }

        parts.push(await res.arrayBuffer());
    }

    if (parts.length === 0) {
        return { ok: false, error: '没有取到任何数据' };
    }

    // 拼起来
    const blob = new Blob(parts, { type: 'video/mp2t' });

    // 文件名：取第一片的名字，去掉分片序号
    const first = list[0].name || 'merged';
    const base = first.replace(/[._-]?\d+\.(ts|m4s|mp4|aac)$/i, '') || 'merged';
    const name = JTUtils.sanitizeFileName(base) + '_merged.ts';

    try {
        const url = URL.createObjectURL(blob);

        await chrome.downloads.download({
            url: url,
            filename: name,
            saveAs: JTConfig.get('saveAs') === true
        });

        // 下载器已经把数据接过去了，延迟释放即可
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);

        return { ok: true, name: name, size: blob.size, count: parts.length };
    } catch (e) {
        return { ok: false, error: '保存失败：' + ((e && e.message) || e) };
    }
}

/**
 * 把资源信息推送到本地服务
 * @param {Object} item 资源条目
 */
async function sendToLocal(item) {
    if (JTConfig.get('send2localEnable') !== true) return;

    const url = JTConfig.get('send2localURL');
    if (!url || !item || !item.url) return;

    try {
        const data = {
            url: item.url,
            name: item.name || '',
            ext: item.ext || '',
            size: item.size || 0,
            title: item.pageTitle || '',
            pageUrl: item.pageUrl || '',
            referer: item.pageUrl || '',
            mime: item.mime || '',
            time: item.time || Date.now()
        };

        const method = (JTConfig.get('send2localMethod') || 'POST').toUpperCase();
        const bodyTpl = JTConfig.get('send2localBody') || '';

        // 有模板就按模板渲染，没配就把整个对象发过去
        const body = bodyTpl
            ? JTUtils.renderTemplate(bodyTpl, data)
            : JSON.stringify(data);

        const headers = { 'Content-Type': 'application/json' };

        // 额外的头：每行一条 `Name: value`
        const extra = JTConfig.get('send2localHeaders');
        if (extra) {
            for (const line of String(extra).split('\n')) {
                const idx = line.indexOf(':');
                if (idx === -1) continue;
                const name = line.slice(0, idx).trim();
                const value = line.slice(idx + 1).trim();
                if (name) headers[name] = value;
            }
        }

        let target = url;

        // GET 没有请求体，参数拼到地址上
        if (method === 'GET') {
            const qs = new URLSearchParams(data).toString();
            target += (url.indexOf('?') === -1 ? '?' : '&') + qs;
        }

        const options = { method: method, headers: headers };
        if (method !== 'GET' && method !== 'HEAD') options.body = body;

        await fetch(target, options);
    } catch (e) {
        console.warn('[鲸吞] 推送到本地服务失败:', e.message || e);
    }
}

async function handleInjectedMedia(payload, sender) {
    if (!payload || !payload.url) return;
    if (!JTConfig.get('enable')) return;

    const tabId = sender.tab ? sender.tab.id : activeTabId;
    if (tabId === undefined || tabId < 0) return;

    const tabInfo = await getTabInfo(tabId);
    const ext = payload.ext || JTUtils.quickExt(payload.url);

    const item = {
        requestId: JTUtils.uid('inj'),
        url: payload.url,
        name: payload.name || JTUtils.parseFileName(safePathname(payload.url))[0] || '',
        ext: ext,
        mime: payload.mime || '',
        size: payload.size,
        type: payload.type || 'injected',
        source: payload.source || 'deep-search',
        initiator: payload.href || '',
        tabId: tabId,
        pageUrl: tabInfo.url,
        pageTitle: tabInfo.title,
        favIconUrl: tabInfo.favIconUrl,
        time: Date.now()
    };

    // 按用户配置的标题规则生成显示名（没配规则就保持原始文件名）
    item.name = applyTitleRule(item) || item.name;

    commitMedia(tabId, item);
    updateBadge(tabId);
    notifyPopup(item);
}

/** 页面里捞到的 AES 密钥：tabId -> Map<hex, {key, href, time}> */
const capturedKeys = new Map();

/**
 * 处理捕获到的 AES 密钥
 * @param {Object} payload
 * @param {Object} sender
 */
function handleInjectedKey(payload, sender) {
    if (!payload || !Array.isArray(payload.key) || payload.key.length !== 16) return;

    const tabId = sender && sender.tab ? sender.tab.id : activeTabId;
    if (tabId === undefined || tabId < 0) return;

    const hex = payload.key.map((b) => Number(b).toString(16).padStart(2, '0')).join('');

    let bucket = capturedKeys.get(tabId);
    if (!bucket) {
        bucket = new Map();
        capturedKeys.set(tabId, bucket);
    }
    if (bucket.has(hex)) return;   // 同一个密钥只记一次

    bucket.set(hex, {
        key: payload.key,
        href: payload.href || '',
        time: Date.now()
    });

    chrome.runtime.sendMessage({
        type: 'media:key',
        payload: { tabId: tabId, hex: hex, href: payload.href || '' }
    }, function () {
        if (chrome.runtime.lastError) { /* 忽略 */ }
    });
}

/**
 * 取某个标签页里捞到的密钥（最新的一个）
 * @param {number} tabId
 * @returns {Array<number>|null}
 */
function latestCapturedKey(tabId) {
    const bucket = capturedKeys.get(tabId);
    if (!bucket || bucket.size === 0) return null;

    let newest = null;
    for (const entry of bucket.values()) {
        if (!newest || entry.time > newest.time) newest = entry;
    }
    return newest ? newest.key : null;
}

/**
 * 处理 DRM 检测事件
 * @param {Object} payload
 * @param {Object} sender
 */
async function handleDrmDetected(payload, sender) {
    if (!JTConfig.get('notifyOnDrm')) return;

    const tabId = sender.tab ? sender.tab.id : activeTabId;
    if (tabId === undefined || tabId < 0) return;

    const tabInfo = await getTabInfo(tabId);

    const item = {
        requestId: JTUtils.uid('drm'),
        url: payload.url || tabInfo.url || '',
        name: '受 DRM 保护的内容',
        ext: '',
        mime: '',
        size: undefined,
        type: 'drm',
        source: 'drm-detect',
        drmSystem: payload.system || '未知',
        tabId: tabId,
        pageUrl: tabInfo.url,
        pageTitle: tabInfo.title,
        favIconUrl: tabInfo.favIconUrl,
        time: Date.now()
    };

    commitMedia(tabId, item);
    notifyPopup(item);
}

/**
 * 处理捕获到的媒体数据块
 * @param {Object} payload
 * @param {Object} sender
 */
function handleCaptureChunk(payload, sender) {
    if (!payload) return;
    chrome.runtime.sendMessage({
        type: 'capture:progress',
        payload: payload
    }, () => {
        if (chrome.runtime.lastError) { /* 忽略 */ }
    });
}

/**
 * 执行下载
 * @param {Object} message
 * @returns {Promise<Object>}
 */
async function handleDownload(message) {
    const item = message.item;
    if (!item || !item.url) return { ok: false, error: '无效的资源' };

    try {
        const config = JTConfig.get();
        const fileName = buildFileName(item, config);
        const downloadPath = config.downloadDir
            ? `${config.downloadDir.replace(/\/+$/, '')}/${fileName}`
            : fileName;

        // 配了 aria2 就交给它，大文件用 aria2 明显更快，
        // 而且能断点续传。失败则退回浏览器下载，不让用户两头落空。
        if (config.aria2Enable) {
            const viaAria = await aria2Download(item, fileName);
            if (viaAria.ok) {
                return { ok: true, via: 'aria2', gid: viaAria.gid };
            }
            console.warn('[鲸吞] aria2 下载失败，改用浏览器下载:', viaAria.error);
        }

        // 这个域名如果以前就下不动，别再来一遍"先失败再回退"，
        // 那条路要走十几秒，用户还得多看一次"下载失败"。
        if (shouldSkipDirectDownload(item.url)) {
            console.info('[鲸吞] 这个域名以前下载失败过，直接走页面身份重试');

            openRetryDownloader({
                url: item.url,
                filename: downloadPath,
                pageUrl: item.pageUrl || '',
                requestHeaders: item.requestHeaders || {}
            });

            return { ok: true, via: 'downloader-page' };
        }

        // 浏览器自己发起的下载不带页面的 Referer / Origin，
        const ruleId = await applyDownloadHeaders(item);

        const downloadId = await chrome.downloads.download({
            url: item.url,
            filename: downloadPath,
            saveAs: message.saveAs === true
        });

        // 规则要等下载真正跑起来才能撤，否则请求还没发出就被摘掉了。
        // 记在表里，由 downloads.onChanged 在结束时清理
        if (ruleId) pendingHeaderRules.set(downloadId, ruleId);
        jingtunDownloads.add(downloadId);

        // 记下发起时的地址，onChanged 里要用它更新统计
        downloadUrls.set(downloadId, item.url);

        // 记下发起参数：失败时要用页面身份重下一次，
        // 那时得知道原始地址、目标文件名和请求头
        downloadAttempts.set(downloadId, {
            url: item.url,
            filename: downloadPath,
            pageUrl: item.pageUrl || '',
            // 直接用它，别再筛一遍，
            requestHeaders: item.requestHeaders || {}
        });

        return { ok: true, downloadId };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
}

// ============================================================
// MQTT 推送
// ============================================================

/** 当前连接（懒建，SW 休眠后自动失效） */
let mqttClient = null;
let mqttConnecting = null;

/**
 * 取 MQTT 连接，没有就建一个
 * @returns {Promise<Object|null>}
 */
function getMqttClient() {
    if (mqttClient && mqttClient.connected) return Promise.resolve(mqttClient);
    if (mqttConnecting) return mqttConnecting;

    // 库没加载成功（SW 环境不兼容之类），安静地跳过
    if (typeof mqtt === 'undefined') return Promise.resolve(null);

    const cfg = JTConfig.get();
    if (!cfg.mqttEnable || !cfg.mqttBroker) return Promise.resolve(null);

    const protocol = cfg.mqttProtocol || 'wss';
    const port = cfg.mqttPort || (protocol === 'wss' ? 8084 : 8083);
    const path = cfg.mqttPath || '/mqtt';
    const url = protocol + '://' + cfg.mqttBroker + ':' + port + path;

    // clientId 留空时自动生成，多个设备用同一个 id 会互相踢下线
    const clientId = cfg.mqttClientId ||
        ('jingtun-' + Math.random().toString(16).slice(2, 10));

    mqttConnecting = new Promise(function (resolve) {
        let settled = false;

        // 连不上就放弃，别让推送任务一直挂着
        const giveUp = setTimeout(function () {
            if (settled) return;
            settled = true;
            mqttConnecting = null;
            console.warn('[鲸吞] MQTT 连接超时');
            resolve(null);
        }, 8000);

        try {
            const client = mqtt.connect(url, {
                clientId: clientId,
                username: cfg.mqttUser || undefined,
                password: cfg.mqttPassword || undefined,
                connectTimeout: 6000,
                reconnectPeriod: 0,     // 不自动重连，SW 里长连接没意义
                clean: true
            });

            client.on('connect', function () {
                if (settled) return;
                settled = true;
                clearTimeout(giveUp);
                mqttClient = client;
                mqttConnecting = null;
                resolve(client);
            });

            client.on('error', function (e) {
                if (settled) return;
                settled = true;
                clearTimeout(giveUp);
                mqttConnecting = null;
                console.warn('[鲸吞] MQTT 连接失败:', e.message || e);
                try { client.end(true); } catch (e2) { /* 忽略 */ }
                resolve(null);
            });
        } catch (e) {
            if (!settled) {
                settled = true;
                clearTimeout(giveUp);
                mqttConnecting = null;
            }
            console.warn('[鲸吞] MQTT 初始化失败:', e.message || e);
            resolve(null);
        }
    });

    return mqttConnecting;
}

/**
 * 把一条资源推到 MQTT
 * @param {Object} item
 */
async function sendToMqtt(item) {
    if (!item || !item.url) return;
    if (JTConfig.get('mqttEnable') !== true) return;

    try {
        const client = await getMqttClient();
        if (!client) return;

        const cfg = JTConfig.get();
        const topic = cfg.mqttTopic || 'jingtun/media';

        // 报文用模板渲染，默认是 JSON，用户也能改成纯地址
        const payload = JTUtils.renderTemplate(cfg.mqttPayload || '"${url}"', {
            url: item.url,
            name: item.name || '',
            ext: item.ext || '',
            size: item.size || 0,
            title: item.pageTitle || '',
            pageUrl: item.pageUrl || '',
            referer: item.pageUrl || '',
            mime: item.mime || '',
            time: item.time || Date.now()
        });

        client.publish(topic, payload, { qos: cfg.mqttQos || 0 }, function (err) {
            if (err) console.warn('[鲸吞] MQTT 推送失败:', err.message || err);
        });
    } catch (e) {
        console.warn('[鲸吞] MQTT 推送异常:', e.message || e);
    }
}

/**
 * 把一条资源取成 ArrayBuffer
 * @param {Object} item
 * @returns {Promise<ArrayBuffer|null>}
 */
async function fetchAsArrayBuffer(item) {
    if (!item || !item.url) return null;

    const ruleId = await applyDownloadHeaders(item);

    try {
        const headers = {};

        // 受限头（Referer / Origin / Sec-Fetch-*）设不了，靠上面的规则；
        // 其余的头直接带上
        const captured = item.requestHeaders || {};
        const SKIP = new Set(['host', 'cookie', 'content-length', 'connection',
            'referer', 'origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']);

        for (const key of Object.keys(captured)) {
            if (SKIP.has(String(key).toLowerCase())) continue;
            const v = captured[key];
            if (v !== undefined && v !== null && v !== '') headers[key] = String(v);
        }

        const res = await fetch(item.url, {
            credentials: 'include',
            headers: headers,
            cache: 'no-cache'
        });

        if (!res.ok) {
            console.warn('[鲸吞] 取流失败 HTTP ' + res.status + '：' + item.url.slice(0, 80));
            return null;
        }

        return await res.arrayBuffer();
    } catch (e) {
        console.warn('[鲸吞] 取流异常：' + ((e && e.message) || e));
        return null;
    } finally {
        // 数据已经拿到，规则可以撤了
        if (ruleId) removeDownloadHeaders(ruleId);
    }
}

// ============================================================
// 下载路径选择
// ============================================================

/**
 * 取域名
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
    try {
        return new URL(url).hostname;
    } catch (e) {
        return '';
    }
}

/**
 * 这个域名该不该跳过 chrome.downloads，直接走下载器页
 * @param {string} url
 * @returns {boolean}
 */
function shouldSkipDirectDownload(url) {
    const host = hostOf(url);
    if (!host) return false;

    const stats = JTConfig.get('downloadStats') || {};
    const rec = stats[host];
    if (!rec) return false;

    if ((rec.ok || 0) > 0) return false;
    return (rec.fail || 0) >= 2;
}

/**
 * 记一次下载结果
 * @param {string} url
 * @param {boolean} ok
 */
function recordDownloadResult(url, ok) {
    const host = hostOf(url);
    if (!host) return;

    const stats = Object.assign({}, JTConfig.get('downloadStats') || {});
    const rec = stats[host] || { ok: 0, fail: 0, time: 0 };

    if (ok) {
        rec.ok = (rec.ok || 0) + 1;
        rec.fail = 0;      // 成功了就把失败计数清零
    } else {
        rec.fail = (rec.fail || 0) + 1;
    }
    rec.time = Date.now();

    stats[host] = rec;

    // 控制体积：按时间排序，只留最近 200 个域名
    const keys = Object.keys(stats);
    if (keys.length > 200) {
        keys.sort(function (a, b) { return (stats[a].time || 0) - (stats[b].time || 0); });
        for (let i = 0; i < keys.length - 200; i++) delete stats[keys[i]];
    }

    JTConfig.set('downloadStats', stats);
}

/**
 * 通过 aria2 JSON-RPC 添加下载任务
 * @param {Object} item
 * @param {string} fileName
 * @returns {Promise<Object>}
 */
async function aria2Download(item, fileName) {
    const config = JTConfig.get();
    const rpc = config.aria2Rpc;

    if (!rpc) return { ok: false, error: '未配置 aria2 RPC 地址' };

    const options = {};

    // 把捕获到的请求头透传给 aria2
    const headers = pickRequestHeaders(item.requestHeaders) || {};
    const headerLines = [];
    for (const name of Object.keys(headers)) {
        headerLines.push(name + ': ' + headers[name]);
    }
    if (headerLines.length > 0) options.header = headerLines;

    if (fileName) options.out = fileName;
    if (config.aria2Dir) options.dir = config.aria2Dir;

    // JSON-RPC 2.0 的参数顺序：token（可选）→ uris → options
    const params = [];
    if (config.aria2Token) params.push('token:' + config.aria2Token);
    params.push([item.url]);
    params.push(options);

    try {
        const response = await fetch(rpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now().toString(),
                method: 'aria2.addUri',
                params: params
            })
        });

        if (!response.ok) {
            return { ok: false, error: 'aria2 无响应（HTTP ' + response.status + '）' };
        }

        const result = await response.json();

        if (result.error) {
            return { ok: false, error: 'aria2 报错：' + (result.error.message || '未知') };
        }

        return { ok: true, gid: result.result };
    } catch (e) {
        return {
            ok: false,
            error: '连接 aria2 失败：' + (e.message || e) +
                '（确认 RPC 已开启，且启动时加了 --rpc-allow-origin-all）'
        };
    }
}

// ============================================================
// 下载请求头（declarativeNetRequest 会话规则）
// ============================================================

/** 规则 id 递增分配，避免并发下载互相覆盖 */
let nextHeaderRuleId = 1;
/** downloadId -> ruleId，用于下载结束后清理 */
const pendingHeaderRules = new Map();
/** 本扩展发起的下载 id，用于把用户自己的下载排除在外 */
const jingtunDownloads = new Set();
/** downloadId -> 发起时的参数，失败重下时要用 */
const downloadAttempts = new Map();

/** downloadId -> 原始地址 */
const downloadUrls = new Map();

/** 这些错误值得用「页面身份」重试一次，多半是防盗链拦的 */
const RETRYABLE_ERRORS = new Set([
    'SERVER_BAD_CONTENT',
    'SERVER_UNAUTHORIZED',
    'SERVER_FORBIDDEN',
    'SERVER_UNREACHABLE',
    'SERVER_CROSS_ORIGIN_REDIRECT',
    'SERVER_FAILED',
    'NETWORK_FAILED'
]);

/**
 * 给下载请求临时补上 Referer / Origin
 * @param {Object} item 资源记录（需要 pageUrl）
 * @returns {Promise<number>} 规则 id；0 表示没添加
 */
async function applyDownloadHeaders(item) {
    if (!chrome.declarativeNetRequest) return 0;
    if (!item.pageUrl) return 0;

    let origin;
    try {
        origin = new URL(item.pageUrl).origin;
    } catch (e) {
        return 0;
    }

    const ruleId = nextHeaderRuleId++;

    // urlFilter 用「origin + path」，不用完整 URL。
    let filterUrl = item.url;
    try {
        const u = new URL(item.url);
        filterUrl = u.origin + u.pathname;
    } catch (e) {
        // URL 畸形时退回原值，至少还有机会匹配
    }

    // 要补的头：Referer / Origin 打底，再加上嗅探时抓到的那些。
    const reqHeaders = [
        { header: 'Referer', operation: 'set', value: item.pageUrl },
        { header: 'Origin', operation: 'set', value: origin },

        // chrome.downloads 发起的请求，Sec-Fetch-Site 是 "none"
        { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-site' },
        { header: 'Sec-Fetch-Mode', operation: 'set', value: 'no-cors' },
        { header: 'Sec-Fetch-Dest', operation: 'set', value: 'video' }
    ];

    // 这些头不能由扩展设置：Host 是连接层的，Cookie 走 credentials
    const SKIP = new Set([
        'host', 'cookie', 'content-length', 'connection',
        'referer', 'origin',
        // Sec-Fetch-* 上面已经显式设了，别被捕获到的值覆盖
        'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
        // Range 也单独处理，捕获到的那个是播放器当时要的一小片
        // （bytes=0-1023 之类），照搬过去下载只能拿到几 KB。
        'range'
    ]);

    // 强制从头取整段。B 站这类站点把文件切成很多次 Range 请求，
    // 补上捕获到的那个 Range 等于只下第一片。
    reqHeaders.push({ header: 'Range', operation: 'set', value: 'bytes=0-' });

    const captured = item.requestHeaders || item.headers;
    if (captured && typeof captured === 'object') {
        for (const key of Object.keys(captured)) {
            const lower = String(key).toLowerCase();
            if (SKIP.has(lower)) continue;

            const value = captured[key];
            if (value === undefined || value === null || value === '') continue;

            reqHeaders.push({
                header: key,
                operation: 'set',
                value: String(value)
            });
        }
    }

    try {
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [ruleId],
            addRules: [{
                id: ruleId,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: reqHeaders
                },
                condition: {
                    urlFilter: filterUrl,
                    // 实测：即使列全所有 resourceType，chrome.downloads
                    resourceTypes: ['xmlhttprequest', 'media', 'other', 'image']
                }
            }]
        });
        return ruleId;
    } catch (e) {
        console.warn('[鲸吞] 添加下载请求头规则失败:', e.message);
        return 0;
    }
}

/**
 * 撤掉一条会话规则
 * @param {number} ruleId
 */
function removeDownloadHeaders(ruleId) {
    if (!ruleId || !chrome.declarativeNetRequest) return;
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }, () => {
        if (chrome.runtime.lastError) { /* 已清理过，忽略 */ }
    });
}

/** 下载失败时给出明确原因 */
const DOWNLOAD_ERROR_HINT = {
    SERVER_BAD_CONTENT: '服务器返回的内容无法识别',
    SERVER_UNAUTHORIZED: '需要登录或授权（401）',
    SERVER_FORBIDDEN: '被服务器拒绝（403），通常是防盗链校验 Referer',
    SERVER_UNREACHABLE: '服务器无法访问',
    SERVER_CROSS_ORIGIN_REDIRECT: '跨域重定向被拦截',
    SERVER_FAILED: '服务器错误',
    NETWORK_FAILED: '网络错误',
    NETWORK_TIMEOUT: '网络超时',
    FILE_FAILED: '写入文件失败',
    FILE_NO_SPACE: '磁盘空间不足'
};

chrome.downloads.onChanged.addListener(function (delta) {
    // 只管自己发起的下载，用户自己的下载别去打扰
    if (!jingtunDownloads.has(delta.id)) return;

    // 规则清理：无论成功失败都要撤，否则会一直影响该地址
    if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
        const ruleId = pendingHeaderRules.get(delta.id);
        if (ruleId) {
            removeDownloadHeaders(ruleId);
            pendingHeaderRules.delete(delta.id);
        }
        jingtunDownloads.delete(delta.id);

        // 注意：这里不能删 downloadAttempts。
    }

    if (!delta.error || !delta.error.current) {
        // 没有错误 = 下载成功（或被用户取消），这时才轮到清理
        if (delta.state && delta.state.current === 'complete') {
            // 成功了就记一笔，这个域名以后可以继续走直接下载
            const u = downloadUrls.get(delta.id);
            if (u) recordDownloadResult(u, true);

            downloadAttempts.delete(delta.id);
            downloadUrls.delete(delta.id);
        }
        return;
    }

    const reason = delta.error.current;
    const hint = DOWNLOAD_ERROR_HINT[reason] || reason;
    console.warn('[鲸吞] 下载失败:', reason, hint);

    // 交给独立下载页重试一次。
    const attempt = downloadAttempts.get(delta.id);

    // 留一条明确的日志：回退有没有发生，是排查下载问题的关键线索
    console.warn('[鲸吞] 下载失败 ' + reason + '，' +
        (attempt && RETRYABLE_ERRORS.has(reason) ? '改用页面身份重试' : '不重试'));

    // 失败也要记，连续失败到阈值就会跳过直接下载这条路
    const failedUrl = downloadUrls.get(delta.id);
    if (failedUrl && RETRYABLE_ERRORS.has(reason)) {
        recordDownloadResult(failedUrl, false);
    }

    if (attempt && RETRYABLE_ERRORS.has(reason)) {
        openRetryDownloader(attempt);
    }

    // 用完就删，避免这张表越积越大
    downloadAttempts.delete(delta.id);
    downloadUrls.delete(delta.id);

    // 弹窗没开着时消息会无人接收，属正常情况
    chrome.runtime.sendMessage({
        type: 'download:failed',
        payload: { downloadId: delta.id, reason: reason, hint: hint, retrying: !!attempt }
    }, function () {
        if (chrome.runtime.lastError) { /* 忽略 */ }
    });
});

/**
 * 打开独立下载页重试
 * @param {Object} attempt { url, filename, pageUrl, requestHeaders }
 */
function openRetryDownloader(attempt) {
    try {
        const payload = {
            url: attempt.url,
            filename: attempt.filename,
            referrer: attempt.pageUrl,
            requestHeaders: attempt.requestHeaders
        };

        const url = chrome.runtime.getURL('downloader.html') +
            '?JSON=' + encodeURIComponent(JSON.stringify(payload));

        // 后台标签页打开，不打断用户当前在看的页面
        chrome.tabs.create({ url: url, active: false }, function () {
            if (chrome.runtime.lastError) {
                console.warn('[鲸吞] 打开重下页面失败: ' + chrome.runtime.lastError.message);
            }
        });
    } catch (e) {
        console.warn('[鲸吞] 打开重下页面失败:', e.message || e);
    }
}

/**
 * 按模板生成文件名
 * @param {Object} item
 * @param {Object} config
 * @returns {string}
 */
function buildFileName(item, config) {
    const template = config.fileNameTemplate || '${title}.${ext}';

    // 模板能取到的变量。尽量给全，用户想拼什么自己拼，
    // 不用回来改代码。
    const data = {
        // 命名相关
        title: item.pageTitle || item.name || 'video',
        name: item.name || '',
        fileName: item.name ? item.name.replace(/\.[^.]+$/, '') : '',
        ext: item.ext || 'mp4',
        host: safeHostname(item.pageUrl),

        // 来源相关
        url: item.url || '',
        pageUrl: item.pageUrl || '',
        referer: item.pageUrl || '',
        origin: safeOrigin(item.pageUrl),
        initiator: item.initiator || '',
        tabId: item.tabId !== undefined ? String(item.tabId) : '',

        // 时间（JTTemplate 里还有 year/month/day 等分量）
        time: new Date(item.time || Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-')
    };

    let fileName = JTUtils.renderTemplate(template, data);
    fileName = JTUtils.sanitizeFileName(fileName);

    // 模板未包含扩展名时补上
    if (item.ext && !fileName.toLowerCase().endsWith('.' + item.ext.toLowerCase())) {
        fileName += '.' + item.ext;
    }
    return fileName;
}

/**
 * 从 URL 安全提取主机名
 * @param {string} url
 * @returns {string}
 */
function safeHostname(url) {
    if (!url) return '';
    try {
        return new URL(url).hostname;
    } catch (e) {
        return '';
    }
}

// ============================================================
// 启动
// ============================================================

/** 初始化流程 */
async function bootstrap() {
    await JTConfig.load();
    await JTStore.init();
    JTStore.setLimit(JTConfig.get('maxPerTab'));
    JTStore.setDedupe(JTConfig.get('checkDuplicates'));

    // 记录当前活动标签
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs && tabs[0] && tabs[0].id !== undefined) {
            activeTabId = tabs[0].id;
        }
    } catch (e) { /* 忽略 */ }

    // 移动端 UA 用的是会话级规则，浏览器重启后不会保留，要重新应用
    await applyMobileUserAgent(JTConfig.get('mobileUserAgent') === true);

    // 右键菜单要等 SW 起来后才能建。重复调用是安全的（内部先 removeAll）
    initContextMenus();

    // 点图标是开弹窗还是开侧边栏，由设置决定
    applySidePanelBehavior();

    bootstrapped = true;

    // 处理初始化期间暂存的请求
    const queued = pendingQueue.splice(0, pendingQueue.length);
    for (const data of queued) {
        try {
            handleResponse(data);
        } catch (e) { /* 单条失败不影响其余 */ }
    }

    // 若开启了常开深度搜索，为所有已加载页面注入
    if (JTConfig.get('deepSearchAlwaysOn')) {
        try {
            const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
            for (const tab of tabs) {
                if (tab.id !== undefined) injectAfterLoad(tab.id, 'deep-search');
            }
        } catch (e) { /* 忽略 */ }
    }
}

bootstrap().catch((e) => {
    console.error('[鲸吞] 初始化失败:', e);
    // 即使初始化失败也放行，避免扩展完全不可用
    bootstrapped = true;
});

// 配置变更时同步存储上限
JTConfig.onChange(function (config) {
    if (config.maxPerTab) JTStore.setLimit(config.maxPerTab);
    applySidePanelBehavior();
});

// 自动清理：关闭标签页时把该页的数据一起释放
if (chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener(function (tabId) {
        if (JTConfig.get('autoClearMode') !== 'tab') return;

        JTStore.remove(tabId);
        captureReady.delete(tabId);
        captureActive.delete(tabId);
        mediaStateCache.delete(tabId);
        downloadTasks.delete(tabId);
    });
}

/** 同步侧边栏行为 */
function applySidePanelBehavior() {
    if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) return;

    const usePanel = JTConfig.get('sidePanelMode') === true;

    chrome.sidePanel
        .setPanelBehavior({ openPanelOnActionClick: usePanel })
        .catch(function () {
            // 某些 Chrome 版本或窗口状态下会失败，忽略即可
        });
}

// 定时清理：释放长时间未活动的标签页缓存
chrome.alarms.create('jt-cleanup', { periodInMinutes: 10 });
chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name !== 'jt-cleanup') return;
    const now = Date.now();
    for (const [tabId, info] of tabInfoCache) {
        if (now - info.ts > 10 * 60 * 1000) {
            tabInfoCache.delete(tabId);
        }
    }
});
