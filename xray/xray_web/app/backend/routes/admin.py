import datetime
import json
import re
import secrets
import threading
import time
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor

from flask import Blueprint, jsonify, request
from sqlalchemy import delete, select

from core.db import (
    db_session,
    get_setting,
    hash_pwd,
    invalidate_nodes_cache,
    invalidate_users_cache,
    set_setting,
)
from core.models import AuditLog, Card, Node, User
from routes import (
    HEARTBEAT_ONLINE_SEC,
    build_node_link,
    check_admin,
    compute_heartbeat_age_sec,
    evaluate_node_sub_health,
    get_node_snis,
    normalize_expire_date,
    parse_agent_health,
    parse_last_probe,
    resolve_public_endpoint,
)
from services.notify_service import notify_user

admin_bp = Blueprint("admin_bp", __name__)


def _enrich_node_dict(node_dict: dict, now_ts: float, now_dt: datetime.datetime) -> dict:
    item = dict(node_dict)
    item["heartbeat_age_sec"] = compute_heartbeat_age_sec(item, now_ts, now_dt)
    item["agent_health_info"] = parse_agent_health(item.get("agent_health"))
    item["last_probe_info"] = parse_last_probe(item.get("last_probe"))
    sub_ok, sub_code, sub_reason = evaluate_node_sub_health(item, now_ts=now_ts, now_dt=now_dt)
    item["sub_eligible"] = sub_ok
    item["sub_status_code"] = sub_code
    item["sub_exclude_reason"] = "" if sub_ok else sub_reason
    return item


