from typing import Any, Dict, List
import httpx

from core.db import get_setting, set_setting
from modules.notifications.base import NotificationChannel


class ServerChanNotificationChannel(NotificationChannel):
    channel_id = "serverchan"
    display_name = "Server酱 微信推送"
    description = "基于 Server酱 Turbo (sctapi.ftqq.com) 将系统异常与运营通知实时送达微信"
    icon = "message-circle"
    supports_test = True

    def get_schema_fields(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "serverchan_key",
                "label": "Server酱 SendKey",
                "type": "password",
                "placeholder": "SCTxxxxxxxxxxxx（留空则不修改）",
            }
        ]

    def is_enabled(self) -> bool:
        return get_setting("serverchan_enabled", "0") == "1"

    def get_config(self) -> Dict[str, Any]:
        key_val = get_setting("serverchan_key", "")
        return {
            "enabled": self.is_enabled(),
            "serverchan_key": "",
            "serverchan_key_configured": bool(key_val),
        }

    def save_config(self, payload: Dict[str, Any]):
        if "enabled" in payload:
            set_setting("serverchan_enabled", "1" if payload["enabled"] else "0")
        elif "serverchan_enabled" in payload:
            set_setting("serverchan_enabled", "1" if payload["serverchan_enabled"] else "0")
        if payload.get("serverchan_key"):
            set_setting("serverchan_key", str(payload["serverchan_key"]).strip())

    async def send(self, title: str, content: str, **kwargs):
        sendkey = (kwargs.get("sendkey") or get_setting("serverchan_key", "")).strip()
        if not sendkey:
            raise ValueError("未配置 Server酱 SendKey")
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.post(
                f"https://sctapi.ftqq.com/{sendkey}.send",
                data={"title": title[:128], "desp": content},
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"Server酱 HTTP {resp.status_code}: {resp.text[:160]}")
