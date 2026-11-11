# 隐私政策

最后更新：2026-11-11

鲸吞是一个在本地运行的 Chrome 扩展。它不包含统计、遥测、广告或远程配置
代码，也不向开发者运营的服务器发送数据。

## 扩展处理的数据

### 设置

设置保存在 `chrome.storage.local`，包括：

- 功能开关、界面选项、文件名模板、捕获上限；
- 域名屏蔽列表、资源判定规则、URL 重写规则；
- 可选服务的地址与凭据，例如 MQTT broker、用户名、密码、aria2 RPC
  地址与 token、本地推送地址与自定义请求头；
- 自定义 CSS 与 ffmpeg 参数。

如果用户主动开启“配置同步”，设置还会写入 `chrome.storage.sync`。该同步
由浏览器厂商提供，扩展不运营也不控制该服务。关闭同步或清除浏览器同步
数据即可删除这部分副本。

### 嗅探结果

扩展记录当前标签页中发现的资源地址、类型、大小、请求头和响应头等元数据。
这些数据优先保存在 `chrome.storage.session`，浏览器重启后清空；浏览器不
支持 session 存储时退回 `chrome.storage.local`。用户可以在弹窗、管理页或
设置页清空列表。

嗅探到的请求头可能包含 `Cookie`、`Authorization`、`Referer` 等敏感信息。
扩展仅在本地使用这些信息完成解析、播放和下载，不会把它们发送到开发者
服务器。

### 捕获与下载

MSE 捕获的数据保存在扩展内存中，导出时写入用户选择的本地文件。分片下载、
合并和 ffmpeg 转封装都在本地完成。下载的文件由浏览器或用户配置的 aria2
保存到本地磁盘。

## 网络访问

扩展会在以下情况发起网络请求：

- 访问用户当前浏览的网页，以及网页中的媒体、清单和分片地址；
- 在下载时向目标站点补充 `Referer`、`Origin` 等请求头；
- 用户启用“发送到本地”时，把选中的资源信息发送到用户填写的 HTTP 地址；
- 用户启用 MQTT 推送时，连接用户填写的 MQTT broker 并发布资源信息；
- 用户启用 aria2 时，把下载地址发送到用户填写的 aria2 JSON-RPC 地址。

上述可选服务默认关闭，地址和凭据由用户自行填写。扩展不会把数据发送到
这些服务之外的地方。用户应自行确认所连接服务的隐私政策与安全性。

## 第三方库

hls.js、mqtt.js、qrcode-generator 和 FFmpeg WebAssembly 核心都随扩展
本地打包，不从 CDN 加载。各库的许可证与版权声明见
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

## 权限

扩展申请的权限及用途见 [README.md](README.md#权限)。权限只用于实现对应
功能，不用于收集或出售数据。

## 数据保留与删除

- 在弹窗或管理页清空资源列表；
- 在设置页恢复默认设置；
- 在 Chrome 扩展管理页移除扩展，浏览器会删除扩展的本地存储；
- 如果开启过配置同步，还需要在浏览器同步设置中删除对应数据。

## 政策变更

如果数据处理方式发生实质变化，会更新本文件并在项目仓库中说明。继续使用
新版本即表示接受更新后的政策。

## English summary

Jingtun runs locally in Chrome. It has no analytics, telemetry, ads, or remote
configuration, and it does not send data to a developer-operated server.
Settings are stored in `chrome.storage.local`; optional Chrome Sync is
controlled by the browser vendor. Captured resource metadata is kept in
session storage where available. Optional local HTTP push, MQTT, and aria2
features are disabled by default and only contact endpoints configured by the
user. See the Chinese text above for the complete policy.
