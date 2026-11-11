/** 给缺 favicon 的页面补上 */
const fs = require('fs');

const TARGETS = ['m3u8.html', 'preview.html', 'downloader.html', 'install.html'];
const LINK = '    <link rel="icon" href="icons/icon32.png">\n';

let added = 0;
let skipped = 0;

for (const file of TARGETS) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        console.log('读不到: ' + file);
        continue;
    }

    if (text.indexOf('rel="icon"') !== -1) {
        console.log('已有: ' + file);
        skipped++;
        continue;
    }

    // 插在 </title> 之后，保持 head 内的自然顺序
    const match = text.match(/<\/title>\s*\n/);

    if (!match) {
        console.log('未找到 </title>: ' + file);
        continue;
    }

    text = text.replace(match[0], match[0] + LINK);
    fs.writeFileSync(file, text);
    console.log('已加: ' + file);
    added++;
}

console.log('\n新增 ' + added + ' 个，跳过 ' + skipped + ' 个');
