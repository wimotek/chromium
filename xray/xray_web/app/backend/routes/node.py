import json
import re
import secrets
import traceback
import uuid
import datetime

from flask import Blueprint, jsonify, request
from sqlalchemy import case, func, or_, select
from wimotek_edge_agent.models import AccessDecision

from core.db import (
    db_session,
    get_cached_active_users,
    get_setting,
    invalidate_nodes_cache,
    random_order_expr,
)
from core.edge_agent_service import EdgeAgentService
from core.models import AuditLog, Node, User
from routes import get_node_snis, is_user_allowed_for_node, resolve_public_endpoint

node_bp = Blueprint("node_bp", __name__)


@node_bp.route("/api/node/challenge", methods=["GET", "POST"])
def get_node_challenge():
    """为节点签发一次性防重放随机挑战 Nonce (带 60s 时效)"""
    node_id = request.args.get("node_id") or (request.json or {}).get("node_id", "")
    challenge_nonce = "xp_chal_" + secrets.token_hex(16)
    if node_id:
        with db_session() as s:
            node_obj = s.scalar(select(Node).where(Node.node_id == node_id))
            if node_obj:
                node_obj.last_challenge_nonce = challenge_nonce
    return jsonify({
        "code": 200,
        "challenge_nonce": challenge_nonce,
        "expires_in": 60,
        "algo": "Ed25519",
    })


