import random
import uuid
import time
from db import get_db

def generate_math_captcha() -> dict:
    """生成暗黑科技风格算术验证码，返回验证码ID和SVG字符串"""
    # 随机生成加、减、乘简单算术（人类秒出答案，机器识别极难）
    op = random.choice(['+', '-', '×'])
    if op == '+':
        a = random.randint(1, 30)
        b = random.randint(1, 30)
        ans = a + b
        text = f"{a} + {b} = ?"
    elif op == '-':
        a = random.randint(10, 50)
        b = random.randint(1, a)
        ans = a - b
        text = f"{a} - {b} = ?"
    else:
        a = random.randint(2, 9)
        b = random.randint(2, 9)
        ans = a * b
        text = f"{a} × {b} = ?"

    captcha_id = str(uuid.uuid4())
    expire_at = time.time() + 300  # 5分钟有效期

    conn = get_db()
    c = conn.cursor()
    c.execute("INSERT OR REPLACE INTO captchas (id, answer, expire_at) VALUES (?, ?, ?)",
              (captcha_id, str(ans), expire_at))
    # 顺便清理已超时的历史记录
    c.execute("DELETE FROM captchas WHERE expire_at < ?", (time.time(),))
    conn.commit()
    conn.close()

    # 动态渲染矢量干扰线和噪点
    w, h = 120, 38
    lines = ""
    for _ in range(3):
        x1, y1 = random.randint(0, w), random.randint(0, h)
        x2, y2 = random.randint(0, w), random.randint(0, h)
        color = random.choice(["#38bdf8", "#818cf8", "#34d399", "#f59e0b"])
        lines += f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="1" stroke-opacity="0.35" />'

    dots = ""
    for _ in range(20):
        cx, cy = random.randint(0, w), random.randint(0, h)
        color = random.choice(["#38bdf8", "#94a3b8", "#334155"])
        dots += f'<circle cx="{cx}" cy="{cy}" r="1" fill="{color}" fill-opacity="0.5" />'

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
        f'<rect width="100%" height="100%" fill="#0b1120" rx="6" stroke="#334155" stroke-width="1"/>'
        f'{lines}{dots}'
        f'<text x="50%" y="58%" dominant-baseline="middle" text-anchor="middle" '
        f'fill="#38bdf8" font-family="monospace, sans-serif" font-size="16" font-weight="700" letter-spacing="2">'
        f'{text}'
        f'</text>'
        f'</svg>'
    )

    return {
        "captcha_id": captcha_id,
        "svg": svg
    }

def verify_captcha(captcha_id: str, user_answer: str) -> tuple[bool, str]:
    """校验验证码（单次消费即作废，防止暴力重放攻击）"""
    if not captcha_id or not user_answer:
        return False, "请输入图形验证码计算结果"

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT answer, expire_at FROM captchas WHERE id=?", (captcha_id.strip(),))
    row = c.fetchone()

    if not row:
        conn.close()
        return False, "验证码已失效，请点击验证码图片刷新"

    # 单次验证即刻销毁
    c.execute("DELETE FROM captchas WHERE id=?", (captcha_id.strip(),))
    conn.commit()
    conn.close()

    if time.time() > row["expire_at"]:
        return False, "验证码已超时过期，请点击刷新"

    if str(row["answer"]).strip() != str(user_answer).strip():
        return False, "验证码计算错误，请重新输入"

    return True, "验证通过"