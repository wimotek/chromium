import asyncio
from datetime import datetime
import math
import secrets
from typing import Any, Dict, List, Optional, Tuple

from config import logger
from core.db import get_setting, session_scope
from core.models import BillingLedger, Node, NodeLease, Plan, User, UserLevel, units_to_yuan_str
from modules.audit.service import write_audit_log
from modules.nodes.traffic_service import (
    drain_lease_unbilled_bytes,
    drain_self_reverse_unbilled_bytes,
    list_pending_self_reverse_owner_ids,
)

BYTES_PER_GB = 1024 * 1024 * 1024
SHAREABLE_CHANNELS = {"reverse", "public_wss"}


def normalize_billing_channel(conn_type: Optional[str]) -> str:
    ct = (conn_type or "reverse").strip().lower()
    if ct in ("public_wss", "wss_direct"):
        return "public_wss"
    if ct == "reverse":
        return "reverse"
    return "unsupported"


def is_shareable_conn_type(conn_type: Optional[str]) -> bool:
    return normalize_billing_channel(conn_type) in SHAREABLE_CHANNELS


def get_platform_fee_bps() -> int:
    try:
        val = int(get_setting("saas_reverse_fee_bps", get_setting("saas_platform_fee_bps", "2500")) or 2500)
        return max(0, min(10000, val))
    except ValueError:
        return 2500


def get_channel_base_fee_bps(conn_type: Optional[str]) -> int:
    ch = normalize_billing_channel(conn_type)
    if ch == "public_wss":
        raw = get_setting("saas_public_wss_fee_bps", "1000")
        default = 1000
    else:
        raw = get_setting("saas_reverse_fee_bps", get_setting("saas_platform_fee_bps", "2500"))
        default = 2500
    try:
        return max(0, min(10000, int(raw if raw != "" else default)))
    except ValueError:
        return default


def get_all_channel_fee_bps() -> Dict[str, int]:
    return {
        "reverse": get_channel_base_fee_bps("reverse"),
        "public_wss": get_channel_base_fee_bps("public_wss"),
    }


def get_self_reverse_hub_gb_units() -> int:
    try:
        return max(0, int(get_setting("saas_self_reverse_hub_gb_units", "2000") or 0))
    except ValueError:
        return 2000


def get_market_base_hour_units() -> int:
    try:
        return max(0, int(get_setting("saas_market_base_hour_units", "5000") or 5000))
    except ValueError:
        return 5000


def get_market_base_gb_units() -> int:
    try:
        return max(0, int(get_setting("saas_market_base_gb_units", "10000") or 10000))
    except ValueError:
        return 10000


def evaluate_node_quality_tier(avg_latency_ms: int, avg_speed_kbps: int) -> Dict[str, Any]:
    lat = max(0, int(avg_latency_ms or 0))
    spd = max(0, int(avg_speed_kbps or 0))
    if 0 < lat <= 120 and spd >= 300:
        grade, label, bonus_bps = "S", "S级 · 极速优质", 2500
    elif (0 < lat <= 250 and spd >= 100) or (0 < lat <= 120 and spd == 0):
        grade, label, bonus_bps = "A", "A级 · 高速稳定", 1500
    elif (0 < lat <= 500) or spd >= 40:
        grade, label, bonus_bps = "B", "B级 · 标准可用", 500
    else:
        grade, label, bonus_bps = "C", "C级 · 基础/待测", 0
    return {
        "grade": grade,
        "label": label,
        "bonus_bps": bonus_bps,
        "avg_latency_ms": lat,
        "avg_speed_kbps": spd,
    }


def get_seller_level_gb_bonus_bps(seller_level: Optional[UserLevel]) -> int:
    rank = int(seller_level.rank_order or 1) if seller_level else 1
    if rank <= 1:
        return 0
    if rank == 2:
        return 1000
    if rank == 3:
        return 2000
    if rank == 4:
        return 3500
    return min(5000, (rank - 1) * 1000)


