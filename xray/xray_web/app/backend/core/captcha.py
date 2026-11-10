# -*- coding: utf-8 -*-
"""
High-Security Anti-Bot Adaptive Verification Engine
高级抗爬虫/防机器人自适应人机验证核心：
1. 多元动态题型：汉字数词混合运算、大小极值比较、生活常识问答、高干扰扭曲字母
2. 彻底防 DOM 文本提取：拆分独立字符多维扰动变换 (Rotate/Skew/Jitter/Color)，注入不可见诱饵字符
3. 高抗 OCR 视觉干扰：多层三次贝塞尔混淆曲线、密集噪斑网络与波浪底纹
4. 蜜罐陷阱 (Honeypot) + 人类反应时间窗口 (Timing Attack Guard)
5. IP 级暴力撞库与高频尝试熔断锁定 (Anti-Brute Force Lockout)
"""

import uuid
import random
import time
import math
from typing import Tuple, Dict, Any, Optional
from core.db import get_db

# 汉字数字映射表
CN_NUMS = {
    0: '零', 1: '一', 2: '二', 3: '三', 4: '四',
    5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '十',
    11: '十一', 12: '十二', 13: '十三', 14: '十四', 15: '十五',
    16: '十六', 17: '十七', 18: '十八', 19: '十九', 20: '二十'
}

# 调色板：高对比度、防简单二值化分割的赛博暗黑主题色
COLOR_PALETTE = [
    '#38bdf8', '#818cf8', '#34d399', '#f472b6',
    '#fbbf24', '#f87171', '#a78bfa', '#2dd4bf', '#60a5fa'
]

NOISE_COLORS = [
    'rgba(56, 189, 248, 0.35)', 'rgba(129, 140, 248, 0.35)',
    'rgba(52, 211, 153, 0.3)', 'rgba(244, 114, 182, 0.3)',
    'rgba(251, 191, 36, 0.3)', 'rgba(148, 163, 184, 0.25)'
]

def _generate_challenge_content() -> Tuple[str, str, str]:
    """
    生成随机多元题型，打破单一数学公式的刻板模式
    返回: (题目字符串, 正确答案字符串, 提示说明)
    """
    mode = random.choices(['math_mixed', 'compare', 'trivia', 'alphanumeric'], weights=[40, 25, 15, 20])[0]

    if mode == 'math_mixed':
        # 汉字数字与阿拉伯数字混合加减乘法
        op = random.choice(['+', '-', '*'])
        if op == '+':
            a = random.randint(1, 15)
            b = random.randint(1, 15)
            ans = str(a + b)
            # 随机将 a 或 b 或操作符转换为汉字
            choice = random.choice([1, 2, 3])
            if choice == 1:
                expr = f"{CN_NUMS.get(a, str(a))}加{b}=?"
            elif choice == 2:
                expr = f"{a}+{CN_NUMS.get(b, str(b))}=?"
            else:
                expr = f"{CN_NUMS.get(a, str(a))}+{b}=?"
        elif op == '-':
            a = random.randint(10, 25)
            b = random.randint(1, a - 1)
            ans = str(a - b)
            choice = random.choice([1, 2, 3])
            if choice == 1:
                expr = f"{a}减{CN_NUMS.get(b, str(b))}=?"
            elif choice == 2:
                expr = f"{CN_NUMS.get(a, str(a))}-{b}=?"
            else:
                expr = f"{a}-{CN_NUMS.get(b, str(b))}=?"
        else:
            a = random.randint(2, 9)
            b = random.randint(2, 9)
            ans = str(a * b)
            expr = f"{CN_NUMS.get(a, str(a))}乘{b}=?"
        return expr, ans, "计算结果"

    elif mode == 'compare':
        # 极值或比大小题目
        a = random.randint(3, 20)
        b = random.randint(3, 20)
        while a == b:
            b = random.randint(3, 20)
        
        kind = random.choice(['max', 'min', 'diff'])
        if kind == 'max':
            expr = f"{a}与{b}谁大?"
            ans = str(max(a, b))
        elif kind == 'min':
            expr = f"{a}与{b}谁小?"
            ans = str(min(a, b))
        else:
            big, small = max(a, b), min(a, b)
            expr = f"{big}比{small}大几?"
            ans = str(big - small)
        return expr, ans, "数字答案"

    elif mode == 'trivia':
        # 常见数学常识与生活问答 (数字作答)
        trivias = [
            ("一周有几天?", "7"),
            ("一年有几季?", "4"),
            ("直角是多少度?", "90"),
            ("平角是多少度?", "180"),
            ("一小时几分钟?", "60"),
            ("一分钟几秒钟?", "60"),
            ("1公里几千米?", "1"),
            ("一打等于几个?", "12"),
            ("四加六等于?", "10"),
            ("三角形几个角?", "3"),
            ("五乘五等于?", "25"),
        ]
        q, a = random.choice(trivias)
        return q, a, "常识数字"

    else:
        # 高抗 OCR 字母数字混合挑战码 (4位排除易混字符)
        charset = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
        code = "".join(random.choice(charset) for _ in range(4))
        # 格式如 "验: 7KM8"
        expr = f"验:{code}"
        return expr, code.upper(), "4位验证码"


