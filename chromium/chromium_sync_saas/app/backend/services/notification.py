import smtplib
from email.header import Header
from email.mime.text import MIMEText
import httpx
from config import logger
from core.db import get_setting


def send_email_sync(to_email: str, subject: str, content: str):
    host = get_setting("smtp_host")
    port = int(get_setting("smtp_port", "465"))
    use_ssl = get_setting("smtp_ssl", "1") == "1"
    user = get_setting("smtp_user")
    password = get_setting("smtp_pass")
    sender_name = get_setting("smtp_sender_name", "Wimotek SaaS Hub")

    if not all([host, user, password, to_email]):
        raise ValueError("SMTP 邮件配置不完整，请先检查服务器地址、账号与授权码")

    msg = MIMEText(content, "plain", "utf-8")
    msg["From"] = f"{sender_name} <{user}>"
    msg["To"] = to_email
    msg["Subject"] = Header(subject, "utf-8")

    server = None
    try:
        if use_ssl:
            server = smtplib.SMTP_SSL(host, port, timeout=10)
        else:
            server = smtplib.SMTP(host, port, timeout=10)
            server.starttls()
        server.login(user, password)
        server.sendmail(user, [to_email], msg.as_string())
    finally:
        if server:
            try:
                server.quit()
            except Exception:
                pass


async def dispatch_notification(title: str, content: str):
    import asyncio

    if get_setting("email_notify_enabled", "0") == "1":
        to_addr = get_setting("email_notify_to")
        if to_addr:
            try:
                await asyncio.to_thread(send_email_sync, to_addr, title, content)
            except Exception as e:
                logger.error(f"❌ 发送告警邮件失败: {e}")

    if get_setting("serverchan_enabled", "0") == "1":
        sendkey = get_setting("serverchan_key")
        if sendkey:
            try:
                async with httpx.AsyncClient(timeout=8.0) as client:
                    await client.post(
                        f"https://sctapi.ftqq.com/{sendkey}.send",
                        data={"title": title, "desp": content},
                    )
            except Exception as e:
                logger.error(f"❌ Server酱 推送异常: {e}")
