import asyncio
from datetime import datetime
import threading
from typing import Dict, List, Optional

from sqlalchemy.exc import IntegrityError

from config import logger
from core.cache import cache_mgr
from core.db import session_scope
from core.models import Node, TrafficStat, User

NODE_BUF_PREFIX = "traffic:buf:"
HOUR_BUF_PREFIX = "traffic:hour:"
LEASE_BUF_PREFIX = "traffic:lease:"
SELF_REVERSE_BUF_PREFIX = "traffic:self_rev:"
LIVE_METRICS_PREFIX = "node:live_metrics:"

_streams_lock = threading.Lock()
_active_streams_mem: Dict[int, int] = {}
_live_snapshot_mem: Dict[int, dict] = {}
_mem_buf_lock = threading.Lock()
_mem_node_buf: Dict[str, Dict[str, int]] = {}
_mem_hour_buf: Dict[str, Dict[str, int]] = {}
_mem_lease_buf: Dict[int, int] = {}
_mem_self_reverse_buf: Dict[int, int] = {}
_mem_live_dirty: Dict[int, dict] = {}
_flush_lock = asyncio.Lock()
_flush_thread_lock = threading.Lock()


def _current_bucket_hour() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:00")


def _safe_int(val) -> int:
    try:
        v = int(val or 0)
        return v if v > 0 else 0
    except (TypeError, ValueError):
        return 0


def _incr_mem_hash(target: Dict[str, Dict[str, int]], hkey: str, field: str, delta: int):
    if delta <= 0:
        return
    bucket = target.get(hkey)
    if bucket is None:
        target[hkey] = {field: delta}
    else:
        bucket[field] = bucket.get(field, 0) + delta


def adjust_active_cdp_streams(node_id: int, delta: int):
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with _streams_lock:
        nxt = max(0, _active_streams_mem.get(node_id, 0) + int(delta))
        _active_streams_mem[node_id] = nxt
        snap = dict(_live_snapshot_mem.get(node_id) or {})
        snap["active_cdp_streams"] = nxt
        snap["updated_at"] = now_str
        _live_snapshot_mem[node_id] = snap
    with _mem_buf_lock:
        _mem_live_dirty[node_id] = dict(snap)


def get_active_cdp_streams(node_id: int) -> int:
    with _streams_lock:
        if node_id in _active_streams_mem:
            return _active_streams_mem[node_id]
    snap = cache_mgr.get_json(f"{LIVE_METRICS_PREFIX}{node_id}")
    if isinstance(snap, dict):
        return _safe_int(snap.get("active_cdp_streams"))
    return 0


def record_cdp_traffic(
    node_id: int,
    channel_type: str = "cdp_gateway",
    rx_bytes: int = 0,
    tx_bytes: int = 0,
    requests: int = 0,
    duration_sec: int = 0,
    lease_id: int = 0,
    owner_id: int = 1,
):
    rx = _safe_int(rx_bytes)
    tx = _safe_int(tx_bytes)
    reqs = _safe_int(requests)
    dur = _safe_int(duration_sec)
    lid = _safe_int(lease_id)
    oid = max(1, _safe_int(owner_id) or 1)
    if not (rx or tx or reqs or dur):
        return

    node_hkey = f"{NODE_BUF_PREFIX}{node_id}"
    bucket = _current_bucket_hour()
    hour_hkey = f"{HOUR_BUF_PREFIX}{bucket}|{node_id}|{lid}|{oid}|{channel_type}"

    with _mem_buf_lock:
        if rx:
            _incr_mem_hash(_mem_node_buf, node_hkey, "cdp_rx_bytes", rx)
            _incr_mem_hash(_mem_hour_buf, hour_hkey, "rx_bytes", rx)
        if tx:
            _incr_mem_hash(_mem_node_buf, node_hkey, "cdp_tx_bytes", tx)
            _incr_mem_hash(_mem_hour_buf, hour_hkey, "tx_bytes", tx)
        if reqs:
            _incr_mem_hash(_mem_hour_buf, hour_hkey, "request_count", reqs)
        if dur:
            _incr_mem_hash(_mem_hour_buf, hour_hkey, "duration_sec", dur)
        if lid and (rx or tx):
            _mem_lease_buf[lid] = _mem_lease_buf.get(lid, 0) + rx + tx
        elif lid == 0 and channel_type == "reverse" and (rx or tx):
            _mem_self_reverse_buf[oid] = _mem_self_reverse_buf.get(oid, 0) + rx + tx


