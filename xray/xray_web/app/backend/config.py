import os

class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "xray_secure_key_default")
    DB_PATH = os.getenv("DB_PATH", "/data/xray_web.db")
    
    # 核心修复：优先读取 WEB_PORT (3000)，不能与 Xray 的 PORT (8443/443) 混淆
    WEB_PORT = int(os.getenv("WEB_PORT", 3000))
    PORT = WEB_PORT
    
    APP_MODE = os.getenv("APP_MODE", "user")

    # Xray 节点监听端口
    SERVER_PORT = os.getenv("PORT", "443")
    SERVER_HOST = os.getenv("SERVER_HOST", "127.0.0.1")
    SNI = os.getenv("DEST", "www.microsoft.com").split(":")[0]
    SHORT_ID = os.getenv("SHORT_ID", "123456")
    XRAY_API_SERVER = os.getenv("XRAY_API_SERVER", "127.0.0.1:10085")