/**
 * 鲸吞：分片磁盘缓存（断点续传）
 *
 * 对标 N_m3u8DL-RE / M3U8-Downloader 的核心能力。
 * 已下载的分片存到 OPFS（Origin Private File System），
 * 换一次运行、关一次页面、甚至浏览器重启之后都能接着下。
 *
 * 浏览器支持：OPFS 在 Chrome 111+ 可用，正好是本项目的最低版本。
 * 不支持时所有方法都安静地退化成「没有缓存」，不影响主流程。
 */
var JTCache = (function () {
    'use strict';

    /** 缓存目录：/jingtun-segments/<任务指纹>/<分片序号>.part + .json */
    const ROOT_DIR = 'jingtun-segments';
    /** 单个任务最多保留的分片数，防止无限增长 */
    const MAX_PARTS_PER_JOB = 10000;

    /** 当前环境的 OPFS 能力缓存，null = 还没探测过 */
    let capability = null;

    /**
     * 探测 OPFS 是否可用
     * @returns {Promise<boolean>}
     */
    async function isSupported() {
        if (capability !== null) return capability;

        try {
            capability = !!(navigator && navigator.storage &&
                typeof navigator.storage.getDirectory === 'function');

            if (capability) {
                // 真正建一次目录，确认不是「API 在但被策略禁了」
                await navigator.storage.getDirectory();
            }
        } catch (e) {
            capability = false;
        }

        return capability;
    }

    /**
     * 取缓存根目录
     * @returns {Promise<FileSystemDirectoryHandle>}
     */
    async function rootDir() {
        if (!(await isSupported())) throw new Error('当前环境不支持 OPFS');

        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle(ROOT_DIR, { create: true });
    }

    /**
     * 用清单文本 + 地址生成任务指纹。
     *
     * 关键点：同一部片子、同一个码率必须得到同一个指纹，
     * 否则「断点续传」永远命不中。
     * @param {string} identity 任务标识（通常是清单 URL）
     * @param {string} [text] 清单原文
     * @returns {Promise<string>}
     */
    async function jobId(identity, text) {
        const raw = String(identity || '') + '\n' + String(text || '');

        try {
            // 用 SHA-256，长度固定且不会有普通字符串的哈希碰撞问题
            const bytes = new TextEncoder().encode(raw);
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest))
                .slice(0, 10)
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('');
        } catch (e) {
            // crypto 不可用时退化为可重复的普通哈希
            let h = 0;
            for (let i = 0; i < raw.length; i++) {
                h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
            }
            return (h >>> 0).toString(16);
        }
    }

    /**
     * 分片元信息文件名
     * @param {number} index
     * @returns {string}
     */
    function metaName(index) {
        return index + '.json';
    }

    /**
     * 分片数据文件名
     * @param {number} index
     * @returns {string}
     */
    function partName(index) {
        return index + '.part';
    }

    /**
     * 写入一个分片。元数据与数据分开写：
     * 数据先落盘，元数据最后写 —— 中途崩溃也不会留下「有元数据没数据」的假命中。
     * @param {string} id 任务指纹
     * @param {number} index 分片序号
     * @param {Blob} blob 分片内容
     * @param {Object} [extra] 额外元信息（如 URL、字节范围）
     * @returns {Promise<boolean>}
     */
    async function put(id, index, blob, extra) {
        if (!id || index < 0 || !blob) return false;

        try {
            const dir = await (await rootDir()).getDirectoryHandle(id, { create: true });

            // 数据先写
            const dataFile = await dir.getFileHandle(partName(index), { create: true });
            const writable = await dataFile.createWritable();
            try {
                await writable.write(blob);
            } finally {
                await writable.close();
            }

            // 元信息后写，作为「这块数据是完整的」的提交标记
            const meta = Object.assign({
                index: index,
                size: blob.size,
                time: Date.now()
            }, extra || {});

            const metaFile = await dir.getFileHandle(metaName(index), { create: true });
            const metaWritable = await metaFile.createWritable();
            try {
                await metaWritable.write(JSON.stringify(meta));
            } finally {
                await metaWritable.close();
            }

            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * 读一个分片。
     * @param {string} id 任务指纹
     * @param {number} index 分片序号
     * @param {Object} [expect] 期望的元信息（url / byteRange），用于确认没串台
     * @returns {Promise<Blob|null>}
     */
    async function get(id, index, expect) {
        if (!id || index < 0) return null;

        try {
            const dir = await (await rootDir()).getDirectoryHandle(id);

            const metaFile = await dir.getFileHandle(metaName(index));
            const metaFileHandle = await metaFile.getFile();
            const meta = JSON.parse(await metaFileHandle.text());

            if (typeof meta.size !== 'number' || meta.size < 0) return null;

            // 任务指纹相同但分片内容变了（换源、清单被重新生成），
            // 旧缓存就是错的，宁可重下
            if (expect && expect.url && meta.url && meta.url !== expect.url) return null;
            if (expect && expect.byteRange && meta.byteRange &&
                (meta.byteRange.offset !== expect.byteRange.offset ||
                    meta.byteRange.length !== expect.byteRange.length)) {
                return null;
            }

            const dataFile = await dir.getFileHandle(partName(index));
            const file = await dataFile.getFile();

            // 长度不符说明上次写了一半，不能当成功
            if (file.size !== meta.size) return null;

            return file;
        } catch (e) {
            return null;
        }
    }

    /**
     * 一次读取整个任务的缓存情况，交给下载器批量跳过已分片。
     * @param {string} id 任务指纹
     * @param {Array<Object>} segments 期望的分片列表
     * @returns {Promise<Map<number, Blob>>} index -> Blob
     */
    async function loadJob(id, segments) {
        const found = new Map();
        if (!id || !Array.isArray(segments) || segments.length === 0) return found;

        try {
            const dir = await (await rootDir()).getDirectoryHandle(id);

            // 一次性列出目录里的所有文件，避免对每个分片各问一次「有没有」
            const names = [];
            for await (const name of dir.keys()) names.push(name);

            const metaByIndex = new Map();
            for (const name of names) {
                if (!name.endsWith('.json')) continue;

                const index = parseInt(name.slice(0, -5), 10);
                if (!Number.isFinite(index)) continue;

                try {
                    const file = await (await dir.getFileHandle(name)).getFile();
                    const meta = JSON.parse(await file.text());
                    metaByIndex.set(index, meta);
                } catch (e) {
                    // 元信息读不出来就当这块不存在
                }
            }

            for (const seg of segments) {
                const index = seg.index;
                const meta = metaByIndex.get(index);
                if (!meta) continue;
                if (names.indexOf(partName(index)) === -1) continue;

                if (seg.url && meta.url && meta.url !== seg.url) continue;
                if (seg.byteRange && meta.byteRange &&
                    (meta.byteRange.offset !== seg.byteRange.offset ||
                        meta.byteRange.length !== seg.byteRange.length)) {
                    continue;
                }

                try {
                    const file = await (await dir.getFileHandle(partName(index))).getFile();
                    if (file.size !== meta.size) continue;
                    found.set(index, file);
                } catch (e) {
                    // 数据读不出来就重下
                }
            }
        } catch (e) {
            // 任务目录不存在 = 还没下过，正常情况
        }

        return found;
    }

    /**
     * 下载完成后清掉任务缓存，避免长期占用磁盘。
     * 失败重跑时会重新建目录。
     * @param {string} id 任务指纹
     * @returns {Promise<boolean>}
     */
    async function clearJob(id) {
        if (!id) return false;

        try {
            const root = await rootDir();
            await root.removeEntry(id, { recursive: true });
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * 清掉所有任务缓存。设置页「清理缓存」用。
     * @returns {Promise<number>} 清掉的任务数
     */
    async function clearAll() {
        try {
            const root = await rootDir();
            const segmentsDir = await root.getDirectoryHandle(ROOT_DIR);
            let count = 0;

            for await (const job of segmentsDir.keys()) {
                await segmentsDir.removeEntry(job, { recursive: true });
                count++;
            }

            return count;
        } catch (e) {
            return 0;
        }
    }

    return {
        isSupported,
        jobId,
        put,
        get,
        loadJob,
        clearJob,
        clearAll,
        ROOT_DIR,
        MAX_PARTS_PER_JOB
    };
})();
