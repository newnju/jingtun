# 第三方资源与许可说明

## 项目许可

本项目自身代码采用 MIT 许可证，全文见 [LICENSE](LICENSE)。

`lib/` 下包含的第三方库保留各自许可证。其中 FFmpeg WebAssembly 核心为
LGPL-2.1-or-later，单独作为可替换组件分发，不属于 MIT 代码。完整的组件
清单、版权声明和许可证全文见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
与 [LICENSES/](LICENSES/)。

## 参考项目

本项目的功能设计参考了 [cat-catch](https://github.com/xifangczy/cat-catch)
（GPL-3.0）的公开实现，主要包括：

- 三层嗅探结构：webRequest 拦截、内容脚本桥接、主世界注入。
- 资源判定思路：后缀、MIME、正则三类规则配合体积条件。
- 注入脚本的 hook 策略。
- MSE 捕获的实现方式，包括代理的方法、数据组织与容器头处理。
- 若干边界情况的处理方式。

本项目代码为独立编写，未复制 cat-catch 的源码。GPL-3.0 保护具体代码
表达，不保护算法与架构思路。本项目采用 MIT 许可证，与 cat-catch 的
许可证不冲突。

## 引入的第三方库

| 库 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| [hls.js](https://github.com/video-dev/hls.js) | 1.5.17 | Apache-2.0 | 弹窗与独立页面中的 HLS 播放 |
| [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) 核心 | 0.12.10 绑定，FFmpeg n5.1.4 | LGPL-2.1-or-later | 本地转封装与音视频合并 |
| [mqtt.js](https://github.com/mqttjs/MQTT.js) | 5.10.1 | MIT | MQTT 推送 |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 1.4.4 | MIT | 生成媒体地址二维码 |

说明：

- hls.js 仅用于播放。本项目的 m3u8 解析由 `js/m3u8.js` 自行实现。
- FFmpeg 核心用于在本机完成 TS 到 MP4 的转封装以及音视频双轨合并，不会
  向服务器上传数据。构建信息与源码地址见 [lib/ffmpeg/README.md](lib/ffmpeg/README.md)。
- mqtt.js 仅在用户开启 MQTT 推送时加载。
- qrcode-generator 用于把媒体地址转换为二维码。

各库的版权声明与许可证全文见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

## 未引入的库

以下库在 cat-catch 中使用，但本项目未引入：

| 库 | 许可证 | cat-catch 中的用途 | 本项目 |
|---|---|---|---|
| mpd-parser | Apache-2.0 | DASH 解析 | 自研 `js/mpd.js` |
| mux.js | Apache-2.0 | TS 到 fMP4 转封装 | 由 ffmpeg.wasm 完成 |
| StreamSaver.js | MIT | 大文件流式写盘 | 使用 File System Access API |
| jQuery | MIT | DOM 操作 | 使用原生 DOM API |
| jquery-qrcode | MIT | 二维码 | 使用 qrcode-generator |
| jquery.json-viewer | MIT | JSON 展示 | 自研 |

## 隐私

扩展不包含统计、遥测或广告代码，也不向开发者运营的服务器上传数据。
详细的本地存储、网络访问和可选推送说明见 [PRIVACY.md](PRIVACY.md)。

## 免责声明

本项目用于技术研究与个人使用，功能是嗅探并下载用户有权访问的网络媒体
资源。

使用者应自行确保其行为符合当地法律法规以及目标网站的服务条款。请勿
用于下载或传播受版权保护的内容。

对于受 DRM 保护的内容，本项目会提示无法下载。这是浏览器安全模型的
限制，不是实现缺陷。本项目不提供 DRM 绕过功能。

## 反馈

如认为本项目侵犯了您的权益，请通过项目仓库的 issue 联系。
