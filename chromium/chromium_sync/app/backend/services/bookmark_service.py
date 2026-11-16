import asyncio
from datetime import datetime
from typing import Any, Dict, List, Optional

from config import logger
from core.db import session_scope
from core.models import Bookmark

DEFAULT_STARTER_BOOKMARKS = [
    {"title": "GitHub", "url": "https://github.com/login", "folder": "开发工具", "pinned": 1, "sort_order": 1},
    {"title": "X / Twitter", "url": "https://x.com", "folder": "常用站点", "pinned": 1, "sort_order": 2},
    {"title": "淘宝", "url": "https://login.taobao.com", "folder": "购物生活", "pinned": 1, "sort_order": 3},
    {"title": "京东", "url": "https://plogin.m.jd.com", "folder": "购物生活", "pinned": 1, "sort_order": 4},
    {"title": "B站", "url": "https://passport.bilibili.com/login", "folder": "常用站点", "pinned": 1, "sort_order": 5},
    {"title": "百度", "url": "https://www.baidu.com", "folder": "常用站点", "pinned": 1, "sort_order": 6},
]


def _normalize_url(raw_url: str) -> str:
    u = (raw_url or "").strip()
    if not u:
        return ""
    if not (u.startswith("http://") or u.startswith("https://")):
        u = "https://" + u
    return u[:1024]


def list_bookmarks_payload() -> List[Dict[str, Any]]:
    with session_scope() as db:
        rows = (
            db.query(Bookmark)
            .order_by(Bookmark.pinned.desc(), Bookmark.sort_order.asc(), Bookmark.id.asc())
            .all()
        )
        return [r.to_dict() for r in rows]


def upsert_bookmark(
    title: str,
    url: str,
    folder: str = "常用站点",
    pinned: int = 1,
    sort_order: int = 0,
    source_node: str = "hub",
) -> Optional[Dict[str, Any]]:
    norm_url = _normalize_url(url)
    if not norm_url:
        return None
    clean_title = (title or "").strip()[:255] or norm_url
    clean_folder = (folder or "").strip()[:128] or "常用站点"
    clean_pinned = 1 if pinned in (1, True, "1", "true", "True") else 0
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with session_scope() as db:
        existing = db.query(Bookmark).filter(Bookmark.url == norm_url).first()
        if existing is not None:
            existing.title = clean_title
            existing.folder = clean_folder
            existing.pinned = clean_pinned
            if sort_order is not None:
                existing.sort_order = int(sort_order)
            if source_node:
                existing.source_node = str(source_node)[:128]
            existing.updated_at = now_str
            db.flush()
            return existing.to_dict()

        obj = Bookmark(
            title=clean_title,
            url=norm_url,
            folder=clean_folder,
            pinned=clean_pinned,
            sort_order=int(sort_order or 0),
            source_node=str(source_node or "hub")[:128],
            created_at=now_str,
            updated_at=now_str,
        )
        db.add(obj)
        db.flush()
        return obj.to_dict()


