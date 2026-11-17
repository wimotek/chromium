from datetime import datetime
import hashlib
import hmac
import json
from typing import Any, Dict, List
import httpx

from core.db import get_setting, set_setting
from modules.notifications.base import NotificationChannel


class WebhookNotificationChannel(NotificationChannel):
    channel_id = "webhook"
    display_name = "自定义 Webhook 推送"
    description = "向企业微信 / 钉钉 / 飞书机器人或自建 HTTP 回调推送 JSON 事件，支持 HMAC-SHA256 验签"
    icon = "webhook"
    supports_test = True

    def get_schema_fields(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "webhook_url",
                "label": "Webhook 接收 URL",
                "type": "text",
                "placeholder": "https://hooks.example.com/notify",
            },
            {
                "key": "webhook_secret",
                "label": "HMAC-SHA256 签名密钥（可选）",
                "type": "password",
                "placeholder": "用于生成 X-Webhook-Signature 请求头，留空不修改",
            },
        ]

    def is_enabled(self) -> bool:
        return get_setting("webhook_enabled", "0") == "1"

    def get_config(self) -> Dict[str, Any]:
        return {
            "enabled": self.is_enabled(),
            "webhook_url": get_setting("webhook_url", ""),
            "webhook_secret": "",
            "webhook_secret_configured": bool(get_setting("webhook_secret", "")),
        }

    def save_config(self, payload: Dict[str, Any]):
        if "enabled" in payload:
            set_setting("webhook_enabled", "1" if payload["enabled"] else "0")
        elif "webhook_enabled" in payload:
            set_setting("webhook_enabled", "1" if payload["webhook_enabled"] else "0")
        if "webhook_url" in payload and payload["webhook_url"] is not None:
            set_setting("webhook_url", str(payload["webhook_url"]).strip())
        if payload.get("webhook_secret"):
            set_setting("webhook_secret", str(payload["webhook_secret"]).strip())

    async def send(self, title: str, content: str, **kwargs):
        url = (kwargs.get("webhook_url") or get_setting("webhook_url", "")).strip()
        if not url:
            raise ValueError("未配置 Webhook 接收 URL")
        if not (url.startswith("http://") or url.startswith("https://")):
            raise ValueError("Webhook URL 必须以 http:// 或 https:// 开头")

        body_obj = {
            "event": kwargs.get("event", "platform_notification"),
            "title": title,
            "content": content,
            "msgtype": "text",
            "text": {"content": f"[{title}]\n{content}"},
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        raw_body = json.dumps(body_obj, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json; charset=utf-8"}
        secret = get_setting("webhook_secret", "").strip()
        if secret:
            sig = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
            headers["X-Webhook-Signature"] = f"sha256={sig}"

        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.post(url, content=raw_body, headers=headers)
            if resp.status_code >= 400:
                raise RuntimeError(f"Webhook HTTP {resp.status_code}: {resp.text[:160]}")