def _round_to_fen_units(raw_units: int) -> int:
    return ((raw_units + 50) // 100) * 100 if raw_units > 0 else 0


def compute_node_seller_pricing(
    node: Node,
    seller_level: Optional[UserLevel] = None,
    base_hour_units: Optional[int] = None,
    base_gb_units: Optional[int] = None,
) -> Dict[str, Any]:
    base_hr = get_market_base_hour_units() if base_hour_units is None else max(0, int(base_hour_units))
    base_gb = get_market_base_gb_units() if base_gb_units is None else max(0, int(base_gb_units))
    level_bonus_bps = get_seller_level_gb_bonus_bps(seller_level)
    quality = evaluate_node_quality_tier(
        getattr(node, "avg_latency_ms", 0),
        getattr(node, "avg_speed_kbps", 0),
    )
    quality_bonus_bps = int(quality["bonus_bps"])
    total_bonus_bps = level_bonus_bps + quality_bonus_bps
    mult = (10000 + total_bonus_bps) / 10000.0
    seller_hour_units = _round_to_fen_units(int(round(base_hr * mult)))
    seller_gb_units = _round_to_fen_units(int(round(base_gb * mult)))
    return {
        "base_hour_units": base_hr,
        "base_hour_yuan": units_to_yuan_str(base_hr),
        "base_gb_units": base_gb,
        "base_gb_yuan": units_to_yuan_str(base_gb),
        "seller_level_code": seller_level.code if seller_level else "lv1",
        "seller_level_name": seller_level.name if seller_level else "Lv.1 青铜节点主",
        "seller_level_rank": int(seller_level.rank_order or 1) if seller_level else 1,
        "level_bonus_bps": level_bonus_bps,
        "quality_grade": quality["grade"],
        "quality_label": quality["label"],
        "quality_bonus_bps": quality_bonus_bps,
        "total_bonus_bps": total_bonus_bps,
        "seller_hour_units": seller_hour_units,
        "seller_hour_yuan": units_to_yuan_str(seller_hour_units),
        "seller_gb_units": seller_gb_units,
        "seller_gb_yuan": units_to_yuan_str(seller_gb_units),
        "avg_latency_ms": quality["avg_latency_ms"],
        "avg_speed_kbps": quality["avg_speed_kbps"],
    }


def compute_node_seller_gb_pricing(
    node: Node,
    seller_level: Optional[UserLevel] = None,
    base_gb_units: Optional[int] = None,
) -> Dict[str, Any]:
    return compute_node_seller_pricing(node, seller_level=seller_level, base_gb_units=base_gb_units)


def resolve_channel_platform_fee_bps(
    conn_type: Optional[str],
    seller_level: Optional[UserLevel] = None,
    fallback_fees: Optional[Dict[str, int]] = None,
) -> int:
    ch = normalize_billing_channel(conn_type)
    if seller_level is not None:
        if ch == "public_wss" and seller_level.public_wss_fee_bps is not None:
            return max(0, min(10000, int(seller_level.public_wss_fee_bps)))
        if ch == "reverse" and seller_level.reverse_fee_bps is not None:
            return max(0, min(10000, int(seller_level.reverse_fee_bps)))
    if fallback_fees is not None:
        default_val = fallback_fees.get("reverse", 2500)
        return max(0, min(10000, int(fallback_fees.get(ch, default_val))))
    return 1000 if ch == "public_wss" else 2500


def compute_buyer_price_units(
    seller_price_units: int,
    platform_fee_bps: int,
    buyer_discount_bps: int = 0,
) -> Tuple[int, int, int]:
    seller = max(0, int(seller_price_units or 0))
    eff_bps = max(0, int(platform_fee_bps or 0) - max(0, int(buyer_discount_bps or 0)))
    if seller == 0 or eff_bps == 0:
        return seller, eff_bps, 0
    spread = int(math.ceil(seller * eff_bps / 10000.0))
    return seller + spread, eff_bps, spread


def compute_lease_cost_deltas(
    seller_hour_units: int,
    buyer_hour_units: int,
    seller_gb_units: int,
    buyer_gb_units: int,
    prev_billed_seconds: int,
    add_seconds: int,
    prev_billed_bytes: int,
    add_bytes: int,
    already_buyer_spent: int,
    already_seller_earned: int,
) -> Tuple[int, int, int, int, int]:
    new_sec = max(0, int(prev_billed_seconds)) + max(0, int(add_seconds))
    new_bytes = max(0, int(prev_billed_bytes)) + max(0, int(add_bytes))

    cum_buyer = (int(buyer_hour_units) * new_sec) // 3600 + (int(buyer_gb_units) * new_bytes) // BYTES_PER_GB
    cum_seller = (int(seller_hour_units) * new_sec) // 3600 + (int(seller_gb_units) * new_bytes) // BYTES_PER_GB

    buyer_delta = max(0, cum_buyer - int(already_buyer_spent))
    seller_delta = max(0, cum_seller - int(already_seller_earned))
    if seller_delta > buyer_delta:
        seller_delta = buyer_delta
    profit_delta = buyer_delta - seller_delta
    return buyer_delta, seller_delta, profit_delta, new_sec, new_bytes


def start_lease_sync(buyer_id: int, node_id: int, client_ip: str = "unknown") -> Dict[str, Any]:
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ch_fees = get_all_channel_fee_bps()
    base_hour_units = get_market_base_hour_units()
    base_gb_units = get_market_base_gb_units()

    with session_scope() as db:
        buyer = db.get(User, int(buyer_id))
        if buyer is None or buyer.status != "active":
            raise ValueError("买家账号不存在或已被停用")

        plan = db.get(Plan, buyer.plan_id)
        buyer_level = db.get(UserLevel, int(buyer.level_id or 1))
        max_leases = int(plan.max_active_leases) if plan else 2
        discount_bps = (int(plan.platform_fee_discount_bps) if plan else 0) + (
            int(buyer_level.buyer_discount_bps) if buyer_level else 0
        )

        active_buyer_leases = (
            db.query(NodeLease)
            .filter(NodeLease.buyer_id == buyer.id, NodeLease.status == "active")
            .count()
        )
        if active_buyer_leases >= max_leases:
            raise PermissionError(f"已达到当前套餐并发租用上限 ({active_buyer_leases}/{max_leases})，请升级套餐或退租空闲节点")

        node = db.get(Node, int(node_id))
        if node is None or node.enabled == 0:
            raise LookupError("目标节点不存在或已被下线")
        if (node.client_type or "").lower() == "android" or node.api_enabled == 0:
            raise PermissionError("该节点未开放第三方 CDP 控制能力")
        if not is_shareable_conn_type(node.conn_type):
            raise PermissionError("SaaS 版仅支持公网 WSS 直连或 WSS 反向穿透节点上架共享")
        if int(node.share_enabled or 0) != 1:
            raise PermissionError("该节点未上架至共享节点市场")
        if int(node.owner_id) == int(buyer.id):
            raise ValueError("不能租用自己名下的节点（请直接从「我的节点」接入控制）")
        if node.status != "connected":
            raise ValueError("目标共享节点当前离线，暂不可租用")
        if int(node.active_lease_count or 0) >= max(1, int(node.max_concurrent_leases or 1)):
            raise ValueError("目标节点租约并发槽位已满，请选择其他共享节点")

        seller = db.get(User, int(node.owner_id))
        seller_level = db.get(UserLevel, int(seller.level_id or 1)) if seller else None
        channel_name = normalize_billing_channel(node.conn_type)
        channel_fee_bps = resolve_channel_platform_fee_bps(node.conn_type, seller_level, fallback_fees=ch_fees)

        pricing = compute_node_seller_pricing(
            node,
            seller_level,
            base_hour_units=base_hour_units,
            base_gb_units=base_gb_units,
        )
        seller_hour_units = int(pricing["seller_hour_units"])
        seller_gb_units = int(pricing["seller_gb_units"])
        if int(node.seller_price_per_hour_units or 0) != seller_hour_units:
            node.seller_price_per_hour_units = seller_hour_units
        if int(node.seller_price_per_gb_units or 0) != seller_gb_units:
            node.seller_price_per_gb_units = seller_gb_units

        buyer_hour, eff_bps, _ = compute_buyer_price_units(
            seller_hour_units, channel_fee_bps, discount_bps
        )
        buyer_gb, _, _ = compute_buyer_price_units(
            seller_gb_units, channel_fee_bps, discount_bps
        )

        min_reserve = max(1, buyer_hour // 60) if (buyer_hour > 0 or buyer_gb > 0) else 0
        if int(buyer.balance_units or 0) < max(min_reserve, 1 if (buyer_hour > 0 or buyer_gb > 0) else 0):
            raise ValueError(f"钱包余额不足（当前 ¥{units_to_yuan_str(buyer.balance_units)}），请先充值后再租用")

        lease_tok = "lse_" + secrets.token_urlsafe(16)
        lease = NodeLease(
            node_id=node.id,
            seller_id=node.owner_id,
            buyer_id=buyer.id,
            status="active",
            lease_token=lease_tok,
            isolation_profile_id="pending",
            channel_type=channel_name,
            seller_level_code=seller_level.code if seller_level else "lv1",
            seller_hour_units=seller_hour_units,
            buyer_hour_units=buyer_hour,
            seller_gb_units=seller_gb_units,
            buyer_gb_units=buyer_gb,
            platform_fee_bps=eff_bps,
            started_at=now_str,
            last_billed_at=now_str,
        )
        db.add(lease)
        db.flush()
        lease.isolation_profile_id = f"iso_l{lease.id}_{lease_tok[4:10]}"
        node.active_lease_count = int(node.active_lease_count or 0) + 1
        db.flush()
        result = lease.to_dict()
        result["node_name"] = node.name
        result["buyer_username"] = buyer.username

    write_audit_log(
        action="lease_start",
        actor_id=buyer_id,
        actor_username=result["buyer_username"],
        target_type="node_lease",
        target_id=result["id"],
        ip=client_ip,
        status="ok",
        details={
            "node_id": node_id,
            "channel_type": result["channel_type"],
            "seller_level": result["seller_level_code"],
            "effective_fee_bps": result["platform_fee_bps"],
            "buyer_hour_yuan": result["buyer_hour_yuan"],
            "buyer_gb_yuan": result["buyer_gb_yuan"],
            "isolation_profile_id": result["isolation_profile_id"],
        },
    )
    return result


def settle_single_lease_sync(
    lease_id: int,
    force_end_status: str = "",
    end_reason: str = "",
    actor_id: int = 0,
    client_ip: str = "system",
) -> Tuple[Dict[str, Any], bool]:
    now_dt = datetime.now()
    now_str = now_dt.strftime("%Y-%m-%d %H:%M:%S")
    unbilled_bytes = drain_lease_unbilled_bytes(lease_id)

    need_disconnect = False
    audit_payload = None

    with session_scope() as db:
        lease = db.get(NodeLease, int(lease_id))
        if lease is None:
            raise LookupError("租约不存在")
        if lease.status != "active":
            return lease.to_dict(), False

        try:
            prev_dt = datetime.strptime(lease.last_billed_at, "%Y-%m-%d %H:%M:%S")
            elapsed_sec = max(0, int((now_dt - prev_dt).total_seconds()))
        except Exception:
            elapsed_sec = 0

        buyer_delta, seller_delta, profit_delta, new_sec, new_bytes = compute_lease_cost_deltas(
            seller_hour_units=int(lease.seller_hour_units or 0),
            buyer_hour_units=int(lease.buyer_hour_units or 0),
            seller_gb_units=int(lease.seller_gb_units or 0),
            buyer_gb_units=int(lease.buyer_gb_units or 0),
            prev_billed_seconds=int(lease.billed_seconds or 0),
            add_seconds=elapsed_sec,
            prev_billed_bytes=int(lease.billed_bytes or 0),
            add_bytes=unbilled_bytes,
            already_buyer_spent=int(lease.buyer_spent_units or 0),
            already_seller_earned=int(lease.seller_earned_units or 0),
        )

        buyer = db.get(User, lease.buyer_id)
        seller = db.get(User, lease.seller_id)
        node = db.get(Node, lease.node_id)

        buyer_bal = int(buyer.balance_units or 0) if buyer else 0
        exhausted = False
        if buyer_delta > buyer_bal:
            actual_buyer_delta = max(0, buyer_bal)
            if buyer_delta > 0:
                actual_seller_delta = min(actual_buyer_delta, (seller_delta * actual_buyer_delta) // buyer_delta)
            else:
                actual_seller_delta = 0
            actual_profit_delta = actual_buyer_delta - actual_seller_delta
            exhausted = True
        else:
            actual_buyer_delta = buyer_delta
            actual_seller_delta = seller_delta
            actual_profit_delta = profit_delta

        if actual_buyer_delta > 0 and buyer is not None:
            buyer.balance_units = max(0, int(buyer.balance_units or 0) - actual_buyer_delta)
            buyer.total_spent_units = int(buyer.total_spent_units or 0) + actual_buyer_delta
            db.add(
                BillingLedger(
                    user_id=buyer.id,
                    related_lease_id=lease.id,
                    related_node_id=lease.node_id,
                    tx_type="lease_debit",
                    amount_units=-actual_buyer_delta,
                    balance_after_units=buyer.balance_units,
                    platform_spread_units=actual_profit_delta,
                    remark=f"租用节点 #{lease.node_id} 计费 (+{elapsed_sec}s / +{unbilled_bytes}B)",
                    created_at=now_str,
                )
            )
            if buyer.balance_units <= 0 and (lease.buyer_hour_units > 0 or lease.buyer_gb_units > 0):
                exhausted = True

        if actual_seller_delta > 0 and seller is not None:
            seller.balance_units = int(seller.balance_units or 0) + actual_seller_delta
            seller.total_earned_units = int(seller.total_earned_units or 0) + actual_seller_delta
            db.add(
                BillingLedger(
                    user_id=seller.id,
                    related_lease_id=lease.id,
                    related_node_id=lease.node_id,
                    tx_type="seller_credit",
                    amount_units=actual_seller_delta,
                    balance_after_units=seller.balance_units,
                    platform_spread_units=actual_profit_delta,
                    remark=f"节点 #{lease.node_id} 出租分成收益 (平台差价 ¥{units_to_yuan_str(actual_profit_delta)})",
                    created_at=now_str,
                )
            )

        lease.consumed_bytes = int(lease.consumed_bytes or 0) + unbilled_bytes
        lease.billed_bytes = new_bytes
        lease.billed_seconds = new_sec
        lease.buyer_spent_units = int(lease.buyer_spent_units or 0) + actual_buyer_delta
        lease.seller_earned_units = int(lease.seller_earned_units or 0) + actual_seller_delta
        lease.platform_profit_units = int(lease.platform_profit_units or 0) + actual_profit_delta
        lease.last_billed_at = now_str

        if node is not None:
            node.total_leased_seconds = int(node.total_leased_seconds or 0) + elapsed_sec
            node.total_leased_bytes = int(node.total_leased_bytes or 0) + unbilled_bytes

        target_end = force_end_status or ("exhausted" if exhausted else "")
        if target_end:
            lease.status = target_end
            lease.ended_at = now_str
            lease.end_reason = end_reason or ("余额耗尽自动退租" if target_end == "exhausted" else "用户主动停止")
            if node is not None:
                node.active_lease_count = max(0, int(node.active_lease_count or 0) - 1)
            need_disconnect = True
            audit_payload = {
                "actor_id": actor_id or lease.buyer_id,
                "actor_username": buyer.username if buyer else "system",
                "status": "ok",
                "end_status": target_end,
                "reason": lease.end_reason,
                "spent_yuan": units_to_yuan_str(lease.buyer_spent_units),
                "platform_profit_yuan": units_to_yuan_str(lease.platform_profit_units),
            }

        db.flush()
        out = lease.to_dict()

    if audit_payload:
        write_audit_log(
            action=f"lease_{audit_payload['end_status']}",
            actor_id=audit_payload["actor_id"],
            actor_username=audit_payload["actor_username"],
            target_type="node_lease",
            target_id=lease_id,
            ip=client_ip,
            status="ok",
            details=audit_payload,
        )
    return out, need_disconnect


def settle_self_reverse_owner_sync(owner_id: int) -> bool:
    oid = int(owner_id or 0)
    if oid <= 0:
        return False

    unbilled_bytes = drain_self_reverse_unbilled_bytes(oid)
    rate_gb = get_self_reverse_hub_gb_units()
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with session_scope() as db:
        owner = db.get(User, oid)
        if owner is None:
            return False

        prev_bytes = int(owner.self_reverse_billed_bytes or 0)
        already_units = int(owner.self_reverse_billed_units or 0)
        new_bytes = prev_bytes + max(0, int(unbilled_bytes))

        if rate_gb <= 0:
            if unbilled_bytes > 0:
                owner.self_reverse_billed_bytes = new_bytes
            return False

        cum_fee = (rate_gb * new_bytes) // BYTES_PER_GB
        delta_fee = max(0, cum_fee - already_units)
        bal = int(owner.balance_units or 0)
        actual_fee = min(delta_fee, max(0, bal))

        if unbilled_bytes > 0:
            owner.self_reverse_billed_bytes = new_bytes

        if actual_fee > 0:
            owner.balance_units = max(0, bal - actual_fee)
            owner.total_spent_units = int(owner.total_spent_units or 0) + actual_fee
            owner.self_reverse_billed_units = already_units + actual_fee
            db.add(
                BillingLedger(
                    user_id=owner.id,
                    tx_type="self_reverse_hub_fee",
                    amount_units=-actual_fee,
                    balance_after_units=owner.balance_units,
                    platform_spread_units=actual_fee,
                    remark=f"自用 WSS 反穿 Hub 中继流量费 (+{unbilled_bytes}B @ ¥{units_to_yuan_str(rate_gb)}/GB)",
                    created_at=now_str,
                )
            )
            db.flush()

        if rate_gb > 0 and (int(owner.balance_units or 0) <= 0 or delta_fee > bal):
            return True
    return False


def settle_all_active_leases_sync(
    active_self_reverse_owner_ids: Optional[List[int]] = None,
) -> Tuple[List[Tuple[int, int]], List[int]]:
    with session_scope() as db:
        active_ids = [r[0] for r in db.query(NodeLease.id).filter(NodeLease.status == "active").all()]

    lease_disconnects: List[Tuple[int, int]] = []
    for lid in active_ids:
        try:
            lease_dict, need_dc = settle_single_lease_sync(lid)
            if need_dc:
                lease_disconnects.append((int(lease_dict["node_id"]), int(lid)))
        except Exception as exc:
            logger.debug(f"租约 #{lid} 结算异常: {exc}")

    candidate_owners = set(list_pending_self_reverse_owner_ids())
    if active_self_reverse_owner_ids:
        candidate_owners.update(int(x) for x in active_self_reverse_owner_ids if x)

    owner_disconnects: List[int] = []
    for oid in candidate_owners:
        try:
            if settle_self_reverse_owner_sync(oid):
                owner_disconnects.append(int(oid))
        except Exception as exc:
            logger.debug(f"自用反穿户 #{oid} 结算异常: {exc}")

    return lease_disconnects, owner_disconnects


async def billing_settlement_loop():
    from modules.nodes.tunnel_manager import tunnel_mgr

    logger.info("💰 启动 SaaS 节点租赁及自用 WSS 反穿流量结算协程 (周期 15s)...")
    while True:
        await asyncio.sleep(15)
        try:
            active_owners = tunnel_mgr.get_active_self_reverse_owner_ids()
            lease_dc, owner_dc = await asyncio.to_thread(settle_all_active_leases_sync, active_owners)
            for nid, lid in lease_dc:
                await tunnel_mgr.disconnect_lease_streams(nid, lid)
                logger.info(f"⛔ 租约 #{lid}（节点 #{nid}）已触发余额耗尽退租与流切断")
            for oid in owner_dc:
                await tunnel_mgr.disconnect_owner_reverse_streams(oid)
                logger.info(f"⛔ 租户 #{oid} 钱包余额耗尽，已切断自用 WSS 反穿网关流")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug(f"SaaS 结算轮询异常: {exc}")
