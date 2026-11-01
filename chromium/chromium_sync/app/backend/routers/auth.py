import uuid
import random
from datetime import datetime, timedelta
import jwt
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel
from core.database import get_setting, set_setting
from core.security import verify_password, hash_password, verify_token, CAPTCHA_STORE

router = APIRouter(tags=["认证"])

class LoginDTO(BaseModel):
    username: str
    password: str
    captcha_token: str
    captcha_answer: str

@router.get("/api/captcha")
def get_captcha():
    a, b = random.randint(10, 50), random.randint(1, 9)
    token = str(uuid.uuid4())
    CAPTCHA_STORE[token] = {"ans": a + b, "exp": datetime.utcnow().timestamp() + 180}
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="120" height="38" viewBox="0 0 120 38">
        <rect width="100%" height="100%" fill="#09122a" rx="4"/>
        <text x="18" y="25" font-family="-apple-system, system-ui" font-size="16" font-weight="bold" fill="#00f0ff">{a} + {b} = ?</text>
    </svg>'''
    return {"token": token, "svg": svg}

@router.post("/api/login")
def login(data: LoginDTO, req: Request):
    cap = CAPTCHA_STORE.get(data.captcha_token)
    if not cap or datetime.utcnow().timestamp() > cap["exp"] or str(cap["ans"]) != data.captcha_answer.strip():
        raise HTTPException(status_code=400, detail="验证码错误或已过期")

    admin_user = get_setting('admin_username', 'admin')
    hashed_pwd = get_setting('admin_password')

    if data.username.strip() != admin_user or not verify_password(data.password, hashed_pwd):
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    jwt_secret = get_setting('jwt_secret')
    return {"token": jwt.encode({"sub": admin_user, "exp": datetime.utcnow() + timedelta(days=7)}, jwt_secret, algorithm="HS256")}

@router.get("/api/profile")
def get_profile(user: dict = Depends(verify_token)):
    return {
        "username": get_setting("admin_username"),
        "api_key": get_setting("api_key")
    }

@router.post("/api/profile")
def update_profile(data: dict, user: dict = Depends(verify_token)):
    import secrets
    if data.get("username"):
        set_setting("admin_username", data["username"].strip())
    if data.get("new_password"):
        set_setting("admin_password", hash_password(data["new_password"]))
    if data.get("regenerate_key"):
        set_setting("api_key", 'cdp_' + secrets.token_urlsafe(24))
    return {"message": "配置更新成功"}