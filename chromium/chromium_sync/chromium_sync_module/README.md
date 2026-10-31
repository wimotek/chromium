# wimotek-chromium-sync

[![PyPI version](https://img.shields.io/pypi/v/wimotek-chromium-sync.svg?style=flat-square)](https://pypi.org/project/wimotek-chromium-sync/)
[![npm version](https://img.shields.io/npm/v/wimotek-chromium-sync.svg?style=flat-square)](https://www.npmjs.com/package/wimotek-chromium-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)

专为 Chromium / Chrome 设计的现代化会话与 Cookie 集群同步调度工具。

---

## 🌟 核心特性

* **统一节点模型 (1对1 / 1对多集群)**：采用纯粹现代的节点架构，同时支持 1对1 穿透与任意规模的 1对多 节点集群分发。
* **本地免密直连与全能 SSH 认证**：
  * **本地节点**：指定本地端口即可直接直连 CDP，免登录、免配置、零 SSH 开销。
  * **远程节点**：支持自定义 SSH 用户名 (`ssh_user`)、私钥认证 (`ssh_key_path` / `ssh_key_data`) 与密码认证 (`ssh_password`)。
  * **端口自愈防撞**：自动为各远程节点分配互不冲突的本地隧道映射端口，已存在的活跃隧道自动复用。
* **两类高效同步策略**：
  * **`merge` (全节点凭证智能融合)**：汇总所有在线节点的 Cookie，若存在同名/同域/同路径冲突，**无条件保留有效期最新（expires 更长）的记录**，同时融合 LocalStorage 状态并向集群节点广播热刷新。
  * **`sync` (单源广播同步)**：将指定源节点 (`source`) 的全部会话凭据镜像推送至一个或多个目标节点。
* **极简调用，免建数据库表**：
  * 代码层面提供 `get_cookies()`、`inspect()` 与 `get_summary_table()`，**仅需 1 行代码即可获取任何节点或全集群的 Cookie 列表与状态**。
  * 命令行提供 `--status` (ASCII 表格) 与 `--json` (标准 JSON 格式)，随取随用。

---

## 📦 安装

### Python 环境 (PyPI)
```bash
pip install wimotek-chromium-sync
playwright install chromium
```

### Node.js 环境 (npm)
```bash
npm install -g wimotek-chromium-sync
```

---

## 🚀 极简使用指南

### 1. Python 代码调用

#### (1) 1 行代码获取节点状态与 Cookie 详情 (无需数据库)
```python
from chromium_sync import ChromiumSync

syncer = ChromiumSync(nodes=[
    {"id": "local", "name": "本机容器", "cdp_port": 9222},
    {"id": "kr2", "name": "韩国节点", "ssh_host": "kr2.wimotek.com", "ssh_user": "root", "ssh_key_path": "~/.ssh/id_rsa", "cdp_port": 9222}
])

# 打印美观的终端状态表格
print(syncer.get_summary_table())

# 获取指定节点或全集群的 Cookie 明细列表 (无需创建外部数据库表)
all_cookies = syncer.get_cookies()          # {"local": [...], "kr2": [...]}
local_cookies = syncer.get_cookies("local") # 获取单个节点的 Cookie 列表
print(f"本地有效 Cookie 数: {len(local_cookies)}")
```

#### (2) 全节点 Cookie 智能 Merge (合并最新有效期)
```python
from chromium_sync import ChromiumSync

syncer = ChromiumSync(
    nodes=[
        {"id": "local", "cdp_port": 9223},
        {"id": "kr2", "ssh_host": "kr2.wimotek.com", "ssh_user": "root", "ssh_key_path": "~/.ssh/id_rsa", "cdp_port": 9222},
        {"id": "sg1", "ssh_host": "sg1.wimotek.com", "ssh_user": "ubuntu", "ssh_password": "YourPassword", "cdp_port": 9222}
    ],
    mode="merge"
)
syncer.run()
```

#### (3) 单源广播同步 (例如将本机状态推送到所有云端节点)
```python
from chromium_sync import ChromiumSync

syncer = ChromiumSync(
    nodes=[
        {"id": "local", "cdp_port": 9222},
        {"id": "node_a", "ssh_host": "10.0.0.1", "cdp_port": 9222},
        {"id": "node_b", "ssh_host": "10.0.0.2", "cdp_port": 9222}
    ],
    mode="sync",
    source="local"
)
syncer.run()
```

---

### 2. 命令行 (CLI) 快速执行

#### (1) 终端直接传入多个节点 (内联精简语法)
```bash
# 智能合并多节点最新 Cookie
chromium-sync \
  --node id=local,port=9223 \
  --node id=kr2,ssh=root@kr2.wimotek.com,port=9222,key=~/.ssh/id_rsa \
  --node id=sg1,ssh=ubuntu@sg1.wimotek.com,port=9222,pass=SecretPassword \
  --mode merge
```

#### (2) 仅查看状态与 Cookie 统计 (ASCII 报表)
```bash
chromium-sync \
  --node id=local,port=9223 \
  --node id=kr2,ssh=root@kr2.wimotek.com,port=9222,key=~/.ssh/id_rsa \
  --status
```
输出样例：
```text
==========================================================================================
节点 ID    | 节点名称       | 类型       | CDP端口/映射 | Cookie数   | 当前页面状态
------------------------------------------------------------------------------------------
local      | 本地容器       | 本地直连   | 9223         | 42 条      | [Google] https://google.com
kr2        | 韩国节点       | SSH远程    | 19222        | 38 条      | [GitHub] https://github.com
==========================================================================================
```

#### (3) 导出 Cookie 详情为 JSON (便于程序与定时脚本直接提取)
```bash
chromium-sync --config cluster.json --status --json > /tmp/cluster_cookies.json
```

#### (4) 使用 JSON 配置文件运行集群同步
准备配置文件 `cluster.json`：
```json
[
  { "id": "local", "name": "本地开发机", "cdp_port": 9222 },
  { "id": "sg1", "name": "新加坡服", "ssh_host": "sg.host.com", "ssh_user": "ubuntu", "ssh_key_path": "~/.ssh/id_rsa", "cdp_port": 9222 },
  { "id": "kr2", "name": "韩国服", "ssh_host": "kr.host.com", "ssh_user": "root", "ssh_password": "SafePassword123", "cdp_port": 9222 }
]
```
单源广播或合并：
```bash
# 合并所有节点最新有效凭据
chromium-sync --config cluster.json --mode merge

# 本地向所有云端广播
chromium-sync --config cluster.json --mode sync --source local
```

---

## ⚙️ 节点配置字段规范 (NodeConfig)

| 字段 | 类型 | 默认值 | 详细说明 |
| :--- | :--- | :--- | :--- |
| `id` | str | 必填 | 节点唯一标识符 (例如 `local`, `sg1`, `kr2`) |
| `name` | str | `id` | 节点显示名称 |
| `is_local` | bool | 自动识别 | 是否为本地节点 (不填 `ssh_host` 或填回环地址自动为 True，免密直连) |
| `cdp_host` | str | `127.0.0.1` | 节点 CDP 服务监听的主机地址 |
| `cdp_port` | int | `9222` | 节点暴露的 CDP 端口 |
| `ssh_host` | str | `None` | 远程服务器 IP 或主机名 (提供该字段时识别为远程 SSH 节点) |
| `ssh_port` | int | `22` | 远程服务器 SSH 端口 |
| `ssh_user` | str | `root` | 远程 SSH 用户名 |
| `ssh_key_path` | str | `None` | SSH 私钥文件路径 (例如 `~/.ssh/id_rsa`) |
| `ssh_key_data` | str | `None` | SSH 私钥内容字符串 |
| `ssh_password` | str | `None` | SSH 登录密码 (无外部依赖纯原生环境自动适配) |
| `tunnel_port` | int | 自动分配 | 本地用于映射隧道的端口 (集群环境下自动递增分配防冲突) |

---

## 🤖 定时任务配置示例 (Crontab)

配合 Linux Crontab，每天凌晨定时执行全节点凭证智能融合：
```bash
crontab -e
# 每天凌晨 3:00 自动融合多节点最新有效凭证并释放隧道
0 3 * * * /usr/local/bin/chromium-sync --config /etc/chromium/cluster.json --mode merge --auto-close >> /var/log/chromium_sync.log 2>&1
```

---

## 📄 License

MIT License
