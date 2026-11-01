from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from core.database import get_setting, set_setting
from core.security import verify_token
from services.notification import send_email_notification, send_serverchan_notification

router = APIRouter(tags=["告警通知"])

class TestEmailDTO(BaseModel):
    test_email: Optional[str] = None

@router.get("/api/notifications/settings")
def get_notification_settings(user: dict = Depends(verify_token)):
    return {
        "smtp_host": get_setting("smtp_host", "smtp.yeah.net"),
        "smtp_port": get_setting("smtp_port", "465"),
        "smtp_ssl": get_setting("smtp_ssl", "1") == "1",
        "smtp_sender_name": get_setting("smtp_sender_name", "CDP 节点中心"),
        "smtp_user": get_setting("smtp_user"),
        "smtp_pass": "",
        "smtp_status": get_setting("smtp_status", "untested"),
        "email_notify_enabled": get_setting("email_notify_enabled", "0") == "1",
        "email_notify_to": get_setting("email_notify_to", ""),
        "serverchan_enabled": get_setting("serverchan_enabled", "0") == "1",
        "serverchan_key": get_setting("serverchan_key")
    }

@router.post("/api/notifications/settings")
def save_notification_settings(data: dict, user: dict = Depends(verify_token)):
    for k in ["smtp_host", "smtp_port", "smtp_sender_name", "smtp_user", "email_notify_to", "serverchan_key"]:
        if k in data:
            set_setting(k, data[k])
    if data.get("smtp_pass"):
        set_setting("smtp_pass", data["smtp_pass"].strip())
    if "smtp_ssl" in data:
        set_setting("smtp_ssl", "1" if data["smtp_ssl"] else "0")
    if "email_notify_enabled" in data:
        set_setting("email_notify_enabled", "1" if data["email_notify_enabled"] else "0")
    if "serverchan_enabled" in data:
        set_setting("serverchan_enabled", "1" if data["serverchan_enabled"] else "0")
    return {"message": "通知设置已保存"}

@router.post("/api/notifications/test-email")
def test_email(data: TestEmailDTO, user: dict = Depends(verify_token)):
    target = data.test_email.strip() if data.test_email else None
    ok, info = send_email_notification("发信测试", "这是一封来自 CDP Sync 系统的测试邮件，SMTP 配置工作正常。", override_to=target)
    if ok:
        set_setting("smtp_status", "ready")
        dest = target if target else (get_setting('email_notify_to') or get_setting('smtp_user'))
        return {"message": f"测试邮件已成功投递至: {dest}", "smtp_status": "ready"}
    else:
        set_setting("smtp_status", f"error: {info[:30]}")
        raise HTTPException(status_code=500, detail=f"发信受阻: {info}")

@router.post("/api/notifications/test-serverchan")
async def test_serverchan(user: dict = Depends(verify_token)):
    ok = await send_serverchan_notification("CDP 测试推送", "Server酱微信通道运行正常。")
    if not ok:
        raise HTTPException(status_code=500, detail="Server酱推送失败，请检查 SendKey")
    return {"message": "Server酱微信测试推送成功"}