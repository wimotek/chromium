from datetime import datetime
import re
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import case, func, or_

from core.cache import build_encoded_redis_url, cache_mgr, normalize_key_prefix
from core.db import (
    get_active_db_info,
    get_all_settings_map,
    get_setting,
    issue_user_api_key,
    issue_user_invite_code,
    issue_user_join_token,
    load_bootstrap_config,
    save_bootstrap_config,
    session_scope,
    set_setting,
    set_settings_batch,
)
from core.models import (
    BillingLedger,
    Node,
    NodeLease,
    Plan,
    RechargeOrder,
    ReferralReward,
    SyncLog,
    SyncPolicy,
    TrafficStat,
    User,
    UserLevel,
    units_to_yuan_str,
    yuan_to_units,
)
from core.rate_limit import get_antispam_stats, get_client_ip
from core.security import hash_password, require_admin
from modules.audit.service import write_audit_log
from modules.billing.payment_gateway import query_alipay_order, query_wechat_order
from modules.billing.router import _get_alipay_gateway_cfg, _get_wechat_gateway_cfg, _mark_recharge_order_paid_sync
from modules.billing.service import (
    get_all_channel_fee_bps,
    get_market_base_gb_units,
    get_market_base_hour_units,
    get_self_reverse_hub_gb_units,
    settle_single_lease_sync,
)
from modules.nodes.geoip_service import download_geoip_dat, get_geoip_status
from modules.nodes.traffic_service import get_traffic_summary
from modules.nodes.tunnel_manager import tunnel_mgr
from modules.sync.service import reschedule_all_policies
from modules.users.level_service import evaluate_all_users_levels_sync, evaluate_user_level_sync

router = APIRouter(tags=["运营管理台（Admin）"])
_ADMIN_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


class AdminSettingsDTO(BaseModel):
    saas_platform_fee_bps: Optional[int] = None
    saas_reverse_fee_bps: Optional[int] = None
    saas_public_wss_fee_bps: Optional[int] = None
    saas_market_base_hour_yuan: Optional[float] = None
    saas_market_base_gb_yuan: Optional[float] = None
    saas_self_reverse_hub_gb_yuan: Optional[float] = None
    saas_auto_level_enabled: Optional[bool] = None
    saas_allow_public_register: Optional[bool] = None
    saas_require_email_verify: Optional[bool] = None
    saas_referral_enabled: Optional[bool] = None
    saas_referral_inviter_bonus_yuan: Optional[float] = None
    saas_referral_invitee_bonus_yuan: Optional[float] = None
    saas_allow_self_recharge: Optional[bool] = None
    saas_welcome_bonus_yuan: Optional[float] = None
    saas_monthly_claim_enabled: Optional[bool] = None
    saas_monthly_claim_yuan: Optional[float] = None
    saas_daily_checkin_enabled: Optional[bool] = None
    saas_daily_checkin_yuan: Optional[float] = None
    saas_daily_streak_bonus_yuan: Optional[float] = None
    saas_alipay_enabled: Optional[bool] = None
    saas_alipay_mode: Optional[str] = None
    saas_alipay_sign_mode: Optional[str] = None
    saas_alipay_f2f_enabled: Optional[bool] = None
    saas_alipay_page_enabled: Optional[bool] = None
    saas_alipay_static_enabled: Optional[bool] = None
    saas_alipay_app_id: Optional[str] = None
    saas_alipay_private_key: Optional[str] = None
    saas_alipay_public_key: Optional[str] = None
    saas_alipay_app_cert: Optional[str] = None
    saas_alipay_cert_public_key: Optional[str] = None
    saas_alipay_root_cert: Optional[str] = None
    saas_alipay_gateway_url: Optional[str] = None
    saas_alipay_notify_url: Optional[str] = None
    saas_alipay_return_url: Optional[str] = None
    saas_alipay_qr_url: Optional[str] = None
    saas_wechat_enabled: Optional[bool] = None
    saas_wechat_mode: Optional[str] = None
    saas_wechat_native_enabled: Optional[bool] = None
    saas_wechat_static_enabled: Optional[bool] = None
    saas_wechat_app_id: Optional[str] = None
    saas_wechat_mch_id: Optional[str] = None
    saas_wechat_serial_no: Optional[str] = None
    saas_wechat_private_key: Optional[str] = None
    saas_wechat_api_v3_key: Optional[str] = None
    saas_wechat_platform_public_key: Optional[str] = None
    saas_wechat_gateway_url: Optional[str] = None
    saas_wechat_notify_url: Optional[str] = None
    saas_wechat_qr_url: Optional[str] = None
    saas_payment_notify_secret: Optional[str] = None


class AdminUserCreateDTO(BaseModel):
    username: str
    email: str = ""
    password: str
    role: str = "user"
    plan_id: int = 1
    level_id: int = 1
    email_verified: bool = True
    initial_balance_yuan: float = 0.0


class AdminUserUpdateDTO(BaseModel):
    role: Optional[str] = None
    status: Optional[str] = None
    email: Optional[str] = None
    email_verified: Optional[bool] = None
    new_password: Optional[str] = None
    plan_id: Optional[int] = None
    level_id: Optional[int] = None
    level_locked: Optional[bool] = None
    adjust_balance_yuan: Optional[float] = None
    adjust_remark: str = ""


class AdminLevelUpdateDTO(BaseModel):
    name: Optional[str] = None
    badge_color: Optional[str] = None
    min_online_hours: Optional[int] = None
    min_contributed_gb: Optional[int] = None
    max_avg_latency_ms: Optional[int] = None
    min_speed_kbps: Optional[int] = None
    reverse_fee_bps: Optional[int] = None
    public_wss_fee_bps: Optional[int] = None
    buyer_discount_bps: Optional[int] = None
    description: Optional[str] = None


class AdminPlanUpdateDTO(BaseModel):
    name: Optional[str] = None
    monthly_price_yuan: Optional[float] = None
    max_nodes: Optional[int] = None
    max_active_leases: Optional[int] = None
    max_monthly_traffic_gb: Optional[float] = None
    platform_fee_discount_bps: Optional[int] = None
    can_share_nodes: Optional[bool] = None


class RedisTestDTO(BaseModel):
    redis_url: str = ""
    redis_host: Optional[str] = None
    redis_port: Optional[int] = 6379
    redis_db: Optional[int] = 0
    redis_username: Optional[str] = ""
    redis_password: Optional[str] = None
    redis_tls: bool = False
    keep_password: bool = True
    clear_password: bool = False
    key_prefix: Optional[str] = None
    use_current: bool = False


class RedisReloadDTO(BaseModel):
    mode: Optional[str] = None
    redis_url: str = ""
    redis_host: Optional[str] = None
    redis_port: Optional[int] = 6379
    redis_db: Optional[int] = 0
    redis_username: Optional[str] = ""
    redis_password: Optional[str] = None
    redis_tls: bool = False
    keep_password: bool = True
    clear_password: bool = False
    key_prefix: Optional[str] = None
    use_current: bool = False
    reconnect_only: bool = False


class GeoipUpdateDTO(BaseModel):
    url: str = ""


def _parse_int_setting(settings_map: Dict[str, str], key: str, default: int, *, min_val: int = 0, max_val: Optional[int] = None) -> int:
    raw = settings_map.get(key)
    try:
        val = int(raw) if raw not in (None, "") else default
    except (TypeError, ValueError):
        val = default
    if val < min_val:
        val = min_val
    if max_val is not None and val > max_val:
        val = max_val
    return val


