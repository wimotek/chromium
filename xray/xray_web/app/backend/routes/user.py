import datetime
import random
import re
import threading
import uuid

from flask import Blueprint, abort, jsonify, request, send_file
from sqlalchemy import or_, select, update

from core.cache import cache
from core.db import db_session, get_cached_nodes, hash_pwd, invalidate_users_cache
from core.models import Card, User
from core.rate_limit import (
    check_cooldown,
    check_ip_ban,
    consume_rate_limit,
    get_client_ip,
    rate_limit,
    rate_limit_response,
    reset_rate_counter,
    set_cooldown,
)
from routes import (
    build_node_link,
    get_node_snis,
    is_user_allowed_for_node,
    normalize_expire_date,
    resolve_public_endpoint,
)
from services.client_pack_service import ensure_base_v2rayng_apk, generate_windows_package
from services.notify_service import notify_user, send_smtp_email

user_bp = Blueprint("user_bp", __name__)

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


@user_bp.route("/api/user/refresh_info", methods=["POST"])
@rate_limit("refresh_info_ip", limit=60, window_seconds=60, msg="状态刷新过于频繁，请稍后再试")
def user_refresh_info():
    data = request.json or {}
    username = data.get("username")
    with db_session(readonly=True) as s:
        user_obj = s.scalar(select(User).where(or_(User.username == username, User.email == username)))
        if not user_obj:
            return jsonify({"code": 404, "msg": "用户不存在"})
        user_dict = user_obj.to_dict()

    all_nodes = get_cached_nodes()
    visible_nodes = [n for n in all_nodes if is_user_allowed_for_node(user_dict, n)]

    nodes_data = []
    hub_host, hub_port, host_prefix = resolve_public_endpoint(request)
    sub_url = f"{host_prefix}/api/sub?token={user_dict['uuid']}"

    for n in visible_nodes:
        if len(n.get("pbk", "")) == 43:
            snis = get_node_snis(n)
            random_sni = random.choice(snis)
            link = build_node_link(
                user_dict["uuid"],
                n,
                f"{n['name']}",
                chosen_sni=random_sni,
                hub_domain=hub_host,
                hub_port=hub_port,
            )
            nodes_data.append({
                "id": n["id"],
                "name": n["name"],
                "ip": n["ip"],
                "port": n["port"],
                "pbk": n["pbk"],
                "sid": n["sid"],
                "server_names": snis,
                "selected_sni": random_sni,
                "link": link,
            })

    return jsonify({
        "code": 200,
        "data": {
            "username": user_dict["username"],
            "email": user_dict["email"],
            "role": user_dict["role"],
            "uuid": user_dict["uuid"],
            "used_mb": round(user_dict.get("used_mb", 0), 2),
            "limit_mb": user_dict["traffic_limit_mb"],
            "expire_date": user_dict["expire_date"],
            "is_monthly": user_dict["is_monthly"] or 0,
            "reset_day": user_dict["reset_day"] or 1,
            "user_group": user_dict.get("user_group", "default"),
            "sub_url": sub_url,
            "nodes": nodes_data,
            "notify_type": user_dict["notify_type"] or "email",
            "serverchan_key": user_dict["serverchan_key"] or "",
        },
    })


@user_bp.route("/api/user/reset_uuid", methods=["POST"])
@rate_limit("reset_uuid_ip", limit=10, window_seconds=300, msg="重置 UUID 操作过于频繁，请 5 分钟后再试")
def user_reset_uuid():
    data = request.json or {}
    username = data.get("username")
    if not username:
        return jsonify({"code": 400, "msg": "参数缺失"}), 400

    new_uuid = str(uuid.uuid4())
    with db_session() as s:
        user_obj = s.scalar(select(User).where(User.username == username))
        if not user_obj:
            return jsonify({"code": 404, "msg": "用户不存在"}), 404
        user_obj.uuid = new_uuid
        user_dict = user_obj.to_dict()

    invalidate_users_cache()
    all_nodes = get_cached_nodes()
    visible_nodes = [n for n in all_nodes if is_user_allowed_for_node(user_dict, n)]

    hub_host, hub_port, host_prefix = resolve_public_endpoint(request)
    sub_url = f"{host_prefix}/api/sub?token={new_uuid}"
    nodes_data = []
    for n in visible_nodes:
        if len(n.get("pbk", "")) == 43:
            snis = get_node_snis(n)
            random_sni = random.choice(snis)
            link = build_node_link(
                new_uuid,
                n,
                f"{n['name']}",
                chosen_sni=random_sni,
                hub_domain=hub_host,
                hub_port=hub_port,
            )
            nodes_data.append({
                "id": n["id"],
                "name": n["name"],
                "ip": n["ip"],
                "port": n["port"],
                "pbk": n["pbk"],
                "sid": n["sid"],
                "server_names": snis,
                "selected_sni": random_sni,
                "link": link,
            })

    return jsonify({
        "code": 200,
        "msg": "节点凭证 (UUID) 已重置！旧链接已立即失效，请重新导入订阅。",
        "data": {
            "uuid": new_uuid,
            "sub_url": sub_url,
            "nodes": nodes_data,
        },
    })


