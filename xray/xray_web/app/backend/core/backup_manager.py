import os
import time
import shutil
import sqlite3
import logging
from datetime import datetime
from ..config import Config

logger = logging.getLogger("xray_web.backup_manager")

BACKUP_DIR = os.getenv("BACKUP_DIR", "/data/backups")

def ensure_backup_dir():
    """保证备份目录存在并具备写权限"""
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
    except Exception as e:
        logger.error(f"[Backup] 创建备份目录失败 {BACKUP_DIR}: {e}")

def get_human_size(size_bytes: int) -> str:
    """人类可读的文件大小格式化"""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size_bytes < 1024.0:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024.0
    return f"{size_bytes:.1f} TB"

def list_backups() -> list[dict]:
    """获取所有历史备份列表，按创建时间倒序排列"""
    ensure_backup_dir()
    backups = []
    if not os.path.exists(BACKUP_DIR):
        return backups

    try:
        for fname in os.listdir(BACKUP_DIR):
            if fname.startswith("xray_backup_") and fname.endswith(".db"):
                fpath = os.path.join(BACKUP_DIR, fname)
                if os.path.isfile(fpath):
                    stat = os.stat(fpath)
                    created_dt = datetime.fromtimestamp(stat.st_mtime)
                    backups.append({
                        "filename": fname,
                        "size_bytes": stat.st_size,
                        "size_human": get_human_size(stat.st_size),
                        "created_at": created_dt.strftime("%Y-%m-%d %H:%M:%S"),
                        "timestamp": stat.st_mtime
                    })
    except Exception as e:
        logger.error(f"[Backup] 列出备份文件失败: {e}")

    # 按时间戳倒序
    backups.sort(key=lambda x: x["timestamp"], reverse=True)
    return backups

def prune_old_backups(max_keep: int = 7) -> int:
    """
    限定备份数量，删除超出配额的最旧备份
    :param max_keep: 最多保留的数量 (例如 7 份)
    :return: 实际清理的文件数量
    """
    if max_keep <= 0:
        max_keep = 1
    backups = list_backups()
    deleted_count = 0
    if len(backups) > max_keep:
        excess = backups[max_keep:]
        for item in excess:
            try:
                target = os.path.join(BACKUP_DIR, item["filename"])
                if os.path.exists(target):
                    os.remove(target)
                    deleted_count += 1
                    logger.info(f"[Backup] 轮转清理旧备份: {item['filename']}")
            except Exception as e:
                logger.error(f"[Backup] 清理旧备份文件失败 {item['filename']}: {e}")
    return deleted_count

def create_database_backup(tag: str = "manual") -> tuple[bool, str, dict]:
    """
    创建数据库热备份 (利用 SQLite WAL 原生 online backup API，完全无锁且原子安全)
    :param tag: 备份标记 (manual 或 auto)
    :return: (success: bool, msg: str, backup_info: dict)
    """
    ensure_backup_dir()
    db_path = Config.DB_PATH
    if not os.path.exists(db_path):
        return False, f"源数据库文件不存在: {db_path}", {}

    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_filename = f"xray_backup_{timestamp_str}_{tag}.db"
    dest_path = os.path.join(BACKUP_DIR, backup_filename)

    source_conn = None
    dest_conn = None
    try:
        source_conn = sqlite3.connect(db_path, timeout=30.0)
        dest_conn = sqlite3.connect(dest_path)
        
        # 使用 SQLite 内置原子热备份
        source_conn.backup(dest_conn)
        dest_conn.commit()
        dest_conn.close()
        dest_conn = None
        source_conn.close()
        source_conn = None

        # 检查生成的目标文件
        if os.path.exists(dest_path):
            stat = os.stat(dest_path)
            info = {
                "filename": backup_filename,
                "size_bytes": stat.st_size,
                "size_human": get_human_size(stat.st_size),
                "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "timestamp": stat.st_mtime,
                "tag": tag
            }
            logger.info(f"[Backup] 数据库热备份成功完成: {backup_filename} ({info['size_human']})")
            return True, f"备份创建成功: {backup_filename}", info
        else:
            return False, "备份写入完成但未找到目标文件", {}
    except Exception as e:
        logger.error(f"[Backup] 备份执行异常: {e}", exc_info=True)
        if dest_conn:
            try:
                dest_conn.close()
            except Exception:
                pass
        if source_conn:
            try:
                source_conn.close()
            except Exception:
                pass
        if os.path.exists(dest_path):
            try:
                os.remove(dest_path)
            except Exception:
                pass
        return False, f"备份异常: {str(e)}", {}

def restore_database_from_backup(filename: str) -> tuple[bool, str]:
    """
    从指定备份快照安全恢复数据库：
    1. 验证目标备份快照存在并进行 SQLite PRAGMA quick_check 校验
    2. 创建当前运行数据库的紧急安全回滚快照 (.pre_restore_safety_bak)
    3. 复制目标快照至当前数据库并清理陈旧 -wal / -shm 临时文件
    4. 校验新数据库完整性
    """
    ensure_backup_dir()
    db_path = Config.DB_PATH
    
    # 严格过滤文件名防止路径穿越
    safe_name = os.path.basename(filename)
    if safe_name != filename or not (safe_name.startswith("xray_backup_") and safe_name.endswith(".db")):
        return False, "非法备份文件名"

    backup_filepath = os.path.join(BACKUP_DIR, safe_name)
    if not os.path.exists(backup_filepath):
        return False, f"备份快照不存在: {safe_name}"

    # 先验证备份文件是否是合法的 SQLite 数据库
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

    # 制作当前数据库的防错冷备
    safety_bak_path = db_path + ".pre_restore_safety_bak"
    try:
        if os.path.exists(db_path):
            shutil.copy2(db_path, safety_bak_path)
    except Exception as e:
        logger.warning(f"[Backup] 制作还原前安全防错备份失败 (继续尝试还原): {e}")

    try:
        # 覆盖主数据库
        shutil.copy2(backup_filepath, db_path)
        
        # 彻底移除可能残留的旧 WAL 和 SHM 页面，使 SQLite 干净加载
        for ext in ["-wal", "-shm"]:
            wal_file = db_path + ext
            if os.path.exists(wal_file):
                try:
                    os.remove(wal_file)
                except Exception as e:
                    logger.warning(f"[Backup] 清理残留临时文件 {wal_file} 失败: {e}")

        # 验证新替换的数据库
        verify_conn = sqlite3.connect(db_path)
        v_cursor = verify_conn.cursor()
        v_cursor.execute("PRAGMA integrity_check;")
        v_res = v_cursor.fetchone()
        verify_conn.close()

        if v_res and v_res[0] == "ok":
            logger.info(f"[Backup] 数据库成功还原至快照: {safe_name}")
            return True, f"数据库已成功安全恢复至快照: {safe_name}"
        else:
            # 完整性校验失败，回滚
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
    """安全删除指定备份文件"""
    ensure_backup_dir()
    safe_name = os.path.basename(filename)
    if safe_name != filename or not (safe_name.startswith("xray_backup_") and safe_name.endswith(".db")):
        return False, "非法备份文件名"

    target_path = os.path.join(BACKUP_DIR, safe_name)
    if not os.path.exists(target_path):
        return False, "目标备份文件不存在"

    try:
        os.remove(target_path)
        logger.info(f"[Backup] 已删除备份文件: {safe_name}")
        return True, "备份文件已成功删除"
    except Exception as e:
        logger.error(f"[Backup] 删除备份文件失败 {safe_name}: {e}")
        return False, f"删除备份文件失败: {str(e)}"
