from datetime import datetime
import hashlib
import os
import re

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from config import KEYS_DIR
from core.db import session_scope
from core.models import SshKey
from core.security import verify_token

router = APIRouter(tags=["租户隔离 SSH 密钥库"])


def _safe_disk_filename(owner_id: int, raw_name: str) -> str:
    base = os.path.basename((raw_name or "id_rsa").strip())
    clean = re.sub(r"[^A-Za-z0-9._-]", "_", base)[:96] or "id_rsa"
    return f"u{int(owner_id)}_{clean}"


@router.get("/api/ssh-keys")
def list_keys(user: dict = Depends(verify_token)):
    uid = int(user["id"])
    with session_scope() as db:
        rows = db.query(SshKey).filter(SshKey.owner_id == uid).order_by(SshKey.id.desc()).all()
        result = []
        for r in rows:
            fp = os.path.join(KEYS_DIR, r.filename)
            sz = os.path.getsize(fp) if os.path.isfile(fp) else 0
            result.append({
                "id": r.id,
                "name": r.name,
                "filename": r.filename,
                "fingerprint": r.fingerprint,
                "created_at": r.created_at,
                "size": sz,
            })
        return result


@router.post("/api/ssh-keys")
async def upload_key(
    file: UploadFile = File(...),
    remark: str = Form(""),
    user: dict = Depends(verify_token),
):
    uid = int(user["id"])
    disk_name = _safe_disk_filename(uid, file.filename or "id_rsa")
    path = os.path.join(KEYS_DIR, disk_name)
    content = await file.read()
    with open(path, "wb") as f:
        f.write(content)
    os.chmod(path, 0o600)

    fp_hash = "sha256:" + hashlib.sha256(content).hexdigest()[:24]
    display_name = (remark or os.path.basename(file.filename or disk_name)).strip()[:255]
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with session_scope() as db:
        existing = db.query(SshKey).filter(SshKey.owner_id == uid, SshKey.filename == disk_name).first()
        if existing is None:
            db.add(
                SshKey(
                    owner_id=uid,
                    name=display_name,
                    filename=disk_name,
                    fingerprint=fp_hash,
                    created_at=now_str,
                )
            )
        else:
            existing.name = display_name
            existing.fingerprint = fp_hash
            existing.created_at = now_str
    return {"message": f"租户私钥 [{display_name}] 上传完成", "filename": disk_name}


@router.delete("/api/ssh-keys/{key_id}")
def delete_key(key_id: int, user: dict = Depends(verify_token)):
    uid = int(user["id"])
    with session_scope() as db:
        row = db.query(SshKey).filter(SshKey.id == int(key_id), SshKey.owner_id == uid).first()
        if row is None:
            raise HTTPException(status_code=404, detail="密钥不存在或无权操作")
        disk_name = row.filename
        db.delete(row)

    p = os.path.join(KEYS_DIR, os.path.basename(disk_name))
    if os.path.exists(p):
        try:
            os.remove(p)
        except OSError:
            pass
    return {"message": "租户私有密钥已销毁"}
