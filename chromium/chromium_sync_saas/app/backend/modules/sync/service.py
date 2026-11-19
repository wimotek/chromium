import asyncio
import json
import os
import time
from datetime import datetime, timedelta
from typing import Dict, Optional

from apscheduler.events import EVENT_JOB_ERROR, EVENT_JOB_EXECUTED
from apscheduler.schedulers.background import BackgroundScheduler

from config import DATA_DIR, logger
from core.db import get_user_setting, session_scope
from core.models import Node, SyncLog, SyncPolicy
from modules.audit.service import write_audit_log
from modules.nodes.cdp_engine import (
    build_cleanup_targets,
    compute_cookie_diff,
    fetch_cookies_native,
    filter_cookies_by_domains,
    inject_cookies_native,
    parse_rule_terms,
    probe_node_cookies,
    purge_stale_cookies_on_node,
    smart_merge_cookies,
)
from modules.notifications.registry import dispatch_notification

try:
    from wimotek_chromium_sync import AuditLogger
except ImportError:
    try:
        from wimotek_chromium_sync.audit import AuditLogger
    except ImportError:
        AuditLogger = None

SYNC_AUDIT_FILE = os.path.join(DATA_DIR, "sync_audit.jsonl")
sync_audit_logger = (
    AuditLogger(file_path=SYNC_AUDIT_FILE, max_bytes=10 * 1024 * 1024, backup_count=5)
    if AuditLogger
    else None
)

scheduler = BackgroundScheduler(timezone="Asia/Shanghai")
_running_owner_locks: Dict[int, bool] = {}
_main_loop: Optional[asyncio.AbstractEventLoop] = None


def set_main_event_loop(loop: asyncio.AbstractEventLoop):
    global _main_loop
    _main_loop = loop


def _job_listener(event):
    if event.exception:
        logger.error(f"❌ 定时策略调度任务执行失败 (Job ID: {event.job_id}): {event.exception}")


scheduler.add_listener(_job_listener, EVENT_JOB_EXECUTED | EVENT_JOB_ERROR)


def _trim_sync_logs(db, owner_id: int, keep: int = 20):
    keep_ids = [
        row[0]
        for row in db.query(SyncLog.id)
        .filter(SyncLog.owner_id == int(owner_id))
        .order_by(SyncLog.id.desc())
        .limit(keep)
        .all()
    ]
    if keep_ids:
        db.query(SyncLog).filter(SyncLog.owner_id == int(owner_id), ~SyncLog.id.in_(keep_ids)).delete(
            synchronize_session=False
        )


def _execute_policy_job_wrapper(policy_id: int):
    try:
        if _main_loop and _main_loop.is_running():
            future = asyncio.run_coroutine_threadsafe(execute_policy_task(policy_id), _main_loop)
            future.result(timeout=180)
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
    with session_scope() as db:
        policies = [p.to_dict() for p in db.query(SyncPolicy).filter(SyncPolicy.enabled == 1).all()]

    for job in scheduler.get_jobs():
        if job.id.startswith("policy_job_"):
            scheduler.remove_job(job.id)

    now_dt = datetime.now()
    for p in policies:
        job_id = f"policy_job_{p['id']}"
        interval = max(1, int(p.get("interval_minutes") or 15))
        if not p.get("last_run"):
            first_run = now_dt + timedelta(seconds=8)
        else:
            try:
                last_dt = datetime.strptime(p["last_run"], "%Y-%m-%d %H:%M:%S")
                target_dt = last_dt + timedelta(minutes=interval)
                first_run = target_dt if target_dt > now_dt else (now_dt + timedelta(seconds=8))
            except Exception:
                first_run = now_dt + timedelta(minutes=interval)

        scheduler.add_job(
            _execute_policy_job_wrapper,
            "interval",
            args=[p["id"]],
            minutes=interval,
            id=job_id,
            next_run_time=first_run,
        )