@user_bp.route("/api/user/send_change_email_code", methods=["POST"])
def send_change_email_code():
    ip = get_client_ip()
    banned, ban_wait, ban_reason = check_ip_ban(ip)
    if banned:
        return rate_limit_response(
            f"安全拦截（{ban_reason}），该 IP 已被临时限制访问，请 {ban_wait} 秒后再试",
            retry_after=ban_wait,
        )

    allowed_burst, _, remaining_burst = consume_rate_limit("send_chg_email_ip", ip, limit=5, window_seconds=300)
    if not allowed_burst:
        return rate_limit_response("请求过于频繁，请 5 分钟后再试", retry_after=300, limit=5, remaining=remaining_burst)

    data = request.json or {}
    username = data.get("username", "").strip()
    new_email = data.get("new_email", "").strip().lower()

    if not username or not new_email or len(new_email) > 120 or not EMAIL_RE.match(new_email):
        return jsonify({"code": 400, "msg": "请输入合法有效的新电子邮箱"}), 400

    cd_ok, wait_sec = check_cooldown("chg_email", f"{username}:{new_email}")
    if not cd_ok:
        return rate_limit_response(f"操作过于频繁，请 {wait_sec} 秒后再试", retry_after=wait_sec)

    allowed_target_daily, _, _ = consume_rate_limit("send_target_daily", new_email, limit=10, window_seconds=86400, sliding=False)
    if not allowed_target_daily:
        return rate_limit_response("该邮箱今日接收验证码次数已达上限，请明天再试", retry_after=3600)

    with db_session() as s:
        user_obj = s.scalar(select(User).where(User.username == username))
        if not user_obj:
            return jsonify({"code": 404, "msg": "用户账号不存在"}), 404
        if user_obj.email == new_email:
            return jsonify({"code": 400, "msg": "新邮箱不能与当前绑定的旧邮箱相同"}), 400
        if s.scalar(select(User.id).where(User.email == new_email, User.username != username).limit(1)):
            return jsonify({"code": 400, "msg": "该新邮箱已被其他账号绑定使用"}), 400

    code = f"{random.randint(100000, 999999)}"
    set_cooldown("chg_email", f"{username}:{new_email}", 60)
    cache.set_json(f"vcode:change_email:{username}:{new_email}", {"code": code}, ttl=600)
    reset_rate_counter("otp_fail_chg_email", f"{username}:{new_email}")

    content = f"""
    <div style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 25px; border-radius: 8px;">
        <h2 style="color: #38bdf8;">📧 Xray Reality 更换绑定邮箱验证</h2>
        <p>您好 <b>{username}</b>！您正在申请将账号绑定邮箱更换为本邮箱地址。</p>
        <p>您的安全验证码为：<b style="font-size: 24px; color: #10b981; letter-spacing: 2px;">{code}</b></p>
        <p style="color: #94a3b8; font-size: 12px;">验证码 10 分钟内有效。如非本人操作，请立即检查账号安全。</p>
    </div>
    """
    ok, msg = send_smtp_email(new_email, "【Xray】更换绑定邮箱验证码", content)
    if not ok:
        return jsonify({"code": 500, "msg": f"验证码投递失败: {msg}"}), 500

    return jsonify({"code": 200, "msg": "验证码已成功投递至新邮箱，请前往查收"})


