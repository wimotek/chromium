import json
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException

from core.db import get_setting, session_scope, set_setting
from core.models import SyncLog, SyncPolicy
from core.security import verify_token
from services.sync_service import (
    execute_global_cleanup,
    execute_policy_task,
    reschedule_all_policies,
)

router = APIRouter(tags=["同步中心与多策略"])


# 策略列表查询
@router.get("/api/sync/policies")
def list_policies(user: dict = Depends(verify_token)):
    with session_scope() as db:
        return [p.to_dict() for p in db.query(SyncPolicy).order_by(SyncPolicy.id.desc()).all()]


# 添加新策略
@router.post("/api/sync/policies")
def create_policy(data: dict, user: dict = Depends(verify_token)):
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with session_scope() as db:
        db.add(
            SyncPolicy(
                name=data["name"],
                enabled=1 if data.get("enabled", True) else 0,
                interval_minutes=int(data.get("interval_minutes", 15)),
                sync_type=data.get("sync_type", "smart_merge"),
                source_type=data.get("source_type", "node"),
                source_id=int(data.get("source_id", 0)),
                source_group=data.get("source_group", ""),
                target_type=data.get("target_type", "all"),
                target_ids=json.dumps(data.get("target_ids", [])),
                target_group=data.get("target_group", ""),
                created_at=now_str,
            )
        )
    reschedule_all_policies()
    return {"message": "同步调度策略添加成功"}


# 修改策略
@router.put("/api/sync/policies/{policy_id}")
def update_policy(policy_id: int, data: dict, user: dict = Depends(verify_token)):
    with session_scope() as db:
        policy = db.get(SyncPolicy, policy_id)
        if policy is None:
            raise HTTPException(status_code=404, detail="策略不存在")
        policy.name = data["name"]
        policy.enabled = 1 if data.get("enabled", True) else 0
        policy.interval_minutes = int(data.get("interval_minutes", 15))
        policy.sync_type = data.get("sync_type", "smart_merge")
        policy.source_type = data.get("source_type", "node")
        policy.source_id = int(data.get("source_id", 0))
        policy.source_group = data.get("source_group", "")
        policy.target_type = data.get("target_type", "all")
        policy.target_ids = json.dumps(data.get("target_ids", []))
        policy.target_group = data.get("target_group", "")
    reschedule_all_policies()
    return {"message": "策略配置修改已生效"}


