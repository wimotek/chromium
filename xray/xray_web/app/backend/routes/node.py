import datetime
import json
import re
import secrets
import time
import traceback
import uuid

from flask import Blueprint, jsonify, request
from sqlalchemy import case, func, or_, select, update
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
from core.rate_limit import (
    consume_rate_limit,
    get_client_ip,
    rate_limit,
    rate_limit_response,
    reset_rate_counter,
)
from routes import (
    get_node_snis,
    is_user_allowed_for_node,
    parse_last_probe,
    resolve_public_endpoint,
)

node_bp = Blueprint("node_bp", __name__)


def _serialize_agent_health(raw_health) -> tuple[str, dict | None]:
    if not isinstance(raw_health, dict):
        return "", None
    core_alive = raw_health.get("xray_alive")
    if core_alive is None:
        core_alive = raw_health.get("core_alive", True)
    parsed = {
        "healthy": bool(raw_health.get("healthy", True)),
        "xray_alive": bool(core_alive),
        "port_ready": bool(raw_health.get("port_ready", True)),
        "stats_ready": bool(raw_health.get("stats_ready", True)),
    }
    if "tunnel_connected" in raw_health and raw_health.get("tunnel_connected") is not None:
        parsed["tunnel_connected"] = bool(raw_health.get("tunnel_connected"))
    if "hy2_ready" in raw_health and raw_health.get("hy2_ready") is not None:
        parsed["hy2_ready"] = bool(raw_health.get("hy2_ready"))
    core_type = str(raw_health.get("core_type") or "").strip().lower()
    if core_type in ("xray", "singbox"):
        parsed["core_type"] = core_type
    return json.dumps(parsed, separators=(",", ":")), parsed


def _parse_bool_int(val, default: int = 0) -> int:
    if val is None:
        return default
    if isinstance(val, bool):
        return 1 if val else 0
    s = str(val).strip().lower()
    if s in ("1", "true", "yes", "on"):
        return 1
    if s in ("0", "false", "no", "off"):
        return 0
    return default


def _parse_core_and_hy2(data: dict) -> tuple[str, int, int, str, int]:
    raw_core = str(data.get("core_type") or "").strip().lower()
    core_type = raw_core if raw_core in ("xray", "singbox") else ""
    hy2_enabled = _parse_bool_int(data.get("hy2_enabled"), default=0) if core_type == "singbox" else 0
    try:
        hy2_port = int(data.get("hy2_port") or 0)
    except Exception:
        hy2_port = 0
    if hy2_port < 0 or hy2_port > 65535:
        hy2_port = 0
    if core_type != "singbox":
        hy2_port = 0
    hy2_sni = str(data.get("hy2_sni") or "").strip()[:255] if core_type == "singbox" else ""
    hy2_insecure = _parse_bool_int(data.get("hy2_insecure"), default=1)
    return core_type, hy2_enabled, hy2_port, hy2_sni, hy2_insecure


def _build_node_config_payload(
    *,
    net_mode: str,
    port: int,
    dest: str,
    snis: list[str],
    sid: str,
    core_type: str = "xray",
    hy2_enabled: int = 0,
    hy2_port: int = 0,
    hy2_sni: str = "",
    hy2_insecure: int = 1,
) -> dict:
    return {
        "net_mode": net_mode,
        "core_type": core_type or "xray",
        "port": port,
        "dest": dest,
        "sni": snis[0] if snis else "www.microsoft.com",
        "server_names": snis,
        "sid": sid,
        "hy2_enabled": bool(int(hy2_enabled or 0)),
        "hy2_port": int(hy2_port or 0),
        "hy2_sni": str(hy2_sni or "").strip(),
        "hy2_insecure": bool(int(hy2_insecure if hy2_insecure is not None else 1)),
    }