@admin_bp.route("/api/admin/data", methods=["POST"])
def admin_data():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    with db_session(readonly=True) as s:
        cards = [c.to_dict() for c in s.scalars(select(Card).order_by(Card.created_at.desc()).limit(200)).all()]
        active_nodes = [n.to_dict() for n in s.scalars(select(Node).order_by(Node.id.asc())).all()]
        audit_logs = [a.to_dict() for a in s.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(150)).all()]
        raw_users = s.scalars(select(User)).all()
        user_dicts = [u.to_dict() for u in raw_users]

    hub_host, hub_port, host_prefix = resolve_public_endpoint(request)

    # 预构建每个节点的链接前缀与后缀模板，避免在 N_users x M_nodes 循环中重复解析 SNI 与 URL 编码
    node_templates = []
    for n in active_nodes:
        if len(n.get("pbk", "")) != 43:
            continue
        snis = get_node_snis(n)
        chosen_sni = snis[0]
        if n.get("net_mode") == "reverse_wss":
            ws_path = urllib.parse.quote(f"/api/tunnel/bridge/{n['node_id']}")
            quoted_remark = urllib.parse.quote(f"{n['name']} [WSS反穿]")
            link_suffix = (
                f"@{hub_host}:{hub_port}"
                f"?security=tls&encryption=none&headerType=none&type=ws&host={hub_host}&path={ws_path}&sni={hub_host}#{quoted_remark}"
            )
        else:
            clean_sni = chosen_sni.split(":")[0]
            raw_host = str(n["ip"]).strip()
            formatted_host = f"[{raw_host}]" if (":" in raw_host and not raw_host.startswith("[")) else raw_host
            quoted_remark = urllib.parse.quote(f"{n['name']}")
            link_suffix = (
                f"@{formatted_host}:{n['port']}"
                f"?security=reality&encryption=none&pbk={n['pbk']}&headerType=none&fp=chrome"
                f"&type=tcp&flow=xtls-rprx-vision&sni={clean_sni}&sid={n['sid']}#{quoted_remark}"
            )
        hy2_suffix = ""
        if (
            n.get("net_mode") != "reverse_wss"
            and str(n.get("core_type") or "xray").lower() == "singbox"
            and int(n.get("hy2_enabled") or 0) == 1
            and int(n.get("hy2_port") or 0) > 0
        ):
            raw_host = str(n["ip"]).strip()
            formatted_host = f"[{raw_host}]" if (":" in raw_host and not raw_host.startswith("[")) else raw_host
            hy2_sni = str(n.get("hy2_sni") or "").strip() or chosen_sni
            hy2_insecure = 1 if int(n.get("hy2_insecure", 1) or 0) != 0 else 0
            hy2_remark = urllib.parse.quote(f"{n['name']} [Hy2-UDP]")
            hy2_suffix = (
                f"@{formatted_host}:{int(n['hy2_port'])}"
                f"?sni={urllib.parse.quote(hy2_sni, safe='')}&insecure={hy2_insecure}"
                f"#{hy2_remark}"
            )
        node_templates.append({
            "id": n["id"],
            "node_id": n["node_id"],
            "name": n["name"],
            "ip": n["ip"],
            "port": n["port"],
            "pbk": n["pbk"],
            "sid": n["sid"],
            "sni": chosen_sni,
            "server_names": snis,
            "selected_sni": chosen_sni,
            "link_suffix": link_suffix,
            "core_type": n.get("core_type") or "xray",
            "hy2_enabled": int(n.get("hy2_enabled") or 0),
            "hy2_port": int(n.get("hy2_port") or 0),
            "hy2_suffix": hy2_suffix,
        })

    users = []
    for d in user_dicts:
        u_uuid = d["uuid"]
        users.append({
            "username": d["username"],
            "email": d["email"],
            "traffic_limit_mb": d["traffic_limit_mb"],
            "used_mb": round(d.get("used_mb", 0), 2),
            "expire_date": d["expire_date"],
            "role": d["role"],
            "uuid": u_uuid,
            "status": d["status"],
            "notify_type": d["notify_type"],
            "is_monthly": d["is_monthly"],
            "reset_day": d["reset_day"],
            "user_group": d["user_group"],
            "sub_url": f"{host_prefix}/api/sub?token={u_uuid}",
            "node_links": [
                {
                    "id": nt["id"],
                    "node_id": nt["node_id"],
                    "name": nt["name"],
                    "ip": nt["ip"],
                    "port": nt["port"],
                    "pbk": nt["pbk"],
                    "sid": nt["sid"],
                    "sni": nt["sni"],
                    "server_names": nt["server_names"],
                    "selected_sni": nt["selected_sni"],
                    "core_type": nt["core_type"],
                    "hy2_enabled": nt["hy2_enabled"],
                    "hy2_port": nt["hy2_port"],
                    "link": f"vless://{u_uuid}{nt['link_suffix']}",
                    "hy2_link": f"hysteria2://{u_uuid}{nt['hy2_suffix']}" if nt["hy2_suffix"] else "",
                }
                for nt in node_templates
            ],
        })

    cluster_token = get_setting("cluster_token", "")
    auto_approve = get_setting("node_auto_approve", "true").lower() == "true"
    tofu_enabled = get_setting("tofu_enabled", "true").lower() == "true"
    now_ts = time.time()
    now_dt = datetime.datetime.now()
    enriched_nodes = [_enrich_node_dict(n, now_ts, now_dt) for n in active_nodes]

    return jsonify({
        "code": 200,
        "server_ts": now_ts,
        "cards": cards,
        "users": users,
        "nodes": enriched_nodes,
        "audit_logs": audit_logs,
        "cluster_info": {
            "cluster_token": cluster_token,
            "tofu_enabled": tofu_enabled,
            "auto_approve": auto_approve,
            "panel_url": host_prefix,
        },
    })


@admin_bp.route("/api/admin/cluster/token", methods=["GET", "POST"])
def admin_cluster_token():
    if request.method == "GET":
        admin_user = request.args.get("admin_user")
        admin_pwd = request.args.get("admin_pwd")
        if not check_admin(admin_user, admin_pwd):
            return jsonify({"code": 403, "msg": "无权限"})
        return jsonify({
            "code": 200,
            "cluster_token": get_setting("cluster_token", ""),
            "tofu_enabled": get_setting("tofu_enabled", "true").lower() == "true",
            "auto_approve": get_setting("node_auto_approve", "true").lower() == "true",
        })

    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    action = data.get("action")
    if action == "regenerate":
        new_token = "ctk_" + secrets.token_hex(16)
        set_setting("cluster_token", new_token)
        return jsonify({"code": 200, "msg": "集群引导令牌已轮换重置！旧令牌已立即失效。", "cluster_token": new_token})

    if "tofu_enabled" in data:
        val = "true" if data.get("tofu_enabled") else "false"
        set_setting("tofu_enabled", val)
        tip = "TOFU 首次信任总开关已开启" if val == "true" else "TOFU 首次信任总开关已关闭，任何未知新节点将被拒接入"
        return jsonify({"code": 200, "msg": tip})

    if "auto_approve" in data:
        val = "true" if data.get("auto_approve") else "false"
        set_setting("node_auto_approve", val)
        tip = "免审上线已开启，新节点可免审直连" if val == "true" else "零信任隔离模式已开启，新节点需审批通过后方可激活服务"
        return jsonify({"code": 200, "msg": tip})

    return jsonify({"code": 400, "msg": "未知操作"})


