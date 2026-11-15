import datetime
import random
import uuid

from flask import Blueprint, jsonify, request
from sqlalchemy import or_, select

from config import Config
from core.cache import cache
from core.captcha import generate_math_captcha, verify_captcha
from core.db import db_session, get_setting, hash_pwd, invalidate_users_cache
from core.models import Node, User
from routes import (
    build_node_link,
    get_node_snis,
    is_user_allowed_for_node,
    normalize_expire_date,
    resolve_public_endpoint,
)
from services.notify_service import send_smtp_email

auth_bp = Blueprint("auth_bp", __name__)


def get_client_ip():
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "127.0.0.1"


@auth_bp.route("/api/auth/captcha", methods=["GET"])
def get_captcha():
    ip = get_client_ip()
    data = generate_math_captcha(ip)
    return jsonify({"code": 200, "data": data})


@auth_bp.route("/api/login", methods=["POST"])
def login():
    data = request.json or {}
    account = data.get("username", "").strip()
    p = data.get("password", "").strip()
    captcha_id = data.get("captcha_id", "").strip()
    captcha_ans = data.get("captcha_ans", "").strip()
    honeypot = data.get("bot_honey_token", "")

    ip = get_client_ip()
    ok, c_msg = verify_captcha(captcha_id, captcha_ans, client_ip=ip, honeypot_val=honeypot)
    if not ok:
        return jsonify({"code": 400, "msg": c_msg})

    with db_session() as s:
        user_obj = s.scalar(
            select(User).where(
                or_(User.username == account, User.email == account),
                User.password_hash == hash_pwd(p),
            )
        )
        if not user_obj:
            return jsonify({"code": 401, "msg": "账号或密码错误"})
        if user_obj.status == 0:
            return jsonify({"code": 403, "msg": "该账号已被管理员封禁停用"})
        if user_obj.is_verified == 0:
            return jsonify({"code": 403, "msg": "账号尚未通过邮箱激活验证"})
        if Config.APP_MODE == "user" and user_obj.role == "admin":
            return jsonify({"code": 403, "msg": "当前节点为纯用户端模式，已屏蔽管理员登录"})

        user_dict = user_obj.to_dict()
        all_nodes = [n.to_dict() for n in s.scalars(select(Node).order_by(Node.id.asc())).all()]

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
            "referral_code": user_dict.get("referral_code") or user_dict["uuid"][:8].upper(),
            "invited_by": user_dict.get("invited_by") or "",
            "referral_count": user_dict.get("referral_count") or 0,
            "referral_bonus_gb": user_dict.get("referral_bonus_gb") or 0,
            "referral_bonus_days": user_dict.get("referral_bonus_days") or 0,
        },
    })


@auth_bp.route("/api/auth/send_register_code", methods=["POST"])
def send_register_code():
    data = request.json or {}
    email = data.get("email", "").strip().lower()
    captcha_id = data.get("captcha_id", "").strip()
    captcha_ans = data.get("captcha_ans", "").strip()
    honeypot = data.get("bot_honey_token", "")

    ip = get_client_ip()
    ok, c_msg = verify_captcha(captcha_id, captcha_ans, client_ip=ip, honeypot_val=honeypot)
    if not ok:
        return jsonify({"code": 400, "msg": c_msg})
    if not email or "@" not in email:
        return jsonify({"code": 400, "msg": "请输入合法的电子邮箱"})

    with db_session() as s:
        if s.scalar(select(User.id).where(User.email == email).limit(1)):
            return jsonify({"code": 400, "msg": "该邮箱已被注册"})

    code = f"{random.randint(100000, 999999)}"
    cache.set_json(f"vcode:register:{email}", {"code": code}, ttl=600)

    content = f"""
    <div style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 25px; border-radius: 8px;">
        <h2 style="color: #38bdf8;">⚡ Xray Reality 账号激活验证</h2>
        <p>您好！您的激活验证码为：<b style="font-size: 24px; color: #10b981; letter-spacing: 2px;">{code}</b></p>
        <p style="color: #94a3b8; font-size: 12px;">验证码 10 分钟内有效。</p>
    </div>
    """
    ok, msg = send_smtp_email(email, "【Xray】注册账号激活验证码", content)
    if not ok:
        return jsonify({"code": 500, "msg": msg})
    return jsonify({"code": 200, "msg": "激活验证码已发送至您的邮箱，请查收"})


