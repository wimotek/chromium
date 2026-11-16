import os
from datetime import datetime
from fastapi import APIRouter, Depends, File, Form, UploadFile

from config import KEYS_DIR
from core.db import session_scope
from core.models import SshKey
from core.security import verify_token

router = APIRouter(tags=["SSH密钥库"])


@router.get("/api/ssh-keys")
def list_keys(user: dict = Depends(verify_token)):
    with session_scope() as db:
        db_keys = {k.filename: k.to_dict() for k in db.query(SshKey).order_by(SshKey.id.desc()).all()}

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
                        "size": meta.get("size", os.path.getsize(fp)),
                    })
                else:
                    c_time = datetime.fromtimestamp(os.path.getctime(fp)).strftime("%Y-%m-%d %H:%M:%S")
                    sz = os.path.getsize(fp)
                    new_key = SshKey(filename=fn, remark="", created_at=c_time, size=sz)
                    db.add(new_key)
                    db.flush()
                    result.append({
                        "id": new_key.id,
                        "filename": fn,
                        "remark": "",
                        "created_at": c_time,
                        "size": sz,
                    })
    return result


@router.post("/api/ssh-keys")
async def upload_key(
    file: UploadFile = File(...),
    remark: str = Form(""),
    user: dict = Depends(verify_token),
):
    path = os.path.join(KEYS_DIR, file.filename)
    content = await file.read()
    with open(path, "wb") as f:
        f.write(content)
    os.chmod(path, 0o600)

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with session_scope() as db:
        existing = db.query(SshKey).filter(SshKey.filename == file.filename).first()
        if existing is None:
            db.add(
                SshKey(
                    filename=file.filename,
                    remark=remark.strip(),
                    created_at=now_str,
                    size=len(content),
                )
            )
        else:
            existing.remark = remark.strip()
            existing.created_at = now_str
            existing.size = len(content)
    return {"message": f"证书 {file.filename} 上传完成"}


@router.put("/api/ssh-keys/{filename:path}")
def update_key_remark(filename: str, data: dict, user: dict = Depends(verify_token)):
    new_remark = data.get("remark", "").strip()
    fp = os.path.join(KEYS_DIR, filename)
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    file_time = datetime.fromtimestamp(os.path.getctime(fp)).strftime("%Y-%m-%d %H:%M:%S") if os.path.exists(fp) else now_str
    file_size = os.path.getsize(fp) if os.path.exists(fp) else 0

    with session_scope() as db:
        row = db.query(SshKey).filter(SshKey.filename == filename).first()
        if row:
            row.remark = new_remark
        else:
            db.add(SshKey(filename=filename, remark=new_remark, created_at=file_time, size=file_size))
    return {"message": "备注更新成功", "remark": new_remark}


@router.delete("/api/ssh-keys/{filename:path}")
def delete_key(filename: str, user: dict = Depends(verify_token)):
    p = os.path.join(KEYS_DIR, filename)
    if os.path.exists(p):
        os.remove(p)
    with session_scope() as db:
        db.query(SshKey).filter(SshKey.filename == filename).delete(synchronize_session=False)
    return {"message": "证书已销毁"}