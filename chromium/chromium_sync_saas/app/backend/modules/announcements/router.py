from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from core.db import session_scope
from core.models import Announcement
from core.rate_limit import get_client_ip
from core.security import require_admin, verify_token
from modules.audit.service import write_audit_log

router = APIRouter(tags=["平台系统公告中心"])


class AnnouncementDTO(BaseModel):
    title: str
    content: str
    level: str = "info"
    is_pinned: bool = False
    is_active: bool = True
    show_on_auth: bool = True


@router.get("/api/announcements/public", summary="获取登录/注册页公开系统公告")
def list_public_announcements():
    with session_scope() as db:
        rows = (
            db.query(Announcement)
            .filter(Announcement.is_active == 1, Announcement.show_on_auth == 1)
            .order_by(Announcement.is_pinned.desc(), Announcement.id.desc())
            .limit(10)
            .all()
        )
        return {"announcements": [r.to_dict() for r in rows]}


@router.get("/api/announcements", summary="获取工作台生效中的系统公告")
def list_active_announcements(user: dict = Depends(verify_token)):
    with session_scope() as db:
        rows = (
            db.query(Announcement)
            .filter(Announcement.is_active == 1)
            .order_by(Announcement.is_pinned.desc(), Announcement.id.desc())
            .limit(20)
            .all()
        )
        return {"announcements": [r.to_dict() for r in rows]}


@router.get("/api/admin/announcements", summary="管理员查看全部系统公告")
def admin_list_announcements(admin: dict = Depends(require_admin)):
    with session_scope() as db:
        rows = (
            db.query(Announcement)
            .order_by(Announcement.is_pinned.desc(), Announcement.id.desc())
            .limit(100)
            .all()
        )
        return {"announcements": [r.to_dict() for r in rows]}


@router.post("/api/admin/announcements", summary="管理员发布新系统公告")
def admin_create_announcement(data: AnnouncementDTO, request: Request, admin: dict = Depends(require_admin)):
    title = (data.title or "").strip()
    content = (data.content or "").strip()
    if not title or not content:
        raise HTTPException(status_code=400, detail="公告标题和正文不能为空")
    level = data.level if data.level in {"info", "success", "warn", "danger"} else "info"
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with session_scope() as db:
        row = Announcement(
            title=title[:200],
            content=content,
            level=level,
            is_pinned=1 if data.is_pinned else 0,
            is_active=1 if data.is_active else 0,
            show_on_auth=1 if data.show_on_auth else 0,
            author_username=admin["username"],
            created_at=now_str,
            updated_at=now_str,
        )
        db.add(row)
        db.flush()
        saved = row.to_dict()

    write_audit_log(
        action="admin_announcement_create",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="announcement",
        target_id=saved["id"],
        ip=get_client_ip(request),
        status="ok",
        details={"title": saved["title"], "level": level},
    )
    return {"message": "系统公告已发布", "announcement": saved}


@router.put("/api/admin/announcements/{ann_id}", summary="管理员更新系统公告")
def admin_update_announcement(ann_id: int, data: AnnouncementDTO, request: Request, admin: dict = Depends(require_admin)):
    title = (data.title or "").strip()
    content = (data.content or "").strip()
    if not title or not content:
        raise HTTPException(status_code=400, detail="公告标题和正文不能为空")
    level = data.level if data.level in {"info", "success", "warn", "danger"} else "info"
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with session_scope() as db:
        row = db.get(Announcement, int(ann_id))
        if row is None:
            raise HTTPException(status_code=404, detail="目标公告不存在")
        row.title = title[:200]
        row.content = content
        row.level = level
        row.is_pinned = 1 if data.is_pinned else 0
        row.is_active = 1 if data.is_active else 0
        row.show_on_auth = 1 if data.show_on_auth else 0
        row.updated_at = now_str
        db.flush()
        saved = row.to_dict()

    write_audit_log(
        action="admin_announcement_update",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="announcement",
        target_id=ann_id,
        ip=get_client_ip(request),
        status="ok",
        details={"title": saved["title"], "is_active": saved["is_active"]},
    )
    return {"message": "系统公告已更新", "announcement": saved}


@router.delete("/api/admin/announcements/{ann_id}", summary="管理员删除系统公告")
def admin_delete_announcement(ann_id: int, request: Request, admin: dict = Depends(require_admin)):
    with session_scope() as db:
        deleted = db.query(Announcement).filter(Announcement.id == int(ann_id)).delete(synchronize_session=False)
        if not deleted:
            raise HTTPException(status_code=404, detail="目标公告不存在")

    write_audit_log(
        action="admin_announcement_delete",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="announcement",
        target_id=ann_id,
        ip=get_client_ip(request),
        status="ok",
    )
    return {"message": "系统公告已删除"}
