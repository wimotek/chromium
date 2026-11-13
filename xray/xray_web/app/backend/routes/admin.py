import re
import uuid
import secrets
import datetime
import threading
import time
from flask import Blueprint, request, jsonify
from core.db import get_db, hash_pwd, get_setting, set_setting
from services.notify_service import notify_user
from routes import check_admin, get_node_snis, build_node_link, normalize_expire_date

admin_bp = Blueprint('admin_bp', __name__)

@admin_bp.route('/api/admin/data', methods=['POST'])
def admin_data():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT code, traffic_gb, days, is_used, used_by, created_at, used_at, is_monthly FROM cards ORDER BY rowid DESC LIMIT 200")
    cards = [dict(r) for r in c.fetchall()]

    c.execute("SELECT * FROM nodes ORDER BY id ASC")
    active_nodes = [dict(n) for n in c.fetchall()]

    c.execute("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 150")
    audit_logs = [dict(a) for a in c.fetchall()]

    c.execute("SELECT username, email, traffic_limit_mb, used_mb, expire_date, role, uuid, status, notify_type, is_monthly, reset_day, user_group FROM users")
    raw_users = c.fetchall()
    conn.close()

    host_prefix = request.host_url.rstrip('/')
    users = []
    for r in raw_users:
        d = dict(r)
        d['sub_url'] = f"{host_prefix}/api/sub?token={d['uuid']}"
        d['used_mb'] = round(d.get('used_mb', 0), 2)
        d['node_links'] = []
        for n in active_nodes:
            if len(n.get("pbk", "")) == 43:
                snis = get_node_snis(n)
                chosen_sni = snis[0]
                d['node_links'].append({
                    "id": n['id'],
                    "node_id": n['node_id'],
                    "name": n['name'],
                    "ip": n['ip'],
                    "port": n['port'],
                    "pbk": n['pbk'],
                    "sid": n['sid'],
                    "sni": chosen_sni,
                    "server_names": snis,
                    "selected_sni": chosen_sni,
                    "link": build_node_link(d['uuid'], n, f"{n['name']}", chosen_sni=chosen_sni, hub_domain=request.host)
                })
        users.append(d)

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
            "panel_url": host_prefix
        }
    })

# 集群通信引导令牌管理
@admin_bp.route('/api/admin/cluster/token', methods=['GET', 'POST'])
def admin_cluster_token():
    if request.method == 'GET':
        admin_user = request.args.get('admin_user')
        admin_pwd = request.args.get('admin_pwd')
        if not check_admin(admin_user, admin_pwd): return jsonify({"code": 403, "msg": "无权限"})
        return jsonify({
            "code": 200,
            "cluster_token": get_setting("cluster_token", ""),
            "tofu_enabled": get_setting("tofu_enabled", "true").lower() == "true",
            "auto_approve": get_setting("node_auto_approve", "true").lower() == "true"
        })
    else:
        data = request.json or {}
        if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
        
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

# 管理员手动审批激活隔离节点
@admin_bp.route('/api/admin/nodes/approve', methods=['POST'])
def admin_approve_node():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    node_id = data.get("node_id")

    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE nodes SET is_approved=1, status=1 WHERE node_id=?", (node_id,))
    conn.commit()
    conn.close()

    return jsonify({"code": 200, "msg": f"节点 [{node_id}] 审核批准通过！已解除隔离并激活上线服务。"})

@admin_bp.route('/api/admin/nodes/save_config', methods=['POST'])
def admin_save_node_config():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get('node_id')
    name = data.get('name', '').strip()
    ip = data.get('ip', '').strip()
    port = int(data.get('port', 443))
    raw_dest = data.get('dest', 'www.microsoft.com:443').strip()
    raw_server_names = data.get('server_names', '').strip()
    raw_sni = data.get('sni', 'www.microsoft.com').strip()
    sid = data.get('sid', '').strip()
    node_key = data.get('node_key', '').strip()

    dest = raw_dest if ":" in raw_dest else f"{raw_dest}:443"

    snis = []
    for part in re.split(r'[,;\s]+', raw_server_names or raw_sni):
        clean = part.strip().split(":")[0]
        if clean and clean not in snis:
            snis.append(clean)
    server_names_str = ",".join(snis)
    primary_sni = snis[0] if snis else "www.microsoft.com"

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT node_key, sid FROM nodes WHERE node_id=?", (node_id,))
    cur_node = c.fetchone()
    if not cur_node:
        conn.close()
        return jsonify({"code": 404, "msg": "未找到对应节点"})

    # 严密保护 TOFU 固化密钥与 ShortId：禁止空值覆写破坏已有加密握手凭证
    final_node_key = cur_node["node_key"] if cur_node["node_key"] else node_key
    final_sid = cur_node["sid"] if cur_node["sid"] else sid

    c.execute("""
        UPDATE nodes 
        SET name=?, ip=?, port=?, dest=?, sni=?, server_names=?, sid=?, node_key=?
        WHERE node_id=?
    """, (name, ip, port, dest, primary_sni, server_names_str, final_sid, final_node_key, node_id))
    conn.commit()
    conn.close()

    return jsonify({"code": 200, "msg": "节点网络配置已保存！"})

