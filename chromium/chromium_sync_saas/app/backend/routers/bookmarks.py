from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.db import session_scope
from core.models import Node
from core.security import verify_token
from services.bookmark_service import (
    broadcast_bookmarks_sync,
    delete_bookmark_by_id,
    list_bookmarks_payload,
    merge_bookmarks,
    seed_starter_bookmarks,
    update_bookmark_by_id,
    upsert_bookmark,
)
from services.tunnel_manager import tunnel_mgr

router = APIRouter(tags=["租户隔离云端联动收藏夹"])


class BookmarkDTO(BaseModel):
    title: str = ""
    url: str
    folder: str = "常用站点"
    pinned: int = 1
    sort_order: int = 0


class BookmarkUpdateDTO(BaseModel):
    title: Optional[str] = None
    url: Optional[str] = None
    folder: Optional[str] = None
    pinned: Optional[int] = None
    sort_order: Optional[int] = None


@router.get("/api/bookmarks", summary="获取当前租户隔离的云端收藏夹列表")
def get_bookmarks(user: dict = Depends(verify_token)):
    uid = int(user["id"])
    items = list_bookmarks_payload(uid)
    folders = sorted({it["folder"] for it in items if it.get("folder")})
    online_nodes = sum(
        1
        for s in tunnel_mgr.reverse_sessions.values()
        if not s.is_closed and int(getattr(s, "owner_id", 0)) == uid
    )
    return {
        "bookmarks": items,
        "folders": folders or ["常用站点"],
        "online_nodes": online_nodes,
    }


@router.post("/api/bookmarks", summary="新增或更新收藏并实时推送至本租户自有在线节点")
async def create_or_upsert_bookmark(data: BookmarkDTO, user: dict = Depends(verify_token)):
    uid = int(user["id"])
    item = upsert_bookmark(
        owner_id=uid,
        title=data.title,
        url=data.url,
        folder=data.folder,
        pinned=data.pinned,
        sort_order=data.sort_order,
        source_node=f"tenant:{uid}",
    )
    if item is None:
        raise HTTPException(status_code=400, detail="网址不能为空")
    pushed = await broadcast_bookmarks_sync(uid)
    return {"message": f"收藏已保存并联动下发至本租户 {pushed} 个在线节点", "bookmark": item, "pushed_nodes": pushed}


@router.put("/api/bookmarks/{bookmark_id}")
async def update_bookmark(bookmark_id: int, data: BookmarkUpdateDTO, user: dict = Depends(verify_token)):
    uid = int(user["id"])
    patch = {k: v for k, v in data.model_dump().items() if v is not None}
    try:
        updated = update_bookmark_by_id(uid, bookmark_id, patch)
    except ValueError as ve:
        raise HTTPException(status_code=409, detail=str(ve))
    if updated is None:
        raise HTTPException(status_code=404, detail="收藏记录不存在")
    pushed = await broadcast_bookmarks_sync(uid)
    return {"message": f"收藏已更新并同步至本租户 {pushed} 个在线节点", "bookmark": updated, "pushed_nodes": pushed}


@router.delete("/api/bookmarks/{bookmark_id}")
async def delete_bookmark(bookmark_id: int, user: dict = Depends(verify_token)):
    uid = int(user["id"])
    if not delete_bookmark_by_id(uid, bookmark_id):
        raise HTTPException(status_code=404, detail="收藏记录不存在")
    pushed = await broadcast_bookmarks_sync(uid)
    return {"message": f"已删除并通知本租户 {pushed} 个在线节点更新", "pushed_nodes": pushed}


@router.post("/api/bookmarks/push-all")
async def push_all_bookmarks(user: dict = Depends(verify_token)):
    uid = int(user["id"])
    pushed = await broadcast_bookmarks_sync(uid)
    return {"message": f"已将全量收藏夹下发至本租户 {pushed} 个在线节点", "pushed_nodes": pushed}


@router.post("/api/bookmarks/import-defaults")
async def import_default_bookmarks(user: dict = Depends(verify_token)):
    uid = int(user["id"])
    added = seed_starter_bookmarks(uid)
    pushed = await broadcast_bookmarks_sync(uid)
    return {"message": f"导入 {added} 条常用站点，并联动下发至 {pushed} 个在线节点", "added": added, "pushed_nodes": pushed}


@router.post("/api/bookmarks/pull/{node_id}")
async def pull_node_bookmarks(node_id: int, user: dict = Depends(verify_token)):
    uid = int(user["id"])
    with session_scope() as db:
        node = db.get(Node, node_id)
        if node is None or int(node.owner_id) != uid:
            raise HTTPException(status_code=404, detail="节点不存在或不属于当前租户")
        node_name = node.name or f"node-{node_id}"

    sess = tunnel_mgr.get_reverse_session(node_id)
    if not sess or sess.is_closed:
        raise HTTPException(status_code=400, detail="仅支持从当前在线的 WSS 长连节点拉取书签")

    try:
        res = await sess.send_command("fetch_bookmarks", timeout=10.0)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"从节点提取书签失败: {e}")

    if res.get("status") == "error":
        raise HTTPException(status_code=502, detail=res.get("message", "节点返回错误"))

    raw_items = res.get("bookmarks") or []
    added = merge_bookmarks(uid, raw_items, source_node=node_name, overwrite_existing=False)
    pushed = await broadcast_bookmarks_sync(uid)
    return {
        "message": f"已从 [{node_name}] 扫描 {len(raw_items)} 条书签，新增入库 {added} 条并同步至 {pushed} 个自有在线节点",
        "scanned": len(raw_items),
        "added": added,
        "pushed_nodes": pushed,
    }
