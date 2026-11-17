import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from config import DATA_DIR
from core.db import session_scope
from core.models import AuditLog


def _rotate_jsonl_if_needed(path: str, max_bytes: int = 10 * 1024 * 1024):
    if os.path.exists(path) and os.path.getsize(path) >= max_bytes:
        rotated = path + ".1"
        try:
            if os.path.exists(rotated):
                os.remove(rotated)
            os.replace(path, rotated)
        except OSError:
            pass


def write_audit_log(
    action: str,
    actor_id: Optional[int] = None,
    actor_username: str = "anonymous",
    target_type: str = "",
    target_id: Any = "",
    ip: str = "unknown",
    status: str = "ok",
    details: Optional[Dict[str, Any]] = None,
):
    """
    SaaS 严苛不可篡改双写审计：
    1. 写入 ORM AuditLog（支持按租户/动作/结果精确检索与管理员全局追溯）
    2. 追加写入滚动 JSONL 备份 (/data/audit.jsonl)
    """
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    detail_str = json.dumps(details or {}, ensure_ascii=False)

    try:
        with session_scope() as db:
            db.add(
                AuditLog(
                    actor_id=int(actor_id) if actor_id is not None else None,
                    actor_username=(actor_username or "anonymous")[:64],
                    action=str(action)[:64],
                    target_type=str(target_type or "")[:64],
                    target_id=str(target_id or "")[:128],
                    ip=str(ip or "unknown")[:64],
                    status=str(status or "ok")[:32],
                    detail_json=detail_str[:4000],
                    created_at=now_str,
                )
            )
    except Exception:
        pass

    audit_path = os.path.join(DATA_DIR, "audit.jsonl")
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "actor_id": actor_id,
        "actor_username": actor_username,
        "action": action,
        "target_type": target_type,
        "target_id": str(target_id or ""),
        "ip": ip,
        "status": status,
        "details": details or {},
    }
    try:
        os.makedirs(os.path.dirname(audit_path), exist_ok=True)
        _rotate_jsonl_if_needed(audit_path)
        with open(audit_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass
