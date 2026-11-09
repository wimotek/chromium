# -*- coding: utf-8 -*-
"""
Xray Config Builder
严格区分 Reality 直连 与 WSS 反穿两种不同的 config.json 拓扑
"""
import copy
from typing import List, Dict, Any
from .config import AppConfig

def build_xray_config(
    net_mode: str,
    clients: List[Dict[str, Any]],
    private_key: str,
    short_id: str,
    port: int = 443,
    dest: str = "www.microsoft.com:443",
    server_names: List[str] = None,
    is_standalone: bool = False
) -> Dict[str, Any]:
    """
    根据运行模式 (direct vs reverse_wss) 组装精准的 Xray 原生配置
    """
    server_names = server_names or ["www.microsoft.com"]
    
    # 基础路由与出站规则
    base_config: Dict[str, Any] = {
        "log": {"loglevel": "warning"},
        "outbounds": [
            {"tag": "direct", "protocol": "freedom", "settings": {}},
            {"tag": "blocked", "protocol": "blackhole", "settings": {}}
        ],
        "routing": {
            "domainStrategy": "IPIfNonMatch",
            "rules": [
                {
                    "type": "field",
                    "ip": ["geoip:private"],
                    "outboundTag": "blocked"
                }
            ]
        }
    }

    # 非单机模式下添加 10085 内部统计 API 与 policy 级别统计
    if not is_standalone:
        base_config["stats"] = {}
        base_config["api"] = {"tag": "api", "services": ["StatsService"]}
        base_config["policy"] = {
            "levels": {
                "0": {
                    "statsUserUplink": True,
                    "statsUserDownlink": True
                }
            },
            "system": {
                "statsInboundUplink": True,
                "statsInboundDownlink": True
            }
        }
        # dokodemo-door inbound 仅供本地 127.0.0.1 统计采集
        api_inbound = {
            "tag": "api",
            "listen": "127.0.0.1",
            "port": AppConfig.STATS_PORT,
            "protocol": "dokodemo-door",
            "settings": {"address": "127.0.0.1"}
        }
        # 将 api 路由指向 api 出站
        base_config["outbounds"].append({"tag": "api", "protocol": "freedom", "settings": {}})
        base_config["routing"]["rules"].insert(0, {
            "type": "field",
            "inboundTag": ["api"],
            "outboundTag": "api"
        })
    else:
        api_inbound = None

    # =========================================================================
    # 模式 1：直连模式 (REALITY Inbound on 0.0.0.0:443)
    # =========================================================================
    if net_mode == "direct":
        business_inbound = {
            "tag": "vless-direct",
            "port": port,
            "protocol": "vless",
            "settings": {
                "clients": clients,
                "decryption": "none"
            },
            "streamSettings": {
                "network": "tcp",
                "security": "reality",
                "realitySettings": {
                    "show": False,
                    "dest": dest,
                    "xver": 0,
                    "serverNames": server_names,
                    "privateKey": private_key,
                    "shortIds": [short_id]
                }
            },
            "sniffing": {
                "enabled": True,
                "destOverride": ["http", "tls", "quic"],
                "routeOnly": True
            }
        }

    # =========================================================================
    # 模式 2：WSS 反穿模式 (Local Loopback on 127.0.0.1:10086)
    # 外部流量通过 Python WSS 反向隧道代理流入本地，Xray 绝不监听公网 443
    # =========================================================================
    else:
        # 在反穿模式下，Xray clients 不需要流控 flow: xtls-rprx-vision (因为外层是 WSS)
        cleaned_clients = []
        for c in clients:
            item = copy.deepcopy(c)
            item.pop("flow", None)  # 移除 vision flow
            cleaned_clients.append(item)

        business_inbound = {
            "tag": "vless-bridge",
            "listen": "127.0.0.1",
            "port": AppConfig.LOCAL_BRIDGE_PORT,
            "protocol": "vless",
            "settings": {
                "clients": cleaned_clients,
                "decryption": "none"
            },
            "streamSettings": {
                "network": "ws",
                "security": "none",
                "wsSettings": {
                    "path": "/internal/bridge"
                }
            },
            "sniffing": {
                "enabled": True,
                "destOverride": ["http", "tls"],
                "routeOnly": True
            }
        }

    inbounds = [business_inbound]
    if api_inbound:
        inbounds.insert(0, api_inbound)
        
    base_config["inbounds"] = inbounds
    return base_config
