import json
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response

from core.db import session_scope
from core.models import AuditLog

from core.security import verify_token

router = APIRouter(tags=["不可篡改严苛审计中心"])


@router.get("/api/audit/logs", summary="检索不可篡改多租户审计流水（管理员可查看全局，普通租户仅查看个人行为与拦截）")
def list_audit_logs(
    action: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(100, ge=10, le=500),
    user: dict = Depends(verify_token),
):
    with session_scope() as db:
        q = db.query(AuditLog)
        if user.get("role") != "admin":
            q = q.filter(AuditLog.actor_id == int(user["id"]))
        if action:
            q = q.filter(AuditLog.action == action.strip())
        if status:
            q = q.filter(AuditLog.status == status.strip())
        rows = [r.to_dict() for r in q.order_by(AuditLog.id.desc()).limit(limit).all()]

    for r in rows:
        try:
            r["details"] = json.loads(r.get("detail_json") or "{}")
        except Exception:
            r["details"] = {}
    return {"logs": rows, "scope": "global" if user.get("role") == "admin" else "tenant"}


@router.get("/api/audit/export", summary="导出 JSONL 格式审计档案用于合规归档")
def export_audit_logs(user: dict = Depends(verify_token)):
    with session_scope() as db:
        q = db.query(AuditLog)
        if user.get("role") != "admin":
            q = q.filter(AuditLog.actor_id == int(user["id"]))
        rows = [r.to_dict() for r in q.order_by(AuditLog.id.desc()).limit(2000).all()]

    lines = [json.dumps(r, ensure_ascii=False) for r in rows]
    return Response(
        content="\n".join(lines),
        media_type="application/x-ndjson",
        headers={"Content-Disposition": 'attachment; filename="saas-audit-logs.jsonl"'},
    )