def _build_admin_settings_payload(settings_map: Dict[str, str]) -> Dict[str, Any]:
    def _s(key: str, default: str = "") -> str:
        val = settings_map.get(key)
        return default if val is None else val

    raw_reverse = settings_map.get("saas_reverse_fee_bps")
    if raw_reverse in (None, ""):
        raw_reverse = settings_map.get("saas_platform_fee_bps")
    try:
        reverse_bps = max(0, min(10000, int(raw_reverse) if raw_reverse not in (None, "") else 2500))
    except (TypeError, ValueError):
        reverse_bps = 2500

    public_wss_bps = _parse_int_setting(settings_map, "saas_public_wss_fee_bps", 1000, min_val=0, max_val=10000)
    market_hour_units = _parse_int_setting(settings_map, "saas_market_base_hour_units", 5000, min_val=0)
    market_gb_units = _parse_int_setting(settings_map, "saas_market_base_gb_units", 10000, min_val=0)
    self_rev_units = _parse_int_setting(settings_map, "saas_self_reverse_hub_gb_units", 2000, min_val=0)

    f2f_enabled = _s("saas_alipay_f2f_enabled", "1") == "1"
    page_enabled = _s("saas_alipay_page_enabled", "1") == "1"
    alipay_static_enabled = _s("saas_alipay_static_enabled", "0") == "1"
    wechat_native_enabled = _s("saas_wechat_native_enabled", "1") == "1"
    wechat_static_enabled = _s("saas_wechat_static_enabled", "0") == "1"

    return {
        "saas_platform_fee_bps": reverse_bps,
        "saas_reverse_fee_bps": reverse_bps,
        "saas_public_wss_fee_bps": public_wss_bps,
        "saas_market_base_hour_yuan": float(units_to_yuan_str(market_hour_units)),
        "saas_market_base_gb_yuan": float(units_to_yuan_str(market_gb_units)),
        "saas_self_reverse_hub_gb_yuan": float(units_to_yuan_str(self_rev_units)),
        "saas_auto_level_enabled": _s("saas_auto_level_enabled", "1") == "1",
        "saas_allow_public_register": _s("saas_allow_public_register", "1") == "1",
        "saas_require_email_verify": _s("saas_require_email_verify", "1") == "1",
        "saas_referral_enabled": _s("saas_referral_enabled", "1") == "1",
        "saas_referral_inviter_bonus_yuan": float(units_to_yuan_str(_parse_int_setting(settings_map, "saas_referral_inviter_bonus_units", 50000))),
        "saas_referral_invitee_bonus_yuan": float(units_to_yuan_str(_parse_int_setting(settings_map, "saas_referral_invitee_bonus_units", 30000))),
        "saas_allow_self_recharge": _s("saas_allow_self_recharge", "1") == "1",
        "saas_welcome_bonus_yuan": float(units_to_yuan_str(_parse_int_setting(settings_map, "saas_welcome_bonus_units", 100000))),
        "saas_monthly_claim_enabled": _s("saas_monthly_claim_enabled", "1") == "1",
        "saas_monthly_claim_yuan": float(units_to_yuan_str(_parse_int_setting(settings_map, "saas_monthly_claim_units", 100000))),
        "saas_daily_checkin_enabled": _s("saas_daily_checkin_enabled", "1") == "1",
        "saas_daily_checkin_yuan": float(units_to_yuan_str(_parse_int_setting(settings_map, "saas_daily_checkin_units", 5000))),
        "saas_daily_streak_bonus_yuan": float(units_to_yuan_str(_parse_int_setting(settings_map, "saas_daily_streak_bonus_units", 1000))),
        "saas_alipay_enabled": f2f_enabled or page_enabled or alipay_static_enabled,
        "saas_alipay_mode": _s("saas_alipay_mode", "precreate") or "precreate",
        "saas_alipay_sign_mode": _s("saas_alipay_sign_mode", "public_key") or "public_key",
        "saas_alipay_f2f_enabled": f2f_enabled,
        "saas_alipay_page_enabled": page_enabled,
        "saas_alipay_static_enabled": alipay_static_enabled,
        "saas_alipay_app_id": _s("saas_alipay_app_id", ""),
        "saas_alipay_private_key": "",
        "saas_alipay_private_key_set": bool(_s("saas_alipay_private_key", "").strip()),
        "saas_alipay_public_key": _s("saas_alipay_public_key", ""),
        "saas_alipay_app_cert": _s("saas_alipay_app_cert", ""),
        "saas_alipay_cert_public_key": _s("saas_alipay_cert_public_key", ""),
        "saas_alipay_root_cert": _s("saas_alipay_root_cert", ""),
        "saas_alipay_gateway_url": _s("saas_alipay_gateway_url", "https://openapi.alipay.com/gateway.do") or "https://openapi.alipay.com/gateway.do",
        "saas_alipay_notify_url": _s("saas_alipay_notify_url", ""),
        "saas_alipay_return_url": _s("saas_alipay_return_url", ""),
        "saas_alipay_qr_url": _s("saas_alipay_qr_url", ""),
        "saas_wechat_enabled": wechat_native_enabled or wechat_static_enabled,
        "saas_wechat_mode": _s("saas_wechat_mode", "native_v3") or "native_v3",
        "saas_wechat_native_enabled": wechat_native_enabled,
        "saas_wechat_static_enabled": wechat_static_enabled,
        "saas_wechat_app_id": _s("saas_wechat_app_id", ""),
        "saas_wechat_mch_id": _s("saas_wechat_mch_id", ""),
        "saas_wechat_serial_no": _s("saas_wechat_serial_no", ""),
        "saas_wechat_private_key": "",
        "saas_wechat_private_key_set": bool(_s("saas_wechat_private_key", "").strip()),
        "saas_wechat_api_v3_key": "",
        "saas_wechat_api_v3_key_set": bool(_s("saas_wechat_api_v3_key", "").strip()),
        "saas_wechat_platform_public_key": _s("saas_wechat_platform_public_key", ""),
        "saas_wechat_gateway_url": _s("saas_wechat_gateway_url", "https://api.mch.weixin.qq.com") or "https://api.mch.weixin.qq.com",
        "saas_wechat_notify_url": _s("saas_wechat_notify_url", ""),
        "saas_wechat_qr_url": _s("saas_wechat_qr_url", ""),
        "saas_payment_notify_secret": "",
        "saas_payment_notify_secret_set": bool(_s("saas_payment_notify_secret", "").strip()),
    }


@router.get("/api/admin/settings", summary="快速读取平台策略与支付网关配置（Admin）")
def admin_get_settings(admin: dict = Depends(require_admin)):
    settings_map = get_all_settings_map()
    return {"settings": _build_admin_settings_payload(settings_map)}


