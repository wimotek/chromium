import os
import sys
import io
import base64
import random
import qrcode
import qrcode.image.svg
from flask import Flask, request, send_from_directory, abort, send_file

# 确保 backend 根路径优先加入 sys.path
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from config import Config
from core.db import init_db, get_db
from core.cert_manager import ensure_certificates, CHALLENGE_DIR
from services.scheduler_service import start_scheduler_thread

# 导入通用路由工具与所有领域蓝图
from routes import get_node_snis, build_node_link
from routes.auth import auth_bp
from routes.user import user_bp
from routes.node import node_bp
from routes.admin import admin_bp
from routes.card import card_bp
from routes.system import system_bp

app = Flask(__name__, static_folder='../frontend/dist', static_url_path='/')

# 注册所有业务功能模块蓝图
app.register_blueprint(auth_bp)
app.register_blueprint(user_bp)
app.register_blueprint(node_bp)
app.register_blueprint(admin_bp)
app.register_blueprint(card_bp)
app.register_blueprint(system_bp)

init_db()

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/.well-known/acme-challenge/<path:filename>')
def acme_challenge_token(filename):
    return send_from_directory(CHALLENGE_DIR, filename)

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

# 聚合多节点订阅
@app.route('/api/sub', methods=['GET'])
def get_subscription():
    token = request.args.get('token', '').strip()
    forced_sni = request.args.get('sni', '').strip() or None
    if not token:
        abort(400)

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
            chosen_sni = forced_sni if (forced_sni and forced_sni in snis) else random.choice(snis)
            remark = f"{n['name']}"
            links.append(build_node_link(user['uuid'], n, remark, chosen_sni=chosen_sni))

    sub_text = "\n".join(links)
    b64_sub = base64.b64encode(sub_text.encode('utf-8')).decode('utf-8')
    return b64_sub, 200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Subscription-Userinfo": f"upload=0; download={int(user['used_mb']*1024*1024)}; total={int(user['traffic_limit_mb']*1024*1024)}; expire={user['expire_date']}"
    }

# 启动后台守护定时线程 (巡检、自动重置与证书自动更新)
start_scheduler_thread()

if __name__ == '__main__':
    cert_path, key_path = ensure_certificates()
    print(f"==> [HTTPS] 正在以 HTTPS 加密协议启动面板 (端口: {Config.WEB_PORT})...", flush=True)
    app.run(
        host='0.0.0.0',
        port=Config.WEB_PORT,
        ssl_context=(cert_path, key_path)
    )