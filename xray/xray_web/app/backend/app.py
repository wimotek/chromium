import os
import io
import uuid
import random
import datetime
import qrcode
import qrcode.image.svg
from flask import Flask, request, jsonify, send_from_directory, abort, send_file
from config import Config
from db import init_db, get_db, hash_pwd, get_setting, set_setting
from xray import get_reality_public_key, query_user_traffic, build_vless_link
from notify import send_smtp_email, send_serverchan_msg, notify_user

app = Flask(__name__, static_folder='../frontend/dist', static_url_path='/')
init_db()

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

# ==================== 用户认证与安全 ====================

# 1. 注册获取邮箱验证码
@app.route('/api/auth/send_register_code', methods=['POST'])
def send_register_code():
    data = request.json or {}
    email = data.get('email', '').strip().lower()
    if not email or '@' not in email:
        return jsonify({"code": 400, "msg": "请输入合法的邮箱地址"})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT id FROM users WHERE email=?", (email,))
    if c.fetchone():
        conn.close()
        return jsonify({"code": 400, "msg": "该邮箱已被注册"})

    # 生成 6 位随机数字验证码
    code = f"{random.randint(100000, 999999)}"
    c.execute("INSERT INTO verify_codes (email, code) VALUES (?, ?)", (email, code))
    conn.commit()
    conn.close()

    # 发送验证邮件
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

    return jsonify({"code": 200, "msg": "验证码已成功发送至您的邮箱，请查收"})

# 2. 注册账号 (校验验证码)
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
    # 校验验证码 (匹配最新一条且 10 分钟内有效)
    c.execute("SELECT code, created_at FROM verify_codes WHERE email=? ORDER BY id DESC LIMIT 1", (email,))
    row = c.fetchone()
    if not row or row["code"] != code:
        conn.close()
        return jsonify({"code": 400, "msg": "验证码错误或已失效"})

    # 查重
    c.execute("SELECT id FROM users WHERE username=? OR email=?", (u, email))
    if c.fetchone():
        conn.close()
        return jsonify({"code": 400, "msg": "用户名或邮箱已被占用"})

    exp = (datetime.datetime.now() + datetime.timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
    try:
        c.execute("INSERT INTO users (username, password_hash, uuid, email, traffic_limit_mb, expire_date, role, status, is_verified) VALUES (?, ?, ?, ?, 1024, ?, 'user', 1, 1)",
                  (u, hash_pwd(p), str(uuid.uuid4()), email, exp))
        # 激活后清空该邮箱的历史验证码
        c.execute("DELETE FROM verify_codes WHERE email=?", (email,))
        conn.commit()
        conn.close()
        return jsonify({"code": 200, "msg": "账号已成功激活注册，已获赠 1GB 体验套餐"})
    except Exception as e:
        conn.close()
        return jsonify({"code": 500, "msg": f"数据库写入失败: {str(e)}"})

# 3. 登录 (支持用户名 或 邮箱)
@app.route('/api/login', methods=['POST'])
def login():
    data = request.json or {}
    account = data.get('username', '').strip()
    p = data.get('password', '').strip()

    conn = get_db()
    c = conn.cursor()
    # 核心：支持用户名 OR 邮箱登录
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
    pbk = get_reality_public_key()
    link = build_vless_link(user['uuid'], pbk, f"{user['username']}-Reality")

    return jsonify({
        "code": 200,
        "data": {
            "username": user['username'],
            "email": user['email'],
            "role": user['role'],
            "used_mb": used_mb,
            "limit_mb": user['traffic_limit_mb'],
            "expire_date": user['expire_date'],
            "public_key": pbk,
            "sub_link": link,
            "notify_type": user['notify_type'] or 'email',
            "serverchan_key": user['serverchan_key'] or ''
        }
    })

# 4. 用户自主修改密码
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

    # 触发安全通知
    title = "【Xray 安全通知】您的账户密码已成功修改"
    content = f"您好 {username}，您的登录密码于 {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} 已成功变更。如非本人操作请立即联系管理人员。"
    notify_user(dict(user), title, f"<p>{content}</p>", content)

    return jsonify({"code": 200, "msg": "密码修改成功，请使用新密码重新登录"})

# 5. 用户更新通知偏好 (Server酱 / 邮件)
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

# 6. 用户端发送测试通知
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
    content = f"恭喜！您在 Xray 节点面板的通知通道验证成功。当前通知方式：{user['notify_type']}。"
    ok, msg = notify_user(dict(user), title, f"<h3>{title}</h3><p>{content}</p>", content)
    if ok:
        return jsonify({"code": 200, "msg": "测试消息发送成功，请前往检查"})
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

    # 充值成功发送通知
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
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    created = []
    for _ in range(int(data.get('count', 5))):
        code = "KM-" + str(uuid.uuid4()).replace("-", "")[:12].upper()
        c.execute("INSERT INTO cards VALUES (?, ?, ?, 0, NULL, ?)",
                  (code, int(data.get('traffic_gb', 50)), int(data.get('days', 30)), now))
        created.append(code)
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": "制卡成功", "cards": created})

@app.route('/api/admin/data', methods=['POST'])
def admin_data():
    if Config.APP_MODE == 'user': abort(404)
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    pbk = get_reality_public_key()
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM cards ORDER BY rowid DESC LIMIT 100")
    cards = [dict(r) for r in c.fetchall()]

    c.execute("SELECT username, email, traffic_limit_mb, expire_date, role, uuid, status, notify_type FROM users")
    users = []
    for r in c.fetchall():
        d = dict(r)
        d['used_mb'] = query_user_traffic(d['username'])
        d['status'] = 1 if d.get('status') is None else d['status']
        d['sub_link'] = build_vless_link(d['uuid'], pbk, f"{d['username']}-Reality")
        users.append(d)
    conn.close()
    return jsonify({"code": 200, "cards": cards, "users": users})

# 管理员重置指定用户密码
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

    # 向用户推送重置提醒
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
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 已被彻底删除"})

@app.route('/api/admin/users/role', methods=['POST'])
def update_user_role():
    if Config.APP_MODE == 'user': abort(404)
    data = request.json or {}
    admin_user = data.get('admin_user')
    if not check_admin(admin_user, data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    target_user = data.get('target_user')
    new_role = data.get('role', 'admin')
    if target_user == admin_user and new_role == 'user':
        return jsonify({"code": 400, "msg": "安全保护：不能降权当前登录的管理员自己！"})

    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE users SET role=? WHERE username=?", (new_role, target_user))
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 角色已更新为 {new_role}"})

# ==================== 管理员系统与 SMTP 发信设置 ====================

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
                "smtp_ssl": get_setting("smtp_ssl", "true")
            }
        })
    else:
        data = request.json or {}
        if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
        for k in ["smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_sender", "smtp_ssl"]:
            if k in data:
                set_setting(k, str(data[k]).strip())
        return jsonify({"code": 200, "msg": "发信服务器参数已保存"})

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

def check_admin(u, p):
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT role FROM users WHERE username=? AND password_hash=?", (u, hash_pwd(p or '')))
    r = c.fetchone()
    conn.close()
    return r and r['role'] == 'admin'

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=Config.WEB_PORT)