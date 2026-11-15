# -*- coding: utf-8 -*-
"""
双引擎数据库热备份与灾难恢复管理器：
- SQLite 模式：原生 sqlite3.Connection.backup() 零锁热备 (.db) + PRAGMA integrity_check
- MySQL 模式：SQLAlchemy 事务级全量逻辑快照导出与还原 (.json)
"""
import json
import logging
import os
import shutil
import sqlite3
from datetime import datetime

from sqlalchemy import delete, select

from config import Config
from core.db import current_dialect, db_session
from core.models import AuditLog, Card, Node, NotifyLog, SystemSetting, User

logger = logging.getLogger("xray_web.backup_manager")

BACKUP_DIR = os.getenv("BACKUP_DIR", "/data/backups")
VALID_BACKUP_EXTS = (".db", ".json")


def ensure_backup_dir():
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
    except Exception as e:
        logger.error(f"[Backup] 创建备份目录失败 {BACKUP_DIR}: {e}")


def get_human_size(size_bytes: int) -> str:
    for unit in ["B", "KB", "MB", "GB"]:
        if size_bytes < 1024.0:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024.0
    return f"{size_bytes:.1f} TB"


def is_valid_backup_filename(filename: str) -> bool:
    safe_name = os.path.basename(filename or "")
    return (
        bool(safe_name)
        and safe_name == filename
        and safe_name.startswith("xray_backup_")
        and safe_name.endswith(VALID_BACKUP_EXTS)
    )


def list_backups() -> list[dict]:
    ensure_backup_dir()
    backups = []
    if not os.path.exists(BACKUP_DIR):
        return backups

    try:
        for fname in os.listdir(BACKUP_DIR):
            if fname.startswith("xray_backup_") and fname.endswith(VALID_BACKUP_EXTS):
                fpath = os.path.join(BACKUP_DIR, fname)
                if os.path.isfile(fpath):
                    stat = os.stat(fpath)
                    created_dt = datetime.fromtimestamp(stat.st_mtime)
                    backups.append({
                        "filename": fname,
                        "format": "json" if fname.endswith(".json") else "sqlite",
                        "size_bytes": stat.st_size,
                        "size_human": get_human_size(stat.st_size),
                        "created_at": created_dt.strftime("%Y-%m-%d %H:%M:%S"),
                        "timestamp": stat.st_mtime,
                    })
    except Exception as e:
        logger.error(f"[Backup] 列出备份文件失败: {e}")

    backups.sort(key=lambda x: x["timestamp"], reverse=True)
    return backups


def prune_old_backups(max_keep: int = 7) -> int:
    if max_keep <= 0:
        max_keep = 1
    backups = list_backups()
    deleted_count = 0
    if len(backups) > max_keep:
        for item in backups[max_keep:]:
            try:
                target = os.path.join(BACKUP_DIR, item["filename"])
                if os.path.exists(target):
                    os.remove(target)
                    deleted_count += 1
                    logger.info(f"[Backup] 轮转清理旧备份: {item['filename']}")
            except Exception as e:
                logger.error(f"[Backup] 清理旧备份文件失败 {item['filename']}: {e}")
    return deleted_count


