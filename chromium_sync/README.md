# wimotek-chromium-sync

[![PyPI version](https://img.shields.io/pypi/v/wimotek-chromium-sync.svg?style=flat-square)](https://pypi.org/project/wimotek-chromium-sync/)
[![npm version](https://img.shields.io/npm/v/wimotek-chromium-sync.svg?style=flat-square)](https://www.npmjs.com/package/wimotek-chromium-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)

专为 Chromium / Chrome 设计的通用会话与 Cookie 穿透热同步工具。
支持在本地容器与远程服务器容器之间双向热同步登录凭证（Cookie + LocalStorage），全端口可参数化自定义，内置智能流向识别与带心跳保活的 SSH 隧道自愈管理。
---

## 🌟 核心特性

* 全端口自由定义：本地容器端口、远程实际端口、本地隧道映射端口及 SSH 端口均可自由配置或通过环境变量覆盖。
* 智能双向流向探测 (auto)：连通后自动探测两端 Cookie 数量与页面状态，支持智能推荐、人工交互确认或全自动执行。
* 内置心跳保活隧道：内置 ServerAliveInterval=15 与端口占用检测，已存在则自动复用，不存在则自动拉起，绝不产生假死僵尸连接。
* 无 TTY 环境自适应：在 Linux Crontab 定时任务、无图形后台或 CI 流程中自动回退，不因无键盘输入而崩溃。
* 双生态支持：同时发布于 PyPI 与 npm，支持 Python 代码导入与命令行跨语言一键执行。

## 📦 安装

Python 环境 (PyPI)

```bash
pip install wimotek-chromium-sync
```

Node.js 环境 (npm)

```bash
npm install wimotek-chromium-sync 
```

##🚀 极简使用示例

### 1. Python 代码调用（仅需 3 行）

```python
from chromium_sync import ChromiumSync

自由定制两端的所有端口

syncer = ChromiumSync( remote_ssh="root@xx.xx.xx", # 远程 SSH 服务器
remote_ssh_port=22, # SSH 连接端口
local_cdp_port=16002, # 本地容器的 CDP 端口
remote_cdp_port=9222, # 远程容器的实际
CDP 端口 remote_tunnel_port=9222, # 本地用于接收隧道的端口
direction="auto", # 智能判断: 自动往缺少凭证的一端同步
timeout=15 # 倒计时等待秒数 (0 为秒执行) )

syncer.run() 
```

### 2. 命令行使用 (CLI 模式)

无论是通过 pip 安装还是 npm 安装，均可直接在终端中敲命令运行：

```bash

查看所有端口与流向选项

chromium-sync --help

自由指定各端口全自动推送 (0 秒等待)

chromium-sync 
--remote-ssh root@xx.xx.xx 
--ssh-port 22 
--local-port 9222 
--tunnel-port 9222 
--direction push 
--timeout 0 
```

##⚙️ 端口与参数对应说明

| 参数名称                 | 命令行选项          | 对应环境变量                      | 默认值                    | 详细说明                 |
| :------------------- | :------------- | :-------------------------- | :--------------------- | :------------------- |
| remote\_ssh          | \--remote-ssh  | CHROMIUM\_REMOTE\_SSH       | <root@xx.xx.xx> | 远程 SSH 连接主机          |
| remote\_ssh\_port    | \--ssh-port    | CHROMIUM\_SSH\_PORT         | 22                     | 远程服务器的 SSH 端口        |
| local\_cdp\_port     | \--local-port  | CHROMIUM\_LOCAL\_PORT       | 16002                   | 运行在本机的容器 CDP 端口      |
| remote\_cdp\_port    | \--remote-port | CHROMIUM\_REMOTE\_CDP\_PORT | 9222                   | 运行在远端服务器上的容器实际端口     |
| remote\_tunnel\_port | \--tunnel-port | CHROMIUM\_TUNNEL\_PORT      | 9222                   | SSH 隧道映射到本机的监听端口     |
| direction            | \--direction   | CHROMIUM\_DIRECTION         | push                   | 默认同步流向 (push 或 pull 或 auto) |
| timeout              | \--timeout     | CHROMIUM\_TIMEOUT           | 15                      | 倒计时交互等待秒数，0 为免打扰秒执行  |
| auto\_close\_tunnel  | \--auto-close  | \-                          | False                  | 任务完成后是否关闭创建的 SSH 隧道  |

##📄 License

MIT License
