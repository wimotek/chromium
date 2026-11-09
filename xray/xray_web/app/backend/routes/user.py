import os
import uuid
import random
import datetime
from flask import Blueprint, request, jsonify, send_file, abort
from core.db import get_db, hash_pwd
from services.notify_service import send_smtp_email, notify_user
from services.client_pack_service import generate_windows_package, ensure_base_v2rayng_apk
from routes import get_node_snis, build_node_link, normalize_expire_date, is_user_allowed_for_node

user_bp = Blueprint('user_bp', __name__)

@user_bp.route('/api/user/refresh_info', methods=['POST'])
def user_refresh_info():
    data = request.json or {}
    username = data.get('username')
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE username=? OR email=?", (username, username))
    user = c.fetchone()
    if not user:
        conn.close()
        return jsonify({"code": 404, "msg": "用户不存在"})

    user_dict = dict(user)

    # 查出所有节点，仅保留未禁用且用户有权访问的节点
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
            hub_domain = request.host
            link = build_node_link(user_dict['uuid'], n, f"{n['name']}", chosen_sni=random_sni, hub_domain=hub_domain)
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

@user_bp.route('/api/user/reset_uuid', methods=['POST'])
def user_reset_uuid():
    data = request.json or {}
    username = data.get('username')
    if not username:
        return jsonify({"code": 400, "msg": "参数缺失"}), 400

    new_uuid = str(uuid.uuid4())
    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE users SET uuid=? WHERE username=?", (new_uuid, username))
    conn.commit()
    c.execute("SELECT * FROM users WHERE username=?", (username,))
    user = c.fetchone()
    user_dict = dict(user)

    c.execute("SELECT * FROM nodes ORDER BY id ASC")
    all_nodes = [dict(n) for n in c.fetchall()]
    conn.close()

    visible_nodes = [n for n in all_nodes if is_user_allowed_for_node(user_dict, n)]

    host_prefix = request.host_url.rstrip('/')
    sub_url = f"{host_prefix}/api/sub?token={new_uuid}"
    nodes_data = []
    for n in visible_nodes:
        if len(n.get("pbk", "")) == 43:
            snis = get_node_snis(n)
            random_sni = random.choice(snis)
            hub_domain = request.host
            link = build_node_link(new_uuid, n, f"{n['name']}", chosen_sni=random_sni, hub_domain=hub_domain)
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
        "msg": "节点凭证 (UUID) 已重置！旧链接已立即失效，请重新导入订阅。",
        "data": {
            "uuid": new_uuid,
            "sub_url": sub_url,
            "nodes": nodes_data
        }
    })

@user_bp.route('/api/user/send_change_email_code', methods=['POST'])
def send_change_email_code():
    data = request.json or {}
    username = data.get('username', '').strip()
    new_email = data.get('new_email', '').strip().lower()

    if not username or not new_email or '@' not in new_email:
        return jsonify({"code": 400, "msg": "请输入合法有效的新电子邮箱"}), 400

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT id, email FROM users WHERE username=?", (username,))
    user = c.fetchone()
    if not user:
        conn.close()
        return jsonify({"code": 404, "msg": "用户账号不存在"}), 404

    if user['email'] == new_email:
        conn.close()
        return jsonify({"code": 400, "msg": "新邮箱不能与当前绑定的旧邮箱相同"}), 400

    c.execute("SELECT id FROM users WHERE email=? AND username!=?", (new_email, username))
    if c.fetchone():
        conn.close()
        return jsonify({"code": 400, "msg": "该新邮箱已被其他账号绑定使用"}), 400

    code = f"{random.randint(100000, 999999)}"
    c.execute("INSERT INTO verify_codes (email, code) VALUES (?, ?)", (new_email, code))
    conn.commit()
    conn.close()

    content = f"""
    <div style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 25px; border-radius: 8px;">
        <h2 style="color: #38bdf8;">📧 Xray Reality 更换绑定邮箱验证</h2>
        <p>您好 <b>{username}</b>！您正在申请将账号绑定邮箱更换为本邮箱地址。</p>
        <p>您的安全验证码为：<b style="font-size: 24px; color: #10b981; letter-spacing: 2px;">{code}</b></p>
        <p style="color: #94a3b8; font-size: 12px;">验证码 10 分钟内有效。如非本人操作，请立即检查账号安全。</p>
    </div>
    """
    ok, msg = send_smtp_email(new_email, "【Xray】更换绑定邮箱验证码", content)
    if not ok:
        return jsonify({"code": 500, "msg": f"验证码投递失败: {msg}"}), 500

    return jsonify({"code": 200, "msg": "验证码已成功投递至新邮箱，请前往查收"})

