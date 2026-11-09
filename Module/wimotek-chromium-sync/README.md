# wimotek-chromium-sync

[![PyPI version](https://img.shields.io/pypi/v/wimotek-chromium-sync.svg?style=flat-square)](https://pypi.org/project/wimotek-chromium-sync/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)

专为 Chromium / Chrome 设计的生产级会话与 Cookie 集群同步调度引擎。  
**专注于多节点凭据同步、差量指纹比对、域名清洗与 CDP Hub 4 种连接模式调度**。SSH 隧道逻辑已彻底解耦，委托由通用的独立模块 [`wimotek-ssh-tunnel`](https://github.com/wimotek/wimotek-ssh-tunnel) 统一承载。

---

## 🌟 核心工程特性

1. **全面对接 CDP Hub 4 种连接方式 (Hub Matrix)**：
   * 原生兼容 **1. 直连 (Direct)**、**2. wss直连 (WSS Direct)**、**3. wss反穿 (WSS Reverse)** 与 **4. ssh穿透 (SSH Tunnel)**。
   * 对于 SSH 穿透模式，无缝对接独立通用模块 `wimotek-ssh-tunnel`，本模块纯粹专注于同步业务，架构清晰解耦。
2. **高容错跳过与强化日志输出 (Resilient Skip & Enhanced Logging)**：
   * 单个节点离线、握手超时或异常时，**绝不抛出未捕获异常崩溃中断流程**。
   * 自动输出标准结构化告警日志：`⚠️ [SKIP] 节点 [节点名] 离线或连接异常 (URL)，自动跳过: <原因>`。
   * 执行结果包含 `nodes_synced`、`nodes_skipped` 与 `skips` 详细审计诊断列表。
   * **源节点离线明确通知并终止 (`⚠️ [SOURCE_OFFLINE]`)**：在单向 `sync` 广播模式下，若指定的数据源节点宕机或异常，引擎立即输出明确通知日志并直接终止流程（源节点下线无需继续后续同步），返回完整的跳过审计信息。
3. **域名白名单 / 黑名单过滤机制 (Domain Filter)**：
   * **`include_domains`**：仅提取与同步关键业务站点 Cookie（如 `['.google.com', '.github.com', '.twitter.com']`），剔除海量无关数据。
   * **`exclude_domains`**：过滤广告、埋点分析类垃圾 Cookie（如 `['doubleclick.net', 'google-analytics.com']`），保护从属端隐私与纯净度。
4. **会话级连接池复用 (Connection Pooling)**：
   * 原生支持异步与同步上下文管理器：`async with ChromiumSync(...) as syncer:`。
   * 在高频定时同步场景下，复用底层常驻 WebSocket CDP 会话，避免重复握手损耗。
5. **Cookie 指纹变更差量同步 (Diff / Delta Sync)**：
   * 默认开启 `diff=True`：比对目标端与待同步凭据的核心指纹 `(name, domain, path, value)`。
   * 仅对实质变更的 Cookie 执行落盘与热重载，避免无效 IO 读写，**大幅延长从属端 SSD 寿命**。
6. **全量纯函数工具方法开箱即用**：
   * 模块顶级导出 `merge_cookies`、`filter_cookies`、`compute_cookie_delta` 等独立纯函数工具。
7. **开箱即用的结构化审计日志与自动大小轮转 (Structured Audit Logging & Auto-Rotation)**：
   * **触发机制**：每次写入时自动检测目标文件大小，当达到阈值（默认 10MB / 10485760 字节）时，自动重命名归档为 `audit.jsonl.1`、`audit.jsonl.2` ... 并创建新的日志文件。
   * **自动淘汰**：超出保留上限（默认最多保留 5 个归档备份，即 `audit.jsonl.1` 至 `audit.jsonl.5`）的最旧日志会被自动剔除，从根源杜绝磁盘打满。
   * **JSON Lines 格式**：标准 JSONL 格式 (`.jsonl`)，便于 ELK、Loki、Splunk 或云端日志系统直接采集与追踪。

---

## 🌐 与 CDP Hub 端的对接规范 (4 种连接方式)

CDP Hub 在管理大规模分布式浏览器节点时，节点所处的网络拓扑各不相同。`wimotek-chromium-sync` 原生支持所有 4 种连接模式：

| 模式 | 连接方式 | 传输协议 | Hub 拓扑与工作机制 | 是否需要 SSH 隧道？ |
| :--- | :--- | :--- | :--- | :--- |
| **1. 直连** | Direct CDP | HTTP / TCP (`ws://`) | Hub 直接请求目标节点的 CDP 端口，如 `http://192.168.1.50:9222/json/list`。 | ❌ **不需要**（内网或直连端口互通） |
| **2. wss直连** | WSS Direct | WSS over TLS | Hub 经由公网反向代理或安全网关（如 `:8443`），支持传入鉴权 Header（如 `Bearer Token`）建立加密直连。 | ❌ **不需要**（公网 TLS 网关直通） |
| **3. wss反穿** | WSS Reverse | Reverse WebSocket | 边缘设备（如 NAT 后的移动端或无公网机器）主动出站向 Hub 的反向监听端点建立连接，Hub 从内存会话池中直接消费。 | ❌ **不需要**（端侧出站建立连接） |
| **4. ssh穿透** | **SSH Tunnel** | **Encrypted SSH (Port 22)** | 远程机器 Chrome 严格监听在 `127.0.0.1:9222` 且受安全组阻断。**委托独立通用库 `wimotek-ssh-tunnel`** 建立本地端口转发（`127.0.0.1:19222 -> remote:9222`）供同步引擎调用。 | ✅ **由独立库 `wimotek-ssh-tunnel` 承载** |

### Hub 端配置示例 (`nodes.json`)

```json
[
  {
    "id": "node-direct",
    "name": "本地开发/内网容器",
    "cdp_host": "192.168.1.100",
    "cdp_port": 9222
  },
  {
    "id": "node-wss-direct",
    "name": "海外云网关节点 (WSS直连)",
    "endpoint_url": "wss://gateway.cluster.internal:8443/devtools/browser/node-us-1",
    "headers": {
      "Authorization": "Bearer wimotek-secret-token"
    }
  },
  {
    "id": "node-wss-reverse",
    "name": "移动边缘设备 (WSS反穿)",
    "endpoint_url": "ws://127.0.0.1:9000/reverse/dev-phone-01"
  },
  {
    "id": "node-ssh-tunnel",
    "name": "生产私有主机 (SSH穿透)",
    "ssh_host": "10.200.1.50",
    "ssh_user": "root",
    "cdp_port": 9222,
    "tunnel_port": 19225
  }
]
```

---

## 🛡️ 强化日志输出与异常跳过机制

在生产级分布式批量同步时，网络抖动或单台节点死机会常态发生。`wimotek-chromium-sync` 具备强化的日志输出机制与跳过策略：

### 1. 节点离线自动跳过日志
当任何节点无法连通、握手超时或鉴权失败时，输出带有明显标志的警告日志并记录上下文：
```text
2026-11-07 07:46:11 [WARNING] ⚠️ [SKIP] 节点 [Node-US-West] 离线或连接异常 (http://10.200.1.20:19222)，自动跳过: Connection refused: 127.0.0.1:19222
2026-11-07 07:46:12 [WARNING] ⚠️ [SKIP] 节点 [Node-SG-Edge] 离线或连接异常 (wss://gateway:8443/...), 自动跳过: HTTP 401 Unauthorized
```

### 2. 单向同步源节点离线终止通知 (`⚠️ [SOURCE_OFFLINE]`)
在单向 `sync` 广播模式下，数据源节点是凭据基准。若指定的源节点离线或异常，没必要继续后续流程，调度器会打印明确错误通知并立即终止：
```text
2026-11-07 07:49:10 [ERROR] ⚠️ [SOURCE_OFFLINE] 单向同步指定的源节点 [Master-Node] (node-master) 离线或连接异常，无法提取基准凭据，同步流程终止。
```

### 3. 返回结构化审计指标
无论执行成功还是遇到故障，同步方法均返回结构化字典，供 Hub 控制台实时消费与告警统计：
```python
{
    "status": "success",                  # "success" (部分或全部成功) | "failed" (全部离线)
    "mode": "merge",                      # "merge" | "sync"
    "transferred_count": 14,              # 本次真正产生指纹变更并落盘的凭证数
    "diff_skipped_count": 86,             # 指纹一致、跳过重复写入保护磁盘的凭证数
    "source_total": 100,                  # 过滤后的业务总凭证数
    "target_total": 100,
    "nodes_synced": ["node-direct", "node-wss-direct"], # 成功同步的节点
    "nodes_skipped": ["node-ssh-tunnel"],               # 自动跳过的异常节点 ID
    "skips": [                            # 详细跳过事件记录
        {
            "id": "node-ssh-tunnel",
            "name": "生产私有主机 (SSH穿透)",
            "mode": "ssh_tunnel",
            "cdp_url": "http://127.0.0.1:19225",
            "reason": "Connection refused / ConnectTimeout"
        }
    ],
    "duration": 1.12,                     # 耗时（秒）
    "details": "全节点 Merge 成功: 写入 14 条凭证 (跳过异常节点: ['生产私有主机 (SSH穿透)'])",
    "error": None
}
```

---

## 📋 审计日志与开箱即用的自动大小轮转 (Auto-Rotation)

生产环境下长期运行多节点同步引擎，审计日志必须兼顾**追溯性**与**磁盘安全性**。`wimotek-chromium-sync` 内置了开箱即用的线程安全 JSON Lines (`.jsonl`) 审计日志记录器与自动大小轮转机制：

### 1. 工作原理与触发机制
* **触发机制 (Trigger Mechanism)**：每次写入审计事件前，自动检测主文件（默认 `audit.jsonl`）的体积大小。当写入后总大小达到阈值（默认 `10MB` / `10 * 1024 * 1024` 字节）时，自动将主日志重命名归档为 `audit.jsonl.1`、`audit.jsonl.2` ... 并初始化全新的 `audit.jsonl` 继续写入。
* **自动淘汰 (Auto-Eviction)**：严格控制归档保留数量（默认最多保留 `5` 个归档备份，即 `audit.jsonl.1` ~ `audit.jsonl.5`）。发生轮转时，超出上限的最旧归档（`audit.jsonl.5`）会被自动剔除删除，**从根源上杜绝磁盘打满或存储溢出风险**。
* **线程安全 (Thread Safety)**：内置全局排他锁，并发批量调度时写入不串行、保证每行均为标准合法的 JSON 对象。

### 2. 标准 JSON Lines 数据格式
每条日志独立成行，字段标准统一：
```json
{"timestamp": "2026-11-08T19:20:01.123Z", "level": "INFO", "event": "sync_start", "details": {"mode": "sync", "source": "node-master", "targets": ["node-worker-1", "node-worker-2"], "nodes": ["node-master", "node-worker-1", "node-worker-2"]}}
{"timestamp": "2026-11-08T19:20:01.345Z", "level": "INFO", "event": "node_connected", "details": {"node_id": "node-master", "name": "主控机", "mode": "direct", "cdp_url": "http://127.0.0.1:9222"}}
{"timestamp": "2026-11-08T19:20:01.450Z", "level": "WARNING", "event": "node_skipped", "details": {"node_id": "node-worker-2", "name": "从属机2", "mode": "ssh_tunnel", "cdp_url": "http://127.0.0.1:19223", "reason": "Connection refused"}}
{"timestamp": "2026-11-08T19:20:01.789Z", "level": "INFO", "event": "sync_finish", "details": {"status": "success", "mode": "sync", "source": "node-master", "transferred_count": 8, "diff_skipped_count": 92, "source_total": 100, "target_total": 100, "nodes_synced": ["node-worker-1"], "nodes_skipped": ["node-worker-2"], "duration": 0.67}}
```

### 3. 支持的核心审计事件 (Events)
| 事件名称 (`event`) | 级别 (`level`) | 触发时机与包含字段 |
| :--- | :--- | :--- |
| `sync_start` | `INFO` | 同步引擎启动，记录模式 `mode`、源节点 `source` 与参与节点列表 |
| `node_connected` | `INFO` | 节点成功接入并建立 CDP 会话 |
| `node_skipped` | `WARNING` | 节点离线、握手失败或异常跳过，记录详细错误原因 `reason` |
| `source_offline` | `ERROR` | 单向同步指定的源节点离线，记录终止通知 |
| `cookies_merged` | `INFO` | `merge` 模式下凭据汇总去重完成，记录原始数与融合数 |
| `sync_finish` | `INFO` | 同步成功完成，记录真正写入条数、差量跳过条数与耗时 |
| `sync_failed` | `ERROR` | 全部节点离线或源节点离线导致同步流程无法继续 |
| `sync_exception` | `ERROR` | 同步过程中发生未预期异常捕获 |

### 4. 审计日志配置示例
```python
from wimotek_chromium_sync import ChromiumSync, AuditLogger

syncer = ChromiumSync(
    nodes=[
        {"id": "master", "cdp_port": 9222},
        {"id": "slave", "cdp_port": 9223}
    ],
    # 审计日志与自动轮转设置 (全部内置合理默认值，开箱即用)
    audit_file="logs/chromium_sync_audit.jsonl", # 日志写入路径 (默认: "audit.jsonl")
    audit_max_bytes=10 * 1024 * 1024,           # 单文件最大容量，达到后轮转 (默认: 10MB)
    audit_backup_count=5,                       # 最多保留归档文件数 (默认: 5 个)
    audit_enabled=True                          # 是否开启审计日志 (默认: True)
)

# 执行同步 (自动记录审计日志并按需轮转)
report = syncer.run()

# 快速读取最近生成的结构化审计日志
recent_logs = syncer.get_audit_records(limit=20)
for entry in recent_logs:
    print(f"[{entry['timestamp']}] {entry['event']} -> {entry['details']}")

# 查看当前存在的所有归档日志文件
print("当前审计归档链:", syncer.get_audit_files())
# ['logs/chromium_sync_audit.jsonl', 'logs/chromium_sync_audit.jsonl.1', ...]
```

---

## 🚀 极简开发示例

### 1. Hub 多模式混合集群融合 (全节点最新凭证合并)
```python
import asyncio
from wimotek_chromium_sync import ChromiumSync

nodes = [
    # 模式 1: 直连
    {"id": "local", "name": "本机容器", "cdp_port": 9222},
    # 模式 2: WSS 直连 (带 Token)
    {
        "id": "hub-remote", 
        "name": "海外网关", 
        "endpoint_url": "wss://hub.domain.internal:8443/devtools/browser/abc",
        "headers": {"Authorization": "Bearer secret_token"}
    },
    # 模式 3: WSS 反穿
    {"id": "mobile-edge", "name": "反向移动端", "endpoint_url": "ws://127.0.0.1:9000/reverse/phone-1"},
    # 模式 4: SSH 穿透 (委托 wimotek-ssh-tunnel 管理端口映射)
    {"id": "private-srv", "name": "专网主机", "cdp_port": 19225}
]

syncer = ChromiumSync(
    nodes=nodes,
    mode="merge",
    include_domains=["google.com", "github.com"], # 仅同步核心业务站点
    exclude_domains=["doubleclick.net"],          # 剔除垃圾广告追踪
    diff=True,                                    # 开启差量指纹比对保护磁盘
    audit_file="audit.jsonl"                      # 开启结构化审计自动轮转
)

report = syncer.run()
print(f"同步完成状态: {report['status']}")
print(f"成功同步节点: {report['nodes_synced']}")
print(f"自动跳过异常节点: {report['nodes_skipped']}")
```

### 2. 结合独立 `wimotek-ssh-tunnel` 管理模式 4 隧道
```python
from wimotek_ssh_tunnel import SSHTunnelManager, TunnelConfig
from wimotek_chromium_sync import ChromiumSync

# 1. 由独立的 wimotek-ssh-tunnel 批量拉起 SSH 隧道映射
with SSHTunnelManager(start_port=19222) as tm:
    tm.add_tunnel(TunnelConfig(id="srv1", ssh_host="10.200.1.10", ssh_user="root"))
    active_ports = tm.start_all(skip_on_failure=True)
    # active_ports => {"srv1": 19222}

    # 2. 将映射后的端口送入 wimotek-chromium-sync 执行多端凭据同步
    syncer = ChromiumSync(
        nodes=[
            {"id": "local", "cdp_port": 9222},
            {"id": "srv1", "cdp_port": active_ports["srv1"]}
        ],
        mode="sync",
        source="local"
    )
    res = syncer.run()
    print("同步指标:", res)
```

---

## ⚙️ 核心参数与配置规范

### `ChromiumSync` 初始化参数

| 参数字段 | 类型 | 默认值 | 详细说明 |
| :--- | :--- | :--- | :--- |
| `nodes` | list | 必填 | 节点配置列表 (支持 `NodeConfig` 或 dict，适配 4 种连接模式) |
| `mode` | str | `'sync'` | 同步策略: `'merge'`(全端融合最新凭证) 或 `'sync'`(单源广播) |
| `include_domains` | list | `None` | **域名白名单**：仅同步关注的业务站点 Cookie (如 `['google.com']`) |
| `exclude_domains` | list | `None` | **域名黑名单**：排除广告/统计类 Cookie (如 `['doubleclick.net']`) |
| `diff` | bool | `True` | **指纹差量同步**：相同凭证跳过写入，避免频繁刷盘保护 SSD 寿命 |
| `source` | str | 第一个节点 | `'sync'` 模式下的基准源节点 ID (离线时打印错误通知并直接终止同步) |
| `targets` | list | 其余节点 | `'sync'` 模式下的目标节点 ID 列表 |
| `audit_file` | str | `'audit.jsonl'` | **审计日志文件路径** (支持相对或绝对路径) |
| `audit_max_bytes` | int | `10485760` (10MB) | **自动轮转阈值**：文件大小达到该字节数时触发归档 |
| `audit_backup_count` | int | `5` | **归档保留上限**：最多保留 5 个 `.1` ~ `.5` 归档备份，超出自动淘汰 |
| `audit_enabled` | bool | `True` | **开箱即用**：是否开启结构化审计日志记录 |
| `verbose` | bool | `True` | 是否输出详细控制台日志 (`⚠️ [SKIP]`, `⚠️ [SOURCE_OFFLINE]`) |

---

## 📚 模块导出接口一览 (`__all__`)

```python
from wimotek_chromium_sync import (
    ChromiumSync,         # 主集群调度器与连接池上下文
    NodeConfig,           # 统一节点配置数据模型 (支持 4 种 CDP 连接模式)
    merge_cookies,        # 多节点 Cookie 智能融合纯函数
    filter_cookies,       # 域名白名单/黑名单过滤纯函数
    compute_cookie_delta, # Cookie 指纹变更差量计算纯函数
    AuditLogger           # 开箱即用的 JSON Lines 审计日志与自动轮转器
)
```

---

## 📄 License

MIT License