@user_bp.route("/api/user/change_email", methods=["POST"])
@rate_limit("chg_email_ip", limit=10, window_seconds=300, msg="更换邮箱请求过于频繁，请 5 分钟后再试")
def user_change_email():
    data = request.json or {}
    username = data.get("username", "").strip()
    new_email = data.get("new_email", "").strip().lower()
    code = data.get("code", "").strip()
    password = data.get("password", "").strip()

    if not username or not new_email or not code or not password:
        return jsonify({"code": 400, "msg": "所有项均为必填项"}), 400

    with db_session() as s:
        user_obj = s.scalar(
            select(User).where(
                or_(User.username == username, User.email == username),
                User.password_hash == hash_pwd(password),
            )
        )
        if not user_obj:
            return jsonify({"code": 401, "msg": "当前账号登录密码验证失败"}), 401

        real_username = user_obj.username
        vcode_data = cache.get_json(f"vcode:change_email:{real_username}:{new_email}")
        if not isinstance(vcode_data, dict) or vcode_data.get("code") != code:
            alt_data = cache.get_json(f"vcode:change_email:{username}:{new_email}")
            if not isinstance(alt_data, dict) or alt_data.get("code") != code:
                allowed_try, _, _ = consume_rate_limit(
                    "otp_fail_chg_email", f"{real_username}:{new_email}", limit=5, window_seconds=600
                )
                if not allowed_try:
                    cache.delete(
                        f"vcode:change_email:{real_username}:{new_email}",
                        f"vcode:change_email:{username}:{new_email}",
                    )
                    return jsonify({"code": 400, "msg": "验证码错误次数过多，已失效，请重新获取"})
                return jsonify({"code": 400, "msg": "新邮箱验证码错误或已失效"})

        if s.scalar(select(User.id).where(User.email == new_email, User.username != real_username).limit(1)):
            return jsonify({"code": 400, "msg": "该新邮箱已被其他账号占用"}), 400

        user_obj.email = new_email
        user_dict = user_obj.to_dict()

    cache.delete(f"vcode:change_email:{real_username}:{new_email}", f"vcode:change_email:{username}:{new_email}")
    reset_rate_counter("otp_fail_chg_email", f"{real_username}:{new_email}")
    invalidate_users_cache()

    notice_content = f"您好 {real_username}，您的账号绑定邮箱已成功更换为 {new_email}。"
    threading.Thread(
        target=notify_user,
        args=(user_dict, "【安全通知】账号绑定邮箱已成功修改", f"<p>{notice_content}</p>", notice_content),
        daemon=True,
    ).start()

    return jsonify({"code": 200, "msg": "绑定邮箱修改成功！", "new_email": new_email})


@user_bp.route("/api/user/change_password", methods=["POST"])
@rate_limit("chg_pwd_ip", limit=10, window_seconds=300, msg="修改密码请求过于频繁，请 5 分钟后再试")
def change_password():
    data = request.json or {}
    username = (data.get("username") or "").strip()
    old_pwd = data.get("old_password", "")
    new_pwd = data.get("new_password", "").strip()

    if not username or not old_pwd or not new_pwd:
        return jsonify({"code": 400, "msg": "请输入完整密码信息"}), 400
    if len(new_pwd) < 6 or len(new_pwd) > 128:
        return jsonify({"code": 400, "msg": "新密码长度需在 6~128 位之间"}), 400

    acct_key = username.lower()
    lock_ok, wait_sec = check_cooldown("chg_pwd_lock", acct_key)
    if not lock_ok:
        return rate_limit_response(f"原密码连续错误次数过多，请 {wait_sec} 秒后再试", retry_after=wait_sec)

    with db_session() as s:
        user_obj = s.scalar(
            select(User).where(User.username == username, User.password_hash == hash_pwd(old_pwd))
        )
        if not user_obj:
            allowed_fail, _, _ = consume_rate_limit("chg_pwd_fail", acct_key, limit=5, window_seconds=600, sliding=False)
            if not allowed_fail:
                set_cooldown("chg_pwd_lock", acct_key, 600)
                return rate_limit_response("原密码连续验证错误过多，改密功能已临时锁定 10 分钟", retry_after=600)
            return jsonify({"code": 400, "msg": "原旧密码验证错误"})
        user_obj.password_hash = hash_pwd(new_pwd)
    reset_rate_counter("chg_pwd_fail", acct_key)
    return jsonify({"code": 200, "msg": "密码修改成功，请重新登录"})


