# Chromium 分布式边缘节点与 Cookie 同步集群总览

本目录汇集了 **Wimotek Chromium 分布式 CDP 网关与 Cookie 同步集群** 的全部服务端与多平台边缘客户端实现，支持 **Docker (Linux 服务器)**、**Windows 桌面端** 与 **Android 移动端** 统一安全接入主控 Hub。

---

## 📦 各版本目录与文档导航

| 组件 / 平台 | 目录位置 | 接入与运行方式 | 说明文档 |
| :--- | :--- | :--- | :--- |
| **主控中心 Hub** | [`chromium_sync/`](./chromium_sync/) | FastAPI + Vue 3 (Docker 部署，默认端口 `8443`) | [查看 Hub 详细文档](./chromium_sync/README.md) |
| **Docker 节点 (noVNC 版)** | [`chromium_novnc/`](./chromium_novnc/) | Docker + TigerVNC (`6080`/`6443`) + 加密 WSS (`9443`) / 反向穿透 | [查看 Docker 节点文档](./chromium_novnc/README.md) |
| **Docker 节点 (KasmVNC 版)** | [`chromium_kasmvnc/`](./chromium_kasmvnc/) | Docker + KasmVNC 流媒体 (`6901`) + 加密 WSS (`9443`) / 反向穿透 | [查看 Docker 节点文档（含 KasmVNC）](./chromium_novnc/README.md) |
| **Windows 桌面客户端** | [`chromium_windows/`](./chromium_windows/) | PySide6 Fluent GUI + 复用本机 Edge/Chrome (`9222`) + 本地 Cookie 防火墙 | [查看 Windows 客户端文档](./chromium_windows/README.md) |
| **Android 移动客户端** | [`chromium_android/`](./chromium_android/) | Kotlin Compose + 内置工作浏览器 + WSS 反向长连（自动禁用第三方 API） | [查看 Android 客户端文档](./chromium_android/README.md) |
| **通用边缘与桌面配置** | [`common/`](./common/) | Docker 节点共用的轻量 WSS / 反向穿透脚本 (`edge_node_client.py`) 与定制 Openbox/tint2 桌面配置 (`desktop/`) | [查看脚本源码](./common/edge_node_client.py) |

---

## 🌐 全平台网络接入与安全策略对照

| 平台版本 | CDP 自动化操控 (Playwright / AI Agent) | WSS 接入模式 | 本地 Cookie 防火墙 (`CookieGuard`) | 第三方 API 默认权限 |
| :--- | :--- | :--- | :--- | :--- |
| **Linux Docker (`novnc` / `kasmvnc`)** | ✅ 完整支持 (`/cdp/{id}/ws`) | 智能双模（TCP 握手探测 `9443`，可达走 `public_wss`，否则回落 `reverse`） | 依赖 Hub 全局策略（黑白名单二选一） | 默认允许（可在 Hub 开关） |
| **Windows 桌面 (`chromium_windows`)** | ✅ 完整支持（隔离 Profile 复用系统 Edge/Chrome） | 智能双模（支持公网 IP / DDNS 域名探测与 `9443` 入站，不通转 `reverse`） | ✅ 本地内存拦截（白名单 / 黑名单 / 全量 / 禁导出） | 默认允许（可在 Hub 开关） |
| **Android 手机 (`chromium_android`)** | ❌ **不支持 / 默认禁用**（方案 A 无移动 CDP 服务） | **仅出站 WSS 反向长连**（适配蜂窝 CGNAT / 动态 IP / 省电保活） | ✅ 本地内存拦截（白名单 / 黑名单 / 全量 / 禁导出） | 🔒 **Hub 自动识别并锁定禁用（不可修改）** |

---

## 🔨 自动化构建与 Release 工作流

* **Windows 安装包 / 绿色压缩包 / 单文件 EXE**：[`.github/workflows/build-windows-node.yml`](../.github/workflows/build-windows-node.yml)（推送 `win-v*` 标签或手动运行发布 Release）
* **Android APK 安装包**：[`.github/workflows/build-android-node.yml`](../.github/workflows/build-android-node.yml)（推送 `android-v*` 标签或手动运行发布 Release）

---

## 🛡️ 全局 Cookie 同步规则提醒

在 Hub 端（[`chromium_sync`](./chromium_sync/README.md)）的 **全局 Cookie 过滤策略** 中，**「域名黑名单」与「域名白名单」采用互斥二选一规则**：
* 当 **黑名单（Exclude Domains）** 填有内容时，系统自动禁用白名单，仅按黑名单剔除敏感/广告域名；
* 当需要开启 **白名单（Include Domains）** 仅同步指定域名时，请先清空黑名单。