@user_bp.route('/api/user/change_email', methods=['POST'])
def user_change_email():
    data = request.json or {}
    username = data.get('username', '').strip()
    new_email = data.get('new_email', '').strip().lower()
    code = data.get('code', '').strip()
    password = data.get('password', '').strip()

    if not username or not new_email or not code or not password:
        return jsonify({"code": 400, "msg": "所有项均为必填项"}), 400

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE (username=? OR email=?) AND password_hash=?", (username, username, hash_pwd(password)))
    user = c.fetchone()
    if not user:
        conn.close()
        return jsonify({"code": 401, "msg": "当前账号登录密码验证失败"}), 401

    c.execute("SELECT code FROM verify_codes WHERE email=? ORDER BY id DESC LIMIT 1", (new_email,))
    row = c.fetchone()
    if not row or row["code"] != code:
        conn.close()
        return jsonify({"code": 400, "msg": "新邮箱验证码错误或已失效"})

    real_username = user['username']
    c.execute("SELECT id FROM users WHERE email=? AND username!=?", (new_email, real_username))
    if c.fetchone():
        conn.close()
        return jsonify({"code": 400, "msg": "该新邮箱已被其他账号占用"}), 400

    c.execute("UPDATE users SET email=? WHERE username=?", (new_email, real_username))
    c.execute("DELETE FROM verify_codes WHERE email=?", (new_email,))
    conn.commit()
    conn.close()

    notice_content = f"您好 {real_username}，您的账号绑定邮箱已成功更换为 {new_email}。"
    notify_user(dict(user), "【安全通知】账号绑定邮箱已成功修改", f"<p>{notice_content}</p>", notice_content)

    return jsonify({"code": 200, "msg": "绑定邮箱修改成功！", "new_email": new_email})

@user_bp.route('/api/user/change_password', methods=['POST'])
def change_password():
    data = request.json or {}
    username = data.get('username')
    old_pwd = data.get('old_password', '')
    new_pwd = data.get('new_password', '').strip()

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
    return jsonify({"code": 200, "msg": "密码修改成功，请重新登录"})

@user_bp.route('/api/user/notify_settings', methods=['POST'])
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

@user_bp.route('/api/user/test_notify', methods=['POST'])
def user_test_notify():
    data = request.json or {}
    username = data.get('username')
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE username=?", (username,))
    user = c.fetchone()
    conn.close()
    if not user: return jsonify({"code": 404, "msg": "用户不存在"})

    title = "【通知测试】Xray 节点服务消息连通性验证"
    content = f"恭喜！您的通知通道验证成功。当前通知通道：{user['notify_type']}。"
    ok, msg = notify_user(dict(user), title, f"<h3>{title}</h3><p>{content}</p>", content)
    if ok: return jsonify({"code": 200, "msg": "测试消息发送成功"})
    return jsonify({"code": 500, "msg": msg})

@user_bp.route('/api/user/download_client', methods=['GET'])
def download_windows_client():
    account = request.args.get('username', '').strip()
    if not account: abort(400)

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE username=? OR email=?", (account, account))
    user = c.fetchone()
    conn.close()

    if not user: abort(404)

    host_prefix = request.host_url.rstrip('/')
    try:
        mem_file = generate_windows_package(dict(user), host_prefix)
        filename = f"v2rayN_WithCore_{user['username']}.zip"
        return send_file(mem_file, as_attachment=True, download_name=filename, mimetype='application/zip')
    except Exception as e:
        return jsonify({"code": 500, "msg": f"客户端构建失败: {str(e)}"}), 500

@user_bp.route('/api/user/download_apk', methods=['GET'])
def download_android_apk():
    try:
        apk_path = ensure_base_v2rayng_apk()
        return send_file(apk_path, as_attachment=True, download_name="v2rayNG_latest.apk", mimetype='application/vnd.android.package-archive')
    except Exception as e:
        return jsonify({"code": 500, "msg": f"安卓包准备失败: {str(e)}"}), 500

