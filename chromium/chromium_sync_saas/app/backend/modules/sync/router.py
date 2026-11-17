from datetime import datetime
import json

from fastapi import APIRouter, Depends, HTTPException, Request

from core.db import get_user_setting, session_scope, set_user_setting
from core.models import SyncLog, SyncPolicy
from core.rate_limit import get_client_ip
from core.security import verify_token
from modules.audit.service import write_audit_log
from modules.sync.service import (
    execute_global_cleanup,
    execute_policy_task,
    reschedule_all_policies,
)

router = APIRouter(tags=["数据同步（租户 Cookie 策略 · 清理 · 流水）"])


@router.get("/api/sync/policies", summary="查询当前租户的自有同步策略（严格隔离于共享出租节点）")
def list_policies(user: dict = Depends(verify_token)):
    uid = int(user["id"])
    with session_scope() as db:
        return [p.to_dict() for p in db.query(SyncPolicy).filter(SyncPolicy.owner_id == uid).order_by(SyncPolicy.id.desc()).all()]


@router.post("/api/sync/policies")
def create_policy(data: dict, request: Request, user: dict = Depends(verify_token)):
    uid = int(user["id"])
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with session_scope() as db:
        p = SyncPolicy(
            owner_id=uid,
            name=data["name"],
            enabled=1 if data.get("enabled", True) else 0,
            interval_minutes=max(1, int(data.get("interval_minutes", 15))),
            sync_type=data.get("sync_type", "smart_merge"),
            source_type=data.get("source_type", "node"),
            source_id=int(data.get("source_id", 0)),
            source_group=data.get("source_group", ""),
            target_type=data.get("target_type", "all"),
            target_ids=json.dumps(data.get("target_ids", [])),
            target_group=data.get("target_group", ""),
            created_at=now_str,
        )
        db.add(p)
        db.flush()
        pid = p.id
    reschedule_all_policies()
    write_audit_log(
        action="sync_policy_create",
        actor_id=uid,
        actor_username=user["username"],
        target_type="sync_policy",
        target_id=pid,
        ip=get_client_ip(request),
        status="ok",
        details={"name": data["name"], "sync_type": data.get("sync_type", "smart_merge")},
    )
    return {"message": "同步调度策略添加成功"}


@router.put("/api/sync/policies/{policy_id}")
def update_policy(policy_id: int, data: dict, user: dict = Depends(verify_token)):
    uid = int(user["id"])
    with session_scope() as db:
        policy = db.get(SyncPolicy, policy_id)
        if policy is None or int(policy.owner_id) != uid:
            raise HTTPException(status_code=404, detail="策略不存在或无权修改")
        policy.name = data["name"]
        policy.enabled = 1 if data.get("enabled", True) else 0
        policy.interval_minutes = max(1, int(data.get("interval_minutes", 15)))
        policy.sync_type = data.get("sync_type", "smart_merge")
        policy.source_type = data.get("source_type", "node")
        policy.source_id = int(data.get("source_id", 0))
        policy.source_group = data.get("source_group", "")
        policy.target_type = data.get("target_type", "all")
        policy.target_ids = json.dumps(data.get("target_ids", []))
        policy.target_group = data.get("target_group", "")
    reschedule_all_policies()
    return {"message": "策略配置修改已生效"}


@router.delete("/api/sync/policies/{policy_id}")
def delete_policy(policy_id: int, user: dict = Depends(verify_token)):
    uid = int(user["id"])
    with session_scope() as db:
        count = db.query(SyncPolicy).filter(SyncPolicy.owner_id == uid).count()
        if count <= 1:
            raise HTTPException(status_code=400, detail="每个租户至少保留一条同步策略，无法全部删除")
        deleted = db.query(SyncPolicy).filter(SyncPolicy.id == policy_id, SyncPolicy.owner_id == uid).delete(synchronize_session=False)
        if not deleted:
            raise HTTPException(status_code=404, detail="策略不存在")
    reschedule_all_policies()
    return {"message": "策略已删除"}


@router.post("/api/sync/policies/{policy_id}/toggle")
def toggle_policy(policy_id: int, user: dict = Depends(verify_token)):
    uid = int(user["id"])
    with session_scope() as db:
        policy = db.get(SyncPolicy, policy_id)
        if not policy or int(policy.owner_id) != uid:
            raise HTTPException(status_code=404, detail="策略不存在")
        new_status = 0 if policy.enabled == 1 else 1
        policy.enabled = new_status
    reschedule_all_policies()
    return {"message": "策略状态已更新", "enabled": new_status}


@router.post("/api/sync/policies/{policy_id}/run")
async def run_policy_immediately(policy_id: int, user: dict = Depends(verify_token)):
    uid = int(user["id"])
    with session_scope() as db:
        policy = db.get(SyncPolicy, policy_id)
        if not policy or int(policy.owner_id) != uid:
            raise HTTPException(status_code=404, detail="策略不存在")
    await execute_policy_task(policy_id, owner_id_guard=uid)
    return {"message": "该策略已完成本租户自有空闲节点同步（出租中节点已自动隔离豁免）"}


