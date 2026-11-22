# -*- coding: utf-8 -*-
"""
Sing-box Config Builder (1.11 / 1.12+ 现代原生配置规范，零废弃告警)
支持：
1. direct 模式：
   - VLESS + REALITY + Vision (TCP)
   - Hysteria2 原生 UDP/QUIC (可选，默认开启，支持同端口 443/udp 或自定义 UDP 端口)
2. reverse_wss 模式：
   - 本地回环 127.0.0.1:10086 纯 TCP VLESS 入站，由 Python WSS 反向隧道桥接
3. 全协议统一用户级流量计费：
   - experimental.v2ray_api (127.0.0.1:10085) 同时精准统计 VLESS 与 Hysteria2 用户的上下行流量
"""
import os
from typing import List, Dict, Any, Tuple
from .config import AppConfig
from .net_detector import detect_listen_address


def _parse_dest_host_port(dest: str) -> Tuple[str, int]:
    raw = (dest or AppConfig.DEST).strip()
    if ":" in raw and not raw.endswith("]"):
        host, port_str = raw.rsplit(":", 1)
        try:
            return host.strip("[]") or AppConfig.get_first_server_name(), int(port_str)
        except ValueError:
            pass
    return raw.strip("[]") or AppConfig.get_first_server_name(), 443


def build_singbox_config(
    net_mode: str,
    clients: List[Dict[str, Any]],
    private_key: str,
    short_id: str,
    port: int = 443,
    dest: str = "",
    server_names: List[str] = None,
    is_standalone: bool = False,
    hy2_enabled: bool = True,
    hy2_port: int = 443,
    hy2_cert_path: str = "",
    hy2_key_path: str = "",
    hy2_masquerade: str = "",
    hy2_up_mbps: int = 0,
    hy2_down_mbps: int = 0,
    log_level: str = "",
    block_cn: bool = True,
) -> Dict[str, Any]:
    """根据运行模式 (direct vs reverse_wss) 组装现代 sing-box JSON 配置"""
    server_names = server_names or AppConfig.get_server_name_list()
    primary_sni = server_names[0] if server_names else AppConfig.get_first_server_name()
    dest_host, dest_port = _parse_dest_host_port(dest or AppConfig.DEST)
    listen_addr = detect_listen_address()

    # 统一组装 VLESS 用户与 Hysteria2 用户，使用相同的 name (email) 以对齐 v2ray_api 流量计费
    vless_users: List[Dict[str, Any]] = []
    hy2_users: List[Dict[str, Any]] = []
    stat_user_names: List[str] = []

    for c in clients or []:
        uid = str(c.get("id") or c.get("uuid") or "").strip()
        if not uid:
            continue
        email = str(c.get("email") or c.get("name") or uid).strip()
        if email not in stat_user_names:
            stat_user_names.append(email)

        vless_item: Dict[str, Any] = {
            "name": email,
            "uuid": uid,
        }
        if net_mode == "direct":
            vless_item["flow"] = str(c.get("flow") or "xtls-rprx-vision")
        vless_users.append(vless_item)

        hy2_users.append({
            "name": email,
            "password": uid,
        })

    inbounds: List[Dict[str, Any]] = []

    # =========================================================================
    # 模式 1：公网直连模式 (VLESS-REALITY TCP + 可选 Hysteria2 UDP)
    # =========================================================================
    if net_mode == "direct":
        vless_inbound: Dict[str, Any] = {
            "type": "vless",
            "tag": "vless-direct",
            "listen": listen_addr,
            "listen_port": int(port),
            "users": vless_users,
            "tls": {
                "enabled": True,
                "server_name": primary_sni,
                "reality": {
                    "enabled": True,
                    "handshake": {
                        "server": dest_host,
                        "server_port": dest_port,
                    },
                    "private_key": private_key,
                    "short_id": [short_id],
                },
            },
        }
        inbounds.append(vless_inbound)

        if hy2_enabled and int(hy2_port or 0) > 0 and hy2_cert_path and hy2_key_path:
            hy2_inbound: Dict[str, Any] = {
                "type": "hysteria2",
                "tag": "hysteria2-in",
                "listen": listen_addr,
                "listen_port": int(hy2_port),
                "users": hy2_users,
                "tls": {
                    "enabled": True,
                    "alpn": ["h3"],
                    "certificate_path": hy2_cert_path,
                    "key_path": hy2_key_path,
                },
            }
            if int(hy2_up_mbps or 0) > 0:
                hy2_inbound["up_mbps"] = int(hy2_up_mbps)
            if int(hy2_down_mbps or 0) > 0:
                hy2_inbound["down_mbps"] = int(hy2_down_mbps)
            if hy2_masquerade:
                hy2_inbound["masquerade"] = hy2_masquerade

            inbounds.append(hy2_inbound)

    # =========================================================================
    # 模式 2：WSS 反穿模式 (Local Loopback on 127.0.0.1:10086)
    # =========================================================================
    else:
        bridge_inbound: Dict[str, Any] = {
            "type": "vless",
            "tag": "vless-bridge",
            "listen": "127.0.0.1",
            "listen_port": AppConfig.LOCAL_BRIDGE_PORT,
            "users": vless_users,
        }
        inbounds.append(bridge_inbound)

    effective_log_level = (log_level or AppConfig.LOG_LEVEL or "warn").strip().lower()
    if effective_log_level == "warning":
        effective_log_level = "warn"

    route_rules: List[Dict[str, Any]] = [
        {
            "action": "sniff",
        },
        {
            "ip_is_private": True,
            "action": "reject",
        },
    ]
    route_rule_sets: List[Dict[str, Any]] = []

    if block_cn:
        rule_set_dir = AppConfig.RULE_SET_DIR
        geosite_cn_path = os.path.join(rule_set_dir, "geosite-cn.srs")
        geoip_cn_path = os.path.join(rule_set_dir, "geoip-cn.srs")
        cn_tags: List[str] = []
        if os.path.exists(geosite_cn_path):
            route_rule_sets.append({
                "type": "local",
                "tag": "geosite-cn",
                "format": "binary",
                "path": geosite_cn_path,
            })
            cn_tags.append("geosite-cn")
        if os.path.exists(geoip_cn_path):
            route_rule_sets.append({
                "type": "local",
                "tag": "geoip-cn",
                "format": "binary",
                "path": geoip_cn_path,
            })
            cn_tags.append("geoip-cn")
        if cn_tags:
            route_rules.append({
                "rule_set": cn_tags,
                "action": "reject",
            })
        if "geosite-cn" not in cn_tags:
            # 兜底策略：若运行环境未预置 .srs 文件，仍拦截 .cn 域名且不影响 sing-box 语法校验
            route_rules.append({
                "domain_suffix": [".cn"],
                "action": "reject",
            })

    route_cfg: Dict[str, Any] = {
        "rules": route_rules,
        "final": "direct",
    }
    if route_rule_sets:
        route_cfg["rule_set"] = route_rule_sets

    config: Dict[str, Any] = {
        "log": {
            "level": effective_log_level,
            "timestamp": True,
        },
        "inbounds": inbounds,
        "outbounds": [
            {
                "type": "direct",
                "tag": "direct",
            }
        ],
        "route": route_cfg,
    }

    # 非单机模式下启用 experimental.v2ray_api (仅绑定 127.0.0.1:10085) 进行精准用户级流量计费
    if not is_standalone:
        config["experimental"] = {
            "v2ray_api": {
                "listen": f"127.0.0.1:{AppConfig.STATS_PORT}",
                "stats": {
                    "enabled": True,
                    "users": stat_user_names,
                },
            }
        }

    return config
