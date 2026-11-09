import time
import datetime
import threading
from core.db import get_db, get_setting, set_setting
from core.cert_manager import auto_renew_acme_job
from services.notify_service import notify_user

def run_scheduled_check(force: bool = False) -> tuple[int, int, str]:
    enable = get_setting("task_notify_enable", "true").lower() == "true"
    if not enable and not force:
        return 0, 0, "定时任务未开启"

    traffic_threshold = int(get_setting("task_traffic_threshold", "80") or 80)
    expire_threshold_days = int(get_setting("task_expire_days", "3") or 3)
    today = datetime.date.today()
    current_year_month = today.strftime("%Y-%m")
    current_day = today.day

    traffic_sent, expire_sent = 0, 0
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE status=1 AND is_verified=1 AND role='user'")
    users = [dict(u) for u in c.fetchall()]

    for u in users:
        uname = u["username"]

        # 1. 每月固定套餐重置保证 (每个用户当月仅重置一次)
        if u.get("is_monthly") == 1:
            reset_day = int(u.get("reset_day", 1) or 1)
            if current_day >= reset_day or force:
                monthly_warn_key = f"monthly_reset_{current_year_month}"
                c.execute("SELECT id FROM notify_logs WHERE username=? AND warn_type=?", (uname, monthly_warn_key))
                if not c.fetchone() or force:
                    c.execute("UPDATE users SET used_mb=0 WHERE username=?", (uname,))
                    c.execute(
                        "INSERT INTO notify_logs (username, warn_type, sent_date) VALUES (?, ?, ?)",
                        (uname, monthly_warn_key, datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
                    )
                    conn.commit()
                    title = "【流量已重置】您的每月固定流量套餐已刷新"
                    content = f"您好 {uname}，今天是您的每月固定套餐重置日（每月 {reset_day} 号），已用流量已恢复满格！"
                    notify_user(u, title, f"<h3>{title}</h3><p>{content}</p>", content)

        # 2. 流量不足预警防骚扰
        used_mb = u.get("used_mb", 0)
        limit_mb = u.get("traffic_limit_mb", 1024)

        if limit_mb > 0:
            used_percent = round((used_mb / limit_mb) * 100, 1)
            if used_percent >= traffic_threshold:
                traffic_warn_key = (
                    f"traffic_warn_{current_year_month}_{limit_mb}"
                    if u.get("is_monthly") == 1
                    else f"traffic_warn_{limit_mb}"
                )
                c.execute("SELECT id FROM notify_logs WHERE username=? AND warn_type=?", (uname, traffic_warn_key))
                if not c.fetchone() or force:
                    title = "【流量预警】您的节点可用流量已不足"
                    content = f"您好 {uname}，当前已用流量已达 {round(used_mb, 1)}MB / {limit_mb}MB ({used_percent}%)。请及时充值续费。"
                    ok, _ = notify_user(u, title, f"<h3>{title}</h3><p>{content}</p>", content)
                    if ok:
                        traffic_sent += 1
                        c.execute(
                            "INSERT INTO notify_logs (username, warn_type, sent_date) VALUES (?, ?, ?)",
                            (uname, traffic_warn_key, datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
                        )
                        conn.commit()

        # 3. 套餐到期预警防骚扰
        exp_str = u.get("expire_date", "").strip()
        if exp_str and not exp_str.startswith("2099"):
            try:
                exp_date = datetime.datetime.strptime(exp_str[:10], "%Y-%m-%d").date()
                days_left = (exp_date - today).days
                if 0 <= days_left <= expire_threshold_days:
                    expire_warn_key = f"expire_warn_{exp_str[:10]}_days_{days_left}"
                    c.execute("SELECT id FROM notify_logs WHERE username=? AND warn_type=?", (uname, expire_warn_key))
                    if not c.fetchone() or force:
                        title = "【到期提醒】您的节点套餐即将到期"
                        content = f"您好 {uname}，您的节点服务套餐将于 {exp_str} 到期 (仅剩 {days_left} 天)。到期后服务将自动暂停。"
                        ok, _ = notify_user(u, title, f"<h3>{title}</h3><p>{content}</p>", content)
                        if ok:
                            expire_sent += 1
                            c.execute(
                                "INSERT INTO notify_logs (username, warn_type, sent_date) VALUES (?, ?, ?)",
                                (uname, expire_warn_key, datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
                            )
                            conn.commit()
            except Exception:
                pass

    # 4. 检查隔离区待审批节点超时告警
    try:
        check_pending_nodes_timeout(force=force)
    except Exception as e:
        print(f"[Pending Nodes Check Error] {e}", flush=True)

    conn.close()
    set_setting("task_last_run", datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    return traffic_sent, expire_sent, f"检测完毕，已推送 {traffic_sent} 条流量预警，{expire_sent} 条到期预警"

def check_pending_nodes_timeout(force: bool = False):
    """
    检查隔离区待审批 (is_approved=0) 节点的等待时长
    若超过系统设定的超时阈值 (默认 10 分钟)，且未被批准，按管理员设置的通道 (邮件/微信) 发送告警通知
    """
    from services.notify_service import notify_admin

    notify_enabled = get_setting("pending_node_notify_enable", "true").lower() == "true"
    if not notify_enabled and not force:
        return

    timeout_minutes = int(get_setting("pending_node_timeout_min", "10") or 10)
    now = datetime.datetime.now()

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM nodes WHERE is_approved=0")
    pending_nodes = [dict(r) for r in c.fetchall()]

    for node in pending_nodes:
        nid = node.get("node_id")
        nip = node.get("ip") or "未知IP"
        nname = node.get("name") or nid
        nmode = "WSS反穿 (NAT4)" if node.get("net_mode") == "reverse_wss" else "公网直连 (Reality)"
        
        hb_str = node.get("last_heartbeat") or ""
        if not hb_str:
            continue

        try:
            hb_time = datetime.datetime.strptime(hb_str, "%Y-%m-%d %H:%M:%S")
        except Exception:
            continue

        waiting_minutes = int((now - hb_time).total_seconds() / 60)

        # 超过配置的超时时间 (例如 10 分钟)
        if waiting_minutes >= timeout_minutes or force:
            warn_key = f"pending_timeout_{nid}"
            c.execute("SELECT id FROM notify_logs WHERE username='ADMIN' AND warn_type=?", (warn_key,))
            if not c.fetchone() or force:
                title = f"⚠️【待审批节点超时告警】节点 {nname} 滞留隔离区超 {waiting_minutes} 分钟！"
                html_body = f"""
                <div style="font-family: sans-serif; line-height: 1.6; color: #222;">
                    <h3 style="color: #d97706;">⚠️ 节点待审批超时提醒</h3>
                    <p>管理员您好，系统检测到有新的边缘节点已长时间在隔离区等待审核，请及时登入控制台处理：</p>
                    <table style="border-collapse: collapse; width: 100%; max-width: 500px; margin: 15px 0;">
                        <tr><td style="padding: 6px; border: 1px solid #ddd; background: #f8fafc;"><b>节点名称:</b></td><td style="padding: 6px; border: 1px solid #ddd;">{nname}</td></tr>
                        <tr><td style="padding: 6px; border: 1px solid #ddd; background: #f8fafc;"><b>节点 ID:</b></td><td style="padding: 6px; border: 1px solid #ddd;"><code>{nid}</code></td></tr>
                        <tr><td style="padding: 6px; border: 1px solid #ddd; background: #f8fafc;"><b>来源 IP:</b></td><td style="padding: 6px; border: 1px solid #ddd;">{nip}:{node.get('port', 443)}</td></tr>
                        <tr><td style="padding: 6px; border: 1px solid #ddd; background: #f8fafc;"><b>网络模式:</b></td><td style="padding: 6px; border: 1px solid #ddd;">{nmode}</td></tr>
                        <tr><td style="padding: 6px; border: 1px solid #ddd; background: #f8fafc;"><b>滞留等待时长:</b></td><td style="padding: 6px; border: 1px solid #ddd; color: #dc2626; font-weight: bold;">{waiting_minutes} 分钟 (阈值: {timeout_minutes}m)</td></tr>
                    </table>
                    <p style="color: #64748b; font-size: 13px;">请前往 <b>管理后台 -> 节点管理 -> 待审批隔离区</b> 点击「通过审批」以允许该节点接入业务。</p>
                </div>
                """
                text_body = f"【待审批节点超时告警】\n节点: {nname}\nID: {nid}\n来源: {nip}:{node.get('port', 443)}\n模式: {nmode}\n滞留等待: {waiting_minutes}分钟 (超限 {timeout_minutes}m)\n请登录管理控制台进行审批！"

                ok, log_msg = notify_admin(title, html_body, text_body)
                if ok:
                    c.execute(
                        "INSERT INTO notify_logs (username, warn_type, sent_date) VALUES ('ADMIN', ?, ?)",
                        (warn_key, datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
                    )
                    c.execute(
                        "INSERT INTO audit_logs (level, event_type, node_id, ip, message) VALUES (?, ?, ?, ?, ?)",
                        ("warn", "PENDING_NODE_TIMEOUT_ALERT", nid, nip, f"待审批节点滞留超限 ({waiting_minutes}m)，已向管理员发送通知: {log_msg}")
                    )
                    conn.commit()
    conn.close()

def start_scheduler_thread():
    def loop():
        time.sleep(10)
        while True:
            try:
                run_scheduled_check(force=False)
                auto_renew_acme_job()
            except Exception as e:
                print(f"[Scheduler Loop Error] {e}", flush=True)
            time.sleep(900)

    threading.Thread(target=loop, daemon=True).start()