@node_bp.route("/api/node/challenge", methods=["GET", "POST"])
@rate_limit("node_chal_ip", limit=300, window_seconds=60, msg="节点挑战请求过于频繁，请稍后再试")
def get_node_challenge():
    """为节点签发一次性防重放随机挑战 Nonce (带 60s 时效)"""
    node_id = request.args.get("node_id") or (request.json or {}).get("node_id", "")
    challenge_nonce = "xp_chal_" + secrets.token_hex(16)
    if node_id:
        with db_session() as s:
            s.execute(
                update(Node)
                .where(Node.node_id == node_id)
                .values(last_challenge_nonce=challenge_nonce)
            )
    return jsonify({
        "code": 200,
        "challenge_nonce": challenge_nonce,
        "expires_in": 60,
        "algo": "Ed25519",
    })


@node_bp.route("/api/node/heartbeat", methods=["POST"])
@rate_limit("node_hb_ip", limit=300, window_seconds=60, msg="节点心跳请求过于频繁，已触发限流保护")
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
        now_ts = time.time()
        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        agent_health_json, agent_health_dict = _serialize_agent_health(data.get("health"))
        reported_core_type, reported_hy2_enabled, reported_hy2_port, reported_hy2_sni, reported_hy2_insecure = _parse_core_and_hy2(data)
        effective_core_type = reported_core_type or "xray"

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
        source_ip = get_client_ip(request)

        # 第一步：超短事务读取节点当前状态（避免在 DB 事务锁内执行耗时网络拨测）
        with db_session() as s:
            node_obj = s.scalar(select(Node).where(Node.node_id == node_id))
            node_snapshot = node_obj.to_dict() if node_obj else None

        # =========================================================================
        # 阶段 1：TOFU 首次信任接入（先于 DB 写事务外完成主动双栈 TCP 拨测）
        # =========================================================================
        if node_snapshot is None:
            tofu_enabled = get_setting("tofu_enabled", "true").lower() == "true"
            if not tofu_enabled:
                with db_session() as s:
                    s.add(
                        AuditLog(
                            level="security",
                            event_type="TOFU_ACCESS_DENIED",
                            node_id=node_id,
                            ip=str(node_ip or source_ip),
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
                remote_addr=source_ip,
            )
            node_ip = probed_ip or node_ip or source_ip or "127.0.0.1"

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
                with db_session() as s:
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

            with db_session() as s:
                # 再次检查是否并发请求已先一步建档（防止高并发同时上线产生主键冲突）
                existing = s.scalar(select(Node).where(Node.node_id == node_id).limit(1))
                if not existing:
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
                    existing.last_heartbeat_ts = now_ts
                    if agent_health_json:
                        existing.agent_health = agent_health_json
                    existing.dest = dest
                    existing.sni = primary_sni
                    existing.server_names = server_names_str
                    existing.node_public_key = node_pubkey
                    existing.key_lock_status = key_lock_status
                    existing.last_challenge_nonce = next_challenge_nonce
                    existing.net_mode = net_mode
                    existing.tunnel_uuid = tunnel_uuid
                    existing.tunnel_status = tunnel_status
                    existing.core_type = effective_core_type
                    existing.hy2_enabled = reported_hy2_enabled
                    existing.hy2_port = reported_hy2_port
                    existing.hy2_sni = reported_hy2_sni
                    existing.hy2_insecure = reported_hy2_insecure
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
                            last_heartbeat_ts=now_ts,
                            agent_health=agent_health_json,
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
                            core_type=effective_core_type,
                            hy2_enabled=reported_hy2_enabled,
                            hy2_port=reported_hy2_port,
                            hy2_sni=reported_hy2_sni,
                            hy2_insecure=reported_hy2_insecure,
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

            invalidate_nodes_cache()
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
                "node_config": _build_node_config_payload(
                    net_mode=net_mode,
                    port=node_port,
                    dest=dest,
                    snis=snis,
                    sid=sid,
                    core_type=effective_core_type,
                    hy2_enabled=reported_hy2_enabled,
                    hy2_port=reported_hy2_port,
                    hy2_sni=reported_hy2_sni,
                    hy2_insecure=reported_hy2_insecure,
                ),
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
            return jsonify(resp_data)

        # =========================================================================
        # 阶段 2：已登记节点的常规校验
        # =========================================================================
        current_key = node_snapshot.get("node_key") or ""
        pending_key = node_snapshot.get("pending_key") or ""
        locked_pubkey = node_snapshot.get("node_public_key") or ""

        current_ip = node_snapshot.get("ip") or ""
        is_custom_domain = bool(current_ip and any(ch.isalpha() for ch in current_ip))
        save_ip = current_ip if is_custom_domain else (node_ip or current_ip)

        if int(node_snapshot.get("is_approved") if node_snapshot.get("is_approved") is not None else 1) == 0:
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

        # 特殊分支：FORCE_RESYNC（先于 DB 事务外执行网络拨测，再回写库）
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
                remote_addr=source_ip,
            )
            final_save_ip = current_ip if is_custom_domain else (probed_ip or save_ip)
            final_node_key = client_key or current_key or ("nk_" + secrets.token_hex(20))
            final_sid = sid or node_snapshot.get("sid") or ""
            final_pubkey = node_pubkey or locked_pubkey
            final_lock = "locked" if final_pubkey else "unlocked"
            resync_tunnel_status = "connected" if resync_net_mode == "reverse_wss" else det_result.network_mode

            with db_session() as s:
                node_obj = s.scalar(select(Node).where(Node.node_id == node_id))
                if not node_obj:
                    return jsonify({"code": 404, "msg": "节点记录已被删除"}), 404
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
                node_obj.last_heartbeat_ts = now_ts
                node_obj.last_probe = ""
                if agent_health_json:
                    node_obj.agent_health = agent_health_json
                node_obj.last_challenge_nonce = next_challenge_nonce
                node_obj.node_public_key = final_pubkey
                node_obj.key_lock_status = final_lock
                if reported_core_type:
                    node_obj.core_type = reported_core_type
                if (node_obj.core_type or "xray") == "singbox":
                    if int(node_obj.hy2_port or 0) == 0 and reported_hy2_port > 0:
                        node_obj.hy2_enabled = reported_hy2_enabled
                        node_obj.hy2_port = reported_hy2_port
                        node_obj.hy2_sni = reported_hy2_sni
                        node_obj.hy2_insecure = reported_hy2_insecure
                s.flush()
                resynced_node = node_obj.to_dict()

            invalidate_nodes_cache()
            resync_snis = get_node_snis(resynced_node)
            resync_dest = resynced_node["dest"] if (resynced_node.get("dest") and ":" in resynced_node["dest"]) else f"{resynced_node.get('dest', 'www.microsoft.com')}:443"
            resync_resp = {
                "code": 200,
                "msg": "重新接纳完成，公钥与网络策略已重新绑定！",
                "challenge_nonce": next_challenge_nonce,
                "net_mode": resync_net_mode,
                "network_mode": det_result.network_mode,
                "network_detection": det_result.to_dict(),
                "node_config": _build_node_config_payload(
                    net_mode=resync_net_mode,
                    port=resynced_node["port"],
                    dest=resync_dest,
                    snis=resync_snis,
                    sid=resynced_node["sid"],
                    core_type=resynced_node.get("core_type", "xray"),
                    hy2_enabled=resynced_node.get("hy2_enabled", 0),
                    hy2_port=resynced_node.get("hy2_port", 0),
                    hy2_sni=resynced_node.get("hy2_sni", ""),
                    hy2_insecure=resynced_node.get("hy2_insecure", 1),
                ),
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
            return jsonify(resync_resp)

        # 快速分支：正常日常心跳 / 密钥轮换（纯本地短事务，零网络阻塞）
        need_cache_invalidate = False
        stage2_resp = None
        rotated_resp = None
        with db_session() as s:
            node_obj = s.scalar(select(Node).where(Node.node_id == node_id))
            if not node_obj:
                return jsonify({"code": 403, "msg": "【安全拦截】节点通信凭据校验失败，拒绝服务！"}), 403

            prev_hb_ts = float(node_obj.last_heartbeat_ts or 0.0)
            prev_health = node_obj.agent_health or ""
            prev_tunnel = node_obj.tunnel_status or ""
            prev_probe = node_obj.last_probe or ""
            prev_status = int(node_obj.status or 0)
            prev_core_type = node_obj.core_type or "xray"
            prev_hy2_sig = (
                int(node_obj.hy2_enabled or 0),
                int(node_obj.hy2_port or 0),
                node_obj.hy2_sni or "",
                int(node_obj.hy2_insecure if node_obj.hy2_insecure is not None else 1),
            )
            hb_was_stale = (prev_hb_ts <= 0.0) or ((now_ts - prev_hb_ts) >= 90.0)

            def _sync_core_and_hy2_if_needed(n_obj):
                if reported_core_type and n_obj.core_type != reported_core_type:
                    n_obj.core_type = reported_core_type
                if (n_obj.core_type or "xray") == "singbox":
                    # 仅在 Hub 尚未配置 Hysteria2 端口时采纳节点首次上报，保证后台编辑配置始终作为权威源
                    if int(n_obj.hy2_port or 0) == 0 and reported_hy2_port > 0:
                        n_obj.hy2_enabled = reported_hy2_enabled
                        n_obj.hy2_port = reported_hy2_port
                        n_obj.hy2_sni = reported_hy2_sni
                        n_obj.hy2_insecure = reported_hy2_insecure

            def _maybe_clear_recoverable_probe(n_obj, health_dict):
                lp = parse_last_probe(n_obj.last_probe)
                if not lp or lp.get("healthy") is not False:
                    return
                code = str(lp.get("status_code") or "")
                if code not in ("offline", "heartbeat_lost", "xray_unhealthy", "tunnel_disconnected"):
                    return
                if health_dict:
                    if health_dict.get("xray_alive") is False or health_dict.get("port_ready") is False:
                        return
                    if (n_obj.net_mode or "direct") == "reverse_wss" and health_dict.get("tunnel_connected") is False:
                        return
                n_obj.last_probe = ""

            if pending_key and client_key == current_key:
                node_obj.node_key = pending_key
                node_obj.pending_key = ""
                node_obj.ip = str(save_ip)
                node_obj.pbk = pbk
                if not node_obj.sid and sid:
                    node_obj.sid = sid
                node_obj.status = 1
                node_obj.last_heartbeat = now_str
                node_obj.last_heartbeat_ts = now_ts
                if agent_health_json:
                    node_obj.agent_health = agent_health_json
                if (node_obj.net_mode or "direct") == "reverse_wss" and agent_health_dict and "tunnel_connected" in agent_health_dict:
                    node_obj.tunnel_status = "connected" if agent_health_dict["tunnel_connected"] else "disconnected"
                _sync_core_and_hy2_if_needed(node_obj)
                _maybe_clear_recoverable_probe(node_obj, agent_health_dict)
                node_obj.last_challenge_nonce = next_challenge_nonce
                need_cache_invalidate = True
                rotated_resp = {
                    "code": 200,
                    "msg": "心跳正常，已同步新密钥",
                    "new_node_key": pending_key,
                    "challenge_nonce": next_challenge_nonce,
                }
            else:
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
                    node_obj.last_heartbeat_ts = now_ts
                    if agent_health_json:
                        node_obj.agent_health = agent_health_json
                    if (node_obj.net_mode or "direct") == "reverse_wss" and agent_health_dict and "tunnel_connected" in agent_health_dict:
                        node_obj.tunnel_status = "connected" if agent_health_dict["tunnel_connected"] else "disconnected"
                    _sync_core_and_hy2_if_needed(node_obj)
                    _maybe_clear_recoverable_probe(node_obj, agent_health_dict)
                    node_obj.last_challenge_nonce = next_challenge_nonce
                    node_obj.key_lock_status = update_lock_status
                    node_obj.node_public_key = save_pubkey
                    s.flush()
                    latest_node = node_obj.to_dict()

                    cur_hy2_sig = (
                        int(node_obj.hy2_enabled or 0),
                        int(node_obj.hy2_port or 0),
                        node_obj.hy2_sni or "",
                        int(node_obj.hy2_insecure if node_obj.hy2_insecure is not None else 1),
                    )
                    if (
                        hb_was_stale
                        or prev_status != 1
                        or (node_obj.agent_health or "") != prev_health
                        or (node_obj.tunnel_status or "") != prev_tunnel
                        or (node_obj.last_probe or "") != prev_probe
                        or (node_obj.core_type or "xray") != prev_core_type
                        or cur_hy2_sig != prev_hy2_sig
                    ):
                        need_cache_invalidate = True

                    snis = get_node_snis(latest_node)
                    clean_dest = latest_node["dest"] if (latest_node.get("dest") and ":" in latest_node["dest"]) else f"{latest_node.get('dest', 'www.microsoft.com')}:443"
                    stage2_net_mode = latest_node.get("net_mode", "direct")
                    stage2_resp = {
                        "code": 200,
                        "msg": "心跳正常 (密码学验签通过)",
                        "challenge_nonce": next_challenge_nonce,
                        "key_lock_status": update_lock_status,
                        "net_mode": stage2_net_mode,
                        "node_config": _build_node_config_payload(
                            net_mode=stage2_net_mode,
                            port=latest_node["port"],
                            dest=clean_dest,
                            snis=snis,
                            sid=latest_node["sid"],
                            core_type=latest_node.get("core_type", "xray"),
                            hy2_enabled=latest_node.get("hy2_enabled", 0),
                            hy2_port=latest_node.get("hy2_port", 0),
                            hy2_sni=latest_node.get("hy2_sni", ""),
                            hy2_insecure=latest_node.get("hy2_insecure", 1),
                        ),
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

        if need_cache_invalidate:
            invalidate_nodes_cache()
        if rotated_resp is not None:
            return jsonify(rotated_resp)
        if stage2_resp is not None:
            return jsonify(stage2_resp)

        return jsonify({"code": 403, "msg": "【安全拦截】节点通信凭据校验失败，拒绝服务！"}), 403

    except Exception as e:
        traceback.print_exc()
        return jsonify({"code": 500, "msg": f"心跳处理异常: {str(e)}"}), 500


@node_bp.route("/api/node/sync", methods=["GET"])
@rate_limit("node_sync_ip", limit=300, window_seconds=60, msg="节点同步请求过于频繁，已触发限流保护")
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
                "node_config": _build_node_config_payload(
                    net_mode=node.get("net_mode", "direct"),
                    port=node["port"],
                    dest=clean_dest,
                    snis=snis,
                    sid=node["sid"],
                    core_type=node.get("core_type", "xray"),
                    hy2_enabled=node.get("hy2_enabled", 0),
                    hy2_port=node.get("hy2_port", 0),
                    hy2_sni=node.get("hy2_sni", ""),
                    hy2_insecure=node.get("hy2_insecure", 1),
                ),
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
            "node_config": _build_node_config_payload(
                net_mode=node.get("net_mode", "direct"),
                port=node["port"],
                dest=clean_dest,
                snis=snis,
                sid=node["sid"],
                core_type=node.get("core_type", "xray"),
                hy2_enabled=node.get("hy2_enabled", 0),
                hy2_port=node.get("hy2_port", 0),
                hy2_sni=node.get("hy2_sni", ""),
                hy2_insecure=node.get("hy2_insecure", 1),
            ),
            "users": allowed_users,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"code": 500, "msg": f"同步配置异常: {str(e)}"}), 500


