/** 鲸吞：设置页逻辑 */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    /** 控件 → 配置键 → 取值方式 */
    const CONTROLS = [
        { id: 'enable', key: 'enable', kind: 'bool' },
        { id: 'badgeNumber', key: 'badgeNumber', kind: 'bool' },
        { id: 'reverseOrder', key: 'reverseOrder', kind: 'bool' },
        { id: 'syncConfig', key: 'syncConfig', kind: 'bool' },
        { id: 'captureMimeTypes', key: 'captureMimeTypes', kind: 'bool' },
        { id: 'autoClearOnNavigate', key: 'autoClearOnNavigate', kind: 'bool' },
        { id: 'checkDuplicates', key: 'checkDuplicates', kind: 'bool' },
        { id: 'maxPerTab', key: 'maxPerTab', kind: 'int', min: 50, max: 20000 },
        { id: 'minMediaSize', key: 'minMediaSize', kind: 'int', min: 0, max: 102400 },
        { id: 'blockList', key: 'blockList', kind: 'lines' },
        { id: 'urlRewriteRules', key: 'urlRewriteRules', kind: 'lines' },
        { id: 'extTable', key: 'extTable', kind: 'lines' },
        { id: 'mimeTable', key: 'mimeTable', kind: 'lines' },
        { id: 'regexTable', key: 'regexTable', kind: 'lines' },
        { id: 'deepSearchAlwaysOn', key: 'deepSearchAlwaysOn', kind: 'bool' },
        { id: 'autoMergeCapture', key: 'autoMergeCapture', kind: 'bool' },
        { id: 'autoToBuffered', key: 'autoToBuffered', kind: 'bool' },
        { id: 'autoDownOnComplete', key: 'autoDownOnComplete', kind: 'bool' },
        { id: 'removeIframeSandbox', key: 'removeIframeSandbox', kind: 'bool' },
        { id: 'downAutoClose', key: 'downAutoClose', kind: 'bool' },
        { id: 'externalPlayer', key: 'externalPlayer', kind: 'text' },

        // 界面与体验
        { id: 'sidePanelMode', key: 'sidePanelMode', kind: 'bool' },
        { id: 'showWebIco', key: 'showWebIco', kind: 'bool' },
        { id: 'showGroup', key: 'showGroup', kind: 'bool' },
        { id: 'groupTime', key: 'groupTime', kind: 'number' },
        { id: 'autoClearMode', key: 'autoClearMode', kind: 'text' },
        { id: 'blockListWhite', key: 'blockListWhite', kind: 'bool' },
        { id: 'titleName', key: 'titleName', kind: 'text' },
        { id: 'customCSS', key: 'customCSS', kind: 'text' },
        { id: 'saveAs', key: 'saveAs', kind: 'bool' },
        { id: 'contextMenusEnable', key: 'contextMenusEnable', kind: 'bool' },

        // 推送到本地服务
        { id: 'send2localEnable', key: 'send2localEnable', kind: 'bool' },
        { id: 'send2localURL', key: 'send2localURL', kind: 'text' },
        { id: 'send2localMethod', key: 'send2localMethod', kind: 'text' },
        { id: 'send2localBody', key: 'send2localBody', kind: 'text' },
        { id: 'send2localHeaders', key: 'send2localHeaders', kind: 'text' },

        // MQTT
        { id: 'mqttEnable', key: 'mqttEnable', kind: 'bool' },
        { id: 'mqttBroker', key: 'mqttBroker', kind: 'text' },
        { id: 'mqttPort', key: 'mqttPort', kind: 'int', min: 1, max: 65535 },
        { id: 'mqttPath', key: 'mqttPath', kind: 'text' },
        { id: 'mqttProtocol', key: 'mqttProtocol', kind: 'text' },
        { id: 'mqttClientId', key: 'mqttClientId', kind: 'text' },
        { id: 'mqttUser', key: 'mqttUser', kind: 'text' },
        { id: 'mqttPassword', key: 'mqttPassword', kind: 'text' },
        { id: 'mqttTopic', key: 'mqttTopic', kind: 'text' },
        { id: 'mqttQos', key: 'mqttQos', kind: 'int', min: 0, max: 2 },
        { id: 'mqttPayload', key: 'mqttPayload', kind: 'text' },
        { id: 'captureMemoryLimit', key: 'captureMemoryLimit', kind: 'int', min: 32, max: 2048 },
        { id: 'mobileUserAgent', key: 'mobileUserAgent', kind: 'bool' },
        { id: 'hideDownloadedSegments', key: 'hideDownloadedSegments', kind: 'bool' },
        { id: 'showPageTitle', key: 'showPageTitle', kind: 'bool' },
        { id: 'downloadStats', key: 'downloadStats', kind: 'skip' },
        { id: 'fileNameTemplate', key: 'fileNameTemplate', kind: 'text' },
        { id: 'copyTemplate', key: 'copyTemplate', kind: 'text' },
        { id: 'm3u8dlArg', key: 'm3u8dlArg', kind: 'text' },
        { id: 'ffmpegArg', key: 'ffmpegArg', kind: 'text' },
        { id: 'autoDownload', key: 'autoDownload', kind: 'bool' },
        { id: 'downloadDir', key: 'downloadDir', kind: 'text' },
        { id: 'aria2Enable', key: 'aria2Enable', kind: 'bool' },
        { id: 'aria2Rpc', key: 'aria2Rpc', kind: 'text' },
        { id: 'aria2Token', key: 'aria2Token', kind: 'text' },
        { id: 'aria2Dir', key: 'aria2Dir', kind: 'text' },
        { id: 'notifyOnDrm', key: 'notifyOnDrm', kind: 'bool' }
    ];

    let config = null;
    let statusTimer = null;

    // ============================================================
    // 状态提示
    // ============================================================

    /**
     * 显示底部状态
     * @param {string} text
     * @param {'ok'|'error'} [kind]
     * @param {boolean} [sticky] 是否常驻（不自动清除）
     */
    function setStatus(text, kind, sticky) {
        const el = $('status');
        el.textContent = text;
        el.className = 'status' + (kind ? ' is-' + kind : '');

        if (statusTimer) clearTimeout(statusTimer);
        if (!sticky) {
            statusTimer = setTimeout(() => {
                el.textContent = '就绪';
                el.className = 'status';
            }, 2000);
        }
    }

    // ============================================================
    // 读写
    // ============================================================

    /**
     * 把配置回填到界面
     * @param {Object} cfg
     */
    function fill(cfg) {
        for (const c of CONTROLS) {
            const el = $(c.id);
            if (!el) continue;
            const value = cfg[c.key];

            if (c.kind === 'bool') {
                el.checked = value !== false;
            } else if (c.kind === 'lines') {
                el.value = Array.isArray(value) ? value.join('\n') : '';
            } else if (c.kind === 'int') {
                el.value = Number(value) || 0;
            } else {
                el.value = value == null ? '' : String(value);
            }
        }
        updateTemplatePreview();
    }

    /**
     * 从控件读出值
     * @param {Object} c 控件描述
     * @returns {*}
     */
    function readControl(c) {
        const el = $(c.id);

        if (c.kind === 'bool') return el.checked;

        if (c.kind === 'lines') {
            return el.value
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
        }

        if (c.kind === 'int') {
            let n = parseInt(el.value, 10);
            if (!Number.isFinite(n)) n = c.min;
            // 输入过程中允许暂时越界，落库时钳回合法区间
            n = Math.min(c.max, Math.max(c.min, n));
            return n;
        }

        return el.value;
    }

    /**
     * 保存单个字段
     * @param {string} key
     * @param {*} value
     */
    async function save(key, value) {
        try {
            const res = await chrome.runtime.sendMessage({
                type: 'popup:setConfig',
                config: { [key]: value }
            });
            if (res && res.ok) {
                config = res.config;
                setStatus('已保存');
            } else {
                setStatus('保存失败', 'error');
            }
        } catch (e) {
            console.error('[鲸吞] 设置保存失败:', e);
            setStatus('保存失败：' + e.message, 'error');
        }
    }

    // ============================================================
    // 模板预览
    // ============================================================

    /** 预览用的样例数据 */
    const SAMPLE = {
        title: '示例页面标题',
        name: 'video_1080p',
        ext: 'mp4',
        index: 1,
        date: '20260916'
    };

    function updateTemplatePreview() {
        const tpl = $('fileNameTemplate').value;
        const el = $('templatePreview');
        if (!tpl) {
            el.textContent = '模板为空，将直接使用原始文件名';
            return;
        }
        let out = JTUtils.renderTemplate(tpl, SAMPLE);
        out = JTUtils.sanitizeFileName(out);
        // 模板没带扩展名时，实际下载会自动补上
        if (!/\.[a-z0-9]{1,6}$/i.test(out)) out += '.' + SAMPLE.ext;
        el.textContent = out || '—';
    }

    // ============================================================
    // 测试器
    //
    // 写正则和模板最容易犯的错，是"配完不确定对不对"。
    // 以前只能保存后去站点上试，来回切很烦。
    // 这里直接拿真实地址当场验证。
    // ============================================================

    /** 与后台 parseTableRows 保持一致的行解析 */
    function parseRows(source) {
        if (!source) return [];

        const lines = Array.isArray(source) ? source : String(source).split('\n');
        const rows = [];

        for (const line of lines) {
            const trimmed = String(line).trim();
            if (!trimmed || trimmed.charAt(0) === '#') continue;

            const fields = trimmed.split(/[,，\t]/).map(function (f) { return f.trim(); });
            if (fields.length > 0 && fields[0]) rows.push(fields);
        }

        return rows;
    }

    /**
     * 显示测试结果
     * @param {HTMLElement} el
     * @param {string} text
     * @param {'hit'|'miss'|'neutral'} kind
     */
    function showTestResult(el, text, kind) {
        el.className = 'test-result is-shown is-' + kind;
        el.textContent = text;
    }

    /** 测试正则表对某个地址的判定 */
    function testRegex() {
        const url = $('regexTestUrl').value.trim();
        const el = $('regexTestResult');

        if (!url) {
            showTestResult(el, '先填一个地址', 'neutral');
            return;
        }

        const rows = parseRows($('regexTable').value);

        if (rows.length === 0) {
            showTestResult(el, '正则表是空的，先在上面写几条规则', 'neutral');
            return;
        }

        const hits = [];
        let blacklisted = false;
        let badPattern = null;

        for (const row of rows) {
            const pattern = row[0];
            if (!pattern) continue;

            const isBlackList = String(row[2] || '').toLowerCase().indexOf('black') !== -1;
            let matched = false;

            try {
                matched = new RegExp(pattern, 'i').test(url);
            } catch (e) {
                badPattern = pattern;
                continue;
            }

            if (!matched) continue;

            if (isBlackList) {
                blacklisted = true;
                break;
            }

            hits.push(row[1] || '(未指定扩展名)');
        }

        if (blacklisted) {
            showTestResult(el, '黑名单规则命中，这个地址会被排除', 'miss');
            return;
        }

        if (hits.length > 0) {
            showTestResult(
                el,
                '命中，补出扩展名：' + hits.join(', '),
                'hit'
            );
            return;
        }

        showTestResult(
            el,
            '未命中任何规则' + (badPattern ? '（注意：有 1 条正则写错了，已跳过：' + badPattern + '）' : ''),
            'miss'
        );
    }

    /** 用真实地址试渲染文件名模板 */
    function testTemplate() {
        const url = $('templateTestUrl').value.trim();
        const el = $('templateTestResult');

        if (!url) {
            showTestResult(el, '先填一个地址', 'neutral');
            return;
        }

        const tpl = $('fileNameTemplate').value;
        if (!tpl) {
            showTestResult(el, '文件名模板为空，将直接使用原始文件名', 'neutral');
            return;
        }

        let fileName = '';
        let ext = '';
        let title = '';

        try {
            const u = new URL(url);
            fileName = JTUtils.parseFileName(u.pathname || '');
            ext = JTUtils.quickExt(url) || '';
            title = decodeURIComponent(fileName || '');
        } catch (e) {
            showTestResult(el, '这个地址解析不了，请检查格式', 'miss');
            return;
        }

        let out = JTUtils.renderTemplate(tpl, {
            title: title,
            name: fileName,
            ext: ext,
            index: '1',
            date: new Date().toISOString().slice(0, 10),
            url: url
        });

        out = JTUtils.sanitizeFileName(out);

        // 模板没带扩展名时，实际下载会自动补上
        if (!/\.[a-z0-9]{1,6}$/i.test(out)) out += '.' + (ext || 'mp4');

        showTestResult(el, out, 'neutral');
    }

    // ============================================================
    // 环境自检
    //
    // 把「依赖浏览器能力」的功能逐个测一遍，让用户知道哪些真能用。
    // 与其等他发现"这个按钮点了没反应"再来查，不如一开始就列清楚。
    // ============================================================

    /**
     * 逐项检测
     * @returns {Array<{name: string, ok: boolean, note: string}>}
     */
    function runSelfCheck() {
        const rows = [];

        function add(name, ok, note) {
            rows.push({ name: name, ok: !!ok, note: note || '' });
        }

        // --- 本地转码（ffmpeg.wasm）---
        const hasWasm = typeof WebAssembly !== 'undefined' &&
            typeof WebAssembly.instantiate === 'function';
        add('本地转码（WebAssembly）', hasWasm, hasWasm ? '' : '浏览器不支持 WebAssembly');

        // --- 录制 ---
        const hasRecorder = typeof MediaRecorder !== 'undefined';
        add('录制（MediaRecorder）', hasRecorder, hasRecorder ? '' : '浏览器不支持 MediaRecorder');

        // --- 区域录制 ---
        const hasCrop = typeof CropTarget !== 'undefined' &&
            typeof CropTarget.fromElement === 'function';
        add(
            '区域录制（CropTarget）',
            hasCrop,
            hasCrop ? '' : '浏览器版本较旧，将退化为录制整个标签页'
        );

        // --- WebRTC ---
        const hasRtc = typeof RTCPeerConnection !== 'undefined';
        add('WebRTC 捕获', hasRtc, hasRtc ? '' : '浏览器不支持 RTCPeerConnection');

        // --- 侧边栏 ---
        const hasSidePanel = !!(chrome.sidePanel && chrome.sidePanel.setPanelBehavior);
        add(
            '侧边栏',
            hasSidePanel,
            hasSidePanel ? '' : '当前 Chrome 版本不支持，可用弹窗代替'
        );

        // --- 浮动面板依赖的 Shadow DOM ---
        const hasShadow = !!(document.createElement('div').attachShadow);
        add(
            '页面内浮动面板',
            hasShadow,
            hasShadow ? '' : '不支持 Shadow DOM，面板样式可能受页面影响'
        );

        // --- 屏幕共享（区域录制需要）---
        const hasCapture = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
        add(
            '屏幕共享',
            hasCapture,
            hasCapture ? '' : '区域录制需要此能力'
        );

        // --- 剪贴板 ---
        const hasClipboard = !!(navigator.clipboard && navigator.clipboard.writeText);
        add('复制功能', hasClipboard, hasClipboard ? '' : '无法写入剪贴板');

        return rows;
    }

    function renderSelfCheck() {
        const box = $('checkList');
        if (!box) return;

        box.textContent = '';

        for (const row of runSelfCheck()) {
            const line = document.createElement('div');
            line.className = 'check-row' + (row.ok ? '' : ' is-bad');

            const mark = document.createElement('span');
            mark.className = 'check-mark';
            mark.textContent = row.ok ? '通过' : '未通过';

            const name = document.createElement('span');
            name.className = 'check-name';
            name.textContent = row.name;

            line.append(mark, name);

            if (row.note) {
                const note = document.createElement('span');
                note.className = 'check-note';
                note.textContent = row.note;
                line.appendChild(note);
            }

            box.appendChild(line);
        }
    }

    // ============================================================
    // 事件绑定
    // ============================================================

    function bind() {
        for (const c of CONTROLS) {
            const el = $(c.id);
            if (!el) continue;

            // 文本类输入边打字边存会频繁写存储，防抖一下
            const handler = c.kind === 'text' || c.kind === 'lines'
                ? JTUtils.debounce(() => save(c.key, readControl(c)), 500)
                : () => save(c.key, readControl(c));

            el.addEventListener('change', handler);
            if (c.kind === 'text' || c.kind === 'lines') {
                el.addEventListener('input', handler);
            }
        }

        // 数字框失焦时把越界值钳回合法区间并回填
        for (const c of CONTROLS) {
            if (c.kind !== 'int') continue;
            const el = $(c.id);
            el.addEventListener('blur', () => {
                const v = readControl(c);
                el.value = v;
                save(c.key, v);
            });
        }

        $('fileNameTemplate').addEventListener('input', updateTemplatePreview);

        // 环境自检
        $('btnSelfCheck').addEventListener('click', renderSelfCheck);
        renderSelfCheck();

        $('btnReloadExt').addEventListener('click', () => {
            // 有些改动（比如脚本注入策略）要重启后台才生效，
            // 让用户去扩展页点一下太麻烦
            chrome.runtime.reload();
        });

        // ---------- 测试器 ----------
        $('btnRegexTest').addEventListener('click', testRegex);
        $('btnTemplateTest').addEventListener('click', testTemplate);

        // 回车即测，省得再去点按钮
        $('regexTestUrl').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') testRegex();
        });
        $('templateTestUrl').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') testTemplate();
        });

        $('btnClearAll').addEventListener('click', async () => {
            if (!confirm('清空所有标签页的捕获记录？此操作不可撤销。')) return;
            try {
                const res = await chrome.runtime.sendMessage({ type: 'popup:clearAll' });
                if (res && res.ok) {
                    setStatus('已清空全部捕获记录', 'ok');
                } else {
                    setStatus('清空失败', 'error');
                }
            } catch (e) {
                setStatus('清空失败：' + e.message, 'error');
            }
        });

        $('btnReset').addEventListener('click', async () => {
            if (!confirm('恢复所有设置为默认值？')) return;
            try {
                const res = await chrome.runtime.sendMessage({
                    type: 'popup:setConfig',
                    reset: true
                });
                if (res && res.ok) {
                    config = res.config;
                    fill(config);
                    setStatus('已恢复默认', 'ok');
                }
            } catch (e) {
                setStatus('恢复失败：' + e.message, 'error');
            }
        });

        // ---------- 配置导入导出 ----------
        // 不走文件系统：给一段 JSON 文本，复制走就能备份，
        // 粘回来就能还原。换设备、分享配置都方便。

        $('btnExport').addEventListener('click', () => {
            const panel = $('configIo');
            $('configIoTitle').textContent = '导出配置';
            $('configIoDesc').textContent = '下面是当前全部设置，复制保存即可。';
            $('configText').value = JSON.stringify(config, null, 2);
            $('configText').readOnly = true;
            panel.hidden = false;
            panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            // 自动全选，省得用户自己拖
            $('configText').select();
            setStatus('已生成配置文本');
        });

        $('btnImport').addEventListener('click', () => {
            const panel = $('configIo');
            $('configIoTitle').textContent = '导入配置';
            $('configIoDesc').textContent = '把之前导出的 JSON 粘到下面，然后点「应用」。';
            $('configText').value = '';
            $('configText').readOnly = false;
            panel.hidden = false;
            panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            $('configText').focus();
        });

        $('btnConfigClose').addEventListener('click', () => {
            $('configIo').hidden = true;
        });

        $('btnConfigApply').addEventListener('click', async () => {
            const text = $('configText').value.trim();

            if (!text) {
                setStatus('请先粘贴配置内容', 'error');
                return;
            }

            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch (e) {
                setStatus('不是合法的 JSON：' + e.message, 'error');
                return;
            }

            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                setStatus('配置内容应该是一个对象', 'error');
                return;
            }

            try {
                const res = await chrome.runtime.sendMessage({
                    type: 'popup:setConfig',
                    patch: parsed
                });

                if (res && res.ok) {
                    config = res.config;
                    fill(config);
                    $('configIo').hidden = true;
                    setStatus('配置已应用', 'ok');
                } else {
                    setStatus('应用失败：' + ((res && res.error) || '未知错误'), 'error');
                }
            } catch (e) {
                setStatus('应用失败：' + e.message, 'error');
            }
        });
    }

    // ============================================================
    // 初始化
    // ============================================================

    async function init() {
        JTUtils.setTitle('pageOptions', '设置');
        $('version').textContent = 'v' + chrome.runtime.getManifest().version;

        try {
            const res = await chrome.runtime.sendMessage({ type: 'popup:getConfig' });
            if (res && res.ok) {
                config = res.config;
            }
        } catch (e) {
            console.error('[鲸吞] 设置读取失败:', e);
        }

        if (!config) {
            // 后台没应答（极少见）时退回内置默认值，界面至少保持可用
            config = (typeof JTConfig !== 'undefined' && JTConfig.DEFAULTS) || {};
            setStatus('无法读取配置，显示的是默认值', 'error', true);
        }

        fill(config);
        bind();

        renderDownloadStats();

        // 清空下载记录：站点修好了、或者想让它重新学一遍
        const clearBtn = $('btnClearDownloadStats');
        if (clearBtn) {
            clearBtn.addEventListener('click', async function () {
                await save('downloadStats', {});
                config = JTConfig.get();
                renderDownloadStats();
                setStatus('已清空下载记录', 'ok');
            });
        }
    }

    /** 渲染下载统计 */
    function renderDownloadStats() {
        const el = $('downloadStatsSummary');
        if (!el) return;

        const stats = (config && config.downloadStats) || {};
        const hosts = Object.keys(stats);

        if (hosts.length === 0) {
            el.textContent = '（还没有记录）';
            return;
        }

        // 只列有失败记录的，那是会影响路径选择的
        const withFail = hosts.filter(function (h) { return (stats[h].fail || 0) > 0; });
        const skipped = withFail.filter(function (h) {
            return (stats[h].ok || 0) === 0 && (stats[h].fail || 0) >= 2;
        });

        let text = hosts.length + ' 个域名';
        if (withFail.length > 0) text += '，其中 ' + withFail.length + ' 个有过失败';
        if (skipped.length > 0) {
            text += '；' + skipped.length + ' 个已改为直接走页面身份（' +
                skipped.slice(0, 2).join('、') +
                (skipped.length > 2 ? ' 等' : '') + '）';
        }

        el.textContent = text;
    }

    /** 初始化失败时的回退处理 */
    function showInitError(e) {
        console.error('[鲸吞] 页面初始化失败:', e);

        try {
            const box = document.createElement('div');
            box.style.cssText =
                'padding:24px;text-align:center;color:#c0392b;' +
                'font:13px/1.6 system-ui,sans-serif';
            box.textContent =
                '页面初始化失败：' + ((e && e.message) || e) + '（按 F12 查看控制台）';

            const host = document.querySelector('main') ||
                document.querySelector('.wrap') ||
                document.querySelector('.container') ||
                document.body;

            if (host) {
                host.textContent = '';
                host.appendChild(box);
            }
        } catch (err) {
            // 回退处理再失败时只能报错
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            Promise.resolve(init()).catch(showInitError);
        });
    } else {
        Promise.resolve(init()).catch(showInitError);
    }
})();