@admin_bp.route("/api/admin/nodes/approve", methods=["POST"])
def admin_approve_node():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})
    node_id = data.get("node_id")

    with db_session() as s:
        node_obj = s.scalar(select(Node).where(Node.node_id == node_id))
        if node_obj:
            node_obj.is_approved = 1
            node_obj.status = 1
            node_obj.last_probe = ""
    invalidate_nodes_cache()
    return jsonify({"code": 200, "msg": f"节点 [{node_id}] 审核批准通过！已解除隔离并激活上线服务。"})


@admin_bp.route("/api/admin/nodes/save_config", methods=["POST"])
def admin_save_node_config():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get("node_id")
    name = data.get("name", "").strip()
    ip = data.get("ip", "").strip()
    port = int(data.get("port", 443))
    raw_dest = data.get("dest", "www.microsoft.com:443").strip()
    raw_server_names = data.get("server_names", "").strip()
    raw_sni = data.get("sni", "www.microsoft.com").strip()
    sid = data.get("sid", "").strip()
    node_key = data.get("node_key", "").strip()

    dest = raw_dest if ":" in raw_dest else f"{raw_dest}:443"

    snis = []
    for part in re.split(r"[,;\s]+", raw_server_names or raw_sni):
        clean = part.strip().split(":")[0]
        if clean and clean not in snis:
            snis.append(clean)
    server_names_str = ",".join(snis)
    primary_sni = snis[0] if snis else "www.microsoft.com"

    with db_session() as s:
        node_obj = s.scalar(select(Node).where(Node.node_id == node_id))
        if not node_obj:
            return jsonify({"code": 404, "msg": "未找到对应节点"})
        node_obj.name = name
        node_obj.ip = ip
        node_obj.port = port
        node_obj.dest = dest
        node_obj.sni = primary_sni
        node_obj.server_names = server_names_str
        node_obj.sid = node_obj.sid or sid
        node_obj.node_key = node_obj.node_key or node_key
        if "hy2_enabled" in data:
            raw_hy2_en = data.get("hy2_enabled")
            node_obj.hy2_enabled = 1 if (raw_hy2_en is True or str(raw_hy2_en).strip().lower() in ("1", "true", "yes")) else 0
        if "hy2_port" in data and str(data.get("hy2_port") or "").strip() != "":
            try:
                p_val = int(data.get("hy2_port"))
                if 0 <= p_val <= 65535:
                    node_obj.hy2_port = p_val
            except Exception:
                pass
        if "hy2_sni" in data:
            node_obj.hy2_sni = str(data.get("hy2_sni") or "").strip()[:255]
        if "hy2_insecure" in data:
            raw_hy2_ins = data.get("hy2_insecure")
            node_obj.hy2_insecure = 1 if (raw_hy2_ins is True or str(raw_hy2_ins).strip().lower() in ("1", "true", "yes")) else 0
        node_obj.last_probe = ""
    invalidate_nodes_cache()
    return jsonify({"code": 200, "msg": "节点网络配置已保存！"})


@admin_bp.route("/api/admin/nodes/save_permission", methods=["POST"])
def admin_save_node_permission():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get("node_id")
    status = int(data.get("status", 1))
    allow_all = int(data.get("allow_all", 1))
    allowed_groups = data.get("allowed_groups", "").strip()
    allowed_users = data.get("allowed_users", "").strip()

    with db_session() as s:
        node_obj = s.scalar(select(Node).where(Node.node_id == node_id))
        if node_obj:
            node_obj.status = status
            node_obj.allow_all = allow_all
            node_obj.allowed_groups = allowed_groups
            node_obj.allowed_users = allowed_users
    invalidate_nodes_cache()

    action_text = "🟢 已启动并生效" if status == 1 else "🛑 已停止并阻断"
    return jsonify({"code": 200, "msg": f"节点运行权限策略已保存 ({action_text})！"})


