import json
import os
import sqlite3
from datetime import datetime
from flask import Blueprint, request, jsonify, send_file
from config import Config
from core.db import get_setting, set_setting, is_setup_required, invalidate_nodes_cache, invalidate_users_cache
from core.cache import cache, test_redis_connection
from services.notify_service import send_smtp_email
from core.cert_manager import get_cert_info, generate_self_signed_cert
from core.backup_manager import (
    BACKUP_DIR,
    list_backups,
    create_database_backup,
    prune_old_backups,
    restore_database_from_backup,
    delete_backup_file,
    ensure_backup_dir,
    is_valid_backup_filename
)
from routes import check_admin, resolve_public_endpoint

system_bp = Blueprint('system_bp', __name__)

@system_bp.route('/api/system/info', methods=['GET'])
def system_info():
    setup_req = is_setup_required()
    _, public_port, public_url = resolve_public_endpoint(request)
    return jsonify({
        "code": 200,
        "data": {
            "setup_required": setup_req,
            "mode": Config.APP_MODE,
            "separate_frontend": Config.SEPARATE_FRONTEND,
            "ssl_enabled": Config.SSL_ENABLE,
            "rate_limit_enabled": Config.RATE_LIMIT_ENABLE,
            "web_port": Config.WEB_PORT,
            "public_port": public_port,
            "public_url": public_url,
            "db_dialect": Config.db_dialect(),
            "cache_backend": cache.status()["backend"],
            "system_notice": get_setting("system_notice", "").strip()
        }
    })

# ----------------- 证书状态与重新自签 -----------------

@system_bp.route('/api/admin/cert/info', methods=['POST'])
def admin_cert_info():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})
    if Config.SEPARATE_FRONTEND:
        return jsonify({
            "code": 200,
            "data": {
                "status": "nginx_managed",
                "separate_frontend": True,
                "is_self_signed": False,
                "issuer": "已开启前后端分离（由前置 Nginx 托管 TLS 证书）",
                "days_left": 0,
                "cert_path": "Nginx 宿主机维护",
                "key_path": "Nginx 宿主机维护",
            }
        })
    return jsonify({"code": 200, "data": get_cert_info()})

@system_bp.route('/api/admin/cert/self_signed', methods=['POST'])
def admin_cert_self_signed():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})
    if Config.SEPARATE_FRONTEND:
        return jsonify({
            "code": 400,
            "msg": "当前已开启 SEPARATE_FRONTEND=true（前后端分离模式），TLS 证书由 Nginx 负责，无需容器内自签"
        }), 400
    generate_self_signed_cert()
    return jsonify({"code": 200, "msg": "已重新生成高兼容性 10 年期自签 TLS 证书"})


# ----------------- 缓存引擎（SQL Cache / Redis）实时监控与热切换 API -----------------

def _resolve_admin_redis_params(data: dict) -> tuple[str, str, int, str, int]:
    """解析后台提交的 Redis 连接参数；若未输入新密码且未勾选清除，则沿用已保存密码或原 URL"""
    import urllib.parse

    explicit_url = Config.normalize_redis_url(data.get("redis_url") or "")
    use_saved_url = bool(data.get("use_saved_url"))
    clear_pwd = bool(data.get("clear_redis_password"))
    raw_pwd = str(data.get("redis_password") or "").strip()

    saved_pwd = Config.REDIS_PASSWORD
    if not saved_pwd and Config.REDIS_URL:
        try:
            saved_url = Config.normalize_redis_url(Config.REDIS_URL)
            saved_pwd = urllib.parse.unquote(urllib.parse.urlparse(saved_url).password or "")
        except Exception:
            saved_pwd = ""

    if raw_pwd:
        effective_pwd = raw_pwd
    elif clear_pwd:
        effective_pwd = ""
    else:
        effective_pwd = saved_pwd

    if explicit_url:
        return explicit_url, str(data.get("redis_host") or "").strip(), 6379, effective_pwd, 0
    if use_saved_url and Config.REDIS_URL:
        return Config.normalize_redis_url(Config.REDIS_URL), str(data.get("redis_host") or "").strip(), 6379, effective_pwd, 0

    host = str(data.get("redis_host") or "").strip()
    try:
        port = int(data.get("redis_port") or 6379)
    except (TypeError, ValueError):
        port = 6379
    try:
        db_idx = int(data.get("redis_db") if data.get("redis_db") not in (None, "") else 0)
    except (TypeError, ValueError):
        db_idx = 0

    url = Config.build_redis_url(host, port, effective_pwd, db_idx) if host else ""
    return url, host, port, effective_pwd, db_idx


