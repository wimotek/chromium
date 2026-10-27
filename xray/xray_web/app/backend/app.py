import os
import io
import re
import uuid
import base64
import random
import secrets
import datetime
import threading
import time
import qrcode
import qrcode.image.svg
from flask import Flask, request, jsonify, send_from_directory, abort, send_file
from config import Config
from db import init_db, get_db, hash_pwd, get_setting, set_setting
from notify import send_smtp_email, send_serverchan_msg, notify_user
from client_pack import generate_windows_package
from captcha import generate_math_captcha, verify_captcha
from cert_manager import (
    ensure_certificates,
    get_cert_info,
    save_custom_certificate,
    issue_acme_certificate,
    generate_self_signed_cert,
    auto_renew_acme_job,
    CHALLENGE_DIR
)

app = Flask(__name__, static_folder='../frontend/dist', static_url_path='/')
init_db()

# 辅助函数：提取节点配置的所有有效 SNI 域名候选列表 (去端口、去重复)
def get_node_snis(node: dict) -> list[str]:
    raw = node.get("server_names") or node.get("sni") or "www.microsoft.com"
    snis = []
    for part in re.split(r'[,;\s]+', str(raw)):
        clean = part.strip().split(":")[0]
        if clean and clean not in snis:
            snis.append(clean)
    return snis if snis else ["www.microsoft.com"]

# 辅助函数：构建标准的 VLESS REALITY 单连接 (默认从候选列表中随机选 1 个)
def build_node_link(uuid_str: str, node: dict, remark: str, chosen_sni: str = None) -> str:
    snis = get_node_snis(node)
    sni = chosen_sni if (chosen_sni and chosen_sni in snis) else random.choice(snis)
    clean_sni = sni.split(":")[0]
    return (
        f"vless://{uuid_str}@{node['ip']}:{node['port']}"
        f"?security=reality&encryption=none&pbk={node['pbk']}&headerType=none&fp=chrome"
        f"&type=tcp&flow=xtls-rprx-vision&sni={clean_sni}&sid={node['sid']}#{remark}"
    )

@app.route('/.well-known/acme-challenge/<path:filename>')
def acme_challenge_token(filename):
    return send_from_directory(CHALLENGE_DIR, filename)

@app.route('/api/auth/captcha', methods=['GET'])
def get_captcha():
    data = generate_math_captcha()
    return jsonify({"code": 200, "data": data})

# ==================== 定时巡检、每月重置与自动续签 ====================

