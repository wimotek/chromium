from __future__ import annotations

import os
import secrets
from pathlib import Path
from typing import Optional


class LocalBypassManager:
    """
    本地连接默认放行，但增加“本地 bypass token”作为纵深防御。
    同主机其他进程只有读取到该文件（0600）才能通过本地放行。
    """

    def __init__(self, token_path: Path, required: bool = True) -> None:
        self.token_path = token_path
        self.required = required
        self.token_path.parent.mkdir(parents=True, exist_ok=True)

    def ensure_token(self) -> str:
        if self.token_path.exists():
            token = self.token_path.read_text(encoding="utf-8").strip()
            if token:
                return token

        token = secrets.token_urlsafe(48)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        try:
            fd = os.open(str(self.token_path), flags, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(token)
        except FileExistsError:
            token = self.token_path.read_text(encoding="utf-8").strip()
            if not token:
                raise RuntimeError("local bypass token file exists but is empty")
        return token

    def verify(self, presented: Optional[str]) -> bool:
        if not self.required:
            return True
        if not presented:
            return False
        expected = self.ensure_token()
        return secrets.compare_digest(presented, expected)