@router.get("/api/cookie-policy")
def get_cookie_policy(user: dict = Depends(verify_token)):
    uid = int(user["id"])
    try:
        within_days = max(0, int(get_user_setting(uid, "sync_cleanup_expiring_within_days", "0") or 0))
    except Exception:
        within_days = 0
    return {
        "sync_diff_enabled": get_user_setting(uid, "sync_diff_enabled", "1") == "1",
        "sync_include_domains": get_user_setting(uid, "sync_include_domains", ""),
        "sync_exclude_domains": get_user_setting(uid, "sync_exclude_domains", "doubleclick.net,google-analytics.com"),
        "sync_cleanup_enabled": get_user_setting(uid, "sync_cleanup_enabled", "0") == "1",
        "sync_cleanup_expired": get_user_setting(uid, "sync_cleanup_expired", "1") == "1",
        "sync_cleanup_domains": get_user_setting(uid, "sync_cleanup_domains", ""),
        "sync_cleanup_keywords": get_user_setting(uid, "sync_cleanup_keywords", ""),
        "sync_cleanup_keyword_scope": get_user_setting(uid, "sync_cleanup_keyword_scope", "name_domain") or "name_domain",
        "sync_cleanup_expires_before": get_user_setting(uid, "sync_cleanup_expires_before", ""),
        "sync_cleanup_expiring_within_days": within_days,
        "sync_cleanup_session_only": get_user_setting(uid, "sync_cleanup_session_only", "0") == "1",
    }


@router.post("/api/cookie-policy")
def save_cookie_policy(data: dict, user: dict = Depends(verify_token)):
    uid = int(user["id"])
    if "sync_diff_enabled" in data:
        set_user_setting(uid, "sync_diff_enabled", "1" if data["sync_diff_enabled"] else "0")
    if "sync_include_domains" in data:
        set_user_setting(uid, "sync_include_domains", str(data["sync_include_domains"]).strip())
    if "sync_exclude_domains" in data:
        set_user_setting(uid, "sync_exclude_domains", str(data["sync_exclude_domains"]).strip())
    if "sync_cleanup_enabled" in data:
        set_user_setting(uid, "sync_cleanup_enabled", "1" if data["sync_cleanup_enabled"] else "0")
    if "sync_cleanup_expired" in data:
        set_user_setting(uid, "sync_cleanup_expired", "1" if data["sync_cleanup_expired"] else "0")
    if "sync_cleanup_domains" in data:
        set_user_setting(uid, "sync_cleanup_domains", str(data["sync_cleanup_domains"]).strip())
    if "sync_cleanup_keywords" in data:
        set_user_setting(uid, "sync_cleanup_keywords", str(data["sync_cleanup_keywords"]).strip())
    if "sync_cleanup_keyword_scope" in data:
        scope = str(data["sync_cleanup_keyword_scope"]).strip()
        set_user_setting(uid, "sync_cleanup_keyword_scope", scope if scope in ("name", "name_domain", "all") else "name_domain")
    if "sync_cleanup_expires_before" in data:
        set_user_setting(uid, "sync_cleanup_expires_before", str(data["sync_cleanup_expires_before"]).strip())
    if "sync_cleanup_expiring_within_days" in data:
        try:
            days_val = max(0, int(data["sync_cleanup_expiring_within_days"] or 0))
        except Exception:
            days_val = 0
        set_user_setting(uid, "sync_cleanup_expiring_within_days", str(days_val))
    if "sync_cleanup_session_only" in data:
        set_user_setting(uid, "sync_cleanup_session_only", "1" if data["sync_cleanup_session_only"] else "0")
    return {"message": "个人租户 Cookie 过滤、清理与差量同步策略已保存"}


@router.post("/api/cookie-policy/cleanup-now")
async def trigger_global_cookie_cleanup(data: dict, user: dict = Depends(verify_token)):
    uid = int(user["id"])
    dry_run = bool(data.get("dry_run", False))
    override_rules = None
    if any(k.startswith("sync_cleanup_") for k in data.keys()):
        try:
            within_days = max(0, int(data.get("sync_cleanup_expiring_within_days") or 0))
        except Exception:
            within_days = 0
        scope = str(data.get("sync_cleanup_keyword_scope") or "name_domain")
        override_rules = {
            "enabled": True,
            "expired": bool(data.get("sync_cleanup_expired", True)),
            "domains": str(data.get("sync_cleanup_domains") or ""),
            "keywords": str(data.get("sync_cleanup_keywords") or ""),
            "keyword_scope": scope if scope in ("name", "name_domain", "all") else "name_domain",
            "expires_before": str(data.get("sync_cleanup_expires_before") or ""),
            "expiring_within_days": within_days,
            "session_only": bool(data.get("sync_cleanup_session_only", False)),
        }
    return await execute_global_cleanup(owner_id=uid, dry_run=dry_run, override_rules=override_rules)


@router.get("/api/sync/logs")
def get_logs(user: dict = Depends(verify_token)):
    uid = int(user["id"])
    with session_scope() as db:
        return [l.to_dict() for l in db.query(SyncLog).filter(SyncLog.owner_id == uid).order_by(SyncLog.id.desc()).limit(20).all()]


@router.delete("/api/sync/logs")
def clear_all_sync_logs(user: dict = Depends(verify_token)):
    uid = int(user["id"])
    with session_scope() as db:
        db.query(SyncLog).filter(SyncLog.owner_id == uid).delete(synchronize_session=False)
    return {"message": "本租户同步执行流水已清空"}