@node_bp.route("/api/node/heartbeat", methods=["POST"])
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
        for part in re.split(r"[,;\s]+", raw_server_names or raw_sni):
            clean = part.strip().split(":")[0]
            if clean and clean not in snis:
                snis.append(clean)
        server_names_str = ",".join(snis)
        primary_sni = snis[0] if snis else "www.microsoft.com"

        pbk = raw_pbk
        if len(pbk) != 43:
            matches = re.findall(r"[A-Za-z0-9_\-]{43}", pbk)
            if len(matches) >= 2:
                pbk = matches[1]
            elif len(matches) == 1:
                pbk = matches[0]

        if len(pbk) != 43:
            return jsonify({"code": 400, "msg": f"公钥格式错误 (原长度: {len(raw_pbk)})"}), 400

        node_pubkey = (data.get("node_pubkey") or data.get("ed25519_pk") or "").strip()
        next_challenge_nonce = "xp_chal_" + secrets.token_hex(16)

        with db_session() as s:
            node_obj = s.scalar(select(Node).where(Node.node_id == node_id))

            # =========================================================================
            # 阶段 1：TOFU 首次信任接入 (该节点在主控数据库未建档)
            # =========================================================================
            if not node_obj:
                tofu_enabled = get_setting("tofu_enabled", "true").lower() == "true"
                if not tofu_enabled:
                    s.add(
                        AuditLog(
                            level="security",
                            event_type="TOFU_ACCESS_DENIED",
                            node_id=node_id,
                            ip=str(node_ip or ""),
                            message=f"未建档新节点握手被拒：TOFU首次信任总开关已关闭 (来源: {node_ip}:{node_port})",
                        )
                    )
                    return jsonify({"code": 403, "msg": "【安全拦截】TOFU 首次信任接入总开关当前已关闭，拒绝任何未知新节点接入！"}), 403

                valid_cluster_token = get_setting("cluster_token", "").strip()
                auto_approve_setting = get_setting("node_auto_approve", "true").lower() == "true"
                strict_token_setting = get_setting("strict_token_only", "false").lower() == "true"

                reported_mode = data.get("net_mode", "auto").strip().lower()
                v4_in = data.get("public_ipv4") or (node_ip if (node_ip and ":" not in str(node_ip)) else None)
                v6_in = data.get("public_ipv6") or (node_ip if (node_ip and ":" in str(node_ip)) else None)
                v4_port = int(data.get("public_ipv4_port") or node_port)
                v6_port = int(data.get("public_ipv6_port") or node_port)

                edge_svc = EdgeAgentService.get_instance()
                net_mode, probed_ip, det_result = edge_svc.probe_node_network(
                    public_ipv4=v4_in,
                    public_ipv4_port=v4_port,
                    public_ipv6=v6_in,
                    public_ipv6_port=v6_port,
                    preferred_mode=reported_mode,
                    remote_addr=request.remote_addr,
                )
                node_ip = probed_ip or node_ip or request.remote_addr or "127.0.0.1"

                edge_claims = edge_svc.verify_token(
                    token=bootstrap_token,
                    source_ip=node_ip,
                    node_uuid=node_id,
                )
                is_edge_token_valid = edge_claims is not None
                is_cluster_token_valid = bool(valid_cluster_token and bootstrap_token == valid_cluster_token)
                token_valid = is_edge_token_valid or is_cluster_token_valid

                if token_valid:
                    is_approved = 1
                    status = 1
                    admit_reason = "凭 wimotek-edge-agent 单次防重放令牌准入" if is_edge_token_valid else "凭有效集群 Token 自动加入"
                    edge_svc.log_access(
                        source_ip=node_ip,
                        node_uuid=node_id,
                        fingerprint=node_pubkey or "none",
                        decision=AccessDecision.ALLOW_TOKEN,
                        reason=admit_reason,
                        network_profile=det_result.network_profile,
                        network_mode=det_result.network_mode,
                        node_status="trusted",
                    )
                elif auto_approve_setting and not strict_token_setting:
                    is_approved = 1
                    status = 1
                    admit_reason = "TOFU 免审核策略自动准入"
                    edge_svc.log_access(
                        source_ip=node_ip,
                        node_uuid=node_id,
                        fingerprint=node_pubkey or "none",
                        decision=AccessDecision.PENDING_TOFU,
                        reason=admit_reason,
                        network_profile=det_result.network_profile,
                        network_mode=det_result.network_mode,
                        node_status="trusted",
                    )
                elif strict_token_setting:
                    edge_svc.log_access(
                        source_ip=node_ip,
                        node_uuid=node_id,
                        fingerprint=node_pubkey or "none",
                        decision=AccessDecision.DENY,
                        reason="严格模式拦截：缺少合法的单次防重放或集群引导令牌",
                        network_profile=det_result.network_profile,
                        network_mode=det_result.network_mode,
                        node_status="revoked",
                    )
                    s.add(
                        AuditLog(
                            level="security",
                            event_type="TOKEN_REJECTED",
                            node_id=node_id,
                            ip=str(node_ip),
                            message="严格令牌模式阻断：新节点未携带合法集群引导令牌",
                        )
                    )
                    return jsonify({"code": 403, "msg": "【安全拦截】严格模式已激活：必须提供合法的单次引导令牌 (Join Token)！"}), 403
                else:
                    is_approved = 0
                    status = 0
                    admit_reason = "进入待审隔离区等待审批"
                    edge_svc.log_access(
                        source_ip=node_ip,
                        node_uuid=node_id,
                        fingerprint=node_pubkey or "none",
                        decision=AccessDecision.PENDING_TOFU,
                        reason=admit_reason,
                        network_profile=det_result.network_profile,
                        network_mode=det_result.network_mode,
                        node_status="pending",
                    )

                assigned_node_key = "nk_" + secrets.token_hex(20)
                key_lock_status = "locked" if node_pubkey else "unlocked"
                tunnel_uuid = data.get("tunnel_uuid", "").strip() or str(uuid.uuid4())
                tunnel_status = "connected" if net_mode == "reverse_wss" else det_result.network_mode

                bare_ip = str(node_ip).strip().strip("[]")
                normalized_ip_col = func.replace(func.replace(Node.ip, "[", ""), "]", "")
                resync_priority = case((Node.pending_key == "FORCE_RESYNC", 0), else_=1)
                existing = s.scalar(
                    select(Node)
                    .where(or_(Node.ip == node_ip, normalized_ip_col == bare_ip), Node.port == node_port)
                    .order_by(resync_priority, Node.id.asc())
                    .limit(1)
                )
                if existing:
                    if existing.tunnel_uuid:
                        tunnel_uuid = existing.tunnel_uuid
                    existing.node_id = node_id
                    existing.node_key = assigned_node_key
                    existing.pbk = pbk
                    existing.sid = sid
                    existing.status = status
                    existing.is_approved = is_approved
                    existing.last_heartbeat = now_str
                    existing.dest = dest
                    existing.sni = primary_sni
                    existing.server_names = server_names_str
                    existing.node_public_key = node_pubkey
                    existing.key_lock_status = key_lock_status
                    existing.last_challenge_nonce = next_challenge_nonce
                    existing.net_mode = net_mode
                    existing.tunnel_uuid = tunnel_uuid
                    existing.tunnel_status = tunnel_status
                else:
                    s.add(
                        Node(
                            node_id=node_id,
                            node_key=assigned_node_key,
                            pending_key="",
                            name=f"节点-{node_ip}",
                            ip=str(node_ip),
                            port=node_port,
                            dest=dest,
                            sni=primary_sni,
                            server_names=server_names_str,
                            pbk=pbk,
                            sid=sid,
                            status=status,
                            last_heartbeat=now_str,
                            allow_all=1,
                            allowed_groups="",
                            allowed_users="",
                            is_approved=is_approved,
                            node_public_key=node_pubkey,
                            key_lock_status=key_lock_status,
                            last_challenge_nonce=next_challenge_nonce,
                            net_mode=net_mode,
                            tunnel_uuid=tunnel_uuid,
                            tunnel_status=tunnel_status,
                        )
                    )

                log_level = "success" if is_approved == 1 else "warn"
                event_type = "NODE_TOFU_APPROVED" if is_approved == 1 else "NODE_TOFU_QUARANTINED"
                mode_desc = "WSS 反向穿透 (NAT4/内网)" if net_mode == "reverse_wss" else "公网直连 (Reality)"
                s.add(
                    AuditLog(
                        level=log_level,
                        event_type=event_type,
                        node_id=node_id,
                        ip=str(node_ip),
                        message=f"TOFU 首次接入 ({mode_desc}): {admit_reason}，公钥锁定: {bool(node_pubkey)}",
                    )
                )

                tip = f"TOFU 首次接入成功 ({admit_reason})！拨测结果: {det_result.network_mode} ({mode_desc})，公私钥绑定: {'已锁定 (Ed25519)' if node_pubkey else '未锁定'}。"
                resp_data = {
                    "code": 200,
                    "msg": tip,
                    "tofu_assigned_key": assigned_node_key,
                    "is_approved": is_approved,
                    "key_lock_status": key_lock_status,
                    "net_mode": net_mode,
                    "network_mode": det_result.network_mode,
                    "network_detection": det_result.to_dict(),
                    "challenge_nonce": next_challenge_nonce,
                    "node_config": {
                        "net_mode": net_mode,
                        "port": node_port,
                        "dest": dest,
                        "sni": primary_sni,
                        "server_names": snis,
                        "sid": sid,
                    },
                }
                if net_mode == "reverse_wss":
                    hub_host, hub_port, _ = resolve_public_endpoint(request)
                    resp_data["tunnel_config"] = {
                        "hub_ws_host": hub_host,
                        "hub_ws_port": hub_port,
                        "hub_ws_path": f"/api/tunnel/bridge/{node_id}",
                        "tunnel_uuid": tunnel_uuid,
                        "portal_domain": f"reverse.{node_id}.hub.internal",
                    }
                s.flush()
                invalidate_nodes_cache()
                return jsonify(resp_data)

            # =========================================================================
            # 阶段 2：日常零信任心跳
            # =========================================================================
            current_key = node_obj.node_key or ""
            pending_key = node_obj.pending_key or ""
            locked_pubkey = node_obj.node_public_key or ""

            current_ip = node_obj.ip or ""
            is_custom_domain = bool(current_ip and any(ch.isalpha() for ch in current_ip))
            save_ip = current_ip if is_custom_domain else (node_ip or current_ip)

            if int(node_obj.is_approved if node_obj.is_approved is not None else 1) == 0:
                return jsonify({
                    "code": 403,
                    "msg": "【隔离拦截】节点尚未获得管理员批准上线。请联系管理员在控制面板审批通过。",
                    "challenge_nonce": next_challenge_nonce,
                }), 403

            if locked_pubkey and node_pubkey and locked_pubkey != node_pubkey:
                return jsonify({
                    "code": 403,
                    "msg": "【致命安全拦截】公钥变异篡改 (Public Key Mismatch)！与主控锁定的节点身份公钥不匹配，疑似假冒攻击！",
                }), 403

            if pending_key == "FORCE_RESYNC":
                edge_svc = EdgeAgentService.get_instance()
                reported_mode = data.get("net_mode", "auto").strip().lower()
                v4_in = data.get("public_ipv4") or (node_ip if (node_ip and ":" not in str(node_ip)) else None)
                v6_in = data.get("public_ipv6") or (node_ip if (node_ip and ":" in str(node_ip)) else None)
                v4_port = int(data.get("public_ipv4_port") or node_port)
                v6_port = int(data.get("public_ipv6_port") or node_port)

                resync_net_mode, probed_ip, det_result = edge_svc.probe_node_network(
                    public_ipv4=v4_in,
                    public_ipv4_port=v4_port,
                    public_ipv6=v6_in,
                    public_ipv6_port=v6_port,
                    preferred_mode=reported_mode,
                    remote_addr=request.remote_addr,
                )
                final_save_ip = current_ip if is_custom_domain else (probed_ip or save_ip)
                final_node_key = client_key or current_key or ("nk_" + secrets.token_hex(20))
                final_sid = sid or node_obj.sid or ""
                final_pubkey = node_pubkey or locked_pubkey
                final_lock = "locked" if final_pubkey else "unlocked"
                resync_tunnel_status = "connected" if resync_net_mode == "reverse_wss" else det_result.network_mode

                node_obj.node_key = final_node_key
                node_obj.pending_key = ""
                node_obj.ip = str(final_save_ip)
                node_obj.port = node_port
                node_obj.pbk = pbk
                node_obj.sid = final_sid
                node_obj.net_mode = resync_net_mode
                node_obj.tunnel_status = resync_tunnel_status
                node_obj.status = 1
                node_obj.is_approved = 1
                node_obj.last_heartbeat = now_str
                node_obj.last_challenge_nonce = next_challenge_nonce
                node_obj.node_public_key = final_pubkey
                node_obj.key_lock_status = final_lock
                s.flush()
                resynced_node = node_obj.to_dict()

                resync_snis = get_node_snis(resynced_node)
                resync_dest = resynced_node["dest"] if (resynced_node.get("dest") and ":" in resynced_node["dest"]) else f"{resynced_node.get('dest', 'www.microsoft.com')}:443"
                resync_resp = {
                    "code": 200,
                    "msg": "重新接纳完成，公钥与网络策略已重新绑定！",
                    "challenge_nonce": next_challenge_nonce,
                    "net_mode": resync_net_mode,
                    "network_mode": det_result.network_mode,
                    "network_detection": det_result.to_dict(),
                    "node_config": {
                        "net_mode": resync_net_mode,
                        "port": resynced_node["port"],
                        "dest": resync_dest,
                        "sni": resync_snis[0] if resync_snis else "www.microsoft.com",
                        "server_names": resync_snis,
                        "sid": resynced_node["sid"],
                    },
                }
                if client_key != final_node_key:
                    resync_resp["tofu_assigned_key"] = final_node_key
                if resync_net_mode == "reverse_wss":
                    hub_host, hub_port, _ = resolve_public_endpoint(request)
                    resync_resp["tunnel_config"] = {
                        "hub_ws_host": hub_host,
                        "hub_ws_port": hub_port,
                        "hub_ws_path": f"/api/tunnel/bridge/{node_id}",
                        "tunnel_uuid": resynced_node.get("tunnel_uuid") or "",
                        "portal_domain": f"reverse.{node_id}.hub.internal",
                    }
                invalidate_nodes_cache()
                return jsonify(resync_resp)

            if pending_key and client_key == current_key:
                node_obj.node_key = pending_key
                node_obj.pending_key = ""
                node_obj.ip = str(save_ip)
                node_obj.pbk = pbk
                if not node_obj.sid and sid:
                    node_obj.sid = sid
                node_obj.status = 1
                node_obj.last_heartbeat = now_str
                node_obj.last_challenge_nonce = next_challenge_nonce
                return jsonify({
                    "code": 200,
                    "msg": "心跳正常，已同步新密钥",
                    "new_node_key": pending_key,
                    "challenge_nonce": next_challenge_nonce,
                })

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

                node_obj.ip = node_obj.ip or str(save_ip)
                node_obj.port = node_obj.port or node_port
                node_obj.pbk = pbk
                node_obj.sid = node_obj.sid or sid
                node_obj.dest = node_obj.dest or dest
                node_obj.sni = node_obj.sni or primary_sni
                node_obj.server_names = node_obj.server_names or server_names_str
                node_obj.status = 1
                node_obj.last_heartbeat = now_str
                node_obj.last_challenge_nonce = next_challenge_nonce
                node_obj.key_lock_status = update_lock_status
                node_obj.node_public_key = save_pubkey
                s.flush()
                latest_node = node_obj.to_dict()

                snis = get_node_snis(latest_node)
                clean_dest = latest_node["dest"] if (latest_node.get("dest") and ":" in latest_node["dest"]) else f"{latest_node.get('dest', 'www.microsoft.com')}:443"
                stage2_net_mode = latest_node.get("net_mode", "direct")
                stage2_resp = {
                    "code": 200,
                    "msg": "心跳正常 (密码学验签通过)",
                    "challenge_nonce": next_challenge_nonce,
                    "key_lock_status": update_lock_status,
                    "net_mode": stage2_net_mode,
                    "node_config": {
                        "net_mode": stage2_net_mode,
                        "port": latest_node["port"],
                        "dest": clean_dest,
                        "sni": snis[0] if snis else "www.microsoft.com",
                        "server_names": snis,
                        "sid": latest_node["sid"],
                    },
                }
                if stage2_net_mode == "reverse_wss":
                    hub_host, hub_port, _ = resolve_public_endpoint(request)
                    stage2_resp["tunnel_config"] = {
                        "hub_ws_host": hub_host,
                        "hub_ws_port": hub_port,
                        "hub_ws_path": f"/api/tunnel/bridge/{node_id}",
                        "tunnel_uuid": latest_node.get("tunnel_uuid") or "",
                        "portal_domain": f"reverse.{node_id}.hub.internal",
                    }
                if current_key and client_key != current_key:
                    stage2_resp["tofu_assigned_key"] = current_key
                return jsonify(stage2_resp)

        return jsonify({"code": 403, "msg": "【安全拦截】节点通信凭据校验失败，拒绝服务！"}), 403

    except Exception as e:
        traceback.print_exc()
        return jsonify({"code": 500, "msg": f"心跳处理异常: {str(e)}"}), 500


