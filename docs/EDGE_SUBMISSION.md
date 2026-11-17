# 上架 Microsoft Edge 加载项商店

本指南对应 v1.0.0。按顺序执行即可。商店素材已放在 [`docs/store/`](store/)。

---

## 一、前置条件

| 项目 | 说明 |
|---|---|
| Edge 开发者账号 | 在 [Partner Center](https://partner.microsoft.com/) 注册（免费），需微软账户 |
| 扩展包 | 仓库 Release 里的 `jingtun-v1.0.0.zip`，或在本地用下方命令打包 |
| 商店素材 | 见 [`docs/store/`](store/)：3 张 1280×800 截图 + 1 张 440×280 促销图 |
| 隐私政策 URL | 需要一个**公网可访问**的链接（见第四节） |
| 支持 URL | GitHub Issues 地址 |
| 主页 URL | GitHub 仓库地址 |

---

## 二、打包扩展

扩展包要求 `manifest.json` 位于压缩包**根目录**。用仓库根目录执行：

```bash
# 方式一：直接用 CI 产物
#   下载 Release 的 jingtun-v1.0.0.zip 即可

# 方式二：本地打包（只打运行时文件，排除 tools/docs/node_modules）
zip -r jingtun-edge.zip \
  manifest.json \
  popup.html m3u8.html preview.html options.html manage.html \
  downloader.html offscreen.html install.html json.html \
  css js icons lib _locales LICENSES \
  LICENSE NOTICE.md THIRD_PARTY_LICENSES.md PRIVACY.md CHANGELOG.md
```

> 注意：不要包含 `tools/`、`docs/`、`node_modules/`、`.github/`。

---

## 三、Partner Center 提交步骤

1. 登录 [Partner Center](https://partner.microsoft.com/) → **Microsoft Edge** → **Create new extension**（新建扩展）。
2. 上传 `jingtun-edge.zip`。系统会自动读取 manifest 校验：
   - 名称、版本、权限、图标、描述。
3. 填写商店列表信息（内容见 [STORE_LISTING.md](STORE_LISTING.md) 第 3 节「详细描述」）。
4. 上传商店素材：
   - **Screenshots**：`docs/store/screenshot-1-popup.png`、`screenshot-2-detail.png`、`screenshot-3-options.png`（1280×800）。
   - **Promotional tile (small)**：`docs/store/promo-tile-440x280.png`。
5. 填写**隐私实践**（见 [STORE_LISTING.md](STORE_LISTING.md) 第 5 节）。
6. 选择**年龄分级**、**类别**（建议：效率 / 开发者工具）。
7. 填写**支持 URL**、**主页 URL**。
8. 提交审核。

---

## 四、隐私政策 URL

Edge 要求填写隐私政策链接。推荐做法：

- 使用 GitHub 仓库里的 [PRIVACY.md](https://github.com/newnju/jingtun/blob/main/PRIVACY.md)，
  通过 `https://github.com/newnju/jingtun/blob/main/PRIVACY.md` 访问。
- 或者启用 GitHub Pages / 自建一个静态页，内容为 PRIVACY.md。

> 若审核要求链接必须是「已发布」状态，建议用 GitHub Pages 托管一个 `privacy.html`。

---

## 五、各字段填写内容

### 1. 名称与简介

- **名称**：鲸吞（Whale Swallow）
- **简介**：嗅探并下载网页中你有权访问的 HLS / DASH / 直链媒体，本地解密与合并。

### 2. 详细描述

见 [README.md](../README.md) 的「功能」一节。

### 3. 隐私实践（Privacy practices）

- **是否收集数据**：否。
- **数据用途**：全部本地处理，用于识别、解析、下载、合并。
- **数据存储**：`chrome.storage.local` / `chrome.storage.session`，浏览器本地。
- **数据共享**：无。
- **认证信息**：不收集账号，不需要登录。

（完整表述见 [STORE_LISTING.md](STORE_LISTING.md) 第 5 节。）

### 4. 权限说明

逐项填写，见 [STORE_LISTING.md](STORE_LISTING.md) 第 4 节的表格。

### 5. 单一用途

见 [STORE_LISTING.md](STORE_LISTING.md) 第 2 节。

---

## 六、Edge 技术兼容性说明

Edge 基于 Chromium，本项目用到的 API 在 Edge 均可用：

| API | Edge 支持 | 备注 |
|---|---|---|
| `webRequest`（非阻塞） | ✅ | 仅观察请求，不拦截 |
| `declarativeNetRequest` | ✅ | 下载时补 Referer / Origin |
| `offscreen` | ✅ | Chromium 109+，Edge 同版本起支持 |
| `sidePanel` | ✅ | 使用 `chrome.sidePanel` |
| `downloads` | ✅ | 保存文件 |
| `commands` | ✅ | 快捷键 |
| `storage` | ✅ | 本地存储 |

> `minimum_chrome_version: "111"` 对应 Edge 111+，没问题。

---

## 七、审核风险与应对

| 风险 | 应对 |
|---|---|
| 下载器类扩展被以「便利盗版」拒绝 | 强调「仅下载用户有权访问的资源」；不提供 DRM 绕过；描述中不出现具体站点名 |
| `<all_urls>` + `webRequest` 被质疑权限过大 | 在权限说明里写清「仅本地观察请求，不上传」 |
| 隐私政策链接不可访问 | 用 GitHub Pages 托管，确保公网可访问 |
| 年龄分级不符 | 按「无限制内容」申请 |

---

## 八、审核周期

Edge 审核通常 1–5 个工作日。被拒时按审核意见修改后重新提交即可。