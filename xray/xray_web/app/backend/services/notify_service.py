import smtplib
import urllib.request
import urllib.parse
import json
from email.mime.text import MIMEText
from email.header import Header
from core.db import get_setting

def send_smtp_email(to_email: str, subject: str, content_html: str) -> tuple[bool, str]:
    smtp_host = get_setting("smtp_host")
    smtp_port = int(get_setting("smtp_port", "465") or 465)
    smtp_user = get_setting("smtp_user")
    smtp_pass = get_setting("smtp_pass")
    smtp_sender = get_setting("smtp_sender", "Xray 节点中心")
    smtp_ssl = get_setting("smtp_ssl", "true").lower() == "true"

    if not smtp_host or not smtp_user or not smtp_pass:
        return False, "SMTP 邮件发信服务器尚未配置"

    message = MIMEText(content_html, 'html', 'utf-8')
    message['From'] = Header(f"{smtp_sender} <{smtp_user}>", 'utf-8')
    message['To'] = Header(to_email, 'utf-8')
    message['Subject'] = Header(subject, 'utf-8')

    try:
        if smtp_ssl:
            server = smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=10)
        else:
            server = smtplib.SMTP(smtp_host, smtp_port, timeout=10)
            server.starttls()

        server.login(smtp_user, smtp_pass)
        server.sendmail(smtp_user, [to_email], message.as_string())
        server.quit()
        return True, "邮件发送成功"
    except Exception as e:
        return False, f"邮件投递异常: {str(e)}"

def send_serverchan_msg(sendkey: str, title: str, desp: str) -> tuple[bool, str]:
    if not sendkey.strip():
        return False, "ServerChan SendKey 为空"

    url = f"https://sctapi.ftqq.com/{sendkey.strip()}.send"
    params = urllib.parse.urlencode({"title": title, "desp": desp}).encode('utf-8')

    try:
        req = urllib.request.Request(url, data=params, headers={'User-Agent': 'Xray-Notify/1.0'})
        with urllib.request.urlopen(req, timeout=10) as response:
            res_data = json.loads(response.read().decode('utf-8'))
            if res_data.get("code") == 0:
                return True, "Server酱微信推送成功"
            else:
                return False, f"Server酱返回错误: {res_data.get('message')}"
    except Exception as e:
        return False, f"Server酱请求失败: {str(e)}"

def notify_user(user: dict, title: str, html_content: str, text_content: str) -> tuple[bool, str]:
    notify_type = user.get("notify_type", "email")

    if notify_type == "serverchan" and user.get("serverchan_key"):
        ok, msg = send_serverchan_msg(user["serverchan_key"], title, text_content)
        if ok:
            return True, msg

    if user.get("email"):
        return send_smtp_email(user["email"], title, html_content)

    return False, "用户未绑定有效的接收方式"

def notify_admin(title: str, html_content: str, text_content: str) -> tuple[bool, str]:
    """向系统管理员推送通知 (支持 SMTP 邮件与 Server 酱微信双通道)"""
    admin_channel = get_setting("admin_notify_channel", "email").lower()
    admin_email = get_setting("admin_notify_email") or get_setting("smtp_user")
    admin_serverchan = get_setting("admin_serverchan_key", "")

    sent_any = False
    messages = []

    # 1. 微信 Server 酱渠道
    if admin_channel in ["serverchan", "all"] and admin_serverchan:
        ok_sc, msg_sc = send_serverchan_msg(admin_serverchan, title, text_content)
        if ok_sc:
            sent_any = True
        messages.append(f"微信: {msg_sc}")

    # 2. 邮件渠道
    if admin_channel in ["email", "all"] and admin_email:
        ok_mail, msg_mail = send_smtp_email(admin_email, title, html_content)
        if ok_mail:
            sent_any = True
        messages.append(f"邮件: {msg_mail}")

    if sent_any:
        return True, "，".join(messages)
    return False, "管理员未配置有效的接收通道或通知渠道关闭: " + "，".join(messages)