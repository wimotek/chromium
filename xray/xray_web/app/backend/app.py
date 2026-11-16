import base64
import io
import os
import random
import sys

import qrcode
import qrcode.image.svg
from flask import Flask, abort, jsonify, request, send_file, send_from_directory
from sqlalchemy import select
from werkzeug.middleware.proxy_fix import ProxyFix

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from config import Config
from core.cert_manager import ensure_certificates
from core.db import db_session, get_cached_nodes, init_db
from core.models import User
from core.rate_limit import is_trusted_proxy_peer, rate_limit
from services.scheduler_service import start_scheduler_thread

# 导入通用路由工具与所有领域蓝图
from routes import build_node_link, get_node_snis, is_user_allowed_for_node, resolve_public_endpoint
from routes.admin import admin_bp
from routes.auth import auth_bp
from routes.card import card_bp
from routes.node import node_bp
from routes.setup import setup_bp
from routes.system import system_bp
from routes.user import user_bp

if Config.SEPARATE_FRONTEND:
    app = Flask(__name__, static_folder=None)
else:
    app = Flask(__name__, static_folder='../frontend/dist', static_url_path='/')


class TrustedProxyMiddleware:
    """仅当直连 TCP 对端属于受信任代理时才解析 X-Forwarded-*，彻底防止公网直连伪造 IP 绕过限流"""

    def __init__(self, wsgi_app):
        self.raw_app = wsgi_app
        self.proxied_app = ProxyFix(wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)

    def __call__(self, environ, start_response):
        peer_ip = (environ.get("REMOTE_ADDR") or "").strip()
        if is_trusted_proxy_peer(peer_ip):
            return self.proxied_app(environ, start_response)
        return self.raw_app(environ, start_response)


app.wsgi_app = TrustedProxyMiddleware(app.wsgi_app)

app.register_blueprint(auth_bp)
app.register_blueprint(user_bp)
app.register_blueprint(node_bp)
app.register_blueprint(admin_bp)
app.register_blueprint(card_bp)
app.register_blueprint(system_bp)
app.register_blueprint(setup_bp)

init_db()


@app.route('/healthz', methods=['GET'])
def health_check():
    """轻量健康探测接口，供 Docker HEALTHCHECK 及 Nginx / K8s 探针秒级检测"""
    return "OK", 200


@app.route('/')
def index():
    if Config.SEPARATE_FRONTEND:
        return jsonify({
            "code": 200,
            "msg": "Xray-Web API Backend Running (Frontend static assets & TLS offloaded to Nginx)",
            "separate_frontend": True,
            "health": "/healthz",
        })
    response = send_from_directory(app.static_folder, 'index.html')
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response


@app.route('/api/qrcode', methods=['GET'])
@rate_limit("qrcode_ip", limit=60, window_seconds=60, msg="二维码生成请求过于频繁，请稍后再试")
def get_qrcode_svg():
    text = request.args.get('text', '').strip()
    if not text or len(text) > 2048:
        abort(400)
    img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    buf.seek(0)
    return send_file(buf, mimetype='image/svg+xml')


# 聚合多节点订阅：严格基于节点禁用状态与用户组/用户白名单过滤！
@app.route('/api/sub', methods=['GET'])
@rate_limit("sub_ip", limit=60, window_seconds=60, msg="订阅拉取过于频繁，请稍后再试")
def get_subscription():
    token = request.args.get('token', '').strip()
    forced_sni = request.args.get('sni', '').strip() or None
    if not token:
        abort(400)

    with db_session() as s:
        user_obj = s.scalar(select(User).where(User.uuid == token, User.status == 1))
        user = user_obj.to_dict() if user_obj else None
    if not user:
        abort(403)

    all_nodes = get_cached_nodes()

    # 权限过滤器：仅提取启用的且用户被允许访问的节点
    allowed_nodes = [n for n in all_nodes if is_user_allowed_for_node(user, n)]

    hub_host, hub_port, _ = resolve_public_endpoint(request)
    links = []
    for n in allowed_nodes:
        if len(n.get("pbk", "")) == 43:
            snis = get_node_snis(n)
            chosen_sni = forced_sni if (forced_sni and forced_sni in snis) else random.choice(snis)
            remark = f"{n['name']}"
            links.append(build_node_link(user['uuid'], n, remark, chosen_sni=chosen_sni, hub_domain=hub_host, hub_port=hub_port))

    sub_text = "\n".join(links)
    b64_sub = base64.b64encode(sub_text.encode('utf-8')).decode('utf-8')
    return b64_sub, 200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Subscription-Userinfo": f"upload=0; download={int(user.get('used_mb', 0)*1024*1024)}; total={int(user['traffic_limit_mb']*1024*1024)}; expire={user['expire_date']}"
    }


start_scheduler_thread()

if __name__ == '__main__':
    if Config.SEPARATE_FRONTEND or not Config.SSL_ENABLE:
        print(f"==> [HTTP/Nginx-Offload] 正在以纯 HTTP API 模式启动后端 (端口: {Config.WEB_PORT})...", flush=True)
        app.run(host='0.0.0.0', port=Config.WEB_PORT)
    else:
        cert_path, key_path = ensure_certificates()
        print(f"==> [HTTPS] 正在以 HTTPS 加密协议启动面板 (端口: {Config.WEB_PORT})...", flush=True)
        print(f"==> [HTTPS] 证书文件: {cert_path}", flush=True)
        print(f"==> [HTTPS] 私钥文件: {key_path}", flush=True)
        app.run(
            host='0.0.0.0',
            port=Config.WEB_PORT,
            ssl_context=(cert_path, key_path)
        )