"""
Windows 边缘侧 Cookie 隐私防火墙 (CookieGuard)
在 Cookie 离开本地 Windows 浏览器进程之前执行确定性过滤与脱敏审计：
- all: 本地全量放行（可选过滤已过期）
- whitelist: 仅放行指定白名单域名（推荐，防止网银/邮箱/内网账号 Cookie 泄露）
- blacklist: 放行除黑名单外的域名（支持屏蔽特定敏感域名与 Cookie 名关键字）
- block_export: 禁止向 Hub 导出任何 Cookie（仅保留远程 CDP 控制或单向接收）
"""

from dataclasses import dataclass, field
import time
from typing import Any, Dict, List, Optional, Tuple


DEFAULT_SENSITIVE_BLACKLIST = [
    "localhost",
    "127.0.0.1",
    "alipay.com",
    "paypal.com",
    "stripe.com",
    "mail.google.com",
    "mail.qq.com",
    "mail.163.com",
    "icbc.com.cn",
    "cmbchina.com",
    "ccb.com",
    "boc.cn",
    "abchina.com",
    "doubleclick.net",
    "google-analytics.com",
]


def parse_rule_list(raw: Any) -> List[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        items = [str(x).strip() for x in raw]
    else:
        text = str(raw).replace("\r", "\n").replace(";", "\n").replace(",", "\n")
        items = [line.strip() for line in text.split("\n")]
    seen = set()
    result: List[str] = []
    for item in items:
        if not item or item.startswith("#"):
            continue
        norm = item.lower()
        if norm not in seen:
            seen.add(norm)
            result.append(norm)
    return result


def match_domain_rule(cookie_domain: str, rule: str) -> bool:
    """
    域名匹配规则：
    - 'github.com' 或 '.github.com' -> 匹配 'github.com' 及所有子域名 'gist.github.com'
    - '*.github.com' -> 匹配 'github.com' 及所有子域名 'api.github.com'
    - '*bank*' -> 通配子串匹配
    """
    dom = (cookie_domain or "").strip().lower().lstrip(".")
    r = (rule or "").strip().lower()
    if not dom or not r:
        return False

    if r.startswith("*."):
        base = r[2:].lstrip(".")
        return dom == base or dom.endswith("." + base)

    if "*" in r:
        # 简单通配支持，例如 *bank*
        import fnmatch
        return fnmatch.fnmatch(dom, r)

    clean_r = r.lstrip(".")
    return dom == clean_r or dom.endswith("." + clean_r)


def match_name_rule(cookie_name: str, rule: str) -> bool:
    name = (cookie_name or "").strip().lower()
    r = (rule or "").strip().lower()
    if not name or not r:
        return False
    if "*" in r:
        import fnmatch
        return fnmatch.fnmatch(name, r)
    return name == r


@dataclass
class CookieGuardConfig:
    mode: str = "whitelist"  # all | whitelist | blacklist | block_export
    whitelist_domains: List[str] = field(default_factory=list)
    blacklist_domains: List[str] = field(default_factory=lambda: list(DEFAULT_SENSITIVE_BLACKLIST))
    blocked_cookie_names: List[str] = field(default_factory=list)
    exclude_expired: bool = True
    protect_inject: bool = False

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "CookieGuardConfig":
        d = data or {}
        mode = str(d.get("mode") or "whitelist").strip().lower()
        if mode not in {"all", "whitelist", "blacklist", "block_export"}:
            mode = "whitelist"
        return cls(
            mode=mode,
            whitelist_domains=parse_rule_list(d.get("whitelist_domains")),
            blacklist_domains=parse_rule_list(
                d.get("blacklist_domains", DEFAULT_SENSITIVE_BLACKLIST)
            ),
            blocked_cookie_names=parse_rule_list(d.get("blocked_cookie_names")),
            exclude_expired=bool(d.get("exclude_expired", True)),
            protect_inject=bool(d.get("protect_inject", False)),
        )


@dataclass
class FilterStats:
    total: int = 0
    allowed: int = 0
    blocked_by_policy: int = 0
    expired_dropped: int = 0
    allowed_domains: Dict[str, int] = field(default_factory=dict)
    blocked_domains: Dict[str, int] = field(default_factory=dict)


class CookieGuard:
    """本地边缘侧 Cookie 过滤与审计器（日志绝不输出 Cookie Value）"""

    def __init__(self, config: CookieGuardConfig):
        self.config = config

    def filter_for_export(self, cookies: List[dict]) -> Tuple[List[dict], FilterStats]:
        return self._apply_rules(cookies)

    def filter_for_inject(self, cookies: List[dict]) -> Tuple[List[dict], FilterStats]:
        if not self.config.protect_inject:
            stats = FilterStats(total=len(cookies), allowed=len(cookies))
            for c in cookies:
                dom = str(c.get("domain") or "unknown").lower().lstrip(".")
                stats.allowed_domains[dom] = stats.allowed_domains.get(dom, 0) + 1
            return list(cookies), stats
        return self._apply_rules(cookies)

    def _apply_rules(self, cookies: List[dict]) -> Tuple[List[dict], FilterStats]:
        stats = FilterStats(total=len(cookies))
        if self.config.mode == "block_export":
            stats.blocked_by_policy = len(cookies)
            for c in cookies:
                dom = str(c.get("domain") or "unknown").lower().lstrip(".")
                stats.blocked_domains[dom] = stats.blocked_domains.get(dom, 0) + 1
            return [], stats

        now_ts = time.time()
        allowed_list: List[dict] = []

        for c in cookies:
            dom = str(c.get("domain") or "").lower().lstrip(".")
            name = str(c.get("name") or "")

            if self.config.exclude_expired:
                exp = c.get("expires")
                if exp is not None and isinstance(exp, (int, float)) and exp > 0 and exp <= now_ts:
                    stats.expired_dropped += 1
                    continue

            if self.config.blocked_cookie_names and any(
                match_name_rule(name, r) for r in self.config.blocked_cookie_names
            ):
                stats.blocked_by_policy += 1
                stats.blocked_domains[dom or "unknown"] = stats.blocked_domains.get(dom or "unknown", 0) + 1
                continue

            if self.config.mode == "whitelist":
                if not self.config.whitelist_domains or not any(
                    match_domain_rule(dom, r) for r in self.config.whitelist_domains
                ):
                    stats.blocked_by_policy += 1
                    stats.blocked_domains[dom or "unknown"] = stats.blocked_domains.get(dom or "unknown", 0) + 1
                    continue
            elif self.config.mode == "blacklist":
                if self.config.blacklist_domains and any(
                    match_domain_rule(dom, r) for r in self.config.blacklist_domains
                ):
                    stats.blocked_by_policy += 1
                    stats.blocked_domains[dom or "unknown"] = stats.blocked_domains.get(dom or "unknown", 0) + 1
                    continue

            allowed_list.append(c)
            stats.allowed += 1
            stats.allowed_domains[dom or "unknown"] = stats.allowed_domains.get(dom or "unknown", 0) + 1

        return allowed_list, stats

    def inspect_cookies(self, cookies: List[dict]) -> Tuple[List[Dict[str, Any]], FilterStats]:
        """逐条评估本地 Cookie 放行/拦截原因（返回脱敏预览与明细清单，绝不泄露完整明文到日志）"""
        rows: List[Dict[str, Any]] = []
        stats = FilterStats(total=len(cookies))
        now_ts = time.time()

        for c in cookies:
            dom = str(c.get("domain") or "").lower().lstrip(".")
            name = str(c.get("name") or "")
            raw_val = str(c.get("value") or "")
            if len(raw_val) > 10:
                masked = f"{raw_val[:4]}...{raw_val[-3:]}"
            elif raw_val:
                masked = "***"
            else:
                masked = "(空)"

            exp = c.get("expires")
            is_expired = (
                self.config.exclude_expired
                and exp is not None
                and isinstance(exp, (int, float))
                and exp > 0
                and exp <= now_ts
            )

            allowed_flag = False
            if is_expired:
                verdict = "已过期剔除"
                stats.expired_dropped += 1
            elif self.config.mode == "block_export":
                verdict = "拦截(禁止导出)"
                stats.blocked_by_policy += 1
                stats.blocked_domains[dom or "unknown"] = stats.blocked_domains.get(dom or "unknown", 0) + 1
            elif self.config.blocked_cookie_names and any(
                match_name_rule(name, r) for r in self.config.blocked_cookie_names
            ):
                verdict = "拦截(名称屏蔽)"
                stats.blocked_by_policy += 1
                stats.blocked_domains[dom or "unknown"] = stats.blocked_domains.get(dom or "unknown", 0) + 1
            elif self.config.mode == "whitelist":
                if not self.config.whitelist_domains:
                    verdict = "拦截(白名单为空)"
                    stats.blocked_by_policy += 1
                    stats.blocked_domains[dom or "unknown"] = stats.blocked_domains.get(dom or "unknown", 0) + 1
                elif not any(match_domain_rule(dom, r) for r in self.config.whitelist_domains):
                    verdict = "拦截(非白名单)"
                    stats.blocked_by_policy += 1
                    stats.blocked_domains[dom or "unknown"] = stats.blocked_domains.get(dom or "unknown", 0) + 1
                else:
                    verdict = "放行"
                    allowed_flag = True
                    stats.allowed += 1
                    stats.allowed_domains[dom or "unknown"] = stats.allowed_domains.get(dom or "unknown", 0) + 1
            elif self.config.mode == "blacklist":
                if self.config.blacklist_domains and any(
                    match_domain_rule(dom, r) for r in self.config.blacklist_domains
                ):
                    verdict = "拦截(命中黑名单)"
                    stats.blocked_by_policy += 1
                    stats.blocked_domains[dom or "unknown"] = stats.blocked_domains.get(dom or "unknown", 0) + 1
                else:
                    verdict = "放行"
                    allowed_flag = True
                    stats.allowed += 1
                    stats.allowed_domains[dom or "unknown"] = stats.allowed_domains.get(dom or "unknown", 0) + 1
            else:
                verdict = "放行"
                allowed_flag = True
                stats.allowed += 1
                stats.allowed_domains[dom or "unknown"] = stats.allowed_domains.get(dom or "unknown", 0) + 1

            if exp is not None and isinstance(exp, (int, float)) and exp > 0:
                exp_str = time.strftime("%Y-%m-%d %H:%M", time.localtime(exp))
            else:
                exp_str = "会话级(关闭失效)"

            flags = []
            if c.get("httpOnly"):
                flags.append("HttpOnly")
            if c.get("secure"):
                flags.append("Secure")

            rows.append({
                "domain": c.get("domain") or dom or "-",
                "name": name,
                "verdict": verdict,
                "allowed": allowed_flag,
                "value_masked": masked,
                "flags": ", ".join(flags) if flags else "-",
                "expires_str": exp_str,
            })

        return rows, stats
