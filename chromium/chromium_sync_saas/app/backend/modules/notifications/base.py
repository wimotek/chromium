from abc import ABC, abstractmethod
from typing import Any, Dict, List


class NotificationChannel(ABC):
    """模块化通知渠道基类：所有通知渠道（邮件、Server酱、Webhook 等）均继承此类并自动注册到管理后台"""

    channel_id: str = ""
    display_name: str = ""
    description: str = ""
    icon: str = "bell"
    supports_test: bool = True

    @abstractmethod
    def get_schema_fields(self) -> List[Dict[str, Any]]:
        """返回动态表单字段定义，便于管理后台零改造扩展新渠道"""

    @abstractmethod
    def is_enabled(self) -> bool:
        """是否已开启该渠道"""

    @abstractmethod
    def get_config(self) -> Dict[str, Any]:
        """读取渠道配置（敏感密钥字段建议返回空串或 masked 提示）"""

    @abstractmethod
    def save_config(self, payload: Dict[str, Any]):
        """持久化渠道配置"""

    @abstractmethod
    async def send(self, title: str, content: str, **kwargs):
        """异步投递通知消息"""

    def to_metadata(self) -> Dict[str, Any]:
        return {
            "channel_id": self.channel_id,
            "display_name": self.display_name,
            "description": self.description,
            "icon": self.icon,
            "supports_test": self.supports_test,
            "enabled": self.is_enabled(),
            "fields": self.get_schema_fields(),
            "config": self.get_config(),
        }