def run_scheduled_check(force=False) -> tuple[int, int, str]:
    enable = get_setting("task_notify_enable", "true").lower() == "true"
    if not enable and not force:
        return 0, 0, "定时任务未开启"

    traffic_threshold = int(get_setting("task_traffic_threshold", "80") or 80)
    expire_threshold_days = int(get_setting("task_expire_days", "3") or 3)
    today = datetime.date.today()
    today_str = today.strftime("%Y-%m-%d")
    current_day = today.day

    traffic_sent, expire_sent = 0, 0
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE status=1 AND is_verified=1 AND role='user'")
    users = [dict(u) for u in c.fetchall()]

    for u in users:
        uname = u["username"]

        if u.get("is_monthly") == 1:
            reset_day = u.get("reset_day", 1) or 1
            if current_day == reset_day or force:
                c.execute("SELECT id FROM notify_logs WHERE username=? AND warn_type='monthly_reset' AND sent_date=?", (uname, today_str))
                if not c.fetchone() or force:
                    c.execute("UPDATE users SET used_mb=0 WHERE username=?", (uname,))
                    c.execute("INSERT INTO notify_logs (username, warn_type, sent_date) VALUES (?, 'monthly_reset', ?)", (uname, today_str))
                    conn.commit()
                    title = "【流量已重置】您的每月固定流量套餐已刷新"
                    content = f"您好 {uname}，今天是您的每月固定套餐重置日（每月 {reset_day} 号），已用流量已恢复满格！"
                    notify_user(u, title, f"<h3>{title}</h3><p>{content}</p>", content)

        used_mb = u.get("used_mb", 0)
        limit_mb = u.get("traffic_limit_mb", 1024)

        if limit_mb > 0:
            used_percent = round((used_mb / limit_mb) * 100, 1)
            if used_percent >= traffic_threshold:
                c.execute("SELECT id FROM notify_logs WHERE username=? AND warn_type='traffic' AND sent_date=?", (uname, today_str))
                if not c.fetchone() or force:
                    title = "【流量预警】您的节点可用流量已不足"
                    content = f"您好 {uname}，当前已用流量已达 {used_mb}MB / {limit_mb}MB ({used_percent}%)。请及时充值续费。"
                    ok, _ = notify_user(u, title, f"<h3>{title}</h3><p>{content}</p>", content)
                    if ok:
                        traffic_sent += 1
                        c.execute("INSERT INTO notify_logs (username, warn_type, sent_date) VALUES (?, 'traffic', ?)", (uname, today_str))
                        conn.commit()

        exp_str = u.get("expire_date", "").strip()
        if exp_str and not exp_str.startswith("2099"):
            try:
                exp_date = datetime.datetime.strptime(exp_str[:10], "%Y-%m-%d").date()
                days_left = (exp_date - today).days
                if 0 <= days_left <= expire_threshold_days:
                    c.execute("SELECT id FROM notify_logs WHERE username=? AND warn_type='expire' AND sent_date=?", (uname, today_str))
                    if not c.fetchone() or force:
                        title = "【到期提醒】您的节点套餐即将到期"
                        content = f"您好 {uname}，您的节点服务套餐将于 {exp_str} 到期 (仅剩 {days_left} 天)。到期后服务将自动暂停。"
                        ok, _ = notify_user(u, title, f"<h3>{title}</h3><p>{content}</p>", content)
                        if ok:
                            expire_sent += 1
                            c.execute("INSERT INTO notify_logs (username, warn_type, sent_date) VALUES (?, 'expire', ?)", (uname, today_str))
                            conn.commit()
            except Exception:
                pass

    conn.close()
    set_setting("task_last_run", datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    return traffic_sent, expire_sent, f"检测完毕，已推送 {traffic_sent} 条流量预警，{expire_sent} 条到期预警"

def scheduled_worker_loop():
    time.sleep(15)
    while True:
        try:
            interval_hours = int(get_setting("task_interval_hours", "12") or 12)
            run_scheduled_check(force=False)
            auto_renew_acme_job()
        except Exception as e:
            print(f"[Worker Error] {e}", flush=True)

        time.sleep(max(3600, interval_hours * 3600))

threading.Thread(target=scheduled_worker_loop, daemon=True).start()

# ==================== 前台聚合订阅 (精简回归：1物理节点=1条连接，默认随机选择) ====================

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/api/system/info', methods=['GET'])
def system_info():
    return jsonify({
        "code": 200,
        "data": {
            "mode": Config.APP_MODE,
            "system_notice": get_setting("system_notice", "")
        }
    })

@app.route('/api/qrcode', methods=['GET'])
def get_qrcode_svg():
    text = request.args.get('text', '').strip()
    if not text: abort(400)
    img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    buf.seek(0)
    return send_file(buf, mimetype='image/svg+xml')

# 核心优化：每个物理节点严格输出 1 条精炼链接，默认从列表中随机选 1 个域名（亦支持 ?sni= 选定）
@app.route('/api/sub', methods=['GET'])
def get_subscription():
    token = request.args.get('token', '').strip()
    forced_sni = request.args.get('sni', '').strip() or None
    if not token: abort(400)

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE uuid=? AND status=1", (token,))
    user = c.fetchone()
    if not user:
        conn.close()
        abort(403)

    c.execute("SELECT * FROM nodes WHERE status=1 ORDER BY id ASC")
    nodes = [dict(n) for n in c.fetchall()]
    conn.close()

    links = []
    for n in nodes:
        if len(n.get("pbk", "")) == 43:
            snis = get_node_snis(n)
            # 关键优化：1个节点只生成1条精炼线路，默认随机从列表挑选；若指定则优先使用指定的域名
            chosen_sni = forced_sni if (forced_sni and forced_sni in snis) else random.choice(snis)
            remark = f"{n['name']}"
            links.append(build_node_link(user['uuid'], n, remark, chosen_sni=chosen_sni))

    sub_text = "\n".join(links)
    b64_sub = base64.b64encode(sub_text.encode('utf-8')).decode('utf-8')
    return b64_sub, 200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Subscription-Userinfo": f"upload=0; download={int(user['used_mb']*1024*1024)}; total={int(user['traffic_limit_mb']*1024*1024)}; expire={user['expire_date']}"
    }

# ==================== 第三方发卡 API 实时出卡 ====================

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
    is_monthly_param = request.args.get("is_monthly") or (request.json or {}).get("is_monthly") if request.is_json else 0

    try:
        traffic_gb = int(gb_param or 100)
        days = int(days_param or 30)
        is_monthly = 1 if str(is_monthly_param) in ["1", "true"] else 0
    except ValueError:
        traffic_gb, days, is_monthly = 100, 30, 0

    code = "KM-" + str(uuid.uuid4()).replace("-", "")[:12].upper()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    conn = get_db()
    c = conn.cursor()
    c.execute("INSERT INTO cards VALUES (?, ?, ?, 0, NULL, ?, '', ?)", (code, traffic_gb, days, now, is_monthly))
    conn.commit()
    conn.close()

    if request.args.get("format") == "json":
        return jsonify({
            "code": 200,
            "card": code,
            "traffic_gb": traffic_gb,
            "days": days,
            "is_monthly": is_monthly
        })

    return code, 200, {"Content-Type": "text/plain; charset=utf-8"}

