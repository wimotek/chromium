# -*- coding: utf-8 -*-
"""
Sing-box Edge Core Configuration & Env Parsers
与 xray_core 环境变量完全对齐，并扩展 Hysteria2 原生 UDP 协议配置
"""
import json
import os
import secrets


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


# 精选更低噪音、支持 TLS 1.3 + HTTP/2 + X25519 且非 Cloudflare / 非烂大街微软的 REALITY 伪装目标池
SAFE_REALITY_TARGETS = (
    ("www.amd.com:443", "www.amd.com"),
    ("www.nvidia.com:443", "www.nvidia.com"),
    ("www.intel.com:443", "www.intel.com"),
    ("www.logitech.com:443", "www.logitech.com"),
    ("www.samsung.com:443", "www.samsung.com"),
    ("www.sony.com:443", "www.sony.com"),
    ("www.asus.com:443", "www.asus.com"),
    ("www.dell.com:443", "www.dell.com"),
    ("www.cisco.com:443", "www.cisco.com"),
    ("www.oracle.com:443", "www.oracle.com"),
    ("www.siemens.com:443", "www.siemens.com"),
    ("www.mozilla.org:443", "www.mozilla.org"),
)


def _host_from_dest(dest: str) -> str:
    raw = (dest or "").strip()
    if raw.startswith("[") and "]" in raw:
        return raw[1:raw.find("]")]
    if ":" in raw:
        return raw.rsplit(":", 1)[0].strip()
    return raw


def _resolve_initial_reality_target(data_dir: str, config_file: str, target_file: str):
    env_dest = os.environ.get("DEST", "").strip()
    env_snis = os.environ.get("SERVER_NAMES", "").strip()

    if env_dest or env_snis:
        if env_dest and env_snis:
            dest = env_dest if ":" in env_dest else f"{env_dest}:443"
            return dest, env_snis
        if env_dest:
            dest = env_dest if ":" in env_dest else f"{env_dest}:443"
            host = _host_from_dest(dest) or SAFE_REALITY_TARGETS[0][1]
            return dest, host
        first_sni = env_snis.split(",")[0].split(":")[0].strip() or SAFE_REALITY_TARGETS[0][1]
        return f"{first_sni}:443", env_snis

    # 1. 优先复用已持久化的随机伪装目标，避免重启容器导致伪装域名飘移
    if os.path.exists(target_file):
        try:
            with open(target_file, "r", encoding="utf-8") as f:
                saved = json.load(f)
            s_dest = str(saved.get("dest") or "").strip()
            s_snis = str(saved.get("server_names") or "").strip()
            if s_dest and s_snis:
                return s_dest, s_snis
        except Exception:
            pass

    # 2. 兼容已运行的旧节点升级：从现存 config.json 读取原有伪装目标，不静默破坏现有连接
    if os.path.exists(config_file):
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            for ib in cfg.get("inbounds", []):
                tls_cfg = ib.get("tls") or {}
                hs = (tls_cfg.get("reality") or {}).get("handshake") or {}
                c_host = str(hs.get("server") or "").strip()
                c_port = int(hs.get("server_port") or 443)
                c_sni = str(tls_cfg.get("server_name") or "").strip()
                if c_host and c_sni:
                    return f"{c_host}:{c_port}", c_sni
        except Exception:
            pass

    # 3. 首次启动随机分配一个更安全的伪装目标并落盘固化
    dest, sni = secrets.choice(SAFE_REALITY_TARGETS)
    try:
        os.makedirs(data_dir, exist_ok=True)
        with open(target_file, "w", encoding="utf-8") as f:
            json.dump({"dest": dest, "server_names": sni}, f, indent=2)
    except Exception:
        pass
    return dest, sni


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
    REALITY_TARGET_FILE = os.path.join(DATA_DIR, "reality_target.json")

    # 控制中心连接配置
    PANEL_URL = os.environ.get("PANEL_URL", "").strip().rstrip("/")
    BOOTSTRAP_TOKEN = os.environ.get("CLUSTER_TOKEN", os.environ.get("NODE_KEY", "")).strip()

    # 网络与服务配置 (VLESS-REALITY TCP + 内部桥接/统计/探活端口)
    PORT = int(os.environ.get("PORT", "443"))
    LOCAL_BRIDGE_PORT = int(os.environ.get("LOCAL_BRIDGE_PORT", "10086"))
    STATS_PORT = int(os.environ.get("STATS_PORT", "10085"))
    HEALTH_PORT = int(os.environ.get("HEALTH_PORT", "10087"))

    DEST, SERVER_NAMES = _resolve_initial_reality_target(DATA_DIR, CONFIG_FILE, REALITY_TARGET_FILE)

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
        return names or [SAFE_REALITY_TARGETS[0][1]]

    @classmethod
    def get_first_server_name(cls):
        names = cls.get_server_name_list()
        return names[0] if names else SAFE_REALITY_TARGETS[0][1]

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
