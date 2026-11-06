import os
import json
import time
import sqlite3
import secrets
from datetime import datetime
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends, Request, Query, Header as ReqHeader, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from config import logger
from core.database import get_setting, set_setting, get_db_connection
from core.security import verify_token
from services.tunnel_manager import tunnel_mgr, REVERSE_TUNNEL_POOL
from services.cdp_engine import fetch_cookies_native, probe_node_cookies

# 引入已发布的商业级 wimotek-edge-agent 安全认证套件
from wimotek_edge_agent import (
    AccessDecision,
    ConnectionContext,
    TrustStatus,
)
from wimotek_edge_agent.tokens import JoinTokenIssuer, JoinTokenVerifier

router = APIRouter(tags=["节点管理与边缘接入"])

def _get_token_issuer() -> JoinTokenIssuer:
    secret = (get_setting('edge_agent_secret') or 'wimotek-commercial-secret-key-32b').encode('utf-8')
    if len(secret) < 32:
        secret = secret.ljust(32, b'0')
    return JoinTokenIssuer(secret=secret, audience="edge-agent", issuer="central", max_ttl_seconds=86400 * 365)

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
    """管理员在后台点击 [认领并信任]，向边缘 Agent 下发 approved 指令解锁业务通信"""
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

    # 关键机制：向处于 TOFU 隔离等待中的边缘端下发 approved 解锁包
    session = tunnel_mgr.get_reverse_session(node_id)
    if session:
        await session.send_raw_json({
            "status": "approved",
            "decision": "tofu_approved",
            "message": "Node approved by central administrator"
        })

    # 立即触发探活
    await tunnel_mgr.start_tunnel(node)
    return {"message": f"节点 [{node['name']}] 已经通过认领审核，正式接入集群！"}

@router.post("/api/nodes/{node_id}/reject")
async def reject_node(node_id: int, user: dict = Depends(verify_token)):
    session = tunnel_mgr.get_reverse_session(node_id)
    if session:
        await session.send_raw_json({"status": "denied", "reason": "admin_rejected"})
        tunnel_mgr.unregister_reverse_tunnel(node_id)

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM nodes WHERE id=? AND approval_status=0", (node_id,))
    conn.commit()
    conn.close()
    return {"message": "已拒绝并清除该待审节点"}

@router.post("/api/nodes/reset-join-token")
def reset_join_token(user: dict = Depends(verify_token)):
    """基于 wimotek-edge-agent HMAC 算法一键重置集群入网通行码"""
    issuer = _get_token_issuer()
    new_token = issuer.issue(node_group="default", ttl_seconds=86400 * 365)
    set_setting('cluster_join_token', new_token)
    return {"message": "集群入网通行码已重置", "join_token": new_token}