# ==================== 远程节点集群心跳 (以主控后台配置为唯一权威) ====================

@app.route('/api/node/heartbeat', methods=['POST'])
def node_heartbeat():
    data = request.json or {}
    node_id = data.get("node_id", "").strip()
    node_key = data.get("node_key", "").strip()
    node_ip = data.get("ip")
    node_port = int(data.get("port", 443))
    raw_pbk = data.get("pbk", "").strip()
    sid = data.get("sid", "").strip()
    raw_dest = data.get("dest", "www.microsoft.com:443").strip()
    raw_sni = data.get("sni", "www.microsoft.com").strip()
    raw_server_names = data.get("server_names", "").strip()
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if not node_id:
        return jsonify({"code": 400, "msg": "缺少 node_id"}), 400

    dest = raw_dest if ":" in raw_dest else f"{raw_dest}:443"

    snis = []
    for part in re.split(r'[,;\s]+', raw_server_names or raw_sni):
        clean = part.strip().split(":")[0]
        if clean and clean not in snis:
            snis.append(clean)
    server_names_str = ",".join(snis)
    primary_sni = snis[0] if snis else "www.microsoft.com"

    # 43 位公钥智能抢救截断
    pbk = raw_pbk
    if len(pbk) != 43:
        matches = re.findall(r'[A-Za-z0-9_\-]{43}', pbk)
        if len(matches) >= 2:
            pbk = matches[1]
        elif len(matches) == 1:
            pbk = matches[0]

    if len(pbk) != 43:
        return jsonify({"code": 400, "msg": f"公钥格式错误 (原长度: {len(raw_pbk)})"}), 400

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM nodes WHERE node_id=?", (node_id,))
    node = c.fetchone()

    # 首次接入：绑定注册
    if not node:
        auto_name = f"节点-{node_ip}"
        c.execute("""
            INSERT INTO nodes 
            (node_id, node_key, pending_key, name, ip, port, dest, sni, server_names, pbk, sid, status, last_heartbeat) 
            VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        """, (node_id, node_key, auto_name, node_ip, node_port, dest, primary_sni, server_names_str, pbk, sid, now_str))
        conn.commit()
        conn.close()
        return jsonify({"code": 200, "msg": "节点首次接入成功！"})

    current_key = node["node_key"]
    pending_key = node["pending_key"]

    if pending_key and node_key == current_key:
        c.execute("""
            UPDATE nodes 
            SET node_key=?, pending_key='', ip=?, pbk=?, sid=COALESCE(NULLIF(sid, ''), ?), status=1, last_heartbeat=? 
            WHERE node_id=?
        """, (pending_key, node_ip, pbk, sid, now_str, node_id))
        conn.commit()
        conn.close()
        return jsonify({"code": 200, "msg": "心跳成功，已为您同步下发新密钥", "new_node_key": pending_key})

    # 关键防反向覆盖：心跳只更新 IP、公钥与时间戳，绝对不反向覆盖后台配置的 dest/sni/server_names！
    if node_key == current_key:
        c.execute("""
            UPDATE nodes 
            SET ip=?, pbk=?, sid=COALESCE(NULLIF(sid, ''), ?), status=1, last_heartbeat=? 
            WHERE node_id=?
        """, (node_ip, pbk, sid, now_str, node_id))
        conn.commit()
        conn.close()
        return jsonify({"code": 200, "msg": "心跳正常"})

    conn.close()
    return jsonify({"code": 403, "msg": "Node Key 验证失败"}), 403

# 双向同步接口：将主控后台配置的 server_names 数组下发给节点热更
@app.route('/api/node/sync', methods=['GET'])
def node_sync_users():
    node_id = request.args.get('node_id', '').strip()
    token = request.args.get('token', '').strip()

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM nodes WHERE node_id=?", (node_id,))
    node = c.fetchone()
    if not node or node["node_key"] != token:
        conn.close()
        return jsonify({"code": 403, "msg": "鉴权失败"}), 403

    c.execute("SELECT username, email, uuid FROM users WHERE status=1 AND is_verified=1")
    users = [{"id": u["uuid"], "flow": "xtls-rprx-vision", "email": u["email"]} for u in c.fetchall()]
    conn.close()

    snis = get_node_snis(dict(node))
    clean_dest = node["dest"] if (node["dest"] and ":" in node["dest"]) else f"{node['dest']}:443"

    node_config = {
        "port": node["port"],
        "dest": clean_dest,
        "sni": snis[0],
        "server_names": snis,
        "sid": node["sid"]
    }

    return jsonify({
        "code": 200,
        "node_config": node_config,
        "users": users
    })

