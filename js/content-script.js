/** 鲸吞：内容脚本（Isolated World 桥接层） */
(function () {
    'use strict';

    /** 允许从页面侧接收的动作白名单 */
    const INBOUND_ACTIONS = new Set([
        'jt:addMedia',
        'jt:addKey',
        'jt:drmDetected',
        'jt:captureChunk',
        'jt:captureDone',
        'jt:recordProgress',
        'jt:recordDone',
        'jt:recordError',
        'jt:recordResult',
        'jt:mediaState',
        'jt:captureWarning',
        'jt:mergeRequest',
        'jt:webrtcTrack',
        'jt:webrtcState',
        'jt:webrtcDone',
        'jt:webrtcError',
        'jt:webrtcResult',
        'jt:regionState',
        'jt:regionDone',
        'jt:regionError'
    ]);

    /** background 消息类型 -> 页面侧动作 的显式映射 */
    const MESSAGE_TO_ACTION = {
        'capture:start': 'jt:start',
        'capture:stop': 'jt:stop',
        'capture:download': 'jt:downloadCapture',
        'capture:setLimit': 'jt:setCaptureLimit',
        'capture:autoMerge': 'jt:setAutoMerge',
        'capture:sandbox': 'jt:setSandboxRemoval',
        'capture:autoToBuffered': 'jt:setAutoToBuffered',
        'capture:autoDownOnComplete': 'jt:setAutoDownOnComplete',
        'record:start': 'jt:recordStart',
        'record:stop': 'jt:recordStop',
        'media:command': 'jt:media',
        'webrtc:start': 'jt:webrtcStart',
        'region:open': 'jt:regionOpen'
    };

    /** action -> background 消息类型映射 */
    const ACTION_TO_MESSAGE = {
        'jt:addMedia': 'inject:media',
        'jt:addKey': 'inject:key',
        'jt:drmDetected': 'inject:drm',
        'jt:captureChunk': 'inject:captureChunk',
        'jt:captureDone': 'inject:captureChunk',
        'jt:captureWarning': 'inject:captureWarning',
        'jt:recordProgress': 'inject:recordProgress',
        'jt:recordDone': 'inject:recordDone',
        'jt:recordError': 'inject:recordError',
        'jt:recordResult': 'inject:recordResult',
        'jt:mediaState': 'inject:mediaState',
        'jt:mergeRequest': 'inject:mergeRequest',
        'jt:webrtcTrack': 'inject:webrtc',
        'jt:webrtcState': 'inject:webrtc',
        'jt:webrtcDone': 'inject:webrtc',
        'jt:webrtcError': 'inject:webrtc',
        'jt:webrtcResult': 'inject:webrtc',
        'jt:regionState': 'inject:region',
        'jt:regionDone': 'inject:region',
        'jt:regionError': 'inject:region'
    };

    // ============================================================
    // 页面侧 -> 扩展侧
    // ============================================================

    window.addEventListener('message', function (event) {
        // 校验一：来源必须是当前窗口
        if (event.source !== window) return;
        // 校验二：origin 必须与页面一致（排除跨域 iframe 与外部注入）
        if (event.origin !== window.location.origin) return;

        const data = event.data;
        if (!data || typeof data !== 'object' || typeof data.action !== 'string') return;
        // 校验三：action 必须在白名单内
        if (!INBOUND_ACTIONS.has(data.action)) return;

        const messageType = ACTION_TO_MESSAGE[data.action];
        if (!messageType) return;

        // 阻止消息继续冒泡，避免被页面其他监听器捕获
        event.stopPropagation();
        event.stopImmediatePropagation();

        try {
            chrome.runtime.sendMessage({
                type: messageType,
                payload: data.payload || {}
            }, function () {
                // 后台未就绪或扩展重载时会报错，属正常情况
                if (chrome.runtime.lastError) { /* 忽略 */ }
            });
        } catch (e) {
            // 扩展上下文失效（例如刚被重载），静默处理
        }
    }, true);

    // ============================================================
    // 扩展侧 -> 页面侧
    // ============================================================

    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
        if (!message || typeof message.type !== 'string') return;

        // 只转发显式登记过的指令，避免任意消息被投递到页面
        const action = MESSAGE_TO_ACTION[message.type];
        if (!action) return;

        window.postMessage({
            action: action,
            payload: message.payload || {}
        }, window.location.origin);

        sendResponse({ ok: true });
        return true;
    });

    // ============================================================
    // 心跳：向后台表明内容脚本已就绪
    // ============================================================

    try {
        chrome.runtime.sendMessage({ type: 'content:ready' }, function () {
            if (chrome.runtime.lastError) { /* 忽略 */ }
        });
    } catch (e) {
        // 忽略
    }
})();
