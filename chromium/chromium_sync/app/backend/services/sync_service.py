import os
import time
import json
import inspect
import sqlite3
import asyncio
from datetime import datetime, timedelta
from typing import Optional, List
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.events import EVENT_JOB_EXECUTED, EVENT_JOB_ERROR

from config import DB_PATH, KEYS_DIR, ChromiumSync, logger
from core.database import get_setting
from services.cdp_engine import (
    fetch_cookies_native,
    inject_cookies_native,
    probe_node_cookies,
    filter_cookies_by_domains,
    compute_cookie_diff,
    smart_merge_cookies,
    purge_stale_cookies_on_node
)
from services.notification import dispatch_notification

scheduler = BackgroundScheduler(timezone="Asia/Shanghai")

_is_sync_running = False

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
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(execute_policy_task(policy_id))
        finally:
            loop.close()
    except Exception as e:
        logger.error(f"定时调度任务异常 (策略ID: {policy_id}): {e}", exc_info=True)

def reschedule_all_policies():
    conn = sqlite3.connect(DB_PATH)
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
        logger.info(f"⏱️ 策略 [{p['name']}] (ID:{p['id']}) 装载完成 | 周期: {interval}分钟 | 下次运行时间: {first_run.strftime('%Y-%m-%d %H:%M:%S')}")

async def run_chromium_sync_instance(source_node: dict, target_node: dict, include_domains: List[str], exclude_domains: List[str], diff_enabled: bool) -> dict:
    if ChromiumSync is None:
        raise ImportError("未安装 wimotek-chromium-sync 模块")

    sig = inspect.signature(ChromiumSync.__init__)
    kwargs = {
        "remote_ssh": f"{target_node['ssh_user']}@{target_node['ssh_host']}",
        "remote_ssh_port": int(target_node['ssh_port']),
        "local_cdp_port": int(source_node['local_bind_port']),
        "remote_cdp_port": int(target_node['remote_cdp_port']),
        "remote_tunnel_port": int(target_node['local_bind_port']),
        "direction": "push",
        "timeout": 10
    }

    if target_node.get('ssh_key_filename'):
        key_path = os.path.join(KEYS_DIR, target_node['ssh_key_filename'])
        for k_param in ['ssh_key', 'key_file', 'key_filename', 'pkey']:
            if k_param in sig.parameters:
                kwargs[k_param] = key_path
                break
        os.environ["GIT_SSH_COMMAND"] = f"ssh -i {key_path} -o StrictHostKeyChecking=no"

    if target_node.get('ssh_password'):
        for p_param in ['ssh_password', 'password']:
            if p_param in sig.parameters:
                kwargs[p_param] = target_node['ssh_password']
                break

    if "include_domains" in sig.parameters:
        kwargs["include_domains"] = include_domains
    if "exclude_domains" in sig.parameters:
        kwargs["exclude_domains"] = exclude_domains
    for diff_arg in ["diff", "diff_enabled", "delta"]:
        if diff_arg in sig.parameters:
            kwargs[diff_arg] = diff_enabled
            break

    filtered = {k: v for k, v in kwargs.items() if k in sig.parameters}
    syncer = ChromiumSync(**filtered)

    if hasattr(syncer, 'run_async') and inspect.iscoroutinefunction(getattr(syncer, 'run_async')):
        res = await syncer.run_async()
    else:
        res = await asyncio.to_thread(syncer.run)

    if isinstance(res, dict):
        return res
    return {"status": "success", "message": str(res) if res else "OK"}

