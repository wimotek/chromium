# Wimotek Edge CDP Node (Android 客户端 · 方案 A)

免 Root 权限的 Android 原生工作浏览器与边缘 Cookie 同步客户端（Kotlin + Jetpack Compose Material 3）。内置独立 WebView 浏览器与 **本地 Cookie 隐私防火墙 (`CookieGuard`)**，通过 **WSS 反向长连 (`reverse-tunnel`)** 接入 `chromium_sync` Hub。

---

## 核心特性

1. **免 Root、象正常浏览器一样网页登录 / 扫码登录**
   - 内置完整 Android WebView 工作浏览器，支持地址栏输入、快捷站点跳转、前后端/桌面 UA 一键切换（方便渲染 PC 版微信/企业微信/微博扫码页）。
   - 支持拉起手机端 `weixin://`、`alipays://`、`intent://` 等 App 授权跳转登录。
   - **安全隔离**：运行在独立 App 沙盒中，手机系统默认 Chrome、银行 App 的数据完全不会混入同步池。

2. **自动识别为 Android 节点，默认锁定禁用第三方 API**
   - 握手自动上报 `X-Client-Type: android` 与 `"client_type": "android"`。
   - Hub 端自动识别并**强制锁定关闭该节点的第三方 API 接入权限 (`api_enabled=0`)且不可修改**：该手机节点**不会出现在 `/api/v1/nodes` 对外 API 列表中**，第三方脚本/AI Agent 无法通过 CDP 网关直接操控你的手机，仅用于 Hub 集群内安全 Cookie 同步。

3. **本地边缘 Cookie 防火墙 (`CookieGuard`)**
   - 在读取本机 WebView `CookieManager`（支持读取 `HttpOnly` 会话 Cookie）后、离开手机网络前先执行本机过滤：
     - `whitelist`（默认推荐）：严格白名单模式
     - `blacklist`：黑名单屏蔽模式
     - `all`：全量放行
     - `block_export`：禁止导出
   - 内置 **「试算过滤结果」**，日志与界面绝不输出任何 Cookie 明文 Value。

4. **Android 前台服务保活**
   - 使用 `FOREGROUND_SERVICE_DATA_SYNC` 保持 WSS 反向长连后台稳定（在切换去微信/支付宝扫码时不断连）。

---

## 构建与 GitHub Actions 发布

仓库已配置 `.github/workflows/build-android-node.yml`（运行于 `ubuntu-latest` + JDK 17 + Gradle 8.7）：
- 推送代码到 `chromium/chromium_android/**` 会自动构建 APK 并上传 Workflow Artifact。
- 推送 `android-v*` 标签（例如 `git tag android-v1.0.0 && git push origin android-v1.0.0`）或在 Actions 页面手动点击 `Run workflow` 即可自动编译 `WimotekEdgeNode-android.apk` 并发布到 **GitHub Release**。

本地构建命令（需 Android SDK 34 + JDK 17 + Gradle 8.7）：
```bash
cd chromium/chromium_android
gradle assembleRelease
```
输出 APK 路径：`app/build/outputs/apk/release/app-release.apk`（默认采用调试签名以便免密钥直接安装测试；正式分发可替换为自己的 Release Keystore）。
