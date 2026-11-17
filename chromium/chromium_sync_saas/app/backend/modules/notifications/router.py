from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel

from core.db import get_setting, set_setting
from core.rate_limit import get_client_ip
from core.security import require_admin
from modules.audit.service import write_audit_log
from modules.notifications.email_channel import send_email_sync
from modules.notifications.registry import notification_registry

router = APIRouter(tags=["模块化通知中心（Admin）"])


class TestEmailDTO(BaseModel):
    test_email: Optional[str] = None


@router.get("/api/notifications/channels", summary="列出所有已注册的通知渠道插件及其表单元数据与配置")
def list_notification_channels(admin: dict = Depends(require_admin)):
    return {
        "channels": notification_registry.list_metadata(),
        "default_channel": "email",
    }


@router.post("/api/notifications/channels/{channel_id}", summary="保存指定通知渠道插件的配置与启停状态")
def update_notification_channel(
    channel_id: str,
    request: Request,
    payload: Dict[str, Any] = Body(...),
    admin: dict = Depends(require_admin),
):
    ch = notification_registry.get(channel_id)
    if ch is None:
        raise HTTPException(status_code=404, detail=f"未注册的通知渠道: {channel_id}")

    ch.save_config(payload)
    write_audit_log(
        action="notification_channel_update",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="notification_channel",
        target_id=ch.channel_id,
        ip=get_client_ip(request),
        status="ok",
        details={"enabled": ch.is_enabled()},
    )
    return {
        "message": f"通知渠道 [{ch.display_name}] 配置已保存",
        "channel": ch.to_metadata(),
    }


@router.post("/api/notifications/channels/{channel_id}/test", summary="向指定通知渠道发送测试消息")
async def test_notification_channel(
    channel_id: str,
    request: Request,
    payload: Dict[str, Any] = Body(default={}),
    admin: dict = Depends(require_admin),
):
    ch = notification_registry.get(channel_id)
    if ch is None:
        raise HTTPException(status_code=404, detail=f"未注册的通知渠道: {channel_id}")

    title = "Chromium Sync SaaS Hub 渠道测试"
    content = (
        f"您好 {admin['username']}，这是一条来自 [{ch.display_name}] 插件的测试通知，"
        "如果您收到本消息，说明通知链路与凭据已工作正常。"
    )
    try:
        kwargs: Dict[str, Any] = {}
        if channel_id == "email":
            target = str(payload.get("target") or payload.get("test_email") or "").strip()
            if target:
                kwargs["to_email"] = target
        await ch.send(title, content, **kwargs)
        if channel_id == "email":
            set_setting("smtp_status", "ready")
        write_audit_log(
            action="notification_channel_test",
            actor_id=admin["id"],
            actor_username=admin["username"],
            target_type="notification_channel",
            target_id=ch.channel_id,
            ip=get_client_ip(request),
            status="ok",
        )
        return {"message": f"[{ch.display_name}] 测试消息已成功发送", "channel": ch.to_metadata()}
    except Exception as exc:
        if channel_id == "email":
            set_setting("smtp_status", f"error: {str(exc)[:40]}")
        raise HTTPException(status_code=400, detail=f"渠道 [{ch.display_name}] 测试发送失败: {exc}")


# ==================== 向后兼容旧版通知接口 ====================
@router.get("/api/notifications/settings")
def get_notification_settings(admin: dict = Depends(require_admin)):
    email_ch = notification_registry.get("email")
    sc_ch = notification_registry.get("serverchan")
    wh_ch = notification_registry.get("webhook")
    cfg = email_ch.get_config() if email_ch else {}
    sc_cfg = sc_ch.get_config() if sc_ch else {}
    wh_cfg = wh_ch.get_config() if wh_ch else {}
    return {
        "smtp_host": cfg.get("smtp_host", "smtp.yeah.net"),
        "smtp_port": str(cfg.get("smtp_port", "465")),
        "smtp_ssl": bool(cfg.get("smtp_ssl", True)),
        "smtp_sender_name": cfg.get("smtp_sender_name", "Wimotek SaaS Hub"),
        "smtp_user": cfg.get("smtp_user", ""),
        "smtp_pass": "",
        "smtp_status": cfg.get("smtp_status", "untested"),
        "email_notify_enabled": bool(cfg.get("enabled", False)),
        "email_notify_to": cfg.get("email_notify_to", ""),
        "serverchan_enabled": bool(sc_cfg.get("enabled", False)),
        "serverchan_key": "",
        "webhook_enabled": bool(wh_cfg.get("enabled", False)),
        "webhook_url": wh_cfg.get("webhook_url", ""),
    }


@router.post("/api/notifications/settings")
def save_notification_settings(data: dict, admin: dict = Depends(require_admin)):
    email_ch = notification_registry.get("email")
    sc_ch = notification_registry.get("serverchan")
    wh_ch = notification_registry.get("webhook")
    if email_ch:
        email_ch.save_config(data)
    if sc_ch:
        sc_ch.save_config(data)
    if wh_ch:
        wh_ch.save_config(data)
    return {"message": "平台通知渠道配置已保存"}


@router.post("/api/notifications/test-email")
def test_email(data: TestEmailDTO, admin: dict = Depends(require_admin)):
    target = (data.test_email.strip() if data.test_email else "") or get_setting("email_notify_to") or get_setting("smtp_user")
    try:
        send_email_sync(target, "SaaS Hub 发信测试", "这是一封来自 Wimotek Chromium SaaS Hub 的平台测试邮件。")
        set_setting("smtp_status", "ready")
        return {"message": f"测试邮件已成功投递至: {target}", "smtp_status": "ready"}
    except Exception as exc:
        set_setting("smtp_status", f"error: {str(exc)[:30]}")
        raise HTTPException(status_code=400, detail=f"发信受阻: {exc}")