def drain_lease_unbilled_bytes(lease_id: int) -> int:
    lid = _safe_int(lease_id)
    if not lid:
        return 0
    total = 0
    with _mem_buf_lock:
        total += _mem_lease_buf.pop(lid, 0)
    vals = cache_mgr.drain_hash_counters(f"{LEASE_BUF_PREFIX}{lid}")
    total += _safe_int(vals.get("bytes"))
    return total


def drain_self_reverse_unbilled_bytes(owner_id: int) -> int:
    oid = _safe_int(owner_id)
    if not oid:
        return 0
    total = 0
    with _mem_buf_lock:
        total += _mem_self_reverse_buf.pop(oid, 0)
    vals = cache_mgr.drain_hash_counters(f"{SELF_REVERSE_BUF_PREFIX}{oid}")
    total += _safe_int(vals.get("bytes"))
    return total


def list_pending_self_reverse_owner_ids() -> List[int]:
    ids = set()
    with _mem_buf_lock:
        ids.update(k for k, v in _mem_self_reverse_buf.items() if v > 0)
    for hk in cache_mgr.list_hash_keys(SELF_REVERSE_BUF_PREFIX):
        try:
            ids.add(int(hk[len(SELF_REVERSE_BUF_PREFIX) :]))
        except ValueError:
            continue
    return list(ids)


def record_node_nic_metrics(
    node_id: int,
    net_rx_delta: int = 0,
    net_tx_delta: int = 0,
    cdp_rx_delta: int = 0,
    cdp_tx_delta: int = 0,
    active_streams: Optional[int] = None,
    owner_id: int = 1,
):
    nrx = _safe_int(net_rx_delta)
    ntx = _safe_int(net_tx_delta)
    crx = _safe_int(cdp_rx_delta)
    ctx = _safe_int(cdp_tx_delta)
    oid = max(1, _safe_int(owner_id) or 1)

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    node_hkey = f"{NODE_BUF_PREFIX}{node_id}"
    bucket = _current_bucket_hour()

    with _streams_lock:
        snap_streams = _active_streams_mem.get(node_id, 0)
        if active_streams is not None:
            reported_streams = _safe_int(active_streams)
            snap_streams = max(reported_streams, snap_streams)
            _active_streams_mem[node_id] = snap_streams
        snap = {
            "active_cdp_streams": snap_streams,
            "edge_active_streams": _safe_int(active_streams) if active_streams is not None else None,
            "last_metrics_at": now_str,
        }
        _live_snapshot_mem[node_id] = snap

    with _mem_buf_lock:
        if nrx:
            _incr_mem_hash(_mem_node_buf, node_hkey, "net_rx_bytes", nrx)
        if ntx:
            _incr_mem_hash(_mem_node_buf, node_hkey, "net_tx_bytes", ntx)
        if nrx or ntx:
            hour_hkey = f"{HOUR_BUF_PREFIX}{bucket}|{node_id}|0|{oid}|node_nic"
            if nrx:
                _incr_mem_hash(_mem_hour_buf, hour_hkey, "rx_bytes", nrx)
            if ntx:
                _incr_mem_hash(_mem_hour_buf, hour_hkey, "tx_bytes", ntx)
            _incr_mem_hash(_mem_hour_buf, hour_hkey, "request_count", 1)
        if crx or ctx:
            edge_hkey = f"{HOUR_BUF_PREFIX}{bucket}|{node_id}|0|{oid}|edge_cdp"
            if crx:
                _incr_mem_hash(_mem_hour_buf, edge_hkey, "rx_bytes", crx)
            if ctx:
                _incr_mem_hash(_mem_hour_buf, edge_hkey, "tx_bytes", ctx)
        _mem_live_dirty[node_id] = dict(snap)


