from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.db import get_setting, set_setting
from core.security import require_admin
from services.notification import send_email_sync

router = APIRouter(tags=["SaaS 平台告警通知（Admin）"])


class TestEmailDTO(BaseModel):
    test_email: Optional[str] = None


@router.get("/api/notifications/settings")
def get_notification_settings(admin: dict = Depends(require_admin)):
    return {
        "smtp_host": get_setting("smtp_host", "smtp.yeah.net"),
        "smtp_port": get_setting("smtp_port", "465"),
        "smtp_ssl": get_setting("smtp_ssl", "1") == "1",
        "smtp_sender_name": get_setting("smtp_sender_name", "Wimotek SaaS Hub"),
        "smtp_user": get_setting("smtp_user"),
        "smtp_pass": "",
        "smtp_status": get_setting("smtp_status", "untested"),
        "email_notify_enabled": get_setting("email_notify_enabled", "0") == "1",
        "email_notify_to": get_setting("email_notify_to", ""),
        "serverchan_enabled": get_setting("serverchan_enabled", "0") == "1",
        "serverchan_key": get_setting("serverchan_key"),
    }


@router.post("/api/notifications/settings")
def save_notification_settings(data: dict, admin: dict = Depends(require_admin)):
    for k in ["smtp_host", "smtp_port", "smtp_sender_name", "smtp_user", "email_notify_to", "serverchan_key"]:
        if k in data:
            set_setting(k, str(data[k]).strip())
    if data.get("smtp_pass"):
        set_setting("smtp_pass", data["smtp_pass"].strip())
    if "smtp_ssl" in data:
        set_setting("smtp_ssl", "1" if data["smtp_ssl"] else "0")
    if "email_notify_enabled" in data:
        set_setting("email_notify_enabled", "1" if data["email_notify_enabled"] else "0")
    if "serverchan_enabled" in data:
        set_setting("serverchan_enabled", "1" if data["serverchan_enabled"] else "0")
    return {"message": "平台 SMTP 与告警通知设置已保存"}


@router.post("/api/notifications/test-email")
def test_email(data: TestEmailDTO, admin: dict = Depends(require_admin)):
    target = (data.test_email.strip() if data.test_email else "") or get_setting("email_notify_to") or get_setting("smtp_user")
    try:
        send_email_sync(target, "SaaS Hub 发信测试", "这是一封来自 Wimotek Chromium SaaS Hub 的平台测试邮件。")
        set_setting("smtp_status", "ready")
        return {"message": f"测试邮件已成功投递至: {target}", "smtp_status": "ready"}
    except Exception as exc:
        set_setting("smtp_status", f"error: {str(exc)[:30]}")
        raise HTTPException(status_code=500, detail=f"发信受阻: {exc}")
