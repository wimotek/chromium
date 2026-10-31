# wimotek-chromium-sync

[![PyPI version](https://img.shields.io/pypi/v/wimotek-chromium-sync.svg?style=flat-square)](https://pypi.org/project/wimotek-chromium-sync/)
[![npm version](https://img.shields.io/npm/v/wimotek-chromium-sync.svg?style=flat-square)](https://www.npmjs.com/package/wimotek-chromium-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)

专为 Chromium / Chrome 设计的通用会话与 Cookie 集群同步调度工具。支持 1对1 与 1对多集群、本地直连免密、SSH 私钥内容/文件与密码认证、Cookie 有效期智能融合（Merge）以及轻量静态探针。

---

## 🌟 核心工程特性

1. **统一现代节点模型 (1对1 / 1对多集群)**：
   * 原生支持任意规模的节点集群管理与多隧道并发映射。
   * **本地节点免密直连**：配置本地端口即可直接直连 CDP 探针，跳过 SSH 隧道拉起。

2. **原生私钥内容 (PEM String) / 路径与密码认证**：
   * `ssh_key`: 原生支持**私钥文本内容字符串**（如以 `-----BEGIN` 开头的 PEM 文本）或**私钥文件绝对路径**（如 `~/.ssh/id_rsa`），调用方无需配置繁琐的环境变量中转。
   * `ssh_password`: 直接支持 SSH 密码认证，支持集群级默认凭证与单节点重载。

3. **结构化执行指标返回 (Structured Return Dict)**：
   * `syncer.run()` 与 `await syncer.run_async()` 执行后返回标准指标字典，上层 Web 控制台可直接捕获迁移量、源端/目标端存量、耗时及明细，无需额外发送 CDP 探针度量。

4. **双驱动入口：原生异步协程 + 同步阻塞**：
   * 原生提供 `await syncer.run_async()` 与 `await syncer.inspect_async()`，适配 FastAPI、Tornado、aiohttp 等现代异步服务。
   * 同步环境直接调用 `syncer.run()`，开箱即用。

5. **暴露轻量静态探针工具方法 (无需实例化集群)**：
   * 提供单点工具函数：`ChromiumSync.get_cookies(port=9222)`、`ChromiumSync.set_cookies(cookies, port=9222)`、`ChromiumSync.probe(port=9222)`，单点探测仅需 1 行代码。

6. **全节点智能 Merge 算法**：
   * 汇总所有节点 Cookie，针对冲突项**优先保留有效期最新（expires 更长 / 最新持久凭证）的 Cookie**，并写回热刷新。

---

## 📦 安装

### Python (PyPI)
```bash
pip install wimotek-chromium-sync
playwright install chromium
```

### Node.js (npm)
```bash
npm install -g wimotek-chromium-sync
```

---

## 🚀 极简开发示例

### 1. 轻量静态探针工具（无需实例化集群）
单点探测某个节点时，直接 1 行静态调用：
```python
from chromium_sync import ChromiumSync

# 1. 单点探测节点在线状态与页面信息
info = ChromiumSync.probe(port=9222)
print(info)
# {'online': True, 'cookie_count': 42, 'page_title': 'GitHub', 'page_url': 'https://github.com', ...}

# 2. 单点直接提取 Cookie 列表
cookies = ChromiumSync.get_cookies(port=9222)

# 3. 单点直接批量写入 Cookie 并热刷新页面
ChromiumSync.set_cookies(cookies, port=9223, reload=True)
```

---

### 2. 现代多节点集群同步与结构化返回

#### (1) Python 同步调用 (同步脚本 / Celery 任务)
```python
from chromium_sync import ChromiumSync

syncer = ChromiumSync(
    nodes=[
        {"id": "local", "name": "本地容器", "cdp_port": 9223},
        {
            "id": "kr2",
            "name": "韩国生产服",
            "ssh_host": "kr2.wimotek.com",
            "ssh_user": "root",
            # 直接支持私钥文本内容 (PEM String) 或文件路径
            "ssh_key": "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIB...\n-----END RSA PRIVATE KEY-----",
            "cdp_port": 9222
        },
        {
            "id": "sg1",
            "name": "新加坡服",
            "ssh_host": "sg1.wimotek.com",
            "ssh_user": "ubuntu",
            # 直接支持密码认证
            "ssh_password": "YourStrongPassword123",
            "cdp_port": 9222
        }
    ],
    mode="merge"  # "merge" (合并最新凭据) 或 "sync" (单源广播)
)

# 执行同步并获取度量指标字典
result = syncer.run()
print(result)
```
**结构化返回值示例**：
```python
{
    "status": "success",          # "success" | "failed"
    "mode": "merge",              # 执行模式
    "transferred_count": 45,      # 实际迁移/融合生成的 Cookie 数量
    "source_total": 80,           # 源端/融合前凭证总数
    "target_total": 45,           # 目标端/融合后凭证总数
    "nodes_synced": ["local", "kr2", "sg1"], # 成功同步的节点列表
    "duration": 1.25,             # 耗时（秒）
    "details": "全节点 Merge 成功: 融合 45 条最新凭证至 ['本地容器', '韩国生产服', '新加坡服']",
    "error": None
}
```

#### (2) FastAPI / aiohttp 异步协程原生驱动
```python
from fastapi import FastAPI
from chromium_sync import ChromiumSync

app = FastAPI()

@app.post("/api/sync")
async def trigger_sync():
    syncer = ChromiumSync(
        nodes=[
            {"id": "local", "cdp_port": 9222},
            {"id": "cloud", "ssh_host": "remote.host.com", "ssh_key": "~/.ssh/id_rsa", "cdp_port": 9222}
        ],
        mode="merge"
    )
    # 原生 asyncio 协程，零线程切换开销，高并发性能极佳
    result = await syncer.run_async()
    return result
```

---

### 3. 命令行 CLI 执行

#### (1) 内联语法直接启动多节点 Merge
```bash
chromium-sync \
  --node id=local,port=9223 \
  --node id=kr2,ssh=root@kr2.wimotek.com,port=9222,key=~/.ssh/id_rsa \
  --node id=sg1,ssh=ubuntu@sg1.wimotek.com,port=9222,pass=SecretPass123 \
  --mode merge
```

#### (2) 仅查看节点状态与 Cookie 数量 (ASCII 表格)
```bash
chromium-sync --config cluster.json --status
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

#### (3) 导出 Cookie 详情或执行结果为 JSON
```bash
# 1. 导出所有节点及 Cookie 列表为 JSON
chromium-sync --config cluster.json --status --json > /tmp/cluster_data.json

# 2. 执行同步并将结构化指标以 JSON 打印 (方便 CI/CD 或流水线捕获)
chromium-sync --config cluster.json --mode merge --json
```

---

## ⚙️ 节点参数配置规范 (NodeConfig)

| 字段 | 类型 | 默认值 | 详细说明 |
| :--- | :--- | :--- | :--- |
| `id` | str | 必填 | 节点唯一标识符 (例如 `local`, `kr2`) |
| `name` | str | `id` | 节点显示名称 |
| `is_local` | bool | 自动识别 | 是否为本地节点 (不填 `ssh_host` 或填回环地址自动判定为本地，免密直连) |
| `cdp_host` | str | `127.0.0.1` | 节点 CDP 服务监听的主机地址 |
| `cdp_port` | int | `9222` | 节点暴露的 CDP 端口 |
| `ssh_host` | str | `None` | 远程服务器 IP 或主机名 (提供该字段时识别为远程 SSH 节点) |
| `ssh_port` | int | `22` | 远程服务器 SSH 端口 |
| `ssh_user` | str | `root` | 远程 SSH 用户名 |
| `ssh_key` | str | `None` | **SSH 私钥 (同时支持文件绝对路径 或 私钥 PEM 文本字符串)** |
| `ssh_password` | str | `None` | SSH 登录密码 (自动适配 `sshpass` 与原生 `SSH_ASKPASS`) |
| `tunnel_port` | int | 自动分配 | 本地用于映射隧道的端口 (多节点自动分配防冲突) |

---

## 📄 License

MIT License
