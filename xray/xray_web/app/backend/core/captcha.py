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

import html
import math
import secrets
import time
import uuid
from typing import Tuple, Dict, Any, Optional
from core.cache import cache
from core.rate_limit import ban_ip, check_ip_ban, is_whitelisted_ip

_rng = secrets.SystemRandom()

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
    'rgba(56, 189, 248, 0.42)', 'rgba(129, 140, 248, 0.42)',
    'rgba(52, 211, 153, 0.36)', 'rgba(244, 114, 182, 0.36)',
    'rgba(251, 191, 36, 0.36)', 'rgba(148, 163, 184, 0.30)'
]

FONT_FAMILIES = [
    'system-ui, -apple-system, sans-serif',
    'ui-sans-serif, Arial, sans-serif',
    'ui-monospace, Consolas, monospace',
]


def _generate_challenge_content() -> Tuple[str, str, str]:
    """
    生成随机多元题型，打破单一数学公式的刻板模式
    返回: (题目字符串, 正确答案字符串, 提示说明)
    """
    mode = _rng.choices(['math_mixed', 'compare', 'trivia', 'alphanumeric'], weights=[40, 22, 13, 25])[0]

    if mode == 'math_mixed':
        op = _rng.choice(['+', '-', '*'])
        if op == '+':
            a = _rng.randint(1, 15)
            b = _rng.randint(1, 15)
            ans = str(a + b)
            choice = _rng.choice([1, 2, 3])
            if choice == 1:
                expr = f"{CN_NUMS.get(a, str(a))}加{b}=?"
            elif choice == 2:
                expr = f"{a}+{CN_NUMS.get(b, str(b))}=?"
            else:
                expr = f"{CN_NUMS.get(a, str(a))}+{b}=?"
        elif op == '-':
            a = _rng.randint(10, 25)
            b = _rng.randint(1, a - 1)
            ans = str(a - b)
            choice = _rng.choice([1, 2, 3])
            if choice == 1:
                expr = f"{a}减{CN_NUMS.get(b, str(b))}=?"
            elif choice == 2:
                expr = f"{CN_NUMS.get(a, str(a))}-{b}=?"
            else:
                expr = f"{a}-{CN_NUMS.get(b, str(b))}=?"
        else:
            a = _rng.randint(2, 9)
            b = _rng.randint(2, 9)
            ans = str(a * b)
            expr = f"{CN_NUMS.get(a, str(a))}乘{b}=?"
        return expr, ans, "计算结果"

    elif mode == 'compare':
        a = _rng.randint(3, 20)
        b = _rng.randint(3, 20)
        while a == b:
            b = _rng.randint(3, 20)

        kind = _rng.choice(['max', 'min', 'diff'])
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
        trivias = [
            ("一周有几天?", "7"),
            ("一年有几季?", "4"),
            ("一年几个月?", "12"),
            ("两天几小时?", "48"),
            ("半小时几分?", "30"),
            ("直角多少度?", "90"),
            ("平角多少度?", "180"),
            ("一小时几分?", "60"),
            ("一分钟几秒?", "60"),
            ("一打有几个?", "12"),
            ("正方形几边?", "4"),
            ("三角形几角?", "3"),
            ("五乘五等于?", "25"),
            ("七加八等于?", "15"),
            ("九减三等于?", "6"),
        ]
        q, a = _rng.choice(trivias)
        return q, a, "常识数字"

    else:
        # 4位高抗 OCR 字母数字混合挑战码（无固定前缀锚点，排除易混字符 0/O/1/I/L）
        charset = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
        code = "".join(_rng.choice(charset) for _ in range(4))
        return code, code.upper(), "4位字符(忽略大小写)"


