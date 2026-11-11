/**
 * 鲸吞 · 配置管理
 */
var JTConfig = (function () {
    'use strict';

    /** 默认配置 */
    const DEFAULTS = {
        // 总开关
        enable: true,

        // 嗅探行为
        /**
 * 页面刷新/跳转时清空该标签页的列表
 */
        autoClearOnNavigate: true,

        checkDuplicates: true,
        maxPerTab: 2000,
        captureMimeTypes: true,      // 是否按 MIME 类型判定（关闭则只看扩展名）
        blockList: [],               // 屏蔽的域名列表
        minMediaSize: 0,             // 体积下限（KB），更小的不计入；0 表示不过滤
        urlRewriteRules: [],         // URL 改写正则（每项含一个捕获组，指向真实地址）

        /**
 * 捕获时自动跳到缓冲末尾
 */
        autoToBuffered: false,

        /**
 * 捕获完成（流结束）后自动导出
 */
        autoDownOnComplete: false,

        /**
 * 捕获后自动合并音视频
 */
        autoMergeCapture: false,

        /**
 * 点击图标时打开侧边栏而不是弹窗
 */
        sidePanelMode: false,

        /**
 * 自定义 CSS
 */
        customCSS: '',

        /** 是否把时间邻近的音视频自动配成一组 */
        showGroup: false,
        /** 判定"邻近"的时间差上限（秒） */
        groupTime: 3,

        /** 列表项是否显示来源网站的图标 */
        showWebIco: false,

        /**
 * 自动清理模式
 */
        autoClearMode: 'never',

        /**
 * 屏蔽网址按白名单理解
 */
        blockListWhite: false,

        /**
 * 标题规则
 */
        titleName: '',

        /** 下载前先问一次文件名（自动生成的名字常是 hash，不好认） */
        saveAs: false,

        /**
 * 是否启用右键菜单
 */
        contextMenusEnable: false,

        /**
 * 推送到本地服务
 */
        send2localEnable: false,
        send2localURL: '',
        /** GET / POST */
        // ---------- MQTT ----------
        /**
 * 通过 MQTT 推送嗅探结果
 */
        mqttEnable: false,
        mqttBroker: 'test.mosquitto.org',
        mqttPort: 8081,
        mqttPath: '/mqtt',
        mqttProtocol: 'wss',
        mqttClientId: '',           // 留空则自动生成，避免多设备撞 id
        mqttUser: '',
        mqttPassword: '',
        mqttTopic: 'jingtun/media',
        mqttQos: 0,
        /**
 * MQTT 报文模板
 */
        mqttPayload: '{"url":"${url}","title":"${title}","ext":"${ext}","size":${size}}',

        send2localMethod: 'POST',
        /**
 * 请求体模板，留空则整个发 JSON。
 */
        send2localBody: '',
        /** 额外的请求头，每行一条 Name: value */
        send2localHeaders: '',

        /** 嗅探到的资源在被下载后，是否自动从列表移除 */
        downAutoClose: false,

        /**
 * 移除页面 iframe 的 sandbox 限制
 */
        removeIframeSandbox: false,

        /**
 * 外部播放器
 */
        externalPlayer: '',

        // 外部下载器：aria2 走 JSON-RPC，适合大文件与多线程
        aria2Enable: false,
        aria2Rpc: 'http://127.0.0.1:6800/jsonrpc',
        aria2Token: '',
        aria2Dir: '',

        // 判定表：用户可在设置页逐条启用/停用并加大小条件。
        // 留空表示用代码内置的默认规则，一旦有内容就以此为准。
        extTable: [],                // [{ext, enable, operator, size, unit}]
        mimeTable: [],               // [{mime, enable, operator, size, unit}]
        regexTable: [],              // [{regex, ext, blackList, enable}]

        // 界面
        badgeNumber: true,
        reverseOrder: false,         // 倒序排列（最新在上）
        syncConfig: false,           // 把配置同步到其他设备（sync 有配额限制）

        // 下载
        autoDownload: false,
        downloadDir: '',
        fileNameTemplate: '${title}.${ext}',
        /**
 * 复制模板
 */
        copyTemplate: '${url}',

        /**
 * N_m3u8DL-RE 的命令行模板
 */
        m3u8dlArg: '"${url}" --save-dir "%USERPROFILE%\\Downloads" --save-name "${title}" ${referer|exists:\'-H "Referer:*"\'} --no-log',

        /**
 * ffmpeg 的命令行模板
 */
        ffmpegArg: '${referer|exists:\'-headers "Referer: *"\'} -i "${url}" -c copy "${title}.${ext}"',

        // 深度搜索与捕获
        deepSearchAlwaysOn: false,   // 常开深度搜索（有性能开销，默认关闭）
        captureMemoryLimit: 256,     // MSE 捕获的内存上限（MB），超出自动落盘
        mobileUserAgent: false,      // 用移动端 UA 请求（部分站点只在移动端下发资源）

        /**
 * 各域名的下载成功 / 失败次数
 */
        downloadStats: {},

        /**
 * m3u8 下载完成后，把已下载的分片从列表里隐掉
 */
        hideDownloadedSegments: true,

        /**
 * 详情面板里显示页面标题
 */
        showPageTitle: false,

        // 通知
        notifyOnDrm: true            // 检测到 DRM 时提示
    };

    let cache = Object.assign({}, DEFAULTS);
    let ready = false;
    const listeners = new Set();

    /**
 * 从存储加载配置
 * @returns {Promise<Object>}
 */
    async function load() {
        try {
            const stored = await chrome.storage.local.get('jt_config');
            if (stored && stored.jt_config && typeof stored.jt_config === 'object') {
                cache = Object.assign({}, DEFAULTS, stored.jt_config);
            } else {
                // 本机还没有配置，但用户可能开了跨设备同步 ——
                // 那就在这台机器上把 sync 里的配置接过来
                const synced = await loadFromSync();
                if (synced) cache = Object.assign({}, DEFAULTS, synced);
            }
        } catch (e) {
            console.warn('[鲸吞] 配置加载失败，使用默认值:', e);
            cache = Object.assign({}, DEFAULTS);
        }
        ready = true;
        return cache;
    }

    /**
 * 从 sync 读配置
 * @returns {Promise<Object|null>}
 */
    async function loadFromSync() {
        if (!chrome.storage.sync) return null;

        try {
            const stored = await chrome.storage.sync.get('jt_config');
            if (stored && stored.jt_config && typeof stored.jt_config === 'object') {
                return stored.jt_config;
            }
        } catch (e) {
            // 配额或权限问题，忽略
        }
        return null;
    }

    /**
 * 读取配置
 * @param {string} [key] 不传则返回全部
 * @returns {*}
 */
    function get(key) {
        if (key === undefined) return cache;
        return cache[key];
    }

    /**
 * 写入配置
 * @param {string|Object} key 键名，或完整的配置对象
 * @param {*} [value]
 * @returns {Promise<void>}
 */
    async function set(key, value) {
        if (typeof key === 'object' && key !== null) {
            cache = Object.assign({}, cache, key);
        } else {
            cache[key] = value;
        }

        for (const fn of listeners) {
            try {
                fn(cache);
            } catch (e) {
                console.warn('[鲸吞] 配置监听器执行出错:', e);
            }
        }

        try {
            await chrome.storage.local.set({ jt_config: cache });
        } catch (e) {
            console.error('[鲸吞] 配置保存失败:', e);
        }

        // 开了跨设备同步就再写一份到 sync。
        // 本地那份始终是权威 —— sync 只是分发渠道，写失败不影响使用。
        if (cache.syncConfig && chrome.storage.sync) {
            try {
                await chrome.storage.sync.set({ jt_config: cache });
            } catch (e) {
                console.warn('[鲸吞] 同步配置失败（多半是超出配额）:', e.message || e);
            }
        }
    }

    /**
 * 重置为默认值
 * @returns {Promise<void>}
 */
    async function reset() {
        cache = Object.assign({}, DEFAULTS);
        await chrome.storage.local.set({ jt_config: cache });
        for (const fn of listeners) {
            try {
                fn(cache);
            } catch (e) { /* 忽略单个监听器错误 */ }
        }
    }

    /**
 * 监听配置变更
 * @param {Function} fn
 * @returns {Function} 取消监听
 */
    function onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    /**
 * 判断某个域名是否在屏蔽列表中
 * @param {string} url
 * @returns {boolean}
 */
    function isBlocked(url) {
        if (!url) return false;
        const list = cache.blockList;

        // 白名单模式下空名单意味着「什么都不放行」——
        // 这符合直觉：既然说"只抓这几个站"，没填就是没有
        if (!Array.isArray(list) || list.length === 0) {
            return cache.blockListWhite === true;
        }

        let host = '';
        try {
            host = new URL(url).hostname;
        } catch (e) {
            return false;
        }
        if (!host) return false;

        const matched = listMatches(list, host);

        // 黑名单：命中就屏蔽
        // 白名单：命中才放行 —— 正好反过来
        return cache.blockListWhite === true ? !matched : matched;
    }

    /**
 * 名单里有没有这条 host
 * @param {Array} list
 * @param {string} host
 * @returns {boolean}
 */
    function listMatches(list, host) {
        for (const entry of list) {
            if (!entry) continue;
            const rule = String(entry).trim().toLowerCase();
            if (!rule) continue;
            if (rule.startsWith('*.')) {
                // 通配子域：*.example.com 匹配 a.example.com 与 example.com
                const base = rule.slice(2);
                if (host === base || host.endsWith('.' + base)) return true;
            } else if (host === rule || host.endsWith('.' + rule)) {
                return true;
            }
        }
        return false;
    }

    /** 是否已完成加载 */
    function isReady() {
        return ready;
    }

    return {
        DEFAULTS,
        load,
        get,
        set,
        reset,
        onChange,
        isBlocked,
        isReady
    };
})();
