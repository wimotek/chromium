import datetime
import uuid

from flask import Blueprint, jsonify, request
from sqlalchemy import delete, func, select

from config import Config
from core.db import db_session, get_setting
from core.models import Card
from routes import check_admin

card_bp = Blueprint("card_bp", __name__)


@card_bp.route("/api/admin/cards/generate", methods=["POST"])
def admin_generate():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    created = []
    t_gb = int(data.get("traffic_gb", 50))
    days = int(data.get("days", 30))
    is_monthly = 1 if str(data.get("is_monthly")).lower() in ["1", "true"] else 0

    with db_session() as s:
        for _ in range(int(data.get("count", 5))):
            code = "KM-" + str(uuid.uuid4()).replace("-", "")[:12].upper()
            s.add(
                Card(
                    code=code,
                    traffic_gb=t_gb,
                    days=days,
                    is_used=0,
                    used_by=None,
                    created_at=now,
                    used_at="",
                    is_monthly=is_monthly,
                )
            )
            created.append(code)
    return jsonify({"code": 200, "msg": "制卡成功", "cards": created})


@card_bp.route("/api/admin/cards/export_unused", methods=["POST"])
def export_unused_cards():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    selected_codes = data.get("selected_codes", [])
    start_date = data.get("start_date", "").strip()
    end_date = data.get("end_date", "").strip()

    with db_session() as s:
        if selected_codes:
            stmt = select(Card.code).where(Card.code.in_(selected_codes)).order_by(Card.created_at.desc())
        else:
            stmt = select(Card.code).where(Card.is_used == 0)
            if start_date:
                stmt = stmt.where(func.substr(Card.created_at, 1, 10) >= start_date)
            if end_date:
                stmt = stmt.where(func.substr(Card.created_at, 1, 10) <= end_date)
            stmt = stmt.order_by(Card.created_at.desc())
        cards = list(s.scalars(stmt).all())

    return jsonify({"code": 200, "count": len(cards), "text": "\n".join(cards)})


@card_bp.route("/api/admin/cards/delete", methods=["POST"])
def admin_delete_cards():
    data = request.json or {}
    if not check_admin(data.get("admin_user"), data.get("admin_pwd")):
        return jsonify({"code": 403, "msg": "无权限"})

    mode = data.get("mode", "").strip()
    deleted_count = 0

    with db_session() as s:
        if mode == "selected":
            selected_codes = data.get("selected_codes", [])
            if not selected_codes:
                return jsonify({"code": 400, "msg": "请先勾选需要删除的卡密"})
            res = s.execute(delete(Card).where(Card.code.in_(selected_codes)))
            deleted_count = int(res.rowcount or 0)
        elif mode == "date":
            start_date = data.get("start_date", "").strip()
            end_date = data.get("end_date", "").strip()
            if not start_date and not end_date:
                return jsonify({"code": 400, "msg": "请选择需要删除的日期范围"})
            stmt = delete(Card).where(Card.is_used == 0)
            if start_date:
                stmt = stmt.where(func.substr(Card.created_at, 1, 10) >= start_date)
            if end_date:
                stmt = stmt.where(func.substr(Card.created_at, 1, 10) <= end_date)
            res = s.execute(stmt)
            deleted_count = int(res.rowcount or 0)
        elif mode == "invalid":
            res = s.execute(delete(Card).where(Card.is_used == 1))
            deleted_count = int(res.rowcount or 0)
        else:
            return jsonify({"code": 400, "msg": "不支持的删除模式"})

    return jsonify({"code": 200, "msg": f"卡密清理完成！共成功删除 {deleted_count} 张卡密。"})


@card_bp.route("/api/open/faka_generate", methods=["GET", "POST"])
def open_faka_generate():
    is_enabled = get_setting("faka_api_enable", "true").lower() == "true"
    if not is_enabled:
        return jsonify({"code": 403, "msg": "第三方发卡 API 接口已被管理员禁用"}), 403

    req_token = request.headers.get("Authorization") or request.args.get("token")
    if not req_token and request.is_json:
        req_token = (request.json or {}).get("token")

    if req_token and req_token.startswith("Bearer "):
        req_token = req_token[7:].strip()

    valid_token = get_setting("faka_api_token", Config.FAKA_API_TOKEN).strip()
    if not req_token or req_token.strip() != valid_token:
        return jsonify({"code": 403, "msg": "Invalid API Token"}), 403

    gb_param = request.args.get("gb") or ((request.json or {}).get("gb") if request.is_json else None)
    days_param = request.args.get("days") or ((request.json or {}).get("days") if request.is_json else None)
    is_monthly_param = request.args.get("is_monthly") or ((request.json or {}).get("is_monthly") if request.is_json else 0)

    try:
        traffic_gb = int(gb_param or 100)
        days = int(days_param or 30)
        is_monthly = 1 if str(is_monthly_param).lower() in ["1", "true"] else 0
    except ValueError:
        traffic_gb, days, is_monthly = 100, 30, 0

    code = "KM-" + str(uuid.uuid4()).replace("-", "")[:12].upper()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with db_session() as s:
        s.add(
            Card(
                code=code,
                traffic_gb=traffic_gb,
                days=days,
                is_used=0,
                used_by=None,
                created_at=now,
                used_at="",
                is_monthly=is_monthly,
            )
        )

    if request.args.get("format") == "json":
        return jsonify({
            "code": 200,
            "card": code,
            "traffic_gb": traffic_gb,
            "days": days,
            "is_monthly": is_monthly,
        })

    return code, 200, {"Content-Type": "text/plain; charset=utf-8"}