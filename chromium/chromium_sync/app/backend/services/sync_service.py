import os
import time
import json
import inspect
import sqlite3
import asyncio
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.events import EVENT_JOB_EXECUTED, EVENT_JOB_ERROR

from config import DB_PATH, KEYS_DIR, ChromiumSync, logger
from core.database import get_setting, get_db_connection
from services.cdp_engine import (
    fetch_cookies_native,
    inject_cookies_native,
    probe_node_cookies,
    filter_cookies_by_domains,
    compute_cookie_diff,
    smart_merge_cookies,
    purge_stale_cookies_on_node,
    build_cleanup_targets,
)
from services.notification import dispatch_notification

# 引入 wimotek-chromium-sync 最新的 AuditLogger 结构化自动轮转引擎
try:
    from wimotek_chromium_sync import AuditLogger
except ImportError:
    try:
        from wimotek_chromium_sync.audit import AuditLogger
    except ImportError:
        AuditLogger = None

SYNC_AUDIT_FILE = "/data/sync_audit.jsonl"
sync_audit_logger = AuditLogger(
    file_path=SYNC_AUDIT_FILE,
    max_bytes=10 * 1024 * 1024,  # 10MB 触发文件轮转
    backup_count=5               # 保留 5 个归档，超出自动淘汰最旧备份
) if AuditLogger else None

scheduler = BackgroundScheduler(timezone="Asia/Shanghai")

_is_sync_running = False
_main_loop: Optional[asyncio.AbstractEventLoop] = None


def set_main_event_loop(loop: asyncio.AbstractEventLoop):
    """注入 FastAPI 主事件循环引用，供调度器跨线程安全调度 WebSocket 通道"""
    global _main_loop
    _main_loop = loop


def _job_listener(event):
    if event.exception:
        logger.error(f"❌ 定时策略调度任务执行失败 (Job ID: {event.job_id}): {event.exception}")
    else:
        logger.info(f"✅ 定时策略调度任务触发执行完毕 (Job ID: {event.job_id})")


scheduler.add_listener(_job_listener, EVENT_JOB_EXECUTED | EVENT_JOB_ERROR)


def _execute_policy_job_wrapper(policy_id: int):
    global _is_sync_running
    if _is_sync_running:
        logger.info(f"⏳ 同步引擎正忙，定时器跳过策略 ID:{policy_id} (防撞车保护)")
        return

    try:
        if _main_loop and _main_loop.is_running():
            future = asyncio.run_coroutine_threadsafe(execute_policy_task(policy_id), _main_loop)
            future.result(timeout=180)  # 策略最大容忍 3 分钟超时
        else:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(execute_policy_task(policy_id))
            finally:
                loop.close()
    except Exception as e:
        logger.error(f"定时调度任务异常 (策略ID: {policy_id}): {e}", exc_info=True)


def reschedule_all_policies():
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM sync_policies WHERE enabled=1")
    policies = [dict(r) for r in cur.fetchall()]
    conn.close()

    for job in scheduler.get_jobs():
        if job.id.startswith("policy_job_"):
            scheduler.remove_job(job.id)

    now_dt = datetime.now()
    logger.info(f"🔄 正在装载同步策略至定时器 (共 {len(policies)} 条启用策略)...")

    for p in policies:
        job_id = f"policy_job_{p['id']}"
        interval = max(1, int(p.get("interval_minutes") or 15))

        if not p.get("last_run"):
            first_run = now_dt + timedelta(seconds=5)
        else:
            try:
                last_dt = datetime.strptime(p["last_run"], "%Y-%m-%d %H:%M:%S")
                target_dt = last_dt + timedelta(minutes=interval)
                first_run = target_dt if target_dt > now_dt else (now_dt + timedelta(seconds=5))
            except Exception:
                first_run = now_dt + timedelta(minutes=interval)

        scheduler.add_job(
            _execute_policy_job_wrapper,
            'interval',
            args=[p['id']],
            minutes=interval,
            id=job_id,
            next_run_time=first_run
        )
        logger.info(f"⏱️ 策略 [{p['name']}] (ID:{p['id']}) 装载完成 | 周期: {interval}分钟 | 下次运行: {first_run.strftime('%Y-%m-%d %H:%M:%S')}")