@admin_bp.route("/api/admin/nodes/list", methods=["POST"])
def admin_list_nodes():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    now_ts = time.time()
    now_dt = datetime.datetime.now()
    with db_session(readonly=True) as s:
        nodes = [_enrich_node_dict(n.to_dict(), now_ts, now_dt) for n in s.scalars(select(Node).order_by(Node.id.asc())).all()]
    return jsonify({"code": 200, "server_ts": now_ts, "data": nodes})


@admin_bp.route("/api/admin/nodes/ping", methods=["POST"])
def admin_ping_node():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get("node_id", "").strip()
    from core.edge_agent_service import EdgeAgentService
    edge_svc = EdgeAgentService.get_instance()
    now_ts = time.time()
    now_dt = datetime.datetime.now()
    results = {}

    with db_session(readonly=True) as s:
        stmt = select(Node).where(Node.node_id == node_id) if node_id else select(Node).order_by(Node.id.asc())
        node_snapshots = [n.to_dict() for n in s.scalars(stmt).all()]

    direct_targets = []
    for n in node_snapshots:
        nid = n["node_id"]
        net_mode = n.get("net_mode") or "direct"
        last_hb = n.get("last_heartbeat") or ""
        hb_age_sec = compute_heartbeat_age_sec(n, now_ts, now_dt)
        hb_alive = hb_age_sec is not None and hb_age_sec <= HEARTBEAT_ONLINE_SEC
        agent_health = parse_agent_health(n.get("agent_health"))

        agent_xray_ok = None if agent_health is None else bool(agent_health.get("xray_alive", True) and agent_health.get("port_ready", True))
        agent_tunnel_ok = None if (agent_health is None or "tunnel_connected" not in agent_health) else bool(agent_health.get("tunnel_connected"))
        core_label = "Sing-box" if str(n.get("core_type") or "xray").lower() == "singbox" else "Xray"

        if net_mode == "reverse_wss":
            if not hb_alive:
                status_code = "offline"
                reason = "节点心跳超时失联"
                healthy = False
            elif agent_xray_ok is False:
                status_code = "xray_unhealthy"
                reason = f"节点有心跳，但 {core_label} 进程或本地端口异常"
                healthy = False
            elif agent_tunnel_ok is False:
                status_code = "tunnel_disconnected"
                reason = "节点有心跳，但 WSS 反向隧道未连接"
                healthy = False
            else:
                status_code = "online"
                reason = "心跳正常且 WSS 反向隧道健康"
                healthy = True

            results[nid] = {
                "healthy": healthy,
                "reachable": healthy,
                "status_code": status_code,
                "reason": reason,
                "hb_alive": hb_alive,
                "hb_age_sec": hb_age_sec,
                "agent_health": agent_health,
                "tcp_ok": None,
                "tcp_rtt_ms": None,
                "tls_ok": None,
                "tls_rtt_ms": None,
                "tls_error": "",
                "rtt_ms": 0.0 if healthy else None,
                "net_mode": "reverse_wss",
                "network_mode": "reverse_tunnel",
                "ipv4_reachable": False,
                "ipv6_reachable": False,
                "recommended_endpoint": None,
                "last_heartbeat": last_hb,
            }
        else:
            snis = get_node_snis(n)
            primary_sni = snis[0] if snis else "www.microsoft.com"
            direct_targets.append((
                nid,
                (n.get("ip") or "").strip(),
                int(n.get("port") or 443),
                primary_sni,
                net_mode,
                last_hb,
                hb_alive,
                hb_age_sec,
                agent_health,
                agent_xray_ok,
            ))

    tunnel_updates: dict[str, str] = {}
    if direct_targets:
        def _probe_one(target):
            nid, ip, port, primary_sni, net_mode, last_hb, hb_alive, hb_age_sec, agent_health, agent_xray_ok = target
            tcp_ok, tcp_rtt_ms, det = edge_svc.probe_host_endpoint(ip, port)
            tls_ok = False
            tls_rtt_ms = None
            tls_error = ""
            if tcp_ok:
                probe_target_host = ip
                if det.ipv4_reachable and det.ipv4 and det.ipv4.host:
                    probe_target_host = det.ipv4.host
                elif det.ipv6_reachable and det.ipv6 and det.ipv6.host:
                    probe_target_host = det.ipv6.host
                tls_ok, tls_rtt_ms, tls_error = edge_svc.probe_tls_handshake(probe_target_host, port, primary_sni)
            else:
                tls_error = "TCP 端口不可达"
            return nid, tcp_ok, tcp_rtt_ms, tls_ok, tls_rtt_ms, tls_error, det, net_mode, last_hb, hb_alive, hb_age_sec, agent_health, agent_xray_ok

        max_workers = min(16, max(1, len(direct_targets)))
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            for (
                nid, tcp_ok, tcp_rtt_ms, tls_ok, tls_rtt_ms, tls_error, det,
                net_mode, last_hb, hb_alive, hb_age_sec, agent_health, agent_xray_ok
            ) in pool.map(_probe_one, direct_targets):
                tunnel_updates[nid] = det.network_mode

                # 联合判活：必须同时满足 心跳未超时 + 节点自检无故障 + TCP通 + TLS/REALITY握手通
                if not hb_alive and not tcp_ok:
                    status_code = "offline"
                    reason = "节点心跳失联且公网端口不可达"
                    healthy = False
                elif not hb_alive and tcp_ok and not tls_ok:
                    status_code = "tls_failed"
                    reason = f"心跳已断连，且端口仅 TCP 有响应但 {tls_error}"
                    healthy = False
                elif not hb_alive and tcp_ok and tls_ok:
                    status_code = "heartbeat_lost"
                    reason = "端口 TLS 有响应但节点心跳已断连（守护进程异常或 IP 已变更）"
                    healthy = False
                elif agent_xray_ok is False:
                    status_code = "xray_unhealthy"
                    reason = "节点心跳在线，但节点自检报告代理内核进程或本地端口异常"
                    healthy = False
                elif not tcp_ok:
                    status_code = "port_unreachable"
                    reason = "节点心跳正常，但 Hub 无法连通其公网代理端口"
                    healthy = False
                elif not tls_ok:
                    status_code = "tls_failed"
                    reason = f"TCP 握手成功，但 {tls_error}"
                    healthy = False
                else:
                    status_code = "online"
                    reason = "心跳活跃 + TCP/TLS REALITY 握手全部正常"
                    healthy = True

                results[nid] = {
                    "healthy": healthy,
                    "reachable": bool(tcp_ok and tls_ok),
                    "status_code": status_code,
                    "reason": reason,
                    "hb_alive": hb_alive,
                    "hb_age_sec": hb_age_sec,
                    "agent_health": agent_health,
                    "tcp_ok": tcp_ok,
                    "tcp_rtt_ms": tcp_rtt_ms,
                    "tls_ok": tls_ok,
                    "tls_rtt_ms": tls_rtt_ms,
                    "tls_error": tls_error,
                    "rtt_ms": tls_rtt_ms if tls_ok else tcp_rtt_ms,
                    "net_mode": net_mode,
                    "network_mode": det.network_mode,
                    "ipv4_reachable": det.ipv4_reachable,
                    "ipv6_reachable": det.ipv6_reachable,
                    "recommended_endpoint": det.recommended_endpoint,
                    "last_heartbeat": last_hb,
                }

    done_ts = time.time()
    done_dt = datetime.datetime.now()
    with db_session() as s:
        stmt = select(Node).where(Node.node_id == node_id) if node_id else select(Node).order_by(Node.id.asc())
        node_objs = s.scalars(stmt).all()
        for node_obj in node_objs:
            nid = node_obj.node_id
            if nid in tunnel_updates:
                node_obj.tunnel_status = tunnel_updates[nid]
            res_item = results.get(nid)
            if isinstance(res_item, dict):
                probe_record = {
                    "healthy": bool(res_item.get("healthy")),
                    "status_code": str(res_item.get("status_code") or "offline"),
                    "reason": str(res_item.get("reason") or "")[:120],
                    "net_mode": str(res_item.get("net_mode") or "direct"),
                    "tcp_ok": res_item.get("tcp_ok"),
                    "tcp_rtt_ms": res_item.get("tcp_rtt_ms"),
                    "tls_ok": res_item.get("tls_ok"),
                    "tls_rtt_ms": res_item.get("tls_rtt_ms"),
                    "tls_error": str(res_item.get("tls_error") or "")[:80],
                    "rtt_ms": res_item.get("rtt_ms"),
                    "ts": round(done_ts, 2),
                }
                node_obj.last_probe = json.dumps(probe_record, ensure_ascii=False, separators=(",", ":"))[:500]
        s.flush()
        nodes = [_enrich_node_dict(n.to_dict(), done_ts, done_dt) for n in node_objs]

    # 测活结果直接影响订阅健康过滤，立即刷新节点缓存
    invalidate_nodes_cache()

    return jsonify({
        "code": 200,
        "server_ts": done_ts,
        "msg": "节点联合深度测活完成（心跳 + 节点自检 + TCP/TLS REALITY 握手）",
        "data": results,
        "nodes": nodes,
    })


