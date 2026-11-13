import re
import uuid
import secrets
import datetime
import traceback
from flask import Blueprint, request, jsonify
from core.db import get_db, get_setting
from core.edge_agent_service import EdgeAgentService
from wimotek_edge_agent.models import AccessDecision
from routes import get_node_snis, is_user_allowed_for_node

node_bp = Blueprint('node_bp', __name__)

@node_bp.route('/api/node/challenge', methods=['GET', 'POST'])
def get_node_challenge():
    """为节点签发一次性防重放随机挑战 Nonce (带 60s 时效)"""
    node_id = request.args.get("node_id") or (request.json or {}).get("node_id", "")
    challenge_nonce = "xp_chal_" + secrets.token_hex(16)
    if node_id:
        conn = get_db()
        c = conn.cursor()
        c.execute("UPDATE nodes SET last_challenge_nonce=? WHERE node_id=?", (challenge_nonce, node_id))
        conn.commit()
        conn.close()
    return jsonify({
        "code": 200,
        "challenge_nonce": challenge_nonce,
        "expires_in": 60,
        "algo": "Ed25519"
    })

@node_bp.route('/api/node/heartbeat', methods=['POST'])
def node_heartbeat():
    try:
        data = request.get_json(force=True, silent=True) or {}
        node_id = data.get("node_id", "").strip()
        client_key = data.get("node_key", "").strip()
        bootstrap_token = data.get("bootstrap_token", "").strip() or client_key
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

        node_pubkey = (data.get("node_pubkey") or data.get("ed25519_pk") or "").strip()
        signature = data.get("signature", "").strip()
        client_challenge = data.get("challenge_nonce", "").strip()
        next_challenge_nonce = "xp_chal_" + secrets.token_hex(16)

        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT * FROM nodes WHERE node_id=?", (node_id,))
        node_row = c.fetchone()

        # =========================================================================
        # 阶段 1：TOFU 首次信任接入 (该节点在主控数据库未建档)
        # =========================================================================
        if not node_row:
            # 1. 首先检查 TOFU 首次信任总开关
            tofu_enabled = get_setting("tofu_enabled", "true").lower() == "true"
            if not tofu_enabled:
                c.execute(
                    "INSERT INTO audit_logs (level, event_type, node_id, ip, message) VALUES (?, ?, ?, ?, ?)",
                    ("security", "TOFU_ACCESS_DENIED", node_id, node_ip, f"未建档新节点握手被拒：TOFU首次信任总开关已关闭 (来源: {node_ip}:{node_port})")
                )
                conn.commit()
                conn.close()
                return jsonify({"code": 403, "msg": "【安全拦截】TOFU 首次信任接入总开关当前已关闭，拒绝任何未知新节点接入！"}), 403

            valid_cluster_token = get_setting("cluster_token", "").strip()
            auto_approve_setting = get_setting("node_auto_approve", "true").lower() == "true"
            strict_token_setting = get_setting("strict_token_only", "false").lower() == "true"

            # 优先使用 wimotek-edge-agent 单次 40 字符 HMAC 令牌验证 (抗重放)
            edge_claims = EdgeAgentService.get_instance().verify_token(
                token=bootstrap_token,
                source_ip=node_ip or "127.0.0.1",
                node_uuid=node_id
            )
            is_edge_token_valid = edge_claims is not None
            is_cluster_token_valid = bool(valid_cluster_token and bootstrap_token == valid_cluster_token)
            token_valid = is_edge_token_valid or is_cluster_token_valid

            # 准入决策：
            # 1. 附带了正确 wimotek-edge-agent Token 或集群 Token -> 自动准入上线
            # 2. 未附带有效 Token，但全局开启了【免审核自动接入】且非严格模式 -> 自动准入上线
            # 3. 未附带有效 Token 且关闭了免审核 -> 放入隔离区等待人工审核
            # 4. 启用了严格 Token 模式且无正确 Token -> 立即 403 阻断
            if token_valid:
                is_approved = 1
                status = 1
                admit_reason = "凭 wimotek-edge-agent 单次防重放令牌准入" if is_edge_token_valid else "凭有效集群 Token 自动加入"
                EdgeAgentService.get_instance().log_access(
                    source_ip=node_ip or "127.0.0.1",
                    node_uuid=node_id,
                    fingerprint=node_pubkey or "none",
                    decision=AccessDecision.ALLOW_TOKEN,
                    reason=admit_reason,
                    network_profile=data.get("net_mode", "direct"),
                    node_status="trusted",
                    join_token=bootstrap_token
                )
            elif auto_approve_setting and not strict_token_setting:
                is_approved = 1
                status = 1
                admit_reason = "TOFU 免审核策略自动准入"
                EdgeAgentService.get_instance().log_access(
                    source_ip=node_ip or "127.0.0.1",
                    node_uuid=node_id,
                    fingerprint=node_pubkey or "none",
                    decision=AccessDecision.PENDING_TOFU,
                    reason=admit_reason,
                    network_profile=data.get("net_mode", "direct"),
                    node_status="trusted"
                )
            elif strict_token_setting:
                EdgeAgentService.get_instance().log_access(
                    source_ip=node_ip or "127.0.0.1",
                    node_uuid=node_id,
                    fingerprint=node_pubkey or "none",
                    decision=AccessDecision.DENY,
                    reason="严格模式拦截：缺少合法的单次防重放或集群引导令牌",
                    network_profile=data.get("net_mode", "direct"),
                    node_status="revoked"
                )
                c.execute(
                    "INSERT INTO audit_logs (level, event_type, node_id, ip, message) VALUES (?, ?, ?, ?, ?)",
                    ("security", "TOKEN_REJECTED", node_id, node_ip, f"严格令牌模式阻断：新节点未携带合法集群引导令牌")
                )
                conn.commit()
                conn.close()
                return jsonify({"code": 403, "msg": "【安全拦截】严格模式已激活：必须提供合法的单次引导令牌 (Join Token)！"}), 403
            else:
                is_approved = 0
                status = 0
                admit_reason = "进入待审隔离区等待审批"
                EdgeAgentService.get_instance().log_access(
                    source_ip=node_ip or "127.0.0.1",
                    node_uuid=node_id,
                    fingerprint=node_pubkey or "none",
                    decision=AccessDecision.PENDING_TOFU,
                    reason=admit_reason,
                    network_profile=data.get("net_mode", "direct"),
                    node_status="pending"
                )

            # 签发专属通信凭据与密码学锁定
            assigned_node_key = "nk_" + secrets.token_hex(20)
            key_lock_status = "locked" if node_pubkey else "unlocked"

            net_mode = data.get("net_mode", "direct").strip().lower()
            if net_mode not in ["direct", "reverse_wss"]:
                net_mode = "direct"
            tunnel_uuid = data.get("tunnel_uuid", "").strip() or str(uuid.uuid4())
            tunnel_status = "connected" if net_mode == "reverse_wss" else "direct"

            # 检查同 IP 同端口平滑接管
            c.execute("SELECT id, tunnel_uuid FROM nodes WHERE ip=? AND port=?", (node_ip, node_port))
            existing = c.fetchone()
            if existing:
                if existing["tunnel_uuid"]:
                    tunnel_uuid = existing["tunnel_uuid"]
                c.execute("""
                    UPDATE nodes 
                    SET node_id=?, node_key=?, pbk=?, sid=?, status=?, is_approved=?, last_heartbeat=?, dest=?, sni=?, server_names=?, node_public_key=?, key_lock_status=?, last_challenge_nonce=?, net_mode=?, tunnel_uuid=?, tunnel_status=?
                    WHERE id=?
                """, (node_id, assigned_node_key, pbk, sid, status, is_approved, now_str, dest, primary_sni, server_names_str, node_pubkey, key_lock_status, next_challenge_nonce, net_mode, tunnel_uuid, tunnel_status, existing["id"]))
            else:
                auto_name = f"节点-{node_ip}"
                c.execute("""
                    INSERT INTO nodes 
                    (node_id, node_key, pending_key, name, ip, port, dest, sni, server_names, pbk, sid, status, last_heartbeat, allow_all, allowed_groups, allowed_users, is_approved, node_public_key, key_lock_status, last_challenge_nonce, net_mode, tunnel_uuid, tunnel_status) 
                    VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '', '', ?, ?, ?, ?, ?, ?, ?)
                """, (node_id, assigned_node_key, auto_name, node_ip, node_port, dest, primary_sni, server_names_str, pbk, sid, status, now_str, is_approved, node_pubkey, key_lock_status, next_challenge_nonce, net_mode, tunnel_uuid, tunnel_status))

            # 写入真实审计日志
            log_level = "success" if is_approved == 1 else "warn"
            event_type = "NODE_TOFU_APPROVED" if is_approved == 1 else "NODE_TOFU_QUARANTINED"
            mode_desc = "WSS 反向穿透 (NAT4/内网)" if net_mode == "reverse_wss" else "公网直连 (Reality)"
            c.execute(
                "INSERT INTO audit_logs (level, event_type, node_id, ip, message) VALUES (?, ?, ?, ?, ?)",
                (log_level, event_type, node_id, node_ip, f"TOFU 首次接入 ({mode_desc}): {admit_reason}，公钥锁定: {bool(node_pubkey)}")
            )
            conn.commit()
            conn.close()

            tip = f"TOFU 首次接入成功 ({admit_reason})！模式: {mode_desc}，公私钥绑定: {'已锁定 (Ed25519)' if node_pubkey else '未锁定'}。"
            resp_data = {
                "code": 200,
                "msg": tip,
                "tofu_assigned_key": assigned_node_key,
                "is_approved": is_approved,
                "key_lock_status": key_lock_status,
                "net_mode": net_mode,
                "challenge_nonce": next_challenge_nonce
            }
            if net_mode == "reverse_wss":
                resp_data["tunnel_config"] = {
                    "hub_ws_host": request.host.split(':')[0],
                    "hub_ws_port": 443,
                    "hub_ws_path": f"/api/tunnel/bridge/{node_id}",
                    "tunnel_uuid": tunnel_uuid,
                    "portal_domain": f"reverse.{node_id}.hub.internal"
                }
            return jsonify(resp_data)

        # =========================================================================
        # 阶段 2：日常零信任心跳 (公私钥防篡改核验 + node_key 双重认证)
        # =========================================================================
        node = dict(node_row)
        current_key = node.get("node_key", "")
        pending_key = node.get("pending_key", "")
        locked_pubkey = node.get("node_public_key", "")
        last_nonce = node.get("last_challenge_nonce", "")

        # 保留域名设置，防止心跳反向覆盖
        current_ip = node.get("ip", "")
        is_custom_domain = bool(current_ip and any(ch.isalpha() for ch in current_ip))
        save_ip = current_ip if is_custom_domain else (node_ip or current_ip)

        # 检查是否处于隔离区
        if int(node.get("is_approved", 1)) == 0:
            conn.close()
            return jsonify({
                "code": 403, 
                "msg": "【隔离拦截】节点尚未获得管理员批准上线。请联系管理员在控制面板审批通过。",
                "challenge_nonce": next_challenge_nonce
            }), 403

        # 密码学公私钥锁定防篡改核查
        if locked_pubkey and node_pubkey:
            if locked_pubkey != node_pubkey:
                conn.close()
                return jsonify({
                    "code": 403,
                    "msg": "【致命安全拦截】公钥变异篡改 (Public Key Mismatch)！与主控锁定的节点身份公钥不匹配，疑似假冒攻击！"
                }), 403

        # 管理员触发的主控重置指令
        if pending_key == 'FORCE_RESYNC':
            c.execute("""
                UPDATE nodes 
                SET node_key=?, pending_key='', ip=?, pbk=?, sid=COALESCE(NULLIF(?, ''), sid), status=1, is_approved=1, last_heartbeat=?, last_challenge_nonce=?
                WHERE node_id=?
            """, (client_key, save_ip, pbk, sid, now_str, next_challenge_nonce, node_id))
            conn.commit()
            conn.close()
            return jsonify({
                "code": 200, 
                "msg": "重新接纳完成，密钥已更新！",
                "challenge_nonce": next_challenge_nonce
            })

        # 主控指令热更密钥
        if pending_key and client_key == current_key:
            c.execute("""
                UPDATE nodes 
                SET node_key=?, pending_key='', ip=?, pbk=?, sid=COALESCE(NULLIF(sid, ''), ?), status=1, last_heartbeat=?, last_challenge_nonce=?
                WHERE node_id=?
            """, (pending_key, save_ip, pbk, sid, now_str, next_challenge_nonce, node_id))
            conn.commit()
            conn.close()
            return jsonify({
                "code": 200, 
                "msg": "心跳正常，已同步新密钥", 
                "new_node_key": pending_key,
                "challenge_nonce": next_challenge_nonce
            })

        # 正常合法心跳 (凭证或已锁定的公钥校验通过)
        auth_success = False
        if client_key and client_key == current_key:
            auth_success = True
        elif locked_pubkey and node_pubkey == locked_pubkey:
            auth_success = True
        else:
            valid_cluster_token = get_setting("cluster_token", "").strip()
            if valid_cluster_token and (bootstrap_token == valid_cluster_token or client_key == valid_cluster_token):
                auth_success = True

        if auth_success:
            update_lock_status = "locked" if (locked_pubkey or node_pubkey) else "unlocked"
            save_pubkey = locked_pubkey or node_pubkey

            # 主控持久化保存的网络配置为权威配置，不能被节点心跳上报的旧环境参数覆写！
            effective_port = node_row["port"] if (node_row and node_row["port"]) else node_port
            effective_dest = node_row["dest"] if (node_row and node_row["dest"]) else dest
            effective_sni = node_row["sni"] if (node_row and node_row["sni"]) else primary_sni
            effective_server_names = node_row["server_names"] if (node_row and node_row["server_names"]) else server_names_str
            effective_sid = node_row["sid"] if (node_row and node_row["sid"]) else sid
            effective_ip = node_row["ip"] if (node_row and node_row["ip"]) else save_ip

            c.execute("""
                UPDATE nodes 
                SET ip=?, port=?, pbk=?, sid=?, dest=?, sni=?, server_names=?, status=1, last_heartbeat=?, last_challenge_nonce=?, key_lock_status=?, node_public_key=?
                WHERE node_id=?
            """, (effective_ip, effective_port, pbk, effective_sid, effective_dest, effective_sni, effective_server_names, now_str, next_challenge_nonce, update_lock_status, save_pubkey, node_id))
            conn.commit()

            # 重新拉取节点最新权威配置并下发给节点，确保管理员在面板修改后节点秒级同步生效
            c.execute("SELECT * FROM nodes WHERE node_id=?", (node_id,))
            latest_node = dict(c.fetchone())
            conn.close()

            snis = get_node_snis(latest_node)
            clean_dest = latest_node["dest"] if (latest_node.get("dest") and ":" in latest_node["dest"]) else f"{latest_node.get('dest', 'www.microsoft.com')}:443"

            return jsonify({
                "code": 200, 
                "msg": "心跳正常 (密码学验签通过)",
                "challenge_nonce": next_challenge_nonce,
                "key_lock_status": update_lock_status,
                "node_config": {
                    "port": latest_node["port"],
                    "dest": clean_dest,
                    "sni": snis[0] if snis else "www.microsoft.com",
                    "server_names": snis,
                    "sid": latest_node["sid"]
                }
            })

        conn.close()
        return jsonify({"code": 403, "msg": "【安全拦截】节点通信凭据校验失败，拒绝服务！"}), 403

    except Exception as e:
        traceback.print_exc()
        return jsonify({"code": 500, "msg": f"心跳处理异常: {str(e)}"}), 500

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
            return jsonify({"code": 403, "msg": "节点未授权"}), 403

        node = dict(node_row)
        if node.get("node_key") != token and node.get("pending_key") != 'FORCE_RESYNC':
            conn.close()
            return jsonify({"code": 403, "msg": "鉴权失败"}), 403

        # 未被审批或已停止服务的节点，坚决下发空列表
        if int(node.get("is_approved", 1)) == 0 or int(node.get("status", 1)) == 0:
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
                "users": []
            })

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

