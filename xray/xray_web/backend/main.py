import os
import json
import uuid
import secrets
import subprocess
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

CONFIG_FILE = "/etc/xray/config.json"
CLIENT_INFO_FILE = "/etc/xray/client_info.txt"
WEB_PASSWORD = os.environ.get("WEB_PASSWORD", "admin123")
AUTH_TOKENS = set()

app = FastAPI(title="Xray REALITY API")

def get_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_config(cfg):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    reload_xray()

def reload_xray():
    try:
        if os.path.exists("/var/run/xray.pid"):
            with open("/var/run/xray.pid", "r") as f:
                pid = int(f.read().strip())
            os.kill(pid, 15)
    except Exception as e:
        print(f"Reload error: {e}")

def verify_token(authorization: str = Header(None)):
    if not authorization or authorization not in AUTH_TOKENS:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return authorization

class LoginReq(BaseModel):
    password: str

class AddUserReq(BaseModel):
    email: str
    id: str = None

class DelUserReq(BaseModel):
    id: str

@app.post("/api/login")
def login(req: LoginReq):
    if req.password == WEB_PASSWORD:
        token = secrets.token_hex(16)
        AUTH_TOKENS.add(token)
        return {"token": token}
    raise HTTPException(status_code=401, detail="Invalid password")

@app.get("/api/status")
def get_status(token: str = Depends(verify_token)):
    cfg = get_config()
    inbound = cfg.get("inbounds", [{}])[0]
    reality = inbound.get("streamSettings", {}).get("realitySettings", {})
    clients = inbound.get("settings", {}).get("clients", [])
    
    server_ip = os.environ.get("SERVER_IP", "YOUR_SERVER_IP")
    if os.path.exists(CLIENT_INFO_FILE):
        try:
            with open(CLIENT_INFO_FILE, encoding="utf-8") as f:
                for line in f:
                    if "IP / 地址:" in line:
                        server_ip = line.split(":")[-1].strip()
        except Exception:
            pass

    ver = "Unknown"
    try:
        res = subprocess.run(["xray", "version"], capture_output=True, text=True)
        if res.stdout:
            ver = res.stdout.splitlines()[0]
    except Exception:
        pass

    meta = {
        "ip": server_ip,
        "port": inbound.get("port", 443),
        "sni": reality.get("serverNames", ["www.apple.com"])[0] if reality.get("serverNames") else "www.apple.com",
        "publicKey": os.environ.get("PUBLIC_KEY", ""),
        "shortId": reality.get("shortIds", [""])[0] if reality.get("shortIds") else "",
        "version": ver
    }
    return {"meta": meta, "users": clients}

@app.post("/api/users/add")
def add_user(req: AddUserReq, token: str = Depends(verify_token)):
    cfg = get_config()
    clients = cfg.setdefault("inbounds", [{}])[0].setdefault("settings", {}).setdefault("clients", [])
    uid = req.id if req.id and len(req.id) >= 16 else str(uuid.uuid4())
    user = {
        "id": uid,
        "flow": "xtls-rprx-vision",
        "email": req.email or f"user_{len(clients)+1}"
    }
    clients.append(user)
    save_config(cfg)
    return {"success": True, "user": user}

@app.post("/api/users/delete")
def delete_user(req: DelUserReq, token: str = Depends(verify_token)):
    cfg = get_config()
    clients = cfg.get("inbounds", [{}])[0].get("settings", {}).get("clients", [])
    if len(clients) <= 1:
        raise HTTPException(status_code=400, detail="Cannot delete the last remaining user")
    cfg["inbounds"][0]["settings"]["clients"] = [u for u in clients if u.get("id") != req.id]
    save_config(cfg)
    return {"success": True}

if os.path.exists("/app/backend/static/assets"):
    app.mount("/assets", StaticFiles(directory="/app/backend/static/assets"), name="assets")

@app.get("/{full_path:path}")
def serve_spa(full_path: str):
    if os.path.exists("/app/backend/static/index.html"):
        return FileResponse("/app/backend/static/index.html")
    return {"message": "Frontend not compiled yet. Access /docs for API."}