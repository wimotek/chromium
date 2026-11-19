from bisect import bisect_right
import ipaddress
import os
import socket
import threading
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple
import urllib.request

from config import DATA_DIR, logger

DEFAULT_GEOIP_URLS = (
    "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat",
    "https://cdn.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geoip.dat",
)

_SKIP_META_CODES = {"PRIVATE", "LAN", "LOCAL", "RESERVED", "UNKNOWN"}


def _read_varint(buf: memoryview, pos: int, end: int) -> Tuple[int, int]:
    val = 0
    shift = 0
    while pos < end:
        b = buf[pos]
        pos += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, pos
        shift += 7
        if shift > 64:
            raise ValueError("Invalid protobuf varint")
    raise ValueError("Unexpected EOF reading protobuf varint")


def _skip_field(buf: memoryview, pos: int, end: int, wire_type: int) -> int:
    if wire_type == 0:
        _, pos = _read_varint(buf, pos, end)
        return pos
    if wire_type == 1:
        return min(end, pos + 8)
    if wire_type == 2:
        length, pos = _read_varint(buf, pos, end)
        return min(end, pos + length)
    if wire_type == 5:
        return min(end, pos + 4)
    raise ValueError(f"Unsupported protobuf wire type: {wire_type}")


def _parse_cidr_message(buf: memoryview, start: int, end: int) -> Optional[Tuple[bytes, int]]:
    ip_bytes = b""
    prefix = -1
    pos = start
    while pos < end:
        tag, pos = _read_varint(buf, pos, end)
        field_num = tag >> 3
        wire_type = tag & 0x07
        if field_num == 1 and wire_type == 2:
            length, pos = _read_varint(buf, pos, end)
            ip_bytes = bytes(buf[pos : pos + length])
            pos += length
        elif field_num == 2 and wire_type == 0:
            prefix, pos = _read_varint(buf, pos, end)
        else:
            pos = _skip_field(buf, pos, end, wire_type)
    if len(ip_bytes) not in (4, 16) or prefix < 0:
        return None
    return ip_bytes, prefix


def _parse_geoip_entry(
    buf: memoryview,
    start: int,
    end: int,
    v4_raw: List[Tuple[int, int, str]],
    v6_raw: List[Tuple[int, int, str]],
) -> Optional[str]:
    country_code = ""
    cidrs: List[Tuple[bytes, int]] = []
    pos = start
    while pos < end:
        tag, pos = _read_varint(buf, pos, end)
        field_num = tag >> 3
        wire_type = tag & 0x07
        if field_num == 1 and wire_type == 2:
            length, pos = _read_varint(buf, pos, end)
            country_code = bytes(buf[pos : pos + length]).decode("utf-8", errors="ignore").strip().upper()
            pos += length
        elif field_num == 2 and wire_type == 2:
            length, pos = _read_varint(buf, pos, end)
            cidr_end = min(end, pos + length)
            parsed = _parse_cidr_message(buf, pos, cidr_end)
            if parsed is not None:
                cidrs.append(parsed)
            pos = cidr_end
        else:
            pos = _skip_field(buf, pos, end, wire_type)

    if not country_code or country_code in _SKIP_META_CODES or not cidrs:
        return None

    for ip_bytes, prefix in cidrs:
        if len(ip_bytes) == 4 and 0 <= prefix <= 32:
            addr_int = int.from_bytes(ip_bytes, "big")
            host_bits = 32 - prefix
            net_mask = ((1 << 32) - 1) ^ ((1 << host_bits) - 1) if host_bits < 32 else 0
            s_int = addr_int & net_mask
            e_int = s_int | ((1 << host_bits) - 1)
            v4_raw.append((s_int, e_int, country_code))
        elif len(ip_bytes) == 16 and 0 <= prefix <= 128:
            addr_int = int.from_bytes(ip_bytes, "big")
            host_bits = 128 - prefix
            net_mask = ((1 << 128) - 1) ^ ((1 << host_bits) - 1) if host_bits < 128 else 0
            s_int = addr_int & net_mask
            e_int = s_int | ((1 << host_bits) - 1)
            v6_raw.append((s_int, e_int, country_code))
    return country_code


def _build_interval_index(raw_intervals: List[Tuple[int, int, str]]) -> Tuple[List[int], List[int], List[str], List[int]]:
    if not raw_intervals:
        return [], [], [], []
    # 起点升序；同起点时跨度更大的（外层 CIDR）排在前面，内层窄 CIDR 排在后面
    raw_intervals.sort(key=lambda item: (item[0], -item[1]))
    starts: List[int] = []
    ends: List[int] = []
    codes: List[str] = []
    parents: List[int] = []
    stack: List[int] = []

    for idx, (s_int, e_int, code) in enumerate(raw_intervals):
        while stack and ends[stack[-1]] < s_int:
            stack.pop()
        parents.append(stack[-1] if stack else -1)
        starts.append(s_int)
        ends.append(e_int)
        codes.append(code)
        stack.append(idx)

    return starts, ends, codes, parents