async def run_chromium_sync_instance(
    source_node: dict,
    target_node: dict,
    include_domains: List[str],
    exclude_domains: List[str],
    diff_enabled: bool
) -> dict:
    """
    全面对接 wimotek-chromium-sync v1.3.0 现代调度引擎：
    挂载自动轮转审计文件 /data/sync_audit.jsonl
    """
    if ChromiumSync is None:
        raise ImportError("未安装 wimotek-chromium-sync 模块")

    src_host = "127.0.0.1" if source_node.get("is_local") else source_node.get("direct_host", "127.0.0.1")
    src_port = int(source_node.get("local_bind_port", 9222))
    tgt_port = int(target_node.get("local_bind_port", 19222))

    nodes_payload = [
        {
            "id": str(source_node["id"]),
            "name": source_node.get("name", "source"),
            "is_local": bool(source_node.get("is_local")),
            "cdp_host": src_host,
            "cdp_port": src_port
        },
        {
            "id": str(target_node["id"]),
            "name": target_node.get("name", "target"),
            "is_local": True,
            "cdp_host": "127.0.0.1",
            "cdp_port": tgt_port
        }
    ]

    try:
        syncer = ChromiumSync(
            nodes=nodes_payload,
            mode="sync",
            source=str(source_node["id"]),
            targets=[str(target_node["id"])],
            include_domains=include_domains or None,
            exclude_domains=exclude_domains or None,
            diff=diff_enabled,
            verbose=False,
            audit_file=SYNC_AUDIT_FILE,
            audit_max_bytes=10 * 1024 * 1024,
            audit_backup_count=5,
            audit_enabled=True
        )
        if hasattr(syncer, "run_async"):
            res = await syncer.run_async()
        else:
            res = await asyncio.to_thread(syncer.run)
        return res if isinstance(res, dict) else {"status": "success", "details": str(res)}
    except Exception as e:
        logger.warning(f"ChromiumSync 调度执行异常: {e}")
        return {"status": "failed", "details": str(e), "error": str(e)}


def _resolve_node_target_host(node: dict) -> str:
    conn_type = node.get("conn_type")
    if conn_type in ("public_wss", "wss_direct"):
        return "public-wss"
    if conn_type == "reverse":
        return "reverse-nat4"
    return node.get("direct_host", "127.0.0.1") if node.get("is_local") else "127.0.0.1"


def get_global_cleanup_rules() -> dict:
    try:
        within_days = int(get_setting("sync_cleanup_expiring_within_days", "0") or 0)
    except Exception:
        within_days = 0
    return {
        "enabled": get_setting("sync_cleanup_enabled", "0") == "1",
        "expired": get_setting("sync_cleanup_expired", "1") == "1",
        "domains": get_setting("sync_cleanup_domains", ""),
        "keywords": get_setting("sync_cleanup_keywords", ""),
        "keyword_scope": get_setting("sync_cleanup_keyword_scope", "name_domain") or "name_domain",
        "expires_before": get_setting("sync_cleanup_expires_before", ""),
        "expiring_within_days": max(0, within_days),
        "session_only": get_setting("sync_cleanup_session_only", "0") == "1",
    }