@user_bp.route("/api/user/notify_settings", methods=["POST"])
def update_notify_settings():
    data = request.json or {}
    username = data.get("username")
    notify_type = data.get("notify_type", "email")
    serverchan_key = data.get("serverchan_key", "").strip()

    with db_session() as s:
        user_obj = s.scalar(select(User).where(User.username == username))
        if user_obj:
            user_obj.notify_type = notify_type
            user_obj.serverchan_key = serverchan_key
    return jsonify({"code": 200, "msg": "通知偏好设置已更新"})


@user_bp.route("/api/user/test_notify", methods=["POST"])
@rate_limit("test_notify_ip", limit=5, window_seconds=300, msg="测试通知触发过于频繁，请 5 分钟后再试")
def user_test_notify():
    data = request.json or {}
    username = data.get("username")
    with db_session() as s:
        user_obj = s.scalar(select(User).where(User.username == username))
        if not user_obj:
            return jsonify({"code": 404, "msg": "用户不存在"})
        user_dict = user_obj.to_dict()

    title = "【通知测试】Xray 节点服务消息连通性验证"
    content = f"恭喜！您的通知通道验证成功。当前通知通道：{user_dict['notify_type']}。"
    ok, msg = notify_user(user_dict, title, f"<h3>{title}</h3><p>{content}</p>", content)
    if ok:
        return jsonify({"code": 200, "msg": "测试消息发送成功"})
    return jsonify({"code": 500, "msg": msg})


@user_bp.route("/api/user/download_client", methods=["GET"])
@rate_limit("dl_client_ip", limit=8, window_seconds=300, msg="客户端打包下载过于频繁，请 5 分钟后再试")
def download_windows_client():
    account = request.args.get("username", "").strip()
    if not account:
        abort(400)

    with db_session(readonly=True) as s:
        user_obj = s.scalar(select(User).where(or_(User.username == account, User.email == account)))
        if not user_obj:
            abort(404)
        user_dict = user_obj.to_dict()

    _, _, host_prefix = resolve_public_endpoint(request)
    try:
        mem_file = generate_windows_package(user_dict, host_prefix)
        filename = f"v2rayN_WithCore_{user_dict['username']}.zip"
        return send_file(mem_file, as_attachment=True, download_name=filename, mimetype="application/zip")
    except Exception as e:
        return jsonify({"code": 500, "msg": f"客户端构建失败: {str(e)}"}), 500


@user_bp.route("/api/user/download_apk", methods=["GET"])
@rate_limit("dl_apk_ip", limit=10, window_seconds=300, msg="APK 下载请求过于频繁，请 5 分钟后再试")
def download_android_apk():
    try:
        apk_path = ensure_base_v2rayng_apk()
        return send_file(
            apk_path,
            as_attachment=True,
            download_name="v2rayNG_latest.apk",
            mimetype="application/vnd.android.package-archive",
        )
    except Exception as e:
        return jsonify({"code": 500, "msg": f"安卓包准备失败: {str(e)}"}), 500


