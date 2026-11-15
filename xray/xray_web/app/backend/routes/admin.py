import datetime
import re
import secrets
import threading
import time
import uuid

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
    build_node_link,
    check_admin,
    get_node_snis,
    normalize_expire_date,
    resolve_public_endpoint,
)
from services.notify_service import notify_user

admin_bp = Blueprint("admin_bp", __name__)


@admin_bp.route("/api/admin/data", methods=["POST"])
def admin_data():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    with db_session() as s:
        cards = [c.to_dict() for c in s.scalars(select(Card).order_by(Card.created_at.desc()).limit(200)).all()]
        active_nodes = [n.to_dict() for n in s.scalars(select(Node).order_by(Node.id.asc())).all()]
        audit_logs = [a.to_dict() for a in s.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(150)).all()]
        raw_users = s.scalars(select(User)).all()
        user_dicts = [u.to_dict() for u in raw_users]

    hub_host, hub_port, host_prefix = resolve_public_endpoint(request)
    users = []
    for d in user_dicts:
        user_item = {
            "username": d["username"],
            "email": d["email"],
            "traffic_limit_mb": d["traffic_limit_mb"],
            "used_mb": round(d.get("used_mb", 0), 2),
            "expire_date": d["expire_date"],
            "role": d["role"],
            "uuid": d["uuid"],
            "status": d["status"],
            "notify_type": d["notify_type"],
            "is_monthly": d["is_monthly"],
            "reset_day": d["reset_day"],
            "user_group": d["user_group"],
            "sub_url": f"{host_prefix}/api/sub?token={d['uuid']}",
            "node_links": [],
        }
        for n in active_nodes:
            if len(n.get("pbk", "")) == 43:
                snis = get_node_snis(n)
                chosen_sni = snis[0]
                user_item["node_links"].append({
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
                    "link": build_node_link(
                        d["uuid"],
                        n,
                        f"{n['name']}",
                        chosen_sni=chosen_sni,
                        hub_domain=hub_host,
                        hub_port=hub_port,
                    ),
                })
        users.append(user_item)

    cluster_token = get_setting("cluster_token", "")
    auto_approve = get_setting("node_auto_approve", "true").lower() == "true"
    tofu_enabled = get_setting("tofu_enabled", "true").lower() == "true"

    return jsonify({
        "code": 200,
        "cards": cards,
        "users": users,
        "nodes": active_nodes,
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

    with db_session() as s:
        nodes = [n.to_dict() for n in s.scalars(select(Node).order_by(Node.id.asc())).all()]
    return jsonify({"code": 200, "data": nodes})


@admin_bp.route("/api/admin/nodes/ping", methods=["POST"])
def admin_ping_node():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get("node_id", "").strip()
    from core.edge_agent_service import EdgeAgentService
    edge_svc = EdgeAgentService.get_instance()
    now_dt = datetime.datetime.now()
    results = {}

    with db_session() as s:
        stmt = select(Node).where(Node.node_id == node_id) if node_id else select(Node).order_by(Node.id.asc())
        node_objs = s.scalars(stmt).all()

        for node_obj in node_objs:
            nid = node_obj.node_id
            ip = (node_obj.ip or "").strip()
            port = int(node_obj.port or 443)
            net_mode = node_obj.net_mode or "direct"
            last_hb = node_obj.last_heartbeat or ""

            hb_alive = False
            if last_hb and "等待" not in last_hb and "下线" not in last_hb:
                try:
                    hb_dt = datetime.datetime.strptime(last_hb, "%Y-%m-%d %H:%M:%S")
                    hb_alive = (now_dt - hb_dt).total_seconds() <= 135
                except Exception:
                    pass

            if net_mode == "reverse_wss":
                results[nid] = {
                    "reachable": hb_alive,
                    "rtt_ms": 0.0 if hb_alive else None,
                    "net_mode": "reverse_wss",
                    "network_mode": "reverse_tunnel",
                    "ipv4_reachable": False,
                    "ipv6_reachable": False,
                    "recommended_endpoint": None,
                    "last_heartbeat": last_hb,
                }
                continue

            reachable, rtt_ms, det = edge_svc.probe_host_endpoint(ip, port)
            node_obj.tunnel_status = det.network_mode
            results[nid] = {
                "reachable": reachable,
                "rtt_ms": rtt_ms,
                "net_mode": net_mode,
                "network_mode": det.network_mode,
                "ipv4_reachable": det.ipv4_reachable,
                "ipv6_reachable": det.ipv6_reachable,
                "recommended_endpoint": det.recommended_endpoint,
                "last_heartbeat": last_hb,
            }

        s.flush()
        nodes = [n.to_dict() for n in node_objs]

    return jsonify({"code": 200, "msg": "基于 wimotek-edge-agent TCP 三次握手的节点连通性检测完成", "data": results, "nodes": nodes})


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
        notify_user(user_dict, title, f"<h3>{title}</h3><p>{content}</p>", content)

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