def _build_char_node(
    ch: str,
    target_x: float,
    target_y: float,
    font_sz: int,
    extra_attr: str = "",
) -> str:
    """使用随机局部坐标系偏移 + 旋转错切渲染单字，防止通过固定 x/y/opacity 属性正则抽取"""
    rot_deg = _rng.uniform(-20, 20)
    skew_deg = _rng.uniform(-14, 14)
    weight = "bold" if _rng.random() > 0.3 else "700"
    color = _rng.choice(COLOR_PALETTE)
    font_fam = _rng.choice(FONT_FAMILIES)
    dx = _rng.uniform(-45, 45)
    dy = _rng.uniform(-20, 20)
    rx = target_x - dx
    ry = target_y - dy
    escaped_ch = html.escape(ch)
    return (
        f'<g transform="translate({dx:.1f},{dy:.1f})" {extra_attr}>'
        f'<text x="{rx:.1f}" y="{ry:.1f}" '
        f'text-anchor="middle" dominant-baseline="middle" '
        f'fill="{color}" stroke="#060a12" stroke-width="0.55" paint-order="stroke fill" '
        f'font-family="{font_fam}" font-size="{font_sz}" font-weight="{weight}" '
        f'transform="rotate({rot_deg:.1f} {rx:.1f} {ry:.1f}) skewX({skew_deg:.1f})">'
        f'{escaped_ch}</text></g>'
    )


