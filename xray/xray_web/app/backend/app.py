import os
import io
import uuid
import random
import datetime
import threading
import time
import qrcode
import qrcode.image.svg
from flask import Flask, request, jsonify, send_from_directory, abort, send_file
from config import Config
from db import init_db, get_db, hash_pwd, get_setting, set_setting
from xray import (
    get_reality_public_key,
    query_user_traffic,
    build_vless_link,
    sync_users_to_xray,
    get_xray_reality_params,
    get_connection_host
)
from notify import send_smtp_email, send_serverchan_msg, notify_user

app = Flask(__name__, static_folder='../frontend/dist', static_url_path='/')

# 1. 初始化数据库表结构
init_db()

# 2. 开机全量同步：服务启动瞬间把数据库中所有有效用户写入 Xray 的 config.json 并补全 stats/api
sync_users_to_xray()

# ==================== 定时自动检测与推送引擎 ====================

def run_scheduled_check(force=False) -> tuple[int, int, str]:
    enable = get_setting("task_notify_enable", "true").lower() == "true"
    if not enable and not force:
        return 0, 0, "定时任务未开启"

    traffic_threshold = int(get_setting("task_traffic_threshold", "80") or 80)
    expire_threshold_days = int(get_setting("task_expire_days", "3") or 3)
    today_str = datetime.date.today().strftime("%Y-%m-%d")

    traffic_sent = 0
    expire_sent = 0

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE status=1 AND is_verified=1 AND role='user'")
    users = [dict(u) for u in c.fetchall()]

    for u in users:
        uname = u["username"]
        used_mb = query_user_traffic(uname)
        limit_mb = u.get("traffic_limit_mb", 1024)

        if limit_mb > 0:
            used_percent = round((used_mb / limit_mb) * 100, 1)
            if used_percent >= traffic_threshold:
                c.execute("SELECT id FROM notify_logs WHERE username=? AND warn_type='traffic' AND sent_date=?", (uname, today_str))
                if not c.fetchone() or force:
                    title = "【流量预警】您的节点可用流量已不足"
                    content = (f"您好 {uname}，系统检测到您当前已用流量达到 {used_mb}MB / {limit_mb}MB "
                               f"(使用率已达 {used_percent}%)。为避免停机，请及时登录面板充值续费。")
                    ok, _ = notify_user(u, title, f"<h3>{title}</h3><p>{content}</p>", content)
                    if ok:
                        traffic_sent += 1
                        c.execute("INSERT INTO notify_logs (username, warn_type, sent_date) VALUES (?, 'traffic', ?)", (uname, today_str))
                        conn.commit()

        exp_str = u.get("expire_date", "").strip()
        if exp_str:
            try:
                exp_date = datetime.datetime.strptime(exp_str[:10], "%Y-%m-%d").date()
                days_left = (exp_date - datetime.date.today()).days
                if 0 <= days_left <= expire_threshold_days:
                    c.execute("SELECT id FROM notify_logs WHERE username=? AND warn_type='expire' AND sent_date=?", (uname, today_str))
                    if not c.fetchone() or force:
                        title = "【到期提醒】您的节点套餐即将到期"
                        content = (f"您好 {uname}，您的节点服务套餐将于 {exp_str} 到期 "
                                   f"(仅剩 {days_left} 天)。到期后服务将自动暂停，请尽快登录充值卡密。")
                        ok, _ = notify_user(u, title, f"<h3>{title}</h3><p>{content}</p>", content)
                        if ok:
                            expire_sent += 1
                            c.execute("INSERT INTO notify_logs (username, warn_type, sent_date) VALUES (?, 'expire', ?)", (uname, today_str))
                            conn.commit()
            except Exception:
                pass

    conn.close()
    now_time = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    set_setting("task_last_run", now_time)
    return traffic_sent, expire_sent, f"检测完毕，已成功推送 {traffic_sent} 条流量预警，{expire_sent} 条到期预警"