@admin_bp.route("/api/admin/nodes/force_resync", methods=["POST"])
def admin_nodes_force_resync():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get("node_id")
    with db_session() as s:
        node_obj = s.scalar(select(Node).where(Node.node_id == node_id))
        if node_obj:
            node_obj.pbk = ""
            node_obj.sid = ""
            node_obj.pending_key = "FORCE_RESYNC"
            node_obj.last_heartbeat = "等待重新上报"
            node_obj.last_heartbeat_ts = 0.0
            node_obj.agent_health = ""
            node_obj.last_probe = ""
    invalidate_nodes_cache()
    return jsonify({"code": 200, "msg": "重置指令已就绪！已开启重置接纳模式，节点将在下次回传时自动完成重绑并回传公钥。"})


@admin_bp.route("/api/admin/nodes/revoke_delete", methods=["POST"])
def admin_revoke_delete_node():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get("node_id")
    with db_session() as s:
        s.execute(delete(Node).where(Node.node_id == node_id))
    invalidate_nodes_cache()
    return jsonify({"code": 200, "msg": "节点已被彻底从集群中吊销并移除！"})


@admin_bp.route("/api/admin/nodes/reset_key", methods=["POST"])
def admin_reset_node_key():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get("node_id")
    new_key = "nk_" + secrets.token_hex(20)
    with db_session() as s:
        node_obj = s.scalar(select(Node).where(Node.node_id == node_id))
        if node_obj:
            node_obj.pending_key = new_key
    return jsonify({
        "code": 200,
        "msg": "重置密钥指令已就绪！节点将在 60 秒内心跳自动同步新密钥并持久化保存。",
        "new_key": new_key,
    })


