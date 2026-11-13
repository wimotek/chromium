import os
import time
import threading
from datetime import datetime
from flask import Blueprint, request, jsonify, send_file
from config import Config
from core.db import get_setting, set_setting
from services.notify_service import send_smtp_email
from core.cert_manager import get_cert_info, generate_self_signed_cert
from core.backup_manager import (
    BACKUP_DIR,
    list_backups,
    create_database_backup,
    prune_old_backups,
    restore_database_from_backup,
    delete_backup_file,
    ensure_backup_dir
)
from routes import check_admin, resolve_public_endpoint

system_bp = Blueprint('system_bp', __name__)

@system_bp.route('/api/system/info', methods=['GET'])
def system_info():
    _, public_port, public_url = resolve_public_endpoint(request)
    return jsonify({
        "code": 200,
        "data": {
            "mode": Config.APP_MODE,
            "web_port": Config.WEB_PORT,
            "public_port": public_port,
            "public_url": public_url,
            "system_notice": get_setting("system_notice", "").strip()
        }
    })

# ----------------- 证书状态与重新自签 -----------------

@system_bp.route('/api/admin/cert/info', methods=['POST'])
def admin_cert_info():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})
    return jsonify({"code": 200, "data": get_cert_info()})

@system_bp.route('/api/admin/cert/self_signed', methods=['POST'])
def admin_cert_self_signed():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})
    generate_self_signed_cert()
    return jsonify({"code": 200, "msg": "已重新生成高兼容性 10 年期自签 TLS 证书"})

# ----------------- 数据库备份与恢复 API -----------------

@system_bp.route('/api/admin/backup/list', methods=['POST'])
def admin_backup_list():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})
    backups = list_backups()
    return jsonify({
        "code": 200,
        "data": {
            "backups": backups,
            "auto_backup_enabled": get_setting("auto_backup_enabled", "true") == "true",
            "backup_interval_hours": int(get_setting("backup_interval_hours", "24") or 24),
            "backup_max_count": int(get_setting("backup_max_count", "7") or 7),
            "last_backup_time": get_setting("last_backup_time", "尚未执行")
        }
    })

@system_bp.route('/api/admin/backup/create', methods=['POST'])
def admin_backup_create():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})

    max_count = int(get_setting("backup_max_count", "7") or 7)
    ok, msg, info = create_database_backup(tag="manual")
    if ok:
        pruned = prune_old_backups(max_keep=max_count)
        set_setting("last_backup_time", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        ret_msg = f"热备份创建成功: {info.get('filename')} ({info.get('size_human')})"
        if pruned > 0:
            ret_msg += f"，已轮替清理 {pruned} 份历史超出配额快照"
        return jsonify({"code": 200, "msg": ret_msg, "data": info})
    return jsonify({"code": 500, "msg": msg})

@system_bp.route('/api/admin/backup/restore', methods=['POST'])
def admin_backup_restore():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})

    filename = data.get("filename", "").strip()
    if not filename:
        return jsonify({"code": 400, "msg": "请指定要恢复的备份文件名"})

    ok, msg = restore_database_from_backup(filename)
    if ok:
        return jsonify({"code": 200, "msg": msg})
    return jsonify({"code": 500, "msg": msg})

@system_bp.route('/api/admin/backup/delete', methods=['POST'])
def admin_backup_delete():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})

    filename = data.get("filename", "").strip()
    if not filename:
        return jsonify({"code": 400, "msg": "请指定要删除的备份文件名"})

    ok, msg = delete_backup_file(filename)
    if ok:
        return jsonify({"code": 200, "msg": msg})
    return jsonify({"code": 500, "msg": msg})

@system_bp.route('/api/admin/backup/download', methods=['GET'])
def admin_backup_download():
    admin_user = request.args.get('admin_user')
    admin_pwd = request.args.get('admin_pwd')
    if not check_admin(admin_user, admin_pwd):
        return jsonify({"code": 403, "msg": "无权限"}), 403

    filename = request.args.get("filename", "").strip()
    safe_name = os.path.basename(filename)
    if safe_name != filename or not (safe_name.startswith("xray_backup_") and safe_name.endswith(".db")):
        return jsonify({"code": 400, "msg": "非法文件名"}), 400

    target = os.path.join(BACKUP_DIR, safe_name)
    if not os.path.exists(target):
        return jsonify({"code": 404, "msg": "备份文件不存在"}), 404

    return send_file(target, as_attachment=True, download_name=safe_name)

