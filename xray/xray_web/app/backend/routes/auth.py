import uuid
import random
import datetime
from flask import Blueprint, request, jsonify
from config import Config
from core.db import get_db, hash_pwd, get_setting
from core.captcha import generate_math_captcha, verify_captcha
from services.notify_service import send_smtp_email
from routes import get_node_snis, build_node_link, normalize_expire_date, is_user_allowed_for_node

auth_bp = Blueprint('auth_bp', __name__)

@auth_bp.route('/api/auth/captcha', methods=['GET'])
def get_captcha():
    data = generate_math_captcha()
    return jsonify({"code": 200, "data": data})

@auth_bp.route('/api/login', methods=['POST'])
def login():
    data = request.json or {}
    account = data.get('username', '').strip()
    p = data.get('password', '').strip()
    captcha_id = data.get('captcha_id', '').strip()
    captcha_ans = data.get('captcha_ans', '').strip()

    ok, c_msg = verify_captcha(captcha_id, captcha_ans)
    if not ok:
        return jsonify({"code": 400, "msg": c_msg})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE (username=? OR email=?) AND password_hash=?", (account, account, hash_pwd(p)))
    user = c.fetchone()

    if not user:
        conn.close()
        return jsonify({"code": 401, "msg": "账号或密码错误"})

    if user['status'] == 0:
        conn.close()
        return jsonify({"code": 403, "msg": "该账号已被管理员封禁停用"})

    if user['is_verified'] == 0:
        conn.close()
        return jsonify({"code": 403, "msg": "账号尚未通过邮箱激活验证"})

    if Config.APP_MODE == 'user' and user['role'] == 'admin':
        conn.close()
        return jsonify({"code": 403, "msg": "当前节点为纯用户端模式，已屏蔽管理员登录"})

    user_dict = dict(user)

    # 核心：根据节点启用状态及权限矩阵过滤
    c.execute("SELECT * FROM nodes ORDER BY id ASC")
    all_nodes = [dict(n) for n in c.fetchall()]
    conn.close()

    visible_nodes = [n for n in all_nodes if is_user_allowed_for_node(user_dict, n)]

    nodes_data = []
    host_prefix = request.host_url.rstrip('/')
    sub_url = f"{host_prefix}/api/sub?token={user_dict['uuid']}"

    for n in visible_nodes:
        if len(n.get("pbk", "")) == 43:
            snis = get_node_snis(n)
            random_sni = random.choice(snis)
            link = build_node_link(user_dict['uuid'], n, f"{n['name']}", chosen_sni=random_sni)
            nodes_data.append({
                "id": n["id"],
                "name": n["name"],
                "ip": n["ip"],
                "port": n["port"],
                "pbk": n["pbk"],
                "sid": n["sid"],
                "server_names": snis,
                "selected_sni": random_sni,
                "link": link
            })

    return jsonify({
        "code": 200,
        "data": {
            "username": user_dict['username'],
            "email": user_dict['email'],
            "role": user_dict['role'],
            "uuid": user_dict['uuid'],
            "used_mb": round(user_dict.get('used_mb', 0), 2),
            "limit_mb": user_dict['traffic_limit_mb'],
            "expire_date": user_dict['expire_date'],
            "is_monthly": user_dict['is_monthly'] or 0,
            "reset_day": user_dict['reset_day'] or 1,
            "user_group": user_dict.get('user_group', 'default'),
            "sub_url": sub_url,
            "nodes": nodes_data,
            "notify_type": user_dict['notify_type'] or 'email',
            "serverchan_key": user_dict['serverchan_key'] or ''
        }
    })

