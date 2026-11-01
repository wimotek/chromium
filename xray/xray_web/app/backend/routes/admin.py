import re
import uuid
import secrets
import datetime
import threading
import time
from flask import Blueprint, request, jsonify
from core.db import get_db, hash_pwd
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

    c.execute("SELECT * FROM nodes WHERE status=1 ORDER BY id ASC")
    active_nodes = [dict(n) for n in c.fetchall()]

    c.execute("SELECT username, email, traffic_limit_mb, used_mb, expire_date, role, uuid, status, notify_type, is_monthly, reset_day FROM users")
    raw_users = c.fetchall()
    conn.close()

    host_prefix = request.host_url.rstrip('/')
    users = []
    for r in raw_users:
        d = dict(r)
        d['sub_url'] = f"{host_prefix}/api/sub?token={d['uuid']}"
        d['used_mb'] = round(d['used_mb'], 2)
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
                    "link": build_node_link(d['uuid'], n, f"{n['name']}", chosen_sni=chosen_sni)
                })
        users.append(d)

    return jsonify({"code": 200, "cards": cards, "users": users})

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

@admin_bp.route('/api/admin/users/edit', methods=['POST'])
def edit_user_quota():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    target_user = data.get('target_user')
    limit_mb = int(data.get('limit_mb', 0))
    raw_expire = data.get('expire_date', '').strip()
    is_monthly = 1 if str(data.get('is_monthly')).lower() in ['1', 'true'] else 0
    reset_day = int(data.get('reset_day', 1) or 1)

    clean_expire = normalize_expire_date(raw_expire)

    conn = get_db()
    c = conn.cursor()
    c.execute("""
        UPDATE users 
        SET traffic_limit_mb=?, expire_date=?, is_monthly=?, reset_day=? 
        WHERE username=?
    """, (limit_mb, clean_expire, is_monthly, reset_day, target_user))
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": f"用户 [{target_user}] 配额属性已更新！到期时限已对齐至 {clean_expire}", "expire_date": clean_expire})

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
    status = int(data.get('status', 1))

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
    c.execute("""
        UPDATE nodes 
        SET name=?, ip=?, port=?, dest=?, sni=?, server_names=?, sid=?, node_key=?, status=?
        WHERE node_id=?
    """, (name, ip, port, dest, primary_sni, server_names_str, sid, node_key, status, node_id))
    conn.commit()
    conn.close()

    return jsonify({"code": 200, "msg": "节点配置已更新！多域名列表已同步，远程节点下次回传时自动热重载。"})

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
    new_key = secrets.token_hex(16)

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