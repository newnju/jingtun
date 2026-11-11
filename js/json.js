/** 鲸吞：JSON 查看器 */
(function () {
    'use strict';

    const els = {
        sourceHint: document.getElementById('sourceHint'),
        inputCard: document.getElementById('inputCard'),
        rawInput: document.getElementById('rawInput'),
        btnParseInput: document.getElementById('btnParseInput'),
        errorCard: document.getElementById('errorCard'),
        treeCard: document.getElementById('treeCard'),
        tree: document.getElementById('tree'),
        loadingCard: document.getElementById('loadingCard'),
        btnExpandAll: document.getElementById('btnExpandAll'),
        btnCollapseAll: document.getElementById('btnCollapseAll'),
        btnCopy: document.getElementById('btnCopy')
    };

    /** 当前解析出的数据 */
    let currentData = null;
    /** 当前展示的原始文本 */
    let currentText = '';

    // ============================================================
    // 剥离外层包装
    // ============================================================

    /**
     * 从一段文本里抽出 JSON 内容
     * @param {string} text
     * @returns {*} 解析结果；失败返回 null
     */
    function extractJson(text) {
        if (!text) return null;

        let s = String(text).trim();

        // 1. try { ... } catch(e) { ... }
        //    JSONP 回调最常见的包装
        const tryMatch = /^try\s*\{([\s\S]*)\}\s*catch\s*\([^)]*\)\s*\{[\s\S]*\}\s*;?\s*$/.exec(s);
        if (tryMatch) s = tryMatch[1].trim();

        // 2. 本身就是完整的 JSON
        if (isBalanced(s)) {
            const direct = JTUtils.jsonParse(s);
            if (direct !== null) return direct;
        }

        // 3. xxx = ({...}) 或 xxx = {...} 或 callback([...])
        let m = /=\s*\(?([\s\S]*?)\)?\s*;?\s*$/.exec(s);
        if (m) {
            const inner = m[1].trim();
            if (isBalanced(inner)) {
                const parsed = JTUtils.jsonParse(inner);
                if (parsed !== null) return parsed;
            }
        }

        // 4. 回退：从第一个 { 或 [ 截到最后一个 } 或 ]
        const first = s.search(/[[{]/);
        if (first !== -1) {
            const last = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
            if (last > first) {
                return JTUtils.jsonParse(s.slice(first, last + 1));
            }
        }

        return null;
    }

    /**
     * 判断字符串是不是一个完整的 JSON 对象/数组
     * @param {string} s
     * @returns {boolean}
     */
    function isBalanced(s) {
        if (!s) return false;

        const first = s[0];
        if (first !== '{' && first !== '[') return false;

        const last = s[s.length - 1];
        const pair = first === '{' ? '}' : ']';

        return last === pair;
    }

    // ============================================================
    // 树形渲染
    // ============================================================

    /** 媒体地址的特征：看起来像个能下载的链接 */
    const URLISH_RE = /^https?:\/\/.+/i;

    /**
     * 判断一个值是不是「值得高亮」的媒体地址
     * @param {*} value
     * @returns {boolean}
     */
    function isMediaUrl(value) {
        if (typeof value !== 'string') return false;
        if (!URLISH_RE.test(value)) return false;

        // 常见的媒体扩展名
        return /\.(m3u8|m3u|mpd|mp4|m4s|ts|flv|mkv|webm|mp3|m4a|aac|mov|avi)(\?|#|$)/i.test(value);
    }

    /**
     * 渲染一个节点
     * @param {string} key 键名（根节点为空）
     * @param {*} value
     * @param {number} depth
     * @returns {HTMLElement}
     */
    function buildNode(key, value, depth) {
        const row = document.createElement('div');
        row.className = 'node';
        row.style.paddingLeft = (depth * 16) + 'px';

        const isObject = value !== null && typeof value === 'object';
        const childCount = isObject ? Object.keys(value).length : 0;

        // --- 展开/折叠箭头 ---
        const toggle = document.createElement('span');
        toggle.className = 'toggle';

        if (isObject && childCount > 0) {
            toggle.textContent = '▸';
            toggle.title = '展开 / 折叠';
        }
        row.appendChild(toggle);

        // --- 键名 ---
        if (key !== '') {
            const keyEl = document.createElement('span');
            keyEl.className = 'key';
            keyEl.textContent = key;
            row.appendChild(keyEl);

            const colon = document.createElement('span');
            colon.className = 'punct';
            colon.textContent = ': ';
            row.appendChild(colon);
        }

        // --- 值 ---
        if (isObject) {
            const summary = document.createElement('span');
            summary.className = 'summary';
            summary.textContent = Array.isArray(value)
                ? '[' + childCount + ']'
                : '{' + childCount + '}';
            row.appendChild(summary);

            if (childCount > 0) {
                const children = document.createElement('div');
                children.className = 'children';
                children.hidden = true;

                // 深层节点延迟构建：第一次展开时才生成子树，
                // 避免大 JSON 一上来就建几千个 DOM 节点
                let built = false;

                toggle.addEventListener('click', function () {
                    if (!built) {
                        for (const k of Object.keys(value)) {
                            children.appendChild(buildNode(k, value[k], depth + 1));
                        }
                        built = true;
                    }

                    children.hidden = !children.hidden;
                    toggle.textContent = children.hidden ? '▸' : '▾';
                });

                row.appendChild(children);
            }
        } else {
            const valueEl = document.createElement('span');
            valueEl.className = 'value type-' + (value === null ? 'null' : typeof value);

            if (typeof value === 'string') {
                valueEl.textContent = '"' + value + '"';

                // 媒体地址高亮，帮用户一眼看到要找的东西
                if (isMediaUrl(value)) {
                    valueEl.classList.add('is-media');
                    valueEl.title = '看起来是个媒体地址，可右键复制';
                }
            } else {
                valueEl.textContent = String(value);
            }

            row.appendChild(valueEl);
        }

        return row;
    }

    /**
     * 渲染整棵树
     * @param {*} data
     */
    function renderTree(data) {
        els.tree.textContent = '';
        els.tree.appendChild(buildNode('', data, 0));

        // 第一层默认展开，否则用户进来看到的是一对花括号
        const root = els.tree.firstChild;
        if (root) {
            const toggle = root.querySelector('.toggle');
            const children = root.querySelector('.children');
            if (toggle && children) {
                // 根节点的内容已经构建好了（buildNode 里没延迟）
                // 这里需要手动触发一次构建
                toggle.click();
            }
        }
    }

    // ============================================================
    // 加载与展示
    // ============================================================

    function showError(message) {
        els.loadingCard.hidden = true;
        els.treeCard.hidden = true;
        els.errorCard.hidden = false;
        els.errorCard.textContent = message;
    }

    function showData(data, text) {
        currentData = data;
        currentText = text;

        els.loadingCard.hidden = true;
        els.errorCard.hidden = true;
        els.treeCard.hidden = false;

        renderTree(data);
    }

    /**
     * 加载一个地址
     * @param {string} url
     */
    async function load(url) {
        els.sourceHint.textContent = url.length > 60 ? url.slice(0, 60) + '…' : url;
        els.sourceHint.title = url;

        try {
            const response = await fetch(url, { credentials: 'include' });
            const text = await response.text();
            const data = extractJson(text);

            if (data === null) {
                showError(
                    '没能从返回内容里解析出 JSON。\n\n' +
                    '前 200 个字符：\n' + text.slice(0, 200)
                );
                return;
            }

            showData(data, text);
        } catch (e) {
            showError('加载失败：' + (e.message || e));
        }
    }

    // ============================================================
    // 交互
    // ============================================================

    if (els.btnParseInput) {
        els.btnParseInput.addEventListener('click', function () {
            const text = els.rawInput.value;
            const data = extractJson(text);

            if (data === null) {
                showError('没能解析出 JSON，请检查内容是否为有效的对象或数组');
                return;
            }

            els.sourceHint.textContent = '手动输入';
            showData(data, text);
        });
    }

    if (els.btnExpandAll) {
        els.btnExpandAll.addEventListener('click', function () {
            // 逐个点开未展开的箭头。深层节点是靠点击触发构建的，
            // 所以要多轮，每轮点开新生成的一层。
            for (let round = 0; round < 20; round++) {
                const closed = els.tree.querySelectorAll('.toggle');
                let clicked = 0;

                for (const t of closed) {
                    if (t.textContent === '▸') {
                        t.click();
                        clicked++;
                    }
                }

                if (clicked === 0) break;
            }
        });
    }

    if (els.btnCollapseAll) {
        els.btnCollapseAll.addEventListener('click', function () {
            const open = els.tree.querySelectorAll('.toggle');
            // 倒序折叠：从最深的开始，否则父节点折叠后子节点点不到
            for (let i = open.length - 1; i >= 0; i--) {
                if (open[i].textContent === '▾') open[i].click();
            }
        });
    }

    if (els.btnCopy) {
        els.btnCopy.addEventListener('click', function () {
            if (currentData === null) return;

            const text = JSON.stringify(currentData, null, 2);

            navigator.clipboard.writeText(text).then(function () {
                const original = els.btnCopy.textContent;
                els.btnCopy.textContent = '已复制';
                setTimeout(function () { els.btnCopy.textContent = original; }, 1200);
            }).catch(function () {
                // 剪贴板不可用时退回选中
            });
        });
    }

    // ============================================================
    // 启动
    // ============================================================

    const params = new URLSearchParams(location.search);
    const target = params.get('url');

    if (target) {
            Promise.resolve(load(target)).catch(showInitError);
    } else {
        els.loadingCard.hidden = true;
        els.inputCard.hidden = false;
        els.rawInput.focus();
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

})();
