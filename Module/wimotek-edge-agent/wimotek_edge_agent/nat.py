from __future__ import annotations

from typing import Optional

from .config import Config


def detect_network_profile(
    config: Config,
    advertised_nat_type: Optional[str] = None,
    advertised_reverse: Optional[bool] = None,
) -> tuple[str, str]:
    """
    返回 (network_profile, nat_type)。

    生产环境建议用 STUN 探测替换 advertised_nat_type；当前接口保持可插拔。
    """
    nat_type = (advertised_nat_type or config.nat_type or "unknown").lower()

    if config.reverse_tunnel is not None:
        reverse = config.reverse_tunnel
    elif advertised_reverse is not None:
        reverse = advertised_reverse
    else:
        reverse = nat_type in {"nat4", "symmetric", "nat4_reverse"}

    profile = "nat4_reverse" if reverse else "direct"
    return profile, nat_type