def _resolve_node_target_host(node: dict) -> str:
    conn_type = node.get("conn_type")
    if conn_type in ("public_wss", "wss_direct"):
        return "public-wss"
    return "reverse-nat4"


def get_tenant_cleanup_rules(owner_id: int) -> dict:
    try:
        within_days = int(get_user_setting(owner_id, "sync_cleanup_expiring_within_days", "0") or 0)
    except Exception:
        within_days = 0
    return {
        "enabled": get_user_setting(owner_id, "sync_cleanup_enabled", "0") == "1",
        "expired": get_user_setting(owner_id, "sync_cleanup_expired", "1") == "1",
        "domains": get_user_setting(owner_id, "sync_cleanup_domains", ""),
        "keywords": get_user_setting(owner_id, "sync_cleanup_keywords", ""),
        "keyword_scope": get_user_setting(owner_id, "sync_cleanup_keyword_scope", "name_domain") or "name_domain",
        "expires_before": get_user_setting(owner_id, "sync_cleanup_expires_before", ""),
        "expiring_within_days": max(0, within_days),
        "session_only": get_user_setting(owner_id, "sync_cleanup_session_only", "0") == "1",
    }


def _filter_sync_eligible_nodes(nodes: list[dict]) -> tuple[list[dict], list[dict]]:
    eligible = []
    skipped_leased = []
    for n in nodes:
        if int(n.get("active_lease_count") or 0) > 0:
            skipped_leased.append(n)
        else:
            eligible.append(n)
    return eligible, skipped_leased