def scheduled_worker_loop():
    time.sleep(15)
    while True:
        try:
            interval_hours = int(get_setting("task_interval_hours", "12") or 12)
            run_scheduled_check(force=False)
        except Exception as e:
            print(f"[Task Error] {e}", flush=True)
        sleep_sec = max(3600, interval_hours * 3600)
        time.sleep(sleep_sec)

task_thread = threading.Thread(target=scheduled_worker_loop, daemon=True)
task_thread.start()

# ==================== 前台基础路由 ====================

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/api/system/info', methods=['GET'])
def system_info():
    return jsonify({
        "code": 200,
        "data": {
            "mode": Config.APP_MODE,
            "public_key": get_reality_public_key()
        }
    })

@app.route('/api/qrcode', methods=['GET'])
def get_qrcode_svg():
    text = request.args.get('text', '').strip()
    if not text:
        abort(400)
    img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    buf.seek(0)
    return send_file(buf, mimetype='image/svg+xml')

# ==================== 方案 C：第三方发卡系统开放 API ====================

@app.route('/api/open/faka_generate', methods=['GET', 'POST'])
def open_faka_generate():
    is_enabled = get_setting("faka_api_enable", "true").lower() == "true"
    if not is_enabled:
        return jsonify({"code": 403, "msg": "第三方发卡 API 接口已被管理员禁用"}), 403

    req_token = request.headers.get("Authorization") or request.args.get("token")
    if not req_token and request.is_json:
        req_token = (request.json or {}).get("token")

    if req_token and req_token.startswith("Bearer "):
        req_token = req_token[7:].strip()

    valid_token = get_setting("faka_api_token", Config.FAKA_API_TOKEN).strip()
    if not req_token or req_token.strip() != valid_token:
        return jsonify({"code": 403, "msg": "Invalid API Token"}), 403

    gb_param = request.args.get("gb") or (request.json or {}).get("gb") if request.is_json else None
    days_param = request.args.get("days") or (request.json or {}).get("days") if request.is_json else None

    try:
        traffic_gb = int(gb_param or 100)
        days = int(days_param or 30)
    except ValueError:
        traffic_gb, days = 100, 30

    code = "KM-" + str(uuid.uuid4()).replace("-", "")[:12].upper()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    conn = get_db()
    c = conn.cursor()
    c.execute("INSERT INTO cards VALUES (?, ?, ?, 0, NULL, ?)", (code, traffic_gb, days, now))
    conn.commit()
    conn.close()

    if request.args.get("format") == "json":
        return jsonify({
            "code": 200,
            "card": code,
            "traffic_gb": traffic_gb,
            "days": days
        })

    return code, 200, {"Content-Type": "text/plain; charset=utf-8"}

# ==================== 用户认证与安全 ====================

@app.route('/api/auth/send_register_code', methods=['POST'])
def send_register_code():
    data = request.json or {}
    email = data.get('email', '').strip().lower()
    if not email or '@' not in email:
        return jsonify({"code": 400, "msg": "请输入合法的电子邮箱"})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT id FROM users WHERE email=?", (email,))
    if c.fetchone():
        conn.close()
        return jsonify({"code": 400, "msg": "该邮箱已被注册"})

    code = f"{random.randint(100000, 999999)}"
    c.execute("INSERT INTO verify_codes (email, code) VALUES (?, ?)", (email, code))
    conn.commit()
    conn.close()

    content = f"""
    <div style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 25px; border-radius: 8px;">
        <h2 style="color: #38bdf8;">⚡ Xray Reality 账号激活验证</h2>
        <p>您好！您正在申请注册节点服务账号。</p>
        <p>您的激活验证码为：<b style="font-size: 24px; color: #10b981; letter-spacing: 2px;">{code}</b></p>
        <p style="color: #94a3b8; font-size: 12px;">验证码 10 分钟内有效。如非本人操作请忽略此邮件。</p>
    </div>
    """
    success, msg = send_smtp_email(email, "【Xray】注册账号激活验证码", content)
    if not success:
        return jsonify({"code": 500, "msg": msg})

    return jsonify({"code": 200, "msg": "激活验证码已发送至您的邮箱，请查收"})