@app.route('/api/node/traffic', methods=['POST'])
def node_report_traffic():
    data = request.json or {}
    node_id = data.get("node_id", "").strip()
    token = data.get("token", "").strip()

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT node_key FROM nodes WHERE node_id=?", (node_id,))
    node = c.fetchone()
    if not node or node["node_key"] != token:
        conn.close()
        return jsonify({"code": 403, "msg": "鉴权失败"}), 403

    for item in data.get("traffic", []):
        account = item.get("email") or item.get("username")
        inc_bytes = int(item.get("bytes", 0))
        if account and inc_bytes > 0:
            inc_mb = round(inc_bytes / (1024 * 1024), 2)
            c.execute("UPDATE users SET used_mb = used_mb + ? WHERE (email=? OR username=?)", (inc_mb, account, account))

    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": "流量同步成功"})

# ==================== 用户端与节点交互 ====================

@app.route('/api/user/refresh_info', methods=['POST'])
def user_refresh_info():
    data = request.json or {}
    username = data.get('username')
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE username=?", (username,))
    user = c.fetchone()
    if not user:
        conn.close()
        return jsonify({"code": 404, "msg": "用户不存在"})

    c.execute("SELECT * FROM nodes WHERE status=1 ORDER BY id ASC")
    node_rows = [dict(n) for n in c.fetchall()]
    conn.close()

    nodes_data = []
    host_prefix = request.host_url.rstrip('/')
    sub_url = f"{host_prefix}/api/sub?token={user['uuid']}"

    for n in node_rows:
        if len(n.get("pbk", "")) == 43:
            snis = get_node_snis(n)
            random_sni = random.choice(snis)
            link = build_node_link(user['uuid'], n, f"{n['name']}", chosen_sni=random_sni)
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
            "uuid": user['uuid'],
            "used_mb": user['used_mb'],
            "limit_mb": user['traffic_limit_mb'],
            "expire_date": user['expire_date'],
            "sub_url": sub_url,
            "nodes": nodes_data
        }
    })

@app.route('/api/login', methods=['POST'])
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

    c.execute("SELECT * FROM nodes WHERE status=1 ORDER BY id ASC")
    node_rows = [dict(n) for n in c.fetchall()]
    conn.close()

    nodes_data = []
    host_prefix = request.host_url.rstrip('/')
    sub_url = f"{host_prefix}/api/sub?token={user['uuid']}"

    for n in node_rows:
        if len(n.get("pbk", "")) == 43:
            snis = get_node_snis(n)
            random_sni = random.choice(snis)
            link = build_node_link(user['uuid'], n, f"{n['name']}", chosen_sni=random_sni)
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
            "username": user['username'],
            "email": user['email'],
            "role": user['role'],
            "uuid": user['uuid'],
            "used_mb": user['used_mb'],
            "limit_mb": user['traffic_limit_mb'],
            "expire_date": user['expire_date'],
            "is_monthly": user['is_monthly'] or 0,
            "reset_day": user['reset_day'] or 1,
            "sub_url": sub_url,
            "nodes": nodes_data,
            "notify_type": user['notify_type'] or 'email',
            "serverchan_key": user['serverchan_key'] or ''
        }
    })

@app.route('/api/user/reset_uuid', methods=['POST'])
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

    c.execute("SELECT * FROM nodes WHERE status=1 ORDER BY id ASC")
    node_rows = [dict(n) for n in c.fetchall()]
    conn.close()

    host_prefix = request.host_url.rstrip('/')
    sub_url = f"{host_prefix}/api/sub?token={new_uuid}"
    nodes_data = []
    for n in node_rows:
        if len(n.get("pbk", "")) == 43:
            snis = get_node_snis(n)
            random_sni = random.choice(snis)
            link = build_node_link(new_uuid, n, f"{n['name']}", chosen_sni=random_sni)
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

@app.route('/api/auth/send_register_code', methods=['POST'])
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

    reg_traffic_mb = int(get_setting("reg_traffic_mb", "1024") or 1024)
    reg_expire_days = int(get_setting("reg_expire_days", "1") or 1)
    exp = "2099-12-31 23:59:59" if reg_expire_days >= 3650 else (datetime.datetime.now() + datetime.timedelta(days=reg_expire_days)).strftime("%Y-%m-%d %H:%M:%S")

    try:
        c.execute("INSERT INTO users (username, password_hash, uuid, email, traffic_limit_mb, used_mb, expire_date, role, status, is_verified, is_monthly, reset_day) VALUES (?, ?, ?, ?, ?, 0, ?, 'user', 1, 1, 0, 1)",
                  (u, hash_pwd(p), str(uuid.uuid4()), email, reg_traffic_mb, exp))
        c.execute("DELETE FROM verify_codes WHERE email=?", (email,))
        conn.commit()
        conn.close()
        return jsonify({"code": 200, "msg": f"账号激活成功，获赠 {reg_traffic_mb}MB 套餐"})
    except Exception as e:
        conn.close()
        return jsonify({"code": 500, "msg": f"注册失败: {str(e)}"})

