import uuid
import datetime
from flask import Flask, request, jsonify, send_from_directory, abort
from config import Config
from db import init_db, get_db, hash_pwd
from xray import get_cached_public_key, query_user_traffic, build_vless_link

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
            "public_key": get_cached_public_key()
        }
    })

# 用户端接口
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
        c.execute("INSERT INTO users VALUES (NULL, ?, ?, ?, ?, 1024, ?, 'user')",
                  (u, hash_pwd(p), str(uuid.uuid4()), u, exp))
        conn.commit()
        conn.close()
        return jsonify({"code": 200, "msg": "注册成功，已开通 1GB 体验套餐"})
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

    if Config.APP_MODE == 'user' and user['role'] == 'admin':
        return jsonify({"code": 403, "msg": "本节点为纯用户端，已关闭管理员登录"})

    used_mb = query_user_traffic(user['email'])
    pbk = get_cached_public_key()
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

# 管理员接口（APP_MODE 为 user 时熔断返回 404）
@app.route('/api/admin/cards/generate', methods=['POST'])
def admin_generate():
    if Config.APP_MODE == 'user':
        abort(404)
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})

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
    if Config.APP_MODE == 'user':
        abort(404)
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM cards ORDER BY rowid DESC LIMIT 50")
    cards = [dict(r) for r in c.fetchall()]
    c.execute("SELECT username, traffic_limit_mb, expire_date, role FROM users")
    users = []
    for r in c.fetchall():
        d = dict(r)
        d['used_mb'] = query_user_traffic(d['username'])
        users.append(d)
    conn.close()
    return jsonify({"code": 200, "cards": cards, "users": users})

def check_admin(u, p):
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT role FROM users WHERE username=? AND password_hash=?", (u, hash_pwd(p or '')))
    r = c.fetchone()
    conn.close()
    return r and r['role'] == 'admin'

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=Config.PORT)