@node_bp.route("/api/node/sync", methods=["GET"])
def node_sync_users():
    try:
        node_id = request.args.get("node_id", "").strip()
        token = request.args.get("token", "").strip()

        with db_session() as s:
            node_obj = s.scalar(select(Node).where(Node.node_id == node_id))
            if not node_obj:
                return jsonify({"code": 403, "msg": "节点未授权"}), 403
            node = node_obj.to_dict()

        if node.get("node_key") != token and node.get("pending_key") != "FORCE_RESYNC":
            return jsonify({"code": 403, "msg": "鉴权失败"}), 403

        if int(node.get("is_approved", 1)) == 0 or int(node.get("status", 1)) == 0:
            snis = get_node_snis(node)
            clean_dest = node["dest"] if (node.get("dest") and ":" in node["dest"]) else f"{node.get('dest', 'www.microsoft.com')}:443"
            return jsonify({
                "code": 200,
                "node_config": {
                    "net_mode": node.get("net_mode", "direct"),
                    "port": node["port"],
                    "dest": clean_dest,
                    "sni": snis[0],
                    "server_names": snis,
                    "sid": node["sid"],
                },
                "users": [],
            })

        all_users = get_cached_active_users()
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
                "net_mode": node.get("net_mode", "direct"),
                "port": node["port"],
                "dest": clean_dest,
                "sni": snis[0],
                "server_names": snis,
                "sid": node["sid"],
            },
            "users": allowed_users,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"code": 500, "msg": f"同步配置异常: {str(e)}"}), 500


