import os
import time
import threading
from flask import Blueprint, request, jsonify
from config import Config
from db import get_setting, set_setting
from notify import send_smtp_email
from cert_manager import (
    get_cert_info,
    save_custom_certificate,
    issue_acme_certificate,
    generate_self_signed_cert
)
from routes import check_admin

system_bp = Blueprint('system_bp', __name__)

@system_bp.route('/api/system/info', methods=['GET'])
def system_info():
    return jsonify({
        "code": 200,
        "data": {
            "mode": Config.APP_MODE,
            "system_notice": get_setting("system_notice", "").strip()
        }
    })

@system_bp.route('/api/admin/cert/info', methods=['POST'])
def admin_cert_info():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    return jsonify({"code": 200, "data": get_cert_info()})

@system_bp.route('/api/admin/cert/custom', methods=['POST'])
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

@system_bp.route('/api/admin/cert/acme', methods=['POST'])
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

@system_bp.route('/api/admin/cert/self_signed', methods=['POST'])
def admin_cert_self_signed():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    generate_self_signed_cert()
    return jsonify({"code": 200, "msg": "已重新生成自签证书"})

@system_bp.route('/api/admin/settings', methods=['GET', 'POST'])
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
                "system_notice": get_setting("system_notice", "").strip(),
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

@system_bp.route('/api/admin/test_email', methods=['POST'])
def test_email():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    to = data.get('test_to', '').strip()
    ok, msg = send_smtp_email(to, "【测试邮件】Xray 邮件服务器通信正常", "<p>恭喜！SMTP 发信服务器工作正常。</p>")
    if ok: return jsonify({"code": 200, "msg": "测试邮件已成功投递！"})
    return jsonify({"code": 500, "msg": msg})

@system_bp.route('/api/admin/tasks/trigger', methods=['POST'])
def trigger_task_now():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    from app import run_scheduled_check
    t_sent, e_sent, desc = run_scheduled_check(force=True)
    return jsonify({"code": 200, "msg": desc, "data": {"traffic_sent": t_sent, "expire_sent": e_sent}})