async def execute_global_cleanup(dry_run: bool = False, override_rules: Optional[dict] = None) -> dict:
    """对所有在线活跃节点执行全局 Cookie 清理（或 dry_run 试算预览）"""
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE enabled=1 AND approval_status=1 AND status='connected'")
    active_nodes = [dict(r) for r in cur.fetchall()]
    conn.close()

    exclude_domains = [d.strip() for d in get_setting("sync_exclude_domains", "doubleclick.net,google-analytics.com").split(",") if d.strip()]
    cleanup_rules = dict(get_global_cleanup_rules())
    if override_rules:
        cleanup_rules.update(override_rules)
    # 立即清理 / 试算场景下强制开启规则评估
    cleanup_rules["enabled"] = True

    if not active_nodes:
        return {
            "dry_run": dry_run,
            "node_count": 0,
            "matched_total": 0,
            "purged_total": 0,
            "reasons": {},
            "nodes": [],
        }

    start_ts = time.time()
    sync_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    node_reports = []
    reason_totals: Dict[str, int] = {}
    matched_total = 0
    purged_total = 0
    log_lines = [f"🧹 {'试算预览' if dry_run else '执行'}全网 Cookie 清理 (覆盖 {len(active_nodes)} 个在线节点)"]

    for n in active_nodes:
        t_host = _resolve_node_target_host(n)
        try:
            raw_c = await fetch_cookies_native(n["local_bind_port"], target_host=t_host, node_id=n["id"])
        except Exception as exc:
            node_reports.append({"id": n["id"], "name": n["name"], "matched": 0, "purged": 0, "error": str(exc)})
            log_lines.append(f"• 节点 [{n['name']}] 读取失败: {exc}")
            continue

        targets, reasons = build_cleanup_targets(raw_c, exclude_domains=exclude_domains, cleanup_rules=cleanup_rules)
        matched_cnt = len(targets)
        matched_total += matched_cnt
        for rk, rv in reasons.items():
            reason_totals[rk] = reason_totals.get(rk, 0) + rv

        purged_cnt = 0
        if not dry_run:
            purged_cnt = await purge_stale_cookies_on_node(
                n["local_bind_port"],
                t_host,
                exclude_domains=exclude_domains,
                node_id=n["id"],
                cleanup_rules=cleanup_rules,
                pre_fetched_cookies=raw_c,
            )
            purged_total += purged_cnt
            c_cnt, _ = await probe_node_cookies(n["local_bind_port"], t_host, node_id=n["id"])
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("UPDATE nodes SET cookie_count=?, last_sync=? WHERE id=?", (c_cnt, sync_time, n["id"]))
            conn.commit()
            conn.close()
            log_lines.append(f"-> 节点 [{n['name']}] 命中 {matched_cnt} 条 / 实删 {purged_cnt} 条，剩余 {c_cnt} 条")

        node_reports.append({
            "id": n["id"],
            "name": n["name"],
            "total_cookies": len(raw_c),
            "matched": matched_cnt,
            "purged": purged_cnt,
            "reasons": reasons,
        })

    if not dry_run:
        duration_str = f"{time.time() - start_ts:.2f}s"
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO sync_logs (timestamp, source_node, target_nodes, cookie_count, duration, status, details)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            sync_time,
            "🧹 全局清理引擎",
            f"全网在线节点 ({len(active_nodes)} 个)",
            purged_total,
            duration_str,
            "SUCCESS",
            "\n".join(log_lines),
        ))
        cur.execute("""
            DELETE FROM sync_logs 
            WHERE id NOT IN (SELECT id FROM (SELECT id FROM sync_logs ORDER BY id DESC LIMIT 20))
        """)
        conn.commit()
        conn.close()

    return {
        "dry_run": dry_run,
        "node_count": len(active_nodes),
        "matched_total": matched_total,
        "purged_total": purged_total,
        "reasons": reason_totals,
        "nodes": node_reports,
    }