@router.get("/api/admin/overview", summary="平台总营收、差价抽成、租户与共享节点大盘（Admin）")
def admin_overview(admin: dict = Depends(require_admin)):
    with session_scope(readonly=True) as db:
        total_users = db.query(User).count()
        active_users = db.query(User).filter(User.status == "active").count()
        total_nodes = db.query(Node).count()
        shared_nodes = db.query(Node).filter(Node.share_enabled == 1).count()
        active_leases = db.query(NodeLease).filter(NodeLease.status == "active").count()
        total_leases = db.query(NodeLease).count()
        lease_spread_sum = db.query(func.coalesce(func.sum(NodeLease.platform_profit_units), 0)).scalar() or 0
        self_reverse_spread_sum = (
            db.query(func.coalesce(func.sum(BillingLedger.platform_spread_units), 0))
            .filter(BillingLedger.tx_type == "self_reverse_hub_fee")
            .scalar()
            or 0
        )
        total_profit_units = int(lease_spread_sum) + int(self_reverse_spread_sum)
        gmv_sum = db.query(func.coalesce(func.sum(NodeLease.buyer_spent_units), 0)).scalar() or 0
        seller_sum = db.query(func.coalesce(func.sum(NodeLease.seller_earned_units), 0)).scalar() or 0
        recent_leases = [l.to_dict() for l in db.query(NodeLease).order_by(NodeLease.id.desc()).limit(50).all()]
        levels = [lv.to_dict() for lv in db.query(UserLevel).order_by(UserLevel.rank_order.asc()).all()]
        plans = [p.to_dict() for p in db.query(Plan).order_by(Plan.monthly_price_units.asc(), Plan.id.asc()).all()]
        referral_count = db.query(ReferralReward).count()
        settings_map = get_all_settings_map(db)

    return {
        "metrics": {
            "total_users": total_users,
            "active_users": active_users,
            "total_nodes": total_nodes,
            "shared_nodes": shared_nodes,
            "active_leases": active_leases,
            "total_leases": total_leases,
            "referral_count": referral_count,
            "platform_profit_units": total_profit_units,
            "platform_profit_yuan": units_to_yuan_str(total_profit_units),
            "lease_profit_units": int(lease_spread_sum),
            "lease_profit_yuan": units_to_yuan_str(int(lease_spread_sum)),
            "self_reverse_profit_units": int(self_reverse_spread_sum),
            "self_reverse_profit_yuan": units_to_yuan_str(int(self_reverse_spread_sum)),
            "gmv_units": int(gmv_sum),
            "gmv_yuan": units_to_yuan_str(int(gmv_sum)),
            "seller_payout_units": int(seller_sum),
            "seller_payout_yuan": units_to_yuan_str(int(seller_sum)),
        },
        "settings": _build_admin_settings_payload(settings_map),
        "levels": levels,
        "plans": plans,
        "runtime": {
            "db": get_active_db_info(),
            "cache": cache_mgr.get_status(),
            "antispam": get_antispam_stats(),
            "geoip": get_geoip_status(),
        },
        "recent_leases": recent_leases,
        "traffic": get_traffic_summary(owner_id=None, limit_hours=24),
    }


@router.post("/api/admin/settings", summary="调整分通道差价比例、邮箱认证、邀请奖励与支付配置")
def admin_update_settings(data: AdminSettingsDTO, request: Request, admin: dict = Depends(require_admin)):
    updates: dict[str, str] = {}

    if data.saas_reverse_fee_bps is not None:
        bps = max(0, min(10000, int(data.saas_reverse_fee_bps)))
        updates["saas_reverse_fee_bps"] = str(bps)
        updates["saas_platform_fee_bps"] = str(bps)
    elif data.saas_platform_fee_bps is not None:
        bps = max(0, min(10000, int(data.saas_platform_fee_bps)))
        updates["saas_platform_fee_bps"] = str(bps)
        updates["saas_reverse_fee_bps"] = str(bps)

    if data.saas_public_wss_fee_bps is not None:
        updates["saas_public_wss_fee_bps"] = str(max(0, min(10000, int(data.saas_public_wss_fee_bps))))
    if data.saas_market_base_hour_yuan is not None:
        updates["saas_market_base_hour_units"] = str(max(0, yuan_to_units(data.saas_market_base_hour_yuan)))
    if data.saas_market_base_gb_yuan is not None:
        updates["saas_market_base_gb_units"] = str(max(0, yuan_to_units(data.saas_market_base_gb_yuan)))
    if data.saas_self_reverse_hub_gb_yuan is not None:
        updates["saas_self_reverse_hub_gb_units"] = str(max(0, yuan_to_units(data.saas_self_reverse_hub_gb_yuan)))
    if data.saas_auto_level_enabled is not None:
        updates["saas_auto_level_enabled"] = "1" if data.saas_auto_level_enabled else "0"
    if data.saas_allow_public_register is not None:
        updates["saas_allow_public_register"] = "1" if data.saas_allow_public_register else "0"
    if data.saas_require_email_verify is not None:
        updates["saas_require_email_verify"] = "1" if data.saas_require_email_verify else "0"
    if data.saas_referral_enabled is not None:
        updates["saas_referral_enabled"] = "1" if data.saas_referral_enabled else "0"
    if data.saas_referral_inviter_bonus_yuan is not None:
        updates["saas_referral_inviter_bonus_units"] = str(max(0, yuan_to_units(data.saas_referral_inviter_bonus_yuan)))
    if data.saas_referral_invitee_bonus_yuan is not None:
        updates["saas_referral_invitee_bonus_units"] = str(max(0, yuan_to_units(data.saas_referral_invitee_bonus_yuan)))
    if data.saas_allow_self_recharge is not None:
        updates["saas_allow_self_recharge"] = "1" if data.saas_allow_self_recharge else "0"
    if data.saas_welcome_bonus_yuan is not None:
        updates["saas_welcome_bonus_units"] = str(max(0, yuan_to_units(data.saas_welcome_bonus_yuan)))
    if data.saas_monthly_claim_enabled is not None:
        updates["saas_monthly_claim_enabled"] = "1" if data.saas_monthly_claim_enabled else "0"
    if data.saas_monthly_claim_yuan is not None:
        updates["saas_monthly_claim_units"] = str(max(0, yuan_to_units(data.saas_monthly_claim_yuan)))
    if data.saas_daily_checkin_enabled is not None:
        updates["saas_daily_checkin_enabled"] = "1" if data.saas_daily_checkin_enabled else "0"
    if data.saas_daily_checkin_yuan is not None:
        updates["saas_daily_checkin_units"] = str(max(0, yuan_to_units(data.saas_daily_checkin_yuan)))
    if data.saas_daily_streak_bonus_yuan is not None:
        updates["saas_daily_streak_bonus_units"] = str(max(0, yuan_to_units(data.saas_daily_streak_bonus_yuan)))
    if data.saas_alipay_mode is not None and data.saas_alipay_mode.strip().lower() in {"precreate", "page_pay", "static_qr"}:
        updates["saas_alipay_mode"] = data.saas_alipay_mode.strip().lower()
    if data.saas_alipay_sign_mode is not None and data.saas_alipay_sign_mode.strip().lower() in {"public_key", "cert"}:
        updates["saas_alipay_sign_mode"] = data.saas_alipay_sign_mode.strip().lower()

    has_alipay_method_flags = any(
        x is not None for x in (data.saas_alipay_f2f_enabled, data.saas_alipay_page_enabled, data.saas_alipay_static_enabled)
    )
    if data.saas_alipay_f2f_enabled is not None:
        updates["saas_alipay_f2f_enabled"] = "1" if data.saas_alipay_f2f_enabled else "0"
    if data.saas_alipay_page_enabled is not None:
        updates["saas_alipay_page_enabled"] = "1" if data.saas_alipay_page_enabled else "0"
    if data.saas_alipay_static_enabled is not None:
        updates["saas_alipay_static_enabled"] = "1" if data.saas_alipay_static_enabled else "0"
    if has_alipay_method_flags:
        f2f_eff = (updates.get("saas_alipay_f2f_enabled") or get_setting("saas_alipay_f2f_enabled", "1")) == "1"
        page_eff = (updates.get("saas_alipay_page_enabled") or get_setting("saas_alipay_page_enabled", "1")) == "1"
        static_eff = (updates.get("saas_alipay_static_enabled") or get_setting("saas_alipay_static_enabled", "0")) == "1"
        updates["saas_alipay_enabled"] = "1" if (f2f_eff or page_eff or static_eff) else "0"
    elif data.saas_alipay_enabled is not None:
        updates["saas_alipay_enabled"] = "1" if data.saas_alipay_enabled else "0"
        if not data.saas_alipay_enabled:
            updates["saas_alipay_f2f_enabled"] = "0"
            updates["saas_alipay_page_enabled"] = "0"
            updates["saas_alipay_static_enabled"] = "0"

    if data.saas_alipay_app_id is not None:
        updates["saas_alipay_app_id"] = data.saas_alipay_app_id.strip()
    if data.saas_alipay_private_key is not None and data.saas_alipay_private_key.strip():
        updates["saas_alipay_private_key"] = data.saas_alipay_private_key.strip()
    if data.saas_alipay_public_key is not None:
        updates["saas_alipay_public_key"] = data.saas_alipay_public_key.strip()
    if data.saas_alipay_app_cert is not None:
        updates["saas_alipay_app_cert"] = data.saas_alipay_app_cert.strip()
    if data.saas_alipay_cert_public_key is not None:
        updates["saas_alipay_cert_public_key"] = data.saas_alipay_cert_public_key.strip()
    if data.saas_alipay_root_cert is not None:
        updates["saas_alipay_root_cert"] = data.saas_alipay_root_cert.strip()
    if data.saas_alipay_gateway_url is not None:
        updates["saas_alipay_gateway_url"] = data.saas_alipay_gateway_url.strip() or "https://openapi.alipay.com/gateway.do"
    if data.saas_alipay_notify_url is not None:
        updates["saas_alipay_notify_url"] = data.saas_alipay_notify_url.strip()
    if data.saas_alipay_return_url is not None:
        updates["saas_alipay_return_url"] = data.saas_alipay_return_url.strip()
    if data.saas_alipay_qr_url is not None:
        updates["saas_alipay_qr_url"] = data.saas_alipay_qr_url.strip()

    if data.saas_wechat_mode is not None and data.saas_wechat_mode.strip().lower() in {"native_v3", "static_qr"}:
        updates["saas_wechat_mode"] = data.saas_wechat_mode.strip().lower()

    has_wechat_method_flags = any(
        x is not None for x in (data.saas_wechat_native_enabled, data.saas_wechat_static_enabled)
    )
    if data.saas_wechat_native_enabled is not None:
        updates["saas_wechat_native_enabled"] = "1" if data.saas_wechat_native_enabled else "0"
    if data.saas_wechat_static_enabled is not None:
        updates["saas_wechat_static_enabled"] = "1" if data.saas_wechat_static_enabled else "0"
    if has_wechat_method_flags:
        native_eff = (updates.get("saas_wechat_native_enabled") or get_setting("saas_wechat_native_enabled", "1")) == "1"
        wstatic_eff = (updates.get("saas_wechat_static_enabled") or get_setting("saas_wechat_static_enabled", "0")) == "1"
        updates["saas_wechat_enabled"] = "1" if (native_eff or wstatic_eff) else "0"
    elif data.saas_wechat_enabled is not None:
        updates["saas_wechat_enabled"] = "1" if data.saas_wechat_enabled else "0"
        if not data.saas_wechat_enabled:
            updates["saas_wechat_native_enabled"] = "0"
            updates["saas_wechat_static_enabled"] = "0"

    if data.saas_wechat_app_id is not None:
        updates["saas_wechat_app_id"] = data.saas_wechat_app_id.strip()
    if data.saas_wechat_mch_id is not None:
        updates["saas_wechat_mch_id"] = data.saas_wechat_mch_id.strip()
    if data.saas_wechat_serial_no is not None:
        updates["saas_wechat_serial_no"] = data.saas_wechat_serial_no.strip()
    if data.saas_wechat_private_key is not None and data.saas_wechat_private_key.strip():
        updates["saas_wechat_private_key"] = data.saas_wechat_private_key.strip()
    if data.saas_wechat_api_v3_key is not None and data.saas_wechat_api_v3_key.strip():
        updates["saas_wechat_api_v3_key"] = data.saas_wechat_api_v3_key.strip()
    if data.saas_wechat_platform_public_key is not None:
        updates["saas_wechat_platform_public_key"] = data.saas_wechat_platform_public_key.strip()
    if data.saas_wechat_gateway_url is not None:
        updates["saas_wechat_gateway_url"] = data.saas_wechat_gateway_url.strip() or "https://api.mch.weixin.qq.com"
    if data.saas_wechat_notify_url is not None:
        updates["saas_wechat_notify_url"] = data.saas_wechat_notify_url.strip()
    if data.saas_wechat_qr_url is not None:
        updates["saas_wechat_qr_url"] = data.saas_wechat_qr_url.strip()
    if data.saas_payment_notify_secret is not None and data.saas_payment_notify_secret.strip():
        updates["saas_payment_notify_secret"] = data.saas_payment_notify_secret.strip()

    if updates:
        set_settings_batch(updates)

    audit_details = data.model_dump(
        exclude_none=True,
        exclude={
            "saas_payment_notify_secret",
            "saas_alipay_private_key",
            "saas_wechat_private_key",
            "saas_wechat_api_v3_key",
        },
    )
    for k in ("saas_alipay_qr_url", "saas_wechat_qr_url", "saas_alipay_app_cert", "saas_alipay_cert_public_key", "saas_alipay_root_cert", "saas_alipay_public_key", "saas_wechat_platform_public_key"):
        v = audit_details.get(k)
        if isinstance(v, str) and len(v) > 256:
            audit_details[k] = f"[{len(v)} chars]"

    write_audit_log(
        action="admin_update_settings",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="platform_settings",
        target_id="saas_global",
        ip=get_client_ip(request),
        status="ok",
        details=audit_details,
    )
    return {
        "message": "平台策略与支付配置已保存生效",
        "updated_keys": len(updates),
        "settings": _build_admin_settings_payload(get_all_settings_map()),
    }


