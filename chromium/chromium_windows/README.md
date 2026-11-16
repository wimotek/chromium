# Wimotek Edge CDP Node (Windows 客户端)

一款专为 Windows 10/11 桌面环境打造的现代 **Windows 11 Fluent Design (`PySide6` + `PySide6-Fluent-Widgets`)** 边缘节点客户端，用于自动探测并拉起本机安装的 **Microsoft Edge / Google Chrome**（开启本地 `127.0.0.1:9222` CDP 调试接口），通过加密 **WSS 直连 (`public_wss`)** 或 **WSS 反向长连 (`reverse`)** 接入 `chromium_sync` Hub 网关，并提供 **本地边缘侧 Cookie 隐私防火墙 (`CookieGuard`)**。

---

## 核心特性

1. **现代 Windows 11 Fluent 桌面界面**
   - 基于 `PySide6` + `PySide6-Fluent-Widgets`（`FluentWindow` 深色主题、侧边栏导航、圆角设置卡片、Fluent Switch 开关、非阻塞 `InfoBar` 提示及 High-DPI 高分屏自动适配）。

2. **零 Docker 依赖，直接复用系统浏览器**
   - 自动通过 Windows 注册表 (`App Paths`) 与标准安装路径探测本机 `msedge.exe` / `chrome.exe`，亦支持手动指定自定义 Chromium 内核 `.exe` 路径。
   - 自动配置 `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1`。

3. **双方案 Profile 隔离与快捷预设（解决 Windows 自动关联本机微软账号问题）**
   - **为什么独立目录有时仍出现本机登录账号？** Windows 下 Microsoft Edge 默认开启系统账户隐式关联（`msImplicitSignin` / `msEdgeAccountConsistency`），且若你日常使用的个人浏览器已占用了 `127.0.0.1:9222` 端口，客户端会直接探测并复用已打开的个人浏览器会话。
   - **本机防串联增强**：客户端默认开启 **`阻止系统账户自动关联 (isolate_os_signin=true)`**（注入 `--disable-features=msImplicitSignin,msEdgeAccountConsistency,...` 与 `--disable-sync`），并在拉起浏览器前主动探测 `127.0.0.1:9222` 是否已被外部个人浏览器占用。
   - **界面内置两种一键组合方案预设（含动态隐私安全提示条）**：
     - **方案 A · `独立 Profile · 全量模式`（推荐）**：`profile_mode="isolated"` + `isolate_os_signin=true` + `CookieGuard="all"`。浏览器工作区完全独立，日常个人网银/邮箱绝不混入，无需折腾白名单即可安全全量同步。
     - **方案 B · `使用主机 Profile · 严格白名单`**：`profile_mode="system_default"` + `CookieGuard="whitelist"` + `protect_inject=true`。可直接复用本机已登录会话，切换时强制弹窗二次确认并提示 Chrome/Edge 136+ 默认目录限制；离开本机前由白名单严格截断，**未列入白名单的个人账号绝不上传**（若本节点用于 SaaS 共享市场出租给他人，严禁使用此模式）。

4. **双模加密 WSS 接入 Hub（支持公网 IP 与 DDNS 域名）**
   - **自动探测 (`auto`)**：先在本地启动自签名 TLS WSS 服务端（默认 `9443`，纯 Python `cryptography` 动态签发证书，无需系统安装 OpenSSL），采集或读取 **公网 IP / DDNS 域名**（配置域名时会自动解析 A/AAAA 记录供 Hub TCP 三次握手探测，探测通过后上报 `域名:端口` 并自动把域名写入自签名证书 SAN）；公网可达走 `public_wss`，处于家用宽带/NAT 后自动关闭本地监听并切换 `/api/nodes/reverse-tunnel` 出站反向长连。
   - **强制模式**：支持手动固定 `reverse_tunnel=true`（纯出站反向长连）或 `false`（直连入站），可分别配置本地监听端口 `edge_wss_port` 与路由器/防火墙外网映射端口 `edge_wss_external_port`。
   - **多路复用 CDP 隧道**：完整支持 `fetch_cookies`、`inject_cookies`、`get_version`、`fetch_bookmarks`、`bookmarks_sync` 与 `cdp_ws_open/frame/close` 远程调试控制。
   - **实时流量统计上报 (`metrics_report`)**：在 `public_wss` 直连与 `reverse` 反向长连双模式下均每 10 秒统计并上报隧道与 CDP 转发真实增量字节 (`net_rx_bytes` / `net_tx_bytes`) 及活跃调试流数 (`active_streams`)，并在桌面顶部实时展示累计 `RX / TX / 流`。

