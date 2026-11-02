import json
import sqlite3
from datetime import datetime
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from core.config import DB_PATH
from core.database import get_setting, set_setting
from core.security import verify_token
from services.sync_service import reschedule_all_policies, execute_policy_task

router = APIRouter(tags=["同步中心与多策略"])

# 策略列表查询
@router.get("/api/sync/policies")
def list_policies(user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM sync_policies ORDER BY id DESC")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

# 添加新策略
@router.post("/api/sync/policies")
def create_policy(data: dict, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cur.execute('''INSERT INTO sync_policies 
        (name, enabled, interval_minutes, sync_type, source_type, source_id, source_group, target_type, target_ids, target_group, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (
            data['name'], 1 if data.get('enabled', True) else 0,
            int(data.get('interval_minutes', 15)),
            data.get('sync_type', 'smart_merge'),
            data.get('source_type', 'node'),
            int(data.get('source_id', 0)),
            data.get('source_group', ''),
            data.get('target_type', 'all'),
            json.dumps(data.get('target_ids', [])),
            data.get('target_group', ''),
            now_str
        ))
    conn.commit()
    conn.close()
    reschedule_all_policies()
    return {"message": "同步调度策略添加成功"}

# 修改策略
@router.put("/api/sync/policies/{policy_id}")
def update_policy(policy_id: int, data: dict, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute('''UPDATE sync_policies SET 
        name=?, enabled=?, interval_minutes=?, sync_type=?, source_type=?, source_id=?, 
        source_group=?, target_type=?, target_ids=?, target_group=?
        WHERE id=?''',
        (
            data['name'], 1 if data.get('enabled', True) else 0,
            int(data.get('interval_minutes', 15)),
            data.get('sync_type', 'smart_merge'),
            data.get('source_type', 'node'),
            int(data.get('source_id', 0)),
            data.get('source_group', ''),
            data.get('target_type', 'all'),
            json.dumps(data.get('target_ids', [])),
            data.get('target_group', ''),
            policy_id
        ))
    conn.commit()
    conn.close()
    reschedule_all_policies()
    return {"message": "策略配置修改已生效"}

# 删除策略
@router.delete("/api/sync/policies/{policy_id}")
def delete_policy(policy_id: int, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("DELETE FROM sync_policies WHERE id=?", (policy_id,))
    conn.commit()
    conn.close()
    reschedule_all_policies()
    return {"message": "策略已删除"}

# 启用/停用策略开关
@router.post("/api/sync/policies/{policy_id}/toggle")
def toggle_policy(policy_id: int, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT enabled FROM sync_policies WHERE id=?", (policy_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="策略不存在")
    new_status = 0 if row["enabled"] == 1 else 1
    cur.execute("UPDATE sync_policies SET enabled=? WHERE id=?", (new_status, policy_id))
    conn.commit()
    conn.close()
    reschedule_all_policies()
    return {"message": "策略状态已更新", "enabled": new_status}

# 立即执行指定策略
@router.post("/api/sync/policies/{policy_id}/run")
async def run_policy_immediately(policy_id: int, user: dict = Depends(verify_token)):
    await execute_policy_task(policy_id)
    return {"message": "该策略已完成即时同步"}

# 全局 Cookie 过滤策略 (白名单/黑名单/差量检测)
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

# 结构化审计流水：严格显示最近 20 条
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

# 手动清空全部审计流水
@router.delete("/api/sync/logs")
def clear_all_sync_logs(user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("DELETE FROM sync_logs")
    conn.commit()
    conn.close()
    return {"message": "所有同步审计流水记录已彻底清空"}