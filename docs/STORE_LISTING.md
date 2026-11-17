# 商店上架材料（审核友好版）

本文件用于 Edge / Chrome 商店提交。内容与实际行为一致，措辞按审核偏好调整：
避免「嗅探 / 注入 / 拦截 / 破解」等易触发误判的词，改用「识别 / 读取 / 本地处理」。
提交时按小节直接复制。

---

## 1. 基本信息

| 字段 | 内容 |
|---|---|
| 名称 | jingtun (Whale Swallow) |
| 简介（≤132 字符） | 识别并下载网页中你有权访问的音视频（HLS / DASH / 直链），本地解密、合并与转封装，全程不联网。 |
| 类别 | 效率工具 / 开发者工具 |
| 语言 | 中文（简体）、英文 |

---

## 2. 单一用途（Single purpose）

**中文：**

jingtun (Whale Swallow，中文名「鲸吞」) 是一款本地媒体处理工具，单一用途是：在用户浏览网页时，
识别页面中**用户有权访问**的音视频资源（HLS / DASH / 直链），并在本地完成下载、
解密、合并与转封装。所有处理均在本机进行，不联网、不上传、不收集数据。

**English:**

Whale Swallow is a local media-processing utility. Its single purpose is to
detect audio/video resources **the user is authorized to access** on pages they
visit (HLS / DASH / direct links) and to download, decrypt, merge and remux
them locally. All processing happens on the device — no network uploads, no
data collection.

---

## 3. 详细描述（可直接粘贴到商店）

**中文：**

鲸吞在你浏览网页时，帮你找到页面里正在播放的音视频，并保存到本地。

- **识别资源**：自动列出页面加载的音视频地址（m3u8、mpd、mp4、m4a 等）。
- **下载与合并**：分片并行下载，自动解密（AES-128），合并为单个文件。
- **本地转封装**：用内置的 FFmpeg（WebAssembly）把 TS 转成 MP4，无需联网。
- **直播录制**：对直播流（m3u8 无结束标记）可跟随录制，随时停止。
- **断点续传**：已下载的分片缓存在本地，中断后重跑只补缺失部分。

**隐私**：
- 不收集任何数据，无统计、无广告、无遥测。
- 所有处理在本机完成，不向任何服务器上传。
- 不申请 `cookies`、`history`、`bookmarks` 等与功能无关的权限。
- 不提供 DRM 绕过；对受保护内容会提示无法下载。

**English:**

Whale Swallow helps you find the audio/video playing on a page and save it locally.

- **Detect**: lists media URLs loaded by the page (m3u8, mpd, mp4, m4a, ...).
- **Download & merge**: parallel segment download, automatic AES-128 decryption,
  merged into a single file.
- **Local remux**: converts TS to MP4 with a bundled FFmpeg (WebAssembly) — no network.
- **Live recording**: follows live streams (m3u8 without an end marker); stop anytime.
- **Resume**: finished segments are cached locally; a rerun only fetches the missing ones.

**Privacy**
- No data collection — no analytics, no ads, no telemetry.
- All processing stays on your device; nothing is uploaded.
- Does not request `cookies`, `history`, `bookmarks` or other unrelated permissions.
- Does not circumvent DRM; protected content is reported as unavailable.

---

## 4. 权限说明（逐条填写）

| 权限 | 说明 |
|---|---|
| `webRequest` | 读取页面的网络请求以识别其中的音视频地址。仅在本机处理，不记录、不上传。 |
| `storage` | 在本地保存设置与资源列表。 |
| `downloads` | 保存用户主动选择的媒体到本地。 |
| `tabs` | 按标签页归类资源，并显示数量角标。 |
| `scripting` | 向当前页注入只读脚本，读取页面已加载的媒体信息。 |
| `webNavigation` | 感知页面切换，清理已失效的状态。 |
| `alarms` | 定期清理长期不活动的本地缓存。 |
| `offscreen` | 在后台文档中执行分片合并，避免影响页面性能。 |
| `declarativeNetRequest` | 下载时临时补充 Referer / Origin，用于通过站点的防盗链校验。 |
| `contextMenus` | 提供右键菜单入口。 |
| `sidePanel` | 支持在侧边栏中使用。 |
| `host_permissions: <all_urls>` | 识别任意站点的媒体需要此权限；扩展不在后台上传任何数据。 |

