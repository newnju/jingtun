/**
 * 鲸吞 · 兼容层
 */
(function () {
    'use strict';

    if (typeof chrome === 'undefined') return;

    // ============================================================
    // chrome.i18n
    // ============================================================

    if (!chrome.i18n) {
        chrome.i18n = {};
    }

    if (typeof chrome.i18n.getMessage !== 'function') {
        /**
 * 兜底：直接用键名当文案
 * @param {string} key
 * @returns {string}
 */
        chrome.i18n.getMessage = function (key) {
            return String(key || '');
        };
    }

    // ============================================================
    // chrome.downloads
    // ============================================================

    if (!chrome.downloads) {
        chrome.downloads = {};
    }

    if (typeof chrome.downloads.download !== 'function') {
        /**
 * 兜底：用 <a download> 触发浏览器下载
 * @param {Object} options
 * @param {Function} [callback]
 */
        chrome.downloads.download = function (options, callback) {
            try {
                const anchor = document.createElement('a');
                anchor.href = options.url;
                if (options.filename) anchor.download = options.filename;
                anchor.style.display = 'none';
                document.body.appendChild(anchor);
                anchor.click();

                setTimeout(function () {
                    if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
                }, 5000);

                if (callback) callback(0);
            } catch (e) {
                if (callback) callback(undefined);
            }
        };
    }

    if (!chrome.downloads.onChanged) {
        // 空桩：调用 addListener 不报错即可
        chrome.downloads.onChanged = { addListener: function () {} };
    }

    if (typeof chrome.downloads.showDefaultFolder !== 'function') {
        chrome.downloads.showDefaultFolder = function () {};
    }

    if (typeof chrome.downloads.show !== 'function') {
        chrome.downloads.show = function () {};
    }

    // ============================================================
    // 可选 API：缺失时打空桩
    //
    // 这些功能（右键菜单、快捷键、侧边栏、窗口）在部分浏览器里没有，
    // 但它们的缺失不该影响嗅探主流程。
    // ============================================================

    /**
 * 给一组对象补齐空桩
 * @param {Object} target
 * @param {string} name
 * @param {Array<string>} methods
 */
    function stub(target, name, methods) {
        if (!target[name]) target[name] = {};

        for (const method of methods) {
            if (typeof target[name][method] !== 'function') {
                target[name][method] = function () {};
            }
        }
    }

    stub(chrome, 'contextMenus', ['create', 'removeAll', 'update', 'remove']);
    stub(chrome, 'commands', ['getAll', 'update']);

    if (chrome.commands && !chrome.commands.onCommand) {
        chrome.commands.onCommand = { addListener: function () {} };
    }

    if (chrome.contextMenus && !chrome.contextMenus.onClicked) {
        chrome.contextMenus.onClicked = { addListener: function () {} };
    }

    if (!chrome.sidePanel) {
        chrome.sidePanel = {};
    }
    if (typeof chrome.sidePanel.setPanelBehavior !== 'function') {
        chrome.sidePanel.setPanelBehavior = function () { return Promise.resolve(); };
    }
    if (typeof chrome.sidePanel.setOptions !== 'function') {
        chrome.sidePanel.setOptions = function () { return Promise.resolve(); };
    }

    if (!chrome.windows) {
        chrome.windows = {};
    }
    if (typeof chrome.windows.create !== 'function') {
        chrome.windows.create = function (options, callback) {
            // 退而求其次：开个标签页
            try {
                chrome.tabs.create({ url: options && options.url }, callback);
            } catch (e) {
                if (callback) callback(undefined);
            }
        };
    }

    // ============================================================
    // declarativeNetRequest
    // ============================================================

    if (!chrome.declarativeNetRequest) {
        chrome.declarativeNetRequest = {};
    }

    if (typeof chrome.declarativeNetRequest.updateSessionRules !== 'function') {
        // 缺这个 API 就没法给下载请求补 Referer。
        chrome.declarativeNetRequest.updateSessionRules = function () {
            return Promise.resolve();
        };
    }

    // ============================================================
    // Promise 化的 API 兜底
    //
    // 旧版 Chrome 的 chrome.tabs.sendMessage 等只支持回调，
    // 直接 await 会拿到 undefined。这里不做全面 polyfill
    // （那会掩盖真实错误），只在缺失时给出明确提示。
    // ============================================================

    // chrome.runtime 本身可能整个不存在（某些套壳浏览器裁得很狠）。
    if (!chrome.runtime) {
        chrome.runtime = {};
    }

    if (typeof chrome.runtime.getPlatformInfo !== 'function') {
        chrome.runtime.getPlatformInfo = function (callback) {
            const info = { os: 'unknown', arch: 'unknown' };
            if (callback) { callback(info); return; }
            return Promise.resolve(info);
        };
    }
})();
