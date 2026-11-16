import asyncio
import threading
import time
from datetime import datetime
from typing import Dict, List, Optional

from sqlalchemy.exc import IntegrityError

from config import logger
from core.cache import cache_mgr
from core.db import session_scope
from core.models import Node, TrafficStat

NODE_BUF_PREFIX = "traffic:buf:"
HOUR_BUF_PREFIX = "traffic:hour:"
LIVE_METRICS_PREFIX = "node:live_metrics:"

_streams_lock = threading.Lock()
_active_streams_mem: Dict[int, int] = {}
_live_snapshot_mem: Dict[int, dict] = {}
_mem_buf_lock = threading.Lock()
_mem_node_buf: Dict[str, Dict[str, int]] = {}
_mem_hour_buf: Dict[str, Dict[str, int]] = {}
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
):
    rx = _safe_int(rx_bytes)
    tx = _safe_int(tx_bytes)
    reqs = _safe_int(requests)
    dur = _safe_int(duration_sec)
    if not (rx or tx or reqs or dur):
        return

    node_hkey = f"{NODE_BUF_PREFIX}{node_id}"
    bucket = _current_bucket_hour()
    hour_hkey = f"{HOUR_BUF_PREFIX}{bucket}|{node_id}|{channel_type}"

    # 纯内存 O(1) 微批累加：绝不在高频 WebSocket 帧循环中直接阻塞写 Redis / SQLite
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


def record_node_nic_metrics(
    node_id: int,
    net_rx_delta: int = 0,
    net_tx_delta: int = 0,
    cdp_rx_delta: int = 0,
    cdp_tx_delta: int = 0,
    active_streams: Optional[int] = None,
):
    nrx = _safe_int(net_rx_delta)
    ntx = _safe_int(net_tx_delta)
    crx = _safe_int(cdp_rx_delta)
    ctx = _safe_int(cdp_tx_delta)

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
            hour_hkey = f"{HOUR_BUF_PREFIX}{bucket}|{node_id}|node_nic"
            if nrx:
                _incr_mem_hash(_mem_hour_buf, hour_hkey, "rx_bytes", nrx)
            if ntx:
                _incr_mem_hash(_mem_hour_buf, hour_hkey, "tx_bytes", ntx)
            _incr_mem_hash(_mem_hour_buf, hour_hkey, "request_count", 1)

        if crx or ctx:
            edge_hkey = f"{HOUR_BUF_PREFIX}{bucket}|{node_id}|edge_cdp"
            if crx:
                _incr_mem_hash(_mem_hour_buf, edge_hkey, "rx_bytes", crx)
            if ctx:
                _incr_mem_hash(_mem_hour_buf, edge_hkey, "tx_bytes", ctx)

        _mem_live_dirty[node_id] = dict(snap)


def flush_mem_to_cache_sync() -> int:
    """将 1s 内聚合在内存微批字典中的流量增量一次性批量写入 Redis Pipeline / SQLite Cache"""
    global _mem_node_buf, _mem_hour_buf, _mem_live_dirty
    with _mem_buf_lock:
        if not _mem_node_buf and not _mem_hour_buf and not _mem_live_dirty:
            return 0
        node_ops = _mem_node_buf
        hour_ops = _mem_hour_buf
        live_ops = _mem_live_dirty
        _mem_node_buf = {}
        _mem_hour_buf = {}
        _mem_live_dirty = {}

    merged_ops: Dict[str, Dict[str, int]] = {}
    merged_ops.update(node_ops)
    merged_ops.update(hour_ops)

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
        # 异常回滚保留未落缓存的内存增量，确保零丢数
        with _mem_buf_lock:
            for hk, fields in node_ops.items():
                for f, d in fields.items():
                    _incr_mem_hash(_mem_node_buf, hk, f, d)
            for hk, fields in hour_ops.items():
                for f, d in fields.items():
                    _incr_mem_hash(_mem_hour_buf, hk, f, d)
            for nid, payload in live_ops.items():
                _mem_live_dirty.setdefault(nid, payload)
        raise