@router.get("/api/admin/users", summary="查看全部租户、邮箱认证、推荐关系、等级与钱包情况")
def admin_list_users(admin: dict = Depends(require_admin)):
    with session_scope(readonly=True) as db:
        plans_map = {p.id: p.name for p in db.query(Plan).all()}
        levels_map = {lv.id: lv for lv in db.query(UserLevel).all()}
        node_counts = dict(db.query(Node.owner_id, func.count(Node.id)).group_by(Node.owner_id).all())
        lease_counts = dict(
            db.query(NodeLease.buyer_id, func.count(NodeLease.id))
            .filter(NodeLease.status == "active")
            .group_by(NodeLease.buyer_id)
            .all()
        )
        invite_counts = dict(
            db.query(ReferralReward.inviter_id, func.count(ReferralReward.id))
            .group_by(ReferralReward.inviter_id)
            .all()
        )
        all_users = db.query(User).order_by(User.id.asc()).all()
        id_to_name = {u.id: u.username for u in all_users}
        users = []
        for u in all_users:
            d = u.to_dict(include_secrets=False)
            lv = levels_map.get(int(u.level_id or 1))
            d["plan_name"] = plans_map.get(u.plan_id, f"Plan#{u.plan_id}")
            d["level_code"] = lv.code if lv else "lv1"
            d["level_name"] = lv.name if lv else "Lv.1 青铜节点主"
            d["level_badge_color"] = lv.badge_color if lv else "#94a3b8"
            d["node_count"] = int(node_counts.get(u.id, 0))
            d["active_lease_count"] = int(lease_counts.get(u.id, 0))
            d["invited_count"] = int(invite_counts.get(u.id, 0))
            d["inviter_username"] = id_to_name.get(u.invited_by_id, "") if u.invited_by_id else ""
            users.append(d)
    return users