@admin_bp.route('/api/admin/nodes/save_permission', methods=['POST'])
def admin_save_node_permission():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get('node_id')
    status = int(data.get('status', 1))
    allow_all = int(data.get('allow_all', 1))
    allowed_groups = data.get('allowed_groups', '').strip()
    allowed_users = data.get('allowed_users', '').strip()

    conn = get_db()
    c = conn.cursor()
    c.execute("""
        UPDATE nodes 
        SET status=?, allow_all=?, allowed_groups=?, allowed_users=?
        WHERE node_id=?
    """, (status, allow_all, allowed_groups, allowed_users, node_id))
    conn.commit()
    conn.close()

    action_text = "🟢 已启动并生效" if status == 1 else "🛑 已停止并阻断"
    return jsonify({"code": 200, "msg": f"节点运行权限策略已保存 ({action_text})！"})

@admin_bp.route('/api/admin/nodes/list', methods=['POST'])
def admin_list_nodes():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM nodes ORDER BY id ASC")
    nodes = [dict(n) for n in c.fetchall()]
    conn.close()
    return jsonify({"code": 200, "data": nodes})

@admin_bp.route('/api/admin/nodes/ping', methods=['POST'])
def admin_ping_node():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get('node_id', '').strip()
    conn = get_db()
    c = conn.cursor()
    if node_id:
        c.execute("SELECT * FROM nodes WHERE node_id=?", (node_id,))
        nodes = [dict(n) for n in c.fetchall()]
    else:
        c.execute("SELECT * FROM nodes ORDER BY id ASC")
        nodes = [dict(n) for n in c.fetchall()]
    conn.close()

    import socket
    import time
    results = {}
    for n in nodes:
        nid = n['node_id']
        ip = n.get('ip')
        port = int(n.get('port', 443))
        reachable = False
        rtt_ms = None
        if ip and ip != '0.0.0.0':
            t0 = time.time()
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(1.5)
                res = s.connect_ex((ip, port))
                s.close()
                if res == 0:
                    reachable = True
                    rtt_ms = round((time.time() - t0) * 1000, 1)
            except Exception:
                pass
        results[nid] = {
            "reachable": reachable,
            "rtt_ms": rtt_ms,
            "last_heartbeat": n.get('last_heartbeat', '')
        }

    return jsonify({"code": 200, "msg": "心跳与端口连通性检测完成", "data": results, "nodes": nodes})

@admin_bp.route('/api/admin/nodes/force_resync', methods=['POST'])
def admin_nodes_force_resync():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get('node_id')
    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE nodes SET pbk='', sid='', pending_key='FORCE_RESYNC', last_heartbeat='等待重新上报' WHERE node_id=?", (node_id,))
    conn.commit()
    conn.close()

    return jsonify({"code": 200, "msg": "重置指令已就绪！已开启重置接纳模式，节点将在下次回传时自动完成重绑并回传公钥。"})

@admin_bp.route('/api/admin/nodes/revoke_delete', methods=['POST'])
def admin_revoke_delete_node():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get('node_id')
    conn = get_db()
    c = conn.cursor()
    c.execute("DELETE FROM nodes WHERE node_id=?", (node_id,))
    conn.commit()
    conn.close()

    return jsonify({"code": 200, "msg": "节点已被彻底从集群中吊销并移除！"})

@admin_bp.route('/api/admin/nodes/reset_key', methods=['POST'])
def admin_reset_node_key():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    node_id = data.get('node_id')
    new_key = "nk_" + secrets.token_hex(20)

    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE nodes SET pending_key=? WHERE node_id=?", (new_key, node_id))
    conn.commit()
    conn.close()

    return jsonify({
        "code": 200,
        "msg": "重置密钥指令已就绪！节点将在 60 秒内心跳自动同步新密钥并持久化保存。",
        "new_key": new_key
    })

