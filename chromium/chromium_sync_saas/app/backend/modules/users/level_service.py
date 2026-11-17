import asyncio
from datetime import datetime
from typing import Any, Dict, List, Optional

from config import logger
from core.db import get_setting, session_scope
from core.models import Node, User, UserLevel
from modules.audit.service import write_audit_log

BYTES_PER_GB = 1024 * 1024 * 1024


def compute_user_level_score(
    online_seconds: int,
    contributed_bytes: int,
    avg_latency_ms: int,
    avg_speed_kbps: int,
) -> int:
    online_hours = max(0.0, float(online_seconds or 0) / 3600.0)
    contrib_gb = max(0.0, float(contributed_bytes or 0) / float(BYTES_PER_GB))

    online_pts = min(350.0, (online_hours / 240.0) * 350.0)
    traffic_pts = min(350.0, (contrib_gb / 50.0) * 350.0)

    if avg_latency_ms and avg_latency_ms > 0:
        lat_pts = max(0.0, min(150.0, (600.0 - float(avg_latency_ms)) / 570.0 * 150.0))
    else:
        lat_pts = 0.0

    speed_pts = min(150.0, (max(0.0, float(avg_speed_kbps or 0)) / 500.0) * 150.0)
    return int(round(online_pts + traffic_pts + lat_pts + speed_pts))


def _refresh_owner_node_speed_aggregates(db, owner: User):
    nodes = (
        db.query(Node)
        .filter(
            Node.owner_id == owner.id,
            Node.enabled == 1,
            Node.conn_type.in_(["reverse", "public_wss", "wss_direct"]),
            Node.status == "connected",
        )
        .all()
    )
    lat_vals = [int(n.avg_latency_ms) for n in nodes if int(n.avg_latency_ms or 0) > 0]
    spd_vals = [int(n.avg_speed_kbps) for n in nodes if int(n.avg_speed_kbps or 0) > 0]

    owner.avg_node_latency_ms = int(round(sum(lat_vals) / len(lat_vals))) if lat_vals else 0
    owner.avg_node_speed_kbps = int(round(sum(spd_vals) / len(spd_vals))) if spd_vals else 0


def record_node_telemetry_sync(
    node_id: int,
    latency_ms: Optional[int] = None,
    speed_kbps: Optional[int] = None,
    mark_online_tick: bool = False,
    is_offline: bool = False,
):
    now_dt = datetime.now()
    now_str = now_dt.strftime("%Y-%m-%d %H:%M:%S")
    with session_scope() as db:
        node = db.get(Node, int(node_id))
        if node is None:
            return
        owner = db.get(User, int(node.owner_id))
        if owner is None:
            return

        if latency_ms is not None and int(latency_ms) > 0:
            lat = max(1, min(10000, int(latency_ms)))
            prev_lat = int(node.avg_latency_ms or 0)
            node.avg_latency_ms = int(round(prev_lat * 0.7 + lat * 0.3)) if prev_lat > 0 else lat

        if speed_kbps is not None and int(speed_kbps) >= 0:
            spd = max(0, int(speed_kbps))
            if spd > 0:
                prev_spd = int(node.avg_speed_kbps or 0)
                node.avg_speed_kbps = int(round(prev_spd * 0.6 + spd * 0.4)) if prev_spd > 0 else spd

        if mark_online_tick and (node.conn_type or "reverse") in ("reverse", "public_wss", "wss_direct") and (node.enabled or 0) == 1:
            add_sec = 30
            if node.last_online_tick_at:
                try:
                    prev_dt = datetime.strptime(node.last_online_tick_at, "%Y-%m-%d %H:%M:%S")
                    diff = int((now_dt - prev_dt).total_seconds())
                    add_sec = max(1, min(120, diff))
                except Exception:
                    add_sec = 30
            node.online_seconds = int(node.online_seconds or 0) + add_sec
            node.last_online_tick_at = now_str
            owner.total_online_seconds = int(owner.total_online_seconds or 0) + add_sec

        if is_offline:
            node.last_online_tick_at = ""
            if int(node.avg_speed_kbps or 0) > 0:
                node.avg_speed_kbps = int(node.avg_speed_kbps * 0.5)

        _refresh_owner_node_speed_aggregates(db, owner)


def _level_matches_user(lv: UserLevel, online_hours: float, contrib_gb: float, avg_lat: int, avg_spd: int) -> bool:
    if online_hours < float(lv.min_online_hours or 0):
        return False
    if contrib_gb < float(lv.min_contributed_gb or 0):
        return False
    if int(lv.max_avg_latency_ms or 0) > 0:
        if avg_lat <= 0 or avg_lat > int(lv.max_avg_latency_ms):
            return False
    if int(lv.min_speed_kbps or 0) > 0:
        if avg_spd < int(lv.min_speed_kbps):
            return False
    return True