def _generate_hardened_svg(expr: str) -> str:
    """
    渲染深度防机器人解析的 SVG：
    1. 单字独立坐标定位 + 独立随机角度旋转 + 独立倾斜错位 (Jitter)
    2. 随机注入 2-3 个不可见/零尺寸假诱饵字符，彻底摧毁正则表达式与 DOM 解析爬虫
    3. 5-7 条随机三次贝塞尔曲线，穿切字符表面，破除 OCR 连通域
    4. 40-50 个动态彩色噪斑与随机干扰微粒
    """
    width = 145
    height = 42

    # 1. 生成背景多重随机噪斑
    noise_elements = []
    for _ in range(35):
        cx = random.randint(3, width - 3)
        cy = random.randint(3, height - 3)
        r = random.uniform(0.8, 2.2)
        color = random.choice(NOISE_COLORS)
        noise_elements.append(f'<circle cx="{cx}" cy="{cy}" r="{r:.1f}" fill="{color}" />')

    # 2. 生成多条贝塞尔混淆曲线 (穿透并切割字符，阻止 OCR 连通分割)
    for _ in range(5):
        x1 = random.randint(0, 20)
        y1 = random.randint(5, height - 5)
        cx1 = random.randint(25, 60)
        cy1 = random.randint(2, height - 2)
        cx2 = random.randint(70, 110)
        cy2 = random.randint(2, height - 2)
        x2 = random.randint(width - 25, width)
        y2 = random.randint(5, height - 5)
        stroke = random.choice(NOISE_COLORS)
        sw = random.uniform(1.2, 2.0)
        dash = 'stroke-dasharray="3,2"' if random.random() > 0.5 else ''
        noise_elements.append(
            f'<path d="M {x1},{y1} C {cx1},{cy1} {cx2},{cy2} {x2},{y2}" fill="none" stroke="{stroke}" stroke-width="{sw:.1f}" {dash} />'
        )

    # 3. 逐字渲染真实字符，并在随机位置插入不可见诱饵字符 (Decoy)
    char_elements = []
    char_list = list(expr)
    total_chars = len(char_list)

    # 均分 X 轴宽度
    margin_x = 8
    avail_w = width - margin_x * 2
    step_w = avail_w / max(1, total_chars)

    # 准备 2 个随机诱饵字符（假数字或假符号），给爬虫制造乱码
    decoys = [random.choice("0123456789+-%"), random.choice("789ABCDEF")]
    decoy_insert_indices = random.sample(range(max(1, total_chars)), min(2, total_chars))

    for idx, ch in enumerate(char_list):
        # 如果当前位置需要插入诱饵字符
        if idx in decoy_insert_indices and decoys:
            decoy_char = decoys.pop()
            # 诱饵字符使用极小字号、0 透明度或绝对隐藏样式，视觉不可见但 DOM textContent 会捕获
            char_elements.append(
                f'<text x="{int(margin_x + idx * step_w)}" y="24" fill="none" opacity="0.001" font-size="1px">{decoy_char}</text>'
            )

        # 计算当前字符的基础中心坐标
        base_x = margin_x + idx * step_w + step_w / 2
        # 随机上下微调 (±3.5px)
        jitter_y = 25 + random.uniform(-3.5, 3.5)
        # 随机旋转 (-18° ~ +18°)
        rot_deg = random.uniform(-18, 18)
        # 随机倾斜 (-12° ~ +12°)
        skew_deg = random.uniform(-12, 12)
        # 随机字体大小 (15px ~ 19px)
        font_sz = random.randint(15, 19)
        # 随机加粗
        weight = "bold" if random.random() > 0.35 else "600"
        # 随机高对比度色彩
        color = random.choice(COLOR_PALETTE)

        transform_attr = f'transform="rotate({rot_deg:.1f} {base_x:.1f} {jitter_y:.1f}) skewX({skew_deg:.1f})"'

        char_elements.append(
            f'<text x="{base_x:.1f}" y="{jitter_y:.1f}" '
            f'text-anchor="middle" dominant-baseline="middle" '
            f'fill="{color}" font-family="system-ui, -apple-system, sans-serif" '
            f'font-size="{font_sz}" font-weight="{weight}" '
            f'{transform_attr}>{ch}</text>'
        )

    # 4. 组装完整 SVG
    svg_body = "".join(noise_elements) + "".join(char_elements)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" '
        f'style="background:#0b1120; border-radius:6px; user-select:none; cursor:pointer;" '
        f'title="点击图片刷新验证码">'
        f'<rect width="100%" height="100%" fill="#0b1120" rx="6" stroke="#1e293b" stroke-width="1"/>'
        f'{svg_body}'
        f'</svg>'
    )
    return svg