def _lookup_interval(
    ip_int: int,
    index: Tuple[List[int], List[int], List[str], List[int]],
) -> Optional[str]:
    starts, ends, codes, parents = index
    if not starts:
        return None
    idx = bisect_right(starts, ip_int) - 1
    while idx >= 0:
        if ip_int <= ends[idx]:
            return codes[idx]
        idx = parents[idx]
    return None


class GeoIPDatReader:
    """零第三方依赖解析 V2Ray / Xray / sing-box 标准 ProtoBuf 格式 geoip.dat"""

    def __init__(self):
        self._lock = threading.Lock()
        self._loaded_path: str = ""
        self._file_sig: Optional[Tuple[int, int]] = None
        self._v4_index: Tuple[List[int], List[int], List[str], List[int]] = ([], [], [], [])
        self._v6_index: Tuple[List[int], List[int], List[str], List[int]] = ([], [], [], [])
        self._country_count: int = 0
        self._last_error: str = ""
        self._loaded_at: str = ""

    @staticmethod
    def candidate_paths() -> List[str]:
        candidates: List[str] = []
        env_path = (os.getenv("GEOIP_DAT_PATH") or "").strip()
        if env_path:
            candidates.append(env_path)
        candidates.extend(
            [
                os.path.join(DATA_DIR, "geoip.dat"),
                "/data/geoip.dat",
                "/app/geoip.dat",
                os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "assets", "geoip.dat"),
                "/usr/share/geoip/geoip.dat",
            ]
        )
        dedup: List[str] = []
        seen = set()
        for p in candidates:
            norm = os.path.normpath(p)
            if norm not in seen:
                seen.add(norm)
                dedup.append(norm)
        return dedup

    def _find_existing_path(self) -> str:
        for p in self.candidate_paths():
            if os.path.isfile(p) and os.path.getsize(p) > 0:
                return p
        return ""

    def _load_file(self, path: str) -> None:
        st = os.stat(path)
        sig = (int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))), int(st.st_size))
        with open(path, "rb") as f:
            raw = f.read()

        buf = memoryview(raw)
        end = len(buf)
        pos = 0
        v4_raw: List[Tuple[int, int, str]] = []
        v6_raw: List[Tuple[int, int, str]] = []
        countries = set()

        while pos < end:
            tag, pos = _read_varint(buf, pos, end)
            field_num = tag >> 3
            wire_type = tag & 0x07
            if field_num == 1 and wire_type == 2:
                length, pos = _read_varint(buf, pos, end)
                entry_end = min(end, pos + length)
                cc = _parse_geoip_entry(buf, pos, entry_end, v4_raw, v6_raw)
                if cc:
                    countries.add(cc)
                pos = entry_end
            else:
                pos = _skip_field(buf, pos, end, wire_type)

        if not v4_raw and not v6_raw:
            raise ValueError("geoip.dat 未解析到有效 CIDR 记录")

        self._v4_index = _build_interval_index(v4_raw)
        self._v6_index = _build_interval_index(v6_raw)
        self._country_count = len(countries)
        self._loaded_path = path
        self._file_sig = sig
        self._last_error = ""
        self._loaded_at = time.strftime("%Y-%m-%d %H:%M:%S")
        logger.info(
            f"🌍 [GeoIP] 已加载 geoip.dat ({path}): {self._country_count} 个国家/地区, "
            f"{len(self._v4_index[0])} IPv4 CIDR, {len(self._v6_index[0])} IPv6 CIDR"
        )

    def ensure_loaded(self, force: bool = False) -> bool:
        path = self._find_existing_path()
        if not path:
            with self._lock:
                self._loaded_path = ""
                self._file_sig = None
                self._v4_index = ([], [], [], [])
                self._v6_index = ([], [], [], [])
                self._country_count = 0
            return False

        try:
            st = os.stat(path)
            sig = (int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))), int(st.st_size))
        except OSError as exc:
            self._last_error = str(exc)
            return False

        with self._lock:
            if not force and self._loaded_path == path and self._file_sig == sig and (self._v4_index[0] or self._v6_index[0]):
                return True
            try:
                self._load_file(path)
                return True
            except Exception as exc:
                self._last_error = f"{type(exc).__name__}: {exc}"
                logger.warning(f"⚠️ [GeoIP] 加载 {path} 失败: {self._last_error}")
                return False

    def lookup_ip(self, raw_ip: Optional[str]) -> Optional[str]:
        txt = extract_host_from_endpoint(raw_ip)
        if not txt:
            return None
        try:
            ip_obj = ipaddress.ip_address(txt)
        except ValueError:
            return None

        if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped:
            ip_obj = ip_obj.ipv4_mapped
        if not ip_obj.is_global:
            return None

        if not self.ensure_loaded():
            return None

        if ip_obj.version == 4:
            return _lookup_interval(int(ip_obj), self._v4_index)
        return _lookup_interval(int(ip_obj), self._v6_index)

    def get_status(self) -> Dict[str, Any]:
        loaded = self.ensure_loaded()
        return {
            "loaded": loaded,
            "path": self._loaded_path or "",
            "candidate_paths": self.candidate_paths(),
            "country_count": self._country_count,
            "ipv4_cidr_count": len(self._v4_index[0]),
            "ipv6_cidr_count": len(self._v6_index[0]),
            "loaded_at": self._loaded_at,
            "last_error": self._last_error,
        }


