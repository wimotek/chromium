from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class AuditLogger:
    """
    结构化审计日志管理器。
    支持自动按大小轮转 (Auto-Rotation) 与安全截断清理，防止未清理导致磁盘耗尽。
    """

    def __init__(
        self,
        path: Path,
        max_bytes: int = 10 * 1024 * 1024,
        backup_count: int = 5,
    ) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max_bytes
        self.backup_count = backup_count
        self._lock = threading.Lock()

    def _rotate_if_needed(self) -> None:
        if self.max_bytes <= 0 or self.backup_count <= 0:
            return
        try:
            if not self.path.exists() or self.path.stat().st_size < self.max_bytes:
                return

            for i in range(self.backup_count - 1, 0, -1):
                sfn = self.path.with_name(f"{self.path.name}.{i}")
                dfn = self.path.with_name(f"{self.path.name}.{i + 1}")
                if sfn.exists():
                    if dfn.exists():
                        dfn.unlink()
                    sfn.rename(dfn)

            dfn = self.path.with_name(f"{self.path.name}.1")
            if dfn.exists():
                dfn.unlink()
            self.path.rename(dfn)
        except Exception:
            # 保证主线程写日志不因归档异常而崩溃
            pass

    def emit(self, event: str, **fields: Any) -> None:
        record = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "event": event,
            **fields,
        }
        line = json.dumps(record, ensure_ascii=False, default=str, sort_keys=True)
        with self._lock:
            self._rotate_if_needed()
            with self.path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")

    def clear(self, keep_last_lines: int = 0) -> int:
        """
        清理或截断审计日志。
        - keep_last_lines = 0: 完全清空
        - keep_last_lines > 0: 保留最近 N 行
        返回清理后保留的行数。
        """
        with self._lock:
            if not self.path.exists():
                return 0
            if keep_last_lines <= 0:
                self.path.write_text("", encoding="utf-8")
                return 0
            try:
                content = self.path.read_text(encoding="utf-8")
                lines = [l for l in content.splitlines() if l.strip()]
                remaining = lines[-keep_last_lines:]
                self.path.write_text(
                    "\n".join(remaining) + ("\n" if remaining else ""),
                    encoding="utf-8",
                )
                return len(remaining)
            except Exception:
                return 0