@node_bp.route("/api/node/traffic", methods=["POST"])
def node_report_traffic():
    try:
        data = request.get_json(force=True, silent=True) or {}
        node_id = data.get("node_id", "").strip()
        token = data.get("token", "").strip()

        if not node_id:
            return jsonify({"code": 400, "msg": "缺少 node_id"}), 400

        updated_count = 0
        total_bytes = 0

        with db_session() as s:
            node_obj = s.scalar(select(Node).where(Node.node_id == node_id))
            if not node_obj:
                return jsonify({"code": 403, "msg": "节点未登记"}), 403

            if node_obj.node_key != token and node_obj.pending_key != "FORCE_RESYNC":
                return jsonify({"code": 403, "msg": "鉴权失败"}), 403

            traffic_items = data.get("traffic", [])
            for item in traffic_items:
                account = item.get("email") or item.get("username")
                inc_bytes = int(item.get("bytes", 0))
                if account and inc_bytes > 0:
                    inc_mb = max(0.01, round(inc_bytes / (1024 * 1024), 2))
                    u_obj = s.scalar(select(User).where(or_(User.email == account, User.username == account)))
                    if u_obj:
                        u_obj.used_mb = round(float(u_obj.used_mb or 0.0) + inc_mb, 2)
                        updated_count += 1
                    total_bytes += inc_bytes

        total_mb = round(total_bytes / (1024 * 1024), 3)
        return jsonify({
            "code": 200,
            "msg": f"流量同步成功！已结算 {updated_count} 位用户 (累计 {total_mb}MB)",
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"code": 500, "msg": f"流量扣费异常: {str(e)}"}), 500


