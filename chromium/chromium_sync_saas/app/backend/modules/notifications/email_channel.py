import asyncio
from email.header import Header
from email.mime.text import MIMEText
import smtplib
from typing import Any, Dict, List, Optional

from core.db import get_setting, set_setting
from modules.notifications.base import NotificationChannel


def send_email_sync(
    to_email: str,
    subject: str,
    content: str,
    override_cfg: Optional[Dict[str, Any]] = None,
    html: bool = False,
):
    cfg = override_cfg or {}
    host = str(cfg.get("smtp_host") if cfg.get("smtp_host") is not None else get_setting("smtp_host", "")).strip()
    raw_port = cfg.get("smtp_port") if cfg.get("smtp_port") is not None else get_setting("smtp_port", "465")
    try:
        port = int(raw_port or 465)
    except (TypeError, ValueError):
        port = 465

    raw_ssl = cfg.get("smtp_ssl") if "smtp_ssl" in cfg else (get_setting("smtp_ssl", "1") == "1")
    use_ssl = raw_ssl in (True, "1", 1, "true", "True")

    user = str(cfg.get("smtp_user") if cfg.get("smtp_user") is not None else get_setting("smtp_user", "")).strip()
    raw_pass = cfg.get("smtp_pass")
    password = str(raw_pass).strip() if raw_pass else get_setting("smtp_pass", "")
    sender_name = str(
        cfg.get("smtp_sender_name") if cfg.get("smtp_sender_name") is not None else get_setting("smtp_sender_name", "Wimotek SaaS Hub")
    ).strip() or "Wimotek SaaS Hub"

    target_addr = (to_email or "").strip()
    if not all([host, user, password, target_addr]):
        raise ValueError("SMTP 邮件配置不完整，请先填写服务器地址、发信账号、授权码与收件地址")

    mime_sub = "html" if html else "plain"
    msg = MIMEText(content, mime_sub, "utf-8")
    msg["From"] = f"{sender_name} <{user}>"
    msg["To"] = target_addr
    msg["Subject"] = Header(subject, "utf-8")

    server = None
    try:
        if use_ssl:
            server = smtplib.SMTP_SSL(host, port, timeout=12)
        else:
            server = smtplib.SMTP(host, port, timeout=12)
            server.ehlo()
            if port in (587, 25):
                try:
                    server.starttls()
                    server.ehlo()
                except Exception:
                    pass
        server.login(user, password)
        server.sendmail(user, [target_addr], msg.as_string())
    finally:
        if server:
            try:
                server.quit()
            except Exception:
                pass


class EmailNotificationChannel(NotificationChannel):
    channel_id = "email"
    display_name = "SMTP 邮件通知"
    description = "通过企业邮箱或个人 SMTP 服务器发送系统告警、安全审计及邮箱注册验证码"
    icon = "mail"
    supports_test = True

    def get_schema_fields(self) -> List[Dict[str, Any]]:
        return [
            {"key": "smtp_host", "label": "SMTP 服务器地址", "type": "text", "placeholder": "smtp.yeah.net / smtp.qq.com"},
            {"key": "smtp_port", "label": "SMTP 端口", "type": "number", "placeholder": "465"},
            {"key": "smtp_ssl", "label": "启用 SSL/TLS 加密", "type": "boolean"},
            {"key": "smtp_sender_name", "label": "发件人展示名称", "type": "text", "placeholder": "Wimotek SaaS Hub"},
            {"key": "smtp_user", "label": "发信邮箱账号", "type": "text", "placeholder": "noreply@example.com"},
            {"key": "smtp_pass", "label": "SMTP 密码 / 授权码", "type": "password", "placeholder": "留空则保留当前已配置密钥"},
            {"key": "email_notify_to", "label": "平台告警默认收件箱", "type": "text", "placeholder": "admin@example.com"},
        ]

    def is_enabled(self) -> bool:
        return get_setting("email_notify_enabled", "0") == "1"

    def get_config(self) -> Dict[str, Any]:
        return {
            "enabled": self.is_enabled(),
            "smtp_host": get_setting("smtp_host", "smtp.yeah.net"),
            "smtp_port": int(get_setting("smtp_port", "465") or 465),
            "smtp_ssl": get_setting("smtp_ssl", "1") == "1",
            "smtp_sender_name": get_setting("smtp_sender_name", "Wimotek SaaS Hub"),
            "smtp_user": get_setting("smtp_user", ""),
            "smtp_pass": "",
            "smtp_pass_configured": bool(get_setting("smtp_pass", "")),
            "smtp_status": get_setting("smtp_status", "untested"),
            "email_notify_to": get_setting("email_notify_to", ""),
        }

    def save_config(self, payload: Dict[str, Any]):
        if "enabled" in payload:
            set_setting("email_notify_enabled", "1" if payload["enabled"] else "0")
        elif "email_notify_enabled" in payload:
            set_setting("email_notify_enabled", "1" if payload["email_notify_enabled"] else "0")

        for k in ("smtp_host", "smtp_port", "smtp_sender_name", "smtp_user", "email_notify_to"):
            if k in payload and payload[k] is not None:
                set_setting(k, str(payload[k]).strip())

        if payload.get("smtp_pass"):
            set_setting("smtp_pass", str(payload["smtp_pass"]).strip())

        if "smtp_ssl" in payload:
            set_setting("smtp_ssl", "1" if payload["smtp_ssl"] else "0")

    async def send(self, title: str, content: str, **kwargs):
        to_addr = (kwargs.get("to_email") or get_setting("email_notify_to") or get_setting("smtp_user") or "").strip()
        if not to_addr:
            raise ValueError("未设置邮件接收地址 (email_notify_to)")
        await asyncio.to_thread(send_email_sync, to_addr, title, content, html=bool(kwargs.get("html", False)))