**未申请的权限**：`cookies`、`history`、`bookmarks`、`webRequestBlocking`、`tabs` 之外的历史类权限均未申请。

---

## 5. 隐私与数据（按商店表单逐项回答）

| 问题 | 回答 |
|---|---|
| 是否收集用户数据？ | **否。** 不收集任何个人信息或使用数据。 |
| 是否使用第三方分析/广告 SDK？ | **否。** |
| 数据是否离开设备？ | **否。** 全部本地处理。 |
| 是否使用远程代码（remote code）？ | **否。** 所有脚本随扩展打包，不从远程加载。 |
| 是否读取/修改页面内容？ | 仅读取页面已加载的媒体地址，用于展示和下载；不修改页面内容。 |
| 是否要求登录/账号？ | **否。** |
| 数据存储位置 | `chrome.storage.local` / `chrome.storage.session`（浏览器本地）。 |
| 数据共享 | 无。 |

**可选的外部连接（默认关闭，需用户主动填写并启用）：**

- MQTT 推送：连接用户自己填写的 broker。
- aria2：连接用户自己配置的本地 RPC。
- 发送到本地：向用户自己填写的地址发送。

以上三项默认关闭，扩展不预置任何服务器地址。

完整说明见 [PRIVACY.md](../PRIVACY.md)。

---

## 6. 远程代码声明（Remote code）

扩展的所有 JavaScript 均随扩展包分发，**不从远程加载任何代码**，不使用
`eval` / `new Function` 动态执行远程脚本。内置的 FFmpeg 核心以 WebAssembly
形式本地打包。

---

## 7. 合规声明

- 本扩展用于个人使用，功能是识别并下载**用户有权访问**的网络媒体资源。
- 使用者应自行确保其行为符合当地法律法规以及目标网站的服务条款。
- 不提供 DRM 绕过；对受 DRM 保护的内容会提示无法下载。
- 项目自身代码采用 MIT 许可证；内置 FFmpeg WASM 核心采用 LGPL-2.1-or-later，
  作为可替换组件单独分发，许可证全文随扩展分发。

---

## 8. 审核常见问题应答（Q&A）

**Q: 这个扩展是用来做什么的？**
A: 识别网页中正在播放的音视频并保存到本地，方便用户保存自己有权访问的内容（如自己的录播、课程回放、公开素材）。

**Q: 是否会绕过付费/DRM？**
A: 不会。检测到 DRM（Widevine / PlayReady）时会提示无法下载，不提供任何绕过手段。

**Q: 为什么需要 `<all_urls>`？**
A: 因为用户可能在任意网站观看视频，扩展需要在该页面识别媒体地址。所有处理在本地，不上传数据。

**Q: 为什么需要 `webRequest`？**
A: 用于读取页面已经发生的网络请求，从中识别音视频地址。仅观察，不拦截、不修改。

**Q: 是否收集数据？**
A: 不收集。无统计、无广告、无遥测，全部本地处理。

**Q: 是否会下载用户未授权的内容？**
A: 扩展只提供工具能力，下载哪些内容完全由用户决定；使用条款与版权责任由用户自行承担。

---

## 9. 提交前检查清单

- [ ] 扩展包 `manifest.json` 在根目录
- [ ] 版本号与商店填写一致（1.0.0）
- [ ] 图标 128×128 已上传
- [ ] 截图 1280×800 至少 1 张（`docs/store/` 有 3 张）
- [ ] 促销图 440×280（`docs/store/promo-tile-440x280.png`）
- [ ] 隐私政策 URL 公网可访问
- [ ] 支持 URL / 主页 URL 已填
- [ ] 权限说明已逐条填写（第 4 节）
- [ ] 数据收集问题已回答「否」（第 5 节）