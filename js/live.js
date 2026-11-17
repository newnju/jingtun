/**
 * 鲸吞：直播清单加载器
 *
 * 直播流没有 EXT-X-ENDLIST，清单会一直滚动。
 * 这个模块负责「跟着清单刷新、把新分片按顺序交出去」，
 * 让下载流程不必关心直播还是点播。
 */
var JTLive = (function () {
    'use strict';

    /** 默认配置 */
    const DEFAULTS = {
        /** 两次刷新之间的最小间隔（毫秒），避免把服务器打疼 */
        minInterval: 1000,
        /** 两次刷新之间的最大间隔（毫秒） */
        maxInterval: 10000,
        /** 下载总时长上限（秒），0 表示不限 */
        maxDuration: 0,
        /** 下载分片数上限，0 表示不限 */
        maxSegments: 0,
        /** 连续多少轮清单完全没变就认为流已结束 */
        maxIdleRounds: 10,
        /**
         * 连续多少轮清单内容完全一样就收工，0 表示不启用。
         * 有些服务器在流结束时既不发 ENDLIST 也不再更新清单，
         * 靠这一项兜住；默认关闭，因为分片较长时正常直播也会出现
         * 连续几轮没有变化。
         */
        maxUnchangedRounds: 0,
        /** 单次刷新失败后的最大重试次数 */
        fetchRetries: 3,
        /** 刷新超时（毫秒） */
        timeout: 20000,
        /** 是否遇到 ENDLIST 就停 */
        stopOnEndList: true
    };

    /**
     * @param {number} ms
     * @returns {Promise<void>}
     */
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * 分片的唯一标识。直播里同一个地址不会重复出现，
     * 但 BYTERANGE 场景下地址相同、区间不同，所以要把区间带上。
     * @param {Object} segment
     * @returns {string}
     */
    function segmentKey(segment) {
        const range = segment.byteRange
            ? segment.byteRange.offset + '-' + segment.byteRange.length
            : '';
        return segment.url + '|' + range;
    }

    /**
     * 把多个分片的时长加起来
     * @param {Array} list
     * @returns {number}
     */
    function totalDuration(list) {
        let sum = 0;
        for (const seg of list) sum += Number(seg.duration) || 0;
        return sum;
    }

    class LiveLoader {
        /**
         * @param {Object} options
         * @param {string} options.url 媒体播放列表地址
         * @param {string} [options.baseUrl] 相对地址的基准
         * @param {Function} options.fetchPlaylist (url) => Promise<string>
         * @param {Function} [options.onBatch] 拿到新分片时调用（可返回 Promise）
         * @param {Function} [options.onProgress] 进度
         * @param {Function} [options.onError] 刷新失败（非致命）
         */
        constructor(options) {
            const opts = Object.assign({}, DEFAULTS, options || {});

            this.url = opts.url;
            this.baseUrl = opts.baseUrl || opts.url;
            this.fetchPlaylist = opts.fetchPlaylist;
            this.onBatch = opts.onBatch || function () {};
            this.onProgress = opts.onProgress || function () {};
            this.onError = opts.onError || function () {};

            this.minInterval = Math.max(200, opts.minInterval);
            this.maxInterval = Math.max(this.minInterval, opts.maxInterval);
            this.maxDuration = Math.max(0, Number(opts.maxDuration) || 0);
            this.maxSegments = Math.max(0, Number(opts.maxSegments) || 0);
            this.maxIdleRounds = Math.max(1, opts.maxIdleRounds | 0);
            this.maxUnchangedRounds = Math.max(0, opts.maxUnchangedRounds | 0);
            this.fetchRetries = Math.max(0, opts.fetchRetries | 0);
            this.timeout = Math.max(1000, opts.timeout);
            this.stopOnEndList = opts.stopOnEndList !== false;

            /** 已经交出去的分片，避免重复下载 */
            this._seen = new Set();
            /** 交出去的分片总数 */
            this.count = 0;
            /** 累计时长（秒） */
            this.duration = 0;
            /** 因为跟不上而产生的空洞数 */
            this.gaps = 0;
            /** 上次拿到分片时的媒体序号 */
            this._lastSequence = -1;
            /** 是否见过 ENDLIST */
            this.ended = false;
            /** 是否是事件型清单 */
            this.isEvent = false;
            /** 目标时长（秒） */
            this.targetDuration = 0;
            /** 刷新轮数 */
            this.rounds = 0;

            this._stopped = false;
            this._stopReason = '';
        }

        /** 停止刷新 */
        stop(reason) {
            this._stopped = true;
            this._stopReason = reason || '已停止';
        }

        /** 是否已经停止 */
        isStopped() {
            return this._stopped;
        }

        /** 停止原因 */
        get stopReason() {
            return this._stopReason;
        }

        /**
         * 取一次清单文本，失败时按退避重试
         * @returns {Promise<string|null>}
         */
        async _load() {
            let lastError = null;

            for (let attempt = 0; attempt <= this.fetchRetries; attempt++) {
                if (this._stopped) return null;

                try {
                    const text = await this.fetchPlaylist(this.url, this.timeout);
                    if (text) return text;
                    lastError = new Error('清单为空');
                } catch (e) {
                    lastError = e;
                }

                if (attempt < this.fetchRetries && !this._stopped) {
                    // 直播流刷新失败很常见（网络抖动、服务器重启），
                    // 退避一下再试，不要因为一次失败就放弃整场直播
                    await sleep(Math.min(5000, 500 * Math.pow(2, attempt)));
                }
            }

            this.onError(lastError || new Error('清单刷新失败'));
            return null;
        }

        /**
         * 把新解析到的分片去重后交出去
         * @param {Object} parsed
         * @returns {Promise<Array>} 本次新增的分片
         */
        async _merge(parsed) {
            const fresh = [];

            for (const segment of parsed.segments) {
                if (segment.gap) continue;   // 占位段，没有真实内容

                const key = segmentKey(segment);
                if (this._seen.has(key)) continue;

                // 直播清单会滚动：如果新一段的序号跳了，
                // 说明中间有分片已经滚出窗口 —— 那是真实的数据空洞，
                // 用户需要知道，否则会以为文件完整。
                if (this._lastSequence >= 0 &&
                    typeof segment.sequence === 'number' &&
                    segment.sequence > this._lastSequence + 1) {
                    this.gaps++;
                }

                this._seen.add(key);
                fresh.push(segment);

                if (typeof segment.sequence === 'number' && segment.sequence > this._lastSequence) {
                    this._lastSequence = segment.sequence;
                }
            }

            if (fresh.length === 0) return fresh;

            // 重新编号，保证下游按 index 写入数组时连续
            for (let i = 0; i < fresh.length; i++) {
                fresh[i] = Object.assign({}, fresh[i], { index: this.count + i });
            }

            this.count += fresh.length;
            this.duration += totalDuration(fresh);

            await this.onBatch(fresh);
            return fresh;
        }

        /**
         * 跑完整个直播流程
         * @returns {Promise<Object>} { ok, count, duration, gaps, ended, reason }
         */
        async run() {
            let idleRounds = 0;
            let unchangedRounds = 0;
            let lastText = null;

            while (!this._stopped) {
                const text = await this._load();

                if (this._stopped) break;

                if (text === null) {
                    // 连续多轮都取不到，多半是流真的断了
                    idleRounds++;
                    if (idleRounds > this.maxIdleRounds) {
                        this._stopped = true;
                        this._stopReason = '清单连续刷新失败，可能已断流';
                        break;
                    }
                    continue;
                }

                idleRounds = 0;

                // 清单一字未变：可能是流已经结束，也可能是分片比较长。
                // 只有用户明确开了这一项才据此收工。
                if (lastText !== null && text === lastText) {
                    unchangedRounds++;
                } else {
                    unchangedRounds = 0;
                }
                lastText = text;

                if (this.maxUnchangedRounds > 0 &&
                    unchangedRounds >= this.maxUnchangedRounds) {
                    this._stopped = true;
                    this._stopReason = '清单长时间没有更新，可能已断流';
                    break;
                }

                this.rounds++;

                const parsed = JTM3u8.parse(text, this.baseUrl);

                if (!parsed.ok) {
                    this.onError(new Error(parsed.error || '清单解析失败'));
                    this._stopped = true;
                    this._stopReason = parsed.error || '清单解析失败';
                    break;
                }

                if (parsed.isMaster) {
                    this._stopped = true;
                    this._stopReason = '主播放列表需要先选码率';
                    break;
                }

                this.targetDuration = parsed.targetDuration || this.targetDuration || 0;
                this.isEvent = parsed.isEvent || this.isEvent;

                const before = this.count;
                await this._merge(parsed);

                if (parsed.isEndList) {
                    this.ended = true;
                    if (this.stopOnEndList) {
                        this._stopped = true;
                        this._stopReason = '流已结束';
                        break;
                    }
                }

                if (this._reachedLimit()) {
                    this._stopped = true;
                    this._stopReason = '已达到下载上限';
                    break;
                }

                this.onProgress({
                    rounds: this.rounds,
                    segments: this.count,
                    duration: this.duration,
                    added: this.count - before,
                    targetDuration: this.targetDuration
                });

                // 没拿到新分片就稍等一会儿再看。
                // 拿到了就尽快继续，避免跟不上直播进度。
                const added = this.count - before;
                const interval = added > 0
                    ? this.minInterval
                    : Math.min(this.maxInterval, this.targetDuration * 500 || this.minInterval);

                if (!this._stopped) await sleep(interval);
            }

            return {
                ok: this.count > 0,
                count: this.count,
                duration: this.duration,
                gaps: this.gaps,
                ended: this.ended,
                isEvent: this.isEvent,
                rounds: this.rounds,
                reason: this._stopReason || (this._stopped ? '已停止' : '')
            };
        }

        /** 是否已经达到用户设的上限 */
        _reachedLimit() {
            if (this.maxDuration > 0 && this.duration >= this.maxDuration) return true;
            if (this.maxSegments > 0 && this.count >= this.maxSegments) return true;
            return false;
        }
    }

    return {
        LiveLoader,
        DEFAULTS,
        segmentKey
    };
})();