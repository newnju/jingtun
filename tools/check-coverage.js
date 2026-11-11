/** 覆盖率检查：哪些模块没被测到 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------
// 收集源文件
// ---------------------------------------------------------------

const sources = [];
(function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (f.endsWith('.js')) {
            sources.push(path.relative(ROOT, full).replace(/\\/g, '/'));
        }
    }
})(path.join(ROOT, 'js'));

// ---------------------------------------------------------------
// 收集测试脚本的内容
// ---------------------------------------------------------------

const TOOL_FILES = fs.readdirSync(path.join(ROOT, 'tools'))
    .filter((f) => f.endsWith('.js'));

/** 测试脚本的正文（用来查"有没有提到这个模块"） */
let testText = '';
/** 集成测试会真加载扩展，它们碰到的模块算"间接覆盖" */
let integrationText = '';

for (const f of TOOL_FILES) {
    const text = fs.readFileSync(path.join(ROOT, 'tools', f), 'utf8');

    if (/^test-/.test(f) || /^check/.test(f)) testText += text;

    // 集成测试（真启动浏览器）与预览生成器
    if (/test-(background|pages|behavior)/.test(f) || f === 'make-preview.js') {
        integrationText += text;
    }
}

// ---------------------------------------------------------------
// 逐个判断
// ---------------------------------------------------------------

const DIRECT = [];
const INDIRECT = [];
const NONE = [];

for (const src of sources) {
    const base = path.basename(src);
    const noExt = base.replace(/\.js$/, '');

    // 直接：测试里按文件名或模块名提到过
    const isDirect = testText.indexOf(base) !== -1 ||
        testText.indexOf("'" + noExt + "'") !== -1 ||
        testText.indexOf('"' + noExt + '"') !== -1 ||
        testText.indexOf(noExt + '.js') !== -1;

    if (isDirect) {
        DIRECT.push(src);
        continue;
    }

    // 间接：集成测试或预览生成器会加载它
    const isIndirect = integrationText.indexOf(base) !== -1 ||
        integrationText.indexOf(noExt) !== -1;

    if (isIndirect) {
        INDIRECT.push(src);
        continue;
    }

    NONE.push(src);
}

// ---------------------------------------------------------------
// 报告
// ---------------------------------------------------------------

console.log('== 覆盖率 ==');
console.log('  [v] 源文件 ' + sources.length + ' 个：直接 ' + DIRECT.length +
    ' / 间接 ' + INDIRECT.length + ' / 没测 ' + NONE.length);

if (NONE.length > 0) {
    console.log('  [!] 没有被任何测试碰过的：');
    NONE.forEach((f) => console.log('      ' + f));
}

// 有没测的算提醒，不算失败，有些文件确实不需要单独测
process.exit(0);