def get_live_node_traffic_overlay(node_ids: List[int]) -> Dict[int, dict]:
    if not node_ids:
        return {}

    buf_keys = [f"{NODE_BUF_PREFIX}{nid}" for nid in node_ids]
    live_keys = [f"{LIVE_METRICS_PREFIX}{nid}" for nid in node_ids]

    # 批量读取：Redis 下仅需 2 次往返，SQLite Cache 下仅需 2 次 IN (...) 批查
    buf_map = cache_mgr.hgetall_readonly_batch(buf_keys)
    live_map = cache_mgr.mget_json_batch(live_keys)

    # 叠加当前尚未刷入缓存 (<1s) 的内存实时增量，确保毫秒级看板准确度
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
    """将内存微批 + Redis / SQLite Cache 中的高频流量增量计数器批量落盘至 ORM (nodes + traffic_stats)"""
    with _flush_thread_lock:
        flush_mem_to_cache_sync()

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        flushed_items = 0

        node_keys = cache_mgr.list_hash_keys(NODE_BUF_PREFIX)
        hour_keys = cache_mgr.list_hash_keys(HOUR_BUF_PREFIX)

        node_deltas: Dict[int, Dict[str, int]] = {}
        for nk in node_keys:
            try:
                nid = int(nk[len(NODE_BUF_PREFIX):])
            except ValueError:
                continue
            vals = cache_mgr.drain_hash_counters(nk)
            if vals:
                node_deltas[nid] = vals
                flushed_items += 1

        hour_deltas = []
        for hk in hour_keys:
            raw_part = hk[len(HOUR_BUF_PREFIX):]
            parts = raw_part.split("|", 2)
            if len(parts) != 3:
                continue
            bucket_hour, nid_str, channel_type = parts
            try:
                nid = int(nid_str)
            except ValueError:
                continue
            vals = cache_mgr.drain_hash_counters(hk)
            if vals:
                hour_deltas.append((nid, bucket_hour, channel_type, vals))
                flushed_items += 1

        if not node_deltas and not hour_deltas:
            return 0

        with session_scope() as db:
            for nid, vals in node_deltas.items():
                node = db.get(Node, nid)
                if node is None:
                    continue
                node.cdp_rx_bytes = int(node.cdp_rx_bytes or 0) + _safe_int(vals.get("cdp_rx_bytes"))
                node.cdp_tx_bytes = int(node.cdp_tx_bytes or 0) + _safe_int(vals.get("cdp_tx_bytes"))
                node.net_rx_bytes = int(node.net_rx_bytes or 0) + _safe_int(vals.get("net_rx_bytes"))
                node.net_tx_bytes = int(node.net_tx_bytes or 0) + _safe_int(vals.get("net_tx_bytes"))
                node.active_cdp_streams = get_active_cdp_streams(nid)
                node.last_metrics_at = now_str

            for nid, bucket_hour, channel_type, vals in hour_deltas:
                rx = _safe_int(vals.get("rx_bytes"))
                tx = _safe_int(vals.get("tx_bytes"))
                reqs = _safe_int(vals.get("request_count"))
                dur = _safe_int(vals.get("duration_sec"))
                row = (
                    db.query(TrafficStat)
                    .filter(
                        TrafficStat.node_id == nid,
                        TrafficStat.bucket_hour == bucket_hour,
                        TrafficStat.channel_type == channel_type,
                    )
                    .first()
                )
                if row is None:
                    row = TrafficStat(
                        node_id=nid,
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

        return flushed_items


async def flush_traffic_buffers() -> int:
    async with _flush_lock:
        return await asyncio.to_thread(flush_traffic_buffers_sync)


async def traffic_flush_loop():
    logger.info("📊 启动流量统计微批缓冲与定时落盘协程 (1s 刷缓存 · 15s 落盘 DB)...")
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


def get_traffic_summary(limit_hours: int = 24) -> dict:
    with session_scope() as db:
        nodes = db.query(Node).order_by(Node.id.asc()).all()
        node_dicts = [n.to_dict() for n in nodes]
        hourly_rows = (
            db.query(TrafficStat)
            .order_by(TrafficStat.bucket_hour.desc())
            .limit(max(10, limit_hours * max(1, len(node_dicts)) * 2))
            .all()
        )
        hourly_dicts = [h.to_dict() for h in hourly_rows]

    overlay = get_live_node_traffic_overlay([n["id"] for n in node_dicts])
    total_cdp_rx = 0
    total_cdp_tx = 0
    total_net_rx = 0
    total_net_tx = 0
    total_streams = 0

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


def get_node_traffic_detail(node_id: int) -> Optional[dict]:
    with session_scope() as db:
        node = db.get(Node, node_id)
        if node is None:
            return None
        nd = node.to_dict()
        hourly_rows = (
            db.query(TrafficStat)
            .filter(TrafficStat.node_id == node_id)
            .order_by(TrafficStat.bucket_hour.desc())
            .limit(48)
            .all()
        )
        hourly = [h.to_dict() for h in hourly_rows]

    ov = get_live_node_traffic_overlay([node_id]).get(node_id, {})
    return {
        "node_id": node_id,
        "name": nd["name"],
        "cdp_rx_bytes": int(nd.get("cdp_rx_bytes") or 0) + _safe_int(ov.get("cdp_rx_delta")),
        "cdp_tx_bytes": int(nd.get("cdp_tx_bytes") or 0) + _safe_int(ov.get("cdp_tx_delta")),
        "net_rx_bytes": int(nd.get("net_rx_bytes") or 0) + _safe_int(ov.get("net_rx_delta")),
        "net_tx_bytes": int(nd.get("net_tx_bytes") or 0) + _safe_int(ov.get("net_tx_delta")),
        "active_cdp_streams": _safe_int(ov.get("active_cdp_streams")),
        "last_metrics_at": ov.get("last_metrics_at") or nd.get("last_metrics_at"),
        "hourly": hourly,
    }


def reset_node_traffic(node_id: Optional[int] = None):
    flush_traffic_buffers_sync()
    with session_scope() as db:
        if node_id is not None:
            node = db.get(Node, node_id)
            if node is not None:
                node.cdp_rx_bytes = 0
                node.cdp_tx_bytes = 0
                node.net_rx_bytes = 0
                node.net_tx_bytes = 0
            db.query(TrafficStat).filter(TrafficStat.node_id == node_id).delete(synchronize_session=False)
        else:
            db.query(Node).update(
                {
                    Node.cdp_rx_bytes: 0,
                    Node.cdp_tx_bytes: 0,
                    Node.net_rx_bytes: 0,
                    Node.net_tx_bytes: 0,
                },
                synchronize_session=False,
            )
            db.query(TrafficStat).delete(synchronize_session=False)
