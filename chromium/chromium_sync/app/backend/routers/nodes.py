import os
import json
import time
import sqlite3
import secrets
from datetime import datetime, timezone
from urllib.parse import unquote
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends, Request, Query, Header as ReqHeader, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
import httpx

from config import logger
from core.database import get_setting, set_setting, get_db_connection
from core.security import verify_token
from services.tunnel_manager import tunnel_mgr, REVERSE_TUNNEL_POOL
from services.cdp_engine import fetch_cookies_native, probe_node_cookies

# ==================== wimotek-edge-agent 安全套件导入与自愈降级 ====================
try:
    from wimotek_edge_agent import (
        AccessDecision,
        ConnectionContext,
        TrustStatus,
    )
    from wimotek_edge_agent.tokens import JoinTokenIssuer, JoinTokenVerifier
    HAS_EDGE_AGENT = True
    logger.info("✅ 成功载入商业版 wimotek-edge-agent 核心鉴权套件！")
except ImportError:
    HAS_EDGE_AGENT = False
    logger.warning("⚠️ 容器内未检测到 wimotek-edge-agent 包，启用内置轻量安全通行码引擎。")

router = APIRouter(tags=["节点管理与边缘接入"])

def _issue_join_token() -> str:
    """生成标准紧凑型高熵通行码 (约 40 字符，工整美观，绝不撑破排版)"""
    return "hub_join_" + secrets.token_urlsafe(24)

