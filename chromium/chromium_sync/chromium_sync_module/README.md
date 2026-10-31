# wimotek-chromium-sync

[![PyPI version](https://img.shields.io/pypi/v/wimotek-chromium-sync.svg?style=flat-square)](https://pypi.org/project/wimotek-chromium-sync/)
[![npm version](https://img.shields.io/npm/v/wimotek-chromium-sync.svg?style=flat-square)](https://www.npmjs.com/package/wimotek-chromium-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)

专为 Chromium / Chrome 设计的生产级会话与 Cookie 集群同步调度引擎。支持 1对1 与 1对多集群、域名白/黑名单过滤、会话级连接池复用、Cookie 指纹变更差量同步 (Diff Sync)、本地免密直连及 SSH 私钥文本(PEM)/路径与密码认证。

---

## 🌟 核心工程特性

1. **统一现代节点模型 (1对1 / 1对多集群)**：
   * 原生支持任意规模的节点集群管理与多隧道并发映射。
   * **本地节点免密直连**：配置本地端口即可直接直连 CDP 探针，跳过 SSH 隧道拉起。
2. **域名白名单 / 黑名单过滤机制 (Domain Filter)**：
   * **`include_domains`**：仅提取与同步关注的关键业务域名（如 `['.google.com', '.github.com', '.twitter.com']`），剔除海量无关噪音。
   * **`exclude_domains`**：自动过滤广告、统计追踪类垃圾 Cookie（如 `['doubleclick.net', 'google-analytics.com']`），大幅提升同步速率并防止从端污染。
3. **会话级连接池复用 (Connection Pooling)**：
   * 原生支持异步与同步上下文管理器：`async with ChromiumSync(...) as syncer:`。
   * 在高频周期调度、定时巡检场景下，复用底层常驻 WebSocket CDP 会话与 SSH 隧道，避免重复握手建立与销毁，消除网络与 CPU 抖动。
4. **Cookie 指纹变更差量同步 (Diff / Delta Sync)**：
   * 默认开启 `diff=True`：自动比对目标端与待同步 Cookie 的核心指纹 `(name, domain, path, value)`。
   * **仅对产生实质变动的凭据执行写入**，若完全一致则直接跳过，并避免无意义触发浏览器页面重载，**极大保护从属节点的磁盘与 SSD IO 寿命**。
5. **原生私钥内容 (PEM String) / 路径与密码认证**：
   * `ssh_key`: 原生支持**私钥 PEM 文本内容字符串**或**私钥文件绝对路径**，调用方无需配置环境变量中转。
   * `ssh_password`: 直接支持 SSH 密码认证，支持集群级默认凭证与单节点自定义。
6. **结构化执行指标返回 (Structured Return Dict)**：
   * 执行后返回包含 `status`、`transferred_count`、`diff_skipped_count`、`duration` 等度量指标的标准字典，Web 控制台可直接消费展示。
7. **全量纯函数工具方法开箱即用**：
   * 模块顶级导出 `merge_cookies`、`filter_cookies`、`compute_cookie_delta` 等独立纯函数工具，无需 CDP 环境亦可直接处理和计算 Cookie 差量。

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

### 1. 会话级连接池复用 (高频周期调度推荐)
使用 `async with` 上下文管理器常驻复用 CDP 连接与隧道，杜绝频繁断连与握手损耗：
```python
import asyncio
from chromium_sync import ChromiumSync

async def periodic_sync_task():
    # 进入上下文时自动预热连接池与隧道
    async with ChromiumSync(
        nodes=[
            {"id": "local", "cdp_port": 9222},
            {"id": "kr2", "ssh_host": "kr2.wimotek.com", "ssh_key": "~/.ssh/id_rsa", "cdp_port": 9222}
        ],
        mode="merge",
        include_domains=["google.com", "github.com"], # 仅同步核心业务域名
        diff=True                                     # 开启差量比对，保护磁盘
    ) as syncer:
        for round_idx in range(5):
            # 复用已建立的 WebSocket 会话执行热同步
            result = await syncer.sync_async()
            print(f"第 {round_idx + 1} 轮同步完成: 写入 {result['transferred_count']} 条, 跳过一致凭据 {result['diff_skipped_count']} 条")
            await asyncio.sleep(60)

asyncio.run(periodic_sync_task())
```

---

### 2. 域名过滤与差量同步 (Diff Sync)
```python
from chromium_sync import ChromiumSync

syncer = ChromiumSync(
    nodes=[
        {"id": "local", "cdp_port": 9223},
        {"id": "kr2", "ssh_host": "kr2.wimotek.com", "ssh_user": "root", "ssh_key": "~/.ssh/id_rsa", "cdp_port": 9222},
        {"id": "sg1", "ssh_host": "sg1.wimotek.com", "ssh_user": "ubuntu", "ssh_password": "YourPassword", "cdp_port": 9222}
    ],
    mode="merge",
    # 白名单：仅同步以下业务站点的 Cookie
    include_domains=["google.com", "twitter.com", "x.com", "github.com"],
    # 黑名单：过滤广告与追踪类 Cookie
    exclude_domains=["doubleclick.net", "google-analytics.com"],
    # 差量比对 (默认 True)
    diff=True
)

result = syncer.run()
print(result)
```
**结构化返回值示例**：
```python
{
    "status": "success",          # "success" | "failed"
    "mode": "merge",
    "transferred_count": 8,       # 本次真正变动并写入的 Cookie 数量
    "diff_skipped_count": 34,     # 指纹完全相同、跳过写入以保护磁盘的 Cookie 数量
    "source_total": 42,           # 过滤后的业务凭证总数
    "target_total": 42,
    "nodes_synced": ["local", "kr2", "sg1"],
    "duration": 0.85,             # 耗时（秒）
    "details": "全节点 Merge 成功: 融合并向 ['local', 'kr2', 'sg1'] 写入 8 条凭证 (跳过一致指纹 34 条)",
    "error": None
}
```

---

### 3. 轻量静态探针（无需实例化集群）
单点探测某个节点时，直接 1 行静态调用：
```python
from chromium_sync import ChromiumSync

# 1. 单点探测节点在线状态与页面信息
info = ChromiumSync.probe(port=9222)
print(info)
# {'online': True, 'cookie_count': 42, 'page_title': 'GitHub', 'page_url': 'https://github.com', ...}

# 2. 单点直接提取 Cookie (支持域名过滤)
cookies = ChromiumSync.get_cookies(port=9222, include_domains=["github.com"])

# 3. 单点写入 Cookie 并启用差量检测
ChromiumSync.set_cookies(cookies, port=9223, reload=True, diff=True)
```

---

### 4. 导出顶级独立纯函数工具
即使没有运行中的 CDP 浏览器，亦可使用顶级导出的纯函数对 Cookie 结构做离线处理：
```python
from chromium_sync import merge_cookies, filter_cookies, compute_cookie_delta

raw_cookies = [
    {"name": "token", "value": "val1", "domain": ".github.com", "path": "/", "expires": 1700000000},
    {"name": "_ad", "value": "track", "domain": ".doubleclick.net", "path": "/", "expires": 1700000000}
]

# 1. 独立过滤域名
filtered = filter_cookies(raw_cookies, include_domains=["github.com"])

# 2. 独立比对两组 Cookie 差量
delta, skipped = compute_cookie_delta(incoming_cookies=filtered, existing_cookies=[])

# 3. 多端 Cookie 离线融合 (优先保留最新过期时间)
merged = merge_cookies([[c1, c2], [c3]])
```

---

### 5. 命令行 (CLI) 快速执行

#### (1) 带域名过滤与差量比对的同步
```bash
chromium-sync \
  --config cluster.json \
  --include-domains google.com github.com twitter.com \
  --exclude-domains doubleclick.net google-analytics.com \
  --mode merge
```

#### (2) 仅查看过滤后的节点状态表格 (ASCII 报表)
```bash
chromium-sync \
  --config cluster.json \
  --include-domains google.com github.com \
  --status
```
输出样例：
```text
============================================================================================
节点 ID    | 节点名称       | 类型       | CDP端口/映射 | Cookie有效数 | 当前页面状态
--------------------------------------------------------------------------------------------
local      | 本地容器       | 本地直连   | 9223         | 18 条        | [GitHub] https://github.com
kr2        | 韩国生产服     | SSH远程    | 19222        | 16 条        | [Google] https://google.com
--------------------------------------------------------------------------------------------
过滤规则: [白名单: google.com, github.com]
============================================================================================
```

#### (3) 导出指标 JSON (供 CI/CD 或自动化运维捕获)
```bash
chromium-sync --config cluster.json --mode merge --json
```

#### (4) 命令行内联多节点语法
```bash
chromium-sync \
  --node id=local,port=9223 \
  --node id=kr2,ssh=root@kr2.wimotek.com,port=9222,key=~/.ssh/id_rsa \
  --node id=sg1,ssh=ubuntu@sg1.wimotek.com,port=9222,pass=SecretPassword \
  --mode merge
```

---

## ⚙️ 核心参数与配置规范

### `cluster.json` 配置文件结构
```json
[
  {
    "id": "local",
    "name": "本机容器",
    "cdp_port": 9222
  },
  {
    "id": "kr2",
    "name": "韩国服",
    "ssh_host": "kr2.wimotek.com",
    "ssh_port": 22,
    "ssh_user": "root",
    "ssh_key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
    "cdp_port": 9222
  },
  {
    "id": "sg1",
    "name": "新加坡服",
    "ssh_host": "sg1.wimotek.com",
    "ssh_user": "ubuntu",
    "ssh_password": "Password123",
    "cdp_port": 9222
  }
]
```

### `ChromiumSync` 初始化参数

| 参数字段 | 类型 | 默认值 | 详细说明 |
| :--- | :--- | :--- | :--- |
| `nodes` | list | 必填 | 节点配置列表 (支持 `NodeConfig` 或 dict) |
| `mode` | str | `'sync'` | 同步策略: `'merge'`(全端融合最新凭证) 或 `'sync'`(单源广播) |
| `include_domains` | list | `None` | **域名白名单**：仅同步匹配列表的 Cookie (如 `['google.com']`) |
| `exclude_domains` | list | `None` | **域名黑名单**：排除广告/统计类 Cookie (如 `['doubleclick.net']`) |
| `diff` | bool | `True` | **指纹差量同步**：相同凭据跳过写入，避免频繁刷盘并保护磁盘 IO |
| `source` | str | 第一个节点 | `'sync'` 模式下的源节点 ID |
| `targets` | list | 其余节点 | `'sync'` 模式下的目标节点 ID 列表 |
| `ssh_key` | str | `None` | 集群默认 SSH 私钥 (支持私钥文件绝对路径 或 私钥 PEM 文本内容) |
| `ssh_password` | str | `None` | 集群默认 SSH 密码认证 |
| `auto_close_tunnel` | bool | `False` | 任务完成后是否自动关闭创建的 SSH 隧道 |
| `verbose` | bool | `True` | 是否输出详细调度日志 |

---

## 📚 模块导出接口一览 (`__all__`)

```python
from chromium_sync import (
    ChromiumSync,         # 主集群调度器与连接池上下文
    NodeConfig,           # 统一节点配置数据类
    merge_cookies,        # 多节点 Cookie 智能融合纯函数
    filter_cookies,       # 域名白名单/黑名单过滤纯函数
    compute_cookie_delta  # Cookie 指纹变更差量计算纯函数
)
```

---

## 📄 License

MIT License
