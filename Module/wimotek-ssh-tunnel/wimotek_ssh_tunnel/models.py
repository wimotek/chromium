"""
Data models and type definitions for wimotek-ssh-tunnel.
"""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any, Literal
from datetime import datetime

ConnectionMode = Literal['direct', 'wss_direct', 'wss_reverse', 'ssh_tunnel']

@dataclass
class SshHostConfig:
    id: str
    name: str
    host: str
    port: int = 22
    username: str = "root"
    auth_type: Literal['password', 'private_key', 'agent'] = 'password'
    password: Optional[str] = None
    private_key: Optional[str] = None
    remote_cdp_host: str = "127.0.0.1"
    remote_cdp_port: int = 9222
    local_bound_port: Optional[int] = None
    timeout_ms: int = 4000
    enabled: bool = True
    tags: List[str] = field(default_factory=list)

@dataclass
class CdpTarget:
    id: str
    title: str
    type: str
    url: str
    web_socket_debugger_url: str
    original_ws_url: str
    node_id: str
    node_name: str
    node_host: str
    tunnel_port: int
    last_synced_at: str
    description: Optional[str] = None
    devtools_frontend_url: Optional[str] = None
    status: str = "active"

@dataclass
class SkipEvent:
    id: str
    node_id: str
    node_name: str
    host: str
    port: int
    error_code: str
    error_message: str
    timestamp: str
    duration_ms: int
    details: Optional[str] = None
    suggestion: Optional[str] = None

@dataclass
class SyncResult:
    sync_id: str
    started_at: str
    completed_at: str
    duration_ms: int
    total_nodes: int
    successful_nodes: int
    failed_nodes: int
    total_targets: int
    targets: List[CdpTarget]
    skips: List[SkipEvent]
    summary_message: str
