import os
import time
import json
import inspect
import sqlite3
import asyncio
from datetime import datetime
from typing import Optional, List
from apscheduler.schedulers.background import BackgroundScheduler
from core.config import DB_PATH, KEYS_DIR, ChromiumSync, logger
from core.database import get_setting
from services.cdp_engine import (
    fetch_cookies_native,
    inject_cookies_native,
    probe_node_cookies,
    filter_cookies_by_domains,
    compute_cookie_diff,
    smart_merge_cookies
)
from services.notification import dispatch_notification

scheduler = BackgroundScheduler()

def reschedule_sync_job(minutes: int):
    try:
        if scheduler.get_job('cookie_sync_job'):
            scheduler.remove_job('cookie_sync_job')
        scheduler.add_job(
            lambda: asyncio.run(execute_sync_task()),
            'interval',
            minutes=max(1, minutes),
            id='cookie_sync_job'
        )
        logger.info(f"Cookie 同步定时调度任务已更新为每 {minutes} 分钟执行一次")
    except Exception as e:
        logger.error(f"更新定时调度异常: {e}")

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

async def execute_sync_task(custom_source_id: Optional[int] = None, custom_target_ids: Optional[List[int]] = None):
    start_ts = time.time()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes")
    nodes = [dict(row) for row in cur.fetchall()]
    conn.close()

    if not nodes:
        return

    sync_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_detail = []
    sync_mode = get_setting("sync_mode", "smart_merge")
    diff_enabled = (get_setting("sync_diff_enabled", "1") == "1")
    include_domains = [d.strip() for d in get_setting("sync_include_domains", "").split(",") if d.strip()]
    exclude_domains = [d.strip() for d in get_setting("sync_exclude_domains", "doubleclick.net,google-analytics.com").split(",") if d.strip()]

    source_node_desc = ""
    target_nodes_desc = ""
    cookie_count_metric = 0

    log_detail.append(f"📋 规则审计：差量检测=[{'开启' if diff_enabled else '关闭'}] | 白名单=[{len(include_domains)}项] | 黑名单=[{len(exclude_domains)}项]")

    # 场景 A: 默认首选【智能全局最新值合并 (Smart Merge)】
    if not custom_source_id and sync_mode == "smart_merge":
        source_node_desc = "🌟 全网智能汇聚"
        try:
            log_detail.append("🚀 触发【智能全局最新值合并 (Smart Merge)】：并发嗅探所有节点...")
            
            fetch_tasks = [
                fetch_cookies_native(n['local_bind_port'], n.get('direct_host', '127.0.0.1') if n['is_local'] else "127.0.0.1")
                for n in nodes
            ]
            fetched_results = await asyncio.gather(*fetch_tasks, return_exceptions=True)
            
            valid_cookie_lists = []
            for idx, res in enumerate(fetched_results):
                n_name = nodes[idx]['name']
                if isinstance(res, list):
                    cleaned_c, dropped = filter_cookies_by_domains(res, include_domains, exclude_domains)
                    valid_cookie_lists.append(cleaned_c)
                    drop_info = f" (已过滤 {dropped} 个黑名单/非白名单项)" if dropped > 0 else ""
                    log_detail.append(f"• 节点 [{n_name}] 贡献 {len(cleaned_c)} 条有效凭据{drop_info}")
                else:
                    log_detail.append(f"• 节点 [{n_name}] 暂时无法连接 ({res})")

            golden_pool = smart_merge_cookies(valid_cookie_lists)
            cookie_count_metric = len(golden_pool)
            target_nodes_desc = f"全网对齐 ({len(nodes)} 个节点)"
            log_detail.append(f"✨ 智能裁决融合完成：生成全网黄金凭据池 (共 {cookie_count_metric} 条唯一最新 Cookies)")

            async def _push_golden(node):
                target_h = node.get('direct_host', '127.0.0.1') if node['is_local'] else "127.0.0.1"
                try:
                    if diff_enabled:
                        curr_c = await fetch_cookies_native(node['local_bind_port'], target_h)
                        diff_cookies, skipped = compute_cookie_diff(curr_c, golden_pool)
                        if diff_cookies:
                            await inject_cookies_native(node['local_bind_port'], diff_cookies, target_h)
                        c_cnt, _ = await probe_node_cookies(node['local_bind_port'], target_h)
                        action_desc = f"差量注入 {len(diff_cookies)} 条更新项 (跳过 {skipped} 个无变化项)"
                    else:
                        await inject_cookies_native(node['local_bind_port'], golden_pool, target_h)
                        c_cnt, _ = await probe_node_cookies(node['local_bind_port'], target_h)
                        action_desc = f"全量写入 {len(golden_pool)} 条凭据"

                    conn = sqlite3.connect(DB_PATH)
                    cur = conn.cursor()
                    cur.execute("UPDATE nodes SET cookie_count=?, last_sync=? WHERE id=?", (c_cnt, sync_time, node['id']))
                    conn.commit()
                    conn.close()
                    return f"-> 节点 [{node['name']}] 对齐成功 ({action_desc}，现存 {c_cnt} 条)"
                except Exception as ex:
                    return f"-> 节点 [{node['name']}] 回写异常: {ex}"

            push_tasks = [_push_golden(n) for n in nodes]
            push_results = await asyncio.gather(*push_tasks)
            log_detail.extend(push_results)
            status = "SUCCESS"
        except Exception as e:
            status = "FAILED"
            log_detail.append(f"智能合并调度中断: {e}")

    # 场景 B: 传统指定主节点单向广播
    else:
        source = None
        if custom_source_id:
            source = next((n for n in nodes if n["id"] == custom_source_id), None)
        if not source:
            rule_source_id = int(get_setting("sync_source_id", "0"))
            if rule_source_id > 0:
                source = next((n for n in nodes if n["id"] == rule_source_id), None)
            if not source:
                source = next((n for n in nodes if n["is_source"] == 1), None)

        if not source:
            logger.warning("未配置或无法找到源节点，跳过主从分发。")
            return

        source_host_display = source.get('direct_host', '127.0.0.1') if source['is_local'] else source['ssh_host']
        source_node_desc = f"{source['name']} ({'直连:' + source_host_display if source['is_local'] else source_host_display})"

        targets = []
        if custom_target_ids is not None:
            targets = [n for n in nodes if n["id"] in custom_target_ids and n["id"] != source["id"]]
        else:
            target_ids_cfg = json.loads(get_setting("sync_target_ids", "[]"))
            if target_ids_cfg:
                targets = [n for n in nodes if n["id"] in target_ids_cfg and n["id"] != source["id"]]
            else:
                targets = [n for n in nodes if n["id"] != source["id"]]

        target_nodes_desc = ", ".join([t['name'] for t in targets]) if targets else "无分发目标"

        try:
            source_h = source.get('direct_host', '127.0.0.1') if source['is_local'] else "127.0.0.1"
            raw_cookies = await fetch_cookies_native(source['local_bind_port'], source_h)
            cookies, dropped = filter_cookies_by_domains(raw_cookies, include_domains, exclude_domains)
            cookie_count_metric = len(cookies)
            drop_info = f" (已过滤 {dropped} 个黑名单/非白名单项)" if dropped > 0 else ""
            log_detail.append(f"主从广播：从源节点 [{source['name']}] 捕获到 {cookie_count_metric} 个有效 Cookies{drop_info}")

            for target in targets:
                target_h = target.get('direct_host', '127.0.0.1') if target['is_local'] else "127.0.0.1"
                try:
                    if ChromiumSync is not None and not target['is_local']:
                        sync_res = await run_chromium_sync_instance(source, target, include_domains, exclude_domains, diff_enabled)
                        target_count, _ = await probe_node_cookies(target['local_bind_port'], target_h)
                        msg = sync_res.get("message", "OK") if isinstance(sync_res, dict) else sync_res
                        log_detail.append(f"-> 目标节点 [{target['name']}] 模块同步完成 ({msg})，现存: {target_count}")
                    else:
                        if diff_enabled:
                            curr_c = await fetch_cookies_native(target['local_bind_port'], target_h)
                            diff_c, skipped = compute_cookie_diff(curr_c, cookies)
                            if diff_c:
                                await inject_cookies_native(target['local_bind_port'], diff_c, target_h)
                            act = f"差量注入 {len(diff_c)} 条 (跳过 {skipped} 个无变化项)"
                        else:
                            await inject_cookies_native(target['local_bind_port'], cookies, target_h)
                            act = f"全量写入 {len(cookies)} 条"

                        target_count, _ = await probe_node_cookies(target['local_bind_port'], target_h)
                        log_detail.append(f"-> 目标节点 [{target['name']}] 写入完成 ({act})，现存: {target_count}")
                except Exception as ex:
                    log_detail.append(f"-> 目标节点 [{target['name']}] 写入异常: {ex}")
            status = "SUCCESS"
        except Exception as e:
            status = "FAILED"
            log_detail.append(f"主从分发中断: {e}")

    duration_str = f"{time.time() - start_ts:.2f}s"

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO sync_logs (timestamp, source_node, target_nodes, cookie_count, duration, status, details)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (sync_time, source_node_desc, target_nodes_desc, cookie_count_metric, duration_str, status, "\n".join(log_detail)))

    # ==================== 核心机制：自动滚动裁剪仅保留最新 20 条 ====================
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

    if status == "FAILED":
        await dispatch_notification("Cookie 同步告警", f"时间: {sync_time} (耗时: {duration_str})\n详情:\n" + "\n".join(log_detail))