@router.get("/api/admin/referrals", summary="管理员查看全网推荐邀请返利明细与统计")
def admin_list_referrals(admin: dict = Depends(require_admin)):
    with session_scope() as db:
        id_to_name = {u.id: u.username for u in db.query(User.id, User.username).all()}
        total_inviter = db.query(func.coalesce(func.sum(ReferralReward.inviter_bonus_units), 0)).scalar() or 0
        total_invitee = db.query(func.coalesce(func.sum(ReferralReward.invitee_bonus_units), 0)).scalar() or 0
        total_cnt = db.query(ReferralReward).count()
        rows = db.query(ReferralReward).order_by(ReferralReward.id.desc()).limit(100).all()
        items = []
        for r in rows:
            d = r.to_dict()
            d["inviter_username"] = id_to_name.get(r.inviter_id, f"user#{r.inviter_id}")
            items.append(d)
    return {
        "summary": {
            "total_referrals": int(total_cnt),
            "total_inviter_bonus_yuan": units_to_yuan_str(int(total_inviter)),
            "total_invitee_bonus_yuan": units_to_yuan_str(int(total_invitee)),
        },
        "rewards": items,
    }


@router.post("/api/admin/users", summary="管理员后台新增租户或子管理员账号")
def admin_create_user(data: AdminUserCreateDTO, request: Request, admin: dict = Depends(require_admin)):
    uname = (data.username or "").strip()
    if not re.match(r"^[a-zA-Z0-9_.-]{3,32}$", uname):
        raise HTTPException(status_code=400, detail="用户名需为 3~32 位字母、数字、下划线或点号")
    if len(data.password or "") < 6:
        raise HTTPException(status_code=400, detail="密码至少需要 6 位")
    clean_email = (data.email or "").strip().lower()
    if clean_email and not _ADMIN_EMAIL_RE.match(clean_email):
        raise HTTPException(status_code=400, detail="邮箱格式不正确")
    role = data.role if data.role in {"user", "admin"} else "user"
    init_units = max(0, yuan_to_units(data.initial_balance_yuan or 0.0))
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with session_scope() as db:
        if db.query(User).filter(User.username == uname).first() is not None:
            raise HTTPException(status_code=400, detail="用户名已存在")
        if clean_email and db.query(User).filter(User.email == clean_email).first() is not None:
            raise HTTPException(status_code=400, detail="该邮箱已被其他账号使用")
        if db.get(Plan, int(data.plan_id)) is None:
            raise HTTPException(status_code=404, detail="目标套餐不存在")
        if db.get(UserLevel, int(data.level_id)) is None:
            raise HTTPException(status_code=404, detail="目标等级不存在")

        u = User(
            username=uname,
            email=clean_email or None,
            email_verified=1 if data.email_verified else 0,
            password_hash=hash_password(data.password),
            role=role,
            status="active",
            plan_id=int(data.plan_id),
            level_id=int(data.level_id),
            invite_code=issue_user_invite_code(),
            balance_units=init_units,
            total_recharged_units=init_units,
            api_key=issue_user_api_key(),
            cluster_join_token=issue_user_join_token(),
            created_at=now_str,
        )
        db.add(u)
        db.flush()

        if init_units > 0:
            db.add(
                BillingLedger(
                    user_id=u.id,
                    tx_type="admin_adjust",
                    amount_units=init_units,
                    balance_after_units=init_units,
                    platform_spread_units=0,
                    remark=f"管理员 {admin['username']} 建号初始授信",
                    created_at=now_str,
                )
            )
        db.add(
            SyncPolicy(
                owner_id=u.id,
                name="自有节点智能双向合并",
                enabled=1,
                interval_minutes=15,
                sync_type="smart_merge",
                source_type="all",
                target_type="all",
                created_at=now_str,
            )
        )
        db.flush()
        out = u.to_dict(include_secrets=False)

    reschedule_all_policies()
    write_audit_log(
        action="admin_create_user",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="user",
        target_id=out["id"],
        ip=get_client_ip(request),
        status="ok",
        details={"username": uname, "role": role, "initial_balance_yuan": units_to_yuan_str(init_units)},
    )
    return {"message": f"账号 [{uname}] 创建成功", "user": out}


@router.put("/api/admin/users/{uid}", summary="管理员调整租户状态、邮箱认证、密码、角色、套餐、等级或后台调账")
def admin_update_user(uid: int, data: AdminUserUpdateDTO, request: Request, admin: dict = Depends(require_admin)):
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with session_scope() as db:
        u = db.get(User, int(uid))
        if u is None:
            raise HTTPException(status_code=404, detail="目标用户不存在")
        if data.role in {"user", "admin"}:
            if int(u.id) == int(admin["id"]) and data.role != "admin":
                raise HTTPException(status_code=400, detail="不能降级当前操作者自己的管理员权限")
            u.role = data.role
        if data.status in {"active", "suspended"}:
            if int(u.id) == int(admin["id"]) and data.status != "active":
                raise HTTPException(status_code=400, detail="不能停用当前登录的管理员自身")
            u.status = data.status
        if data.email is not None:
            clean_email = data.email.strip().lower()
            if clean_email:
                if not _ADMIN_EMAIL_RE.match(clean_email):
                    raise HTTPException(status_code=400, detail="邮箱格式不正确")
                dup = db.query(User).filter(User.email == clean_email, User.id != u.id).first()
                if dup is not None:
                    raise HTTPException(status_code=400, detail="该邮箱已被其他账号绑定")
                u.email = clean_email
            else:
                u.email = None
        if data.email_verified is not None:
            u.email_verified = 1 if data.email_verified else 0
        if data.new_password is not None and data.new_password.strip():
            if len(data.new_password.strip()) < 6:
                raise HTTPException(status_code=400, detail="重置密码至少需要 6 位")
            u.password_hash = hash_password(data.new_password.strip())
        if data.plan_id is not None:
            if db.get(Plan, int(data.plan_id)) is None:
                raise HTTPException(status_code=404, detail="目标套餐不存在")
            u.plan_id = int(data.plan_id)
        if data.level_id is not None:
            target_lv = db.get(UserLevel, int(data.level_id))
            if target_lv is None:
                raise HTTPException(status_code=404, detail="目标等级不存在")
            u.level_id = target_lv.id
            u.last_level_change_reason = f"管理员 {admin['username']} 手动调整为 {target_lv.name}"
        if data.level_locked is not None:
            u.level_locked = 1 if data.level_locked else 0
            if not data.level_locked and data.level_id is None:
                u.last_level_change_reason = f"管理员 {admin['username']} 已解除等级锁定"
        if data.adjust_balance_yuan is not None and abs(data.adjust_balance_yuan) > 0:
            delta = yuan_to_units(data.adjust_balance_yuan)
            u.balance_units = max(0, int(u.balance_units or 0) + delta)
            if delta > 0:
                u.total_recharged_units = int(u.total_recharged_units or 0) + delta
            db.add(
                BillingLedger(
                    user_id=u.id,
                    tx_type="admin_adjust",
                    amount_units=delta,
                    balance_after_units=u.balance_units,
                    platform_spread_units=0,
                    remark=data.adjust_remark or f"管理员人工调账 ({units_to_yuan_str(delta)} 元)",
                    created_at=now_str,
                )
            )
        db.flush()
        out = u.to_dict(include_secrets=False)

    audit_details = data.model_dump(exclude_none=True, exclude={"new_password"})
    if data.new_password and data.new_password.strip():
        audit_details["password_reset"] = True
    write_audit_log(
        action="admin_update_user",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="user",
        target_id=uid,
        ip=get_client_ip(request),
        status="ok",
        details=audit_details,
    )
    return {"message": f"账号 [{out['username']}] 已更新", "user": out}


