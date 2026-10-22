import os
import io
import uuid
import datetime
import qrcode
import qrcode.image.svg
from flask import Flask, request, jsonify, send_from_directory, abort, send_file
from config import Config
from db import init_db, get_db, hash_pwd
from xray import get_reality_public_key, query_user_traffic, build_vless_link

app = Flask(__name__, static_folder='../frontend/dist', static_url_path='/')

# 启动初始化并对现有数据库做 status 字段热兼容
init_db()
def patch_db():
    conn = get_db()
    c = conn.cursor()
    try:
        c.execute("ALTER TABLE users ADD COLUMN status INTEGER DEFAULT 1")
        conn.commit()
    except Exception:
        pass
    conn.close()
patch_db()

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

# ==================== 核心新增：纯 Python 矢量二维码生成接口 ====================

@app.route('/api/qrcode', methods=['GET'])
def get_qrcode_svg():
    """
    纯 Python 内存生成超高清 SVG 矢量二维码接口
    零 C 库依赖，零 Pillow 依赖，杜绝前端任何打包报错
    """
    text = request.args.get('text', '').strip()
    if not text:
        abort(400)
    
    # 使用纯 Python 的 SVG Path 工厂生成矢量图
    img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    buf.seek(0)
    return send_file(buf, mimetype='image/svg+xml')

# ==================== 用户端路由 (User APIs) ====================

@app.route('/api/register', methods=['POST'])
def register():
    if Config.APP_MODE == 'admin':
        return jsonify({"code": 403, "msg": "当前节点为纯后台模式，不开放注册"})

    data = request.json or {}
    u = data.get('username', '').strip()
    p = data.get('password', '').strip()
    if not u or not p:
        return jsonify({"code": 400, "msg": "账号或密码不能为空"})

    exp = (datetime.datetime.now() + datetime.timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("INSERT INTO users (username, password_hash, uuid, email, traffic_limit_mb, expire_date, role, status) VALUES (?, ?, ?, ?, 1024, ?, 'user', 1)",
                  (u, hash_pwd(p), str(uuid.uuid4()), u, exp))
        conn.commit()
        conn.close()
        return jsonify({"code": 200, "msg": "注册成功，已获赠 1GB 体验套餐"})
    except Exception:
        return jsonify({"code": 400, "msg": "用户名已存在"})

@app.route('/api/login', methods=['POST'])
def login():
    data = request.json or {}
    u = data.get('username', '').strip()
    p = data.get('password', '').strip()
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE username=? AND password_hash=?", (u, hash_pwd(p)))
    user = c.fetchone()
    conn.close()

    if not user:
        return jsonify({"code": 401, "msg": "账号或密码错误"})

    # 用户账号封禁状态拦截
    if user['status'] == 0:
        return jsonify({"code": 403, "msg": "该账号已被管理员封禁停用，无法登录！"})

    # APP_MODE 为 user 时物理拦截管理员登录（防公网扫描爆破）
    if Config.APP_MODE == 'user' and user['role'] == 'admin':
        return jsonify({"code": 403, "msg": "本节点为纯用户端，已关闭管理员登录"})

    used_mb = query_user_traffic(user['email'])
    pbk = get_reality_public_key()
    link = build_vless_link(user['uuid'], pbk, f"{user['username']}-Reality")

    return jsonify({
        "code": 200,
        "data": {
            "username": user['username'],
            "role": user['role'],
            "used_mb": used_mb,
            "limit_mb": user['traffic_limit_mb'],
            "expire_date": user['expire_date'],
            "public_key": pbk,
            "sub_link": link
        }
    })

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
        return jsonify({"code": 400, "msg": "卡密无效或已使用"})

    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    c.execute("UPDATE cards SET is_used=1, used_by=?, created_at=? WHERE code=?", (u, now, code))
    c.execute("SELECT expire_date, traffic_limit_mb FROM users WHERE username=?", (u,))
    user = c.fetchone()
    c_exp = datetime.datetime.strptime(user['expire_date'], "%Y-%m-%d %H:%M:%S")
    n_exp = (max(datetime.datetime.now(), c_exp) + datetime.timedelta(days=card['days'])).strftime("%Y-%m-%d %H:%M:%S")
    c.execute("UPDATE users SET traffic_limit_mb=?, expire_date=? WHERE username=?",
              (user['traffic_limit_mb'] + card['traffic_gb'] * 1024, n_exp, u))
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": f"充值成功！增加 {card['traffic_gb']}GB 流量，延长 {card['days']} 天"})

# ==================== 管理员全量治理路由 (Admin APIs) ====================

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

    c.execute("SELECT username, traffic_limit_mb, expire_date, role, uuid, status FROM users")
    users = []
    for r in c.fetchall():
        d = dict(r)
        d['used_mb'] = query_user_traffic(d['username'])
        d['status'] = 1 if d.get('status') is None else d['status']
        # 后端直接为每一个用户计算出该用户的专属 VLESS 节点链接
        d['sub_link'] = build_vless_link(d['uuid'], pbk, f"{d['username']}-Reality")
        users.append(d)
    conn.close()
    return jsonify({"code": 200, "cards": cards, "users": users})

# 1. 禁用 / 启用用户
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
    action = "解封启用" if status == 1 else "封禁停用"
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 已成功{action}"})

# 2. 修改用户流量与到期时间
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
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 配额与到期时间修改成功！"})

# 3. 彻底删除用户
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

# 4. 提权 / 降权接口
@app.route('/api/admin/users/role', methods=['POST'])
def update_user_role():
    if Config.APP_MODE == 'user': abort(404)
    data = request.json or {}
    admin_user = data.get('admin_user')
    admin_pwd = data.get('admin_pwd')
    if not check_admin(admin_user, admin_pwd):
        return jsonify({"code": 403, "msg": "无管理员权限"})

    target_user = data.get('target_user')
    new_role = data.get('role', 'admin')
    if target_user == admin_user and new_role == 'user':
        return jsonify({"code": 400, "msg": "安全保护：不能降权当前登录的管理员自己！"})

    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE users SET role=? WHERE username=?", (new_role, target_user))
    conn.commit()
    conn.close()
    action = "提升为管理员" if new_role == 'admin' else "降级为普通用户"
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 已成功{action}"})

def check_admin(u, p):
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT role FROM users WHERE username=? AND password_hash=?", (u, hash_pwd(p or '')))
    r = c.fetchone()
    conn.close()
    return r and r['role'] == 'admin'

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=Config.WEB_PORT)