@user_bp.route("/api/recharge", methods=["POST"])
@rate_limit("recharge_ip", limit=15, window_seconds=300, msg="卡密核销请求过于频繁，请 5 分钟后再试")
def recharge():
    ip = get_client_ip()
    data = request.json or {}
    u = data.get("username")
    raw_card_input = data.get("card_code", "").strip()

    if not raw_card_input:
        return jsonify({"code": 400, "msg": "请输入卡密兑换码"})

    # 检查是否存在连续无效卡密暴力穷举锁定
    fail_cd_ok, wait_sec = check_cooldown("card_brute_lock", f"{ip}:{u}")
    if not fail_cd_ok:
        return rate_limit_response(f"检测到连续输入无效卡密，已触发防穷举保护，请 {wait_sec} 秒后再试", retry_after=wait_sec)

    raw_tokens = re.split(r"[\r\n,;\s]+", raw_card_input)
    codes = list(dict.fromkeys([c.strip().upper() for c in raw_tokens if c.strip()]))

    if not codes:
        return jsonify({"code": 400, "msg": "未识别到有效的卡密格式"})
    if len(codes) > 20:
        return jsonify({"code": 400, "msg": "单次最多支持批量核销 20 张卡密"})

    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with db_session() as s:
        user_obj = s.scalar(select(User).where(User.username == u))
        if not user_obj:
            return jsonify({"code": 404, "msg": "用户不存在"})

        found_cards = s.scalars(select(Card).where(Card.code.in_(codes))).all()
        found_map = {fc.code: fc for fc in found_cards}
        candidate_cards, used_cards, invalid_codes = [], [], []

        for code in codes:
            if code not in found_map:
                invalid_codes.append(code)
            elif found_map[code].is_used == 1:
                used_cards.append(code)
            else:
                candidate_cards.append(found_map[code])

        # 条件原子核销 (CAS: UPDATE cards SET is_used=1 WHERE code=? AND is_used=0)，彻底杜绝并发双花漏洞
        valid_cards = []
        for vc in candidate_cards:
            upd_res = s.execute(
                update(Card)
                .where(Card.code == vc.code, Card.is_used == 0)
                .values(is_used=1, used_by=u, used_at=now_str)
            )
            if (upd_res.rowcount or 0) == 1:
                valid_cards.append(vc)
            else:
                used_cards.append(vc.code)

        if not valid_cards:
            allowed_fail, _, _ = consume_rate_limit("card_fail", f"{ip}:{u}", limit=8, window_seconds=900)
            if not allowed_fail:
                set_cooldown("card_brute_lock", f"{ip}:{u}", 900)
                return rate_limit_response("连续输入无效或已使用的卡密过多，已临时锁定 15 分钟", retry_after=900)
            err_msg = "所提交的卡密全部无效"
            if used_cards:
                err_msg = f"卡密已被使用 (共 {len(used_cards)} 张)"
            return jsonify({"code": 400, "msg": err_msg})

        total_add_gb, total_add_days = 0, 0
        has_unlimited_traffic = False
        has_lifetime_expiry = False
        has_monthly_card = False

        for card in valid_cards:
            if card.traffic_gb == 0:
                has_unlimited_traffic = True
            else:
                total_add_gb += card.traffic_gb

            if card.days >= 3650:
                has_lifetime_expiry = True
            else:
                total_add_days += card.days

            if str(card.is_monthly).lower() in ["1", "true"]:
                has_monthly_card = True

        current_limit = user_obj.traffic_limit_mb
        new_limit = 0 if (has_unlimited_traffic or current_limit == 0) else (current_limit + total_add_gb * 1024)

        c_exp_str = user_obj.expire_date
        if has_lifetime_expiry or c_exp_str.startswith("2099"):
            n_exp = "2099-12-31 23:59:59"
        else:
            try:
                c_exp = datetime.datetime.strptime(c_exp_str, "%Y-%m-%d %H:%M:%S")
            except Exception:
                c_exp = datetime.datetime.now()
            base_time = max(datetime.datetime.now(), c_exp)
            calculated_date = (base_time + datetime.timedelta(days=total_add_days)).strftime("%Y-%m-%d")
            n_exp = normalize_expire_date(calculated_date)

        new_is_monthly = user_obj.is_monthly or 0
        new_reset_day = user_obj.reset_day or 1
        if has_monthly_card:
            new_is_monthly = 1
            new_reset_day = datetime.date.today().day

        user_obj.traffic_limit_mb = new_limit
        user_obj.expire_date = n_exp
        user_obj.is_monthly = new_is_monthly
        user_obj.reset_day = new_reset_day
        user_dict = user_obj.to_dict()

    reset_rate_counter("card_fail", f"{ip}:{u}")
    res_msg = f"成功核销 {len(valid_cards)} 张卡密！"
    res_msg += " 流量已设为不限制；" if (has_unlimited_traffic or new_limit == 0) else f" 累计增加 {total_add_gb}GB 流量；"
    res_msg += " 有效期已设为永久有效。" if (has_lifetime_expiry or n_exp.startswith("2099")) else f" 有效期顺延至 {n_exp}。"

    if used_cards or invalid_codes:
        res_msg += f" (跳过了 {len(used_cards) + len(invalid_codes)} 张已被使用或无效的卡密)"

    title = "【充值成功】您的套餐配额已更新"
    threading.Thread(
        target=notify_user,
        args=(user_dict, title, f"<p>{res_msg}</p>", res_msg),
        daemon=True,
    ).start()

    return jsonify({
        "code": 200,
        "msg": res_msg,
        "valid_count": len(valid_cards),
        "skipped_count": len(used_cards) + len(invalid_codes),
    })