@router.delete("/api/admin/users/{uid}", summary="管理员安全删除空租户账号")
def admin_delete_user(uid: int, request: Request, admin: dict = Depends(require_admin)):
    if int(uid) == int(admin["id"]):
        raise HTTPException(status_code=400, detail="不能删除当前登录的管理员自身账号")

    with session_scope() as db:
        u = db.get(User, int(uid))
        if u is None:
            raise HTTPException(status_code=404, detail="目标用户不存在")
        active_leases = (
            db.query(NodeLease)
            .filter(
                NodeLease.status == "active",
                or_(NodeLease.buyer_id == u.id, NodeLease.seller_id == u.id),
            )
            .count()
        )
        if active_leases > 0:
            raise HTTPException(status_code=409, detail="该用户仍有进行中的市场租约，请先在租赁风控中强断结算后再删除")
        owned_nodes = db.query(Node).filter(Node.owner_id == u.id).count()
        if owned_nodes > 0:
            raise HTTPException(status_code=409, detail=f"该用户名下仍绑定 {owned_nodes} 个节点，请先停用封禁或等待节点清理后再删除")

        uname = u.username
        db.query(User).filter(User.invited_by_id == u.id).update({User.invited_by_id: None}, synchronize_session=False)
        db.query(SyncPolicy).filter(SyncPolicy.owner_id == u.id).delete(synchronize_session=False)
        db.query(SyncLog).filter(SyncLog.owner_id == u.id).delete(synchronize_session=False)
        db.query(BillingLedger).filter(BillingLedger.user_id == u.id).delete(synchronize_session=False)
        db.query(RechargeOrder).filter(RechargeOrder.user_id == u.id).delete(synchronize_session=False)
        db.query(TrafficStat).filter(TrafficStat.owner_id == u.id).delete(synchronize_session=False)
        db.query(ReferralReward).filter(or_(ReferralReward.inviter_id == u.id, ReferralReward.invitee_id == u.id)).delete(synchronize_session=False)
        db.delete(u)

    reschedule_all_policies()
    write_audit_log(
        action="admin_delete_user",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="user",
        target_id=uid,
        ip=get_client_ip(request),
        status="ok",
        details={"username": uname},
    )
    return {"message": f"账号 [{uname}] 已移除"}


@router.get("/api/admin/levels", summary="获取全部用户等级及分通道差价配置")
def admin_list_levels(admin: dict = Depends(require_admin)):
    with session_scope() as db:
        return [lv.to_dict() for lv in db.query(UserLevel).order_by(UserLevel.rank_order.asc()).all()]


@router.put("/api/admin/levels/{level_id}", summary="调整指定用户等级的升降级门槛与分通道平台差价")
def admin_update_level(level_id: int, data: AdminLevelUpdateDTO, request: Request, admin: dict = Depends(require_admin)):
    with session_scope() as db:
        lv = db.get(UserLevel, int(level_id))
        if lv is None:
            raise HTTPException(status_code=404, detail="等级配置不存在")
        if data.name is not None:
            lv.name = data.name.strip()[:64]
        if data.badge_color is not None:
            lv.badge_color = data.badge_color.strip()[:32]
        if data.min_online_hours is not None:
            lv.min_online_hours = max(0, int(data.min_online_hours))
        if data.min_contributed_gb is not None:
            lv.min_contributed_gb = max(0, int(data.min_contributed_gb))
        if data.max_avg_latency_ms is not None:
            lv.max_avg_latency_ms = max(0, int(data.max_avg_latency_ms))
        if data.min_speed_kbps is not None:
            lv.min_speed_kbps = max(0, int(data.min_speed_kbps))
        if data.reverse_fee_bps is not None:
            lv.reverse_fee_bps = max(0, min(10000, int(data.reverse_fee_bps)))
        if data.public_wss_fee_bps is not None:
            lv.public_wss_fee_bps = max(0, min(10000, int(data.public_wss_fee_bps)))
        if data.buyer_discount_bps is not None:
            lv.buyer_discount_bps = max(0, min(10000, int(data.buyer_discount_bps)))
        if data.description is not None:
            lv.description = data.description.strip()[:255]
        db.flush()
        saved = lv.to_dict()

    write_audit_log(
        action="admin_update_level",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="user_level",
        target_id=level_id,
        ip=get_client_ip(request),
        status="ok",
        details=saved,
    )
    return {"message": f"等级 [{saved['name']}] 门槛与差价已保存", "level": saved}


@router.post("/api/admin/levels/evaluate", summary="立即对全网用户执行一次自动评级/降级检查")
def admin_evaluate_levels_now(request: Request, admin: dict = Depends(require_admin), user_id: Optional[int] = None):
    if user_id is not None:
        res = evaluate_user_level_sync(int(user_id), actor_username=admin["username"])
        if res is None:
            raise HTTPException(status_code=404, detail="目标用户不存在或未激活")
        msg = f"已完成对用户 {res['username']} 的评级检查 ({res['direction']})"
    else:
        res = evaluate_all_users_levels_sync(actor_username=admin["username"])
        msg = f"已评估 {res['evaluated']} 位租户：升级 {res['upgrades']} 人，降级 {res['demotes']} 人"

    write_audit_log(
        action="admin_evaluate_levels",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="user_levels",
        target_id=str(user_id or "all"),
        ip=get_client_ip(request),
        status="ok",
        details=res,
    )
    return {"message": msg, "result": res}


@router.put("/api/admin/plans/{pid}", summary="调整套餐月价、节点配额与抽成折扣")
def admin_update_plan(pid: int, data: AdminPlanUpdateDTO, request: Request, admin: dict = Depends(require_admin)):
    with session_scope() as db:
        p = db.get(Plan, int(pid))
        if p is None:
            raise HTTPException(status_code=404, detail="套餐不存在")
        if data.name is not None:
            p.name = data.name.strip()[:128]
        if data.monthly_price_yuan is not None:
            p.monthly_price_units = max(0, yuan_to_units(data.monthly_price_yuan))
        if data.max_nodes is not None:
            p.max_nodes = max(1, int(data.max_nodes))
        if data.max_active_leases is not None:
            p.max_active_leases = max(1, int(data.max_active_leases))
        if data.max_monthly_traffic_gb is not None:
            p.max_monthly_traffic_bytes = max(1, int(data.max_monthly_traffic_gb * 1024 * 1024 * 1024))
        if data.platform_fee_discount_bps is not None:
            p.platform_fee_discount_bps = max(0, min(10000, int(data.platform_fee_discount_bps)))
        if data.can_share_nodes is not None:
            p.can_share_nodes = 1 if data.can_share_nodes else 0
        db.flush()
        saved = p.to_dict()

    write_audit_log(
        action="admin_update_plan",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="plan",
        target_id=pid,
        ip=get_client_ip(request),
        status="ok",
        details=saved,
    )
    return {"message": "套餐配置已保存", "plan": saved}


@router.post("/api/admin/leases/{lease_id}/revoke", summary="管理员风控强制中止异常租约并立即结算断流")
async def admin_revoke_lease(lease_id: int, request: Request, admin: dict = Depends(require_admin)):
    client_ip = get_client_ip(request)
    lease_dict, need_dc = settle_single_lease_sync(
        lease_id=lease_id,
        force_end_status="revoked",
        end_reason="管理员风控强制中止",
        actor_id=int(admin["id"]),
        client_ip=client_ip,
    )
    if need_dc:
        await tunnel_mgr.disconnect_lease_streams(int(lease_dict["node_id"]), int(lease_id))
    return {"message": f"租约 #{lease_id} 已被强制中止并完成尾款结算", "lease": lease_dict}


@router.get("/api/admin/recharges", summary="管理员查看全网支付宝 / 微信充值订单")
def admin_list_recharges(admin: dict = Depends(require_admin)):
    with session_scope() as db:
        users_map = {u.id: u.username for u in db.query(User.id, User.username).all()}
        rows = db.query(RechargeOrder).order_by(RechargeOrder.id.desc()).limit(100).all()
        items = []
        for r in rows:
            d = r.to_dict()
            d["username"] = users_map.get(r.user_id, f"user#{r.user_id}")
            items.append(d)
    return {"orders": items}