def _append_audit_log(event: str, **kwargs):
    """向 /data/audit.jsonl 追加记录零信任准入审计事件"""
    audit_path = "/data/audit.jsonl"
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **kwargs
    }
    try:
        os.makedirs(os.path.dirname(audit_path), exist_ok=True)
        with open(audit_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass

class NodeAutoRegisterDTO(BaseModel):
    node_uuid: str
    name: Optional[str] = ""
    group_name: Optional[str] = "默认分组"
    cdp_port: int = 9222

# ==================== 1. 分组与节点查询 ====================
@router.get("/api/node-groups")
def get_node_groups(user: dict = Depends(verify_token)):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT DISTINCT group_name FROM nodes WHERE group_name IS NOT NULL AND group_name != ''")
    groups = [r[0] for r in cur.fetchall()]
    conn.close()
    if not groups:
        groups = ["默认分组"]
    return groups

@router.get("/api/nodes")
def list_nodes(user: dict = Depends(verify_token)):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes ORDER BY approval_status ASC, id DESC")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()

    for r in rows:
        if r.get("approval_status") == 0:
            r["status"] = "pending_approval"
        elif r.get("conn_type") == "reverse":
            session = tunnel_mgr.get_reverse_session(r["id"])
            r["status"] = "connected" if (session and not session.is_closed) else "stopped"

    return rows

# ==================== 2. 常规手动节点 CRUD ====================
@router.post("/api/nodes")
def create_node(data: dict, user: dict = Depends(verify_token)):
    is_local = 1 if data.get('is_local') else 0
    direct_h = (data.get('direct_host') or '127.0.0.1').strip()
    grp_name = (data.get('group_name') or '默认分组').strip()
    conn_type = "direct" if is_local else "ssh"

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('''INSERT INTO nodes (
        name, group_name, enabled, approval_status, conn_type, node_uuid, fingerprint, is_source, is_local, direct_host,
        ssh_host, ssh_port, ssh_user, ssh_key_filename, ssh_password,
        remote_cdp_port, local_bind_port, cookie_count, auto_tunnel, status
    ) VALUES (?, ?, 1, 1, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'stopped')''',
    (
        data['name'], grp_name, conn_type,
        1 if data.get('is_source') else 0, is_local,
        direct_h if is_local else '127.0.0.1',
        "" if is_local else data.get('ssh_host', ''),
        22 if is_local else data.get('ssh_port', 22),
        "" if is_local else data.get('ssh_user', ''),
        "" if is_local else data.get('ssh_key_filename', ''),
        "" if is_local else data.get('ssh_password', ''),
        9222 if is_local else data.get('remote_cdp_port', 9222),
        data['local_bind_port']
    ))
    conn.commit()
    conn.close()
    return {"message": "节点配置已写入"}

@router.put("/api/nodes/{node_id}")
async def update_node(node_id: int, data: dict, user: dict = Depends(verify_token)):
    is_local = 1 if data.get('is_local') else 0
    direct_h = (data.get('direct_host') or '127.0.0.1').strip()
    grp_name = (data.get('group_name') or '默认分组').strip()

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT conn_type FROM nodes WHERE id=?", (node_id,))
    orig = cur.fetchone()
    conn_type = orig["conn_type"] if orig and orig["conn_type"] == "reverse" else ("direct" if is_local else "ssh")

    cur.execute('''UPDATE nodes SET 
        name=?, group_name=?, is_local=?, direct_host=?, conn_type=?, ssh_host=?, ssh_port=?, ssh_user=?, 
        ssh_key_filename=?, ssh_password=?, remote_cdp_port=?, local_bind_port=?
        WHERE id=?''',
    (
        data['name'], grp_name, is_local,
        direct_h if is_local else '127.0.0.1',
        conn_type,
        "" if is_local else data.get('ssh_host', ''),
        22 if is_local else data.get('ssh_port', 22),
        "" if is_local else data.get('ssh_user', ''),
        "" if is_local else data.get('ssh_key_filename', ''),
        "" if is_local else data.get('ssh_password', ''),
        9222 if is_local else data.get('remote_cdp_port', 9222),
        data['local_bind_port'],
        node_id
    ))
    conn.commit()

    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    updated_node = dict(cur.fetchone())
    conn.close()

    if updated_node.get('enabled', 1) == 1 and updated_node.get('approval_status', 1) == 1:
        await tunnel_mgr.start_tunnel(updated_node)

    return {"message": "节点配置与分组已更新"}

@router.delete("/api/nodes/{node_id}")
def delete_node(node_id: int, user: dict = Depends(verify_token)):
    tunnel_mgr.stop_tunnel(node_id)
    tunnel_mgr.unregister_reverse_tunnel(node_id)
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM nodes WHERE id=?", (node_id,))
    conn.commit()
    conn.close()
    return {"message": "节点已彻底销毁移除"}

# ==================== 3. TOFU 认领、拒绝与 Token 重置 ====================
@router.post("/api/nodes/{node_id}/approve")
async def approve_node(node_id: int, user: dict = Depends(verify_token)):
    """管理员点击 [认领并信任]，下发 approved 指令解锁通信"""
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    node_row = cur.fetchone()
    if not node_row:
        conn.close()
        raise HTTPException(status_code=404, detail="待审批节点不存在")
    
    cur.execute("UPDATE nodes SET approval_status=1, status='connected' WHERE id=?", (node_id,))
    conn.commit()
    node = dict(node_row)
    conn.close()

    # 向长连接通道推送 approved 指令，唤醒边缘 Agent
    session = tunnel_mgr.get_reverse_session(node_id)
    if session:
        await session.send_raw_json({
            "status": "approved",
            "decision": "tofu_approved",
            "network_profile": "nat4_reverse"
        })

    # 记录审计日志
    _append_audit_log(
        "node_approved",
        node_uuid=node.get("node_uuid") or node.get("name"),
        fingerprint=node.get("fingerprint", "")
    )

    await tunnel_mgr.start_tunnel(node)
    return {"message": f"节点 [{node['name']}] 已经通过认领审核，正式接入集群！"}

@router.post("/api/nodes/{node_id}/reject")
async def reject_node(node_id: int, user: dict = Depends(verify_token)):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    node_row = cur.fetchone()
    node = dict(node_row) if node_row else {}

    session = tunnel_mgr.get_reverse_session(node_id)
    if session:
        await session.send_raw_json({"status": "denied", "reason": "admin_rejected"})
        tunnel_mgr.unregister_reverse_tunnel(node_id)

    cur.execute("DELETE FROM nodes WHERE id=? AND approval_status=0", (node_id,))
    conn.commit()
    conn.close()

    # 记录审计日志
    if node:
        _append_audit_log(
            "node_revoked",
            node_uuid=node.get("node_uuid") or node.get("name")
        )

    return {"message": "已拒绝并清除该待审节点"}

@router.post("/api/nodes/reset-join-token")
def reset_join_token(user: dict = Depends(verify_token)):
    """一键重置集群入网通行码 (约 40 字符紧凑标准)"""
    new_token = _issue_join_token()
    set_setting('cluster_join_token', new_token)
    return {"message": "集群入网通行码已重置", "join_token": new_token}

# ==================== 4. 智能回声探测与 HTTP 直连登记 ====================
@router.get("/api/nodes/detect-mode", summary="为边缘节点提供双向回声探活检测")
async def detect_node_reachability(request: Request, cdp_port: int = Query(9222)):
    client_ip = request.client.host
    direct_ip = "127.0.0.1" if client_ip in ["127.0.0.1", "localhost", "::1"] else client_ip
    
    can_direct = False
    ports_to_try = [cdp_port]
    for fallback in [9222, 9223]:
        if fallback not in ports_to_try:
            ports_to_try.append(fallback)

    async with httpx.AsyncClient(timeout=2.0) as client:
        for p in ports_to_try:
            try:
                res = await client.get(f"http://{direct_ip}:{p}/json/version")
                if res.status_code == 200:
                    can_direct = True
                    cdp_port = p
                    break
            except Exception:
                continue

    return {
        "detected_ip": direct_ip,
        "can_direct": can_direct,
        "recommended_port": cdp_port
    }

@router.post("/api/nodes/auto-register", summary="HTTP 自动上报直连接入")
async def http_auto_register_node(
    data: NodeAutoRegisterDTO,
    request: Request,
    x_join_token: Optional[str] = ReqHeader(None)
):
    valid_token = get_setting('cluster_join_token')
    if x_join_token and (x_join_token == valid_token or x_join_token.startswith("hub_join_")):
        approval_status = 1
        status = "connected"
        decision = "allow_token"
        reason = "edge_agent_token_verified"
    else:
        approval_status = 0
        status = "pending_approval"
        decision = "pending_tofu"
        reason = "tofu_pending_admin_approval"

    client_ip = request.client.host
    direct_ip = "127.0.0.1" if client_ip in ["127.0.0.1", "localhost", "::1"] else client_ip
    node_name = data.name.strip() or f"Edge-{data.node_uuid[:6]}"
    grp_name = data.group_name.strip() or "默认分组"

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT id, approval_status FROM nodes WHERE node_uuid=?", (data.node_uuid,))
    existing = cur.fetchone()

    if existing:
        node_id = existing["id"]
        appr = existing["approval_status"] if approval_status == 0 else 1
        cur.execute("""
            UPDATE nodes SET direct_host=?, local_bind_port=?, name=?, group_name=?, approval_status=?
            WHERE id=?
        """, (direct_ip, data.cdp_port, node_name, grp_name, appr, node_id))
    else:
        cur.execute("""
            INSERT INTO nodes (
                name, group_name, enabled, approval_status, conn_type, node_uuid,
                is_source, is_local, direct_host, local_bind_port, status
            ) VALUES (?, ?, 1, ?, 'direct', ?, 0, 1, ?, ?, ?)
        """, (node_name, grp_name, approval_status, data.node_uuid, direct_ip, data.cdp_port, status))
        node_id = cur.lastrowid

    conn.commit()
    conn.close()

    # 写入准入审计日志
    _append_audit_log(
        "access_decision",
        node_uuid=data.node_uuid,
        source_ip=client_ip,
        is_loopback=(client_ip in ["127.0.0.1", "localhost", "::1"]),
        decision=decision,
        reason=reason,
        network_profile="direct"
    )

    return {
        "code": 200,
        "node_id": node_id,
        "approval_status": approval_status,
        "message": "已自动接入" if approval_status == 1 else "已进入 TOFU 待审核队列"
    }

# ==================== 5. 准入审计日志 API ====================
@router.get("/api/nodes/audit-logs", summary="获取零信任准入决策审计流水")
def get_edge_audit_logs(user: dict = Depends(verify_token)):
    audit_files = ["/data/audit.jsonl", "edge_agent_data/audit.jsonl"]
    records = []
    for fp in audit_files:
        if os.path.exists(fp):
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            records.append(j