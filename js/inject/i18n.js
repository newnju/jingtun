/** 鲸吞：注入脚本的文案（中 / 英） */
(function () {
    'use strict';

    const SELF = typeof self !== 'undefined' ? self : this;

    // 幂等：脚本可能被重复注入，不要覆盖已有的
    if (SELF.__JINGTUN_I18N__) return;

    const ZH = {
        // ---------- 捕获面板 ----------
        'panel.title': '鲸吞：捕获中',
        'panel.waiting': '等待数据…',
        'panel.captured': '已捕获 {size} · 第 {part} 段',
        'panel.export': '导出',
        'panel.clear': '清空',
        'panel.exported': '已导出',
        'panel.nothingToExport': '没有可导出的数据',
        'panel.cleared': '已清空缓冲',
        'panel.collapse': '收起 / 展开',
        'panel.close': '停止并关闭',
        'panel.stopped': '已停止捕获',

        // ---------- WebRTC ----------
        'rtc.title': '鲸吞：WebRTC',
        'rtc.start': '开始录制',
        'rtc.stop': '停止并保存',
        'rtc.waiting': '等待轨道…',
        'rtc.tracks': '视频 {video} 条 · 音频 {audio} 条',
        'rtc.tracksWaiting': '（等待中）',
        'rtc.noTracks': '还没有捕获到任何轨道',
        'rtc.alreadyRecording': '已经在录制了',
        'rtc.notRecording': '没有在录制',
        'rtc.createFail': '创建录制器失败：{msg}',
        'rtc.startFail': '启动失败：{msg}',
        'rtc.stopFail': '停止失败：{msg}',
        'rtc.exportFail': '导出失败：{msg}',

        // ---------- 区域录制 ----------
        'region.start': '开始录制',
        'region.stop': '停止并保存',
        'region.hint': '拖动框选要录的区域',
        'region.hintNoCrop': '当前浏览器不支持区域捕获，将录制整个标签页',
        'region.close': '关闭',
        'region.noPermission': '没有拿到屏幕共享权限：{msg}',
        'region.cropFail': '区域裁剪失败，将录制整个页面：{msg}',
        'region.createFail': '创建录制器失败：{msg}',
        'region.startFail': '启动失败：{msg}',
        'region.exportFail': '导出失败：{msg}',

        // ---------- 媒体控制 ----------
        'media.noElement': '页面上没有找到媒体元素',
        'media.noPip': '当前浏览器不支持画中画',
        'media.unknownCommand': '未知指令：{cmd}',
        'media.noFrame': '还没有画面可以截',
        'media.shotFail': '截图失败（视频跨域时浏览器禁止读取画面）',

        // ---------- 录制 ----------
        'rec.already': '已在录制中',
        'rec.noElement': '页面上没有找到可录制的媒体元素',
        'rec.noCaptureStream': '当前浏览器不支持 captureStream，无法录制',
        'rec.noRecorder': '当前浏览器不支持 MediaRecorder',
        'rec.createFail': '创建录制器失败：{msg}',
        'rec.startFail': '启动录制失败：{msg}',
        'rec.notRecording': '当前没有在录制',
        'rec.fileSuffix': '_录制',

        // ---------- 深度搜索 ----------
        'search.unknown': '未知'
    };

    const EN = {
        // ---------- Capture panel ----------
        'panel.title': 'JingTun · Capturing',
        'panel.waiting': 'Waiting for data…',
        'panel.captured': 'Captured {size} · part {part}',
        'panel.export': 'Export',
        'panel.clear': 'Clear',
        'panel.exported': 'Exported',
        'panel.nothingToExport': 'Nothing to export',
        'panel.cleared': 'Buffer cleared',
        'panel.collapse': 'Collapse / expand',
        'panel.close': 'Stop and close',
        'panel.stopped': 'Capture stopped',

        // ---------- WebRTC ----------
        'rtc.title': 'JingTun · WebRTC',
        'rtc.start': 'Start recording',
        'rtc.stop': 'Stop and save',
        'rtc.waiting': 'Waiting for tracks…',
        'rtc.tracks': 'Video {video} · Audio {audio}',
        'rtc.tracksWaiting': '(waiting)',
        'rtc.noTracks': 'No tracks captured yet',
        'rtc.alreadyRecording': 'Already recording',
        'rtc.notRecording': 'Not recording',
        'rtc.createFail': 'Could not create recorder: {msg}',
        'rtc.startFail': 'Could not start: {msg}',
        'rtc.stopFail': 'Could not stop: {msg}',
        'rtc.exportFail': 'Could not export: {msg}',

        // ---------- Region recording ----------
        'region.start': 'Start recording',
        'region.stop': 'Stop and save',
        'region.hint': 'Drag to select the area to record',
        'region.hintNoCrop': 'Region capture unsupported — will record the whole tab',
        'region.close': 'Close',
        'region.noPermission': 'Screen share permission denied: {msg}',
        'region.cropFail': 'Crop failed, recording the whole page: {msg}',
        'region.createFail': 'Could not create recorder: {msg}',
        'region.startFail': 'Could not start: {msg}',
        'region.exportFail': 'Could not export: {msg}',

        // ---------- Media control ----------
        'media.noElement': 'No media element found on this page',
        'media.noPip': 'Picture-in-picture is not supported in this browser',
        'media.unknownCommand': 'Unknown command: {cmd}',
        'media.noFrame': 'No frame to capture yet',
        'media.shotFail': 'Screenshot failed (cross-origin video blocks frame access)',

        // ---------- Recording ----------
        'rec.already': 'Already recording',
        'rec.noElement': 'No recordable media element found',
        'rec.noCaptureStream': 'captureStream is not supported — cannot record',
        'rec.noRecorder': 'MediaRecorder is not supported',
        'rec.createFail': 'Could not create recorder: {msg}',
        'rec.startFail': 'Could not start recording: {msg}',
        'rec.notRecording': 'Not recording',
        'rec.fileSuffix': '_rec',

        // ---------- Deep search ----------
        'search.unknown': 'unknown'
    };

    /** 挑一种语言 */
    function pickTable() {
        const nav = SELF.navigator || {};

        const list = Array.isArray(nav.languages) && nav.languages.length > 0
            ? nav.languages
            : [nav.language || ''];

        for (const lang of list) {
            if (/^zh/i.test(String(lang))) return ZH;
            // 遇到明确支持的语言就停，不再往后找
            if (/^en/i.test(String(lang))) return EN;
        }

        // 都不认识就用英文，比中文的适用范围更广
        return EN;
    }

    const table = pickTable();

    SELF.__JINGTUN_I18N__ = {
        /** 当前语言：'zh' 或 'en' */
        lang: table === ZH ? 'zh' : 'en',

        /**
         * 取一条文案
         * @param {string} key
         * @param {Object} [params] 形如 {msg: '...'}，替换文案里的 {msg}
         * @returns {string} 找不到 key 时返回 key 本身，便于发现遗漏
         */
        get: function (key, params) {
            let text = table[key];

            if (text === undefined) {
                // 不静默返回空串：返回 key 能在界面上直接看出漏翻了哪条
                return key;
            }

            if (params) {
                text = text.replace(/\{(\w+)\}/g, function (whole, name) {
                    return params[name] !== undefined ? String(params[name]) : whole;
                });
            }

            return text;
        }
    };
})();
