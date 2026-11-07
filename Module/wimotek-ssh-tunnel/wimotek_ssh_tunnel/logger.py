"""
Structured Logger with dedicated SKIP level support.
"""

import logging
import sys
from datetime import datetime
from typing import Optional, Dict, Any
from .models import SkipEvent

# Custom log level for SKIP (between WARNING and ERROR)
SKIP_LOG_LEVEL = 35
logging.addLevelName(SKIP_LOG_LEVEL, "SKIP")

class TunnelLogger:
    def __init__(self, name: str = "wimotek-ssh-tunnel", console_output: bool = True):
        self.logger = logging.getLogger(name)
        self.logger.setLevel(logging.DEBUG)
        self.console_output = console_output
        self.entries = []

        if console_output and not self.logger.handlers:
            handler = logging.StreamHandler(sys.stdout)
            formatter = logging.Formatter(
                "[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
                datefmt="%H:%M:%S"
            )
            handler.setFormatter(formatter)
            self.logger.addHandler(handler)

    def debug(self, msg: str, node_id: Optional[str] = None):
        prefix = f"[Node: {node_id}] " if node_id else ""
        self.logger.debug(f"{prefix}{msg}")

    def info(self, msg: str, node_id: Optional[str] = None):
        prefix = f"[Node: {node_id}] " if node_id else ""
        self.logger.info(f"{prefix}{msg}")

    def warning(self, msg: str, node_id: Optional[str] = None):
        prefix = f"[Node: {node_id}] " if node_id else ""
        self.logger.warning(f"{prefix}{msg}")

    def error(self, msg: str, node_id: Optional[str] = None):
        prefix = f"[Node: {node_id}] " if node_id else ""
        self.logger.error(f"{prefix}{msg}")

    def skip(self, skip_event: SkipEvent):
        """
        Record a skipped node event with actionable diagnostic metadata.
        """
        msg = f"⚠️ [SKIP] [{skip_event.error_code}] Target skipped: {skip_event.node_name} ({skip_event.host}:{skip_event.port}) -> {skip_event.error_message}"
        self.logger.log(SKIP_LOG_LEVEL, msg)
        self.entries.append({
            "timestamp": skip_event.timestamp,
            "level": "skip",
            "message": msg,
            "skip_event": skip_event
        })

default_logger = TunnelLogger()