@admin_bp.route("/api/admin/users/edit", methods=["POST"])
def edit_user_quota():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    target_user = data.get("target_user")
    limit_mb = int(data.get("limit_mb", 0))
    raw_expire = data.get("expire_date", "").strip()
    is_monthly = 1 if str(data.get("is_monthly")).lower() in ["1", "true"] else 0
    reset_day = int(data.get("reset_day", 1) or 1)
    user_group = str(data.get("user_group", "default")).strip() or "default"
    clean_expire = normalize_expire_date(raw_expire)

    with db_session() as s:
        user_obj = s.scalar(select(User).where(User.username == target_user))
        if user_obj:
            user_obj.traffic_limit_mb = limit_mb
            user_obj.expire_date = clean_expire
            user_obj.is_monthly = is_monthly
            user_obj.reset_day = reset_day
            user_obj.user_group = user_group
    invalidate_users_cache()
    return jsonify({
        "code": 200,
        "msg": f"用户 [{target_user}] 属性已更新！所属用户组：{user_group}，到期时限：{clean_expire}",
        "expire_date": clean_expire,
        "user_group": user_group,
    })


@admin_bp.route("/api/admin/users/reset_uuid", methods=["POST"])
def admin_reset_user_uuid():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    target_user = data.get("target_user")
    new_uuid = str(uuid.uuid4())
    user_dict = None
    with db_session() as s:
        user_obj = s.scalar(select(User).where(User.username == target_user))
        if user_obj:
            user_obj.uuid = new_uuid
            user_dict = user_obj.to_dict()
    invalidate_users_cache()

    if user_dict:
        title = "【安全通知】管理员已重置您的节点连接凭证 (UUID)"
        content = f"您好 {target_user}，管理员已为您重置节点连接凭证。旧凭证已彻底失效断网，请登录控制台复制最新订阅地址重新导入！"
        threading.Thread(
            target=notify_user,
            args=(user_dict, title, f"<h3>{title}</h3><p>{content}</p>", content),
            daemon=True,
        ).start()

    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 凭证 (UUID) 已重置为: {new_uuid}"})