@router.post("/api/admin/recharges/{order_id}/confirm", summary="管理员人工核账确认充值订单到账")
def admin_confirm_recharge(order_id: int, request: Request, admin: dict = Depends(require_admin)):
    with session_scope() as db:
        order = db.get(RechargeOrder, int(order_id))
        if order is None:
            raise HTTPException(status_code=404, detail="充值订单不存在")
        res = _mark_recharge_order_paid_sync(
            db,
            order_no=order.order_no,
            expected_channel=None,
            external_trade_no=f"ADMIN-{admin['username']}-{order.id}",
            paid_remark=f"管理员 {admin['username']} 人工确认 {order.channel.upper()} 充值到账 ({order.order_no})",
        )

    if not res["already_paid"]:
        write_audit_log(
            action="admin_confirm_recharge",
            actor_id=admin["id"],
            actor_username=admin["username"],
            target_type="recharge_order",
            target_id=res["order"]["order_no"],
            ip=get_client_ip(request),
            status="ok",
            details={"amount_yuan": res["order"]["amount_yuan"], "channel": res["order"]["channel"]},
        )
    return {
        "message": "该订单此前已入账（幂等返回）" if res["already_paid"] else f"已确认订单 {res['order']['order_no']} 到账 ¥{res['order']['amount_yuan']}",
        "already_paid": res["already_paid"],
        "order": res["order"],
    }


@router.post("/api/admin/recharges/{order_id}/query", summary="管理员向支付宝 / 微信官方网关主动查单并同步入账/关单")
async def admin_query_recharge(order_id: int, request: Request, admin: dict = Depends(require_admin)):
    with session_scope() as db:
        order = db.get(RechargeOrder, int(order_id))
        if order is None:
            raise HTTPException(status_code=404, detail="充值订单不存在")
        order_payload = order.to_dict()

    if order_payload["status"] == "paid":
        return {"message": "该订单早已完成入账", "order": order_payload, "paid": True}
    if order_payload["status"] == "refunded":
        return {"message": "该订单已冲正退款，无法继续查单入账", "order": order_payload, "paid": False}

    ch = order_payload["channel"]
    try:
        if ch == "alipay":
            q_res = await query_alipay_order(order_payload["order_no"], _get_alipay_gateway_cfg())
        else:
            q_res = await query_wechat_order(order_payload["order_no"], _get_wechat_gateway_cfg())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"官方查单失败: {exc}")

    if not q_res.get("supported"):
        raise HTTPException(status_code=400, detail=f"尚未配置 {ch.upper()} 官方 API 查单密钥")

    if not q_res.get("paid"):
        status_hint = q_res.get("trade_status") or q_res.get("trade_state") or q_res.get("sub_msg") or "未支付"
        if status_hint in {"TRADE_CLOSED", "CLOSED"} and order_payload["status"] == "pending":
            with session_scope() as db:
                row = db.get(RechargeOrder, int(order_id))
                if row is not None and row.status == "pending":
                    row.status = "cancelled"
                    row.remark = f"{(row.remark + ' | ') if row.remark else ''}官方网关状态 {status_hint} 自动关闭"[:255]
                    db.flush()
                    order_payload = row.to_dict()
            return {"message": f"官方网关返回交易已关闭 ({status_hint})，订单已同步标记为已取消", "order": order_payload, "paid": False}
        return {"message": f"官方网关返回当前未支付 ({status_hint})", "order": order_payload, "paid": False}

    ext_no = q_res.get("trade_no") or f"{ch.upper()}-{order_payload['order_no']}"
    with session_scope() as db:
        res = _mark_recharge_order_paid_sync(
            db,
            order_no=order_payload["order_no"],
            expected_channel=ch,
            external_trade_no=ext_no,
            paid_remark=f"管理员 {admin['username']} 触发 {ch.upper()} 查单同步到账 ({order_payload['order_no']})",
            allow_cancelled=True,
        )
    if not res["already_paid"]:
        write_audit_log(
            action="admin_query_recharge_paid",
            actor_id=admin["id"],
            actor_username=admin["username"],
            target_type="recharge_order",
            target_id=res["order"]["order_no"],
            ip=get_client_ip(request),
            status="ok",
            details={"channel": ch, "amount_yuan": res["order"]["amount_yuan"], "trade_no": ext_no},
        )
    return {
        "message": f"官方网关确认已支付，订单 {res['order']['order_no']} 已入账 ¥{res['order']['amount_yuan']}",
        "order": res["order"],
        "paid": True,
    }


@router.post("/api/admin/recharges/{order_id}/cancel", summary="管理员关闭/取消未支付充值订单")
def admin_cancel_recharge(order_id: int, request: Request, admin: dict = Depends(require_admin)):
    with session_scope() as db:
        order = db.get(RechargeOrder, int(order_id))
        if order is None:
            raise HTTPException(status_code=404, detail="充值订单不存在")
        if order.status == "paid":
            raise HTTPException(status_code=400, detail="该订单已入账，如需撤回请使用「冲正退款」")
        if order.status == "cancelled":
            return {"message": f"订单 {order.order_no} 已处于取消状态", "order": order.to_dict()}
        if order.status != "pending":
            raise HTTPException(status_code=400, detail=f"订单状态为 {order.status}，无法取消")

        order.status = "cancelled"
        order.remark = f"{(order.remark + ' | ') if order.remark else ''}管理员 {admin['username']} 手动关闭"[:255]
        db.flush()
        order_payload = order.to_dict()

    write_audit_log(
        action="admin_cancel_recharge",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="recharge_order",
        target_id=order_payload["order_no"],
        ip=get_client_ip(request),
        status="ok",
        details={"amount_yuan": order_payload["amount_yuan"], "channel": order_payload["channel"]},
    )
    return {"message": f"已关闭未支付订单 {order_payload['order_no']}", "order": order_payload}


@router.post("/api/admin/recharges/{order_id}/refund", summary="管理员对已入账充值订单执行冲正退款")
def admin_refund_recharge(order_id: int, request: Request, admin: dict = Depends(require_admin)):
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with session_scope() as db:
        order = db.get(RechargeOrder, int(order_id))
        if order is None:
            raise HTTPException(status_code=404, detail="充值订单不存在")
        if order.status == "refunded":
            raise HTTPException(status_code=400, detail="该订单已完成冲正退款，请勿重复操作")
        if order.status != "paid":
            raise HTTPException(status_code=400, detail=f"仅已入账 (paid) 订单可执行冲正退款，当前状态: {order.status}")

        deduct_units = int(order.amount_units or 0)
        affected_order = (
            db.query(RechargeOrder)
            .filter(RechargeOrder.id == int(order_id), RechargeOrder.status == "paid")
            .update({RechargeOrder.status: "refunded"}, synchronize_session=False)
        )
        if affected_order == 0:
            raise HTTPException(status_code=409, detail="订单状态已变化，请刷新后重试")

        affected_user = (
            db.query(User)
            .filter(User.id == int(order.user_id), User.balance_units >= deduct_units)
            .update(
                {
                    User.balance_units: User.balance_units - deduct_units,
                    User.total_recharged_units: case(
                        (User.total_recharged_units >= deduct_units, User.total_recharged_units - deduct_units),
                        else_=0,
                    ),
                },
                synchronize_session=False,
            )
        )
        if affected_user == 0:
            raise HTTPException(
                status_code=400,
                detail="该租户当前可用余额不足以全额冲正（可能已部分消费），请在「用户管理」中人工调账",
            )

        db.expire_all()
        order = db.get(RechargeOrder, int(order_id))
        u = db.get(User, int(order.user_id))
        order.remark = f"{(order.remark + ' | ') if order.remark else ''}管理员 {admin['username']} 冲正退款"[:255]
        db.add(
            BillingLedger(
                user_id=u.id,
                tx_type="recharge_refund",
                amount_units=-deduct_units,
                balance_after_units=int(u.balance_units or 0),
                platform_spread_units=0,
                remark=f"管理员 {admin['username']} 冲正退款充值订单 ({order.order_no})",
                created_at=now_str,
            )
        )
        db.flush()
        order_payload = order.to_dict()

    write_audit_log(
        action="admin_refund_recharge",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="recharge_order",
        target_id=order_payload["order_no"],
        ip=get_client_ip(request),
        status="ok",
        details={"amount_yuan": order_payload["amount_yuan"], "channel": order_payload["channel"]},
    )
    return {"message": f"已完成订单 {order_payload['order_no']} 冲正退款（-¥{order_payload['amount_yuan']}）", "order": order_payload}