@node_bp.route("/api/v1/gateway/session", methods=["POST"])
def create_gateway_session():
    """开放网关 API：允许外部主机请求接入指定 WSS 反穿节点或公网节点"""
    try:
        data = request.get_json(force=True, silent=True) or {}
        auth_header = request.headers.get("Authorization", "").replace("Bearer ", "").strip()
        target_node_id = data.get("node_id", "").strip()
        preferred_mode = data.get("preferred_mode", "").strip()

        cluster_token = get_setting("cluster_token", "")
        if not auth_header or (auth_header != cluster_token and not auth_header.startswith("api_")):
            return jsonify({
                "code": 401,
                "msg": "未授权的 API 访问：请在 Header 携带合法的 Authorization: Bearer <API_TOKEN>",
            }), 401

        with db_session() as s:
            stmt = select(Node).where(Node.status == 1, Node.is_approved == 1)
            if target_node_id:
                stmt = stmt.where(Node.node_id == target_node_id)
            elif preferred_mode == "reverse_wss":
                stmt = stmt.where(Node.net_mode == "reverse_wss").order_by(random_order_expr()).limit(1)
            else:
                stmt = stmt.order_by(random_order_expr()).limit(1)

            node_obj = s.scalar(stmt)
            if not node_obj:
                return jsonify({
                    "code": 404,
                    "msg": "未匹配到符合条件的在线代理节点 (请检查节点是否在线且已通过准入审批)",
                }), 404
            node = node_obj.to_dict()

        session_id = "sess_" + secrets.token_hex(12)
        session_uuid = str(uuid.uuid4())
        is_reverse = node.get("net_mode") == "reverse_wss"

        hub_host, hub_port, _ = resolve_public_endpoint(request)
        raw_node_ip = str(node["ip"]).strip()
        formatted_node_ip = f"[{raw_node_ip}]" if (":" in raw_node_ip and not raw_node_ip.startswith("[")) else raw_node_ip

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
                    "sni": node["sni"],
                },
                "connection": {
                    "server": hub_host if is_reverse else formatted_node_ip,
                    "port": hub_port if is_reverse else node["port"],
                    "protocol": "vless-wss" if is_reverse else "vless-reality",
                    "uuid": session_uuid,
                    "path": f"/api/tunnel/bridge/{node['node_id']}" if is_reverse else "",
                    "sni": node["sni"],
                    "tls": "tls" if is_reverse else "reality",
                    "public_key": "" if is_reverse else node["pbk"],
                },
                "expires_in_seconds": 3600,
            },
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"code": 500, "msg": f"生成网关会话失败: {str(e)}"}), 500


