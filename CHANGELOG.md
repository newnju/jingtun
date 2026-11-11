# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的
格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-11-11

### 新增

- 基于 Manifest V3 的 webRequest、页面注入和 MSE 捕获三层嗅探。
- HLS 与 DASH 清单解析、分片下载、AES-128 解密、断点重试和本地合并。
- 弹窗预览、独立解析页、管理页、侧边栏和右键菜单。
- 直链、直播、区域和 WebRTC 录制。
- 本地 FFmpeg WASM 转封装与音视频双轨合并。
- 可选 MQTT 推送、aria2 下载和本地 HTTP 推送。
- 资源判定规则、域名屏蔽、文件名模板、URL 重写和配置同步。

### 说明

- 项目自身代码使用 MIT 许可证。
- 内置 FFmpeg WASM 核心使用 LGPL-2.1-or-later，作为可替换组件单独分发。
- 不提供 DRM 绕过功能。