async def execute_global_cleanup(owner_id: int, dry_run: bool = False, override_rules: Optional[dict] = None) -> dict:
    with session_scope() as db:
        raw_active = [
            n.to_dict()
            for n in db.query(Node)
            .filter(Node.owner_id == int(owner_id), Node.enabled == 1, Node.status == "connected")
            .all()
        ]
    active_nodes, skipped_leased = _filter_sync_eligible_nodes(raw_active)

    exclude_domains = [
        d.strip()
        for d in get_user_setting(owner_id, "sync_exclude_domains", "doubleclick.net,google-analytics.com").split(",")
        if d.strip()
    ]
    cleanup_rules = dict(get_tenant_cleanup_rules(owner_id))
    if override_rules:
        cleanup_rules.update(override_rules)
    cleanup_rules["enabled"] = True

    if not active_nodes:
        return {
            "dry_run": dry_run,
            "node_count": 0,
            "skipped_leased_count": len(skipped_leased),
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
    log_lines = [f"🧹 {'试算预览' if dry_run else '执行'}租户 Cookie 清理 (覆盖 {len(active_nodes)} 个自有空闲节点)"]
    if skipped_leased:
        log_lines.append(f"🔒 已自动豁免 {len(skipped_leased)} 个正在市场出租中的节点，防止误删买家会话")

    for n in active_nodes:
        t_host = _resolve_node_target_host(n)
        try:
            raw_c = await fetch_cookies_native(n["local_bind_port"], target_host=t_host, node_id=n["id"])
        except Exception as exc:
            node_reports.append({"id": n["id"], "name": n["name"], "matched": 0, "purged": 0, "error": str(exc)})
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
            with session_scope() as db:
                node_obj = db.get(Node, n["id"])
                if node_obj is not None:
                    node_obj.cookie_count = c_cnt
                    node_obj.last_sync = sync_time
            log_lines.append(f"-> 节点 [{n['name']}] 命中 {matched_cnt} / 清理 {purged_cnt}，剩余 {c_cnt}")

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
        with session_scope() as db:
            db.add(
                SyncLog(
                    owner_id=int(owner_id),
                    timestamp=sync_time,
                    source_node="🧹 租户清理引擎",
                    target_nodes=f"自有在线节点 ({len(active_nodes)} 个)",
                    cookie_count=purged_total,
                    duration=duration_str,
                    status="SUCCESS",
                    details="\n".join(log_lines),
                )
            )
            db.flush()
            _trim_sync_logs(db, owner_id, 20)

    return {
        "dry_run": dry_run,
        "node_count": len(active_nodes),
        "skipped_leased_count": len(skipped_leased),
        "matched_total": matched_total,
        "purged_total": purged_total,
        "reasons": reason_totals,
        "nodes": node_reports,
    }


async def execute_policy_task(policy_id: int, owner_id_guard: Optional[int] = None):
    with session_scope() as db:
        policy_obj = db.get(SyncPolicy, policy_id)
        if policy_obj is None:
            return
        if owner_id_guard is not None and int(policy_obj.owner_id) != int(owner_id_guard):
            return
        policy = policy_obj.to_dict()
        owner_id = int(policy["owner_id"])
        raw_enabled_nodes = [
            n.to_dict()
            for n in db.query(Node).filter(Node.owner_id == owner_id, Node.enabled == 1).all()
        ]

    if _running_owner_locks.get(owner_id):
        logger.warning(f"⚠️ 租户 #{owner_id} 已有同步任务运行，跳过策略 ID:{policy_id}")
        return

    _running_owner_locks[owner_id] = True
    start_ts = time.time()

    try:
        sync_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        all_enabled_nodes, skipped_leased = _filter_sync_eligible_nodes(raw_enabled_nodes)
        log_detail = [f"🚀 [租户 #{owner_id}] 触发策略 [{policy['name']}] (类型: {policy['sync_type']})"]
        if skipped_leased:
            log_detail.append(
                "🔒 [共享安全隔离] 已自动跳过正在出租中的节点 ("
                + ", ".join(n["name"] for n in skipped_leased)
                + ")，防止同步污染买家会话或反向吸取买家凭据"
            )

        diff_enabled = get_user_setting(owner_id, "sync_diff_enabled", "1") == "1"
        active_nodes = [n for n in all_enabled_nodes if n.get("status") == "connected"]
        include_domains = parse_rule_terms(get_user_setting(owner_id, "sync_include_domains", ""))
        exclude_domains = parse_rule_terms(get_user_setting(owner_id, "sync_exclude_domains", "doubleclick.net,google-analytics.com"))
        cleanup_rules = get_tenant_cleanup_rules(owner_id)

        source_node_desc = ""
        target_nodes_desc = ""
        cookie_count_metric = 0

        if policy["target_type"] == "group":
            scope_targets = [n for n in active_nodes if n.get("group_name") == policy["target_group"]]
            target_nodes_desc = f"分组 [{policy['target_group']}] ({len(scope_targets)} 活跃)"
        elif policy["target_type"] == "nodes":
            tids = json.loads(policy.get("target_ids") or "[]")
            scope_targets = [n for n in active_nodes if n["id"] in tids]
            target_nodes_desc = f"指定自有节点 ({len(scope_targets)} 活跃)"
        else:
            scope_targets = active_nodes
            target_nodes_desc = f"自有活跃节点 ({len(active_nodes)} 个)"

        try:
            if not all_enabled_nodes:
                source_node_desc = "无空闲启用节点"
                log_detail.append("⚠️ 当前无可用的自有空闲启用节点（可能全部已禁用或正处于市场出租中），本次同步已跳过")
                status = "SKIPPED"
            elif policy["sync_type"] == "smart_merge":
                source_node_desc = "🌟 多主汇聚 (严格限定本租户自有空闲节点)"
                merge_pool_nodes = scope_targets if policy["target_type"] in ("group", "nodes") else active_nodes
                if not merge_pool_nodes:
                    log_detail.append("⚠️ 无符合条件的自有空闲在线节点，本次跳过")
                    status = "SKIPPED"
                else:
                    fetch_tasks = [
                        fetch_cookies_native(n["local_bind_port"], target_host=_resolve_node_target_host(n), node_id=n["id"])
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
                            total_dropped += bl_cnt + exp_cnt
                            node_in_memory_data.append({"node": n, "cookies": cleaned_c, "raw_cookies": res})
                        else:
                            log_detail.append(f"• 节点 [{n['name']}] 握手异常，自动跳过")

                    golden_pool, cap_trimmed = smart_merge_cookies(valid_cookie_lists, max_per_domain=50)
                    cookie_count_metric = len(golden_pool)
                    nodes_to_inject = []
                    total_diff_count = 0
                    for item in node_in_memory_data:
                        if diff_enabled:
                            diff_c, skipped = compute_cookie_diff(item["cookies"], golden_pool)
                        else:
                            diff_c, skipped = (list(golden_pool), 0)
                        if diff_c:
                            nodes_to_inject.append({"node": item["node"], "diff_cookies": diff_c, "skipped": skipped})
                            total_diff_count += len(diff_c)

                    if total_diff_count == 0 and total_dropped == 0 and cap_trimmed == 0 and not cleanup_rules.get("enabled"):
                        log_detail.append("⚡ [前置比对无差异] 自有节点已 100% 对齐，跳过写入")
                        status = "NO_CHANGE"
                    else:
                        log_detail.append(f"✨ 黄金池汇聚 {cookie_count_metric} 条 ({total_diff_count} 项增量待对齐，过滤/待清理 {total_dropped} 项)")
                        changed_any = False
                        for item in node_in_memory_data:
                            n = item["node"]
                            match_inject = next((x for x in nodes_to_inject if x["node"]["id"] == n["id"]), None)
                            t_host = _resolve_node_target_host(n)
                            should_purge = bool(match_inject or cleanup_rules.get("enabled") or total_dropped > 0)
                            purged_cnt = 0
                            if should_purge:
                                purged_cnt = await purge_stale_cookies_on_node(
                                    n["local_bind_port"],
                                    t_host,
                                    exclude_domains,
                                    node_id=n["id"],
                                    cleanup_rules=cleanup_rules,
                                    pre_fetched_cookies=item.get("raw_cookies"),
                                )
                            if match_inject:
                                changed_any = True
                                await inject_cookies_native(n["local_bind_port"], match_inject["diff_cookies"], t_host, node_id=n["id"])
                                c_cnt, _ = await probe_node_cookies(n["local_bind_port"], t_host, node_id=n["id"])
                                with session_scope() as db:
                                    node_obj = db.get(Node, n["id"])
                                    if node_obj is not None:
                                        node_obj.cookie_count = c_cnt
                                        node_obj.last_sync = sync_time
                                purge_info = f"，清理 {purged_cnt} 条" if purged_cnt > 0 else ""
                                log_detail.append(
                                    f"-> 节点 [{n['name']}] {'差量' if diff_enabled else '全量'}写入 {len(match_inject['diff_cookies'])} 项 (跳过 {match_inject['skipped']} 项{purge_info})，现存 {c_cnt} 条"
                                )
                            elif purged_cnt > 0:
                                changed_any = True
                                c_cnt, _ = await probe_node_cookies(n["local_bind_port"], t_host, node_id=n["id"])
                                with session_scope() as db:
                                    node_obj = db.get(Node, n["id"])
                                    if node_obj is not None:
                                        node_obj.cookie_count = c_cnt
                                        node_obj.last_sync = sync_time
                                log_detail.append(f"-> 节点 [{n['name']}] 已按全局删除/黑名单策略清理 {purged_cnt} 条 Cookie，现存 {c_cnt} 条")
                            else:
                                log_detail.append(f"-> 节点 [{n['name']}] 凭据已对齐，跳过写入 (现存 {len(item['cookies'])} 条)")
                        status = "SUCCESS" if changed_any else "NO_CHANGE"

            elif policy["sync_type"] == "group_to_group":
                src_group = policy.get("source_group") or "默认分组"
                src_active_nodes = [n for n in active_nodes if n.get("group_name") == src_group]
                source_node_desc = f"🏢 自有源分组 [{src_group}] ({len(src_active_nodes)} 活跃)"
                if not src_active_nodes:
                    status = "SKIPPED"
                    log_detail.append(f"⚠️ 源分组 [{src_group}] 无在线空闲节点")
                else:
                    fetched_results = await asyncio.gather(
                        *(fetch_cookies_native(n["local_bind_port"], _resolve_node_target_host(n), node_id=n["id"]) for n in src_active_nodes),
                        return_exceptions=True,
                    )
                    valid_lists = [
                        filter_cookies_by_domains(r, include_domains, exclude_domains, cleanup_rules=cleanup_rules)[0]
                        for r in fetched_results
                        if isinstance(r, list)
                    ]

                    src_purged_any = False
                    if cleanup_rules.get("enabled"):
                        for idx, sn in enumerate(src_active_nodes):
                            raw_sn = (
                                fetched_results[idx]
                                if idx < len(fetched_results) and isinstance(fetched_results[idx], list)
                                else None
                            )
                            s_host = _resolve_node_target_host(sn)
                            src_purged = await purge_stale_cookies_on_node(
                                sn["local_bind_port"],
                                s_host,
                                exclude_domains,
                                node_id=sn["id"],
                                cleanup_rules=cleanup_rules,
                                pre_fetched_cookies=raw_sn,
                            )
                            if src_purged > 0:
                                src_purged_any = True
                                s_cnt, _ = await probe_node_cookies(sn["local_bind_port"], s_host, node_id=sn["id"])
                                with session_scope() as db:
                                    s_obj = db.get(Node, sn["id"])
                                    if s_obj is not None:
                                        s_obj.cookie_count = s_cnt
                                        s_obj.last_sync = sync_time
                                log_detail.append(f"-> 源节点 [{sn['name']}] 已按全局删除策略清理 {src_purged} 条，现存 {s_cnt} 条")

                    group_cookies, _ = smart_merge_cookies(valid_lists, max_per_domain=50)
                    cookie_count_metric = len(group_cookies)
                    dest_nodes = [n for n in scope_targets if n not in src_active_nodes]
                    if not dest_nodes:
                        if src_purged_any:
                            status = "SUCCESS"
                        else:
                            log_detail.append("ℹ️ 目标分组中无在线空闲接收节点")
                            status = "SKIPPED"
                    else:
                        injected_any = src_purged_any
                        for target in dest_nodes:
                            t_host = _resolve_node_target_host(target)
                            curr_c = await fetch_cookies_native(target["local_bind_port"], t_host, node_id=target["id"])
                            purged_cnt = 0
                            if cleanup_rules.get("enabled"):
                                purged_cnt = await purge_stale_cookies_on_node(
                                    target["local_bind_port"],
                                    t_host,
                                    exclude_domains,
                                    node_id=target["id"],
                                    cleanup_rules=cleanup_rules,
                                    pre_fetched_cookies=curr_c,
                                )
                            if diff_enabled:
                                diff_c, _ = compute_cookie_diff(curr_c, group_cookies)
                            else:
                                diff_c = list(group_cookies)

                            if diff_c:
                                injected_any = True
                                if not cleanup_rules.get("enabled"):
                                    purged_cnt = await purge_stale_cookies_on_node(
                                        target["local_bind_port"],
                                        t_host,
                                        exclude_domains,
                                        node_id=target["id"],
                                        cleanup_rules=cleanup_rules,
                                        pre_fetched_cookies=curr_c,
                                    )
                                await inject_cookies_native(target["local_bind_port"], diff_c, t_host, node_id=target["id"])
                                t_cnt, _ = await probe_node_cookies(target["local_bind_port"], t_host, node_id=target["id"])
                                with session_scope() as db:
                                    t_obj = db.get(Node, target["id"])
                                    if t_obj is not None:
                                        t_obj.cookie_count = t_cnt
                                        t_obj.last_sync = sync_time
                                purge_info = f"（清理 {purged_cnt} 条）" if purged_cnt > 0 else ""
                                log_detail.append(f"-> 目标 [{target['name']}] {'差量' if diff_enabled else '全量'}写入 {len(diff_c)} 项{purge_info}，现存 {t_cnt} 条")
                            elif purged_cnt > 0:
                                injected_any = True
                                t_cnt, _ = await probe_node_cookies(target["local_bind_port"], t_host, node_id=target["id"])
                                with session_scope() as db:
                                    t_obj = db.get(Node, target["id"])
                                    if t_obj is not None:
                                        t_obj.cookie_count = t_cnt
                                        t_obj.last_sync = sync_time
                                log_detail.append(f"-> 目标 [{target['name']}] 已全局清理 {purged_cnt} 条，现存 {t_cnt} 条")
                            else:
                                log_detail.append(f"-> 目标 [{target['name']}] 数据完全一致，跳过写入")
                        status = "SUCCESS" if injected_any else "NO_CHANGE"

            else:
                source = next((n for n in all_enabled_nodes if n["id"] == policy["source_id"]), None)
                if not source or source.get("status") != "connected":
                    source = next((n for n in active_nodes if n.get("is_source") == 1), None) or (active_nodes[0] if active_nodes else None)
                if not source:
                    status = "SKIPPED"
                    source_node_desc = "源端离线或正在出租中"
                    log_detail.append("⚠️ 源节点离线或处于市场出租隔离态")
                else:
                    source_node_desc = source["name"]
                    src_host = _resolve_node_target_host(source)
                    raw_c = await fetch_cookies_native(source["local_bind_port"], src_host, node_id=source["id"])
                    src_purged = 0
                    if cleanup_rules.get("enabled"):
                        src_purged = await purge_stale_cookies_on_node(
                            source["local_bind_port"],
                            src_host,
                            exclude_domains,
                            node_id=source["id"],
                            cleanup_rules=cleanup_rules,
                            pre_fetched_cookies=raw_c,
                        )
                        if src_purged > 0:
                            s_cnt, _ = await probe_node_cookies(source["local_bind_port"], src_host, node_id=source["id"])
                            with session_scope() as db:
                                s_obj = db.get(Node, source["id"])
                                if s_obj is not None:
                                    s_obj.cookie_count = s_cnt
                                    s_obj.last_sync = sync_time
                            log_detail.append(f"-> 源节点 [{source['name']}] 已按全局删除策略清理 {src_purged} 条 Cookie，现存 {s_cnt} 条")

                    cookies, _, _ = filter_cookies_by_domains(raw_c, include_domains, exclude_domains, cleanup_rules=cleanup_rules)
                    cookie_count_metric = len(cookies)
                    dest_nodes = [n for n in scope_targets if n["id"] != source["id"]]
                    if not dest_nodes:
                        if src_purged > 0:
                            status = "SUCCESS"
                        else:
                            log_detail.append("ℹ️ 目标接收队列中无在线空闲节点")
                            status = "SKIPPED"
                    else:
                        injected_any = src_purged > 0
                        for target in dest_nodes:
                            tgt_host = _resolve_node_target_host(target)
                            curr_c = await fetch_cookies_native(target["local_bind_port"], tgt_host, node_id=target["id"])
                            purged_cnt = 0
                            if cleanup_rules.get("enabled"):
                                purged_cnt = await purge_stale_cookies_on_node(
                                    target["local_bind_port"],
                                    tgt_host,
                                    exclude_domains,
                                    node_id=target["id"],
                                    cleanup_rules=cleanup_rules,
                                    pre_fetched_cookies=curr_c,
                                )
                            if diff_enabled:
                                diff_c, _ = compute_cookie_diff(curr_c, cookies)
                            else:
                                diff_c = list(cookies)

                            if diff_c:
                                injected_any = True
                                if not cleanup_rules.get("enabled"):
                                    purged_cnt = await purge_stale_cookies_on_node(
                                        target["local_bind_port"],
                                        tgt_host,
                                        exclude_domains,
                                        node_id=target["id"],
                                        cleanup_rules=cleanup_rules,
                                        pre_fetched_cookies=curr_c,
                                    )
                                await inject_cookies_native(target["local_bind_port"], diff_c, tgt_host, node_id=target["id"])
                                target_count, _ = await probe_node_cookies(target["local_bind_port"], tgt_host, node_id=target["id"])
                                with session_scope() as db:
                                    t_obj = db.get(Node, target["id"])
                                    if t_obj is not None:
                                        t_obj.cookie_count = target_count
                                        t_obj.last_sync = sync_time
                                purge_info = f"（清理 {purged_cnt} 条）" if purged_cnt > 0 else ""
                                log_detail.append(f"-> 目标 [{target['name']}] {'差量' if diff_enabled else '全量'}写入 {len(diff_c)} 项{purge_info}，现存 {target_count} 条")
                            elif purged_cnt > 0:
                                injected_any = True
                                target_count, _ = await probe_node_cookies(target["local_bind_port"], tgt_host, node_id=target["id"])
                                with session_scope() as db:
                                    t_obj = db.get(Node, target["id"])
                                    if t_obj is not None:
                                        t_obj.cookie_count = target_count
                                        t_obj.last_sync = sync_time
                                log_detail.append(f"-> 目标 [{target['name']}] 已全局清理 {purged_cnt} 条，现存 {target_count} 条")
                            else:
                                log_detail.append(f"-> 目标 [{target['name']}] 数据一致，跳过写入")
                        status = "SUCCESS" if injected_any else "NO_CHANGE"
        except Exception as e:
            status = "FAILED"
            log_detail.append(f"策略执行中断: {e}")

        duration_str = f"{time.time() - start_ts:.2f}s"
        with session_scope() as db:
            db.add(
                SyncLog(
                    owner_id=owner_id,
                    timestamp=sync_time,
                    source_node=source_node_desc,
                    target_nodes=target_nodes_desc,
                    cookie_count=cookie_count_metric,
                    duration=duration_str,
                    status=status,
                    details="\n".join(log_detail),
                )
            )
            policy_row = db.get(SyncPolicy, policy_id)
            if policy_row is not None:
                policy_row.last_run = sync_time
            db.flush()
            _trim_sync_logs(db, owner_id, 20)

        write_audit_log(
            action="sync_policy_run",
            actor_id=owner_id,
            actor_username=f"tenant:{owner_id}",
            target_type="sync_policy",
            target_id=policy_id,
            ip="scheduler",
            status="ok" if status in {"SUCCESS", "NO_CHANGE", "SKIPPED"} else "error",
            details={"policy_name": policy["name"], "status": status, "cookies": cookie_count_metric},
        )
        if status == "FAILED":
            await dispatch_notification(f"租户#{owner_id} 策略 [{policy['name']}] 执行失败", "\n".join(log_detail))
    finally:
        _running_owner_locks[owner_id] = False


async def execute_sync_task(policy_id: Optional[int] = None, owner_id: Optional[int] = None):
    if policy_id:
        await execute_policy_task(policy_id, owner_id_guard=owner_id)
        return
    with session_scope() as db:
        q = db.query(SyncPolicy).filter(SyncPolicy.enabled == 1)
        if owner_id is not None:
            q = q.filter(SyncPolicy.owner_id == int(owner_id))
        policy_ids = [p.id for p in q.order_by(SyncPolicy.id.asc()).all()]
    for pid in policy_ids:
        await execute_policy_task(pid, owner_id_guard=owner_id)
