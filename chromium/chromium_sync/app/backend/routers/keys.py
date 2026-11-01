import os
import sqlite3
from datetime import datetime
from fastapi import APIRouter, Depends, UploadFile, File, Form
from core.config import DB_PATH, KEYS_DIR
from core.security import verify_token

router = APIRouter(tags=["SSH密钥库"])

@router.get("/api/ssh-keys")
def list_keys(user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM ssh_keys ORDER BY id DESC")
    db_keys = {r["filename"]: dict(r) for r in cur.fetchall()}

    result = []
    for fn in os.listdir(KEYS_DIR):
        fp = os.path.join(KEYS_DIR, fn)
        if os.path.isfile(fp):
            meta = db_keys.get(fn)
            if meta:
                result.append({
                    "id": meta.get("id"),
                    "filename": fn,
                    "remark": meta.get("remark", ""),
                    "created_at": meta.get("created_at"),
                    "size": meta.get("size", os.path.getsize(fp))
                })
            else:
                c_time = datetime.fromtimestamp(os.path.getctime(fp)).strftime("%Y-%m-%d %H:%M:%S")
                sz = os.path.getsize(fp)
                cur.execute("INSERT OR IGNORE INTO ssh_keys (filename, remark, created_at, size) VALUES (?, '', ?, ?)",
                            (fn, c_time, sz))
                conn.commit()
                result.append({
                    "id": None,
                    "filename": fn,
                    "remark": "",
                    "created_at": c_time,
                    "size": sz
                })
    conn.close()
    return result

@router.post("/api/ssh-keys")
async def upload_key(
    file: UploadFile = File(...),
    remark: str = Form(""),
    user: dict = Depends(verify_token)
):
    path = os.path.join(KEYS_DIR, file.filename)
    content = await file.read()
    with open(path, "wb") as f:
        f.write(content)
    os.chmod(path, 0o600)

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("INSERT OR REPLACE INTO ssh_keys (filename, remark, created_at, size) VALUES (?, ?, ?, ?)",
                (file.filename, remark.strip(), now_str, len(content)))
    conn.commit()
    conn.close()
    return {"message": f"证书 {file.filename} 上传完成"}

@router.put("/api/ssh-keys/{filename:path}")
def update_key_remark(filename: str, data: dict, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT id FROM ssh_keys WHERE filename=?", (filename,))
    row = cur.fetchone()
    new_remark = data.get("remark", "").strip()

    fp = os.path.join(KEYS_DIR, filename)
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    file_time = datetime.fromtimestamp(os.path.getctime(fp)).strftime("%Y-%m-%d %H:%M:%S") if os.path.exists(fp) else now_str
    file_size = os.path.getsize(fp) if os.path.exists(fp) else 0

    if row:
        cur.execute("UPDATE ssh_keys SET remark=? WHERE filename=?", (new_remark, filename))
    else:
        cur.execute("INSERT INTO ssh_keys (filename, remark, created_at, size) VALUES (?, ?, ?, ?)",
                    (filename, new_remark, file_time, file_size))
    conn.commit()
    conn.close()
    return {"message": "备注更新成功", "remark": new_remark}

@router.delete("/api/ssh-keys/{filename:path}")
def delete_key(filename: str, user: dict = Depends(verify_token)):
    p = os.path.join(KEYS_DIR, filename)
    if os.path.exists(p):
        os.remove(p)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("DELETE FROM ssh_keys WHERE filename=?", (filename,))
    conn.commit()
    conn.close()
    return {"message": "证书已销毁"}