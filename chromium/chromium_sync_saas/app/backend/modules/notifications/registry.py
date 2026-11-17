from typing import Dict, List, Optional

from config import logger
from modules.notifications.base import NotificationChannel
from modules.notifications.email_channel import EmailNotificationChannel
from modules.notifications.serverchan_channel import ServerChanNotificationChannel
from modules.notifications.webhook_channel import WebhookNotificationChannel


class NotificationRegistry:
    """模块化通知渠道注册表：新增渠道只需继承 NotificationChannel 并调用 register()"""

    def __init__(self):
        self._channels: Dict[str, NotificationChannel] = {}

    def register(self, channel: NotificationChannel):
        if not channel.channel_id:
            raise ValueError("NotificationChannel 必须定义 channel_id")
        self._channels[channel.channel_id] = channel

    def get(self, channel_id: str) -> Optional[NotificationChannel]:
        return self._channels.get((channel_id or "").strip().lower())

    def list_channels(self) -> List[NotificationChannel]:
        return list(self._channels.values())

    def list_metadata(self) -> List[dict]:
        return [ch.to_metadata() for ch in self._channels.values()]

    async def dispatch(self, title: str, content: str, **kwargs):
        for ch in self._channels.values():
            if not ch.is_enabled():
                continue
            try:
                await ch.send(title, content, **kwargs)
            except Exception as exc:
                logger.error(f"❌ 通知渠道 [{ch.channel_id}] 投递失败: {exc}")


notification_registry = NotificationRegistry()
notification_registry.register(EmailNotificationChannel())
notification_registry.register(ServerChanNotificationChannel())
notification_registry.register(WebhookNotificationChannel())


async def dispatch_notification(title: str, content: str, **kwargs):
    await notification_registry.dispatch(title, content, **kwargs)
