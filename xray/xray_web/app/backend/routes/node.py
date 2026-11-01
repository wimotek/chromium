import re
import datetime
import traceback
from flask import Blueprint, request, jsonify
from core.db import get_db
from routes import get_node_snis, is_user_allowed_for_node

node_bp = Blueprint('node_bp', __name__)

@node_bp.route('/api/node/heartbeat', methods=['POST'])
def node_heartbeat():
    try:
        data = request.get_json(force=True, silent=True) or {}
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

        c.execute("SELECT * FROM nodes WHERE node_id=?", (node_id,))
        node_row = c.fetchone()

        if not node_row:
            c.execute("SELECT id FROM nodes WHERE ip=? AND port=?", (node_ip, node_port))
            existing = c.fetchone()
            if existing:
                c.execute("""
                    UPDATE nodes 
                    SET node_id=?, node_key=?, pbk=?, sid=?, status=1, last_heartbeat=?, dest=?, sni=?, server_names=?
                    WHERE id=?
                """, (node_id, node_key, pbk, sid, now_str, dest, primary_sni, server_names_str, existing["id"]))
            else:
                auto_name = f"节点-{node_ip}"
                c.execute("""
                    INSERT INTO nodes 
                    (node_id, node_key, pending_key, name, ip, port, dest, sni, server_names, pbk, sid, status, last_heartbeat, allow_all, allowed_groups, allowed_users) 
                    VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, '', '')
                """, (node_id, node_key, auto_name, node_ip, node_port, dest, primary_sni, server_names_str, pbk, sid, now_str))

            conn.commit()
            conn.close()
            return jsonify({"code": 200, "msg": "节点上线握手成功！"})

        node = dict(node_row)
        current_key = node.get("node_key", "")
        pending_key = node.get("pending_key", "")

        if pending_key == 'FORCE_RESYNC':
            c.execute("""
                UPDATE nodes 
                SET node_key=?, pending_key='', ip=?, pbk=?, sid=COALESCE(NULLIF(?, ''), sid), status=1, last_heartbeat=? 
                WHERE node_id=?
            """, (node_key, node_ip, pbk, sid, now_str, node_id))
            conn.commit()
            conn.close()
            return jsonify({"code": 200, "msg": "重置接纳完成，密钥已更新！"})

        if pending_key and node_key == current_key:
            c.execute("""
                UPDATE nodes 
                SET node_key=?, pending_key='', ip=?, pbk=?, sid=COALESCE(NULLIF(sid, ''), ?), status=1, last_heartbeat=? 
                WHERE node_id=?
            """, (pending_key, node_ip, pbk, sid, now_str, node_id))
            conn.commit()
            conn.close()
            return jsonify({"code": 200, "msg": "心跳成功，已下发新密钥", "new_node_key": pending_key})

        if node_key == current_key or not current_key:
            c.execute("""
                UPDATE nodes 
                SET ip=?, pbk=?, sid=COALESCE(NULLIF(sid, ''), ?), last_heartbeat=? 
                WHERE node_id=?
            """, (node_ip, pbk, sid, now_str, node_id))
            conn.commit()
            conn.close()
            return jsonify({"code": 200, "msg": "心跳正常"})

        conn.close()
        return jsonify({"code": 403, "msg": "Node Key 验证失败"}), 403

    except Exception as e:
        traceback.print_exc()
        return jsonify({"code": 500, "msg": f"心跳处理异常: {str(e)}"}), 500

# 核心升级：根据节点是否禁用及允许范围，精准向节点下发可连接的客户端 UUID
@node_bp.route('/api/node/sync', methods=['GET'])
def node_sync_users():
    try:
        node_id = request.args.get('node_id', '').strip()
        token = request.args.get('token', '').strip()

        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT * FROM nodes WHERE node_id=?", (node_id,))
        node_row = c.fetchone()
        if not node_row:
            conn.close()
            return jsonify({"code": 403, "msg": "节点不存在"}), 403

        node = dict(node_row)
        if node.get("node_key") != token and node.get("pending_key") != 'FORCE_RESYNC':
            conn.close()
            return jsonify({"code": 403, "msg": "鉴权失败"}), 403

        # 核心逻辑 1：如果节点被管理员禁用 (status=0)，向节点下发空用户列表，切断所有连接！
        if int(node.get("status", 1)) == 0:
            conn.close()
            snis = get_node_snis(node)
            clean_dest = node["dest"] if (node.get("dest") and ":" in node["dest"]) else f"{node.get('dest', 'www.microsoft.com')}:443"
            return jsonify({
                "code": 200,
                "node_config": {
                    "port": node["port"],
                    "dest": clean_dest,
                    "sni": snis[0],
                    "server_names": snis,
                    "sid": node["sid"]
                },
                "users": []  # 下发空列表，彻底阻断
            })

        # 核心逻辑 2：节点为启用状态，根据用户组和特定用户权限进行筛选
        c.execute("SELECT username, email, uuid, user_group, role FROM users WHERE status=1 AND is_verified=1")
        all_users = [dict(u) for u in c.fetchall()]
        conn.close()

        allowed_users = [
            {"id": u["uuid"], "flow": "xtls-rprx-vision", "email": u["email"]}
            for u in all_users
            if is_user_allowed_for_node(u, node)
        ]

        snis = get_node_snis(node)
        clean_dest = node["dest"] if (node.get("dest") and ":" in node["dest"]) else f"{node.get('dest', 'www.microsoft.com')}:443"

        return jsonify({
            "code": 200,
            "node_config": {
                "port": node["port"],
                "dest": clean_dest,
                "sni": snis[0],
                "server_names": snis,
                "sid": node["sid"]
            },
            "users": allowed_users
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"code": 500, "msg": f"同步配置异常: {str(e)}"}), 500

@node_bp.route('/api/node/traffic', methods=['POST'])
def node_report_traffic():
    try:
        data = request.get_json(force=True, silent=True) or {}
        node_id = data.get("node_id", "").strip()
        token = data.get("token", "").strip()

        if not node_id:
            return jsonify({"code": 400, "msg": "缺少 node_id"}), 400

        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT * FROM nodes WHERE node_id=?", (node_id,))
        node_row = c.fetchone()
        if not node_row:
            conn.close()
            return jsonify({"code": 403, "msg": "节点未登记"}), 403

        node = dict(node_row)
        node_key = node.get("node_key", "")
        pending_key = node.get("pending_key", "")

        if node_key != token and pending_key != 'FORCE_RESYNC':
            conn.close()
            return jsonify({"code": 403, "msg": "鉴权失败"}), 403

        traffic_items = data.get("traffic", [])
        updated_count = 0
        total_bytes = 0

        for item in traffic_items:
            account = item.get("email") or item.get("username")
            inc_bytes = int(item.get("bytes", 0))
            if account and inc_bytes > 0:
                inc_mb = max(0.01, round(inc_bytes / (1024 * 1024), 2))
                c.execute("""
                    UPDATE users 
                    SET used_mb = ROUND(COALESCE(used_mb, 0) + ?, 2) 
                    WHERE email=? OR username=?
                """, (inc_mb, account, account))
                
                if c.rowcount > 0:
                    updated_count += 1
                total_bytes += inc_bytes

        conn.commit()
        conn.close()

        total_mb = round(total_bytes / (1024 * 1024), 3)
        return jsonify({
            "code": 200, 
            "msg": f"流量同步成功！已结算 {updated_count} 位用户 (累计 {total_mb}MB)"
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"code": 500, "msg": f"流量扣费异常: {str(e)}"}), 500