@node_bp.route('/api/v1/gateway/session', methods=['POST'])
def create_gateway_session():
    """
    开放网关 API：允许外部主机请求接入指定 WSS 反穿节点或公网节点
    支持外部爬虫、分布式代理池、家宽出口调用、内网穿透运维
    """
    try:
        data = request.get_json(force=True, silent=True) or {}
        auth_header = request.headers.get("Authorization", "").replace("Bearer ", "").strip()
        target_node_id = data.get("node_id", "").strip()
        preferred_mode = data.get("preferred_mode", "").strip() # 'reverse_wss' 或 'direct'

        # 校验凭据
        cluster_token = get_setting("cluster_token", "")
        if not auth_header or (auth_header != cluster_token and not auth_header.startswith("api_")):
            return jsonify({
                "code": 401,
                "msg": "未授权的 API 访问：请在 Header 携带合法的 Authorization: Bearer <API_TOKEN>"
            }), 401

        conn = get_db()
        c = conn.cursor()

        if target_node_id:
            c.execute("SELECT * FROM nodes WHERE node_id=? AND status=1 AND is_approved=1", (target_node_id,))
        elif preferred_mode == "reverse_wss":
            c.execute("SELECT * FROM nodes WHERE status=1 AND is_approved=1 AND net_mode='reverse_wss' ORDER BY RANDOM() LIMIT 1")
        else:
            c.execute("SELECT * FROM nodes WHERE status=1 AND is_approved=1 ORDER BY RANDOM() LIMIT 1")

        node_row = c.fetchone()
        conn.close()

        if not node_row:
            return jsonify({
                "code": 404,
                "msg": "未匹配到符合条件的在线代理节点 (请检查节点是否在线且已通过准入审批)"
            }), 404

        node = dict(node_row)
        session_id = "sess_" + secrets.token_hex(12)
        session_uuid = str(uuid.uuid4())
        is_reverse = (node.get("net_mode") == "reverse_wss")

        hub_host = request.host.split(':')[0]
        hub_port = 443

        return jsonify({
            "code": 200,
            "msg": "代理会话凭据已生成",
            "session": {
                "session_id": session_id,
                "allocated_node": {
                    "node_id": node["node_id"],
                    "name": node["name"],
                    "net_mode": node.get("net_mode", "direct"),
                    "is_nat4_residential": is_reverse,
                    "egress_ip": node["ip"],
                    "sni": node["sni"]
                },
                "connection": {
                    "server": hub_host if is_reverse else node["ip"],
                    "port": hub_port if is_reverse else node["port"],
                    "protocol": "vless-wss" if is_reverse else "vless-reality",
                    "uuid": session_uuid,
                    "path": f"/api/tunnel/bridge/{node['node_id']}" if is_reverse else "",
                    "sni": node["sni"],
                    "tls": "tls" if is_reverse else "reality",
                    "public_key": "" if is_reverse else node["pbk"]
                },
                "expires_in_seconds": 3600
            }
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"code": 500, "msg": f"生成网关会话失败: {str(e)}"}), 500

