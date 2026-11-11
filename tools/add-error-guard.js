/** 给各页面补初始化错误处理 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 通用回退函数 */
const GUARD = `
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
`;

/** 要处理的页面脚本 */
const TARGETS = [
    { file: 'js/m3u8-ui.js', fn: 'init' },
    { file: 'js/preview.js', fn: 'init' },
    { file: 'js/options.js', fn: 'init' },
    { file: 'js/manage.js', fn: 'load' },
    { file: 'js/json.js', fn: null },          // 特殊：不是 init 形式
    { file: 'js/downloader-page.js', fn: null }
];

let changed = 0;

for (const target of TARGETS) {
    const full = path.join(ROOT, target.file);

    if (!fs.existsSync(full)) {
        console.log('跳过（不存在）: ' + target.file);
        continue;
    }

    let src = fs.readFileSync(full, 'utf8');

    if (src.indexOf('showInitError') !== -1) {
        console.log('已有回退: ' + target.file);
        continue;
    }

    const before = src;

    // 1. 插入回退函数（放在 IIFE 内、启动代码之前）
    //    找启动代码的位置作为锚点
    const startAnchor = src.lastIndexOf('if (document.readyState');
    const simpleAnchor = src.lastIndexOf('setInterval(load, 5000);');

    if (startAnchor !== -1) {
        src = src.slice(0, startAnchor) + GUARD.trim() + '\n\n    ' + src.slice(startAnchor);
    } else if (simpleAnchor !== -1) {
        src = src.slice(0, simpleAnchor) + GUARD.trim() + '\n\n    ' + src.slice(simpleAnchor);
    } else {
        // json.js / downloader-page.js：锚点是最后一段启动代码
        const tail = src.lastIndexOf('})();');
        if (tail === -1) {
            console.log('找不到插入点: ' + target.file);
            continue;
        }
        src = src.slice(0, tail) + GUARD.trim() + '\n\n' + src.slice(tail);
    }

    // 2. 给启动调用套上 catch
    src = src.replace(
        /if \(document\.readyState === 'loading'\) \{\s*\n\s*document\.addEventListener\('DOMContentLoaded', init\);\s*\n\s*\} else \{\s*\n\s*init\(\);\s*\n\s*\}/,
        "if (document.readyState === 'loading') {\n" +
        "        document.addEventListener('DOMContentLoaded', function () {\n" +
        "            Promise.resolve(init()).catch(showInitError);\n" +
        "        });\n" +
        "    } else {\n" +
        "        Promise.resolve(init()).catch(showInitError);\n" +
        "    }"
    );

    if (src === before) {
        console.log('未产生改动（可能启动代码形式不同）: ' + target.file);
        continue;
    }

    fs.writeFileSync(full, src);
    console.log('已加回退: ' + target.file);
    changed++;
}

console.log('\n共处理 ' + changed + ' 个文件');