@node_bp.route("/api/node/traffic", methods=["POST"])
@rate_limit("node_traffic_ip", limit=300, window_seconds=60, msg="流量上报请求过于频繁，已触发限流保护")
def node_report_traffic():
    try:
        data = request.get_json(force=True, silent=True) or {}
        node_id = data.get("node_id", "").strip()
        token = data.get("token", "").strip()

        if not node_id:
            return jsonify({"code": 400, "msg": "缺少 node_id"}), 400

        # 先在内存中聚合同一批次中同一账号的流量增量，减少 DB roundtrip
        aggregated: dict[str, int] = {}
        total_bytes = 0
        for item in (data.get("traffic") or []):
            account = (item.get("email") or item.get("username") or "").strip()
            inc_bytes = int(item.get("bytes", 0) or 0)
            if account and inc_bytes > 0:
                aggregated[account] = aggregated.get(account, 0) + inc_bytes
                total_bytes += inc_bytes

        updated_count = 0
        with db_session() as s:
            node_obj = s.scalar(select(Node).where(Node.node_id == node_id))
            if not node_obj:
                return jsonify({"code": 403, "msg": "节点未登记"}), 403

            if node_obj.node_key != token and node_obj.pending_key != "FORCE_RESYNC":
                return jsonify({"code": 403, "msg": "鉴权失败"}), 403

            # 原子 SQL 累加 (used_mb = ROUND(COALESCE(used_mb, 0) + inc_mb, 2))，彻底消除多节点/多 Worker 并发丢账竞争
            for account, inc_bytes in aggregated.items():
                inc_mb = max(0.01, round(inc_bytes / (1024 * 1024), 2))
                res = s.execute(
                    update(User)
                    .where(or_(User.email == account, User.username == account))
                    .values(used_mb=func.round(func.coalesce(User.used_mb, 0.0) + inc_mb, 2))
                )
                if (res.rowcount or 0) > 0:
                    updated_count += 1

        total_mb = round(total_bytes / (1024 * 1024), 3)
        return jsonify({
            "code": 200,
            "msg": f"流量同步成功！已结算 {updated_count} 位用户 (累计 {total_mb}MB)",
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"code": 500, "msg": f"流量扣费异常: {str(e)}"}), 500


