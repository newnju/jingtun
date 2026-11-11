# 贡献指南

感谢你愿意改进鲸吞。提交代码前，请先阅读本文件和
[行为准则](CODE_OF_CONDUCT.md)。

## 开发环境

- Chrome 111 或更高版本，或其他 Chromium 浏览器。
- Node.js 18 或更高版本，用于运行检查和测试。
- 不需要构建步骤。修改源码后，在 `chrome://extensions/` 中点击扩展的
  “重新加载”按钮即可。

加载方式：

1. 打开 `chrome://extensions/`。
2. 开启开发者模式。
3. 点击“加载已解压的扩展程序”，选择项目根目录。

## 检查与测试

```bash
# 静态检查、单元测试和纯逻辑测试
npm test

# 额外验证 FFmpeg WASM 核心
npm run test:ffmpeg
npm run check:ffmpeg-license

# 完整测试，包括真实浏览器集成测试
npm run test:full
```

快速测试不需要安装任何 npm 依赖。完整测试需要 `playwright-core` 和
Chromium，可通过 `PLAYWRIGHT_CORE`、`CHROME_PATH` 指定路径；ffmpeg 与
ffprobe 可通过 `FFMPEG_PATH`、`FFPROBE_PATH` 指定。

集成测试会启动真实浏览器。请使用临时目录作为浏览器配置目录，不要把测试
产生的截图、下载文件或媒体分片提交到仓库。

## 代码风格

- 使用原生 JavaScript、HTML 和 CSS，不引入构建工具或前端框架。
- 保持现有文件的缩进、命名和注释风格。
- 新增逻辑尽量写成可测试的纯函数，并在 `tools/` 下补充测试。
- 不提交压缩后的业务代码；第三方库放在 `lib/`，并更新
  [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) 与 `LICENSES/`。
- 不提交真实 Cookie、Authorization、MQTT 密码、aria2 token、个人路径或
  受版权保护的媒体文件。
- 修改权限、网络行为或存储行为时，同步更新 [PRIVACY.md](PRIVACY.md) 和
  [README.md](README.md) 中的说明。

## 提交与拉取请求

- 一个拉取请求尽量只解决一个问题。
- 说明修改内容、测试方式和可能的影响。
- 涉及界面变化时，附上脱敏后的截图；不要包含第三方视频画面。
- 新增第三方代码前，先确认许可证兼容性，并在拉取请求中说明来源。
- 安全问题不要通过公开拉取请求或 issue 报告，请按 [SECURITY.md](SECURITY.md)
  的流程处理。

## 许可证

提交贡献即表示你同意以 MIT 许可证授权该贡献。第三方代码仍受其原始许可证
约束。项目不要求签署单独的贡献者许可协议。