def flush_mem_to_cache_sync() -> int:
    global _mem_node_buf, _mem_hour_buf, _mem_lease_buf, _mem_self_reverse_buf, _mem_live_dirty
    with _mem_buf_lock:
        if not _mem_node_buf and not _mem_hour_buf and not _mem_lease_buf and not _mem_self_reverse_buf and not _mem_live_dirty:
            return 0
        node_ops = _mem_node_buf
        hour_ops = _mem_hour_buf
        lease_ops = _mem_lease_buf
        self_rev_ops = _mem_self_reverse_buf
        live_ops = _mem_live_dirty
        _mem_node_buf = {}
        _mem_hour_buf = {}
        _mem_lease_buf = {}
        _mem_self_reverse_buf = {}
        _mem_live_dirty = {}

    merged_ops: Dict[str, Dict[str, int]] = {}
    merged_ops.update(node_ops)
    merged_ops.update(hour_ops)
    for lid, b_val in lease_ops.items():
        if b_val > 0:
            merged_ops[f"{LEASE_BUF_PREFIX}{lid}"] = {"bytes": b_val}
    for oid, b_val in self_rev_ops.items():
        if b_val > 0:
            merged_ops[f"{SELF_REVERSE_BUF_PREFIX}{oid}"] = {"bytes": b_val}

    try:
        if merged_ops:
            cache_mgr.hincrby_batch(merged_ops)
        if live_ops:
            cache_mgr.mset_json_batch(
                {f"{LIVE_METRICS_PREFIX}{nid}": payload for nid, payload in live_ops.items()},
                ttl=90,
            )
        return len(merged_ops) + len(live_ops)
    except Exception:
        with _mem_buf_lock:
            for hk, fields in node_ops.items():
                for f, d in fields.items():
                    _incr_mem_hash(_mem_node_buf, hk, f, d)
            for hk, fields in hour_ops.items():
                for f, d in fields.items():
                    _incr_mem_hash(_mem_hour_buf, hk, f, d)
            for lid, b_val in lease_ops.items():
                _mem_lease_buf[lid] = _mem_lease_buf.get(lid, 0) + b_val
            for oid, b_val in self_rev_ops.items():
                _mem_self_reverse_buf[oid] = _mem_self_reverse_buf.get(oid, 0) + b_val
            for nid, payload in live_ops.items():
                _mem_live_dirty.setdefault(nid, payload)
        raise


def get_live_node_traffic_overlay(node_ids: List[int]) -> Dict[int, dict]:
    if not node_ids:
        return {}
    buf_keys = [f"{NODE_BUF_PREFIX}{nid}" for nid in node_ids]
    live_keys = [f"{LIVE_METRICS_PREFIX}{nid}" for nid in node_ids]
    buf_map = cache_mgr.hgetall_readonly_batch(buf_keys)
    live_map = cache_mgr.mget_json_batch(live_keys)

    mem_pending: Dict[int, Dict[str, int]] = {}
    with _mem_buf_lock:
        for nid in node_ids:
            hk = f"{NODE_BUF_PREFIX}{nid}"
            if hk in _mem_node_buf:
                mem_pending[nid] = dict(_mem_node_buf[hk])

    with _streams_lock:
        mem_streams_copy = {nid: _active_streams_mem[nid] for nid in node_ids if nid in _active_streams_mem}
        mem_snap_copy = {nid: dict(_live_snapshot_mem[nid]) for nid in node_ids if nid in _live_snapshot_mem}

    overlay: Dict[int, dict] = {}
    for nid in node_ids:
        buf = buf_map.get(f"{NODE_BUF_PREFIX}{nid}") or {}
        pending = mem_pending.get(nid) or {}
        snap = mem_snap_copy.get(nid) or live_map.get(f"{LIVE_METRICS_PREFIX}{nid}") or {}

        active_s = mem_streams_copy.get(nid)
        if active_s is None:
            active_s = _safe_int(snap.get("active_cdp_streams"))

        overlay[nid] = {
            "cdp_rx_delta": _safe_int(buf.get("cdp_rx_bytes")) + _safe_int(pending.get("cdp_rx_bytes")),
            "cdp_tx_delta": _safe_int(buf.get("cdp_tx_bytes")) + _safe_int(pending.get("cdp_tx_bytes")),
            "net_rx_delta": _safe_int(buf.get("net_rx_bytes")) + _safe_int(pending.get("net_rx_bytes")),
            "net_tx_delta": _safe_int(buf.get("net_tx_bytes")) + _safe_int(pending.get("net_tx_bytes")),
            "active_cdp_streams": active_s,
            "last_metrics_at": snap.get("last_metrics_at"),
        }
    return overlay


