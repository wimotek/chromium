# wimotek-ssh-tunnel

> **通用生产级 SSH 端口转发与隧道调度引擎 (Universal SSH Tunnel & Port Forwarding Engine)**  
> 纯通用工程设计，与 Chromium 彻底解耦，可穿透任意 TCP 服务 (默认适配 CDP 9222 / 19222 端口)。

[![PyPI version](https://img.shields.io/pypi/v/wimotek-ssh-tunnel.svg?style=flat-square)](https://pypi.org/project/wimotek-ssh-tunnel/)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-green.svg?style=flat-square)](LICENSE)
[![Python 3.8+](https://img.shields.io/badge/Python-3.8+-blue.svg?style=flat-square)](https://www.python.org/)

---

## 📖 模块设计初衷 (Background & Philosophy)

在分布式集群调度和跨机房作业场景下，许多目标服务（例如 CDP 调试端口 `9222`、数据库 `3306`、Redis `6379` 等）通常绑定在远程主机的 `127.0.0.1` 本地回环接口，受制于严格的安全组与防火墙，禁止在公网暴露端口。

**`wimotek-ssh-tunnel`** 从具体业务框架中**彻底解耦剥离**，作为**纯通用的 SSH 隧道调度库**：
- 🌟 **通用性**：不依赖任何浏览器框架或上层客户端，纯粹专注于 Linux/Unix 标准 SSH 端口转发通道生命周期；
- 🛡️ **异常跳过与容错 (Resilient Skip)**：集群批量映射时，单节点认证失败、网络断网不可达或端口超时，**自动跳过并输出结构化警告日志**，绝不中断其余正常节点；
- 🔑 **全形态凭证支持**：原生支持私钥 PEM 文本字符串（自动写入受限 0600 临时文件并安全销毁）、私钥文件绝对路径、以及 SSH 密码认证（自动注入环境并隔离）；
- 🔄 **端口自增与复用**：内置 `SSHTunnelManager`，支持 `19222` 起始的端口自增分发与死连接探测复用。

---

## 🚀 快速上手 (Python)

### 1. 安装 (Installation)
```bash
pip install wimotek-ssh-tunnel
```

### 2. 便捷单隧道穿透 (One-line Tunnel)
```python
from wimotek_ssh_tunnel import open_tunnel

# 建立远程 127.0.0.1:9222 到本地 127.0.0.1:19222 的安全穿透隧道
tunnel = open_tunnel(
    ssh_host="remote.server.internal",
    ssh_user="admin",
    ssh_password="password123",       # 或传入 ssh_key="~/.ssh/id_rsa" / PEM 字符串
    remote_port=9222,                  # 目标远端端口 (默认 9222)
    local_port=19222                   # 本地映射端口 (默认 19222)
)

print(f"隧道建立成功，现在可访问本地: 127.0.0.1:{tunnel.local_port}")

# 用完后安全销毁并释放端口
tunnel.stop()
```

### 3. 多隧道集群调度管理与异常自动跳过
```python
from wimotek_ssh_tunnel import SSHTunnelManager, TunnelConfig

# 使用上下文管理器批量调度多个远程节点
with SSHTunnelManager(start_port=19222) as tm:
    tm.add_tunnel(TunnelConfig(id="node-1", ssh_host="10.0.1.10", ssh_user="root"))
    tm.add_tunnel(TunnelConfig(id="node-fault", ssh_host="192.0.2.1", timeout_sec=2.0)) # 故障机器，将自动跳过
    tm.add_tunnel(TunnelConfig(id="node-2", ssh_host="10.0.1.20", ssh_user="ubuntu"))

    # 批量拉起隧道并跳过离线节点 (skip_on_failure=True)
    active_ports = tm.start_all(skip_on_failure=True)
    print("已成功映射的节点端口:", active_ports)
    print("被自动跳过的故障记录:", tm.skips)
```

---

## 🌐 配合 CDP Hub 4 种连接方式的职责划分

| 模式 | 连接方式 | 传输协议 | 是否需要 `wimotek-ssh-tunnel`？ | 为什么？ |
| :--- | :--- | :--- | :--- | :--- |
| **1. 直连** | Direct CDP | HTTP / WS (`ws://`) | ❌ **不需要** | 目标机器直接开放了 9222 端口，Hub 直接请求 `http://ip:9222/json/list`。 |
| **2. wss直连** | Direct Secure WSS | WSS over TLS | ❌ **不需要** | 直连反向代理的安全网关端口（如 8443），走标准 TLS 链路。 |
| **3. wss反穿** | Reverse WebSocket | Outbound Reverse WS | ❌ **不需要** | 边缘客户端主动向 Hub 建立连接池，Hub 无需主动往外穿透。 |
| **4. ssh穿透** | **SSH Port Forwarding** | **Encrypted SSH (Port 22)** | ✅ **由本模块全权负责** | 远端 Chrome 仅监听本地 `127.0.0.1:9222`，Hub 必须借助本模块建立隧道映射出安全本地端口。 |

---

## 📦 发布至 PyPI 与 npm
```bash
# Python (PyPI)
python3 -m pip install --upgrade build twine
python3 -m build
python3 -m twine upload dist/*
```