@app.route('/api/auth/send_reset_code', methods=['POST'])
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

@app.route('/api/auth/reset_password', methods=['POST'])
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

@app.route('/api/user/change_password', methods=['POST'])
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
    if not user: return jsonify({"code": 404, "msg": "用户不存在"})

    title = "【通知测试】Xray 节点服务消息连通性验证"
    content = f"恭喜！您的通知通道验证成功。当前通知通道：{user['notify_type']}。"
    ok, msg = notify_user(dict(user), title, f"<h3>{title}</h3><p>{content}</p>", content)
    if ok: return jsonify({"code": 200, "msg": "测试消息发送成功"})
    return jsonify({"code": 500, "msg": msg})

@app.route('/api/user/download_client', methods=['GET'])
def download_windows_client():
    account = request.args.get('username', '').strip()
    node_id = request.args.get('node_id', '')
    chosen_sni = request.args.get('sni', '').strip() or None
    if not account: abort(400)

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE username=? OR email=?", (account, account))
    user = c.fetchone()
    if not user:
        conn.close()
        abort(404)

    if node_id:
        c.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    else:
        c.execute("SELECT * FROM nodes WHERE status=1 ORDER BY id ASC LIMIT 1")
    node = c.fetchone()
    conn.close()

    if not node:
        return jsonify({"code": 404, "msg": "暂无可用节点"}), 404

    try:
        mem_file = generate_windows_package(dict(user), dict(node), chosen_sni=chosen_sni)
        filename = f"Xray_Windows_{user['username']}_{node['name']}.zip"
        return send_file(mem_file, as_attachment=True, download_name=filename, mimetype='application/zip')
    except Exception as e:
        return jsonify({"code": 500, "msg": f"客户端构建失败: {str(e)}"}), 500

@app.route('/api/recharge', methods=['POST'])
def recharge():
    data = request.json or {}
    u = data.get('username')
    raw_card_input = data.get('card_code', '').strip()

    if not raw_card_input:
        return jsonify({"code": 400, "msg": "请输入卡密兑换码"})

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

        if card.get('is_monthly') == 1:
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
        n_exp = (base_time + datetime.timedelta(days=total_add_days)).strftime("%Y-%m-%d %H:%M:%S")

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

# ==================== 管理员节点调度与配置修改 ====================

@app.route('/api/admin/nodes/list', methods=['POST'])
def admin_list_nodes():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM nodes ORDER BY id ASC")
    nodes = [dict(n) for n in c.fetchall()]
    conn.close()
    return jsonify({"code": 200, "data": nodes})

@app.route('/api/admin/nodes/save_config', methods=['POST'])
def admin_save_node_config():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get('node_id')
    name = data.get('name', '').strip()
    ip = data.get('ip', '').strip()
    port = int(data.get('port', 443))
    raw_dest = data.get('dest', 'www.microsoft.com:443').strip()
    raw_server_names = data.get('server_names', '').strip()
    raw_sni = data.get('sni', 'www.microsoft.com').strip()
    sid = data.get('sid', '').strip()
    node_key = data.get('node_key', '').strip()
    status = int(data.get('status', 1))

    dest = raw_dest if ":" in raw_dest else f"{raw_dest}:443"

    snis = []
    for part in re.split(r'[,;\s]+', raw_server_names or raw_sni):
        clean = part.strip().split(":")[0]
        if clean and clean not in snis:
            snis.append(clean)
    server_names_str = ",".join(snis)
    primary_sni = snis[0] if snis else "www.microsoft.com"

    conn = get_db()
    c = conn.cursor()
    c.execute("""
        UPDATE nodes 
        SET name=?, ip=?, port=?, dest=?, sni=?, server_names=?, sid=?, node_key=?, status=?
        WHERE node_id=?
    """, (name, ip, port, dest, primary_sni, server_names_str, sid, node_key, status, node_id))
    conn.commit()
    conn.close()

    return jsonify({"code": 200, "msg": "节点配置已更新！多域名列表已同步，远程节点下次回传时自动热重载。"})

@app.route('/api/admin/nodes/force_resync', methods=['POST'])
def admin_nodes_force_resync():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get('node_id')
    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE nodes SET pbk='', sid='', last_heartbeat='等待重新上报' WHERE node_id=?", (node_id,))
    conn.commit()
    conn.close()

    return jsonify({"code": 200, "msg": "节点主控缓存已成功重置！节点将在下次心跳（最快几秒内）重新上报正确的公钥与ShortId。"})

