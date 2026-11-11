/** 鲸吞：安装引导页 */
(function () {
    'use strict';

    const okBtn = document.getElementById('btnOk');
    const optionsBtn = document.getElementById('btnOptions');

    if (okBtn) {
        okBtn.addEventListener('click', function () {
            window.close();
        });
    }

    if (optionsBtn) {
        optionsBtn.addEventListener('click', function () {
            // 用 openOptionsPage 而不是自己拼 URL，
            // 它会复用已打开的设置页，不会开出一堆重复标签
            if (chrome.runtime && chrome.runtime.openOptionsPage) {
                chrome.runtime.openOptionsPage();
            } else {
                chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
            }

            window.close();
        });
    }
})();