# 删除策略 (核心防护：仅剩 1 条时强制禁止删除)
@router.delete("/api/sync/policies/{policy_id}")
def delete_policy(policy_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        count = db.query(SyncPolicy).count()
        if count <= 1:
            raise HTTPException(status_code=400, detail="系统必须保留至少一条调度策略，无法全部删除")
        db.query(SyncPolicy).filter(SyncPolicy.id == policy_id).delete(synchronize_session=False)
    reschedule_all_policies()
    return {"message": "策略已删除"}


# 启用/停用策略开关
@router.post("/api/sync/policies/{policy_id}/toggle")
def toggle_policy(policy_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        policy = db.get(SyncPolicy, policy_id)
        if not policy:
            raise HTTPException(status_code=404, detail="策略不存在")
        new_status = 0 if policy.enabled == 1 else 1
        policy.enabled = new_status
    reschedule_all_policies()
    return {"message": "策略状态已更新", "enabled": new_status}


# 立即执行指定策略
@router.post("/api/sync/policies/{policy_id}/run")
async def run_policy_immediately(policy_id: int, user: dict = Depends(verify_token)):
    await execute_policy_task(policy_id)
    return {"message": "该策略已完成即时同步"}


# 全局 Cookie 过滤与删除清理策略 (白名单/黑名单/差量检测/删除清理)
@router.get("/api/cookie-policy")
def get_cookie_policy(user: dict = Depends(verify_token)):
    try:
        within_days = max(0, int(get_setting("sync_cleanup_expiring_within_days", "0") or 0))
    except Exception:
        within_days = 0
    return {
        "sync_diff_enabled": get_setting("sync_diff_enabled", "1") == "1",
        "sync_include_domains": get_setting("sync_include_domains", ""),
        "sync_exclude_domains": get_setting("sync_exclude_domains", "doubleclick.net,google-analytics.com"),
        "sync_cleanup_enabled": get_setting("sync_cleanup_enabled", "0") == "1",
        "sync_cleanup_expired": get_setting("sync_cleanup_expired", "1") == "1",
        "sync_cleanup_domains": get_setting("sync_cleanup_domains", ""),
        "sync_cleanup_keywords": get_setting("sync_cleanup_keywords", ""),
        "sync_cleanup_keyword_scope": get_setting("sync_cleanup_keyword_scope", "name_domain") or "name_domain",
        "sync_cleanup_expires_before": get_setting("sync_cleanup_expires_before", ""),
        "sync_cleanup_expiring_within_days": within_days,
        "sync_cleanup_session_only": get_setting("sync_cleanup_session_only", "0") == "1",
    }


@router.post("/api/cookie-policy")
def save_cookie_policy(data: dict, user: dict = Depends(verify_token)):
    if "sync_diff_enabled" in data:
        set_setting("sync_diff_enabled", "1" if data["sync_diff_enabled"] else "0")
    if "sync_include_domains" in data:
        set_setting("sync_include_domains", str(data["sync_include_domains"]).strip())
    if "sync_exclude_domains" in data:
        set_setting("sync_exclude_domains", str(data["sync_exclude_domains"]).strip())
    if "sync_cleanup_enabled" in data:
        set_setting("sync_cleanup_enabled", "1" if data["sync_cleanup_enabled"] else "0")
    if "sync_cleanup_expired" in data:
        set_setting("sync_cleanup_expired", "1" if data["sync_cleanup_expired"] else "0")
    if "sync_cleanup_domains" in data:
        set_setting("sync_cleanup_domains", str(data["sync_cleanup_domains"]).strip())
    if "sync_cleanup_keywords" in data:
        set_setting("sync_cleanup_keywords", str(data["sync_cleanup_keywords"]).strip())
    if "sync_cleanup_keyword_scope" in data:
        scope = str(data["sync_cleanup_keyword_scope"]).strip()
        if scope not in ("name", "name_domain", "all"):
            scope = "name_domain"
        set_setting("sync_cleanup_keyword_scope", scope)
    if "sync_cleanup_expires_before" in data:
        set_setting("sync_cleanup_expires_before", str(data["sync_cleanup_expires_before"]).strip())
    if "sync_cleanup_expiring_within_days" in data:
        try:
            days_val = max(0, int(data["sync_cleanup_expiring_within_days"] or 0))
        except Exception:
            days_val = 0
        set_setting("sync_cleanup_expiring_within_days", str(days_val))
    if "sync_cleanup_session_only" in data:
        set_setting("sync_cleanup_session_only", "1" if data["sync_cleanup_session_only"] else "0")
    return {"message": "全局 Cookie 过滤、删除清理与差量同步策略已保存"}


@router.post("/api/cookie-policy/cleanup-now")
async def trigger_global_cookie_cleanup(data: dict, user: dict = Depends(verify_token)):
    dry_run = bool(data.get("dry_run", False))
    override_rules = None
    if any(k.startswith("sync_cleanup_") for k in data.keys()):
        try:
            within_days = max(0, int(data.get("sync_cleanup_expiring_within_days") or 0))
        except Exception:
            within_days = 0
        scope = str(data.get("sync_cleanup_keyword_scope") or "name_domain")
        if scope not in ("name", "name_domain", "all"):
            scope = "name_domain"
        override_rules = {
            "enabled": True,
            "expired": bool(data.get("sync_cleanup_expired", True)),
            "domains": str(data.get("sync_cleanup_domains") or ""),
            "keywords": str(data.get("sync_cleanup_keywords") or ""),
            "keyword_scope": scope,
            "expires_before": str(data.get("sync_cleanup_expires_before") or ""),
            "expiring_within_days": within_days,
            "session_only": bool(data.get("sync_cleanup_session_only", False)),
        }
    return await execute_global_cleanup(dry_run=dry_run, override_rules=override_rules)


# 结构化审计流水：严格显示最近 20 条
@router.get("/api/sync/logs")
def get_logs(user: dict = Depends(verify_token)):
    with session_scope() as db:
        return [l.to_dict() for l in db.query(SyncLog).order_by(SyncLog.id.desc()).limit(20).all()]


# 手动清空全部审计流水
@router.delete("/api/sync/logs")
def clear_all_sync_logs(user: dict = Depends(verify_token)):
    with session_scope() as db:
        db.query(SyncLog).delete(synchronize_session=False)
    return {"message": "所有同步审计流水记录已彻底清空"}