@app.route('/api/admin/nodes/revoke_delete', methods=['POST'])
def admin_revoke_delete_node():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get('node_id')
    conn = get_db()
    c = conn.cursor()
    c.execute("DELETE FROM nodes WHERE node_id=?", (node_id,))
    conn.commit()
    conn.close()

    return jsonify({"code": 200, "msg": "节点已被彻底从集群中吊销并移除！"})

@app.route('/api/admin/nodes/reset_key', methods=['POST'])
def admin_reset_node_key():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get('node_id')
    new_key = secrets.token_hex(16)

    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE nodes SET pending_key=? WHERE node_id=?", (new_key, node_id))
    conn.commit()
    conn.close()

    return jsonify({
        "code": 200,
        "msg": "重置密钥指令已就绪！节点将在 60 秒内心跳自动同步新密钥并持久化保存。",
        "new_key": new_key
    })

@app.route('/api/admin/cards/generate', methods=['POST'])
def admin_generate():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    conn = get_db()
    c = conn.cursor()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    created = []
    t_gb = int(data.get('traffic_gb', 50))
    days = int(data.get('days', 30))
    is_monthly = 1 if data.get('is_monthly') else 0

    for _ in range(int(data.get('count', 5))):
        code = "KM-" + str(uuid.uuid4()).replace("-", "")[:12].upper()
        c.execute("INSERT INTO cards VALUES (?, ?, ?, 0, NULL, ?, '', ?)", (code, t_gb, days, now, is_monthly))
        created.append(code)
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": "制卡成功", "cards": created})

@app.route('/api/admin/cards/export_unused', methods=['POST'])
def export_unused_cards():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    selected_codes = data.get("selected_codes", [])
    start_date = data.get("start_date", "").strip()
    end_date = data.get("end_date", "").strip()

    conn = get_db()
    c = conn.cursor()
    if selected_codes:
        placeholders = ','.join(['?'] * len(selected_codes))
        c.execute(f"SELECT code FROM cards WHERE code IN ({placeholders}) ORDER BY rowid DESC", selected_codes)
    elif start_date or end_date:
        query_parts, params = ["is_used=0"], []
        if start_date: query_parts.append("substr(created_at, 1, 10) >= ?"); params.append(start_date)
        if end_date: query_parts.append("substr(created_at, 1, 10) <= ?"); params.append(end_date)
        c.execute(f"SELECT code FROM cards WHERE {' AND '.join(query_parts)} ORDER BY rowid DESC", params)
    else:
        c.execute("SELECT code FROM cards WHERE is_used=0 ORDER BY rowid DESC")

    cards = [r["code"] for r in c.fetchall()]
    conn.close()
    return jsonify({"code": 200, "count": len(cards), "text": "\n".join(cards)})

@app.route('/api/admin/cards/delete', methods=['POST'])
def admin_delete_cards():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    mode = data.get('mode', '').strip()
    conn = get_db()
    c = conn.cursor()
    deleted_count = 0

    if mode == 'selected':
        selected_codes = data.get('selected_codes', [])
        if not selected_codes:
            conn.close()
            return jsonify({"code": 400, "msg": "请先勾选需要删除的卡密"})
        placeholders = ','.join(['?'] * len(selected_codes))
        c.execute(f"DELETE FROM cards WHERE code IN ({placeholders})", selected_codes)
        deleted_count = c.rowcount

    elif mode == 'date':
        start_date = data.get('start_date', '').strip()
        end_date = data.get('end_date', '').strip()
        if not start_date and not end_date:
            conn.close()
            return jsonify({"code": 400, "msg": "请选择需要删除的日期范围"})
        query_parts, params = [], []
        if start_date:
            query_parts.append("substr(created_at, 1, 10) >= ?")
            params.append(start_date)
        if end_date:
            query_parts.append("substr(created_at, 1, 10) <= ?")
            params.append(end_date)
        query_parts.append("is_used=0")
        c.execute(f"DELETE FROM cards WHERE {' AND '.join(query_parts)}", params)
        deleted_count = c.rowcount

    elif mode == 'invalid':
        c.execute("DELETE FROM cards WHERE is_used=1")
        deleted_count = c.rowcount

    else:
        conn.close()
        return jsonify({"code": 400, "msg": "不支持的删除模式"})

    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": f"卡密清理完成！共成功删除 {deleted_count} 张卡密。"})

