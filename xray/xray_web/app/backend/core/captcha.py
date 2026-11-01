import uuid
import random
import time
from core.db import get_db

def generate_math_captcha() -> dict:
    op = random.choice(['+', '-', '*'])
    if op == '+':
        a = random.randint(1, 20)
        b = random.randint(1, 20)
        ans = a + b
    elif op == '-':
        a = random.randint(10, 30)
        b = random.randint(1, a)
        ans = a - b
    else:
        a = random.randint(1, 9)
        b = random.randint(1, 9)
        ans = a * b

    expr = f"{a} {op} {b} = ?"
    cid = str(uuid.uuid4()).replace('-', '')[:16]
    expire_at = time.time() + 300

    conn = get_db()
    c = conn.cursor()
    c.execute("DELETE FROM captchas WHERE expire_at < ?", (time.time(),))
    c.execute("INSERT INTO captchas (id, answer, expire_at) VALUES (?, ?, ?)", (cid, str(ans), expire_at))
    conn.commit()
    conn.close()

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="130" height="38" viewBox="0 0 130 38">
      <rect width="100%" height="100%" fill="#0b1120" rx="4"/>
      <path d="M 10,19 Q 45,5 80,25 T 120,15" fill="none" stroke="#334155" stroke-width="1.5"/>
      <path d="M 5,28 Q 50,35 90,10 T 125,20" fill="none" stroke="#1e293b" stroke-width="1"/>
      <text x="50%" y="58%" dominant-baseline="middle" text-anchor="middle"
            fill="#38bdf8" font-family="monospace" font-size="19" font-weight="bold" letter-spacing="3">
        {expr}
      </text>
    </svg>'''

    return {"captcha_id": cid, "svg": svg}

def verify_captcha(cid: str, ans: str) -> tuple[bool, str]:
    if not cid or not ans:
        return False, "请输入验证码计算结果"

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT answer, expire_at FROM captchas WHERE id=?", (cid,))
    row = c.fetchone()

    if not row:
        conn.close()
        return False, "验证码已失效，请点击图片刷新"

    correct_ans = row["answer"]
    expire_at = row["expire_at"]

    c.execute("DELETE FROM captchas WHERE id=?", (cid,))
    conn.commit()
    conn.close()

    if time.time() > expire_at:
        return False, "验证码已超时过期，请点击图片刷新"

    if ans.strip() != correct_ans.strip():
        return False, "算术验证码计算错误，请重新输入"

    return True, "验证通过"