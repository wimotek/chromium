from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .models import NodeRecord, TrustStatus


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class TrustStore:
    """
    可替换为外部 KMS / 中心端数据库。当前提供 SQLite 商业默认实现。
    """

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS nodes (
                    node_uuid TEXT PRIMARY KEY,
                    fingerprint TEXT NOT NULL,
                    status TEXT NOT NULL,
                    first_seen TEXT NOT NULL,
                    approved_at TEXT,
                    network_profile TEXT NOT NULL,
                    metadata TEXT NOT NULL DEFAULT '{}'
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS used_tokens (
                    jti TEXT PRIMARY KEY,
                    expires_at INTEGER NOT NULL,
                    used_at TEXT NOT NULL
                )
                """
            )

    def get_node(self, node_uuid: str) -> Optional[NodeRecord]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM nodes WHERE node_uuid = ?", (node_uuid,)
            ).fetchone()
        if row is None:
            return None
        return NodeRecord(
            node_uuid=row["node_uuid"],
            fingerprint=row["fingerprint"],
            status=TrustStatus(row["status"]),
            first_seen=row["first_seen"],
            approved_at=row["approved_at"],
            network_profile=row["network_profile"],
            metadata=json.loads(row["metadata"] or "{}"),
        )

    def upsert_pending(
        self,
        node_uuid: str,
        fingerprint: str,
        network_profile: str,
        metadata: Optional[dict] = None,
    ) -> NodeRecord:
        existing = self.get_node(node_uuid)
        now = _utc_now()
        metadata_json = json.dumps(metadata or {}, ensure_ascii=False, sort_keys=True)

        with self._connect() as conn:
            if existing is None:
                conn.execute(
                    """
                    INSERT INTO nodes
                    (node_uuid, fingerprint, status, first_seen, approved_at, network_profile, metadata)
                    VALUES (?, ?, ?, ?, NULL, ?, ?)
                    """,
                    (
                        node_uuid,
                        fingerprint,
                        TrustStatus.PENDING.value,
                        now,
                        network_profile,
                        metadata_json,
                    ),
                )
            elif existing.status == TrustStatus.PENDING:
                conn.execute(
                    """
                    UPDATE nodes
                    SET fingerprint = ?, network_profile = ?, metadata = ?
                    WHERE node_uuid = ?
                    """,
                    (fingerprint, network_profile, metadata_json, node_uuid),
                )
        result = self.get_node(node_uuid)
        if result is None:
            raise RuntimeError("failed to upsert pending node")
        return result

    def approve_tofu(self, node_uuid: str, fingerprint: Optional[str] = None) -> bool:
        node = self.get_node(node_uuid)
        if node is None or node.status != TrustStatus.PENDING:
            return False
        if fingerprint is not None and node.fingerprint != fingerprint:
            return False
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE nodes
                SET status = ?, approved_at = ?
                WHERE node_uuid = ? AND status = ?
                """,
                (
                    TrustStatus.TRUSTED.value,
                    _utc_now(),
                    node_uuid,
                    TrustStatus.PENDING.value,
                ),
            )
        return True

    def bind_token(
        self,
        node_uuid: str,
        fingerprint: str,
        network_profile: str,
        metadata: Optional[dict] = None,
    ) -> None:
        now = _utc_now()
        metadata_json = json.dumps(metadata or {}, ensure_ascii=False, sort_keys=True)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO nodes
                (node_uuid, fingerprint, status, first_seen, approved_at, network_profile, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(node_uuid) DO UPDATE SET
                    fingerprint = excluded.fingerprint,
                    status = excluded.status,
                    approved_at = excluded.approved_at,
                    network_profile = excluded.network_profile,
                    metadata = excluded.metadata
                """,
                (
                    node_uuid,
                    fingerprint,
                    TrustStatus.TRUSTED.value,
                    now,
                    now,
                    network_profile,
                    metadata_json,
                ),
            )

    def revoke(self, node_uuid: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE nodes SET status = ? WHERE node_uuid = ?",
                (TrustStatus.REVOKED.value, node_uuid),
            )
            return cur.rowcount > 0

    def is_trusted(self, node_uuid: str, fingerprint: Optional[str] = None) -> bool:
        node = self.get_node(node_uuid)
        if node is None or node.status != TrustStatus.TRUSTED:
            return False
        if fingerprint is not None and node.fingerprint != fingerprint:
            return False
        return True

    def list_nodes(self, status: Optional[TrustStatus] = None) -> list[NodeRecord]:
        with self._connect() as conn:
            if status is not None:
                rows = conn.execute(
                    "SELECT * FROM nodes WHERE status = ? ORDER BY first_seen DESC",
                    (status.value,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM nodes ORDER BY first_seen DESC"
                ).fetchall()
        return [
            NodeRecord(
                node_uuid=r["node_uuid"],
                fingerprint=r["fingerprint"],
                status=TrustStatus(r["status"]),
                first_seen=r["first_seen"],
                approved_at=r["approved_at"],
                network_profile=r["network_profile"],
                metadata=json.loads(r["metadata"] or "{}"),
            )
            for r in rows
        ]

    def delete_node(self, node_uuid: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM nodes WHERE node_uuid = ?", (node_uuid,))
            return cur.rowcount > 0

    def get_stats(self) -> dict[str, int]:
        with self._connect() as conn:
            nodes_rows = conn.execute(
                "SELECT status, COUNT(*) as cnt FROM nodes GROUP BY status"
            ).fetchall()
            status_counts = {r["status"]: r["cnt"] for r in nodes_rows}
            used_tokens_count = conn.execute(
                "SELECT COUNT(*) as cnt FROM used_tokens"
            ).fetchone()["cnt"]

        return {
            "total_nodes": sum(status_counts.values()),
            "trusted_nodes": status_counts.get(TrustStatus.TRUSTED.value, 0),
            "pending_nodes": status_counts.get(TrustStatus.PENDING.value, 0),
            "revoked_nodes": status_counts.get(TrustStatus.REVOKED.value, 0),
            "used_tokens_count": used_tokens_count,
        }

    def consume_token(self, jti: str, expires_at: int) -> bool:
        """
        返回 True 表示首次使用；False 表示重放。
        """
        now_ts = int(time.time())
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM used_tokens WHERE expires_at < ?", (now_ts,)
            )
            try:
                conn.execute(
                    """
                    INSERT INTO used_tokens (jti, expires_at, used_at)
                    VALUES (?, ?, ?)
                    """,
                    (jti, expires_at, _utc_now()),
                )
                return True
            except sqlite3.IntegrityError:
                return False