async def execute_policy_task(policy_id: int):
    """
    根据策略执行同步：集成【前置差异研判】与【零变化秒级跳过】
    """
    global _is_sync_running
    if _is_sync_running:
        logger.warning(f"⚠️ 拦截重复调度：已有策略正在同步中，策略 ID:{policy_id} 自动跳过")
        return

    _is_sync_running = True
    start_ts = time.time()

    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT * FROM sync_policies WHERE id=?", (policy_id,))
        policy_row = cur.fetchone()
        
        cur.execute("SELECT * FROM nodes WHERE enabled=1")
        all_enabled_nodes = [dict(r) for r in cur.fetchall()]
        conn.close()

        if not policy_row or not all_enabled_nodes:
            logger.warning(f"策略 ID:{policy_id} 执行跳过: 策略不存在或无可用节点")
            return

        policy = dict(policy_row)
        sync_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        log_detail = [f"🚀 触发策略 [{policy['name']}] (类型: {policy['sync_type']})"]

        active_nodes = [n for n in all_enabled_nodes if n.get("status") == "connected"]
        inactive_nodes = [n for n in all_enabled_nodes if n.get("status") != "connected"]
        
        if inactive_nodes:
            skip_names = ", ".join([n['name'] for n in inactive_nodes])
            log_detail.append(f"ℹ️ 自动跳过 {len(inactive_nodes)} 个离线节点: {skip_names}")

        diff_enabled = (get_setting("sync_diff_enabled", "1") == "1")
        include_domains = [d.strip() for d in get_setting("sync_include_domains", "").split(",") if d.strip()]
        exclude_domains = [d.strip() for d in get_setting("sync_exclude_domains", "doubleclick.net,google-analytics.com").split(",") if d.strip()]

        source_node_desc = ""
        target_nodes_desc = ""
        cookie_count_metric = 0

        # 解析目标节点
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
            # ==================== A. 全网智能最新值合并 ====================
            if policy["sync_type"] == "smart_merge":
                source_node_desc = "🌟 智能多主汇聚"
                merge_pool_nodes = scope_targets if policy["target_type"] == "group" else active_nodes

                if not merge_pool_nodes:
                    log_detail.append("⚠️ 无可用在线活跃节点，本次智能合并自动挂起跳过")
                    status = "SKIPPED"
                else:
                    # 1. 单次并发抓取各节点 Cookie 存入内存
                    fetch_tasks = [
                        fetch_cookies_native(n['local_bind_port'], n.get('direct_host', '127.0.0.1') if n['is_local'] else "127.0.0.1")
                        for n in merge_pool_nodes
                    ]
                    fetched_results = await asyncio.gather(*fetch_tasks, return_exceptions=True)
                    
                    node_in_memory_data = [] # 结构: [{"node": n, "cookies": cleaned_c, "dropped": count}]
                    valid_cookie_lists = []
                    total_dropped = 0

                    for idx, res in enumerate(fetched_results):
                        n = merge_pool_nodes[idx]
                        if isinstance(res, list):
                            cleaned_c, bl_cnt, exp_cnt = filter_cookies_by_domains(res, include_domains, exclude_domains)
                            valid_cookie_lists.append(cleaned_c)
                            total_dropped += (bl_cnt + exp_cnt)
                            node_in_memory_data.append({"node": n, "cookies": cleaned_c})
                        else:
                            log_detail.append(f"• 节点 [{n['name']}] 握手异常，自动跳过")

                    # 2. 聚拢生成黄金池 (带四元组分区防重与 50 条熔断)
                    golden_pool, cap_trimmed = smart_merge_cookies(valid_cookie_lists, max_per_domain=50)
                    cookie_count_metric = len(golden_pool)

                    # ==================== 核心：前置差异研判 (Pre-flight Diff Check) ====================
                    nodes_to_inject = []
                    total_diff_count = 0

                    for item in node_in_memory_data:
                        n = item["node"]
                        node_cookies = item["cookies"]
                        # 在内存中直接比对目标与黄金池的差异
                        diff_c, skipped = compute_cookie_diff(node_cookies, golden_pool)
                        if diff_c:
                            nodes_to_inject.append({"node": n, "diff_cookies": diff_c, "skipped": skipped})
                            total_diff_count += len(diff_c)

                    # 3. 全局无变化秒级跳过 (Fast-Skip)
                    if total_diff_count == 0 and total_dropped == 0 and cap_trimmed == 0:
                        elapsed_fast = f"{(time.time() - start_ts):.2f}s"
                        log_detail.append(f"⚡ [前置比对无差异] 各节点凭据已 100% 保持最新且完全对齐 (0 差异项 / 0 过期垃圾)，已自动跳过下发落盘 (耗时: {elapsed_fast})")
                        status = "NO_CHANGE"
                    else:
                        log_detail.append(f"✨ 黄金凭据池聚拢完成: 共 {cookie_count_metric} 条最新 Cookies (发现 {total_diff_count} 项增量需对齐)")
                        
                        # 4. 仅向真正有差异的节点发起定向写入 (差异为0的节点直接忽略，不连网络)
                        for item in node_in_memory_data:
                            n = item["node"]
                            match_inject = next((x for x in nodes_to_inject if x["node"]["id"] == n["id"]), None)
                            target_h = n.get('direct_host', '127.0.0.1') if n['is_local'] else "127.0.0.1"
                            
                            if match_inject:
                                # 有差异：物理清理垃圾 + 仅注入增量项
                                purged_cnt = await purge_stale_cookies_on_node(n['local_bind_port'], target_h, exclude_domains)
                                diff_c = match_inject["diff_cookies"]
                                skipped = match_inject["skipped"]
                                await inject_cookies_native(n['local_bind_port'], diff_c, target_h)
                                c_cnt, _ = await probe_node_cookies(n['local_bind_port'], target_h)
                                
                                conn = sqlite3.connect(DB_PATH)
                                cur = conn.cursor()
                                cur.execute("UPDATE nodes SET cookie_count=?, last_sync=? WHERE id=?", (c_cnt, sync_time, n['id']))
                                conn.commit()
                                conn.close()
                                
                                purge_info = f"，清除 {purged_cnt} 垃圾" if purged_cnt > 0 else ""
                                log_detail.append(f"-> 节点 [{n['name']}] 差量写入 {len(diff_c)} 项 (跳过 {skipped} 个无变化项{purge_info})，现存 {c_cnt} 条")
                            else:
                                # 毫无差异：直接标记跳过，0 次网络连接
                                log_detail.append(f"-> 节点 [{n['name']}] 凭据已对齐，跳过写入 (现存 {len(item['cookies'])} 条)")

                        status = "SUCCESS"

            # ==================== B. 组对组分发 (含前置比对) ====================
            elif policy["sync_type"] == "group_to_group":
                src_group = policy.get("source_group") or "默认分组"
                src_active_nodes = [n for n in active_nodes if n.get("group_name") == src_group]
                source_node_desc = f"🏢 源分组 [{src_group}] ({len(src_active_nodes)} 活跃)"

                if not src_active_nodes:
                    log_detail.append(f"⚠️ 源分组 [{src_group}] 中无在线活跃节点，已自动跳过")
                    status = "SKIPPED"
                else:
                    fetch_tasks = [
                        fetch_cookies_native(n['local_bind_port'], n.get('direct_host', '127.0.0.1') if n['is_local'] else "127.0.0.1")
                        for n in src_active_nodes
                    ]
                    fetched_results = await asyncio.gather(*fetch_tasks, return_exceptions=True)
                    valid_lists = [filter_cookies_by_domains(r, include_domains, exclude_domains)[0] for r in fetched_results if isinstance(r, list)]

                    group_cookies, _ = smart_merge_cookies(valid_lists, max_per_domain=50)
                    cookie_count_metric = len(group_cookies)

                    dest_nodes = [n for n in scope_targets if n not in src_active_nodes]
                    if not dest_nodes:
                        log_detail.append("ℹ️ 目标分组中无在线活跃接收节点")
                        status = "SKIPPED"
                    else:
                        # 检查目标节点是否有差异
                        injected_any = False
                        for target in dest_nodes:
                            target_h = target.get('direct_host', '127.0.0.1') if target['is_local'] else "127.0.0.1"
                            curr_c = await fetch_cookies_native(target['local_bind_port'], target_h)
                            diff_c, skipped = compute_cookie_diff(curr_c, group_cookies)
                            
                            if diff_c:
                                injected_any = True
                                await purge_stale_cookies_on_node(target['local_bind_port'], target_h, exclude_domains)
                                await inject_cookies_native(target['local_bind_port'], diff_c, target_h)
                                t_cnt, _ = await probe_node_cookies(target['local_bind_port'], target_h)
                                log_detail.append(f"-> 目标节点 [{target['name']}] 差量写入 {len(diff_c)} 项，现存: {t_cnt}")
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
                    source_node_desc = f"{source['name']} ({'本地' if source['is_local'] else source['ssh_host']})"
                    source_h = source.get('direct_host', '127.0.0.1') if source['is_local'] else "127.0.0.1"

                    raw_c = await fetch_cookies_native(source['local_bind_port'], source_h)
                    cookies, _, _ = filter_cookies_by_domains(raw_c, include_domains, exclude_domains)
                    cookie_count_metric = len(cookies)

                    dest_nodes = [n for n in scope_targets if n["id"] != source["id"]]
                    if not dest_nodes:
                        log_detail.append("ℹ️ 目标接收队列中无在线活跃节点")
                        status = "SKIPPED"
                    else:
                        injected_any = False
                        for target in dest_nodes:
                            target_h = target.get('direct_host', '127.0.0.1') if target['is_local'] else "127.0.0.1"
                            curr_c = await fetch_cookies_native(target['local_bind_port'], target_h)
                            diff_c, skipped = compute_cookie_diff(curr_c, cookies)
                            
                            if diff_c:
                                injected_any = True
                                await purge_stale_cookies_on_node(target['local_bind_port'], target_h, exclude_domains)
                                if ChromiumSync is not None and not target['is_local']:
                                    sync_res = await run_chromium_sync_instance(source, target, include_domains, exclude_domains, diff_enabled)
                                    target_count, _ = await probe_node_cookies(target['local_bind_port'], target_h)
                                    log_detail.append(f"-> 目标节点 [{target['name']}] 模块同步完成，现存: {target_count}")
                                else:
                                    await inject_cookies_native(target['local_bind_port'], diff_c, target_h)
                                    target_count, _ = await probe_node_cookies(target['local_bind_port'], target_h)
                                    log_detail.append(f"-> 目标节点 [{target['name']}] 差量写入 {len(diff_c)} 项，现存: {target_count}")
                            else:
                                log_detail.append(f"-> 目标节点 [{target['name']}] 数据一致，跳过写入")

                        status = "SUCCESS" if injected_any else "NO_CHANGE"

        except Exception as e:
            status = "FAILED"
            log_detail.append(f"策略执行中断: {e}")

        duration_str = f"{time.time() - start_ts:.2f}s"

        # 写回审计流水
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO sync_logs (timestamp, source_node, target_nodes, cookie_count, duration, status, details)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (sync_time, source_node_desc, target_nodes_desc, cookie_count_metric, duration_str, status, "\n".join(log_detail)))
        
        cur.execute("UPDATE sync_policies SET last_run=? WHERE id=?", (sync_time, policy_id))

        # 滚动淘汰保持 20 条
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

        # 顺延下次调度
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

    conn = sqlite3.connect(DB_PATH)
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