def flush_traffic_buffers_sync() -> int:
    with _flush_thread_lock:
        flush_mem_to_cache_sync()

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        flushed_items = 0

        node_keys = cache_mgr.list_hash_keys(NODE_BUF_PREFIX)
        hour_keys = cache_mgr.list_hash_keys(HOUR_BUF_PREFIX)

        node_deltas: Dict[int, Dict[str, int]] = {}
        for nk in node_keys:
            try:
                nid = int(nk[len(NODE_BUF_PREFIX) :])
            except ValueError:
                continue
            vals = cache_mgr.drain_hash_counters(nk)
            if vals:
                node_deltas[nid] = vals
                flushed_items += 1

        hour_deltas = []
        for hk in hour_keys:
            raw_part = hk[len(HOUR_BUF_PREFIX) :]
            parts = raw_part.split("|", 4)
            if len(parts) != 5:
                continue
            bucket_hour, nid_str, lid_str, oid_str, channel_type = parts
            try:
                nid = int(nid_str)
                lid = int(lid_str)
                oid = int(oid_str)
            except ValueError:
                continue
            vals = cache_mgr.drain_hash_counters(hk)
            if vals:
                hour_deltas.append((nid, lid, oid, bucket_hour, channel_type, vals))
                flushed_items += 1

        if not node_deltas and not hour_deltas:
            return 0

        user_traffic_adds: Dict[int, int] = {}
        seller_contrib_adds: Dict[int, int] = {}

        with session_scope() as db:
            for nid, vals in node_deltas.items():
                node = db.get(Node, nid)
                if node is None:
                    continue
                crx = _safe_int(vals.get("cdp_rx_bytes"))
                ctx = _safe_int(vals.get("cdp_tx_bytes"))
                nrx = _safe_int(vals.get("net_rx_bytes"))
                ntx = _safe_int(vals.get("net_tx_bytes"))
                node.cdp_rx_bytes = int(node.cdp_rx_bytes or 0) + crx
                node.cdp_tx_bytes = int(node.cdp_tx_bytes or 0) + ctx
                node.net_rx_bytes = int(node.net_rx_bytes or 0) + nrx
                node.net_tx_bytes = int(node.net_tx_bytes or 0) + ntx
                node.active_cdp_streams = get_active_cdp_streams(nid)
                node.last_metrics_at = now_str

                win_bytes = crx + ctx
                if win_bytes > 0 and (node.conn_type or "reverse") in ("reverse", "public_wss", "wss_direct"):
                    win_kbps = max(1, int(round(win_bytes / 1024.0 / 15.0)))
                    prev_spd = int(node.avg_speed_kbps or 0)
                    node.avg_speed_kbps = int(round(prev_spd * 0.6 + win_kbps * 0.4)) if prev_spd > 0 else win_kbps

            node_owner_map = {n.id: n.owner_id for n in db.query(Node.id, Node.owner_id).all()}

            for nid, lid, oid, bucket_hour, channel_type, vals in hour_deltas:
                rx = _safe_int(vals.get("rx_bytes"))
                tx = _safe_int(vals.get("tx_bytes"))
                reqs = _safe_int(vals.get("request_count"))
                dur = _safe_int(vals.get("duration_sec"))
                if rx or tx:
                    user_traffic_adds[oid] = user_traffic_adds.get(oid, 0) + rx + tx
                    if lid > 0 or channel_type in ("reverse", "public_wss"):
                        seller_oid = node_owner_map.get(nid, oid)
                        seller_contrib_adds[seller_oid] = seller_contrib_adds.get(seller_oid, 0) + rx + tx
                row = (
                    db.query(TrafficStat)
                    .filter(
                        TrafficStat.node_id == nid,
                        TrafficStat.lease_id == lid,
                        TrafficStat.bucket_hour == bucket_hour,
                        TrafficStat.channel_type == channel_type,
                    )
                    .first()
                )
                if row is None:
                    row = TrafficStat(
                        owner_id=oid,
                        node_id=nid,
                        lease_id=lid,
                        bucket_hour=bucket_hour,
                        channel_type=channel_type,
                        rx_bytes=rx,
                        tx_bytes=tx,
                        request_count=reqs,
                        duration_sec=dur,
                    )
                    try:
                        with db.begin_nested():
                            db.add(row)
                    except IntegrityError:
                        row = (
                            db.query(TrafficStat)
                            .filter(
                                TrafficStat.node_id == nid,
                                TrafficStat.lease_id == lid,
                                TrafficStat.bucket_hour == bucket_hour,
                                TrafficStat.channel_type == channel_type,
                            )
                            .first()
                        )
                        if row is not None:
                            row.rx_bytes = int(row.rx_bytes or 0) + rx
                            row.tx_bytes = int(row.tx_bytes or 0) + tx
                            row.request_count = int(row.request_count or 0) + reqs
                            row.duration_sec = int(row.duration_sec or 0) + dur
                else:
                    row.rx_bytes = int(row.rx_bytes or 0) + rx
                    row.tx_bytes = int(row.tx_bytes or 0) + tx
                    row.request_count = int(row.request_count or 0) + reqs
                    row.duration_sec = int(row.duration_sec or 0) + dur

            for uid, add_bytes in user_traffic_adds.items():
                u = db.get(User, uid)
                if u is not None:
                    u.monthly_traffic_bytes = int(u.monthly_traffic_bytes or 0) + add_bytes

            for suid, c_bytes in seller_contrib_adds.items():
                su = db.get(User, suid)
                if su is not None:
                    su.contributed_traffic_bytes = int(su.contributed_traffic_bytes or 0) + c_bytes

        return flushed_items