@app.route('/api/register', methods=['POST'])
def register():
    if Config.APP_MODE == 'admin':
        return jsonify({"code": 403, "msg": "当前节点为纯管理模式，不开放公网注册"})

    data = request.json or {}
    u = data.get('username', '').strip()
    p = data.get('password', '').strip()
    email = data.get('email', '').strip().lower()
    code = data.get('code', '').strip()

    if not u or not p or not email or not code:
        return jsonify({"code": 400, "msg": "所有项均为必填项"})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT code FROM verify_codes WHERE email=? ORDER BY id DESC LIMIT 1", (email,))
    row = c.fetchone()
    if not row or row["code"] != code:
        conn.close()
        return jsonify({"code": 400, "msg": "验证码错误或已失效"})

    c.execute("SELECT id FROM users WHERE username=? OR email=?", (u, email))
    if c.fetchone():
        conn.close()
        return jsonify({"code": 400, "msg": "用户名或邮箱已被占用"})

    exp = (datetime.datetime.now() + datetime.timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
    try:
        c.execute("INSERT INTO users (username, password_hash, uuid, email, traffic_limit_mb, expire_date, role, status, is_verified) VALUES (?, ?, ?, ?, 1024, ?, 'user', 1, 1)",
                  (u, hash_pwd(p), str(uuid.uuid4()), email, exp))
        c.execute("DELETE FROM verify_codes WHERE email=?", (email,))
        conn.commit()
        conn.close()

        # 核心联动：新用户注册成功，立刻同步至 Xray 核心生效
        sync_users_to_xray()

        return jsonify({"code": 200, "msg": "账号已成功激活注册，已获赠 1GB 体验套餐"})
    except Exception as e:
        conn.close()
        return jsonify({"code": 500, "msg": f"数据库写入失败: {str(e)}"})

@app.route('/api/auth/send_reset_code', methods=['POST'])
def send_reset_code():
    data = request.json or {}
    email = data.get('email', '').strip().lower()
    if not email or '@' not in email:
        return jsonify({"code": 400, "msg": "请输入合法的电子邮箱"})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT id, username FROM users WHERE email=?", (email,))
    user = c.fetchone()
    if not user:
        conn.close()
        return jsonify({"code": 404, "msg": "该邮箱尚未绑定任何已注册的账号"})

    code = f"{random.randint(100000, 999999)}"
    c.execute("INSERT INTO verify_codes (email, code) VALUES (?, ?)", (email, code))
    conn.commit()
    conn.close()

    content = f"""
    <div style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 25px; border-radius: 8px;">
        <h2 style="color: #38bdf8;">🔐 Xray Reality 密码重置验证</h2>
        <p>您好 <b>{user['username']}</b>！您正在申请找回并重置登录密码。</p>
        <p>您的重置验证码为：<b style="font-size: 24px; color: #f59e0b; letter-spacing: 2px;">{code}</b></p>
        <p style="color: #94a3b8; font-size: 12px;">验证码 10 分钟内有效。如非本人操作请立即核查账号安全。</p>
    </div>
    """
    success, msg = send_smtp_email(email, "【Xray】找回登录密码验证码", content)
    if not success:
        return jsonify({"code": 500, "msg": msg})

    return jsonify({"code": 200, "msg": "密码重置验证码已发送至您的邮箱，请查收"})

@app.route('/api/auth/reset_password', methods=['POST'])
def reset_password():
    data = request.json or {}
    email = data.get('email', '').strip().lower()
    code = data.get('code', '').strip()
    new_pwd = data.get('new_password', '').strip()

    if not email or not code or not new_pwd:
        return jsonify({"code": 400, "msg": "请填写完整重置信息"})
    if len(new_pwd) < 6:
        return jsonify({"code": 400, "msg": "新密码长度至少需要 6 位"})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT code FROM verify_codes WHERE email=? ORDER BY id DESC LIMIT 1", (email,))
    row = c.fetchone()
    if not row or row["code"] != code:
        conn.close()
        return jsonify({"code": 400, "msg": "验证码错误或已失效"})

    c.execute("SELECT * FROM users WHERE email=?", (email,))
    user = c.fetchone()
    if not user:
        conn.close()
        return jsonify({"code": 404, "msg": "未找到对应账号"})

    c.execute("UPDATE users SET password_hash=? WHERE email=?", (hash_pwd(new_pwd), email))
    c.execute("DELETE FROM verify_codes WHERE email=?", (email,))
    conn.commit()
    conn.close()

    title = "【Xray 安全通知】您的账户密码已成功重置"
    text = f"您好 {user['username']}，您的登录密码已通过邮箱验证码重置成功。如非本人操作请立即联系管理人员。"
    notify_user(dict(user), title, f"<p>{text}</p>", text)

    return jsonify({"code": 200, "msg": "密码已成功重置，请使用新密码登录"})

@app.route('/api/login', methods=['POST'])
def login():
    data = request.json or {}
    account = data.get('username', '').strip()
    p = data.get('password', '').strip()

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE (username=? OR email=?) AND password_hash=?", (account, account, hash_pwd(p)))
    user = c.fetchone()
    conn.close()

    if not user:
        return jsonify({"code": 401, "msg": "账号或密码错误"})

    if user['status'] == 0:
        return jsonify({"code": 403, "msg": "该账号已被管理员封禁停用，无法登录！"})

    if user['is_verified'] == 0:
        return jsonify({"code": 403, "msg": "账号尚未通过邮箱激活验证，无法登录"})

    if Config.APP_MODE == 'user' and user['role'] == 'admin':
        return jsonify({"code": 403, "msg": "当前节点为纯用户端模式，已屏蔽管理员登录"})

    used_mb = query_user_traffic(user['username'])
    # 动态抓取当前 Xray 正在运行的真实参数（自动识别后台自定义域名或外网 IP）
    params = get_xray_reality_params()
    link = build_vless_link(user['uuid'], params['pbk'], f"{user['username']}-Reality")

    return jsonify({
        "code": 200,
        "data": {
            "username": user['username'],
            "email": user['email'],
            "role": user['role'],
            "used_mb": used_mb,
            "limit_mb": user['traffic_limit_mb'],
            "expire_date": user['expire_date'],
            "public_key": params['pbk'],
            "sub_link": link,
            "notify_type": user['notify_type'] or 'email',
            "serverchan_key": user['serverchan_key'] or ''
        }
    })

@app.route('/api/user/change_password', methods=['POST'])
def change_password():
    data = request.json or {}
    username = data.get('username')
    old_pwd = data.get('old_password', '')
    new_pwd = data.get('new_password', '').strip()

    if not new_pwd or len(new_pwd) < 6:
        return jsonify({"code": 400, "msg": "新密码长度至少需要 6 位"})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE username=? AND password_hash=?", (username, hash_pwd(old_pwd)))
    user = c.fetchone()
    if not user:
        conn.close()
        return jsonify({"code": 400, "msg": "原旧密码验证错误"})

    c.execute("UPDATE users SET password_hash=? WHERE username=?", (hash_pwd(new_pwd), username))
    conn.commit()
    conn.close()

    title = "【Xray 安全通知】您的账户密码已成功修改"
    content = f"您好 {username}，您的登录密码于 {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} 已成功变更。"
    notify_user(dict(user), title, f"<p>{content}</p>", content)

    return jsonify({"code": 200, "msg": "密码修改成功，请使用新密码重新登录"})

@app.route('/api/user/notify_settings', methods=['POST'])
def update_notify_settings():
    data = request.json or {}
    username = data.get('username')
    notify_type = data.get('notify_type', 'email')
    serverchan_key = data.get('serverchan_key', '').strip()

    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE users SET notify_type=?, serverchan_key=? WHERE username=?", (notify_type, serverchan_key, username))
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": "通知偏好设置已更新"})

@app.route('/api/user/test_notify', methods=['POST'])
def user_test_notify():
    data = request.json or {}
    username = data.get('username')
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE username=?", (username,))
    user = c.fetchone()
    conn.close()
    if not user:
        return jsonify({"code": 404, "msg": "用户不存在"})

    title = "【通知测试】Xray 节点服务消息连通性验证"
    content = f"恭喜！您在 Xray 节点面板的通知通道验证成功。当前通知通道：{user['notify_type']}。"
    ok, msg = notify_user(dict(user), title, f"<h3>{title}</h3><p>{content}</p>", content)
    if ok:
        return jsonify({"code": 200, "msg": "测试消息发送成功，请前往查收"})
    return jsonify({"code": 500, "msg": msg})

# ==================== 卡密充值 ====================

@app.route('/api/recharge', methods=['POST'])
def recharge():
    data = request.json or {}
    u = data.get('username')
    code = data.get('card_code', '').strip()
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM cards WHERE code=?", (code,))
    card = c.fetchone()
    if not card or card['is_used']:
        conn.close()
        return jsonify({"code": 400, "msg": "卡密无效或已被使用"})

    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    c.execute("UPDATE cards SET is_used=1, used_by=?, created_at=? WHERE code=?", (u, now, code))
    c.execute("SELECT * FROM users WHERE username=?", (u,))
    user = c.fetchone()
    c_exp = datetime.datetime.strptime(user['expire_date'], "%Y-%m-%d %H:%M:%S")
    n_exp = (max(datetime.datetime.now(), c_exp) + datetime.timedelta(days=card['days'])).strftime("%Y-%m-%d %H:%M:%S")
    c.execute("UPDATE users SET traffic_limit_mb=?, expire_date=? WHERE username=?",
              (user['traffic_limit_mb'] + card['traffic_gb'] * 1024, n_exp, u))
    conn.commit()
    conn.close()

    title = "【充值成功】您的套餐配额已更新"
    text = f"您好 {u}，您已成功兑换卡密！增加流量：{card['traffic_gb']}GB，有效期顺延至：{n_exp}。"
    notify_user(dict(user), title, f"<p>{text}</p>", text)

    return jsonify({"code": 200, "msg": f"充值成功！增加 {card['traffic_gb']}GB 流量，延长 {card['days']} 天"})

# ==================== 管理员全量治理路由 ====================

@app.route('/api/admin/cards/generate', methods=['POST'])
def admin_generate():
    if Config.APP_MODE == 'user': abort(404)
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    conn = get_db()
    c = conn.cursor()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    created = []
    for _ in range(int(data.get('count', 5))):
        code = "KM-" + str(uuid.uuid4()).replace("-", "")[:12].upper()
        c.execute("INSERT INTO cards VALUES (?, ?, ?, 0, NULL, ?)",
                  (code, int(data.get('traffic_gb', 50)), int(data.get('days', 30)), now))
        created.append(code)
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": "制卡成功", "cards": created})

@app.route('/api/admin/cards/export_unused', methods=['POST'])
def export_unused_cards():
    if Config.APP_MODE == 'user': abort(404)
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})

    selected_codes = data.get("selected_codes", [])
    start_date = data.get("start_date", "").strip()
    end_date = data.get("end_date", "").strip()

    conn = get_db()
    c = conn.cursor()

    if selected_codes and len(selected_codes) > 0:
        placeholders = ','.join(['?'] * len(selected_codes))
        sql = f"SELECT code FROM cards WHERE code IN ({placeholders}) ORDER BY rowid DESC"
        c.execute(sql, selected_codes)
    elif start_date or end_date:
        query_parts = ["is_used=0"]
        params = []
        if start_date:
            query_parts.append("substr(created_at, 1, 10) >= ?")
            params.append(start_date)
        if end_date:
            query_parts.append("substr(created_at, 1, 10) <= ?")
            params.append(end_date)
        sql = f"SELECT code FROM cards WHERE {' AND '.join(query_parts)} ORDER BY rowid DESC"
        c.execute(sql, params)
    else:
        c.execute("SELECT code FROM cards WHERE is_used=0 ORDER BY rowid DESC")

    cards = [r["code"] for r in c.fetchall()]
    conn.close()

    return jsonify({
        "code": 200,
        "count": len(cards),
        "text": "\n".join(cards)
    })

