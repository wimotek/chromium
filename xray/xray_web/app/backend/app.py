import base64
import datetime
import io
import mimetypes
import os
import random
import sys
import time

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")

import qrcode
import qrcode.image.svg
from flask import Flask, abort, jsonify, request, send_file, send_from_directory
from sqlalchemy import select
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import safe_join

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
from routes import (
    build_hy2_link,
    build_node_link,
    get_node_snis,
    is_node_healthy_for_sub,
    is_user_allowed_for_node,
    pick_node_sni,
    resolve_public_endpoint,
)
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


def _no_cache_html_response(response):
    response.headers['Cache-Control'] = 'private, no-cache, no-store, must-revalidate, max-age=0'
    response.headers['CDN-Cache-Control'] = 'no-store'
    response.headers['Cloudflare-CDN-Cache-Control'] = 'no-store'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response


def _client_accepts_gzip():
    enc = (request.headers.get('Accept-Encoding') or '').lower()
    return 'gzip' in enc


def _append_vary_accept_encoding(response):
    existing = response.headers.get('Vary')
    if not existing:
        response.headers['Vary'] = 'Accept-Encoding'
    elif 'accept-encoding' not in [v.strip().lower() for v in existing.split(',')]:
        response.headers['Vary'] = f"{existing}, Accept-Encoding"
    return response


def _send_precompressed_static(rel_path, is_html=False):
    if not app.static_folder:
        abort(404)
    target = safe_join(app.static_folder, rel_path)
    if not target or not os.path.isfile(target):
        abort(404)

    mime, _ = mimetypes.guess_type(target)
    if not mime:
        mime = 'text/html; charset=utf-8' if is_html else 'application/octet-stream'
    elif mime == 'text/html' and 'charset=' not in mime:
        mime = 'text/html; charset=utf-8'

    gz_target = f"{target}.gz"
    if _client_accepts_gzip() and os.path.isfile(gz_target):
        resp = send_file(gz_target, mimetype=mime, conditional=True, etag=True)
        resp.headers['Content-Encoding'] = 'gzip'
    else:
        resp = send_from_directory(app.static_folder, rel_path, mimetype=mime)

    _append_vary_accept_encoding(resp)
    return _no_cache_html_response(resp) if is_html else resp


@app.after_request
def add_cdn_safe_headers(response):
    path = request.path or ''
    if path.startswith('/api/'):
        response.headers.setdefault('Cache-Control', 'private, no-store, max-age=0')
        response.headers.setdefault('CDN-Cache-Control', 'no-store')
        response.headers.setdefault('Cloudflare-CDN-Cache-Control', 'no-store')
    elif path.startswith('/assets/'):
        if response.status_code == 200:
            response.headers['Cache-Control'] = 'public, max-age=2592000, immutable'
        else:
            response.headers['Cache-Control'] = 'no-store'
            response.headers['CDN-Cache-Control'] = 'no-store'
        response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    return response


@app.errorhandler(404)
def spa_or_api_not_found(_err):
    path = request.path or ''
    if path.startswith('/api/') or path.startswith('/assets/') or Config.SEPARATE_FRONTEND:
        resp = jsonify({"code": 404, "msg": "Not Found"})
        resp.status_code = 404
        resp.headers['Cache-Control'] = 'no-store'
        resp.headers['CDN-Cache-Control'] = 'no-store'
        return resp
    return _send_precompressed_static('index.html', is_html=True)


@app.route('/healthz', methods=['GET'])
def health_check():
    """轻量健康探测接口，供 Docker HEALTHCHECK 及 Nginx / K8s 探针秒级检测"""
    return "OK", 200


@app.route('/assets/<path:filename>')
def serve_precompressed_asset(filename):
    if Config.SEPARATE_FRONTEND or filename.endswith('.gz'):
        abort(404)
    return _send_precompressed_static(os.path.join('assets', filename), is_html=False)


@app.route('/index.html')
def index_html():
    if Config.SEPARATE_FRONTEND:
        abort(404)
    return _send_precompressed_static('index.html', is_html=True)


@app.route('/')
def index():
    if Config.SEPARATE_FRONTEND:
        return jsonify({
            "code": 200,
            "msg": "Xray-Web API Backend Running (Frontend static assets & TLS offloaded to Nginx)",
            "separate_frontend": True,
            "health": "/healthz",
        })
    return _send_precompressed_static('index.html', is_html=True)


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

    with db_session(readonly=True) as s:
        user_obj = s.scalar(select(User).where(User.uuid == token, User.status == 1))
        user = user_obj.to_dict() if user_obj else None
    if not user:
        abort(403)

    all_nodes = get_cached_nodes()
    now_ts = time.time()
    now_dt = datetime.datetime.now()

    # 权限 + 健康双重过滤：仅下发已启用、用户有权访问、且心跳/自检/手动测活均健康的节点
    allowed_nodes = [
        n for n in all_nodes
        if is_user_allowed_for_node(user, n) and is_node_healthy_for_sub(n, now_ts=now_ts, now_dt=now_dt)
    ]

    hub_host, hub_port, _ = resolve_public_endpoint(request)
    links = []
    for n in allowed_nodes:
        if len(n.get("pbk", "")) == 43:
            chosen_sni = pick_node_sni(n, forced_sni=forced_sni)
            remark = f"{n['name']}"
            links.append(build_node_link(user['uuid'], n, remark, chosen_sni=chosen_sni, hub_domain=hub_host, hub_port=hub_port))
            hy2_link = build_hy2_link(user['uuid'], n, remark)
            if hy2_link:
                links.append(hy2_link)

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