@auth_bp.route("/api/register", methods=["POST"])
def register():
    if Config.APP_MODE == "admin":
        return jsonify({"code": 403, "msg": "当前节点为纯管理模式，不开放公网注册"})

    data = request.json or {}
    u = data.get("username", "").strip()
    p = data.get("password", "").strip()
    email = data.get("email", "").strip().lower()
    code = data.get("code", "").strip()
    ref_code = data.get("ref_code", "").strip().upper()

    if not u or not p or not email or not code:
        return jsonify({"code": 400, "msg": "所有项均为必填项"})

    vcode_data = cache.get_json(f"vcode:register:{email}")
    if not isinstance(vcode_data, dict) or vcode_data.get("code") != code:
        return jsonify({"code": 400, "msg": "验证码错误或已失效"})

    reg_traffic_mb = int(get_setting("reg_traffic_mb", "1024") or 1024)
    reg_expire_days = int(get_setting("reg_expire_days", "1") or 1)

    referral_enabled = get_setting("referral_enabled", "true") == "true"
    inviter_gb = int(get_setting("referral_inviter_traffic_gb", "10") or 10)
    inviter_days = int(get_setting("referral_inviter_days", "30") or 30)
    invitee_gb = int(get_setting("referral_invitee_traffic_gb", "5") or 5)
    invitee_days = int(get_setting("referral_invitee_days", "30") or 30)
    max_per_user = int(get_setting("referral_max_per_user", "50") or 50)

    bonus_invitee_mb = 0
    bonus_invitee_days = 0
    invited_by_user = ""

    try:
        with db_session() as s:
            if s.scalar(select(User.id).where(or_(User.username == u, User.email == email)).limit(1)):
                return jsonify({"code": 400, "msg": "用户名或邮箱已被占用"})

            if ref_code and referral_enabled:
                from sqlalchemy import func
                inviter = s.scalar(
                    select(User).where(
                        or_(User.referral_code == ref_code, func.upper(User.username) == ref_code)
                    )
                )
                if inviter and inviter.username != u:
                    cur_ref_count = inviter.referral_count or 0
                    if cur_ref_count < max_per_user:
                        invited_by_user = inviter.username
                        bonus_invitee_mb = invitee_gb * 1024
                        bonus_invitee_days = invitee_days

                        inviter.traffic_limit_mb = (inviter.traffic_limit_mb or 0) + (inviter_gb * 1024)
                        try:
                            cur_exp_dt = datetime.datetime.strptime(inviter.expire_date, "%Y-%m-%d %H:%M:%S")
                        except Exception:
                            cur_exp_dt = datetime.datetime.now()
                        if cur_exp_dt < datetime.datetime.now():
                            cur_exp_dt = datetime.datetime.now()
                        inviter.expire_date = (cur_exp_dt + datetime.timedelta(days=inviter_days)).strftime("%Y-%m-%d %H:%M:%S")
                        inviter.referral_count = (inviter.referral_count or 0) + 1
                        inviter.referral_bonus_gb = (inviter.referral_bonus_gb or 0) + inviter_gb
                        inviter.referral_bonus_days = (inviter.referral_bonus_days or 0) + inviter_days

            total_traffic_mb = reg_traffic_mb + bonus_invitee_mb
            total_expire_days = reg_expire_days + bonus_invitee_days

            if total_expire_days >= 3650:
                exp = "2099-12-31 23:59:59"
            else:
                exp_date = (datetime.datetime.now() + datetime.timedelta(days=total_expire_days)).strftime("%Y-%m-%d")
                exp = normalize_expire_date(exp_date)

            my_ref_code = uuid.uuid4().hex[:8].upper()
            s.add(
                User(
                    username=u,
                    password_hash=hash_pwd(p),
                    uuid=str(uuid.uuid4()),
                    email=email,
                    traffic_limit_mb=total_traffic_mb,
                    used_mb=0.0,
                    expire_date=exp,
                    role="user",
                    status=1,
                    is_verified=1,
                    is_monthly=0,
                    reset_day=1,
                    user_group="default",
                    referral_code=my_ref_code,
                    invited_by=invited_by_user,
                    referral_count=0,
                    referral_bonus_gb=0.0,
                    referral_bonus_days=0,
                )
            )
        cache.delete(f"vcode:register:{email}")
        invalidate_users_cache()

        bonus_msg = f"（含推荐礼包 +{invitee_gb}GB 流量与 +{invitee_days} 天有效期）" if invited_by_user else ""
        return jsonify({"code": 200, "msg": f"账号激活成功！获赠 {round(total_traffic_mb/1024, 2)}GB 套餐{bonus_msg}"})
    except Exception as e:
        return jsonify({"code": 500, "msg": f"注册失败: {str(e)}"})


@auth_bp.route("/api/auth/send_reset_code", methods=["POST"])
def send_reset_code():
    data = request.json or {}
    email = data.get("email", "").strip().lower()
    captcha_id = data.get("captcha_id", "").strip()
    captcha_ans = data.get("captcha_ans", "").strip()
    honeypot = data.get("bot_honey_token", "")

    ip = get_client_ip()
    ok, c_msg = verify_captcha(captcha_id, captcha_ans, client_ip=ip, honeypot_val=honeypot)
    if not ok:
        return jsonify({"code": 400, "msg": c_msg})

    with db_session() as s:
        user_obj = s.scalar(select(User).where(User.email == email))
        if not user_obj:
            return jsonify({"code": 404, "msg": "该邮箱尚未绑定任何账号"})
        uname = user_obj.username

    code = f"{random.randint(100000, 999999)}"
    cache.set_json(f"vcode:reset:{email}", {"code": code}, ttl=600)

    content = f"""
    <div style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 25px; border-radius: 8px;">
        <h2 style="color: #38bdf8;">🔐 Xray Reality 密码重置验证</h2>
        <p>您好 <b>{uname}</b>！您的重置验证码为：<b style="font-size: 24px; color: #f59e0b; letter-spacing: 2px;">{code}</b></p>
    </div>
    """
    ok, msg = send_smtp_email(email, "【Xray】找回登录密码验证码", content)
    if not ok:
        return jsonify({"code": 500, "msg": msg})
    return jsonify({"code": 200, "msg": "验证码已发送至您的邮箱"})


@auth_bp.route("/api/auth/reset_password", methods=["POST"])
def reset_password():
    data = request.json or {}
    email = data.get("email", "").strip().lower()
    code = data.get("code", "").strip()
    new_pwd = data.get("new_password", "").strip()

    vcode_data = cache.get_json(f"vcode:reset:{email}")
    if not isinstance(vcode_data, dict) or vcode_data.get("code") != code:
        return jsonify({"code": 400, "msg": "验证码错误或已失效"})

    with db_session() as s:
        user_obj = s.scalar(select(User).where(User.email == email))
        if user_obj:
            user_obj.password_hash = hash_pwd(new_pwd)
    cache.delete(f"vcode:reset:{email}")
    return jsonify({"code": 200, "msg": "密码已成功重置，请登录"})