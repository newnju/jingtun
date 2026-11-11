/**
 * 鲸吞 · 存储层
 */
var JTStore = (function () {
    'use strict';

    const PREFIX = 'jt_tab_';
    const DEFAULT_LIMIT = 2000;    // 单标签页条目上限
    const FLUSH_DELAY = 800;       // 写入防抖间隔（毫秒）

    /** tabId(string) -> item[]，数组尾部为最新 */
    const memory = new Map();
    /** `${tabId}|${url}` -> item，用于 O(1) 去重 */
    const urlIndex = new Map();
    /** 待写入的标签页集合 */
    const dirtyTabs = new Set();

    let limit = DEFAULT_LIMIT;
    /** 是否对同一地址去重（可由用户关闭） */
    let dedupe = true;
    let flushTimer = null;
    let ready = false;

    /** 获取可用的存储区域 */
    function storageArea() {
        if (chrome.storage.session) return chrome.storage.session;
        return chrome.storage.local;
    }

    /**
 * 从存储恢复数据（Service Worker 重启后调用）
 * @returns {Promise<void>}
 */
    async function init() {
        if (ready) return;
        try {
            const all = await storageArea().get(null);
            for (const key in all) {
                if (!key.startsWith(PREFIX)) continue;
                const tabId = key.slice(PREFIX.length);
                const items = all[key];
                if (!Array.isArray(items) || items.length === 0) continue;

                memory.set(tabId, items);
                for (const item of items) {
                    if (item && item.url) {
                        urlIndex.set(tabId + '|' + item.url, item);
                    }
                }
            }
        } catch (e) {
            console.warn('[鲸吞] 存储恢复失败:', e);
        }
        ready = true;
    }

    /** 标记标签页数据已变更并安排写入 */
    function markDirty(tabId) {
        dirtyTabs.add(String(tabId));
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flush();
        }, FLUSH_DELAY);
    }

    /**
 * 将脏数据写入存储
 * @returns {Promise<void>}
 */
    async function flush() {
        if (dirtyTabs.size === 0) return;

        const payload = {};
        for (const tabId of dirtyTabs) {
            payload[PREFIX + tabId] = memory.get(tabId) || [];
        }
        dirtyTabs.clear();

        try {
            await storageArea().set(payload);
        } catch (e) {
            // 配额超限：砍掉各标签页一半的最旧数据后重试一次
            console.warn('[鲸吞] 存储写入失败，尝试缩减后重试:', e);
            try {
                for (const [tabId, list] of memory) {
                    if (list.length > 100) {
                        const keep = list.slice(-Math.floor(list.length / 2));
                        const drop = list.slice(0, list.length - keep.length);
                        for (const item of drop) {
                            if (item && item.url) urlIndex.delete(tabId + '|' + item.url);
                        }
                        memory.set(tabId, keep);
                    }
                }
                const retry = {};
                for (const [tabId, list] of memory) {
                    retry[PREFIX + tabId] = list;
                }
                await storageArea().set(retry);
            } catch (e2) {
                console.error('[鲸吞] 存储写入最终失败:', e2);
            }
        }
    }

    /**
 * 添加一条资源记录（自动去重与 LRU 淘汰）
 * @param {number|string} tabId
 * @param {Object} item
 * @returns {Object} 实际存储的条目
 */
    function add(tabId, item) {
        // 调用方可能传进空对象或 null —— 比如消息反序列化失败、
        if (!item || typeof item !== 'object' || !item.url) {
            return { item: null, isNew: false };
        }

        const key = String(tabId);
        let list = memory.get(key);
        if (!list) {
            list = [];
            memory.set(key, list);
        }

        const urlKey = key + '|' + item.url;

        if (dedupe) {
            const existing = urlIndex.get(urlKey);
            if (existing) {
                // 已存在：合并新信息（例如后到的响应头补全了大小与类型）
                Object.assign(existing, item);
                markDirty(key);
                return { item: existing, isNew: false };
            }
        }

        list.push(item);
        urlIndex.set(urlKey, item);

        // LRU 淘汰：超出上限时移除最旧的条目
        while (list.length > limit) {
            const removed = list.shift();
            if (removed && removed.url) {
                urlIndex.delete(key + '|' + removed.url);
            }
        }

        markDirty(key);
        return { item: item, isNew: true };
    }

    /**
 * 获取指定标签页的资源列表
 * @param {number|string} tabId
 * @returns {Array}
 */
    function get(tabId) {
        return memory.get(String(tabId)) || [];
    }

    /**
 * 获取全部标签页的资源
 * @returns {Object} { tabId: item[] }
 */
    function getAll() {
        const result = {};
        for (const [tabId, list] of memory) {
            if (list.length > 0) result[tabId] = list;
        }
        return result;
    }

    /**
 * 按 requestId 批量查询（O(n) 单次遍历，替代嵌套循环）
 * @param {Array<string>} requestIds
 * @returns {Array}
 */
    function getByRequestIds(requestIds) {
        if (!Array.isArray(requestIds) || requestIds.length === 0) return [];
        const wanted = new Set(requestIds);
        const result = [];
        for (const list of memory.values()) {
            for (const item of list) {
                if (wanted.has(item.requestId)) result.push(item);
            }
        }
        return result;
    }

    /**
 * 删除指定标签页的数据
 * @param {number|string} tabId
 */
    function remove(tabId) {
        const key = String(tabId);
        const list = memory.get(key);
        if (list) {
            for (const item of list) {
                if (item && item.url) urlIndex.delete(key + '|' + item.url);
            }
        }
        memory.delete(key);
        markDirty(key);
    }

    /**
 * 按地址移除若干条目
 * @param {Array<string>} urls
 * @returns {number} 实际移除的条数
 */
    function removeByUrls(urls) {
        if (!urls || urls.length === 0) return 0;

        const target = new Set(urls);
        let removed = 0;

        for (const [tabId, list] of memory) {
            const kept = [];

            for (const item of list) {
                if (item && item.url && target.has(item.url)) {
                    urlIndex.delete(tabId + '|' + item.url);
                    removed++;
                } else {
                    kept.push(item);
                }
            }

            if (kept.length !== list.length) {
                memory.set(tabId, kept);
                markDirty(tabId);
            }
        }

        return removed;
    }

    /** 清空全部数据 */
    function clear() {
        for (const [tabId, list] of memory) {
            for (const item of list) {
                if (item && item.url) urlIndex.delete(tabId + '|' + item.url);
            }
        }
        const tabIds = Array.from(memory.keys());
        memory.clear();
        urlIndex.clear();
        for (const tabId of tabIds) markDirty(tabId);
    }

    /**
 * 统计指定标签页的资源数量
 * @param {number|string} tabId
 * @returns {number}
 */
    function count(tabId) {
        const list = memory.get(String(tabId));
        return list ? list.length : 0;
    }

    /** 统计全部资源数量 */
    function totalCount() {
        let total = 0;
        for (const list of memory.values()) total += list.length;
        return total;
    }

    /**
 * 按 URL 查找资源
 * @param {string} url
 * @returns {Object|null}
 */
    function findByUrl(url) {
        if (!url) return null;

        // 快路径：URL 唯一时直接命中
        for (const [key, item] of urlIndex) {
            if (key.endsWith('|' + url)) return item;
        }

        // 慢路径：URL 含特殊字符导致键不一致时逐个比对
        for (const list of memory.values()) {
            for (let i = list.length - 1; i >= 0; i--) {
                if (list[i] && list[i].url === url) return list[i];
            }
        }
        return null;
    }

    /**
 * 设置单标签页条目上限
 * @param {number} value
 */
    function setLimit(value) {
        if (typeof value === 'number' && value > 0) limit = value;
    }

    /**
 * 设置是否去重
 * @param {boolean} value
 */
    function setDedupe(value) {
        dedupe = value !== false;
    }

    /** 是否已完成初始化 */
    function isReady() {
        return ready;
    }

    return {
        init,
        add,
        get,
        getAll,
        getByRequestIds,
        findByUrl,
        remove,
        removeByUrls,
        clear,
        count,
        totalCount,
        setLimit,
        setDedupe,
        flush,
        isReady,
        DEFAULT_LIMIT
    };
})();
