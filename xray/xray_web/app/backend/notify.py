import smtplib
import requests
from email.mime.text import MIMEText
from email.header import Header
from email.utils import formataddr
from db import get_setting

def send_smtp_email(to_email: str, subject: str, content: str) -> tuple[bool, str]:
    """发送 SMTP 邮件 (支持 SSL 465 与 STARTTLS 587/25)"""
    host = get_setting("smtp_host", "").strip()
    port = int(get_setting("smtp_port", "465").strip() or 465)
    user = get_setting("smtp_user", "").strip()
    pwd = get_setting("smtp_pass", "").strip()
    sender_name = get_setting("smtp_sender", "Xray 节点管理系统").strip()
    use_ssl = get_setting("smtp_ssl", "true").lower() == "true"

    if not host or not user or not pwd:
        return False, "系统尚未配置 SMTP 邮件服务器参数，无法发送邮件"

    try:
        msg = MIMEText(content, 'html', 'utf-8')
        msg['From'] = formataddr((str(Header(sender_name, 'utf-8')), user))
        msg['To'] = formataddr((to_email, to_email))
        msg['Subject'] = Header(subject, 'utf-8')

        if use_ssl or port == 465:
            server = smtplib.SMTP_SSL(host, port, timeout=10)
        else:
            server = smtplib.SMTP(host, port, timeout=10)
            try:
                server.starttls()
            except Exception:
                pass

        server.login(user, pwd)
        server.sendmail(user, [to_email], msg.as_string())
        server.quit()
        return True, "邮件发送成功"
    except Exception as e:
        return False, f"邮件发送失败: {str(e)}"

def send_serverchan_msg(sendkey: str, title: str, desp: str) -> tuple[bool, str]:
    """调用 Server酱·Turbo版 发送微信通知"""
    if not sendkey or not sendkey.strip():
        return False, "用户未配置 Server酱 SendKey"

    url = f"https://sctapi.ftqq.com/{sendkey.strip()}.send"
    try:
        res = requests.post(url, data={"title": title, "desp": desp}, timeout=10)
        json_data = res.json()
        if json_data.get("code") == 0:
            return True, "Server酱微信通知推送成功"
        else:
            return False, f"Server酱返回错误: {json_data.get('message')}"
    except Exception as e:
        return False, f"Server酱请求失败: {str(e)}"

def notify_user(user: dict, title: str, content_html: str, content_text: str = None) -> tuple[bool, str]:
    """
    通用通知派发器：根据用户的偏好分发 (默认: email)
    """
    if not content_text:
        content_text = content_html

    notify_type = user.get("notify_type", "email")
    if notify_type == "serverchan":
        key = user.get("serverchan_key", "").strip()
        if key:
            return send_serverchan_msg(key, title, content_text)
        # 如果选了 Server酱但没填 key，自动降级发邮件保底
        return send_smtp_email(user["email"], title, content_html)
    else:
        # 默认使用邮件通道
        return send_smtp_email(user["email"], title, content_html)