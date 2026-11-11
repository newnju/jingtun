/** 回归测试：覆盖曾经出现过的问题 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
    if (cond) {
        passed++;
        console.log('  [v] ' + name);
    } else {
        failed++;
        console.log('  [x] ' + name + (detail ? '\n        → ' + detail : ''));
    }
}

const popupJs = read('js/popup.js');
const popupHtml = read('popup.html');
const popupCss = read('css/popup.css');
const bgJs = read('js/background.js');
const manifest = JSON.parse(read('manifest.json'));

// ============================================================
console.log('=== 回归 1：弹窗空白（els 漏成员）===');
// 原因：加了按钮和事件绑定，忘了把元素加进 els 对象。
// els.btnXxx 是 undefined，调用 addEventListener 时抛错，
// init 中断，后面的 loadData 不再执行，页面显示空白。
// 静态检查没有覆盖 $('btnXxx')，id 检查也没有发现。
// ============================================================

(function () {
    const start = popupJs.indexOf('const els = {');
    const end = popupJs.indexOf('};', start);
    const block = popupJs.slice(start, end);

    const defined = new Set();
    for (const m of block.matchAll(/^\s+(\w+)\s*:/gm)) defined.add(m[1]);

    const used = new Set();
    for (const m of popupJs.matchAll(/\bels\.(\w+)/g)) used.add(m[1]);

    const undef = [...used].filter((k) => !defined.has(k));
    check('没有「用了但没定义」的 els 成员', undef.length === 0, undef.join(', '));

    // 反向：定义了但 HTML 里没这个 id（死引用）
    const htmlIds = new Set([...popupHtml.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
    const dead = [];
    for (const m of block.matchAll(/^\s+(\w+):\s*\$\('([\w-]+)'\)/gm)) {
        if (!htmlIds.has(m[2])) dead.push(m[1] + '→#' + m[2]);
    }
    check('没有死引用（els 有但 HTML 没有）', dead.length === 0, dead.join(', '));
})();

// ============================================================
console.log('\n=== 回归 2：内嵌播放器永远挂不上（DOM 时序）===');
// 原因：detail.appendChild(player) 之后立刻 attachInlinePlayer，
// 而那个函数里有 `if (!player.isConnected) return` 的守卫，
// 元素还在内存里没进文档，守卫每次都拦下，播放器永远挂不上。
// ============================================================

(function () {
    check(
        '播放器是「先入队、列表进 DOM 后统一挂载」',
        /pendingPlayers\.push\(/.test(popupJs) &&
        /for \(const pending of pendingPlayers\)/.test(popupJs),
        '直接调用 attachInlinePlayer 会被 isConnected 守卫拦下'
    );

    check(
        'render 开头清空了待挂载队列',
        /pendingPlayers\.length = 0;/.test(popupJs)
    );

    check(
        'render 末尾（列表已 append）才挂载',
        (function () {
            const iAppend = popupJs.indexOf('els.list.appendChild(fragment)');
            const iMount = popupJs.indexOf('for (const pending of pendingPlayers)');
            return iAppend !== -1 && iMount !== -1 && iMount > iAppend;
        })()
    );
})();

// ============================================================
console.log('\n=== 回归 3：点了复制图标就消失（textContent 顶掉 SVG）===');
// 原因：把文字按钮换成图标按钮后，
// handleCopy / handleDownload 里的 button.textContent = '已复制' 把内联 SVG 顶掉了；
// 而"恢复"时只能恢复成原来读到的空串，图标永久消失。
// ============================================================

(function () {
    check(
        '有统一的 flashButton（用 class 反馈）',
        /function flashButton\(/.test(popupJs)
    );

    check(
        '复制反馈区分了图标按钮与文字按钮',
        /classList\.contains\('icon-act'\)/.test(popupJs),
        '图标按钮不能改 textContent'
    );

    // 列表项的操作按钮不能出现 textContent 赋值
    const buildItem = popupJs.slice(
        popupJs.indexOf('function buildItem'),
        popupJs.indexOf('function removeItem')
    );
    check(
        '列表项里没有对操作按钮赋 textContent',
        !/Btn\.textContent\s*=/.test(buildItem)
    );
})();

// ============================================================
console.log('\n=== 回归 4：提示条关不掉（CSS 的 display 覆盖 hidden）===');
// 原因：JS 里 el.hidden = true 明明执行了，元素却关不掉。
// 根因是 CSS 里 `.drm-banner { display: flex }` 盖掉了
// 浏览器默认的 `[hidden] { display: none }`。
// 排查时盯着 JS 看了半天，问题在样式。
// ============================================================

(function () {
    const cssFiles = fs.readdirSync(path.join(ROOT, 'css')).filter((f) => f.endsWith('.css'));

    const missing = cssFiles.filter((f) => {
        const text = read('css/' + f);
        return !/\[hidden\][^{]*\{[^}]*display\s*:\s*none/.test(text);
    });

    check('每个样式表都有 [hidden] 保护规则', missing.length === 0, missing.join(', '));

    // 带 display 的元素用 hidden 控制会失效，但有保护规则就正常。
    const hasGuard = /\[hidden\][^{]*\{[^}]*display\s*:\s*none/.test(popupCss);

    if (hasGuard) {
        check('有 [hidden] 保护规则，带 display 的元素也能正确隐藏', true);
    } else {
        const risky = [];
        for (const m of popupHtml.matchAll(/class="([^"]+)"[^>]*\bhidden\b/g)) {
            for (const cls of m[1].split(/\s+/)) {
                if (!cls) continue;
                const re = new RegExp('\\.' + cls + '\\s*\\{[^}]*display\\s*:\\s*([a-z-]+)', 'i');
                const hit = popupCss.match(re);
                if (hit && hit[1] !== 'none') risky.push('.' + cls + ' display:' + hit[1]);
            }
        }
        check('没有「带 display 又用 hidden 且无保护规则」的元素', risky.length === 0, risky.join(', '));
    }
})();

// ============================================================
console.log('\n=== 回归 5：DRM 提示条反复弹回来（未保存用户关闭状态）===');
// 原因：handleDrmClose 只做了 hidden = true，没记标志；
// 而 media:add 事件每次都调 updateDrmBanner 把它重新显示。
// 页面一直产生资源，提示条就一次次弹回来，用户觉得"点了没用"。
// ============================================================

(function () {
    check('DRM 提示条有「已关闭」标志', /drmBannerClosed/.test(popupJs));
    check('密钥提示条有「已关闭」标志', /keyBannerClosed/.test(popupJs));

    // 关闭函数里必须置标志
    const closeDrm = popupJs.slice(
        popupJs.indexOf('function handleDrmClose'),
        popupJs.indexOf('function handleDrmClose') + 200
    );
    check('关闭 DRM 时置了标志', /drmBannerClosed\s*=\s*true/.test(closeDrm));

    // update 函数里必须检查
    const update = popupJs.slice(
        popupJs.indexOf('function updateDrmBanner'),
        popupJs.indexOf('function updateDrmBanner') + 400
    );
    check('显示前检查了标志', /drmBannerClosed/.test(update));
})();

// ============================================================
console.log('\n=== 回归 6：刷新后列表一直叠加（没清数据）===');
// 原因：onCommitted 里清了一堆缓存（captureReady / captureActive / capturedKeys），
// 唯独没清媒体列表，刷新后旧条目还在，新捕获的往后叠。
// ============================================================

(function () {
    const committed = bgJs.slice(
        bgJs.indexOf('webNavigation.onCommitted.addListener'),
        bgJs.indexOf('chrome.tabs.onUpdated')
    );

    check('导航时清了媒体列表', /JTStore\.remove\(/.test(committed));
    check('清空行为可配置', /autoClearOnNavigate/.test(committed));
    check(
        '排除了子框架与表单提交',
        /auto_subframe/.test(committed) && /form_submit/.test(committed),
        'iframe 内部跳转不算换页'
    );
})();

// ============================================================
console.log('\n=== 回归 7：消息断链（后台推了但没人收）===');
// 原因：后台注释写着"转给弹窗"，但 popup 里从来没监听
// webrtc:done / webrtc:state / media:key，
// WebRTC 录完用户看不到结果，密钥抓到了提示条也不更新。
// ============================================================

(function () {
    const listened = new Set();
    for (const m of popupJs.matchAll(/message\.type === '([^']+)'/g)) listened.add(m[1]);
    for (const m of popupJs.matchAll(/case\s+'([^']+)'\s*:/g)) listened.add(m[1]);

    for (const t of ['webrtc:done', 'webrtc:state', 'media:key']) {
        check('弹窗监听了 ' + t, listened.has(t));
    }
})();

// ============================================================
console.log('\n=== 回归 8：品牌区用 emoji 当 logo ===');
// 原因：install / downloader / manage 里用 emoji 当品牌图标。
// 各平台 emoji 长得不一样，和工具栏真图标对不上，看着像两个产品。
// ============================================================

(function () {
    const BRAND = /class="(mark|brand|logo|brand-icon|empty-icon)"/;
    const bad = [];

    for (const f of fs.readdirSync(ROOT)) {
        if (!f.endsWith('.html')) continue;
        const lines = read(f).split('\n');
        lines.forEach((line, i) => {
            if (BRAND.test(line) && /[\u{1F300}-\u{1FAFF}]/u.test(line)) {
                bad.push(f + ':' + (i + 1));
            }
        });
    }

    check('品牌区没有 emoji', bad.length === 0, bad.join(', '));
})();

// ============================================================
console.log('\n=== 回归 9：漏声明 sidePanel 权限 ===');
// 原因：代码里用了 chrome.sidePanel.setPanelBehavior，
// 但 manifest 的 permissions 里没有 sidePanel，功能静默失效。
// 更糟的是检查脚本的权限表里也没这一项，所以一路绿灯。
// ============================================================

(function () {
    const perms = new Set(manifest.permissions || []);

    // 代码里用到的扩展 API
    const API_PERM = {
        'chrome.sidePanel': 'sidePanel',
        'chrome.contextMenus': 'contextMenus',
        'chrome.declarativeNetRequest': 'declarativeNetRequest',
        'chrome.offscreen': 'offscreen',
        'chrome.webNavigation': 'webNavigation',
        'chrome.scripting': 'scripting',
        'chrome.downloads': 'downloads',
        'chrome.alarms': 'alarms',
        'chrome.webRequest': 'webRequest'
    };

    const allJs = [];
    (function walk(d) {
        for (const f of fs.readdirSync(d)) {
            const p = path.join(d, f);
            if (fs.statSync(p).isDirectory()) walk(p);
            else if (f.endsWith('.js')) allJs.push(p);
        }
    })(path.join(ROOT, 'js'));

    const combined = allJs
        .filter((p) => p.indexOf('inject') === -1)
        .map((p) => fs.readFileSync(p, 'utf8'))
        .join('\n');

    const missing = [];
    for (const [api, perm] of Object.entries(API_PERM)) {
        if (combined.indexOf(api) !== -1 && !perms.has(perm)) missing.push(perm);
    }

    check('用到的 API 都声明了权限', missing.length === 0, missing.join(', '));
})();

// ============================================================
console.log('\n=== 回归 10：iframe sandbox 用 removeAttribute 无效 ===');
// 原因：想解除 sandbox 限制，写了 removeAttribute('sandbox')。
// 但 sandbox 是 iframe 加载时生效的属性，
// 对已加载完的 iframe 摘掉它，限制并不会解除，必须克隆替换。
// ============================================================

(function () {
    const mse = read('js/inject/mse-capture.js');
    const fn = mse.slice(mse.indexOf('function stripIframeSandbox'), mse.indexOf('function stripIframeSandbox') + 2500);

    check('用了克隆替换', /cloneNode/.test(fn), 'removeAttribute 对已加载的 iframe 无效');
    check('监听了动态插入的 iframe', /MutationObserver/.test(fn));
})();

// ============================================================
console.log('\n=== 回归 11：Shadow DOM 被页面劫持 ===');
// 原因：只用 try-catch 保护，页面覆盖 Element.prototype.attachShadow
// 之后样式就全被污染了。正确做法是从未被修改的 iframe 里取原生方法。
// ============================================================

(function () {
    for (const f of ['js/inject/mse-capture.js', 'js/inject/webrtc.js']) {
        const src = read(f);
        check(f.split('/').pop() + ' 用了安全 Shadow DOM',
            /createSecureShadowRoot/.test(src) && /native code/.test(src));
    }
})();

// ============================================================
console.log('\n=== 回归 12：DRM 误报（探测被当成真用）===');
// 原因：在 requestMediaKeySystemAccess 被调用时就上报。
// 但有些播放器初始化时会挨个探测各种 DRM 支持情况，
// 即使用户看的是普通内容，全被误判成"受保护内容"。
// ============================================================

(function () {
    const ds = read('js/inject/deep-search.js');
    const hook = ds.slice(ds.indexOf('function hookEME'), ds.indexOf('function hookEME') + 1800);

    check('等 Promise 兑现才上报', /\.then\(/.test(hook),
        '调用时就上报会把"探测"误判成"真用"');
})();

// ============================================================
console.log('\n=== 回归 13：下载反馈把按钮变成"..."（图标被顶掉）===');
// 同回归 3，但发生在 handleDownload 里。
// ============================================================

(function () {
    const fn = popupJs.slice(
        popupJs.indexOf('async function handleDownload'),
        popupJs.indexOf('async function handleDownload') + 1200
    );

    check('下载反馈用 flashButton', /flashButton\(button/.test(fn));
    check('没有对按钮赋 textContent', !/button\.textContent\s*=/.test(fn));
})();

// ============================================================
console.log('\n=== 附加：列表项是图标按钮 ===');
// 从文字按钮改成图标是刻意的，三个文字按钮占掉半行。
// 一旦有人改回文字，上面几条反馈逻辑的假设也会跟着变。
// ============================================================

(function () {
    check('列表项用了 makeIconButton', /makeIconButton\(/.test(popupJs));
    check('图标是内联 SVG', /const ICONS = \{/.test(popupJs) && /<svg/.test(popupJs));
})();

// ============================================================

console.log('\n' + '='.repeat(46));
console.log(failed === 0
    ? '全部通过（' + passed + ' 项）'
    : '通过 ' + passed + ' 项，失败 ' + failed + ' 项');

process.exit(failed === 0 ? 0 : 1);
