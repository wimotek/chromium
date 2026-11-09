#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Structured Audit Logging & Auto-Rotation Engine for wimotek-chromium-sync
开箱即用的结构化 JSON Lines 审计日志与文件大小自动轮转引擎
- 触发机制: 每次写入时检测目标文件大小，达到阈值 (默认 10MB) 时，自动归档为 audit.jsonl.1, audit.jsonl.2...
- 自动淘汰: 超出保留上限 (默认最多保留 5 个归档备份) 的最旧日志自动被剔除，从根源杜绝磁盘打满
- 线程安全: 内置锁机制保障多线程并发写入不串行
"""

import os
import json
import time
import threading
from datetime import datetime
from typing import Optional, Dict, Any, Union, List


class AuditLogger:
    """
    生产级 JSON Lines 审计日志记录器
    """
    DEFAULT_FILE: str = "audit.jsonl"
    DEFAULT_MAX_BYTES: int = 10 * 1024 * 1024  # 默认 10MB
    DEFAULT_BACKUP_COUNT: int = 5              # 默认保留 5 个历史归档

    def __init__(
        self,
        file_path: Optional[str] = "audit.jsonl",
        max_bytes: int = 10 * 1024 * 1024,
        backup_count: int = 5,
        enabled: bool = True
    ):
        self.file_path = file_path or self.DEFAULT_FILE
        self.max_bytes = max_bytes if max_bytes > 0 else self.DEFAULT_MAX_BYTES
        self.backup_count = backup_count if backup_count >= 0 else self.DEFAULT_BACKUP_COUNT
        self.enabled = enabled
        self._lock = threading.Lock()

    def should_rotate(self, new_bytes_len: int = 0) -> bool:
        """检查写入新数据后是否达到轮转阈值"""
        if not self.file_path or self.max_bytes <= 0:
            return False
        try:
            if os.path.exists(self.file_path):
                current_size = os.path.getsize(self.file_path)
                return (current_size + new_bytes_len) >= self.max_bytes
        except OSError:
            pass
        return False

    def rotate(self) -> None:
        """
        执行文件大小自动轮转与淘汰:
        1. 若已存在 audit.jsonl.{backup_count}，自动删除最旧归档；
        2. 将历史归档依次向后推进: audit.jsonl.{N-1} -> audit.jsonl.{N}；
        3. 将主文件 audit.jsonl 重命名为 audit.jsonl.1；
        4. 随后写入自动写入新的主文件。
        """
        if not self.file_path or not os.path.exists(self.file_path):
            return

        if self.backup_count <= 0:
            # 不保留备份，直接清空主文件
            try:
                os.remove(self.file_path)
            except OSError:
                pass
            return

        # 1. 淘汰超出保留上限的最旧备份文件
        oldest_backup = f"{self.file_path}.{self.backup_count}"
        if os.path.exists(oldest_backup):
            try:
                os.remove(oldest_backup)
            except OSError:
                pass

        # 2. 从 backup_count - 1 递减到 1 依次向后重命名
        for i in range(self.backup_count - 1, 0, -1):
            src = f"{self.file_path}.{i}"
            dst = f"{self.file_path}.{i + 1}"
            if os.path.exists(src):
                try:
                    if os.path.exists(dst):
                        os.remove(dst)
                    os.rename(src, dst)
                except OSError:
                    pass

        # 3. 将当前主文件重命名为 .1
        first_backup = f"{self.file_path}.1"
        try:
            if os.path.exists(first_backup):
                os.remove(first_backup)
            os.rename(self.file_path, first_backup)
        except OSError:
            pass

    def log(
        self,
        event_type: str,
        details: Optional[Dict[str, Any]] = None,
        level: str = "INFO",
        **kwargs
    ) -> Dict[str, Any]:
        """
        写入一条结构化审计日志 (JSON Lines 格式)
        自动触发大小检测、轮转与淘汰
        """
        if not self.enabled or not self.file_path:
            return {}

        now = datetime.utcnow()
        record = {
            "timestamp": now.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "level": level.upper(),
            "event": event_type,
            "details": details.copy() if details else {}
        }
        if kwargs:
            record["details"].update(kwargs)

        line = json.dumps(record, ensure_ascii=False) + "\n"
        encoded = line.encode("utf-8")

        with self._lock:
            # 写入前检测是否需轮转
            if self.should_rotate(len(encoded)):
                self.rotate()

            parent_dir = os.path.dirname(self.file_path)
            if parent_dir and not os.path.exists(parent_dir):
                try:
                    os.makedirs(parent_dir, exist_ok=True)
                except OSError:
                    pass

            with open(self.file_path, "a", encoding="utf-8") as f:
                f.write(line)

        return record

    def get_audit_files(self) -> List[str]:
        """获取当前存在的主日志及全部轮转归档文件列表 (按新到旧排序)"""
        files = []
        if os.path.exists(self.file_path):
            files.append(self.file_path)
        for i in range(1, self.backup_count + 1):
            rotated = f"{self.file_path}.{i}"
            if os.path.exists(rotated):
                files.append(rotated)
        return files

    def read_recent_records(self, limit: int = 50) -> List[Dict[str, Any]]:
        """便捷读取最近的审计记录 (主要用于控制台展示或调试)"""
        records: List[Dict[str, Any]] = []
        if not self.file_path or not os.path.exists(self.file_path):
            return records

        try:
            with open(self.file_path, "r", encoding="utf-8") as f:
                lines = f.readlines()
                for line in reversed(lines):
                    line = line.strip()
                    if line:
                        try:
                            records.append(json.loads(line))
                            if len(records) >= limit:
                                break
                        except json.JSONDecodeError:
                            continue
        except OSError:
            pass

        return records