def _export_logical_snapshot(dest_path: str):
    """通过 SQLAlchemy 导出全表 JSON 逻辑快照（兼容 MySQL 与 SQLite）"""
    with db_session() as s:
        payload = {
            "version": 2,
            "dialect": current_dialect(),
            "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "tables": {
                "users": [r.to_dict() for r in s.scalars(select(User).order_by(User.id.asc())).all()],
                "nodes": [r.to_dict() for r in s.scalars(select(Node).order_by(Node.id.asc())).all()],
                "cards": [r.to_dict() for r in s.scalars(select(Card)).all()],
                "system_settings": [r.to_dict() for r in s.scalars(select(SystemSetting)).all()],
                "notify_logs": [r.to_dict() for r in s.scalars(select(NotifyLog).order_by(NotifyLog.id.asc())).all()],
                "audit_logs": [r.to_dict() for r in s.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(2000)).all()],
            },
        }
    with open(dest_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def _restore_logical_snapshot(snapshot_path: str) -> tuple[bool, str]:
    try:
        with open(snapshot_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        tables = payload.get("tables")
        if not isinstance(tables, dict) or "users" not in tables or "nodes" not in tables:
            return False, "JSON 快照结构无效，缺少核心业务表"
    except Exception as e:
        return False, f"JSON 快照解析失败: {e}"

    model_map = [
        ("users", User),
        ("nodes", Node),
        ("cards", Card),
        ("system_settings", SystemSetting),
        ("notify_logs", NotifyLog),
        ("audit_logs", AuditLog),
    ]

    try:
        with db_session() as s:
            for table_key, model_cls in model_map:
                s.execute(delete(model_cls))
                valid_cols = {c.name for c in model_cls.__table__.columns}
                rows = tables.get(table_key) or []
                for row_dict in rows:
                    clean_data = {k: v for k, v in row_dict.items() if k in valid_cols}
                    if "created_at" in clean_data and isinstance(clean_data["created_at"], str):
                        try:
                            clean_data["created_at"] = datetime.strptime(clean_data["created_at"], "%Y-%m-%d %H:%M:%S")
                        except Exception:
                            clean_data.pop("created_at", None)
                    s.add(model_cls(**clean_data))
        return True, f"逻辑快照已成功恢复 ({os.path.basename(snapshot_path)})"
    except Exception as e:
        return False, f"恢复逻辑快照失败（事务已回滚）: {e}"


def create_database_backup(tag: str = "manual") -> tuple[bool, str, dict]:
    ensure_backup_dir()
    dialect = current_dialect()
    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")

    if dialect == "mysql":
        backup_filename = f"xray_backup_{timestamp_str}_{tag}.json"
        dest_path = os.path.join(BACKUP_DIR, backup_filename)
        try:
            _export_logical_snapshot(dest_path)
            stat = os.stat(dest_path)
            info = {
                "filename": backup_filename,
                "format": "json",
                "size_bytes": stat.st_size,
                "size_human": get_human_size(stat.st_size),
                "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "timestamp": stat.st_mtime,
                "tag": tag,
            }
            return True, f"逻辑热备份创建成功: {backup_filename}", info
        except Exception as e:
            if os.path.exists(dest_path):
                try:
                    os.remove(dest_path)
                except Exception:
                    pass
            return False, f"MySQL 逻辑备份异常: {e}", {}

    # SQLite 模式：原生无锁 online backup API
    db_path = Config.DB_PATH
    if not os.path.exists(db_path):
        return False, f"源数据库文件不存在: {db_path}", {}

    backup_filename = f"xray_backup_{timestamp_str}_{tag}.db"
    dest_path = os.path.join(BACKUP_DIR, backup_filename)

    source_conn = None
    dest_conn = None
    try:
        source_conn = sqlite3.connect(db_path, timeout=30.0)
        dest_conn = sqlite3.connect(dest_path)
        source_conn.backup(dest_conn)
        dest_conn.commit()
        dest_conn.close()
        dest_conn = None
        source_conn.close()
        source_conn = None

        if os.path.exists(dest_path):
            stat = os.stat(dest_path)
            info = {
                "filename": backup_filename,
                "format": "sqlite",
                "size_bytes": stat.st_size,
                "size_human": get_human_size(stat.st_size),
                "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "timestamp": stat.st_mtime,
                "tag": tag,
            }
            logger.info(f"[Backup] SQLite 热备份成功: {backup_filename} ({info['size_human']})")
            return True, f"备份创建成功: {backup_filename}", info
        return False, "备份写入完成但未找到目标文件", {}
    except Exception as e:
        logger.error(f"[Backup] 备份执行异常: {e}", exc_info=True)
        for conn_obj in (dest_conn, source_conn):
            if conn_obj:
                try:
                    conn_obj.close()
                except Exception:
                    pass
        if os.path.exists(dest_path):
            try:
                os.remove(dest_path)
            except Exception:
                pass
        return False, f"备份异常: {str(e)}", {}


def restore_database_from_backup(filename: str) -> tuple[bool, str]:
    ensure_backup_dir()
    if not is_valid_backup_filename(filename):
        return False, "非法备份文件名"

    backup_filepath = os.path.join(BACKUP_DIR, filename)
    if not os.path.exists(backup_filepath):
        return False, f"备份快照不存在: {filename}"

    if filename.endswith(".json"):
        return _restore_logical_snapshot(backup_filepath)

    if current_dialect() != "sqlite":
        return False, "当前运行在 MySQL 模式下，请上传或选择 .json 逻辑快照文件进行恢复"

    db_path = Config.DB_PATH
    try:
        test_conn = sqlite3.connect(backup_filepath)
        cursor = test_conn.cursor()
        cursor.execute("PRAGMA quick_check;")
        check_res = cursor.fetchone()
        test_conn.close()
        if not check_res or check_res[0] != "ok":
            return False, f"备份快照损坏，未通过 SQLite 完整性检查: {check_res}"
    except Exception as e:
        return False, f"备份快照校验失败: {e}"

    safety_bak_path = db_path + ".pre_restore_safety_bak"
    try:
        if os.path.exists(db_path):
            shutil.copy2(db_path, safety_bak_path)
    except Exception as e:
        logger.warning(f"[Backup] 制作还原前安全防错备份失败: {e}")

    try:
        shutil.copy2(backup_filepath, db_path)
        for ext in ["-wal", "-shm"]:
            wal_file = db_path + ext
            if os.path.exists(wal_file):
                try:
                    os.remove(wal_file)
                except Exception:
                    pass

        verify_conn = sqlite3.connect(db_path)
        v_cursor = verify_conn.cursor()
        v_cursor.execute("PRAGMA integrity_check;")
        v_res = v_cursor.fetchone()
        verify_conn.close()

        if v_res and v_res[0] == "ok":
            logger.info(f"[Backup] 数据库成功还原至快照: {filename}")
            return True, f"数据库已成功安全恢复至快照: {filename}"
        if os.path.exists(safety_bak_path):
            shutil.copy2(safety_bak_path, db_path)
        return False, f"恢复后完整性检查未通过 ({v_res})，已自动回滚原数据库！"
    except Exception as e:
        logger.error(f"[Backup] 还原数据库发生致命错误: {e}", exc_info=True)
        if os.path.exists(safety_bak_path):
            try:
                shutil.copy2(safety_bak_path, db_path)
            except Exception:
                pass
        return False, f"还原发生错误: {str(e)}"


def delete_backup_file(filename: str) -> tuple[bool, str]:
    ensure_backup_dir()
    if not is_valid_backup_filename(filename):
        return False, "非法备份文件名"

    target_path = os.path.join(BACKUP_DIR, filename)
    if not os.path.exists(target_path):
        return False, "目标备份文件不存在"

    try:
        os.remove(target_path)
        logger.info(f"[Backup] 已删除备份文件: {filename}")
        return True, "备份文件已成功删除"
    except Exception as e:
        logger.error(f"[Backup] 删除备份文件失败 {filename}: {e}")
        return False, f"删除备份文件失败: {str(e)}"
