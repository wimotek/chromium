import sqlite3
import time
from datetime import datetime
from fastapi import APIRouter, HTTPException, Depends
from core.config import DB_PATH
from core.security import verify_token
from services.tunnel_manager import tunnel_mgr
from services.cdp_engine import fetch_cookies_native, probe_node_cookies

router = APIRouter(tags=["节点管理"])

@router.get("/api/nodes")
def list_nodes(user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

@router.post("/api/nodes")
def create_node(data: dict, user: dict = Depends(verify_token)):
    is_local = 1 if data.get('is_local') else 0
    direct_h = (data.get('direct_host') or '127.0.0.1').strip()
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute('''INSERT INTO nodes (
        name, is_source, is_local, direct_host, ssh_host, ssh_port, ssh_user, ssh_key_filename,
        ssh_password, remote_cdp_port, local_bind_port, cookie_count, auto_tunnel, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'stopped')''',
    (
        data['name'], 1 if data.get('is_source') else 0, is_local,
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
    return {"message": "节点配置已写入，后台已自动激活默认穿透"}

@router.put("/api/nodes/{node_id}")
async def update_node(node_id: int, data: dict, user: dict = Depends(verify_token)):
    is_local = 1 if data.get('is_local') else 0
    direct_h = (data.get('direct_host') or '127.0.0.1').strip()
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute('''UPDATE nodes SET 
        name=?, is_local=?, direct_host=?, ssh_host=?, ssh_port=?, ssh_user=?, 
        ssh_key_filename=?, ssh_password=?, remote_cdp_port=?, local_bind_port=?
        WHERE id=?''',
    (
        data['name'], is_local,
        direct_h if is_local else '127.0.0.1',
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
    conn.close()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    updated_node = dict(cur.fetchone())
    conn.close()
    await tunnel_mgr.start_tunnel(updated_node)

    return {"message": "节点配置已更新并重新载入连接"}

@router.delete("/api/nodes/{node_id}")
def delete_node(node_id: int, user: dict = Depends(verify_token)):
    tunnel_mgr.stop_tunnel(node_id)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("DELETE FROM nodes WHERE id=?", (node_id,))
    conn.commit()
    conn.close()
    return {"message": "节点已删除"}

@router.get("/api/nodes/{node_id}/cookie-details")
async def get_node_cookie_details(node_id: int, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
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
        raw_cookies = await fetch_cookies_native(node['local_bind_port'], target_h)
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
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    node = dict(cur.fetchone())
    conn.close()

    target_h = node.get('direct_host', '127.0.0.1') if node['is_local'] else "127.0.0.1"
    count, msg = await probe_node_cookies(node['local_bind_port'], target_h)
    new_status = "connected" if msg == "OK" else "error: refused"

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("UPDATE nodes SET cookie_count=?, status=? WHERE id=?", (count, new_status, node_id))
    conn.commit()
    conn.close()

    if msg != "OK":
        raise HTTPException(status_code=502, detail=f"探针未就绪 ({target_h}:{node['local_bind_port']}): {msg}")
    return {"cookie_count": count, "message": f"探测成功: 捕获到 {count} 条 Cookies"}

@router.post("/api/nodes/{node_id}/toggle-tunnel")
async def toggle_tunnel(node_id: int, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
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
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT is_source FROM nodes WHERE id=?", (node_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="节点不存在")
    
    curr = row["is_source"]
    if curr == 1:
        cur.execute("UPDATE nodes SET is_source = 0 WHERE id=?", (node_id,))
        msg = "已取消该节点的默认源状态"
        is_src = 0
    else:
        cur.execute("UPDATE nodes SET is_source = 0")
        cur.execute("UPDATE nodes SET is_source = 1 WHERE id=?", (node_id,))
        msg = "已设为全网默认源节点"
        is_src = 1

    conn.commit()
    conn.close()
    return {"message": msg, "is_source": is_src}

@router.post("/api/nodes/{node_id}/set-source")
def set_source_compat(node_id: int, user: dict = Depends(verify_token)):
    return toggle_source(node_id, user)