def _generate_hardened_svg(expr: str) -> str:
    """
    强力抗 OCR & 抗 XML 源码解析 SVG：
    1. 像素级波浪形变滤镜 (<feTurbulence> + <feDisplacementMap>) 扭曲所有字符笔画边缘
    2. 遮挡层诱饵字符 (置于不透明渐变背景之下，具备与真字完全相同的字号/颜色/透明度，彻底迷惑 XML/正则爬虫)
    3. clipPath 零域诱饵 + 真字符节点 DOM 顺序随机打乱 + 随机 <g> 相对坐标偏移
    4. 前景与背景多层三次贝塞尔穿切曲线、彩色噪斑与高频短划线
    """
    width = 148
    height = 44
    uid = secrets.token_hex(4)

    # 1. 定义渐变背景、零域裁剪与波浪扭曲滤镜
    bf_x = _rng.uniform(0.030, 0.046)
    bf_y = _rng.uniform(0.055, 0.082)
    warp_scale = _rng.uniform(2.6, 3.6)
    noise_seed = _rng.randint(1, 9999)

    c_start = _rng.choice(['#080d1a', '#090f1d', '#0b1120'])
    c_end = _rng.choice(['#0f192d', '#111c33', '#0d172a'])

    defs_block = (
        f'<defs>'
        f'<linearGradient id="bg_{uid}" x1="0%" y1="0%" x2="100%" y2="100%">'
        f'<stop offset="0%" stop-color="{c_start}"/>'
        f'<stop offset="100%" stop-color="{c_end}"/>'
        f'</linearGradient>'
        f'<clipPath id="cp_{uid}"><rect x="-12" y="-12" width="1" height="1"/></clipPath>'
        f'<filter id="wp_{uid}" filterUnits="userSpaceOnUse" x="-12" y="-12" width="{width + 24}" height="{height + 24}">'
        f'<feTurbulence type="fractalNoise" baseFrequency="{bf_x:.3f} {bf_y:.3f}" numOctaves="2" seed="{noise_seed}" result="ns"/>'
        f'<feDisplacementMap in="SourceGraphic" in2="ns" scale="{warp_scale:.2f}" xChannelSelector="R" yChannelSelector="G"/>'
        f'</filter>'
        f'</defs>'
    )

    # 2. 底层遮挡诱饵字符（位于不透明背景 <rect> 之下，视觉完全不可见，但属性与真字符高度一致）
    decoy_pool = "0123456789ABCDEFGHJKMNPQRSTUVWXYZ加减乘大小一二三四五六七八九十=?"
    occluded_decoys = []
    for _ in range(_rng.randint(8, 12)):
        occluded_decoys.append(
            _build_char_node(
                _rng.choice(decoy_pool),
                _rng.uniform(12, width - 12),
                _rng.uniform(14, height - 12),
                _rng.randint(15, 20),
            )
        )

    # 3. 覆盖不透明背景矩形（遮住底层诱饵）
    bg_rect = (
        f'<rect width="100%" height="100%" fill="url(#bg_{uid})" '
        f'rx="6" stroke="#1e293b" stroke-width="1"/>'
    )

    # 4. 背景干扰层（噪斑、微短线、低透明度水印曲线）
    bg_noise = []
    for _ in range(30):
        cx = _rng.randint(4, width - 4)
        cy = _rng.randint(4, height - 4)
        r = _rng.uniform(0.7, 2.0)
        bg_noise.append(f'<circle cx="{cx}" cy="{cy}" r="{r:.1f}" fill="{_rng.choice(NOISE_COLORS)}" />')

    for _ in range(8):
        lx1 = _rng.randint(4, width - 14)
        ly1 = _rng.randint(4, height - 6)
        lx2 = lx1 + _rng.randint(-14, 14)
        ly2 = ly1 + _rng.randint(-10, 10)
        bg_noise.append(
            f'<line x1="{lx1}" y1="{ly1}" x2="{lx2}" y2="{ly2}" '
            f'stroke="{_rng.choice(NOISE_COLORS)}" stroke-width="{_rng.uniform(0.8, 1.4):.1f}" />'
        )

    for _ in range(3):
        x1 = _rng.randint(0, 18)
        y1 = _rng.randint(6, height - 6)
        cx1 = _rng.randint(25, 62)
        cy1 = _rng.randint(2, height - 2)
        cx2 = _rng.randint(75, 118)
        cy2 = _rng.randint(2, height - 2)
        x2 = _rng.randint(width - 20, width)
        y2 = _rng.randint(6, height - 6)
        dash = f'stroke-dasharray="{_rng.randint(2,4)},{_rng.randint(2,3)}"' if _rng.random() > 0.45 else ''
        bg_noise.append(
            f'<path d="M {x1},{y1} C {cx1},{cy1} {cx2},{cy2} {x2},{y2}" '
            f'fill="none" stroke="{_rng.choice(NOISE_COLORS)}" stroke-width="{_rng.uniform(1.1, 1.8):.1f}" {dash} />'
        )

    # 5. 渲染真实字符 + clipPath 零域诱饵，全部随机打乱 DOM 顺序并整体施加波浪形变滤镜
    char_list = list(expr)
    total_chars = len(char_list)
    margin_x = 12 if total_chars <= 4 else 8
    avail_w = width - margin_x * 2
    step_w = avail_w / max(1, total_chars)
    base_font_min = 18 if total_chars <= 4 else 15
    base_font_max = 21 if total_chars <= 4 else 18

    warped_nodes = []
    for idx, ch in enumerate(char_list):
        base_x = margin_x + idx * step_w + step_w / 2 + _rng.uniform(-1.5, 1.5)
        base_y = height / 2 + 1 + _rng.uniform(-3.0, 3.0)
        font_sz = _rng.randint(base_font_min, base_font_max)
        warped_nodes.append(_build_char_node(ch, base_x, base_y, font_sz))

    for _ in range(_rng.randint(2, 3)):
        warped_nodes.append(
            _build_char_node(
                _rng.choice(decoy_pool),
                _rng.uniform(15, width - 15),
                _rng.uniform(14, height - 12),
                _rng.randint(15, 19),
                extra_attr=f'clip-path="url(#cp_{uid})"',
            )
        )

    _rng.shuffle(warped_nodes)
    char_layer = f'<g filter="url(#wp_{uid})">{"".join(warped_nodes)}</g>'

    # 6. 前景穿切干扰曲线（破除 OCR 字符连通域分割）
    fg_noise = []
    for _ in range(3):
        x1 = _rng.randint(0, 15)
        y1 = _rng.randint(6, height - 6)
        cx1 = _rng.randint(28, 65)
        cy1 = _rng.randint(3, height - 3)
        cx2 = _rng.randint(78, 120)
        cy2 = _rng.randint(3, height - 3)
        x2 = _rng.randint(width - 16, width)
        y2 = _rng.randint(6, height - 6)
        dash = 'stroke-dasharray="4,3"' if _rng.random() > 0.5 else ''
        fg_noise.append(
            f'<path d="M {x1},{y1} C {cx1},{cy1} {cx2},{cy2} {x2},{y2}" '
            f'fill="none" stroke="{_rng.choice(NOISE_COLORS)}" stroke-width="{_rng.uniform(0.9, 1.4):.1f}" {dash} />'
        )

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" '
        f'style="background:{c_start}; border-radius:6px; user-select:none; cursor:pointer;" '
        f'title="点击图片刷新验证码">'
        f'{defs_block}'
        f'{"".join(occluded_decoys)}'
        f'{bg_rect}'
        f'{"".join(bg_noise)}'
        f'{char_layer}'
        f'{"".join(fg_noise)}'
        f'</svg>'
    )
    return svg


