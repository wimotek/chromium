import json
import os
import secrets
import sqlite3
import subprocess
import uuid
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ================= 路径配置与持久化存储 =================
DB_FILE = "/data/xray_web.db"
CONFIG_FILE = "/data/config.json"
CLIENT_INFO_FILE = "/data/client_info.txt"
WEB_PASSWORD = os.environ.get("WEB_PASSWORD", "admin123")
AUTH_TOKENS = set()

app = FastAPI(title="Xray REALITY Management API")


# ================= 1. SQLite 数据库操作 =================
def init_db():
  os.makedirs("/data", exist_ok=True)
  with sqlite3.connect(DB_FILE) as conn:
    conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uuid TEXT UNIQUE NOT NULL,
                email TEXT NOT NULL,
                flow TEXT DEFAULT 'xtls-rprx-vision',
                enabled INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
    conn.commit()


def get_config():
  if os.path.exists(CONFIG_FILE) and os.path.getsize(CONFIG_FILE) > 0:
    try:
      with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)
    except Exception as e:
      print(f"[Error] Failed to parse {CONFIG_FILE}: {e}")
  return {}


def reload_xray():
  try:
    if os.path.exists("/var/run/xray.pid"):
      with open("/var/run/xray.pid", "r") as f:
        pid = int(f.read().strip())
      os.kill(pid, 15)  # 发送 SIGTERM，由 entrypoint 守护进程毫秒级重启
  except Exception as e:
    print(f"[Reload] Error reloading Xray: {e}")


# 将 SQLite 数据库中所有状态为 enabled=1 的用户同步到 /data/config.json
def sync_db_to_xray():
  with sqlite3.connect(DB_FILE) as conn:
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT uuid, email, flow FROM users WHERE enabled = 1"
    ).fetchall()
    clients = [
        {"id": r["uuid"], "flow": r["flow"], "email": r["email"]}
        for r in rows
    ]

  cfg = get_config()
  if cfg and "inbounds" in cfg and len(cfg["inbounds"]) > 0:
    cfg["inbounds"][0].setdefault("settings", {})["clients"] = clients
    # 原子写入，防止截断导致 0 字节
    tmp_file = "/tmp/config.sync.tmp.json"
    with open(tmp_file, "w", encoding="utf-8") as f:
      json.dump(cfg, f, indent=2)
    os.replace(tmp_file, CONFIG_FILE)
    reload_xray()


# 服务启动时执行的数据迁移/校验
@app.on_event("startup")
def on_startup():
  init_db()
  with sqlite3.connect(DB_FILE) as conn:
    user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]

    # 情况 A: 数据库为空，从现存 config.json 导入初始用户
    if user_count == 0:
      cfg = get_config()
      if cfg:
        clients = (
            cfg.get("inbounds", [{}])[0].get("settings", {}).get("clients", [])
        )
        for c in clients:
          conn.execute(
              "INSERT OR IGNORE INTO users (uuid, email, flow) VALUES (?, ?,"
              " ?)",
              (
                  c.get("id"),
                  c.get("email", "user"),
                  c.get("flow", "xtls-rprx-vision"),
              ),
          )
        conn.commit()
        print(f"[Init] Migrated {len(clients)} initial users into SQLite.")
    # 情况 B: 数据库已有数据，以数据库为唯一基准刷新 config.json
    else:
      sync_db_to_xray()


# ================= 2. 鉴权依赖 =================
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


class ToggleUserReq(BaseModel):
  id: str
  enabled: int


# ================= 3. RESTful API =================
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

  # 直接从 SQLite 查询所有用户（包含创建时间与启用状态）
  with sqlite3.connect(DB_FILE) as conn:
    conn.row_factory = sqlite3.Row
    users = [
        dict(r)
        for r in conn.execute(
            "SELECT id, uuid, email, flow, enabled, created_at FROM users"
            " ORDER BY id DESC"
        ).fetchall()
    ]

  meta = {
      "ip": server_ip,
      "port": inbound.get("port", 443),
      "sni": (
          reality.get("serverNames", ["www.microsoft.com"])[0]
          if reality.get("serverNames")
          else "www.microsoft.com"
      ),
      "publicKey": os.environ.get("PUBLIC_KEY", ""),
      "shortId": (
          reality.get("shortIds", [""])[0] if reality.get("shortIds") else ""
      ),
      "version": ver,
  }
  return {"meta": meta, "users": users}


@app.post("/api/users/add")
def add_user(req: AddUserReq, token: str = Depends(verify_token)):
  uid = req.id.strip() if req.id and len(req.id.strip()) >= 16 else str(uuid.uuid4())
  email = req.email.strip() if req.email else f"user_{secrets.token_hex(3)}"

  with sqlite3.connect(DB_FILE) as conn:
    try:
      conn.execute(
          "INSERT INTO users (uuid, email, flow, enabled) VALUES (?, ?, ?,"
          " 1)",
          (uid, email, "xtls-rprx-vision"),
      )
      conn.commit()
    except sqlite3.IntegrityError:
      raise HTTPException(status_code=400, detail="UUID already exists")

  sync_db_to_xray()
  return {"success": True}


@app.post("/api/users/delete")
def delete_user(req: DelUserReq, token: str = Depends(verify_token)):
  with sqlite3.connect(DB_FILE) as conn:
    count = conn.execute(
        "SELECT COUNT(*) FROM users WHERE enabled = 1"
    ).fetchone()[0]
    if count <= 1:
      raise HTTPException(
          status_code=400, detail="At least one active user must be retained"
      )
    conn.execute("DELETE FROM users WHERE uuid = ?", (req.id,))
    conn.commit()

  sync_db_to_xray()
  return {"success": True}


@app.post("/api/users/toggle")
def toggle_user(req: ToggleUserReq, token: str = Depends(verify_token)):
  with sqlite3.connect(DB_FILE) as conn:
    conn.execute(
        "UPDATE users SET enabled = ? WHERE uuid = ?", (req.enabled, req.id)
    )
    conn.commit()

  sync_db_to_xray()
  return {"success": True}


# ================= 4. 前端 SPA 静态挂载 =================
if os.path.exists("/app/backend/static/assets"):
  app.mount(
      "/assets",
      StaticFiles(directory="/app/backend/static/assets"),
      name="assets",
  )


@app.get("/{full_path:path}")
def serve_spa(full_path: str):
  if os.path.exists("/app/backend/static/index.html"):
    return FileResponse("/app/backend/static/index.html")
  return {"message": "Frontend static assets not built yet."}