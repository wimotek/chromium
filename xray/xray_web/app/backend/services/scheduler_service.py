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

    conn.close()
    set_setting("task_last_run", datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    return traffic_sent, expire_sent, f"检测完毕，已推送 {traffic_sent} 条流量预警，{expire_sent} 条到期预警"

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