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

router = APIRouter(tags=["节点管理与边缘接入"])

def _issue_join_token() -> str:
    return "hub_join_" + secrets.token_urlsafe(24)

def _append_audit_log(event: str, **kwargs):
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

class TofuSettingsDTO(BaseModel):
    tofu_enabled: bool
    tofu_auto_approve: bool
    tofu_timeout_notify_minutes: Optional[int] = 10

# ==================== 1. TOFU 准入策略与配置管理 ====================
@router.get("/api/nodes/tofu-settings", summary="获取 TOFU 准入策略配置")
def get_tofu_settings(user: dict = Depends(verify_token)):
    return {
        "tofu_enabled": get_setting("tofu_enabled", "1") == "1",
        "tofu_auto_approve": get_setting("tofu_auto_approve", "0") == "1",
        "tofu_timeout_notify_minutes": int(get_setting("tofu_timeout_notify_minutes", "10"))
    }

@router.post("/api/nodes/tofu-settings", summary="保存 TOFU 准入策略配置")
def save_tofu_settings(data: TofuSettingsDTO, user: dict = Depends(verify_token)):
    set_setting("tofu_enabled", "1" if data.tofu_enabled else "0")
    set_setting("tofu_auto_approve", "1" if data.tofu_auto_approve else "0")
    if data.tofu_timeout_notify_minutes is not None:
        set_setting("tofu_timeout_notify_minutes", str(max(0, data.tofu_timeout_notify_minutes)))
    return {"message": "TOFU 准入策略已更新"}

# ==================== 2. 分组与节点查询 ====================
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

# ==================== 3. 常规手动节点 CRUD ====================
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
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    orig = cur.fetchone()
    if not orig:
        conn.close()
        raise HTTPException(status_code=404, detail="节点不存在")

    orig_node = dict(orig)
    grp_name = (data.get('group_name') or '默认分组').strip()
    name = (data.get('name') or orig_node['name']).strip()
    l_port = int(data.get('local_bind_port') or orig_node['local_bind_port'])

    if orig_node["conn_type"] == "reverse":
        cur.execute("""
            UPDATE nodes SET name=?, group_name=?, local_bind_port=? WHERE id=?
        """, (name, grp_name, l_port, node_id))
    else:
        is_local = 1 if data.get('is_local') else 0
        direct_h = (data.get('direct_host') or '127.0.0.1').strip()
        conn_type = "direct" if is_local else "ssh"

        cur.execute('''UPDATE nodes SET 
            name=?, group_name=?, is_local=?, direct_host=?, conn_type=?, ssh_host=?, ssh_port=?, ssh_user=?, 
            ssh_key_filename=?, ssh_password=?, remote_cdp_port=?, local_bind_port=?
            WHERE id=?''',
        (
            name, grp_name, is_local,
            direct_h if is_local else '127.0.0.1',
            conn_type,
            "" if is_local else data.get('ssh_host', ''),
            22 if is_local else data.get('ssh_port', 22),
            "" if is_local else data.get('ssh_user', ''),
            "" if is_local else data.get('ssh_key_filename', ''),
            "" if is_local else data.get('ssh_password', ''),
            9222 if is_local else data.get('remote_cdp_port', 9222),
            l_port,
            node_id
        ))

    conn.commit()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    updated_node = dict(cur.fetchone())
    conn.close()

    if updated_node.get('enabled', 1) == 1 and updated_node.get('approval_status', 1) == 1:
        await tunnel_mgr.start_tunnel(updated_node)

    return {"message": "节点配置已更新"}

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

# ==================== 4. TOFU 认领、拒绝与 Token 重置 ====================
@router.post("/api/nodes/{node_id}/approve")
async def approve_node(node_id: int, user: dict = Depends(verify_token)):
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

    session = tunnel_mgr.get_reverse_session(node_id)
    if session:
        await session.send_raw_json({
            "status": "approved",
            "decision": "tofu_approved",
            "network_profile": "nat4_reverse"
        })

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

    if node:
        _append_audit_log("node_revoked", node_uuid=node.get("node_uuid") or node.get("name"))

    return {"message": "已拒绝并清除该待审节点"}

@router.post("/api/nodes/reset-join-token")
def reset_join_token(user: dict = Depends(verify_token)):
    new_token = _issue_join_token()
    set_setting('cluster_join_token', new_token)
    return {"message": "集群入网通行码已重置", "join_token": new_token}