def _build_cache_admin_payload() -> dict:
    return {
        "status": cache.detailed_status(),
        "config": Config.cache_config_summary(),
        "db_dialect": Config.db_dialect(),
    }


@system_bp.route('/api/admin/cache/status', methods=['POST'])
def admin_cache_status():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})
    return jsonify({"code": 200, "data": _build_cache_admin_payload()})


@system_bp.route('/api/admin/cache/test', methods=['POST'])
def admin_cache_test():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})

    redis_url, host, port, _, db_idx = _resolve_admin_redis_params(data)
    if not redis_url:
        return jsonify({"code": 400, "msg": "请填写 Redis 主机地址或完整连接 URL"})
    if port < 1 or port > 65535:
        return jsonify({"code": 400, "msg": "Redis 端口必须在 1 ~ 65535 之间"})
    if db_idx < 0 or db_idx > 15:
        return jsonify({"code": 400, "msg": "Redis 库索引 (DB) 必须在 0 ~ 15 之间"})

    ok, msg = test_redis_connection(redis_url)
    return jsonify({"code": 200 if ok else 400, "msg": msg})


@system_bp.route('/api/admin/cache/save', methods=['POST'])
def admin_cache_save():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})

    mode = str(data.get("cache_mode") or "sql_cache").strip().lower()
    if mode not in ("redis", "sql_cache"):
        return jsonify({"code": 400, "msg": "不支持的缓存引擎类型，仅支持 redis 或 sql_cache"})

    key_prefix = Config.normalize_redis_key_prefix(data.get("redis_key_prefix") or "xray_hub:")
    try:
        timeout_val = max(0.3, min(15.0, float(data.get("redis_timeout") or 1.5)))
    except (TypeError, ValueError):
        timeout_val = 1.5
    try:
        cooldown_val = max(5, min(600, int(data.get("redis_cooldown_seconds") or 30)))
    except (TypeError, ValueError):
        cooldown_val = 30

    explicit_url = Config.normalize_redis_url(data.get("redis_url") or "")
    use_saved_url = bool(data.get("use_saved_url"))
    redis_url, host, port, effective_pwd, db_idx = _resolve_admin_redis_params(data)

    if mode == "redis":
        if not redis_url:
            return jsonify({"code": 400, "msg": "启用 Redis 前请填写 Redis 主机地址或完整连接 URL"})
        if port < 1 or port > 65535:
            return jsonify({"code": 400, "msg": "Redis 端口必须在 1 ~ 65535 之间"})
        if db_idx < 0 or db_idx > 15:
            return jsonify({"code": 400, "msg": "Redis 库索引 (DB) 必须在 0 ~ 15 之间"})

        ok, test_msg = test_redis_connection(redis_url)
        if not ok:
            return jsonify({"code": 400, "msg": f"连通性校验未通过，未切换配置：{test_msg}"})

        saved_explicit_url = explicit_url or (Config.normalize_redis_url(Config.REDIS_URL) if use_saved_url else "")
        Config.save_hub_config({
            "cache_mode": "redis",
            "redis_url": saved_explicit_url,
            "redis_host": "" if saved_explicit_url else host,
            "redis_port": port,
            "redis_password": "" if saved_explicit_url else effective_pwd,
            "redis_db": db_idx,
            "redis_key_prefix": key_prefix,
            "redis_timeout": timeout_val,
            "redis_cooldown_seconds": cooldown_val,
        })
        cache.reset_client()
        cache.delete_prefix("setting:")
        invalidate_nodes_cache()
        invalidate_users_cache()
        return jsonify({
            "code": 200,
            "msg": f"已成功切换为 Redis 缓存引擎并全节点 Worker 热生效（无需重启容器）！{test_msg}",
            "data": _build_cache_admin_payload(),
        })

    # 切回内置 SQL Cache（保留主机/端口配置方便下次快速切回）
    save_patch = {
        "cache_mode": "sql_cache",
        "redis_key_prefix": key_prefix,
        "redis_timeout": timeout_val,
        "redis_cooldown_seconds": cooldown_val,
    }
    if host:
        save_patch["redis_host"] = host
    if 1 <= port <= 65535:
        save_patch["redis_port"] = port
    if 0 <= db_idx <= 15:
        save_patch["redis_db"] = db_idx
    if data.get("clear_redis_password"):
        save_patch["redis_password"] = ""
        save_patch["redis_url"] = ""
    elif str(data.get("redis_password") or "").strip():
        save_patch["redis_password"] = str(data.get("redis_password")).strip()

    Config.save_hub_config(save_patch)
    cache.reset_client()
    cache.delete_prefix("setting:")
    invalidate_nodes_cache()
    invalidate_users_cache()
    return jsonify({
        "code": 200,
        "msg": "已热切换回内置 SQL Cache（kv_cache），所有 Worker 进程将在 1~2 秒内自动同步，无需重启容器！",
        "data": _build_cache_admin_payload(),
    })


