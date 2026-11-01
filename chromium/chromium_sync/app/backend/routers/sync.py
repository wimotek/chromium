import json
import sqlite3
from typing import Optional, List
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from core.config import DB_PATH
from core.database import get_setting, set_setting
from core.security import verify_token
from services.sync_service import reschedule_sync_job, execute_sync_task

router = APIRouter(tags=["同步中心"])

class TriggerSyncDTO(BaseModel):
    source_id: Optional[int] = None
    target_ids: Optional[List[int]] = None

@router.get("/api/sync/settings")
def get_sync_settings(user: dict = Depends(verify_token)):
    return {
        "sync_interval_minutes": int(get_setting("sync_interval_minutes", "15")),
        "sync_mode": get_setting("sync_mode", "smart_merge"),
        "sync_source_id": int(get_setting("sync_source_id", "0")),
        "sync_target_ids": json.loads(get_setting("sync_target_ids", "[]")),
        "sync_diff_enabled": get_setting("sync_diff_enabled", "1") == "1",
        "sync_include_domains": get_setting("sync_include_domains", ""),
        "sync_exclude_domains": get_setting("sync_exclude_domains", "doubleclick.net,google-analytics.com")
    }

@router.post("/api/sync/settings")
def save_sync_settings(data: dict, user: dict = Depends(verify_token)):
    if "sync_interval_minutes" in data:
        mins = int(data["sync_interval_minutes"])
        set_setting("sync_interval_minutes", str(mins))
        reschedule_sync_job(mins)
    if "sync_mode" in data:
        set_setting("sync_mode", data["sync_mode"])
    if "sync_source_id" in data:
        set_setting("sync_source_id", str(data["sync_source_id"]))
    if "sync_target_ids" in data:
        set_setting("sync_target_ids", json.dumps(data["sync_target_ids"]))
    if "sync_diff_enabled" in data:
        set_setting("sync_diff_enabled", "1" if data["sync_diff_enabled"] else "0")
    if "sync_include_domains" in data:
        set_setting("sync_include_domains", data["sync_include_domains"].strip())
    if "sync_exclude_domains" in data:
        set_setting("sync_exclude_domains", data["sync_exclude_domains"].strip())
    return {"message": "同步策略配置已生效"}

@router.get("/api/cookie-policy")
def get_cookie_policy(user: dict = Depends(verify_token)):
    return {
        "sync_diff_enabled": get_setting("sync_diff_enabled", "1") == "1",
        "sync_include_domains": get_setting("sync_include_domains", ""),
        "sync_exclude_domains": get_setting("sync_exclude_domains", "doubleclick.net,google-analytics.com")
    }

@router.post("/api/cookie-policy")
def save_cookie_policy(data: dict, user: dict = Depends(verify_token)):
    if "sync_diff_enabled" in data:
        set_setting("sync_diff_enabled", "1" if data["sync_diff_enabled"] else "0")
    if "sync_include_domains" in data:
        set_setting("sync_include_domains", data["sync_include_domains"].strip())
    if "sync_exclude_domains" in data:
        set_setting("sync_exclude_domains", data["sync_exclude_domains"].strip())
    return {"message": "全局 Cookie 过滤与差量同步策略已保存"}

@router.post("/api/sync/trigger")
async def trigger_sync(data: TriggerSyncDTO = TriggerSyncDTO(), user: dict = Depends(verify_token)):
    await execute_sync_task(custom_source_id=data.source_id, custom_target_ids=data.target_ids)
    return {"message": "同步任务指令已下发执行"}

# 结构化审计日志接口 (获取最新的 20 条记录)
@router.get("/api/sync/logs")
def get_logs(user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("""
        SELECT id, timestamp, source_node, target_nodes, cookie_count, duration, status, details 
        FROM sync_logs 
        ORDER BY id DESC LIMIT 20
    """)
    logs = [dict(r) for r in cur.fetchall()]
    conn.close()
    return logs

# 手动清空所有审计流水记录接口
@router.delete("/api/sync/logs")
def clear_all_sync_logs(user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("DELETE FROM sync_logs")
    conn.commit()
    conn.close()
    return {"message": "所有同步审计流水记录已彻底清空"}