# 核心：管理端用户数据实时聚合下发 (1个物理节点严格对应1条精炼直连链接，默认使用随机挑选的 SNI)
@app.route('/api/admin/data', methods=['POST'])
def admin_data():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT code, traffic_gb, days, is_used, used_by, created_at, used_at, is_monthly FROM cards ORDER BY rowid DESC LIMIT 200")
    cards = [dict(r) for r in c.fetchall()]

    c.execute("SELECT * FROM nodes WHERE status=1 ORDER BY id ASC")
    active_nodes = [dict(n) for n in c.fetchall()]

    c.execute("SELECT username, email, traffic_limit_mb, used_mb, expire_date, role, uuid, status, notify_type, is_monthly, reset_day FROM users")
    raw_users = c.fetchall()
    conn.close()

    host_prefix = request.host_url.rstrip('/')
    users = []
    for r in raw_users:
        d = dict(r)
        d['sub_url'] = f"{host_prefix}/api/sub?token={d['uuid']}"
        d['node_links'] = []
        for n in active_nodes:
            if len(n.get("pbk", "")) == 43:
                snis = get_node_snis(n)
                # 每个物理节点1条，默认使用随机分配的SNI，保持清爽！
                chosen_sni = random.choice(snis)
                d['node_links'].append({
                    "id": n['id'],
                    "node_id": n['node_id'],
                    "name": n['name'],
                    "ip": n['ip'],
                    "port": n['port'],
                    "pbk": n['pbk'],
                    "sid": n['sid'],
                    "sni": chosen_sni,
                    "server_names": snis,
                    "selected_sni": chosen_sni,
                    "link": build_node_link(d['uuid'], n, f"{n['name']}", chosen_sni=chosen_sni)
                })
        users.append(d)

    return jsonify({"code": 200, "cards": cards, "users": users})

@app.route('/api/admin/users/reset_uuid', methods=['POST'])
def admin_reset_user_uuid():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    target_user = data.get('target_user')
    new_uuid = str(uuid.uuid4())
    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE users SET uuid=? WHERE username=?", (new_uuid, target_user))
    c.execute("SELECT * FROM users WHERE username=?", (target_user,))
    user = c.fetchone()
    conn.commit()
    conn.close()

    if user:
        title = "【安全通知】管理员已重置您的节点连接凭证 (UUID)"
        content = f"您好 {target_user}，管理员已为您重置节点连接凭证。旧凭证已彻底失效断网，请登录控制台复制最新订阅地址重新导入！"
        notify_user(dict(user), title, f"<h3>{title}</h3><p>{content}</p>", content)

    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 凭证 (UUID) 已重置为: {new_uuid}"})

@app.route('/api/admin/users/reset_password', methods=['POST'])
def admin_reset_password():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    target_user = data.get('target_user')
    new_pwd = data.get('new_password', '').strip()

    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE users SET password_hash=? WHERE username=?", (hash_pwd(new_pwd), target_user))
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 密码已成功重置！"})

@app.route('/api/admin/users/status', methods=['POST'])
def update_user_status():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    target_user = data.get('target_user')
    status = int(data.get('status', 1))

    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE users SET status=? WHERE username=?", (status, target_user))
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 状态已更新"})

@app.route('/api/admin/users/edit', methods=['POST'])
def edit_user_quota():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    target_user = data.get('target_user')
    limit_mb = int(data.get('limit_mb', 0))
    expire_date = data.get('expire_date', '').strip()
    is_monthly = 1 if data.get('is_monthly') else 0
    reset_day = int(data.get('reset_day', 1) or 1)

    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE users SET traffic_limit_mb=?, expire_date=?, is_monthly=?, reset_day=? WHERE username=?",
              (limit_mb, expire_date, is_monthly, reset_day, target_user))
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 属性已更新"})

@app.route('/api/admin/users/delete', methods=['POST'])
def delete_user():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    target_user = data.get('target_user')

    conn = get_db()
    c = conn.cursor()
    c.execute("DELETE FROM users WHERE username=?", (target_user,))
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 已被彻底删除"})

# ==================== 管理员系统与证书管理 ====================

@app.route('/api/admin/cert/info', methods=['POST'])
def admin_cert_info():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    return jsonify({"code": 200, "data": get_cert_info()})

@app.route('/api/admin/cert/custom', methods=['POST'])
def admin_cert_custom():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    cert_pem = data.get("cert_pem", "")
    key_pem = data.get("key_pem", "")

    ok, msg = save_custom_certificate(cert_pem, key_pem)
    if ok:
        def auto_reload():
            time.sleep(2)
            os._exit(0)
        threading.Thread(target=auto_reload, daemon=True).start()
        return jsonify({"code": 200, "msg": f"{msg}\n【提示】面板将在 2 秒内平滑重载生效，请稍后刷新页面！"})
    return jsonify({"code": 500, "msg": msg})