@app.route('/api/admin/data', methods=['POST'])
def admin_data():
    if Config.APP_MODE == 'user': abort(404)
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    params = get_xray_reality_params()
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT code, traffic_gb, days, is_used, used_by, created_at FROM cards ORDER BY rowid DESC LIMIT 200")
    cards = [dict(r) for r in c.fetchall()]

    c.execute("SELECT username, email, traffic_limit_mb, expire_date, role, uuid, status, notify_type FROM users")
    users = []
    for r in c.fetchall():
        d = dict(r)
        d['used_mb'] = query_user_traffic(d['username'])
        d['status'] = 1 if d.get('status') is None else d['status']
        # 为每一个用户自动拼装当前节点最新的真实 Reality 连接 (包含自定义域名与真实公钥)
        d['sub_link'] = build_vless_link(d['uuid'], params['pbk'], f"{d['username']}-Reality")
        users.append(d)
    conn.close()
    return jsonify({"code": 200, "cards": cards, "users": users})

@app.route('/api/admin/users/reset_password', methods=['POST'])
def admin_reset_password():
    if Config.APP_MODE == 'user': abort(404)
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    target_user = data.get('target_user')
    new_pwd = data.get('new_password', '').strip()
    if not new_pwd:
        return jsonify({"code": 400, "msg": "新密码不能为空"})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE username=?", (target_user,))
    user = c.fetchone()
    if not user:
        conn.close()
        return jsonify({"code": 404, "msg": "用户不存在"})

    c.execute("UPDATE users SET password_hash=? WHERE username=?", (hash_pwd(new_pwd), target_user))
    conn.commit()
    conn.close()

    title = "【系统提醒】管理员已重置您的登录密码"
    text = f"您好 {target_user}，管理员已为您重置新密码。新密码为：{new_pwd} ，请登录后及时修改。"
    notify_user(dict(user), title, f"<p>{text}</p>", text)

    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 密码已成功重置！"})

