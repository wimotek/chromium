import smtplib
from email.mime.text import MIMEText
from email.header import Header
from typing import Optional
import httpx
from core.config import logger
from core.database import get_setting

def send_email_notification(title: str, content: str, override_to: Optional[str] = None) -> tuple[bool, str]:
    if get_setting('email_notify_enabled', '0') != '1' and not override_to:
        return False, "邮件推送未启用"

    host = get_setting('smtp_host')
    port = int(get_setting('smtp_port') or '465')
    use_ssl = get_setting('smtp_ssl') == '1'
    user = get_setting('smtp_user')
    password = get_setting('smtp_pass')
    sender_name = get_setting('smtp_sender_name', 'CDP 节点中心')
    to_email = override_to if override_to else (get_setting('email_notify_to') or user)

    if not (host and user and password and to_email):
        return False, "SMTP 配置不完整"

    try:
        msg = MIMEText(content, 'plain', 'utf-8')
        msg['From'] = Header(f"{sender_name} <{user}>", 'utf-8')
        msg['To'] = Header(to_email, 'utf-8')
        msg['Subject'] = Header(f"[CDP 集群告警] {title}", 'utf-8')

        if use_ssl:
            server = smtplib.SMTP_SSL(host, port, timeout=10)
        else:
            server = smtplib.SMTP(host, port, timeout=10)
            server.starttls()

        server.login(user, password)
        server.sendmail(user, [to_email], msg.as_string())
        server.quit()
        return True, "发信正常"
    except Exception as e:
        return False, str(e)

async def send_serverchan_notification(title: str, content: str) -> bool:
    if get_setting('serverchan_enabled', '0') != '1':
        return False
    key = get_setting('serverchan_key')
    if not key:
        return False
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.post(f"https://sctapi.ftqq.com/{key}.send", data={"title": title, "desp": content})
            return res.status_code == 200
    except Exception:
        return False

async def dispatch_notification(title: str, content: str):
    send_email_notification(title, content)
    await send_serverchan_notification(title, content)