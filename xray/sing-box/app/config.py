# -*- coding: utf-8 -*-
"""
Sing-box Edge Core Configuration & Env Parsers
与 xray_core 环境变量完全对齐，并扩展 Hysteria2 原生 UDP 协议配置
"""
import os


def _parse_bool(raw: str, default: bool = True) -> bool:
    val = (raw or "").strip().lower()
    if not val:
        return default
    return val in ("1", "true", "yes", "on")


_VALID_LOG_LEVELS = ("trace", "debug", "info", "warn", "error", "fatal", "panic")


def _parse_log_level(raw: str, default: str = "warn") -> str:
    val = (raw or "").strip().lower()
    if val == "warning":
        val = "warn"
    return val if val in _VALID_LOG_LEVELS else default


class AppConfig:
    CORE_TYPE = "singbox"
    DATA_DIR = os.environ.get("DATA_DIR", "/data")
    TEMPLATE_FILE = os.environ.get("TEMPLATE_FILE", "/etc/sing-box/config.template.json")
    RULE_SET_DIR = os.environ.get("RULE_SET_DIR", "/usr/share/sing-box/rule-set")

    CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
    NODE_ID_FILE = os.path.join(DATA_DIR, "node_id.txt")
    NODE_KEY_FILE = os.path.join(DATA_DIR, "node_key.txt")
    PUBLIC_KEY_FILE = os.path.join(DATA_DIR, "public_key.txt")
    PRIVATE_KEY_FILE = os.path.join(DATA_DIR, "private_key.txt")
    SHORT_ID_FILE = os.path.join(DATA_DIR, "short_id.txt")
    CLIENT_INFO_FILE = os.path.join(DATA_DIR, "client_info.txt")

    # 控制中心连接配置
    PANEL_URL = os.environ.get("PANEL_URL", "").strip().rstrip("/")
    BOOTSTRAP_TOKEN = os.environ.get("CLUSTER_TOKEN", os.environ.get("NODE_KEY", "")).strip()

    # 网络与服务配置 (VLESS-REALITY TCP + 内部桥接/统计/探活端口)
    PORT = int(os.environ.get("PORT", "443"))
    LOCAL_BRIDGE_PORT = int(os.environ.get("LOCAL_BRIDGE_PORT", "10086"))
    STATS_PORT = int(os.environ.get("STATS_PORT", "10085"))
    HEALTH_PORT = int(os.environ.get("HEALTH_PORT", "10087"))

    # 默认占位伪装目标（集群模式下首次上报时由 Hub 从全局多 SNI 池随机分配并下发）
    DEST = os.environ.get("DEST", "www.microsoft.com:443").strip() or "www.microsoft.com:443"
    SERVER_NAMES = os.environ.get("SERVER_NAMES", "www.microsoft.com").strip() or "www.microsoft.com"

    # 回国流量拦截开关：默认开启（关闭回国流量），Hub 后台可随时在线切换
    BLOCK_CN = _parse_bool(os.environ.get("BLOCK_CN", "true"), default=True)

    # Hysteria2 原生 UDP/QUIC 双协议配置 (默认与 REALITY 共用 443/udp，互不冲突)
    HY2_ENABLED = _parse_bool(os.environ.get("HY2_ENABLED", "true"), default=True)
    HY2_PORT = int(os.environ.get("HY2_PORT", str(PORT)))
    HY2_SNI = os.environ.get("HY2_SNI", "www.bing.com").strip() or "www.bing.com"
    HY2_MPORT = os.environ.get("HY2_MPORT", "").strip()
    HY2_MASQUERADE = os.environ.get("HY2_MASQUERADE", "https://www.bing.com").strip()
    HY2_UP_MBPS = int(os.environ.get("HY2_UP_MBPS", "0") or 0)
    HY2_DOWN_MBPS = int(os.environ.get("HY2_DOWN_MBPS", "0") or 0)
    HY2_CERT_PATH = os.environ.get("HY2_CERT_PATH", "").strip()
    HY2_KEY_PATH = os.environ.get("HY2_KEY_PATH", "").strip()
    # 若挂载了自定义 CA 签名证书，默认 insecure=False；使用自动自签证书时默认 insecure=True
    _default_insecure = not bool(HY2_CERT_PATH and HY2_KEY_PATH)
    HY2_INSECURE = _parse_bool(os.environ.get("HY2_INSECURE", ""), default=_default_insecure)

    # 默认自动生成的 Hysteria2 自签证书存放路径
    AUTO_HY2_CERT_FILE = os.path.join(DATA_DIR, "hy2_cert.pem")
    AUTO_HY2_KEY_FILE = os.path.join(DATA_DIR, "hy2_key.pem")

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

    @classmethod
    def get_effective_hy2_cert_paths(cls):
        if cls.HY2_CERT_PATH and cls.HY2_KEY_PATH:
            return cls.HY2_CERT_PATH, cls.HY2_KEY_PATH
        return cls.AUTO_HY2_CERT_FILE, cls.AUTO_HY2_KEY_FILE

    # 网络模式配置: auto / direct / reverse_wss
    NET_MODE = os.environ.get("NET_MODE", "auto").strip().lower()

    # Sing-box 内核日志级别: trace / debug / info / warn / error / fatal / panic（默认 warn；设为 fatal 可静默外网 REALITY 扫描回落日志）
    LOG_LEVEL = _parse_log_level(os.environ.get("LOG_LEVEL", "warn"), default="warn")

    # 证书 Pinning (可选)
    CERT_PIN = os.environ.get("EDGE_AGENT_CERTIFICATE_PIN_SHA256", "").strip() or None