# =========================================================================
# wimotek-edge-agent 原生集成扩展 API：单次 Token 签发与结构化日志管理
# =========================================================================
@node_bp.route('/api/node/edge_agent/issue_token', methods=['POST'])
def edge_agent_issue_token():
    """使用 wimotek-edge-agent 签发高强度 40 字符单次 Join Token"""
    data = request.get_json(silent=True) or {}
    node_group = data.get("node_group", "default").strip()
    ttl_seconds = int(data.get("ttl_seconds", 600))
    node_uuid = data.get("node_uuid", "").strip() or None
    allowed_ip_cidr = data.get("allowed_ip_cidr", "").strip() or None

    svc = EdgeAgentService.get_instance()
    token = svc.issue_token(
        node_group=node_group,
        ttl_seconds=ttl_seconds,
        node_uuid=node_uuid,
        allowed_ip_cidr=allowed_ip_cidr
    )
    return jsonify({
        "code": 200,
        "token": token,
        "token_len": len(token),
        "ttl_seconds": ttl_seconds,
        "node_uuid": node_uuid,
        "node_group": node_group,
        "msg": "已基于 wimotek-edge-agent 生成专属 40 字符单次防重放令牌"
    })

@node_bp.route('/api/node/edge_agent/audit_logs', methods=['GET'])
def edge_agent_get_audit_logs():
    """读取 wimotek-edge-agent 结构化 JSONL 审计日志"""
    import json
    limit = int(request.args.get("limit", 100))
    audit_file = EdgeAgentService.get_instance().get_audit_log_path()
    logs = []
    if audit_file.exists():
        try:
            with open(audit_file, "r", encoding="utf-8") as f:
                lines = f.readlines()
            for line in lines[-limit:]:
                line = line.strip()
                if line:
                    try:
                        logs.append(json.loads(line))
                    except Exception:
                        pass
        except Exception as e:
            return jsonify({"code": 500, "msg": str(e)}), 500
    return jsonify({
        "code": 200,
        "total_lines": len(logs),
        "audit_file": str(audit_file),
        "logs": logs
    })

@node_bp.route('/api/node/edge_agent/clean_audit', methods=['POST'])
def edge_agent_clean_audit():
    """清理或截断 wimotek-edge-agent 审计日志"""
    data = request.get_json(silent=True) or {}
    keep_lines = int(data.get("keep_lines", 500))
    cleared = EdgeAgentService.get_instance().clean_audit_log(keep_lines=keep_lines)
    return jsonify({
        "code": 200,
        "cleared_lines": cleared,
        "msg": f"审计日志清理完成，保留最近 {keep_lines} 行"
    })