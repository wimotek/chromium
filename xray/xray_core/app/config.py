# -*- coding: utf-8 -*-
"""
Edge Core Configuration & Env Parsers
"""
import os


def _parse_bool(raw: str, default: bool = True) -> bool:
    val = (raw or "").strip().lower()
    if not val:
        return default
    return val in ("1", "true", "yes", "on")


class AppConfig:
    DATA_DIR = os.environ.get("DATA_DIR", "/data")
    TEMPLATE_FILE = os.environ.get("TEMPLATE_FILE", "/etc/xray/config.template.json")

    CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
    NODE_ID_FILE = os.path.join(DATA_DIR, "node_id.txt")
    NODE_KEY_FILE = os.path.join(DATA_DIR, "node_key.txt")
    PUBLIC_KEY_FILE = os.path.join(DATA_DIR, "public_key.txt")
    SHORT_ID_FILE = os.path.join(DATA_DIR, "short_id.txt")
    CLIENT_INFO_FILE = os.path.join(DATA_DIR, "client_info.txt")

    # 控制中心连接配置
    PANEL_URL = os.environ.get("PANEL_URL", "").strip().rstrip("/")
    BOOTSTRAP_TOKEN = os.environ.get("CLUSTER_TOKEN", os.environ.get("NODE_KEY", "")).strip()

    # 网络与服务配置
    PORT = int(os.environ.get("PORT", "443"))
    LOCAL_BRIDGE_PORT = int(os.environ.get("LOCAL_BRIDGE_PORT", "10086"))
    STATS_PORT = int(os.environ.get("STATS_PORT", "10085"))
    HEALTH_PORT = int(os.environ.get("HEALTH_PORT", "10087"))

    # 默认占位伪装目标（集群模式下首次上报时由 Hub 从全局多 SNI 池随机分配并下发）
    DEST = os.environ.get("DEST", "www.microsoft.com:443").strip() or "www.microsoft.com:443"
    SERVER_NAMES = os.environ.get("SERVER_NAMES", "www.microsoft.com").strip() or "www.microsoft.com"

    # 回国流量拦截开关：默认开启（关闭回国流量），Hub 后台可随时在线切换
    BLOCK_CN = _parse_bool(os.environ.get("BLOCK_CN", "true"), default=True)

    @classmethod
    def get_server_name_list(cls):
        names = []
        for item in cls.SERVER_NAMES.split(","):
            clean = item.split(":")[0].strip()
            if clean:
                names.append(clean)
        return names or ["www.microsoft.com"]

    @classmethod
    def get_first_server_name(cls):
        names = cls.get_server_name_list()
        return names[0] if names else "www.microsoft.com"

    # 网络模式配置: auto / direct / reverse_wss
    NET_MODE = os.environ.get("NET_MODE", "auto").strip().lower()

    # 证书 Pinning (可选)
    CERT_PIN = os.environ.get("EDGE_AGENT_CERTIFICATE_PIN_SHA256", "").strip() or None