def evaluate_user_level_sync(user_id: int, actor_username: str = "auto_scheduler") -> Optional[Dict[str, Any]]:
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    audit_event = None

    with session_scope() as db:
        u = db.get(User, int(user_id))
        if u is None or u.status != "active":
            return None

        _refresh_owner_node_speed_aggregates(db, u)

        levels: List[UserLevel] = db.query(UserLevel).order_by(UserLevel.rank_order.desc(), UserLevel.id.desc()).all()
        if not levels:
            return None

        levels_by_id = {lv.id: lv for lv in levels}
        base_lv = levels[-1]
        cur_lv = levels_by_id.get(int(u.level_id or 0)) or base_lv

        online_hours = float(u.total_online_seconds or 0) / 3600.0
        contrib_gb = float(u.contributed_traffic_bytes or 0) / float(BYTES_PER_GB)
        avg_lat = int(u.avg_node_latency_ms or 0)
        avg_spd = int(u.avg_node_speed_kbps or 0)

        u.level_score = compute_user_level_score(
            int(u.total_online_seconds or 0),
            int(u.contributed_traffic_bytes or 0),
            avg_lat,
            avg_spd,
        )
        u.level_evaluated_at = now_str

        matched_lv = base_lv
        for lv in levels:
            if _level_matches_user(lv, online_hours, contrib_gb, avg_lat, avg_spd):
                matched_lv = lv
                break

        changed = False
        direction = "unchanged"
        if not bool(u.level_locked) and matched_lv.id != cur_lv.id:
            changed = True
            direction = "upgrade" if int(matched_lv.rank_order) > int(cur_lv.rank_order) else "demote"
            metrics_desc = (
                f"在线 {online_hours:.1f}h · 贡献 {contrib_gb:.2f}GB · "
                f"延迟 {avg_lat if avg_lat > 0 else '--'}ms · 速度 {avg_spd}KB/s"
            )
            if direction == "upgrade":
                reason = f"自动升级 {cur_lv.code.upper()} → {matched_lv.code.upper()}（{metrics_desc}）"
            else:
                reason = f"自动降级 {cur_lv.code.upper()} → {matched_lv.code.upper()}（指标未维持原等级门槛：{metrics_desc}）"
            u.level_id = matched_lv.id
            u.last_level_change_reason = reason[:255]
            audit_event = {
                "action": f"user_level_{direction}",
                "actor_id": u.id,
                "actor_username": u.username,
                "details": {
                    "operator": actor_username,
                    "from": cur_lv.code,
                    "to": matched_lv.code,
                    "online_hours": round(online_hours, 2),
                    "contributed_gb": round(contrib_gb, 3),
                    "avg_latency_ms": avg_lat,
                    "avg_speed_kbps": avg_spd,
                    "reason": reason,
                },
            }

        db.flush()
        out = {
            "user_id": u.id,
            "username": u.username,
            "changed": changed,
            "direction": direction,
            "level": (matched_lv if changed else cur_lv).to_dict(),
            "score": u.level_score,
        }

    if audit_event:
        write_audit_log(
            action=audit_event["action"],
            actor_id=audit_event["actor_id"],
            actor_username=audit_event["actor_username"],
            target_type="user",
            target_id=audit_event["actor_id"],
            ip="system",
            status="ok",
            details=audit_event["details"],
        )
    return out


def evaluate_all_users_levels_sync(actor_username: str = "auto_scheduler") -> Dict[str, Any]:
    with session_scope() as db:
        user_ids = [r[0] for r in db.query(User.id).filter(User.status == "active").all()]

    upgrades = 0
    demotes = 0
    evaluated = 0
    for uid in user_ids:
        try:
            res = evaluate_user_level_sync(uid, actor_username=actor_username)
            if res:
                evaluated += 1
                if res.get("direction") == "upgrade":
                    upgrades += 1
                elif res.get("direction") == "demote":
                    demotes += 1
        except Exception as exc:
            logger.debug(f"评估用户 #{uid} 等级失败: {exc}")
    return {"evaluated": evaluated, "upgrades": upgrades, "demotes": demotes}


def get_user_level_progress(db, user_obj: User) -> Dict[str, Any]:
    levels = db.query(UserLevel).order_by(UserLevel.rank_order.asc(), UserLevel.id.asc()).all()
    if not levels:
        return {"current_level": None, "next_level": None, "all_levels": [], "metrics": {}}
    cur_lv = next((lv for lv in levels if lv.id == int(user_obj.level_id or 0)), levels[0])
    nxt_lv = next((lv for lv in levels if int(lv.rank_order) > int(cur_lv.rank_order)), None)
    return {
        "current_level": cur_lv.to_dict(),
        "next_level": nxt_lv.to_dict() if nxt_lv else None,
        "all_levels": [lv.to_dict() for lv in levels],
        "metrics": {
            "online_hours": round(float(user_obj.total_online_seconds or 0) / 3600.0, 2),
            "contributed_gb": round(float(user_obj.contributed_traffic_bytes or 0) / float(BYTES_PER_GB), 3),
            "avg_node_latency_ms": int(user_obj.avg_node_latency_ms or 0),
            "avg_node_speed_kbps": int(user_obj.avg_node_speed_kbps or 0),
            "level_score": int(user_obj.level_score or 0),
            "level_locked": bool(user_obj.level_locked),
            "last_level_change_reason": user_obj.last_level_change_reason or "",
        },
    }


async def level_evaluation_loop():
    logger.info("🏅 启动 SaaS 用户等级自动升降级评估协程 (在线时长 · 节点速度 · 贡献流量, 周期 60s)...")
    while True:
        await asyncio.sleep(60)
        try:
            if get_setting("saas_auto_level_enabled", "1") != "1":
                continue
            res = await asyncio.to_thread(evaluate_all_users_levels_sync, "auto_scheduler")
            if res.get("upgrades") or res.get("demotes"):
                logger.info(
                    f"🏅 [自动评级完成] 评估 {res['evaluated']} 位用户: 升级 {res['upgrades']} 人, 降级 {res['demotes']} 人"
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug(f"等级自动评估轮询异常: {exc}")
