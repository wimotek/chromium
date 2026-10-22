import os

class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "xray_secure_key_default")
    # 严格持久化在 /data/xray_manager.db
    DB_PATH = os.getenv("DB_PATH", "/data/xray_manager.db")
    PORT = int(os.getenv("PORT", 8080))
    APP_MODE = os.getenv("APP_MODE", "user")

    SERVER_HOST = os.getenv("SERVER_HOST", "127.0.0.1")
    SERVER_PORT = os.getenv("SERVER_PORT", "443")
    SNI = os.getenv("REALITY_SNI", "itunes.apple.com")
    SHORT_ID = os.getenv("REALITY_SHORT_ID", "123456")
    XRAY_API_SERVER = os.getenv("XRAY_API_SERVER", "127.0.0.1:10085")