5. **Hub 云端联动收藏夹 (`Default/Bookmarks` 双向同步)**
   - **内置图形管理**：在「节点接入与 Hub」页面点击 **「联动收藏夹」** 即可搜索、添加、置顶 (`★`)、删除或一键拉取 Hub 云端收藏，点击条目自动使用受管 Edge/Chrome 打开。
   - **自动注入浏览器书签栏**：开启 `browser.sync_bookmarks`（默认开启）后，客户端自动把 Hub 收藏写入隔离或默认 Profile 的 `Default/Bookmarks` 书签栏 **`☁️ Hub 联动收藏`** 文件夹并计算标准 Chromium MD5 Checksum，完整保留用户自身其他书签；断网期间增删改自动入队，重连 Hub 后立即回放同步。

6. **本地边缘 Cookie 隐私防火墙 (`CookieGuard`) + 高危配置拦截**
   - 所有规则在 **Windows 本机内存** 立即拦截生效，敏感 Cookie 在离开本机网络前即被剔除，**不会上传到 Hub**。
   - 页面顶部与浏览器页联动展示 **实时隐私风险评估横幅**（绿/黄/橙/红四级提示）；若用户尝试保存 `system_default + all` 等极高危组合，界面会弹出不可忽略的二次确认警示。
   - 支持 4 种运行模式（支持运行中实时热更新）：
     - `whitelist`（**推荐默认 / 主机模式必选**）：严格白名单模式，仅放行明确列入白名单的域名（支持 `*.example.com`），其余网银/邮箱/内网会话全部本地拦截。
     - `blacklist`：黑名单屏蔽模式，内置常见银行/支付/邮箱/统计域名黑名单，并支持 `*bank*` 通配符与敏感 Cookie 名称屏蔽（如 `*token*`、`sessionid`）。
     - `all`：本地全量放行（建议仅在使用 `isolated` 独立 Profile 且开启 `isolate_os_signin` 时启用）。
     - `block_export`：禁止导出任何本地 Cookie，仅保留远程 CDP 控制与单向写入能力。
   - 内置 **「试算本地 Cookie 过滤结果」** 按钮：一键预演当前策略会放行/拦截哪些域名（仅统计数量与域名，日志与界面 **绝不打印任何 Cookie 明文 Value**）。

7. **清晰分级日志与审计持久化**
   - 界面支持按级别筛选（`ALL` / `GUARD` / `INFO` / `WARNING` / `ERROR`）。
   - 自动写入滚动日志文件：`%APPDATA%\WimotekEdgeNode\logs\agent.log`（单文件最大 5 MB，保留 3 份备份）。

---

## 为什么推荐「本地 CookieGuard + 独立 Profile」而不大改 Hub？

目前 Hub 端（`chromium_sync`）已具备全局域名白名单/黑名单过滤能力；如果在 Hub 侧强行增加复杂的多节点独立策略体系，会引入表结构升级、向后兼容与策略冲突问题，反而把系统做重。

采用 **双层防御 + 浏览器环境隔离** 是更简洁且更安全的最佳实践：
- **第 0 层（物理隔离）**：Windows 端默认以独立 `BrowserProfile` 启动 Edge/Chrome，日常网银、个人邮箱仍在你平时使用的默认浏览器配置中，压根不进入调试进程。
- **第 1 层（零信任本地防火墙 `CookieGuard`）**：即使工作浏览器打开了敏感站点，在响应 Hub 的 `fetch_cookies` 前，由 Windows 本机 `CookieGuard` 先按白名单/黑名单/名称规则裁剪掉无关 Cookie，敏感数据 **不出本机网卡**。
- **第 2 层（Hub 全局策略）**：继续沿用现有 `chromium_sync` 的全局黑白名单做二次兜底与跨节点分发，**Hub 无需任何代码改造即可直接兼容接入**。

---

## 快速使用

### 方式一：直接下载成品安装包 / 绿色版（推荐）
前往本仓库 **GitHub Releases**，可根据需要选择任意一种分发形态：