async def flush_traffic_buffers() -> int:
    async with _flush_lock:
        return await asyncio.to_thread(flush_traffic_buffers_sync)


async def traffic_flush_loop():
    logger.info("📊 启动 SaaS 流量微批统计与按租户落盘协程 (1s 刷缓存 · 15s 落盘 DB)...")
    tick = 0
    while True:
        await asyncio.sleep(1)
        tick += 1
        try:
            await asyncio.to_thread(flush_mem_to_cache_sync)
            if tick % 15 == 0:
                await flush_traffic_buffers()
            if tick % 300 == 0:
                await asyncio.to_thread(cache_mgr.cleanup_sqlite_expired)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug(f"流量缓冲落盘异常: {exc}")


def get_traffic_summary(owner_id: Optional[int] = None, limit_hours: int = 24) -> dict:
    with session_scope() as db:
        q = db.query(Node)
        if owner_id is not None:
            q = q.filter(Node.owner_id == int(owner_id))
        node_dicts = [n.to_dict() for n in q.order_by(Node.id.asc()).all()]
        hq = db.query(TrafficStat)
        if owner_id is not None:
            hq = hq.filter(TrafficStat.owner_id == int(owner_id))
        hourly_dicts = [
            h.to_dict()
            for h in hq.order_by(TrafficStat.bucket_hour.desc())
            .limit(max(10, limit_hours * max(1, len(node_dicts)) * 2))
            .all()
        ]

    overlay = get_live_node_traffic_overlay([n["id"] for n in node_dicts])
    total_cdp_rx = total_cdp_tx = total_net_rx = total_net_tx = total_streams = 0
    per_node = []
    for nd in node_dicts:
        ov = overlay.get(nd["id"], {})
        cdp_rx = int(nd.get("cdp_rx_bytes") or 0) + _safe_int(ov.get("cdp_rx_delta"))
        cdp_tx = int(nd.get("cdp_tx_bytes") or 0) + _safe_int(ov.get("cdp_tx_delta"))
        net_rx = int(nd.get("net_rx_bytes") or 0) + _safe_int(ov.get("net_rx_delta"))
        net_tx = int(nd.get("net_tx_bytes") or 0) + _safe_int(ov.get("net_tx_delta"))
        streams = _safe_int(ov.get("active_cdp_streams"))

        total_cdp_rx += cdp_rx
        total_cdp_tx += cdp_tx
        total_net_rx += net_rx
        total_net_tx += net_tx
        total_streams += streams

        per_node.append({
            "id": nd["id"],
            "name": nd["name"],
            "conn_type": nd.get("conn_type"),
            "status": nd.get("status"),
            "cdp_rx_bytes": cdp_rx,
            "cdp_tx_bytes": cdp_tx,
            "cdp_total_bytes": cdp_rx + cdp_tx,
            "net_rx_bytes": net_rx,
            "net_tx_bytes": net_tx,
            "net_total_bytes": net_rx + net_tx,
            "active_cdp_streams": streams,
            "last_metrics_at": ov.get("last_metrics_at") or nd.get("last_metrics_at"),
        })

    return {
        "total_cdp_rx_bytes": total_cdp_rx,
        "total_cdp_tx_bytes": total_cdp_tx,
        "total_cdp_bytes": total_cdp_rx + total_cdp_tx,
        "total_net_rx_bytes": total_net_rx,
        "total_net_tx_bytes": total_net_tx,
        "total_net_bytes": total_net_rx + total_net_tx,
        "active_cdp_streams": total_streams,
        "nodes": per_node,
        "hourly": hourly_dicts[:100],
        "cache_status": cache_mgr.get_status(),
    }