geoip_reader = GeoIPDatReader()


def extract_host_from_endpoint(raw_value: Optional[str]) -> str:
    txt = (raw_value or "").strip()
    if not txt:
        return ""
    if "://" in txt:
        txt = txt.split("://", 1)[1]
    if "/" in txt:
        txt = txt.split("/", 1)[0]
    if "@" in txt:
        txt = txt.rsplit("@", 1)[-1]
    if txt.startswith("[") and "]" in txt:
        return txt[1 : txt.index("]")].strip()
    if txt.count(":") == 1:
        host_part, port_part = txt.rsplit(":", 1)
        if port_part.isdigit():
            return host_part.strip()
    return txt.strip("[]")


def resolve_ip_from_host(host_or_endpoint: Optional[str]) -> Optional[str]:
    host = extract_host_from_endpoint(host_or_endpoint)
    if not host or host.lower() in {"localhost", "reverse-nat4", "public-wss", "wss-direct", "unknown"}:
        return None
    try:
        ip_obj = ipaddress.ip_address(host)
        if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped:
            ip_obj = ip_obj.ipv4_mapped
        return str(ip_obj) if ip_obj.is_global else None
    except ValueError:
        pass

    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
        for info in infos:
            addr = info[4][0]
            try:
                ip_obj = ipaddress.ip_address(addr)
                if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped:
                    ip_obj = ip_obj.ipv4_mapped
                if ip_obj.is_global:
                    return str(ip_obj)
            except ValueError:
                continue
    except Exception:
        return None
    return None


def pick_best_public_ip(candidates: Sequence[Optional[str]]) -> str:
    for item in candidates:
        resolved = resolve_ip_from_host(item)
        if resolved:
            return resolved
    return ""


def lookup_ip_region(raw_ip: Optional[str]) -> Optional[str]:
    return geoip_reader.lookup_ip(raw_ip)


def resolve_node_region(candidates: Sequence[Optional[str]]) -> Tuple[Optional[str], str]:
    best_ip = pick_best_public_ip(candidates)
    if not best_ip:
        return None, ""
    region = geoip_reader.lookup_ip(best_ip)
    return region, best_ip


def get_geoip_status() -> Dict[str, Any]:
    return geoip_reader.get_status()


def download_geoip_dat(custom_url: Optional[str] = None, timeout: float = 30.0) -> Dict[str, Any]:
    os.makedirs(DATA_DIR, exist_ok=True)
    target_path = os.path.join(DATA_DIR, "geoip.dat")
    tmp_path = target_path + ".tmp"
    urls = [custom_url.strip()] if (custom_url and custom_url.strip()) else list(DEFAULT_GEOIP_URLS)
    last_err = ""

    for url in urls:
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "ChromiumSyncSaaS-GeoIP-Updater/1.0"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            if len(data) < 1024:
                raise ValueError(f"下载文件体积异常 ({len(data)} bytes)")
            with open(tmp_path, "wb") as f:
                f.write(data)
            # 先试解析校验有效性
            v4_raw: List[Tuple[int, int, str]] = []
            v6_raw: List[Tuple[int, int, str]] = []
            buf = memoryview(data)
            pos = 0
            end = len(buf)
            while pos < end:
                tag, pos = _read_varint(buf, pos, end)
                fn = tag >> 3
                wt = tag & 0x07
                if fn == 1 and wt == 2:
                    ln, pos = _read_varint(buf, pos, end)
                    _parse_geoip_entry(buf, pos, min(end, pos + ln), v4_raw, v6_raw)
                    pos = min(end, pos + ln)
                else:
                    pos = _skip_field(buf, pos, end, wt)
            if not v4_raw:
                raise ValueError("下载内容不是有效的 V2Ray geoip.dat 文件")

            os.replace(tmp_path, target_path)
            geoip_reader.ensure_loaded(force=True)
            status = geoip_reader.get_status()
            status["downloaded_from"] = url
            status["size_bytes"] = len(data)
            return status
        except Exception as exc:
            last_err = f"{url} -> {type(exc).__name__}: {exc}"
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass

    raise RuntimeError(f"geoip.dat 下载更新失败: {last_err}")
