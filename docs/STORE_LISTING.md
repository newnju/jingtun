# Chrome Web Store 上架材料

本文件汇总上架所需的说明，供提交审核时直接取用。内容与实际行为保持一致，
不包含夸大或误导性描述。

---

## 1. 单一用途（Single purpose）

**中文：**

鲸吞是一款媒体资源嗅探与下载工具。它的单一用途是：帮助用户识别网页中
**其有权访问**的音视频资源（HLS / DASH / 直链），并在本地完成下载、解密与合并。

它不提供 DRM 绕过，不针对任何特定网站，不包含账号、广告或数据上报功能。

**English:**

Whale Swallow is a media sniffing and downloading utility. Its single purpose is
to help users identify audio/video resources on a web page **that they are
authorized to access** (HLS / DASH / direct links) and to download, decrypt and
merge them locally.

It does not circumvent DRM, does not target any specific site, and contains no
accounts, ads or data reporting.

---

## 2. 权限说明（Permission justifications）

| 权限 | 用途说明（提交时填写） |
|---|---|
| `webRequest` | 读取页面的网络请求，用于识别其中的音视频资源地址（仅本地处理，不上传）。 |
| `storage` | 在本地保存用户设置与嗅探到的资源列表。 |
| `downloads` | 把用户主动选择的媒体保存到本地。 |
| `tabs` | 按标签页归类资源，并在图标上显示数量角标。 |
| `scripting` | 向页面注入嗅探脚本，用于发现藏在接口响应里的媒体地址。 |
| `webNavigation` | 感知页面跳转，清理已失效的注入状态。 |
| `alarms` | 定期清理长期不活动的标签页缓存。 |
| `offscreen` | 在后台文档中执行分片合并，避免阻塞页面。 |
| `declarativeNetRequest` | 下载时临时补充 Referer / Origin，用于通过防盗链校验。 |
| `contextMenus` | 提供右键菜单入口。 |
| `sidePanel` | 支持在侧边栏中使用。 |
| `host_permissions: <all_urls>` | 嗅探需要覆盖用户访问的任意站点；扩展不在后台上传任何数据。 |
| `cookies`（**未申请**） | 扩展不申请 cookies 权限；需要 Cookie 的请求由浏览器凭据机制处理。 |

> 说明：扩展未申请 `history`、`bookmarks`、`webRequestBlocking`、`cookies`
> 等与功能无关的权限。

---

## 3. 隐私实践（Privacy practices）

**数据收集：** 不收集。扩展不包含统计、遥测、广告或崩溃上报代码，也不向
开发者或任何第三方服务器传输数据。

**数据使用：** 嗅探到的资源元数据（地址、请求头、大小）仅保存在浏览器本地
（`chrome.storage.session` / `chrome.storage.local`），用于展示、解析和下载。

**数据存储：** 设置保存在 `chrome.storage.local`；资源列表优先保存在
`chrome.storage.session`（浏览器重启后清空）。可选的配置同步使用浏览器提供的
`chrome.storage.sync`。

**数据共享：** 无。下载、合并、转封装全部在本机完成。

**可选的外部连接（默认关闭）：**

- **MQTT 推送**：仅在用户填写并启用后，连接用户自己指定的 broker。
- **aria2**：仅在用户启用后，连接用户自己指定的本地 RPC。
- **发送到本地**：仅在用户启用后，向用户自己填写的地址发送。

以上三项默认关闭，凭据与地址均由用户自行填写，扩展不预置任何服务器。

**敏感信息处理：** 嗅探到的 `Cookie`、`Authorization`、`Referer` 等请求头
仅在本地用于解析、播放和下载，不会写入日志或上传。

完整说明见 [PRIVACY.md](../PRIVACY.md)。

---

## 4. 合规声明

- 本项目用于技术研究与个人使用，功能是嗅探并下载**用户有权访问**的网络媒体资源。
- 使用者应自行确保其行为符合当地法律法规以及目标网站的服务条款。
- 本项目不提供 DRM 绕过功能；对受 DRM 保护的内容会提示无法下载。
- 项目自身代码采用 MIT 许可证；内置 FFmpeg WASM 核心采用 LGPL-2.1-or-later，
  作为可替换组件单独分发，许可证全文随扩展分发。

---

## 5. 商店信息字段建议

| 字段 | 建议内容 |
|---|---|
| 名称 | 鲸吞（Whale Swallow） |
| 简介 | 嗅探并下载网页中有权访问的 HLS / DASH / 直链媒体，本地解密与合并 |
| 详细描述 | 见 [README.md](../README.md) 的「功能」一节 |
| 类别 | 效率 / 开发者工具 |
| 主页 | 仓库地址 |
| 支持 | 仓库 Issues |
| 隐私政策 | [PRIVACY.md](../PRIVACY.md) 链接 |