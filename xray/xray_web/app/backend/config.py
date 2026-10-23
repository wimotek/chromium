import os

class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "xray_secure_key_default")
    DB_PATH = os.getenv("DB_PATH", "/data/xray_web.db")
    
    # Web 端口与代理端口彻底解耦
    WEB_PORT = int(os.getenv("WEB_PORT", 3000))
    PORT = WEB_PORT
    
    APP_MODE = os.getenv("APP_MODE", "user")

    # Xray 节点监听端口
    SERVER_PORT = os.getenv("PORT", "443")
    SERVER_HOST = os.getenv("SERVER_HOST", "127.0.0.1")
    SNI = os.getenv("DEST", "www.microsoft.com").split(":")[0]
    SHORT_ID = os.getenv("SHORT_ID", "123456")
    XRAY_API_SERVER = os.getenv("XRAY_API_SERVER", "127.0.0.1:10085")

    # 方案 C：第三方发卡网 API 鉴权 Token (可在 compose 中自定义，也支持在后台动态修改)
    FAKA_API_TOKEN = os.getenv("FAKA_API_TOKEN", "faka_secret_token_8899")