def update_bookmark_by_id(bookmark_id: int, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with session_scope() as db:
        obj = db.get(Bookmark, bookmark_id)
        if obj is None:
            return None
        if "url" in data:
            norm_url = _normalize_url(str(data["url"]))
            if norm_url and norm_url != obj.url:
                dup = db.query(Bookmark).filter(Bookmark.url == norm_url, Bookmark.id != bookmark_id).first()
                if dup is not None:
                    raise ValueError("目标网址已存在另一条收藏记录")
                obj.url = norm_url
        if "title" in data:
            obj.title = (str(data["title"]) or "").strip()[:255] or obj.url
        if "folder" in data:
            obj.folder = (str(data["folder"]) or "").strip()[:128] or "常用站点"
        if "pinned" in data:
            obj.pinned = 1 if data["pinned"] in (1, True, "1", "true", "True") else 0
        if "sort_order" in data:
            obj.sort_order = int(data["sort_order"] or 0)
        obj.updated_at = now_str
        db.flush()
        return obj.to_dict()


def delete_bookmark_by_id(bookmark_id: int) -> bool:
    with session_scope() as db:
        deleted = db.query(Bookmark).filter(Bookmark.id == bookmark_id).delete(synchronize_session=False)
        return deleted > 0


def delete_bookmark_by_url(url: str) -> bool:
    norm_url = _normalize_url(url)
    if not norm_url:
        return False
    with session_scope() as db:
        deleted = db.query(Bookmark).filter(Bookmark.url == norm_url).delete(synchronize_session=False)
        return deleted > 0


def merge_bookmarks(items: List[Dict[str, Any]], source_node: str = "client", overwrite_existing: bool = False) -> int:
    if not items:
        return 0
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    changed = 0
    with session_scope() as db:
        existing_map = {b.url: b for b in db.query(Bookmark).all()}
        for idx, it in enumerate(items):
            if not isinstance(it, dict):
                continue
            norm_url = _normalize_url(str(it.get("url") or ""))
            if not norm_url:
                continue
            title = (str(it.get("title") or "").strip()[:255]) or norm_url
            folder = (str(it.get("folder") or "").strip()[:128]) or "常用站点"
            pinned = 1 if it.get("pinned", 1) in (1, True, "1", "true", "True") else 0
            sort_order = int(it.get("sort_order") if it.get("sort_order") is not None else idx)

            if norm_url in existing_map:
                if overwrite_existing:
                    row = existing_map[norm_url]
                    row.title = title
                    row.folder = folder
                    row.pinned = pinned
                    row.updated_at = now_str
                    changed += 1
            else:
                obj = Bookmark(
                    title=title,
                    url=norm_url,
                    folder=folder,
                    pinned=pinned,
                    sort_order=sort_order,
                    source_node=str(it.get("source_node") or source_node)[:128],
                    created_at=now_str,
                    updated_at=now_str,
                )
                db.add(obj)
                existing_map[norm_url] = obj
                changed += 1
    return changed


def seed_starter_bookmarks() -> int:
    return merge_bookmarks(DEFAULT_STARTER_BOOKMARKS, source_node="hub_preset", overwrite_existing=False)


async def push_bookmarks_to_session(session, bookmarks: Optional[List[Dict[str, Any]]] = None) -> bool:
    if session is None or getattr(session, "is_closed", True):
        return False
    payload = {
        "type": "bookmarks_sync",
        "bookmarks": bookmarks if bookmarks is not None else list_bookmarks_payload(),
    }
    try:
        await session.send_raw_json(payload)
        return True
    except Exception as e:
        logger.debug(f"向节点 ID:{getattr(session, 'node_id', '?')} 推送收藏夹失败: {e}")
        return False


async def broadcast_bookmarks_sync(exclude_node_id: Optional[int] = None) -> int:
    from services.tunnel_manager import tunnel_mgr

    bookmarks = list_bookmarks_payload()
    sessions = [
        s
        for nid, s in list(tunnel_mgr.reverse_sessions.items())
        if not s.is_closed and (exclude_node_id is None or nid != exclude_node_id)
    ]
    if not sessions:
        return 0
    results = await asyncio.gather(
        *(push_bookmarks_to_session(s, bookmarks) for s in sessions),
        return_exceptions=True,
    )
    return sum(1 for r in results if r is True)


async def handle_client_bookmark_event(node_id: Optional[int], node_label: str, parsed: Dict[str, Any]) -> bool:
    """
    处理客户端主动发起的收藏夹联动消息:
    - bookmark_upsert: 新增或更新单条收藏并全网广播
    - bookmark_delete: 按 URL 删除单条收藏并全网广播
    - bookmarks_merge: 客户端上传本地新增/离线收藏合并入 Hub 并回推全量列表
    - bookmarks_pull / action=pull_bookmarks: 请求下发最新 Hub 收藏列表
    """
    from services.tunnel_manager import tunnel_mgr
    from core.models import Node

    resolved_label = (node_label or "").strip()
    if node_id and (not resolved_label or resolved_label == f"node-{node_id}"):
        try:
            with session_scope() as db:
                n = db.get(Node, node_id)
                if n is not None and n.name:
                    resolved_label = n.name
        except Exception:
            pass
    if not resolved_label:
        resolved_label = f"node-{node_id}" if node_id else "client"

    msg_type = parsed.get("type")
    action = parsed.get("action")

    if msg_type == "bookmark_upsert":
        b = parsed.get("bookmark") if isinstance(parsed.get("bookmark"), dict) else parsed
        res = upsert_bookmark(
            title=str(b.get("title") or ""),
            url=str(b.get("url") or ""),
            folder=str(b.get("folder") or "常用站点"),
            pinned=1 if b.get("pinned", 1) in (1, True, "1", "true", "True") else 0,
            sort_order=int(b.get("sort_order") or 0),
            source_node=resolved_label,
        )
        if res is not None:
            await broadcast_bookmarks_sync()
        return True

    if msg_type == "bookmark_delete":
        b_url = str(parsed.get("url") or (parsed.get("bookmark") or {}).get("url") or "")
        if delete_bookmark_by_url(b_url):
            await broadcast_bookmarks_sync()
        else:
            sess = tunnel_mgr.get_reverse_session(node_id) if node_id else None
            if sess:
                await push_bookmarks_to_session(sess)
        return True

    if msg_type == "bookmarks_merge":
        items = parsed.get("bookmarks") or []
        changed = merge_bookmarks(items, source_node=resolved_label, overwrite_existing=False)
        if changed > 0:
            await broadcast_bookmarks_sync()
        elif node_id:
            sess = tunnel_mgr.get_reverse_session(node_id)
            if sess:
                await push_bookmarks_to_session(sess)
        return True

    if msg_type == "bookmarks_pull" or action == "pull_bookmarks":
        if node_id:
            sess = tunnel_mgr.get_reverse_session(node_id)
            if sess:
                await push_bookmarks_to_session(sess)
        return True

    return False