@admin_bp.route("/api/admin/users/reset_password", methods=["POST"])
def admin_reset_password():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})
    target_user = data.get("target_user")
    new_pwd = data.get("new_password", "").strip()

    with db_session() as s:
        user_obj = s.scalar(select(User).where(User.username == target_user))
        if user_obj:
            user_obj.password_hash = hash_pwd(new_pwd)
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 密码已成功重置！"})


@admin_bp.route("/api/admin/users/status", methods=["POST"])
def update_user_status():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})
    target_user = data.get("target_user")
    status = int(data.get("status", 1))

    with db_session() as s:
        user_obj = s.scalar(select(User).where(User.username == target_user))
        if user_obj:
            user_obj.status = status
    invalidate_users_cache()
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 状态已更新"})


@admin_bp.route("/api/admin/users/delete", methods=["POST"])
def delete_user():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})
    target_user = data.get("target_user")

    with db_session() as s:
        s.execute(delete(User).where(User.username == target_user))
    invalidate_users_cache()
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 已被彻底删除"})


@admin_bp.route("/api/admin/notify/send", methods=["POST"])
def admin_send_notification():
    data = request.json or {}
    admin_user = data.get("admin_user")
    admin_pwd = data.get("admin_pwd")
    if not check_admin(admin_user, admin_pwd):
        return jsonify({"code": 403, "msg": "无权限"}), 403

    target = data.get("target", "all").strip()
    target_user = data.get("target_user", "").strip()
    title = data.get("title", "").strip()
    content = data.get("content", "").strip()

    if not title or not content:
        return jsonify({"code": 400, "msg": "通知标题和内容不能为空"}), 400

    if target == "single":
        if not target_user:
            return jsonify({"code": 400, "msg": "未指定接收用户"}), 400
        with db_session() as s:
            user_obj = s.scalar(select(User).where(User.username == target_user))
            if not user_obj:
                return jsonify({"code": 404, "msg": f"用户 [{target_user}] 不存在"}), 404
            user_dict = user_obj.to_dict()

        content_html = f"<div style='font-family: sans-serif; padding: 15px;'><h3>{title}</h3><p style='line-height: 1.6; white-space: pre-wrap;'>{content}</p></div>"
        ok, msg = notify_user(user_dict, title, content_html, content)
        if ok:
            return jsonify({"code": 200, "msg": f"已成功向用户 [{target_user}] 投递通知！通道：{user_dict['notify_type']}"})
        return jsonify({"code": 500, "msg": f"投递失败: {msg}"})

    with db_session() as s:
        users = [
            u.to_dict()
            for u in s.scalars(
                select(User).where(User.status == 1, User.is_verified == 1, User.role == "user")
            ).all()
        ]

    if not users:
        return jsonify({"code": 200, "msg": "全站暂无活跃用户，无需发送"})

    def broadcast_task(user_list, t, c_text):
        c_html = f"<div style='font-family: sans-serif; padding: 15px;'><h3>{t}</h3><p style='line-height: 1.6; white-space: pre-wrap;'>{c_text}</p></div>"
        success_cnt = 0
        for u in user_list:
            try:
                ok, _ = notify_user(u, t, c_html, c_text)
                if ok:
                    success_cnt += 1
            except Exception:
                pass
            time.sleep(0.5)
        print(f"==> [Broadcast] 全站广播通知完成: 成功投递 {success_cnt}/{len(user_list)} 位用户", flush=True)

    threading.Thread(target=broadcast_task, args=(users, title, content), daemon=True).start()
    return jsonify({"code": 200, "msg": f"已启动后台广播队列，正在按用户偏好向全站 {len(users)} 位用户逐一推送通知！"})