@node_bp.route("/api/node/edge_agent/issue_token", methods=["POST"])
def edge_agent_issue_token():
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
        allowed_ip_cidr=allowed_ip_cidr,
    )
    return jsonify({
        "code": 200,
        "token": token,
        "token_len": len(token),
        "ttl_seconds": ttl_seconds,
        "node_uuid": node_uuid,
        "node_group": node_group,
        "msg": "已基于 wimotek-edge-agent 生成专属 40 字符单次防重放令牌",
    })


@node_bp.route("/api/node/edge_agent/audit_logs", methods=["GET"])
def edge_agent_get_audit_logs():
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
        "logs": logs,
    })


@node_bp.route("/api/node/edge_agent/clean_audit", methods=["POST"])
def edge_agent_clean_audit():
    data = request.get_json(silent=True) or {}
    keep_lines = int(data.get("keep_lines", 500))
    cleared = EdgeAgentService.get_instance().clean_audit_log(keep_lines=keep_lines)
    return jsonify({
        "code": 200,
        "cleared_lines": cleared,
        "msg": f"审计日志清理完成，保留最近 {keep_lines} 行",
    })


@node_bp.route("/api/node/edge_agent/probe_network", methods=["POST"])
def edge_agent_probe_network():
    data = request.get_json(silent=True) or {}
    node_id = (data.get("node_id") or "").strip()
    apply_result = bool(data.get("apply", False))

    public_ipv4 = data.get("public_ipv4") or data.get("ipv4")
    public_ipv4_port = data.get("public_ipv4_port") or data.get("port")
    public_ipv6 = data.get("public_ipv6") or data.get("ipv6")
    public_ipv6_port = data.get("public_ipv6_port") or data.get("port")
    preferred_mode = data.get("net_mode", "auto")

    if node_id and not (public_ipv4 or public_ipv6):
        with db_session() as s:
            node_obj = s.scalar(select(Node).where(Node.node_id == node_id))
            if not node_obj:
                return jsonify({"code": 404, "msg": "节点不存在"}), 404
            stored_ip = (node_obj.ip or "").strip().strip("[]")
            stored_port = int(node_obj.port or 443)
        if ":" in stored_ip:
            public_ipv6 = stored_ip
            public_ipv6_port = public_ipv6_port or stored_port
        elif stored_ip:
            public_ipv4 = stored_ip
            public_ipv4_port = public_ipv4_port or stored_port

    xray_net_mode, best_ip, det = EdgeAgentService.get_instance().probe_node_network(
        public_ipv4=public_ipv4,
        public_ipv4_port=int(public_ipv4_port) if public_ipv4_port else None,
        public_ipv6=public_ipv6,
        public_ipv6_port=int(public_ipv6_port) if public_ipv6_port else None,
        preferred_mode=preferred_mode,
    )

    if apply_result and node_id:
        tunnel_status = "connected" if xray_net_mode == "reverse_wss" else det.network_mode
        with db_session() as s:
            node_obj = s.scalar(select(Node).where(Node.node_id == node_id))
            if node_obj:
                node_obj.net_mode = xray_net_mode
                node_obj.tunnel_status = tunnel_status
        invalidate_nodes_cache()

    return jsonify({
        "code": 200,
        "xray_net_mode": xray_net_mode,
        "best_ip": best_ip,
        "applied": bool(apply_result and node_id),
        "detection": det.to_dict(),
    })