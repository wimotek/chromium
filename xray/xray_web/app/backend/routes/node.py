import re
import datetime
from flask import Blueprint, request, jsonify
from core.db import get_db
from routes import get_node_snis

node_bp = Blueprint('node_bp', __name__)

@node_bp.route('/api/node/heartbeat', methods=['POST'])
def node_heartbeat():
    data = request.json or {}
    node_id = data.get("node_id", "").strip()
    node_key = data.get("node_key", "").strip()
    node_ip = data.get("ip")
    node_port = int(data.get("port", 443))
    raw_pbk = data.get("pbk", "").strip()
    sid = data.get("sid", "").strip()
    raw_dest = data.get("dest", "www.microsoft.com:443").strip()
    raw_sni = data.get("sni", "www.microsoft.com").strip()
    raw_server_names = data.get("server_names", "").strip()
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if not node_id:
        return jsonify({"code": 400, "msg": "缺少 node_id"}), 400

    dest = raw_dest if ":" in raw_dest else f"{raw_dest}:443"

    snis = []
    for part in re.split(r'[,;\s]+', raw_server_names or raw_sni):
        clean = part.strip().split(":")[0]
        if clean and clean not in snis:
            snis.append(clean)
    server_names_str = ",".join(snis)
    primary_sni = snis[0] if snis else "www.microsoft.com"

    # 43 位公钥智能提取
    pbk = raw_pbk
    if len(pbk) != 43:
        matches = re.findall(r'[A-Za-z0-9_\-]{43}', pbk)
        if len(matches) >= 2:
            pbk = matches[1]
        elif len(matches) == 1:
            pbk = matches[0]

    if len(pbk) != 43:
        return jsonify({"code": 400, "msg": f"公钥格式错误 (原长度: {len(raw_pbk)})"}), 400

    conn = get_db()
    c = conn.cursor()

    # 自动将相同 IP 和端口的其它旧节点标记为下线，确保新实例自动接管
    c.execute("""
        UPDATE nodes 
        SET status=0, last_heartbeat='已下线 (新节点接管)' 
        WHERE ip=? AND port=? AND node_id!=?
    """, (node_ip, node_port, node_id))

    c.execute("SELECT * FROM nodes WHERE node_id=?", (node_id,))
    node = c.fetchone()

    # 场景 1：全新节点首次接入
    if not node:
        auto_name = f"节点-{node_ip}"
        c.execute("""
            INSERT INTO nodes 
            (node_id, node_key, pending_key, name, ip, port, dest, sni, server_names, pbk, sid, status, last_heartbeat) 
            VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        """, (node_id, node_key, auto_name, node_ip, node_port, dest, primary_sni, server_names_str, pbk, sid, now_str))
        conn.commit()
        conn.close()
        return jsonify({"code": 200, "msg": "新节点首次接入成功！旧实例已自动标记下线。"})

    current_key = node["node_key"]
    pending_key = node["pending_key"]

    # 场景 2：重置上报熔断保护 (pending_key='FORCE_RESYNC')
    if pending_key == 'FORCE_RESYNC':
        c.execute("""
            UPDATE nodes 
            SET node_key=?, pending_key='', ip=?, pbk=?, sid=COALESCE(NULLIF(?, ''), sid), status=1, last_heartbeat=? 
            WHERE node_id=?
        """, (node_key, node_ip, pbk, sid, now_str, node_id))
        conn.commit()
        conn.close()
        return jsonify({"code": 200, "msg": "重置接纳完成，密钥与公钥已重新绑定生效！"})

    if pending_key and node_key == current_key:
        c.execute("""
            UPDATE nodes 
            SET node_key=?, pending_key='', ip=?, pbk=?, sid=COALESCE(NULLIF(?, ''), sid), status=1, last_heartbeat=? 
            WHERE node_id=?
        """, (pending_key, node_ip, pbk, sid, now_str, node_id))
        conn.commit()
        conn.close()
        return jsonify({"code": 200, "msg": "心跳成功，已为您同步下发新密钥", "new_node_key": pending_key})

    # 场景 3：正常心跳 (强校验 node_key)
    if node_key == current_key:
        c.execute("""
            UPDATE nodes 
            SET ip=?, pbk=?, sid=COALESCE(NULLIF(sid, ''), ?), status=1, last_heartbeat=? 
            WHERE node_id=?
        """, (node_ip, pbk, sid, now_str, node_id))
        conn.commit()
        conn.close()
        return jsonify({"code": 200, "msg": "心跳正常"})

    conn.close()
    return jsonify({"code": 403, "msg": "Node Key 验证失败"}), 403

@node_bp.route('/api/node/sync', methods=['GET'])
def node_sync_users():
    node_id = request.args.get('node_id', '').strip()
    token = request.args.get('token', '').strip()

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM nodes WHERE node_id=?", (node_id,))
    node = c.fetchone()
    if not node or (node["node_key"] != token and node["pending_key"] != 'FORCE_RESYNC'):
        conn.close()
        return jsonify({"code": 403, "msg": "鉴权失败"}), 403

    c.execute("SELECT username, email, uuid FROM users WHERE status=1 AND is_verified=1")
    users = [{"id": u["uuid"], "flow": "xtls-rprx-vision", "email": u["email"]} for u in c.fetchall()]
    conn.close()

    snis = get_node_snis(dict(node))
    clean_dest = node["dest"] if (node["dest"] and ":" in node["dest"]) else f"{node['dest']}:443"

    node_config = {
        "port": node["port"],
        "dest": clean_dest,
        "sni": snis[0],
        "server_names": snis,
        "sid": node["sid"]
    }

    return jsonify({
        "code": 200,
        "node_config": node_config,
        "users": users
    })

# 合理定点流量累加 (精确至 0.01 MB ≈ 10KB)
@node_bp.route('/api/node/traffic', methods=['POST'])
def node_report_traffic():
    data = request.json or {}
    node_id = data.get("node_id", "").strip()
    token = data.get("token", "").strip()

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT node_key, pending_key FROM nodes WHERE node_id=?", (node_id,))
    node = c.fetchone()
    if not node or (node["node_key"] != token and node["pending_key"] != 'FORCE_RESYNC'):
        conn.close()
        return jsonify({"code": 403, "msg": "鉴权失败"}), 403

    updated_count = 0
    total_bytes = 0

    for item in data.get("traffic", []):
        account = item.get("email") or i