@router.delete("/api/admin/recharges/{order_id}", summary="管理员清理已取消的无效充值订单记录")
def admin_delete_cancelled_recharge(order_id: int, request: Request, admin: dict = Depends(require_admin)):
    with session_scope() as db:
        order = db.get(RechargeOrder, int(order_id))
        if order is None:
            raise HTTPException(status_code=404, detail="充值订单不存在")
        if order.status != "cancelled":
            raise HTTPException(status_code=400, detail="出于财务审计安全，仅允许删除「已取消 (cancelled)」的无效订单记录")
        order_no = order.order_no
        amount_yuan = units_to_yuan_str(order.amount_units or 0)
        db.delete(order)
        db.flush()

    write_audit_log(
        action="admin_delete_recharge",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="recharge_order",
        target_id=order_no,
        ip=get_client_ip(request),
        status="ok",
        details={"amount_yuan": amount_yuan},
    )
    return {"message": f"已删除已取消的订单记录 {order_no}"}


@router.get("/api/system/cache/status", summary="实时获取当前缓存引擎状态（SQL Cache / Redis / 降级状态）")
def admin_cache_status(admin: dict = Depends(require_admin)):
    return cache_mgr.get_status()


@router.post("/api/system/cache/test", summary="在线执行 Redis PING 连通性测试（Admin）")
def admin_test_cache_redis(data: RedisTestDTO, admin: dict = Depends(require_admin)):
    return cache_mgr.test_target(
        data.redis_url,
        use_current=bool(data.use_current),
        redis_host=data.redis_host,
        redis_port=data.redis_port,
        redis_db=data.redis_db,
        redis_username=data.redis_username,
        redis_password=data.redis_password,
        redis_tls=bool(data.redis_tls),
        keep_password=bool(data.keep_password),
        clear_password=bool(data.clear_password),
        key_prefix=data.key_prefix,
    )


@router.post("/api/system/cache/reload", summary="一键热切换并持久化缓存引擎配置（Admin）")
def admin_reload_cache(data: RedisReloadDTO, request: Request, admin: dict = Depends(require_admin)):
    if data.reconnect_only:
        res = cache_mgr.probe_reconnect()
        write_audit_log(
            action="admin_cache_reconnect",
            actor_id=admin["id"],
            actor_username=admin["username"],
            target_type="system",
            target_id="cache_engine",
            ip=get_client_ip(request),
            status="ok" if res.get("ok") else "degraded",
            details={
                "engine_state": (res.get("cache") or {}).get("engine_state"),
                "redis_url_masked": (res.get("cache") or {}).get("redis_url_masked"),
                "key_prefix": (res.get("cache") or {}).get("key_prefix"),
            },
        )
        return res

    mode = (data.mode or "").strip().lower()
    if mode in {"sqlite", "sqlite_cache", "sql"}:
        try:
            key_prefix = normalize_key_prefix(
                data.key_prefix if data.key_prefix is not None else cache_mgr.get_key_prefix(),
                strict=True,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        new_cfg = None
        new_url = ""
    else:
        try:
            new_cfg, key_prefix = cache_mgr.resolve_target_config(
                redis_url=data.redis_url,
                redis_host=data.redis_host,
                redis_port=data.redis_port,
                redis_db=data.redis_db,
                redis_username=data.redis_username,
                redis_password=data.redis_password,
                redis_tls=bool(data.redis_tls),
                keep_password=bool(data.keep_password),
                clear_password=bool(data.clear_password),
                use_current=bool(data.use_current),
                key_prefix=data.key_prefix,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if mode == "redis" and not new_cfg:
            raise HTTPException(status_code=400, detail="请填写 Redis 主机地址或连接 URL")
        new_url = build_encoded_redis_url(new_cfg) if new_cfg else ""

    boot = load_bootstrap_config()
    boot["redis_url"] = new_url
    boot["redis_config"] = new_cfg
    boot["redis_key_prefix"] = key_prefix
    save_bootstrap_config(boot)
    cache_mgr.reload_from_config(
        redis_url="" if not new_cfg else None,
        source="bootstrap",
        redis_config=new_cfg,
        key_prefix=key_prefix,
    )
    status = cache_mgr.get_status()

    if status["engine_state"] == "redis":
        info = status.get("redis_info") or {}
        ver = info.get("version") or "?"
        ping_ms = info.get("ping_ms")
        lat_txt = f", {ping_ms}ms" if ping_ms is not None else ""
        msg = f"已热切换并保存为 Redis 高速缓存 (v{ver}{lat_txt} · 命名空间 {status.get('key_prefix')})"
        ok = True
    elif status["engine_state"] == "degraded":
        msg = f"Redis 配置已保存（前缀 {status.get('key_prefix')}），但当前连接失败 ({status.get('last_error') or '不可达'})，已自动降级至 SQLite WAL Cache 兜底"
        ok = False
    else:
        msg = "已热切换并保存为内置 SQLite WAL Cache"
        ok = True

    write_audit_log(
        action="admin_reload_cache",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="system",
        target_id="cache_engine",
        ip=get_client_ip(request),
        status="ok" if ok else "degraded",
        details={
            "mode": mode or ("redis" if new_cfg else "sqlite_cache"),
            "engine_state": status.get("engine_state"),
            "active_backend": status.get("active_backend"),
            "degraded": bool(status.get("degraded", False)),
            "redis_url_masked": status.get("redis_url_masked", ""),
            "key_prefix": status.get("key_prefix", ""),
        },
    )
    return {
        "ok": ok,
        "degraded": bool(status.get("degraded", False)),
        "message": msg,
        "cache": status,
    }


@router.get("/api/admin/geoip/status", summary="查看 geoip.dat 地理库加载状态（Admin）")
def admin_geoip_status(admin: dict = Depends(require_admin)):
    return get_geoip_status()


@router.post("/api/admin/geoip/update", summary="从镜像源在线下载并热更新 geoip.dat（Admin）")
def admin_geoip_update(data: GeoipUpdateDTO, request: Request, admin: dict = Depends(require_admin)):
    try:
        status = download_geoip_dat(custom_url=data.url or None)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    write_audit_log(
        action="admin_geoip_update",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="system",
        target_id="geoip_dat",
        ip=get_client_ip(request),
        status="ok",
        details={
            "path": status.get("path"),
            "country_count": status.get("country_count"),
            "ipv4_cidr_count": status.get("ipv4_cidr_count"),
            "ipv6_cidr_count": status.get("ipv6_cidr_count"),
        },
    )
    return {
        "message": f"geoip.dat 已更新并加载（{status.get('country_count', 0)} 个国家/地区，{status.get('ipv4_cidr_count', 0)} IPv4 CIDR）",
        "geoip": status,
    }