def check_ip_rate_limit(ip: str) -> Tuple[bool, str]:
    """
    检查指定 IP 是否因触发全域黑名单或频繁验证失败而被熔断锁定（优先走 Redis，故障/未启用自动回退 SQL kv_cache）
    """
    if not ip or ip in ('127.0.0.1', 'localhost', '::1') or is_whitelisted_ip(ip):
        return True, ""

    banned, ban_wait, ban_reason = check_ip_ban(ip)
    if banned:
        return False, f"安全熔断（{ban_reason}），该 IP 已被临时限制访问，请 {ban_wait} 秒后再试"

    lock_data = cache.get_json(f"ip_lock:{ip}")
    if isinstance(lock_data, dict):
        lock_until = float(lock_data.get("lock_until") or 0)
        now = time.time()
        if lock_until > now:
            remaining_mins = max(1, int(math.ceil((lock_until - now) / 60)))
            return False, f"安全熔断：检测到高频失败尝试，该IP已被临时锁定，请 {remaining_mins} 分钟后再试"

    return True, ""


def record_ip_attempt_result(ip: str, success: bool):
    """
    记录 IP 验证成败：成功则清零短期计数，连续失败达到阈值（5次）则阶梯锁定（15m -> 30m -> 60m 并加入全域黑名单）
    """
    if not ip or ip in ('127.0.0.1', 'localhost', '::1') or is_whitelisted_ip(ip):
        return

    fail_key = f"ip_fail:{ip}"
    lock_key = f"ip_lock:{ip}"

    if success:
        cache.delete(fail_key, lock_key)
        return

    current_fails = cache.incr_with_ttl(fail_key, ttl=900)
    if current_fails >= 5:
        strikes = cache.incr_with_ttl(f"ip_strike:{ip}", ttl=86400)
        duration = min(3600, 900 * (2 ** max(0, strikes - 1)))
        cache.set_json(lock_key, {"lock_until": time.time() + duration}, ttl=duration)
        cache.delete(fail_key)
        if strikes >= 2:
            ban_ip(ip, duration_seconds=duration, reason="多次触发人机验证熔断")


def generate_math_captcha(client_ip: Optional[str] = None) -> dict:
    """
    生成高防护自适应验证码，包含人机挑战与防自动化凭证
    """
    expr, ans, hint = _generate_challenge_content()
    cid = str(uuid.uuid4()).replace('-', '')[:16]
    now = time.time()
    expire_at = now + 300  # 5分钟有效期

    cache.set_json(
        f"captcha:{cid}",
        {"answer": ans.upper(), "expire_at": expire_at, "created_at": now},
        ttl=300,
    )

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
    # 1. 蜜罐陷阱：隐藏字段一旦有任何输入，100% 为自动化爬虫，立即全域封禁 IP 30 分钟
    if honeypot_val and len(str(honeypot_val).strip()) > 0:
        if client_ip:
            ban_ip(client_ip, duration_seconds=1800, reason="触发蜜罐诱饵")
            record_ip_attempt_result(client_ip, False)
        return False, "安全防护：检测到非人类交互，操作已被拦截封禁"

    # 2. IP 锁定检查
    if client_ip:
        ip_ok, ip_err = check_ip_rate_limit(client_ip)
        if not ip_ok:
            return False, ip_err

    if not cid or not ans:
        return False, "请输入验证码计算结果或答案"

    # 阅后即焚，原子读取并销毁，防止验证码被并发重放
    row = cache.pop_json(f"captcha:{cid}")
    if not isinstance(row, dict):
        return False, "验证码已失效或已被使用，请点击图片刷新"

    correct_ans = str(row.get("answer", "")).strip().upper()
    expire_at = float(row.get("expire_at") or 0)
    created_at = float(row.get("created_at") or 0)

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