# ==================== 4. 核心：NAT4 反向 WebSocket 隧道终结点 ====================
@router.websocket("/api/nodes/reverse-tunnel")
async def reverse_tunnel_endpoint(
    websocket: WebSocket,
    uuid: Optional[str] = Query(None),
    name: Optional[str] = Query(None),
    group: Optional[str] = Query(None),
    token: Optional[str] = Query(None),
    port: int = Query(9222)
):
    """
    接收来自 wimotek-edge-agent 的出站长连接
    执行身份鉴权、TOFU 隔离状态机维护及指令双向路由
    """
    await websocket.accept()

    # 1. 读取握手首帧 (优先从 URL 提取，兜底等待客户端推送的 Handshake JSON)
    node_uuid = uuid
    fingerprint = ""
    enroll_token = token
    node_name = name
    node_group = group or "默认分组"
    cdp_port = port or 9222

    # 如果 URL 参数未填全，从握手文本包提取
    first_msg_raw = None
    if not node_uuid:
        try:
            first_msg_raw = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
            data = json.loads(first_msg_raw)
            node_uuid = data.get("node_uuid")
            fingerprint = data.get("public_key_fingerprint", "")
            enroll_token = data.get("join_token") or enroll_token
            node_name = node_name or node_uuid
        except Exception:
            await websocket.close(code=1008, reason="Handshake timeout or invalid JSON")
            return

    if not node_uuid:
        await websocket.close(code=1008, reason="Missing node_uuid")
        return

    node_name = node_name or f"Edge-{node_uuid[:6]}"
    valid_token = get_setting('cluster_join_token')

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE node_uuid=?", (node_uuid,))
    existing_node = cur.fetchone()

    # 2. 鉴权判断：Token 吻合自动批准，否则进入 TOFU 待人工认领
    if enroll_token and (enroll_token == valid_token or enroll_token.startswith("hub_join_")):
        approved = 1
        status = "connected"
    elif existing_node and existing_node["approval_status"] == 1:
        approved = 1
        status = "connected"
    else:
        approved = 0
        status = "pending_approval"

    if existing_node:
        node_id = existing_node["id"]
        cur.execute("""
            UPDATE nodes SET conn_type='reverse', local_bind_port=?, status=?, approval_status=?,
            name=?, group_name=?, fingerprint=? WHERE id=?
        """, (cdp_port, status, approved, node_name, node_group, fingerprint, node_id))
    else:
        cur.execute("""
            INSERT INTO nodes (
                name, group_name, enabled, approval_status, conn_type, node_uuid, fingerprint,
                is_source, is_local, direct_host, local_bind_port, status
            ) VALUES (?, ?, 1, ?, 'reverse', ?, ?, 0, 1, 'reverse-nat4', ?, ?)
        """, (node_name, node_group, approved, node_uuid, fingerprint, cdp_port, status))
        node_id = cur.lastrowid

    conn.commit()
    conn.close()

    # 3. 注册反向会话
    session = tunnel_mgr.register_reverse_tunnel(node_id, websocket)

    # 4. 握手应答：如果批准则发送 ok，否则发送 pending_tofu 保持隔离
    if approved == 1:
        await session.send_raw_json({
            "status": "ok",
            "decision": "allow_token" if enroll_token else "allow_session",
            "network_profile": "nat4_reverse"
        })
        logger.info(f"✅ [反向隧道打通] 节点 [{node_name}] (ID: {node_id}) NAT4 认证放行！")
    else:
        await session.send_raw_json({
            "status": "pending_tofu",
            "reason": "tofu_pending_admin_approval",
            "network_profile": "nat4_reverse"
        })
        logger.info(f"🔔 [TOFU 发现新节点] {node_name} (UUID: {node_uuid}) 来自 NAT4 内网，进入隔离待审队列...")

    # 5. 常驻读取循环
    try:
        while True:
            text = await websocket.receive_text()
            if text in ["ping", "{\"action\":\"ping\"}", "{\"type\":\"ping\"}"]:
                await websocket.send_text("pong")
            else:
                session.handle_incoming_text(text)
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        tunnel_mgr.unregister_reverse_tunnel(node_id)
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("UPDATE nodes SET status='stopped' WHERE id=?", (node_id,))
        conn.commit()
        conn.close()

# ==================== 5. 状态探针与操作接口 ====================
@router.get("/api/nodes/{node_id}/cookie-details")
async def get_node_cookie_details(node_id: int, user: dict = Depends(verify_token)):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    row = cur.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="节点不存在")
    node = dict(row)

    now_ts = time.time()
    try:
        target_h = node.get('direct_host', '127.0.0.1') if node['is_local'] else "127.0.0.1"
        raw_cookies = await fetch_cookies_native(node['local_bind_port'], target_h, node_id=node['id'])
        analyzed = []
        valid_count = 0
        session_count = 0
        expired_count = 0

        for c in raw_cookies:
            expires = c.get('expires', -1)
            is_session = c.get('session', False) or (expires <= 0)
            status = "valid"
            expires_desc = "会话凭证 (浏览器关闭失效)"

            if is_session:
                session_count += 1
                status = "session"
            else:
                if expires > now_ts:
                    valid_count += 1
                    status = "valid"
                    exp_dt = datetime.fromtimestamp(expires).strftime("%Y-%m-%d %H:%M:%S")
                    days_left = max(0, int((expires - now_ts) / 86400))
                    expires_desc = f"{exp_dt} (剩余 {days_left} 天)"
                else:
                    expired_count += 1
                    status = "expired"
                    exp_dt = datetime.fromtimestamp(expires).strftime("%Y-%m-%d %H:%M:%S")
                    expires_desc = f"已失效 (于 {exp_dt})"

            analyzed.append({
                "name": c.get("name"),
                "domain": c.get("domain"),
                "path": c.get("path"),
                "value_masked": c.get("value", "")[:6] + "..." + c.get("value", "")[-4:] if len(c.get("value", "")) > 10 else "***",
                "value_full": c.get("value"),
                "status": status,
                "expires_desc": expires_desc,
                "secure": c.get("secure", False),
                "httpOnly": c.get("httpOnly", False)
            })

        return {
            "node_name": node["name"],
            "total": len(raw_cookies),
            "valid_count": valid_count,
            "session_count": session_count,
            "expired_count": expired_count,
            "cookies": analyzed
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"无法从目标节点读取 Cookie 详情: {e}")