@system_bp.route('/api/admin/backup/upload', methods=['POST'])
def admin_backup_upload():
    admin_user = request.form.get('admin_user')
    admin_pwd = request.form.get('admin_pwd')
    if not check_admin(admin_user, admin_pwd):
        return jsonify({"code": 403, "msg": "无权限"})

    if 'file' not in request.files:
        return jsonify({"code": 400, "msg": "未检测到上传文件"})

    uploaded_file = request.files['file']
    if uploaded_file.filename == '':
        return jsonify({"code": 400, "msg": "文件名为空"})

    if not uploaded_file.filename.endswith(".db"):
        return jsonify({"code": 400, "msg": "仅允许上传 SQLite .db 格式备份文件"})

    ensure_backup_dir()
    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_filename = f"xray_backup_{timestamp_str}_uploaded.db"
    dest_path = os.path.join(BACKUP_DIR, safe_filename)

    try:
        uploaded_file.save(dest_path)
        # 验证 SQLite 文件完整性
        import sqlite3
        conn = sqlite3.connect(dest_path)
        cursor = conn.cursor()
        cursor.execute("PRAGMA quick_check;")
        res = cursor.fetchone()
        conn.close()

        if not res or res[0] != "ok":
            os.remove(dest_path)
            return jsonify({"code": 400, "msg": "上传的文件非合法或完整 SQLite 数据库文件"})

        max_count = int(get_setting("backup_max_count", "7") or 7)
        prune_old_backups(max_keep=max_count)
        return jsonify({"code": 200, "msg": f"外部备份文件已成功导入: {safe_filename}，可直接在列表中点击一键还原！"})
    except Exception as e:
        if os.path.exists(dest_path):
            try: os.remove(dest_path)
            except Exception: pass
        return jsonify({"code": 500, "msg": f"保存上传备份失败: {str(e)}"})

# ----------------- 系统常规配置项 -----------------

@system_bp.route('/api/admin/settings', methods=['GET', 'POST'])
def handle_settings():
    if request.method == 'GET':
        admin_user = request.args.get('admin_user')
        admin_pwd = request.args.get('admin_pwd')
        if not check_admin(admin_user, admin_pwd):
            return jsonify({"code": 403, "msg": "无权限"})

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
                "system_notice": get_setting("system_notice", "").strip(),
                "reg_traffic_mb": get_setting("reg_traffic_mb", "1024"),
                "reg_expire_days": get_setting("reg_expire_days", "1"),
                "referral_enabled": get_setting("referral_enabled", "true"),
                "referral_inviter_traffic_gb": get_setting("referral_inviter_traffic_gb", "10"),
                "referral_inviter_days": get_setting("referral_inviter_days", "30"),
                "referral_invitee_traffic_gb": get_setting("referral_invitee_traffic_gb", "5"),
                "referral_invitee_days": get_setting("referral_invitee_days", "30"),
                "referral_max_per_user": get_setting("referral_max_per_user", "50"),
                # 数据库定期备份配置
                "auto_backup_enabled": get_setting("auto_backup_enabled", "true"),
                "backup_interval_hours": get_setting("backup_interval_hours", "24"),
                "backup_max_count": get_setting("backup_max_count", "7"),
                "last_backup_time": get_setting("last_backup_time", "尚未执行")
            }
        })
    else:
        data = request.json or {}
        if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
            return jsonify({"code": 403, "msg": "无权限"})

        new_pass = data.get("smtp_pass", "").strip()
        if new_pass:
            set_setting("smtp_pass", new_pass)

        keys = [
            "smtp_host", "smtp_port", "smtp_user", "smtp_sender", "smtp_ssl",
            "task_notify_enable", "task_interval_hours", "task_traffic_threshold", "task_expire_days",
            "faka_api_enable", "faka_api_token",
            "system_notice", "reg_traffic_mb", "reg_expire_days",
            "referral_enabled", "referral_inviter_traffic_gb", "referral_inviter_days",
            "referral_invitee_traffic_gb", "referral_invitee_days", "referral_max_per_user",
            # 数据库备份设置
            "auto_backup_enabled", "backup_interval_hours", "backup_max_count"
        ]
        for k in keys:
            if k in data:
                set_setting(k, str(data[k]).strip())
        return jsonify({"code": 200, "msg": "系统运维与数据库备份配置已成功保存"})

@system_bp.route('/api/admin/test_email', methods=['POST'])
def test_email():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})
    to = data.get('test_to', '').strip()
    ok, msg = send_smtp_email(to, "【测试邮件】Xray 邮件服务器通信正常", "<p>恭喜！SMTP 发信服务器工作正常。</p>")
    if ok:
        return jsonify({"code": 200, "msg": "测试邮件已成功投递！"})
    return jsonify({"code": 500, "msg": msg})

@system_bp.route('/api/admin/tasks/trigger', methods=['POST'])
def trigger_task_now():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})
    from services.scheduler_service import run_scheduled_check
    t_sent, e_sent, desc = run_scheduled_check(force=True)
    return jsonify({"code": 200, "msg": desc, "data": {"traffic_sent": t_sent, "expire_sent": e_sent}})