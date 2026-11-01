import uuid
import datetime
from flask import Blueprint, request, jsonify
from config import Config
from db import get_db, get_setting
from routes import check_admin

card_bp = Blueprint('card_bp', __name__)

@card_bp.route('/api/admin/cards/generate', methods=['POST'])
def admin_generate():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    conn = get_db()
    c = conn.cursor()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    created = []
    t_gb = int(data.get('traffic_gb', 50))
    days = int(data.get('days', 30))
    is_monthly = 1 if str(data.get('is_monthly')).lower() in ['1', 'true'] else 0

    for _ in range(int(data.get('count', 5))):
        code = "KM-" + str(uuid.uuid4()).replace("-", "")[:12].upper()
        c.execute("""
            INSERT INTO cards (code, traffic_gb, days, is_used, used_by, created_at, used_at, is_monthly)
            VALUES (?, ?, ?, 0, NULL, ?, '', ?)
        """, (code, t_gb, days, now, is_monthly))
        created.append(code)
    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": "制卡成功", "cards": created})

@card_bp.route('/api/admin/cards/export_unused', methods=['POST'])
def export_unused_cards():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    selected_codes = data.get("selected_codes", [])
    start_date = data.get("start_date", "").strip()
    end_date = data.get("end_date", "").strip()

    conn = get_db()
    c = conn.cursor()
    if selected_codes:
        placeholders = ','.join(['?'] * len(selected_codes))
        c.execute(f"SELECT code FROM cards WHERE code IN ({placeholders}) ORDER BY rowid DESC", selected_codes)
    elif start_date or end_date:
        query_parts, params = ["is_used=0"], []
        if start_date: query_parts.append("substr(created_at, 1, 10) >= ?"); params.append(start_date)
        if end_date: query_parts.append("substr(created_at, 1, 10) <= ?"); params.append(end_date)
        c.execute(f"SELECT code FROM cards WHERE {' AND '.join(query_parts)} ORDER BY rowid DESC", params)
    else:
        c.execute("SELECT code FROM cards WHERE is_used=0 ORDER BY rowid DESC")

    cards = [r["code"] for r in c.fetchall()]
    conn.close()
    return jsonify({"code": 200, "count": len(cards), "text": "\n".join(cards)})

@card_bp.route('/api/admin/cards/delete', methods=['POST'])
def admin_delete_cards():
    data = request.json or {}
    if not check_admin(data.get('admin_user'), data.get('admin_pwd')): return jsonify({"code": 403, "msg": "无权限"})

    mode = data.get('mode', '').strip()
    conn = get_db()
    c = conn.cursor()
    deleted_count = 0

    if mode == 'selected':
        selected_codes = data.get('selected_codes', [])
        if not selected_codes:
            conn.close()
            return jsonify({"code": 400, "msg": "请先勾选需要删除的卡密"})
        placeholders = ','.join(['?'] * len(selected_codes))
        c.execute(f"DELETE FROM cards WHERE code IN ({placeholders})", selected_codes)
        deleted_count = c.rowcount

    elif mode == 'date':
        start_date = data.get('start_date', '').strip()
        end_date = data.get('end_date', '').strip()
        if not start_date and not end_date:
            conn.close()
            return jsonify({"code": 400, "msg": "请选择需要删除的日期范围"})
        query_parts, params = [], []
        if start_date:
            query_parts.append("substr(created_at, 1, 10) >= ?")
            params.append(start_date)
        if end_date:
            query_parts.append("substr(created_at, 1, 10) <= ?")
            params.append(end_date)
        query_parts.append("is_used=0")
        c.execute(f"DELETE FROM cards WHERE {' AND '.join(query_parts)}", params)
        deleted_count = c.rowcount

    elif mode == 'invalid':
        c.execute("DELETE FROM cards WHERE is_used=1")
        deleted_count = c.rowcount

    else:
        conn.close()
        return jsonify({"code": 400, "msg": "不支持的删除模式"})

    conn.commit()
    conn.close()
    return jsonify({"code": 200, "msg": f"卡密清理完成！共成功删除 {deleted_count} 张卡密。"})

@card_bp.route('/api/open/faka_generate', methods=['GET', 'POST'])
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

    gb_param = request.args.get("gb") or (request.json or {}).get("gb") if request.is_json else None
    days_param = request.args.get("days") or (request.json or {}).get("days") if request.is_json else None
    is_monthly_param = request.args.get("is_monthly") or (request.json or {}).get("is_monthly") if request.is_json else 0

    try:
        traffic_gb = int(gb_param or 100)
        days = int(days_param or 30)
        is_monthly = 1 if str(is_monthly_param).lower() in ["1", "true"] else 0
    except ValueError:
        traffic_gb, days, is_monthly = 100, 30, 0

    code = "KM-" + str(uuid.uuid4()).replace("-", "")[:12].upper()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    conn = get_db()
    c = conn.cursor()
    c.execute("""
        INSERT INTO cards (code, traffic_gb, days, is_used, used_by, created_at, used_at, is_monthly)
        VALUES (?, ?, ?, 0, NULL, ?, '', ?)
    """, (code, traffic_gb, days, now, is_monthly))
    conn.commit()
    conn.close()

    if request.args.get("format") == "json":
        return jsonify({
            "code": 200,
            "card": code,
            "traffic_gb": traffic_gb,
            "days": days,
            "is_monthly": is_monthly
        })

    return code, 200, {"Content-Type": "text/plain; charset=utf-8"}