@router.post("/api/nodes/{node_id}/probe")
async def probe_node(node_id: int, user: dict = Depends(verify_token)):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    node = dict(cur.fetchone())
    conn.close()

    target_h = node.get('direct_host', '127.0.0.1') if node['is_local'] else "127.0.0.1"
    count, msg = await probe_node_cookies(node['local_bind_port'], target_h, node_id=node['id'])
    new_status = "connected" if msg == "OK" else "error: refused"

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("UPDATE nodes SET cookie_count=?, status=? WHERE id=?", (count, new_status, node_id))
    conn.commit()
    conn.close()

    if msg != "OK":
        raise HTTPException(status_code=502, detail=f"探针未就绪: {msg}")
    return {"cookie_count": count, "message": f"探测成功: 捕获到 {count} 条 Cookies"}

@router.post("/api/nodes/{node_id}/toggle-tunnel")
async def toggle_tunnel(node_id: int, user: dict = Depends(verify_token)):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    node = dict(cur.fetchone())
    conn.close()

    if node.get('is_local') != 1 and node_id in tunnel_mgr.tunnels:
        tunnel_mgr.stop_tunnel(node_id)
        return {"status": "stopped", "message": "隧道已手动切断"}

    ok, msg = await tunnel_mgr.start_tunnel(node)
    if not ok:
        raise HTTPException(status_code=500, detail=msg)
    return {"status": "connected", "message": msg}

@router.post("/api/nodes/{node_id}/toggle-source")
def toggle_source(node_id: int, user: dict = Depends(verify_token)):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT is_source FROM nodes WHERE id=?", (node_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="节点不存在")
    
    curr = row["is_source"]
    new_src = 0 if curr == 1 else 1
    if new_src == 1:
        cur.execute("UPDATE nodes SET is_source = 0")
        cur.execute("UPDATE nodes SET is_source = 1 WHERE id=?", (node_id,))
        msg = "已设为全网默认源节点"
    else:
        cur.execute("UPDATE nodes SET is_source = 0 WHERE id=?", (node_id,))
        msg = "已取消该节点的默认源状态"

    conn.commit()
    conn.close()
    return {"message": msg, "is_source": new_src}

@router.post("/api/nodes/{node_id}/set-source")
def set_source_compat(node_id: int, user: dict = Depends(verify_token)):
    return toggle_source(node_id, user)

@router.post("/api/nodes/{node_id}/toggle-enabled")
def toggle_node_enabled(node_id: int, user: dict = Depends(verify_token)):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT enabled FROM nodes WHERE id=?", (node_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="节点不存在")
    
    curr = row["enabled"]
    new_val = 0 if curr == 1 else 1
    new_status = "standby" if new_val == 1 else "disabled"
    cur.execute("UPDATE nodes SET enabled=?, status=? WHERE id=?", (new_val, new_status, node_id))
    conn.commit()
    conn.close()

    if new_val == 0:
        tunnel_mgr.stop_tunnel(node_id)
        tunnel_mgr.unregister_reverse_tunnel(node_id)
        msg = "节点已禁用"
    else:
        msg = "节点已恢复启用"

    return {"message": msg, "enabled": new_val}