def check_ip_rate_limit(ip: str) -> Tuple[bool, str]:
    """
    检查指定 IP 是否因频繁验证失败而被熔断锁定
    """
    if not ip or ip in ('127.0.0.1', 'localhost', '::1'):
        return True, ""

    now = time.time()
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT fail_count, lock_until FROM ip_security_limits WHERE ip=?", (ip,))
    row = c.fetchone()
    conn.close()

    if row:
        lock_until = row["lock_until"] or 0
        if lock_until > now:
            remaining_mins = max(1, int(math.ceil((lock_until - now) / 60)))
            return False, f"安全熔断：检测到高频失败尝试，该IP已被临时锁定，请 {remaining_mins} 分钟后再试"

    return True, ""


def record_ip_attempt_result(ip: str, success: bool):
    """
    记录 IP 验证成败：成功则清零计数，连续失败达到阈值（5次）则锁定 15 分钟
    """
    if not ip or ip in ('127.0.0.1', 'localhost', '::1'):
        return

    now = time.time()
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT fail_count, lock_until FROM ip_security_limits WHERE ip=?", (ip,))
    row = c.fetchone()

    if success:
        if row:
            c.execute("DELETE FROM ip_security_limits WHERE ip=?", (ip,))
            conn.commit()
    else:
        current_fails = (row["fail_count"] if row else 0) + 1
        lock_until = 0
        # 连续失败达 5 次，锁定 15 分钟 (900秒)
        if current_fails >= 5:
            lock_until = now + 900
        
        c.execute(
            """INSERT INTO ip_security_limits (ip, fail_count, lock_until, last_attempt) 
               VALUES (?, ?, ?, ?)
               ON CONFLICT(ip) DO UPDATE SET 
                 fail_count=excluded.fail_count,
                 lock_until=excluded.lock_until,
                 last_attempt=excluded.last_attempt""",
            (ip, current_fails, lock_until, now)
        )
        conn.commit()

    conn.close()


def generate_math_captcha(client_ip: Optional[str] = None) -> dict:
    """
    生成高防护自适应验证码，包含人机挑战与防自动化凭证
    """
    expr, ans, hint = _generate_challenge_content()
    cid = str(uuid.uuid4()).replace('-', '')[:16]
    now = time.time()
    expire_at = now + 300  # 5分钟有效期

    conn = get_db()
    c = conn.cursor()
    # 清理过期验证码
    c.execute("DELETE FROM captchas WHERE expire_at < ?", (now,))
    c.execute(
        "INSERT INTO captchas (id, answer, expire_at, created_at) VALUES (?, ?, ?, ?)",
        (cid, ans.upper(), expire_at, now)
    )
    conn.commit()
    conn.close()

    svg = _generate_hardened_svg(expr)

    return {
        "captcha_id": cid,
        "svg": svg,
        "hint": hint
    }


def verify_captcha(
    cid: str,
    ans: str,
    client_ip: Optional[str] = None,
    honeypot_val: Optional[str] = None
) -> Tuple[bool, str]:
    """
    多重防机器人与人机合规校验：
    1. 蜜罐检测 (Honeypot Trap)
    2. IP 撞库频率与锁定保护
    3. 人类反应时间窗口分析 (Timing Check: < 0.5s 判定为自动化机器)
    4. 验证码时效与精确答案匹配
    """
    # 1. 蜜罐陷阱：隐藏字段一旦有任何输入，100% 为自动化爬虫
    if honeypot_val and len(str(honeypot_val).strip()) > 0:
        if client_ip:
            record_ip_attempt_result(client_ip, False)
        return False, "安全防护：检测到非人类交互，操作被拒绝"

    # 2. IP 锁定检查
    if client_ip:
        ip_ok, ip_err = check_ip_rate_limit(client_ip)
        if not ip_ok:
            return False, ip_err

    if not cid or not ans:
        return False, "请输入验证码计算结果或答案"

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT answer, expire_at, created_at FROM captchas WHERE id=?", (cid,))
    row = c.fetchone()

    if not row:
        conn.close()
        return False, "验证码已失效或已被使用，请点击图片刷新"

    correct_ans = str(row["answer"]).strip().upper()
    expire_at = row["expire_at"]
    created_at = row["created_at"] or 0

    # 阅后即焚，防止验证码被并发重放
    c.execute("DELETE FROM captchas WHERE id=?", (cid,))
    conn.commit()
    conn.close()

    now = time.time()

    # 3. 超时检查
    if now > expire_at:
        return False, "验证码已超时过期，请点击图片刷新"

    # 4. 人机交互反应时间检查 (人类从看到题目、输入到提交至少需要 500ms，毫秒级提交一律为脚本)
    if created_at > 0 and (now - created_at) < 0.5:
        if client_ip:
            record_ip_attempt_result(client_ip, False)
        return False, "人机交互过快，请人工辨识并重新输入"

    # 5. 答案匹配 (支持中英混排大小写不敏感)
    user_ans = str(ans).strip().upper()

    # 容错：去除中间空格或等号
    user_ans = user_ans.replace('=', '').replace(' ', '')
    correct_ans = correct_ans.replace('=', '').replace(' ', '')

    if user_ans != correct_ans:
        if client_ip:
            record_ip_attempt_result(client_ip, False)
        return False, "防机器人验证答案错误，请仔细辨识并重试"

    # 验证通过，重置该 IP 失败计数
    if client_ip:
        record_ip_attempt_result(client_ip, True)

    return True, "验证通过"