async def execute_policy_task(policy_id: int):
    """
    多策略执行引擎：
    1. 前置过滤未认证节点，穿透 NAT4 反向与 SSH 通道；
    2. 全局互斥锁防撞车，0 差异毫秒级跳过；
    3. 集成 AuditLogger 持久化结构化轮转文件；
    4. 数据库 sync_logs 自动定容滚动保留 20 条高频视图。
    """
    global _is_sync_running
    if _is_sync_running:
        logger.warning(f"⚠️ 拦截重复调度：已有策略正在同步中，策略 ID:{policy_id} 自动跳过")
        return

    _is_sync_running = True
    start_ts = time.time()

    try:
        conn = get_db_connection()
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT * FROM sync_policies WHERE id=?", (policy_id,))
        policy_row = cur.fetchone()

        cur.execute("SELECT * FROM nodes WHERE enabled=1 AND approval_status=1")
        all_enabled_nodes = [dict(r) for r in cur.fetchall()]
        conn.close()

        if not policy_row or not all_enabled_nodes:
            logger.warning(f"策略 ID:{policy_id} 执行跳过: 策略不存在或无可用认证节点")
            return

        policy = dict(policy_row)
        sync_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        log_detail = [f"🚀 触发策略 [{policy['name']}] (类型: {policy['sync_type']})"]

        if sync_audit_logger:
            sync_audit_logger.log("policy_start", {
                "policy_id": policy_id,
                "policy_name": policy["name"],
                "sync_type": policy["sync_type"]
            })

        active_nodes = [n for n in all_enabled_nodes if n.get("status") == "connected"]
        inactive_nodes = [n for n in all_enabled_nodes if n.get("status") != "connected"]

        if inactive_nodes:
            skip_names = ", ".join([n['name'] for n in inactive_nodes])
            log_detail.append(f"ℹ️ 自动跳过 {len(inactive_nodes)} 个非活跃离线节点: {skip_names}")

        diff_enabled = (get_setting("sync_diff_enabled", "1") == "1")
        include_domains = [d.strip() for d in get_setting("sync_include_domains", "").split(",") if d.strip()]
        exclude_domains = [d.strip() for d in get_setting("sync_exclude_domains", "doubleclick.net,google-analytics.com").split(",") if d.strip()]
        cleanup_rules = get_global_cleanup_rules()

        source_node_desc = ""
        target_nodes_desc = ""
        cookie_count_metric = 0

        # 解析目标范围
        scope_targets = []
        if policy["target_type"] == "group":
            group_all = [n for n in all_enabled_nodes if n.get("group_name") == policy["target_group"]]
            scope_targets = [n for n in group_all if n.get("status") == "connected"]
            target_nodes_desc = f"分组 [{policy['target_group']}] ({len(scope_targets)} 活跃)"
        elif policy["target_type"] == "nodes":
            tids = json.loads(policy.get("target_ids") or "[]")
            nodes_all = [n for n in all_enabled_nodes if n["id"] in tids]
            scope_targets = [n for n in nodes_all if n.get("status") == "connected"]
            target_nodes_desc = f"指定节点 ({len(scope_targets)} 活跃)"
        else:
            scope_targets = active_nodes
            target_nodes_desc = f"全网活跃节点 ({len(active_nodes)} 个)"

        try:
            # ==================== A. 全网智能最新值合并 (Smart Merge) ====================
            if policy["sync_type"] == "smart_merge":
                source_node_desc = "🌟 智能多主汇聚"
                merge_pool_nodes = scope_targets if policy["target_type"] == "group" else active_nodes

                if not merge_pool_nodes:
                    log_detail.append("⚠️ 无可用在线活跃节点，本次智能合并自动挂起跳过")
                    status = "SKIPPED"
                else:
                    fetch_tasks = [
                        fetch_cookies_native(
                            n['local_bind_port'],
                            target_host=_resolve_node_target_host(n),
                            node_id=n['id']
                        )
                        for n in merge_pool_nodes
                    ]
                    fetched_results = await asyncio.gather(*fetch_tasks, return_exceptions=True)

                    node_in_memory_data = []
                    valid_cookie_lists = []
                    total_dropped = 0

                    for idx, res in enumerate(fetched_results):
                        n = merge_pool_nodes[idx]
                        if isinstance(res, list):
                            cleaned_c, bl_cnt, exp_cnt = filter_cookies_by_domains(
                                res, include_domains, exclude_domains, cleanup_rules=cleanup_rules
                            )
                            valid_cookie_lists.append(cleaned_c)
                            total_dropped += (bl_cnt + exp_cnt)
                            node_in_memory_data.append({"node": n, "cookies": cleaned_c, "raw_cookies": res})
                        else:
                            log_detail.append(f"• 节点 [{n['name']}] 握手异常，自动跳过")

                    golden_pool, cap_trimmed = smart_merge_cookies(valid_cookie_lists, max_per_domain=50)
                    cookie_count_metric = len(golden_pool)

                    # 前置差异研判
                    nodes_to_inject = []
                    total_diff_count = 0

                    for item in node_in_memory_data:
                        n = item["node"]
                        diff_c, skipped = compute_cookie_diff(item["cookies"], golden_pool)
                        if diff_c:
                            nodes_to_inject.append({"node": n, "diff_cookies": diff_c, "skipped": skipped})
                            total_diff_count += len(diff_c)

                    # 0 增量秒级跳过机制
                    if total_diff_count == 0 and total_dropped == 0 and cap_trimmed == 0:
                        elapsed_fast = f"{(time.time() - start_ts):.2f}s"
                        log_detail.append(f"⚡ [前置比对无差异] 各节点凭据已 100% 保持最新且完全对齐，跳过写入 (耗时: {elapsed_fast})")
                        status = "NO_CHANGE"
                        if sync_audit_logger:
                            sync_audit_logger.log("sync_no_change", {
                                "policy_id": policy_id,
                                "duration": elapsed_fast,
                                "cookie_count": cookie_count_metric
                            })
                    else:
                        log_detail.append(f"✨ 黄金凭据池聚拢完成: 共 {cookie_count_metric} 条最新 Cookies (发现 {total_diff_count} 项增量需对齐, 过滤/待清理 {total_dropped} 项)")

                        for item in node_in_memory_data:
                            n = item["node"]
                            match_inject = next((x for x in nodes_to_inject if x["node"]["id"] == n["id"]), None)
                            t_host = _resolve_node_target_host(n)
                            should_purge = bool(match_inject or cleanup_rules.get("enabled") or total_dropped > 0)
                            purged_cnt = 0
                            if should_purge:
                                purged_cnt = await purge_stale_cookies_on_node(
                                    n['local_bind_port'],
                                    t_host,
                                    exclude_domains,
                                    node_id=n['id'],
                                    cleanup_rules=cleanup_rules,
                                    pre_fetched_cookies=item.get("raw_cookies"),
                                )

                            if match_inject:
                                diff_c = match_inject["diff_cookies"]
                                skipped = match_inject["skipped"]
                                await inject_cookies_native(n['local_bind_port'], diff_c, t_host, node_id=n['id'])
                                c_cnt, _ = await probe_node_cookies(n['local_bind_port'], t_host, node_id=n['id'])

                                conn = get_db_connection()
                                cur = conn.cursor()
                                cur.execute("UPDATE nodes SET cookie_count=?, last_sync=? WHERE id=?", (c_cnt, sync_time, n['id']))
                                conn.commit()
                                conn.close()

                                purge_info = f"，清理 {purged_cnt} 条" if purged_cnt > 0 else ""
                                log_detail.append(f"-> 节点 [{n['name']}] 差量写入 {len(diff_c)} 项 (跳过 {skipped} 项{purge_info})，现存 {c_cnt} 条")
                            elif purged_cnt > 0:
                                c_cnt, _ = await probe_node_cookies(n['local_bind_port'], t_host, node_id=n['id'])
                                conn = get_db_connection()
                                cur = conn.cursor()
                                cur.execute("UPDATE nodes SET cookie_count=?, last_sync=? WHERE id=?", (c_cnt, sync_time, n['id']))
                                conn.commit()
                                conn.close()
                                log_detail.append(f"-> 节点 [{n['name']}] 已按全局删除策略清理 {purged_cnt} 条 Cookie，现存 {c_cnt} 条")
                            else:
                                log_detail.append(f"-> 节点 [{n['name']}] 凭据已对齐，跳过写入 (现存 {len(item['cookies'])} 条)")

                        status = "SUCCESS"

            # ==================== B. 组对组分发 (Group-to-Group) ====================
            elif policy["sync_type"] == "group_to_group":
                src_group = policy.get("source_group") or "默认分组"
                src_active_nodes = [n for n in active_nodes if n.get("group_name") == src_group]
                source_node_desc = f"🏢 源分组 [{src_group}] ({len(src_active_nodes)} 活跃)"

                if not src_active_nodes:
                    log_detail.append(f"⚠️ 源分组 [{src_group}] 中无在线活跃节点，已自动跳过")
                    status = "SKIPPED"
                else:
                    fetch_tasks = [
                        fetch_cookies_native(
                            n['local_bind_port'],
                            target_host=_resolve_node_target_host(n),
                            node_id=n['id']
                        )
                        for n in src_active_nodes
                    ]
                    fetched_results = await asyncio.gather(*fetch_tasks, return_exceptions=True)
                    valid_lists = [
                        filter_cookies_by_domains(r, include_domains, exclude_domains, cleanup_rules=cleanup_rules)[0]
                        for r in fetched_results if isinstance(r, list)
                    ]

                    if cleanup_rules.get("enabled"):
                        for idx, sn in enumerate(src_active_nodes):
                            raw_sn = fetched_results[idx] if idx < len(fetched_results) and isinstance(fetched_results[idx], list) else None
                            await purge_stale_cookies_on_node(
                                sn['local_bind_port'],
                                _resolve_node_target_host(sn),
                                exclude_domains,
                                node_id=sn['id'],
                                cleanup_rules=cleanup_rules,
                                pre_fetched_cookies=raw_sn,
                            )

                    group_cookies, _ = smart_merge_cookies(valid_lists, max_per_domain=50)
                    cookie_count_metric = len(group_cookies)

                    dest_nodes = [n for n in scope_targets if n not in src_active_nodes]
                    if not dest_nodes:
                        log_detail.append("ℹ️ 目标分组中无在线活跃接收节点")
                        status = "SKIPPED"
                    else:
                        injected_any = False
                        for target in dest_nodes:
                            t_host = _resolve_node_target_host(target)
                            curr_c = await fetch_cookies_native(target['local_bind_port'], t_host, node_id=target['id'])
                            purged_cnt = 0
                            if cleanup_rules.get("enabled"):
                                purged_cnt = await purge_stale_cookies_on_node(
                                    target['local_bind_port'],
                                    t_host,
                                    exclude_domains,
                                    node_id=target['id'],
                                    cleanup_rules=cleanup_rules,
                                    pre_fetched_cookies=curr_c,
                                )
                            diff_c, skipped = compute_cookie_diff(curr_c, group_cookies)

                            if diff_c:
                                injected_any = True
                                if not cleanup_rules.get("enabled"):
                                    purged_cnt = await purge_stale_cookies_on_node(
                                        target['local_bind_port'],
                                        t_host,
                                        exclude_domains,
                                        node_id=target['id'],
                                        cleanup_rules=cleanup_rules,
                                        pre_fetched_cookies=curr_c,
                                    )
                                await inject_cookies_native(target['local_bind_port'], diff_c, t_host, node_id=target['id'])
                                t_cnt, _ = await probe_node_cookies(target['local_bind_port'], t_host, node_id=target['id'])
                                purge_info = f"（清理 {purged_cnt} 条）" if purged_cnt > 0 else ""
                                log_detail.append(f"-> 目标节点 [{target['name']}] 差量写入 {len(diff_c)} 项{purge_info}，现存: {t_cnt}")
                            elif purged_cnt > 0:
                                injected_any = True
                                t_cnt, _ = await probe_node_cookies(target['local_bind_port'], t_host, node_id=target['id'])
                                log_detail.append(f"-> 目标节点 [{target['name']}] 已全局清理 {purged_cnt} 条，现存: {t_cnt}")
                            else:
                                log_detail.append(f"-> 目标节点 [{target['name']}] 数据完全一致，跳过写入")

                        status = "SUCCESS" if injected_any else "NO_CHANGE"

            # ==================== C. 节点对组 / 节点对多节点分发 ====================
            else:
                source = next((n for n in all_enabled_nodes if n["id"] == policy["source_id"]), None)
                if not source or source.get("status") != "connected":
                    source = next((n for n in active_nodes if n.get("is_source") == 1), None) or (active_nodes[0] if active_nodes else None)

                if not source:
                    log_detail.append("⚠️ 源节点当前处于离线/非活跃状态，策略自动熔断跳过")
                    source_node_desc = "源端离线"
                    status = "SKIPPED"
                else:
                    source_node_desc = f"{source['name']} ({'本地' if source['is_local'] else (source.get('conn_type') or 'SSH')})"
                    src_host = _resolve_node_target_host(source)

                    raw_c = await fetch_cookies_native(source['local_bind_port'], src_host, node_id=source['id'])
                    if cleanup_rules.get("enabled"):
                        src_purged = await purge_stale_cookies_on_node(
                            source['local_bind_port'],
                            src_host,
                            exclude_domains,
                            node_id=source['id'],
                            cleanup_rules=cleanup_rules,
                            pre_fetched_cookies=raw_c,
                        )
                        if src_purged > 0:
                            log_detail.append(f"-> 源节点 [{source['name']}] 已按全局删除策略清理 {src_purged} 条 Cookie")

                    cookies, _, _ = filter_cookies_by_domains(
                        raw_c, include_domains, exclude_domains, cleanup_rules=cleanup_rules
                    )
                    cookie_count_metric = len(cookies)

                    dest_nodes = [n for n in scope_targets if n["id"] != source["id"]]
                    if not dest_nodes:
                        log_detail.append("ℹ️ 目标接收队列中无在线活跃节点")
                        status = "SKIPPED"
                    else:
                        injected_any = False
                        for target in dest_nodes:
                            tgt_host = _resolve_node_target_host(target)
                            curr_c = await fetch_cookies_native(target['local_bind_port'], tgt_host, node_id=target['id'])
                            purged_cnt = 0
                            if cleanup_rules.get("enabled"):
                                purged_cnt = await purge_stale_cookies_on_node(
                                    target['local_bind_port'],
                                    tgt_host,
                                    exclude_domains,
                                    node_id=target['id'],
                                    cleanup_rules=cleanup_rules,
                                    pre_fetched_cookies=curr_c,
                                )
                            diff_c, skipped = compute_cookie_diff(curr_c, cookies)

                            if diff_c:
                                injected_any = True
                                if not cleanup_rules.get("enabled"):
                                    purged_cnt = await purge_stale_cookies_on_node(
                                        target['local_bind_port'],
                                        tgt_host,
                                        exclude_domains,
                                        node_id=target['id'],
                                        cleanup_rules=cleanup_rules,
                                        pre_fetched_cookies=curr_c,
                                    )

                                if ChromiumSync is not None and target.get('conn_type') == 'ssh':
                                    sync_res = await run_chromium_sync_instance(source, target, include_domains, exclude_domains, diff_enabled)
                                    target_count, _ = await probe_node_cookies(target['local_bind_port'], tgt_host, node_id=target['id'])
                                    log_detail.append(f"-> 目标节点 [{target['name']}] 模块同步完成 ({sync_res.get('status', 'OK')})，现存: {target_count}")
                                else:
                                    await inject_cookies_native(target['local_bind_port'], diff_c, tgt_host, node_id=target['id'])
                                    target_count, _ = await probe_node_cookies(target['local_bind_port'], tgt_host, node_id=target['id'])
                                    purge_info = f"（清理 {purged_cnt} 条）" if purged_cnt > 0 else ""
                                    log_detail.append(f"-> 目标节点 [{target['name']}] 差量写入 {len(diff_c)} 项{purge_info}，现存: {target_count}")
                            elif purged_cnt > 0:
                                injected_any = True
                                target_count, _ = await probe_node_cookies(target['local_bind_port'], tgt_host, node_id=target['id'])
                                log_detail.append(f"-> 目标节点 [{target['name']}] 已全局清理 {purged_cnt} 条，现存: {target_count}")
                            else:
                                log_detail.append(f"-> 目标节点 [{target['name']}] 数据一致，跳过写入")

                        status = "SUCCESS" if injected_any else "NO_CHANGE"

        except Exception as e:
            status = "FAILED"
            log_detail.append(f"策略执行中断: {e}")
            if sync_audit_logger:
                sync_audit_logger.log("policy_exception", {"policy_id": policy_id, "error": str(e)}, level="ERROR")

        duration_str = f"{time.time() - start_ts:.2f}s"

        # 1. 结构化日志持久化至 10MB 自动轮替文件 (audit.py 引擎接管淘汰)
        if sync_audit_logger:
            sync_audit_logger.log("policy_finish", {
                "policy_id": policy_id,
                "policy_name": policy["name"],
                "status": status,
                "cookie_count": cookie_count_metric,
                "duration": duration_str,
                "source": source_node_desc,
                "targets": target_nodes_desc
            })

        # 2. 数据库写入高频摘要，严格定容滚动保留 20 条供 UI 展示
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO sync_logs (timestamp, source_node, target_nodes, cookie_count, duration, status, details)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (sync_time, source_node_desc, target_nodes_desc, cookie_count_metric, duration_str, status, "\n".join(log_detail)))

        cur.execute("UPDATE sync_policies SET last_run=? WHERE id=?", (sync_time, policy_id))

        cur.execute("""
            DELETE FROM sync_logs 
            WHERE id NOT IN (
                SELECT id FROM (
                    SELECT id FROM sync_logs ORDER BY id DESC LIMIT 20
                )
            )
        """)
        conn.commit()
        conn.close()

        # 手动执行后自动顺延下一次定时触发时间
        try:
            job_id = f"policy_job_{policy_id}"
            job = scheduler.get_job(job_id)
            if job:
                interval_mins = max(1, int(policy.get("interval_minutes") or 15))
                next_trigger = datetime.now() + timedelta(minutes=interval_mins)
                job.modify(next_run_time=next_trigger)
        except Exception:
            pass

        if status == "FAILED":
            await dispatch_notification(f"策略 [{policy['name']}] 执行失败预警", f"时间: {sync_time} (耗时: {duration_str})\n" + "\n".join(log_detail))

    finally:
        _is_sync_running = False


async def execute_sync_task(policy_id: Optional[int] = None):
    if policy_id:
        await execute_policy_task(policy_id)
        return

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT id FROM sync_policies WHERE enabled=1 ORDER BY id ASC")
    policies = cur.fetchall()
    conn.close()

    if not policies:
        logger.warning("未检测到已启用的同步策略，跳过执行。")
        return

    for p in policies:
        await execute_policy_task(p["id"])