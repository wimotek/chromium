from __future__ import annotations

import asyncio
import hashlib
import json
import ssl
from typing import Any, Optional, Protocol


class JsonLineTransport:
    """
    JSON Line 传输。可直连 TLS，也可由 WSS 反向隧道 dialer 包装。
    """

    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        max_line_bytes: int = 64 * 1024,
    ) -> None:
        self.reader = reader
        self.writer = writer
        self.max_line_bytes = max_line_bytes

    async def read_message(self) -> dict[str, Any]:
        line = await self.reader.readline()
        if not line:
            raise ConnectionError("connection closed")
        if len(line) > self.max_line_bytes:
            raise ValueError("handshake/message line too large")
        return json.loads(line.decode("utf-8"))

    async def write_message(self, message: dict[str, Any]) -> None:
        data = json.dumps(
            message, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        if len(data) > self.max_line_bytes:
            raise ValueError("message too large")
        self.writer.write(data + b"\n")
        await self.writer.drain()

    async def close(self) -> None:
        self.writer.close()
        try:
            await self.writer.wait_closed()
        except Exception:
            pass

    def peer_cert_sha256(self) -> Optional[str]:
        ssl_object = self.writer.get_extra_info("ssl_object")
        if ssl_object is None:
            return None
        der = ssl_object.getpeercert(binary_form=True)
        if not der:
            return None
        return hashlib.sha256(der).hexdigest()

    def verify_certificate_pin(self, expected_sha256: Optional[str]) -> None:
        if not expected_sha256:
            return
        actual = self.peer_cert_sha256()
        if actual is None:
            raise ConnectionError("TLS peer certificate not available for pinning")
        if actual.lower() != expected_sha256.lower():
            raise ConnectionError("TLS certificate pin mismatch")


class TunnelDialer(Protocol):
    """
    WSS 反向隧道拨号器接口。
    你现有的 websocket 栈实现该接口后，即可接入 run_reverse_tunnel。
    """

    async def dial(
        self,
        url: str,
        ssl_context: ssl.SSLContext,
        server_hostname: str,
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        ...


async def open_direct_tls(
    host: str,
    port: int,
    ssl_context: ssl.SSLContext,
    server_hostname: Optional[str] = None,
    certificate_pin_sha256: Optional[str] = None,
) -> JsonLineTransport:
    reader, writer = await asyncio.open_connection(
        host=host,
        port=port,
        ssl=ssl_context,
        server_hostname=server_hostname or host,
    )
    transport = JsonLineTransport(reader, writer)
    transport.verify_certificate_pin(certificate_pin_sha256)
    return transport


async def open_reverse_tunnel(
    url: str,
    dialer: TunnelDialer,
    ssl_context: ssl.SSLContext,
    server_hostname: str,
    certificate_pin_sha256: Optional[str] = None,
) -> JsonLineTransport:
    reader, writer = await dialer.dial(url, ssl_context, server_hostname)
    transport = JsonLineTransport(reader, writer)
    transport.verify_certificate_pin(certificate_pin_sha256)
    return transport