@user_bp.route('/api/recharge', methods=['POST'])
def recharge():
    data = request.json or {}
    u = data.get('username')
    raw_card_input = data.get('card_code', '').strip()

    if not raw_card_input:
        return jsonify({"code": 400, "msg": "请输入卡密兑换码"})

    import re
    raw_tokens = re.split(r'[\r\n,;\s]+', raw_card_input)
    codes = list(dict.fromkeys([c.strip().upper() for c in raw_tokens if c.strip()]))

    if not codes:
        return jsonify({"code": 400, "msg": "未识别到有效的卡密格式"})

    if len(codes) > 20:
        return jsonify({"code": 400, "msg": "单次最多支持批量核销 20 张卡密"})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE username=?", (u,))
    user = c.fetchone()
    if not user:
        conn.close()
        return jsonify({"code": 404, "msg": "用户不存在"})

    placeholders = ','.join(['?'] * len(codes))
    c.execute(f"SELECT * FROM cards WHERE code IN ({placeholders})", codes)
    found_cards = [dict(r) for r in c.fetchall()]

    found_map = {fc['code']: fc for fc in found_cards}
    valid_cards, used_cards, invalid_codes = [], [], []

    for code in codes:
        if code not in found_map:
            invalid_codes.append(code)
        elif found_map[code]['is_used'] == 1:
            used_cards.append(code)
        else:
            valid_cards.append(found_map[code])

    if not valid_cards:
        conn.close()
        err_msg = "所提交的卡密全部无效"
        if used_cards:
            err_msg = f"卡密已被使用 (共 {len(used_cards)} 张)"
        return jsonify({"code": 400, "msg": err_msg})

    total_add_gb, total_add_days = 0, 0
    has_unlimited_traffic = False
    has_lifetime_expiry = False
    has_monthly_card = False

    for card in valid_cards:
        if card['traffic_gb'] == 0:
            has_unlimited_traffic = True
        else:
            total_add_gb += card['traffic_gb']

        if card['days'] >= 3650:
            has_lifetime_expiry = True
        else:
            total_add_days += card['days']

        if str(card.get('is_monthly')).lower() in ['1', 'true']:
            has_monthly_card = True

    current_limit = user['traffic_limit_mb']
    new_limit = 0 if (has_unlimited_traffic or current_limit == 0) else (current_limit + total_add_gb * 1024)

    c_exp_str = user['expire_date']
    if has_lifetime_expiry or c_exp_str.startswith("2099"):
        n_exp = "2099-12-31 23:59:59"
    else:
        try:
            c_exp = datetime.datetime.strptime(c_exp_str, "%Y-%m-%d %H:%M:%S")
        except Exception:
            c_exp = datetime.datetime.now()
        base_time = max(datetime.datetime.now(), c_exp)
        calculated_date = (base_time + datetime.timedelta(days=total_add_days)).strftime("%Y-%m-%d")
        n_exp = normalize_expire_date(calculated_date)

    new_is_monthly = user['is_monthly'] or 0
    new_reset_day = user['reset_day'] or 1
    if has_monthly_card:
        new_is_monthly = 1
        new_reset_day = datetime.date.today().day

    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    valid_codes_list = [vc['code'] for vc in valid_cards]
    v_placeholders = ','.join(['?'] * len(valid_codes_list))
    
    c.execute(f"UPDATE cards SET is_used=1, used_by=?, used_at=? WHERE code IN ({v_placeholders})",
              [u, now_str] + valid_codes_list)

    c.execute("""
        UPDATE users 
        SET traffic_limit_mb=?, expire_date=?, is_monthly=?, reset_day=? 
        WHERE username=?
    """, (new_limit, n_exp, new_is_monthly, new_reset_day, u))

    conn.commit()
    conn.close()

    res_msg = f"成功核销 {len(valid_cards)} 张卡密！"
    res_msg += " 流量已设为不限制；" if (has_unlimited_traffic or new_limit == 0) else f" 累计增加 {total_add_gb}GB 流量；"
    res_msg += " 有效期已设为永久有效。" if (has_lifetime_expiry or n_exp.startswith("2099")) else f" 有效期顺延至 {n_exp}。"

    if used_cards or invalid_codes:
        res_msg += f" (跳过了 {len(used_cards) + len(invalid_codes)} 张已被使用或无效的卡密)"

    title = "【充值成功】您的套餐配额已更新"
    notify_user(dict(user), title, f"<p>{res_msg}</p>", res_msg)

    return jsonify({
        "code": 200,
        "msg": res_msg,
        "valid_count": len(valid_cards),
        "skipped_count": len(used_cards) + len(invalid_codes)
    })