@app.route('/api/admin/cert/acme', methods=['POST'])
def admin_cert_acme():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    domain = data.get("domain", "").strip()
    email = data.get("email", "").strip()

    ok, msg = issue_acme_certificate(domain, email)
    if ok:
        def auto_reload():
            time.sleep(2)
            os._exit(0)
        threading.Thread(target=auto_reload, daemon=True).start()
        return jsonify({"code": 200, "msg": f"{msg}\n【提示】面板将在 2 秒内平滑重载生效，请稍后刷新页面！"})
    return jsonify({"code": 500, "msg": msg})

@app.route('/api/admin/cert/self_signed', methods=['POST'])
def admin_cert_self_signed():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    generate_self_signed_cert()
    return jsonify({"code": 200, "msg": "已重新生成自签证书"})

@app.route('/api/admin/settings', methods=['GET', 'POST'])
def handle_settings():
    if request.method == 'GET':
        admin_user = request.args.get('admin_user')
        admin_pwd = request.args.get('admin_pwd')
        if not check_admin(admin_user, admin_pwd): return jsonify({"code": 403, "msg": "无权限"})

        smtp_host = get_setting("smtp_host", "")
        smtp_user = get_setting("smtp_user", "")
        smtp_pass = get_setting("smtp_pass", "")
        has_smtp_pass = bool(smtp_pass.strip())
        is_smtp_configured = bool(smtp_host.strip() and smtp_user.strip() and has_smtp_pass)

        return jsonify({
            "code": 200,
            "data": {
                "smtp_host": smtp_host,
                "smtp_port": get_setting("smtp_port", "465"),
                "smtp_user": smtp_user,
                "has_smtp_pass": has_smtp_pass,
                "is_smtp_configured": is_smtp_configured,
                "smtp_sender": get_setting("smtp_sender", "Xray 节点运营中心"),
                "smtp_ssl": get_setting("smtp_ssl", "true"),
                "task_notify_enable": get_setting("task_notify_enable", "true"),
                "task_interval_hours": get_setting("task_interval_hours", "12"),
                "task_traffic_threshold": get_setting("task_traffic_threshold", "80"),
                "task_expire_days": get_setting("task_expire_days", "3"),
                "task_last_run": get_setting("task_last_run", "尚未执行"),
                "faka_api_enable": get_setting("faka_api_enable", "true"),
                "faka_api_token": get_setting("faka_api_token", Config.FAKA_API_TOKEN),
                "acme_enable": get_setting("acme_enable", "false"),
                "acme_domain": get_setting("acme_domain", ""),
                "acme_email": get_setting("acme_email", ""),
                "system_notice": get_setting("system_notice", ""),
                "reg_traffic_mb": get_setting("reg_traffic_mb", "1024"),
                "reg_expire_days": get_setting("reg_expire_days", "1")
            }
        })
    else:
        data = request.json or {}
        if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

        new_pass = data.get("smtp_pass", "").strip()
        if new_pass:
            set_setting("smtp_pass", new_pass)

        keys = ["smtp_host", "smtp_port", "smtp_user", "smtp_sender", "smtp_ssl",
                "task_notify_enable", "task_interval_hours", "task_traffic_threshold", "task_expire_days",
                "faka_api_enable", "faka_api_token", "acme_enable", "acme_domain", "acme_email",
                "system_notice", "reg_traffic_mb", "reg_expire_days"]
        for k in keys:
            if k in data:
                set_setting(k, str(data[k]).strip())
        return jsonify({"code": 200, "msg": "系统配置已成功保存"})

@app.route('/api/admin/test_email', methods=['POST'])
def test_email():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    to = data.get('test_to', '').strip()
    ok, msg = send_smtp_email(to, "【测试邮件】Xray 邮件服务器通信正常", "<p>恭喜！SMTP 发信服务器工作正常。</p>")
    if ok: return jsonify({"code": 200, "msg": "测试邮件已成功投递！"})
    return jsonify({"code": 500, "msg": msg})

@app.route('/api/admin/tasks/trigger', methods=['POST'])
def trigger_task_now():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    t_sent, e_sent, desc = run_scheduled_check(force=True)
    return jsonify({"code": 200, "msg": desc, "data": {"traffic_sent": t_sent, "expire_sent": e_sent}})

def check_admin(u, p):
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT role FROM users WHERE (username=? OR email=?) AND password_hash=?", (u, u, hash_pwd(p or '')))
    r = c.fetchone()
    conn.close()
    return r and r['role'] == 'admin'

if __name__ == '__main__':
    cert_path, key_path = ensure_certificates()
    print(f"==> [HTTPS] 正在以 HTTPS 加密协议启动面板 (端口: {Config.WEB_PORT})...", flush=True)
    app.run(
        host='0.0.0.0',
        port=Config.WEB_PORT,
        ssl_context=(cert_path, key_path)
    )