| 文件名 | 类型 | 特点 |
| :--- | :--- | :--- |
| **`WimotekEdgeNode-Setup-win64.exe`** | **标准 Windows 安装包**（推荐） | 基于 Inno Setup 制作，带开始菜单/桌面快捷方式与卸载程序；基于多文件目录安装，启动秒开且更少触发杀软误报 |
| **`WimotekEdgeNode-win64-portable.zip`** | **多文件绿色便携版** | 解压后直接双击 `WimotekEdgeNode.exe`，无需安装、无临时目录解包延迟，压缩包体积更小（含 `WimotekEdgeNode-cli.exe`） |
| **`WimotekEdgeNode-onefile.exe`** | **单文件直用版** | 仅一个 `.exe` 文件即可运行（约 55~75 MB），适合随手拷贝到其他电脑使用 |
| **`WimotekEdgeNode-cli.exe`** | **轻量无界面命令行版** | 不含 Qt 图形界面（约 12~15 MB），专用于 `--headless` 静默常驻或开机计划任务 |

首次启动 GUI 流程：
1. 在 **「节点接入与 Hub」** 中填写 `Hub 地址 (HUB_URL)` 与 `入网通行码 (JOIN_TOKEN)`，接入模式通常选 `auto`；若家宽有 DDNS 域名，可在 **「公网 IP / 域名 (可选)」** 直接填写域名。
2. 在 **「Cookie 隐私防火墙」** 中确认保护模式（推荐保持 `whitelist` 并填入需要同步的业务域名，例如 `github.com`、`*.openai.com`）。
3. 点击 **「启动浏览器并接入 Hub」**，客户端会自动拉起隔离版 Edge/Chrome 并开启 `127.0.0.1:9222` 完成入网登记。
4. 若 Hub 开启了 TOFU 节点审批，在 Hub 后台点击通过审批即可激活全量通信。

### 方式二：无界面模式 (`--headless`)
CLI 版支持指定自定义配置文件静默运行（不会加载 Qt 图形界面）：
```powershell
WimotekEdgeNode-cli.exe --headless --config C:\path\to\config.json
```

### 方式三：从源码运行或本地打包 EXE
环境要求：Windows 10/11 + Python 3.11+

```powershell
cd chromium\chromium_windows
pip install -r requirements.txt

# 直接源码启动 Fluent GUI
python main.py

# 或源码无界面运行
python main.py --headless --config config.example.json
```

本地使用 PyInstaller 打包单文件 EXE（剔除无用 QtWebEngine/QtQuick 等大型模块，体积约 55–75 MB）：
```powershell
pip install pyinstaller
pyinstaller --noconfirm --clean --onefile --windowed `
  --name WimotekEdgeNode `
  --paths chromium/chromium_windows `
  --collect-all qfluentwidgets `
  --exclude-module PySide6.QtWebEngineCore `
  --exclude-module PySide6.QtWebEngineWidgets `
  --exclude-module PySide6.QtQuick `
  --exclude-module PySide6.QtQml `
  chromium/chromium_windows/main.py
```

---

## 数据与日志目录

所有本机持久化文件默认保存在 Windows 当前用户目录下：
- 配置文件：`%APPDATA%\WimotekEdgeNode\config.json`
- 节点身份与密钥：`%APPDATA%\WimotekEdgeNode\identity.json`、`session_ticket.txt`
- 自签名 WSS 证书：`%APPDATA%\WimotekEdgeNode\certs\edge_wss.{crt,key}`
- 书签缓存与离线队列：`%APPDATA%\WimotekEdgeNode\bookmarks.json`、`pending_bookmark_ops.json`
- 运行审计日志：`%APPDATA%\WimotekEdgeNode\logs\agent.log`
- 隔离浏览器目录：`%LOCALAPPDATA%\WimotekEdgeNode\BrowserProfile`

---

## GitHub Actions 自动编译与发布 Release

仓库已配置自动化工作流 `.github/workflows/build-windows-node.yml`（运行于 `windows-latest`）：
- **提交即自动递增版本号发布 Release**：提交改动到 `chromium/chromium_windows/**` 时，Actions 会读取仓库现有 `win-v*` 标签并自动将补丁号 +1（例如 `win-v1.1.0` -> `win-v1.1.1`），同步写入安装包版本号并发布新 Release。
- **推送版本标签发布正式版**：推送以 `win-v` 开头的版本标签即可自动编译 EXE、生成 `SHA256SUMS.txt` 并发布对应版本 GitHub Release：
  ```bash
  git tag win-v1.0.0
  git push origin win-v1.0.0
  ```
- 也可在 GitHub 网页端 **Actions -> Build & Release Windows Edge CDP Node -> Run workflow** 手动触发，按需勾选发布 Release 并填写版本号。
