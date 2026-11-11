/** 鲸吞：媒体控制（注入至页面 MAIN world） */
(function __JINGTUN_MEDIA_CONTROL__() {
    'use strict';

    const SELF = typeof self !== 'undefined' ? self : this;

    if (SELF.__JINGTUN_MEDIA_CONTROL__) return;
    SELF.__JINGTUN_MEDIA_CONTROL__ = true;

    /**
     * 取出页面上所有可用的媒体元素
     * @returns {Array<HTMLMediaElement>}
     */
    /** 取一条文案 */
    function t(key, params, fallback) {
        const dict = SELF.__JINGTUN_I18N__;
        if (dict && typeof dict.get === 'function') return dict.get(key, params);
        return fallback || key;
    }
    function listMedia() {
        const all = Array.prototype.slice.call(
            document.querySelectorAll('video, audio')
        );

        return all.filter(function (el) {
            // 排除隐藏的：尺寸为 0 的多半是预加载用的空元素
            return el.offsetWidth > 0 || el.offsetHeight > 0 || el.duration > 0;
        }).sort(function (a, b) {
            const areaA = (a.videoWidth || a.offsetWidth || 0) * (a.videoHeight || a.offsetHeight || 0);
            const areaB = (b.videoWidth || b.offsetWidth || 0) * (b.videoHeight || b.offsetHeight || 0);
            return areaB - areaA;
        });
    }

    /**
     * 取指定序号的媒体元素
     * @param {number} [index]
     * @returns {HTMLMediaElement|null}
     */
    function pick(index) {
        const list = listMedia();
        if (list.length === 0) return null;

        const i = typeof index === 'number' && index >= 0 && index < list.length ? index : 0;
        return list[i];
    }

    /**
     * 收集当前状态
     * @param {number} [index]
     * @returns {Object}
     */
    function getState(index) {
        const list = listMedia();

        if (list.length === 0) {
            return { ok: false, error: t('media.noElement', null, '页面上没有找到媒体元素'), count: 0 };
        }

        const el = pick(index);

        return {
            ok: true,
            count: list.length,
            // 每个元素的简要信息，供界面做下拉切换
            items: list.map(function (item, i) {
                return {
                    index: i,
                    width: item.videoWidth || 0,
                    height: item.videoHeight || 0,
                    duration: isFinite(item.duration) ? item.duration : 0,
                    paused: item.paused,
                    currentTime: item.currentTime
                };
            }),
            paused: el.paused,
            muted: el.muted,
            loop: el.loop,
            volume: el.volume,
            playbackRate: el.playbackRate,
            currentTime: el.currentTime,
            duration: isFinite(el.duration) ? el.duration : 0,
            width: el.videoWidth || 0,
            height: el.videoHeight || 0
        };
    }

    /**
     * 执行一条控制指令
     * @param {string} command
     * @param {Object} payload
     * @returns {Object}
     */
    function execute(command, payload) {
        const data = payload || {};
        const el = pick(data.index);

        if (!el && command !== 'getState') {
            return { ok: false, error: t('media.noElement', null, '页面上没有找到媒体元素') };
        }

        switch (command) {
            case 'play':
                // play() 返回 Promise，被自动播放策略拒绝时会 reject。
                // 但用户是点了按钮才触发的，属于用户手势，一般不会被拒。
                el.play().catch(function () { /* 忽略 */ });
                return { ok: true };

            case 'pause':
                el.pause();
                return { ok: true };

            case 'toggle':
                if (el.paused) el.play().catch(function () { /* 忽略 */ });
                else el.pause();
                return { ok: true, paused: el.paused };

            case 'speed': {
                const rate = Math.min(16, Math.max(0.1, Number(data.value) || 1));
                el.playbackRate = rate;
                return { ok: true, playbackRate: rate };
            }

            case 'volume': {
                const volume = Math.min(1, Math.max(0, Number(data.value)));
                el.volume = volume;
                // 调音量通常意味着用户想听，同时取消静音
                if (volume > 0) el.muted = false;
                return { ok: true, volume: el.volume, muted: el.muted };
            }

            case 'muted':
                el.muted = !!data.value;
                return { ok: true, muted: el.muted };

            case 'loop':
                el.loop = !!data.value;
                return { ok: true, loop: el.loop };

            case 'seek': {
                const time = Math.max(0, Number(data.value) || 0);
                el.currentTime = time;
                return { ok: true, currentTime: el.currentTime };
            }

            case 'pip': {
                if (!document.pictureInPictureEnabled) {
                    return { ok: false, error: t('media.noPip', null, '当前浏览器不支持画中画') };
                }
                if (document.pictureInPictureElement) {
                    document.exitPictureInPicture().catch(function () { /* 忽略 */ });
                } else {
                    el.requestPictureInPicture().catch(function (e) {
                        return { ok: false, error: e.message };
                    });
                }
                return { ok: true };
            }

            case 'fullscreen': {
                const target = el;
                if (document.fullscreenElement) {
                    document.exitFullscreen().catch(function () { /* 忽略 */ });
                } else if (target.requestFullscreen) {
                    target.requestFullscreen().catch(function () { /* 忽略 */ });
                } else if (target.webkitRequestFullscreen) {
                    target.webkitRequestFullscreen();
                }
                return { ok: true };
            }

            case 'screenshot':
                return screenshot(el, data);

            case 'getState':
                return getState(data.index);

            default:
                return { ok: false, error: t('media.unknownCommand', null, '未知指令：') + command };
        }
    }

    /**
     * 截取当前画面
     * @param {HTMLMediaElement} el
     * @param {Object} data
     * @returns {Object}
     */
    function screenshot(el, data) {
        if (!el.videoWidth || !el.videoHeight) {
            return { ok: false, error: t('media.noFrame', null, '还没有画面可以截') };
        }

        try {
            const canvas = document.createElement('canvas');
            canvas.width = el.videoWidth;
            canvas.height = el.videoHeight;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(el, 0, 0, canvas.width, canvas.height);

            const dataUrl = canvas.toDataURL('image/png');

            // 直接触发下载，省得再往扩展里传一遍 base64
            const time = Math.floor(el.currentTime);
            const anchor = document.createElement('a');
            anchor.href = dataUrl;
            anchor.download = buildShotName(time);
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();

            setTimeout(function () {
                if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
            }, 5000);

            return { ok: true, time: time };
        } catch (e) {
            // 跨域污染会走到这里
            return {
                ok: false,
                error: t('media.shotFail', null, '截图失败（视频跨域时浏览器禁止读取画面）')
            };
        }
    }

    /**
     * 构造截图文件名
     * @param {number} seconds
     * @returns {string}
     */
    function buildShotName(seconds) {
        const base = String(document.title || 'screenshot')
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .trim()
            .slice(0, 60) || 'screenshot';

        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        const stamp = (h > 0 ? h + 'h' : '') +
            String(m).padStart(2, '0') + 'm' + String(s).padStart(2, '0') + 's';

        return base + '_' + stamp + '.png';
    }

    /** 原生的 postMessage */
    const nativePostMessage = (typeof SELF.postMessage === 'function')
        ? SELF.postMessage.bind(SELF)
        : null;

    /**
     * 上报到内容脚本
     * @param {Object} payload
     */
    function report(payload) {
        try {
            nativePostMessage({ action: 'jt:mediaState', payload: payload }, SELF.location.origin);
        } catch (e) {
            // 忽略
        }
    }

    // ============================================================
    // 接收指令
    // ============================================================

    SELF.addEventListener('message', function (event) {
        const data = event && event.data;
        if (!data || typeof data !== 'object') return;

        // 统一走 jt:media 这一个动作，具体指令放在 payload.command 里，
        // 指令有十来个，一个个登记到跨环境映射表里既啰嗦又容易漏
        if (data.action !== 'jt:media') return;

        const payload = data.payload || {};
        let result;

        try {
            result = execute(payload.command || 'getState', payload);
        } catch (e) {
            result = { ok: false, error: e.message || String(e) };
        }

        result.command = payload.command || 'getState';
        report(result);
    }, false);
})();