@system_bp.route('/api/admin/cache/flush', methods=['POST'])
def admin_cache_flush():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')):
        return jsonify({"code": 403, "msg": "无权限"})

    deleted_settings = cache.delete_prefix("setting:")
    invalidate_nodes_cache()
    invalidate_users_cache()
    cleaned_expired = cache.cleanup_expired_sql()
    return jsonify({
        "code": 200,
        "msg": f"业务缓存已清理刷新（清除配置缓存 {deleted_settings} 项、节点/用户快照已失效、清理过期 SQL 缓存 {cleaned_expired} 条）",
        "data": _build_cache_admin_payload(),
    })


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
        cache.delete_prefix("setting:")
        invalidate_nodes_cache()
        invalidate_users_cache()
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
    if not is_valid_backup_filename(filename):
        return jsonify({"code": 400, "msg": "非法文件名"}), 400

    target = os.path.join(BACKUP_DIR, filename)
    if not os.path.exists(target):
        return jsonify({"code": 404, "msg": "备份文件不存在"}), 404

    return send_file(target, as_attachment=True, download_name=filename)

@system_bp.route('/api/admin/backup/upload', methods=['POST'])
def admin_backup_upload():
    admin_user = request.form.get('admin_user')
    admin_pwd = request.form.get('admin_pwd')
    if not check_admin(admin_user, admin_pwd):
        return jsonify({"code": 403, "msg": "无权限"})

    if 'file' not in request.files:
        return jsonify({"code": 400, "msg": "未检测到上传文件"})

    uploaded_file = request.files['file']
    orig_name = (uploaded_file.filename or '').strip()
    if not orig_name:
        return jsonify({"code": 400, "msg": "文件名为空"})

    lower_name = orig_name.lower()
    if lower_name.endswith(".db") or lower_name.endswith(".sqlite"):
        ext = "db"
    elif lower_name.endswith(".json"):
        ext = "json"
    else:
        return jsonify({"code": 400, "msg": "仅支持上传 SQLite (.db/.sqlite) 或通用逻辑快照 (.json) 备份文件"})

    ensure_backup_dir()
    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_filename = f"xray_backup_{timestamp_str}_uploaded.{ext}"
    dest_path = os.path.join(BACKUP_DIR, safe_filename)

    try:
        uploaded_file.save(dest_path)
        if ext == "db":
            conn = sqlite3.connect(dest_path)
            cursor = conn.cursor()
            cursor.execute("PRAGMA quick_check;")
            res = cursor.fetchone()
            conn.close()
            if not res or res[0] != "ok":
                os.remove(dest_path)
                return jsonify({"code": 400, "msg": "上传的文件非合法或完整 SQLite 数据库文件"})
        else:
            with open(dest_path, "r", encoding="utf-8") as f:
                payload = json.load(f)
            tables = payload.get("tables") if isinstance(payload, dict) else None
            if not isinstance(tables, dict) or not isinstance(tables.get("users"), list) or not isinstance(tables.get("nodes"), list):
                os.remove(dest_path)
                return jsonify({"code": 400, "msg": "上传的 JSON 快照结构无效，缺少 users / nodes 核心表"})

        max_count = int(get_setting("backup_max_count", "7") or 7)
        prune_old_backups(max_keep=max_count)
        return jsonify({"code": 200, "msg": f"外部备份文件已成功导入: {safe_filename}，可直接在列表中点击一键还原！"})
    except Exception as e:
        if os.path.exists(dest_path):
            try:
                os.remove(dest_path)
            except Exception:
                pass
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