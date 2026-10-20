wimotek-chromium-sync

PyPI version npm version License: MIT

专为 Chromium / Chrome 设计的通用会话与 Cookie
穿透热同步工具。全端口可配置，支持在本地容器与远程服务器容器之间双向热同步登录凭证，支持按需拉起带心跳保活的 SSH 隧道。

📦 安装

Python 环境 (PyPI)

'''bash pip install wimotek-chromium-sync '''

Node.js 环境 (npm)

'''bash npm install wimotek-chromium-sync '''

🚀 极简使用示例

1. Python 代码调用（仅需 3 行）

'''python from chromium_sync import ChromiumSync

自由定制两端的所有端口

syncer = ChromiumSync( remote_ssh="root@kr2.wimotek.com", # 远程 SSH 服务器
remote_ssh_port=22, # SSH 连接端口 local_cdp_port=9223, # 本地容器的 CDP 端口
remote_cdp_port=9222, # 远程容器的实际 CDP 端口 remote_tunnel_port=9222, # 本地用于接收隧道的端口
direction="push", # 默认流向 (push: 本地->远程, pull: 远程->本地) timeout=5 # 倒计时等待秒数 (0
为秒执行) )

syncer.run() '''

2. 命令行使用 (CLI 模式)

无论是通过 pip 安装还是 npm 安装，均可直接在终端中敲命令运行：

'''bash

查看所有端口与流向选项

chromium-sync --help

自由指定各端口全自动推送 (0 秒等待)

chromium-sync 
--remote-ssh root@kr2.wimotek.com 
--ssh-port 22 
--local-port 9223 
--tunnel-port 9222 
--direction push 
--timeout 0 '''

⚙️ 端口与参数对应说明

| 参数名称                 | 命令行选项          | 对应环境变量                      | 默认值                    | 详细说明                 |
| :------------------- | :------------- | :-------------------------- | :--------------------- | :------------------- |
| remote\_ssh          | \--remote-ssh  | CHROMIUM\_REMOTE\_SSH       | <root@kr2.wimotek.com> | 远程 SSH 连接主机          |
| remote\_ssh\_port    | \--ssh-port    | CHROMIUM\_SSH\_PORT         | 22                     | 远程服务器的 SSH 端口        |
| local\_cdp\_port     | \--local-port  | CHROMIUM\_LOCAL\_PORT       | 9223                   | 运行在本机的容器 CDP 端口      |
| remote\_cdp\_port    | \--remote-port | CHROMIUM\_REMOTE\_CDP\_PORT | 9222                   | 运行在远端服务器上的容器实际端口     |
| remote\_tunnel\_port | \--tunnel-port | CHROMIUM\_TUNNEL\_PORT      | 9222                   | SSH 隧道映射到本机的监听端口     |
| direction            | \--direction   | CHROMIUM\_DIRECTION         | push                   | 默认同步流向 (push 或 pull) |
| timeout              | \--timeout     | CHROMIUM\_TIMEOUT           | 5                      | 倒计时交互等待秒数，0 为免打扰秒执行  |
| auto\_close\_tunnel  | \--auto-close  | \-                          | False                  | 任务完成后是否关闭创建的 SSH 隧道  |

📄 License

MIT License