@auth_bp.route('/api/auth/send_register_code', methods=['POST'])
def send_register_code():
    data = request.json or {}
    email = data.get('email', '').strip().lower()
    captcha_id = data.get('captcha_id', '').strip()
    captcha_ans = data.get('captcha_ans', '').strip()

    ok, c_msg = verify_captcha(captcha_id, captcha_ans)
    if not ok: return jsonify({"code": 400, "msg": c_msg})
    if not email or '@' not in email: return jsonify({"code": 400, "msg": "请输入合法的电子邮箱"})

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
        <p>您好！您的激活验证码为：<b style="font-size: 24px; color: #10b981; letter-spacing: 2px;">{code}</b></p>
        <p style="color: #94a3b8; font-size: 12px;">验证码 10 分钟内有效。</p>
    </div>
    """
    ok, msg = send_smtp_email(email, "【Xray】注册账号激活验证码", content)
    if not ok: return jsonify({"code": 500, "msg": msg})
    return jsonify({"code": 200, "msg": "激活验证码已发送至您的邮箱，请查收"})

@auth_bp.route('/api/register', methods=['POST'])
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

    reg_traffic_mb = int(get_setting("reg_traffic_mb", "1024") or 1024)
    reg_expire_days = int(get_setting("reg_expire_days", "1") or 1)

    if reg_expire_days >= 3650:
        exp = "2099-12-31 23:59:59"
    else:
        exp_date = (datetime.datetime.now() + datetime.timedelta(days=reg_expire_days)).strftime("%Y-%m-%d")
        exp = normalize_expire_date(exp_date)

    try:
        c.execute("""
            INSERT INTO users (username, password_hash, uuid, email, traffic_limit_mb, used_mb, expire_date, role, status, is_verified, is_monthly, reset_day, user_group) 
            VALUES (?, ?, ?, ?, ?, 0, ?, 'user', 1, 1, 0, 1, 'default')
        """, (u, hash_pwd(p), str(uuid.uuid4()), email, reg_traffic_mb, exp))
        c.execute("DELETE FROM verify_codes WHERE email=?", (email,))
        conn.commit()
        conn.close()
        return jsonify({"code": 200, "msg": f"账号激活成功，获赠 {reg_traffic_mb}MB 套餐"})
    except Exception as e:
        conn.close()
        return jsonify({"code": 500, "msg": f"注册失败: {str(e)}"})

@auth_bp.route('/api/auth/send_reset_code', methods=['POST'])
def send_reset_code():
    data = request.json or {}
    email = data.get('email', '').strip().lower()
    captcha_id = data.get('captcha_id', '').strip()
    captcha_ans = data.get('captcha_ans', '').strip()

    ok, c_msg = verify_captcha(captcha_id, captcha_ans)
    if not ok: return jsonify({"code": 400, "msg": c_msg})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT id, username FROM users WHERE email=?", (email,))
    user = c.fetchone()
    if not user:
        conn.close()
        return jsonify({"code": 404, "msg": "该邮箱尚未绑定任何账号"})

    code = f"{random.randint(100000, 999999)}"
    c.execute("INSERT INTO verify_codes (email, code) VALUES (?, ?)", (email, code))
    conn.commit()
    conn.close()

    content = f"""
    <div style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 25px; border-radius: 8px;">
        <h2 style="color: #38bdf8;">🔐 Xray Reality 密码重置验证</h2>
        <p>您好 <b>{user['username']}</b>！您的重置验证码为：<b style="font-size: 24px; color: #f59e0b; letter-spacing: 2px;">{code}</b></p>
    </div>
    """
    ok, msg = send_smtp_email(email, "【Xray】找回登录密码验证码", content)
    if not ok: return jsonify({"code": 500, "msg": msg})
    return jsonify({"code": 200, "msg": "验证码已发送至您的邮箱"})

@auth_bp.route('/api/auth/reset_password', methods=['POST'])
def reset_password():
    data = request.json or {}
    email = data.get('email', '').strip().lower()
    code = data.get('code', '').strip()
    new_pwd = data.get('new_password', '').strip()

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT code FROM verify_codes WHERE email=? ORDER BY id DESC LIMIT 1", (email,))
    row = c.fetchone()
    if not row or row["code"] != code:
        conn.close()
        return jsonify({"code": 400, "msg": "验证码错误或已失效"})

    c.execute("UPDATE users SET password_hash=? WHERE email=?", (hash_pwd(new_pwd), email))
    c.execute("DELETE FROM verify_codes WHERE email=?", (email,))
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": "密码已成功重置，请登录"})