@node_bp.route("/api/v1/gateway/session", methods=["POST"])
@rate_limit("gateway_sess_ip", limit=60, window_seconds=60, msg="网关会话请求过于频繁，请稍后再试")
def create_gateway_session():
    """开放网关 API：允许外部主机请求接入指定 WSS 反穿节点或公网节点"""
    try:
        ip = get_client_ip(request)
        data = request.get_json(force=True, silent=True) or {}
        auth_header = request.headers.get("Authorization", "").replace("Bearer ", "").strip()
        target_node_id = data.get("node_id", "").strip()
        preferred_mode = data.get("preferred_mode", "").strip()

        cluster_token = get_setting("cluster_token", "")
        if not auth_header or (auth_header != cluster_token and not auth_header.startswith("api_")):
            allowed_fail, _, _ = consume_rate_limit("gw_auth_fail", ip, limit=15, window_seconds=300)
            if not allowed_fail:
                return rate_limit_response("网关鉴权失败次数过多，已临时限流", retry_after=300)
            return jsonify({
                "code": 401,
                "msg": "未授权的 API 访问：请在 Header 携带合法的 Authorization: Bearer <API_TOKEN>",
            }), 401

        reset_rate_counter("gw_auth_fail", ip)
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
@rate_limit("edge_token_ip", limit=30, window_seconds=60, msg="令牌签发请求过于频繁，请稍后再试")
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
@rate_limit("edge_probe_ip", limit=20, window_seconds=60, msg="网络拨测过于频繁，请稍后再试")
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