@app.route('/api/admin/users/status', methods=['POST'])
def update_user_status():
    if Config.APP_MODE == 'user': abort(404)
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    target_user = data.get('target_user')
    status = int(data.get('status', 1))
    if target_user == data.get('admin_user'):
        return jsonify({"code": 400, "msg": "不能封禁管理员当前登录账号！"})

    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE users SET status=? WHERE username=?", (status, target_user))
    conn.commit()
    conn.close()

    # 核心联动：封禁或解封后，立即同步 Xray 允许名单
    sync_users_to_xray()

    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 状态已更新"})

@app.route('/api/admin/users/edit', methods=['POST'])
def edit_user_quota():
    if Config.APP_MODE == 'user': abort(404)
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    target_user = data.get('target_user')
    limit_mb = int(data.get('limit_mb', 1024))
    expire_date = data.get('expire_date', '').strip()

    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE users SET traffic_limit_mb=?, expire_date=? WHERE username=?", (limit_mb, expire_date, target_user))
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 属性已更新"})

@app.route('/api/admin/users/delete', methods=['POST'])
def delete_user():
    if Config.APP_MODE == 'user': abort(404)
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    target_user = data.get('target_user')
    if target_user == data.get('admin_user'):
        return jsonify({"code": 400, "msg": "不能删除当前登录的管理员自己！"})

    conn = get_db()
    c = conn.cursor()
    c.execute("DELETE FROM users WHERE username=?", (target_user,))
    conn.commit()
    conn.close()

    # 核心联动：删除用户后，立刻从 Xray clients 中剔除
    sync_users_to_xray()

    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 已被彻底删除"})