@admin_bp.route('/api/admin/users/edit', methods=['POST'])
def edit_user_quota():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    target_user = data.get('target_user')
    limit_mb = int(data.get('limit_mb', 0))
    raw_expire = data.get('expire_date', '').strip()
    is_monthly = 1 if str(data.get('is_monthly')).lower() in ['1', 'true'] else 0
    reset_day = int(data.get('reset_day', 1) or 1)
    user_group = str(data.get('user_group', 'default')).strip() or 'default'

    clean_expire = normalize_expire_date(raw_expire)

    conn = get_db()
    c = conn.cursor()
    c.execute("""
        UPDATE users 
        SET traffic_limit_mb=?, expire_date=?, is_monthly=?, reset_day=?, user_group=? 
        WHERE username=?
    """, (limit_mb, clean_expire, is_monthly, reset_day, user_group, target_user))
    conn.commit()
    conn.close()
    return jsonify({
        "code": 200, 
        "msg": f"用户 [{target_user}] 属性已更新！所属用户组：{user_group}，到期时限：{clean_expire}",
        "expire_date": clean_expire,
        "user_group": user_group
    })

@admin_bp.route('/api/admin/users/reset_uuid', methods=['POST'])
def admin_reset_user_uuid():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    target_user = data.get('target_user')
    new_uuid = str(uuid.uuid4())
    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE users SET uuid=? WHERE username=?", (new_uuid, target_user))
    c.execute("SELECT * FROM users WHERE username=?", (target_user,))
    user = c.fetchone()
    conn.commit()
    conn.close()

    if user:
        title = "【安全通知】管理员已重置您的节点连接凭证 (UUID)"
        content = f"您好 {target_user}，管理员已为您重置节点连接凭证。旧凭证已彻底失效断网，请登录控制台复制最新订阅地址重新导入！"
        notify_user(dict(user), title, f"<h3>{title}</h3><p>{content}</p>", content)

    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 凭证 (UUID) 已重置为: {new_uuid}"})

@admin_bp.route('/api/admin/users/reset_password', methods=['POST'])
def admin_reset_password():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    target_user = data.get('target_user')
    new_pwd = data.get('new_password', '').strip()

    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE users SET password_hash=? WHERE username=?", (hash_pwd(new_pwd), target_user))
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 密码已成功重置！"})

@admin_bp.route('/api/admin/users/status', methods=['POST'])
def update_user_status():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    target_user = data.get('target_user')
    status = int(data.get('status', 1))

    conn = get_db()
    c = conn.cursor()
    c.execute("UPDATE users SET status=? WHERE username=?", (status, target_user))
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 状态已更新"})

@admin_bp.route('/api/admin/users/delete', methods=['POST'])
def delete_user():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})
    target_user = data.get('target_user')

    conn = get_db()
    c = conn.cursor()
    c.execute("DELETE FROM users WHERE username=?", (target_user,))
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 已被彻底删除"})

@admin_bp.route('/api/admin/notify/send', methods=['POST'])
def admin_send_notification():
    data = request.json or {}
    admin_user = data.get('admin_user')
    admin_pwd = data.get('admin_pwd')
    if not check_admin(admin_user, admin_pwd):
        return jsonify({"code": 403, "msg": "无权限"}), 403

    target = data.get('target', 'all').strip()
    target_user = data.get('target_user', '').strip()
    title = data.get('title', '').strip()
    content = data.get('content', '').strip()

    if not title or not content:
        return jsonify({"code": 400, "msg": "通知标题和内容不能为空"}), 400

    conn = get_db()
    c = conn.cursor()

    if target == 'single':
        if not target_user:
            conn.close()
            return jsonify({"code": 400, "msg": "未指定接收用户"}), 400

        c.execute("SELECT * FROM users WHERE username=?", (target_user,))
        user = c.fetchone()
        conn.close()
        if not user:
            return jsonify({"code": 404, "msg": f"用户 [{target_user}] 不存在"}), 404

        content_html = f"<div style='font-family: sans-serif; padding: 15px;'><h3>{title}</h3><p style='line-height: 1.6; white-space: pre-wrap;'>{content}</p></div>"
        ok, msg = notify_user(dict(user), title, content_html, content)
        if ok:
            return jsonify({"code": 200, "msg": f"已成功向用户 [{target_user}] 投递通知！通道：{user['notify_type']}"})
        else:
            return jsonify({"code": 500, "msg": f"投递失败: {msg}"})

    else:
        c.execute("SELECT * FROM users WHERE status=1 AND is_verified=1 AND role='user'")
        users = [dict(u) for u in c.fetchall()]
        conn.close()

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