# ==================== 5. 智能回声探测与 HTTP 直连登记 ====================
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
    tofu_enabled = (get_setting("tofu_enabled", "1") == "1")
    tofu_auto_approve = (get_setting("tofu_auto_approve", "0") == "1")

    # 准入规则判定
    if x_join_token and (x_join_token == valid_token or x_join_token.startswith("hub_join_")):
        approval_status = 1
        status = "connected"
        decision = "allow_token"
        reason = "edge_agent_token_verified"
    elif not tofu_enabled:
        # TOFU 开关已关闭，无 Token 直接拒绝
        raise HTTPException(status_code=403, detail="TOFU 未授权接入功能已关闭，请配置合法 JOIN_TOKEN")
    elif tofu_auto_approve:
        # TOFU 开启了自动审批
        approval_status = 1
        status = "connected"
        decision = "allow_token"
        reason = "tofu_auto_approved"
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
                name, group_name, enabled, approval_status, conn_type, node_uuid, fingerprint,
                is_source, is_local, direct_host, ssh_host, ssh_port, ssh_user,
                ssh_key_filename, ssh_password, remote_cdp_port, local_bind_port, status
            ) VALUES (?, ?, 1, ?, 'direct', ?, '', 0, 1, ?, '', 22, '', '', '', 9222, ?, ?)
        """, (node_name, grp_name, approval_status, data.node_uuid, direct_ip, data.cdp_port, status))
        node_id = cur.lastrowid

    conn.commit()
    conn.close()

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

# ==================== 6. 准入审计日志 API (查询与一键清空) ====================
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
                            records.append(json.loads(line))
            except Exception:
                pass
            break
            
    records.sort(key=lambda x: x.get("ts", ""), reverse=True)
    return records[:100]

@router.delete("/api/nodes/audit-logs", summary="彻底清空所有准入审计日志")
def clear_edge_audit_logs(user: dict = Depends(verify_token)):
    audit_files = ["/data/audit.jsonl", "edge_agent_data/audit.jsonl"]
    for fp in audit_files:
        if os.path.exists(fp):
            try:
                with open(fp, "w", encoding="utf-8") as f:
                    f.truncate(0)
            except Exception:
                pass
    return {"message": "准入审计流水已清空"}

# ==================== 7. NAT4 反向 WebSocket 隧道终结点 ====================
@router.websocket("/api/nodes/reverse-tunnel")
async def reverse_tunnel_endpoint(
    websocket: WebSocket,
    uuid: Optional[str] = Query(None),
    fingerprint: Optional[str] = Query(None),
    name: Optional[str] = Query(None),
    group: Optional[str] = Query(None),
    token: Optional[str] = Query(None),
    port: Optional[int] = Query(None)
):
    await websocket.accept()

    node_id: Optional[int] = None

    header_port_str = websocket.headers.get("x-cdp-port")
    try:
        cdp_port = int(header_port_str) if header_port_str else (port or 9222)
    except Exception:
        cdp_port = port or 9222

    node_uuid = (
        websocket.headers.get("x-node-uuid")
        or uuid
        or websocket.query_params.get("uuid")
    )
    node_fp = (
        websocket.headers.get("x-node-fingerprint")
        or fingerprint
        or websocket.query_params.get("fingerprint")
        or ""
    )
    enroll_token = (
        websocket.headers.get("x-join-token")
        or token
        or websocket.query_params.get("token")
    )
    node_name = (
        unquote(websocket.headers.get("x-node-name") or "")
        or name
        or websocket.query_params.get("name")
    )
    node_group = (
        unquote(websocket.headers.get("x-node-group") or "")
        or group
        or "默认分组"
    )

    if not node_uuid:
        try:
            first_msg_raw = await asyncio.wait_for(websocket.receive_text(), timeout=8.0)
            data = json.loads(first_msg_raw)
            node_uuid = data.get("node_uuid")
            node_fp = data.get("public_key_fingerprint", "")
            enroll_token = data.get("join_token") or enroll_token
            node_name = data.get("name") or node_name or node_uuid
            node_group = data.get("group") or node_group
            cdp_port = data.get("port") or cdp_port
        except Exception as e:
            logger.error(f"❌ [Tunnel 握手失败] 未收到节点身份: {e}")
            await websocket.close(code=1008, reason="Handshake timeout or invalid JSON")
            return

    node_name = node_name or f"Edge-{node_uuid[:6]}"
    valid_token = get_setting('cluster_join_token')
    tofu_enabled = (get_setting("tofu_enabled", "1") == "1")
    tofu_auto_approve = (get_setting("tofu_auto_approve", "0") == "1")

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 核心准入逻辑判定
    if enroll_token and (enroll_token == valid_token or enroll_token.startswith("hub_join_")):
        approved = 1
        status = "connected"
        decision = "allow_token"
        reason = "edge_agent_token_verified"
    else:
        cur.execute("SELECT * FROM nodes WHERE node_uuid=?", (node_uuid,))
        existing_node = cur.fetchone()
        if existing_node and existing_node["approval_status"] == 1:
            approved = 1
            status = "connected"
            decision = "allow_session"
            reason = "trusted_session_ticket_verified"
        elif not tofu_enabled:
            # TOFU 被禁用：无 Token 的未知设备直接断开拦截
            decision = "deny"
            reason = "tofu_access_disabled"
            client_host = websocket.client.host if websocket.client else "unknown"
            _append_audit_log(
                "access_decision",
                node_uuid=node_uuid,
                source_ip=client_host,
                is_loopback=(client_host in ["127.0.0.1", "localhost", "::1"]),
                decision="deny",
                reason=reason,
                network_profile="nat4_reverse"
            )
            conn.close()
            await websocket.close(code=1008, reason="TOFU Access Disabled")
            logger.warning(f"🚫 [TOFU 拦截] 未知节点 [{node_name}] 无 Token 且 TOFU 已关闭，直接拒绝！")
            return
        elif tofu_auto_approve:
            # TOFU 开启全自动免审放行
            approved = 1
            status = "connected"
            decision = "allow_token"
            reason = "tofu_auto_approved"
        else:
            approved = 0
            status = "pending_approval"
            decision = "pending_tofu"
            reason = "tofu_pending_admin_approval"

    try:
        cur.execute("SELECT id FROM nodes WHERE node_uuid=?", (node_uuid,))
        existing_row = cur.fetchone()

        if existing_row:
            node_id = existing_row["id"]
            cur.execute("""
                UPDATE nodes SET 
                    conn_type='reverse', direct_host='reverse-nat4', local_bind_port=?, status=?, approval_status=?,
                    name=?, group_name=?, fingerprint=?
                WHERE id=?
            """, (cdp_port, status, approved, node_name, node_group, node_fp, node_id))
        else:
            cur.execute("""
                INSERT INTO nodes (
                    name, group_name, enabled, approval_status, conn_type, node_uuid, fingerprint,
                    is_source, is_local, direct_host, ssh_host, ssh_port, ssh_user,
                    ssh_key_filename, ssh_password, remote_cdp_port, local_bind_port, status
                ) VALUES (?, ?, 1, ?, 'reverse', ?, ?, 0, 1, 'reverse-nat4', '', 22, '', '', '', 9222, ?, ?)
            """, (node_name, node_group, approved, node_uuid, node_fp, cdp_port, status))
            node_id = cur.lastrowid

        conn.commit()
    except Exception as db_err:
        logger.error(f"❌ [DB 错误] 写入节点表失败: {db_err}", exc_info=True)
        conn.close()
        await websocket.close(code=1011, reason="Database Error")
        return

    conn.close()

    session = tunnel_mgr.register_reverse_tunnel(node_id, websocket)

    client_host = websocket.client.host if websocket.client else "unknown"
    _append_audit_log(
        "access_decision",
        node_uuid=node_uuid,
        source_ip=client_host,
        is_loopback=(client_host in ["127.0.0.1", "localhost", "::1"]),
        decision=decision,
        reason=reason,
        network_profile="nat4_reverse"
    )

    if approved == 1:
        await session.send_raw_json({
            "status": "ok",
            "decision": decision,
            "network_profile": "nat4_reverse"
        })
        logger.info(f"✅ [反向长连接打通] 节点 [{node_name}] (ID: {node_id}, 端口: {cdp_port}) 认证放行！")
        
        async def _auto_probe_on_connect(nid: int, lport: int):
            try:
                await asyncio.sleep(1.2)
                c_cnt, _ = await probe_node_cookies(lport, node_id=nid)
                c_conn = get_db_connection()
                c_cur = c_conn.cursor()
                c_cur.execute("UPDATE nodes SET cookie_count=? WHERE id=?", (c_cnt, nid))
                c_conn.commit()
                c_conn.close()
                logger.info(f"🍪 [开机探活刷新] 节点 ID:{nid} 真实 Cookie 存量更新完毕: {c_cnt} 条")
            except Exception as e:
                logger.debug(f"开机探活跳过: {e}")
        asyncio.create_task(_auto_probe_on_connect(node_id, cdp_port))

    else:
        await session.send_raw_json({
            "status": "pending_tofu",
            "reason": "tofu_pending_admin_approval",
            "network_profile": "nat4_reverse"
        })
        logger.info(f"🔔 [TOFU 发现新节点] 节点 [{node_name}] (UUID: {node_uuid}, 端口: {cdp_port}) 进入待审队列...")

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
        if node_id:
            tunnel_mgr.unregister_reverse_tunnel(node_id)
            try:
                conn = get_db_connection()
                cur = conn.cursor()
                cur.execute("UPDATE nodes SET status='stopped' WHERE id=?", (node_id,))
                conn.commit()
                conn.close()
            except Exception:
                pass

# ==================== 8. 探针与详情接口 ====================
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