# ==================== 管理员 SMTP 与系统参数设置 (含自定义域名/IP) ====================

@app.route('/api/admin/settings', methods=['GET', 'POST'])
def handle_settings():
    if Config.APP_MODE == 'user': abort(404)
    if request.method == 'GET':
        admin_user = request.args.get('admin_user')
        admin_pwd = request.args.get('admin_pwd')
        if not check_admin(admin_user, admin_pwd): return jsonify({"code": 403, "msg": "无权限"})
        return jsonify({
            "code": 200,
            "data": {
                "smtp_host": get_setting("smtp_host", ""),
                "smtp_port": get_setting("smtp_port", "465"),
                "smtp_user": get_setting("smtp_user", ""),
                "smtp_pass": get_setting("smtp_pass", ""),
                "smtp_sender": get_setting("smtp_sender", "Xray 节点运营中心"),
                "smtp_ssl": get_setting("smtp_ssl", "true"),
                "task_notify_enable": get_setting("task_notify_enable", "true"),
                "task_interval_hours": get_setting("task_interval_hours", "12"),
                "task_traffic_threshold": get_setting("task_traffic_threshold", "80"),
                "task_expire_days": get_setting("task_expire_days", "3"),
                "task_last_run": get_setting("task_last_run", "尚未执行"),
                "faka_api_enable": get_setting("faka_api_enable", "true"),
                "faka_api_token": get_setting("faka_api_token", Config.FAKA_API_TOKEN),
                # 核心新增：客户端自定义连接地址 (域名或 IP)
                "custom_host": get_setting("custom_host", "")
            }
        })
    else:
        data = request.json or {}
        if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
        keys = ["smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_sender", "smtp_ssl",
                "task_notify_enable", "task_interval_hours", "task_traffic_threshold", "task_expire_days",
                "faka_api_enable", "faka_api_token", "custom_host"]
        for k in keys:
            if k in data:
                set_setting(k, str(data[k]).strip())
        return jsonify({"code": 200, "msg": "配置已成功保存"})

@app.route('/api/admin/test_email', methods=['POST'])
def test_email():
    if Config.APP_MODE == 'user': abort(404)
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    to = data.get('test_to', '').strip()
    if not to: return jsonify({"code": 400, "msg": "接收邮箱不能为空"})

    ok, msg = send_smtp_email(to, "【测试邮件】Xray 邮件服务器通信正常", "<p>恭喜！您的 SMTP 发信服务器配置正确，邮件发送功能已正常启用。</p>")
    if ok:
        return jsonify({"code": 200, "msg": "测试邮件已成功投递！"})
    return jsonify({"code": 500, "msg": msg})

@app.route('/api/admin/tasks/trigger', methods=['POST'])
def trigger_task_now():
    if Config.APP_MODE == 'user': abort(404)
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    t_sent, e_sent, desc = run_scheduled_check(force=True)
    return jsonify({
        "code": 200,
        "msg": desc,
        "data": {"traffic_sent": t_sent, "expire_sent": e_sent}
    })

def check_admin(u, p):
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT role FROM users WHERE username=? AND password_hash=?", (u, hash_pwd(p or '')))
    r = c.fetchone()
    conn.close()
    return r and r['role'] == 'admin'

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=Config.WEB_PORT)