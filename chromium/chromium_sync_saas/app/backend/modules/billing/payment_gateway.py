import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
import secrets
from typing import Any, Dict, Optional
from urllib.parse import urlencode, urlparse, urlsplit, urlunsplit

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import httpx

from config import logger

_CST_TZ = timezone(timedelta(hours=8))
_PEM_BLOCK_RE = re.compile(r"-----BEGIN ([A-Z0-9 ]+)-----(.*?)-----END \1-----", flags=re.DOTALL)


def _now_cst_str() -> str:
    return datetime.now(_CST_TZ).strftime("%Y-%m-%d %H:%M:%S")


def _clean_pem_text(raw: str) -> str:
    txt = (raw or "").replace("\ufeff", "").replace("\r\n", "\n").replace("\r", "\n").replace("\\n", "\n").strip()
    if not txt:
        return ""
    if "-----BEGIN " not in txt:
        return txt

    def _reformat_block(match: re.Match) -> str:
        label = match.group(1).strip()
        body = "".join(match.group(2).split())
        lines = [body[i : i + 64] for i in range(0, len(body), 64)]
        return f"-----BEGIN {label}-----\n" + "\n".join(lines) + f"\n-----END {label}-----"

    return _PEM_BLOCK_RE.sub(_reformat_block, txt)


def _wrap_pem(raw: str, begin_marker: str, end_marker: str) -> str:
    txt = _clean_pem_text(raw)
    if not txt:
        return ""
    if "-----BEGIN " in txt:
        return txt
    compact = "".join(txt.split())
    lines = [compact[i : i + 64] for i in range(0, len(compact), 64)]
    return f"{begin_marker}\n" + "\n".join(lines) + f"\n{end_marker}"


def _load_rsa_private_key(raw: str):
    txt = _clean_pem_text(raw)
    if not txt:
        raise ValueError("RSA 私钥为空")
    candidates = [txt]
    if "-----BEGIN " not in txt:
        candidates = [
            _wrap_pem(txt, "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"),
            _wrap_pem(txt, "-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"),
        ]
    last_err = None
    for pem in candidates:
        try:
            return serialization.load_pem_private_key(pem.encode("utf-8"), password=None)
        except Exception as exc:
            last_err = exc
    raise ValueError(f"无法解析 RSA 私钥: {last_err}")


def _load_rsa_public_key(raw: str):
    txt = _clean_pem_text(raw)
    if not txt:
        raise ValueError("RSA 公钥/证书为空")
    if "-----BEGIN CERTIFICATE-----" in txt:
        cert = x509.load_pem_x509_certificate(txt.encode("utf-8"))
        return cert.public_key()
    candidates = [txt]
    if "-----BEGIN " not in txt:
        candidates = [
            _wrap_pem(txt, "-----BEGIN PUBLIC KEY-----", "-----END PUBLIC KEY-----"),
            _wrap_pem(txt, "-----BEGIN CERTIFICATE-----", "-----END CERTIFICATE-----"),
        ]
    last_err = None
    for pem in candidates:
        try:
            if "-----BEGIN CERTIFICATE-----" in pem:
                return x509.load_pem_x509_certificate(pem.encode("utf-8")).public_key()
            return serialization.load_pem_public_key(pem.encode("utf-8"))
        except Exception as exc:
            last_err = exc
    raise ValueError(f"无法解析 RSA 公钥或证书: {last_err}")


def _get_alipay_cert_sn(cert_pem: str) -> str:
    txt = _clean_pem_text(cert_pem)
    if not txt:
        return ""
    cert = x509.load_pem_x509_certificate(txt.encode("utf-8"))
    issuer_str = cert.issuer.rfc4514_string()
    raw = (issuer_str + str(cert.serial_number)).encode("utf-8")
    return hashlib.md5(raw).hexdigest()


def _get_alipay_root_cert_sn(root_cert_pem: str) -> str:
    txt = _clean_pem_text(root_cert_pem)
    if not txt:
        return ""
    blocks = re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", txt, flags=re.DOTALL)
    sns = []
    rsa_oids = {
        "1.2.840.113549.1.1.4",   # md5WithRSAEncryption
        "1.2.840.113549.1.1.5",   # sha1WithRSAEncryption
        "1.2.840.113549.1.1.11",  # sha256WithRSAEncryption
        "1.2.840.113549.1.1.12",  # sha384WithRSAEncryption
        "1.2.840.113549.1.1.13",  # sha512WithRSAEncryption
    }
    for block in blocks:
        try:
            cert = x509.load_pem_x509_certificate(block.encode("utf-8"))
            oid_dotted = cert.signature_algorithm_oid.dotted_string
            oid_name = (getattr(cert.signature_algorithm_oid, "_name", "") or "").lower()
            if oid_dotted in rsa_oids or ("rsa" in oid_name and "sm2" not in oid_name):
                sns.append(_get_alipay_cert_sn(block))
        except Exception:
            continue
    return "_".join(sns)


def _normalize_alipay_gateway_base(raw_gateway: str) -> str:
    gw = (raw_gateway or "https://openapi.alipay.com/gateway.do").strip()
    if not gw:
        return "https://openapi.alipay.com/gateway.do"
    parts = urlsplit(gw)
    if not parts.scheme or not parts.netloc:
        return gw.split("?", 1)[0]
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/gateway.do", "", ""))


def _decode_alipay_response(resp: httpx.Response) -> str:
    raw = resp.content or b""
    ctype = (resp.headers.get("content-type") or "").lower()
    if any(enc in ctype for enc in ("gbk", "gb2312", "gb18030")):
        for enc in ("gb18030", "utf-8"):
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                continue
    for enc in ("utf-8", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


_gateway_http_client: Optional[httpx.AsyncClient] = None


def _get_gateway_http_client() -> httpx.AsyncClient:
    global _gateway_http_client
    if _gateway_http_client is None or _gateway_http_client.is_closed:
        _gateway_http_client = httpx.AsyncClient(
            follow_redirects=True,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10, keepalive_expiry=60.0),
        )
    return _gateway_http_client


async def _post_alipay_gateway(gateway: str, signed_params: Dict[str, Any], timeout_sec: float = 12.0) -> str:
    """
    按照支付宝官方 SDK 规范发送网关请求：
    公共请求参数（含 charset=utf-8 与 sign）放在 URL Query，biz_content 放在 UTF-8 POST Form Body，
    避免支付宝网关因 URL 缺少 charset 参数而按 GBK 解码中文 subject 导致验签失败或乱码。
    """
    gateway_base = _normalize_alipay_gateway_base(gateway)
    query_params = {k: v for k, v in signed_params.items() if k != "biz_content" and v is not None and v != ""}
    body_params = {}
    if signed_params.get("biz_content"):
        body_params["biz_content"] = signed_params["biz_content"]

    url = f"{gateway_base}?{urlencode(query_params)}"
    body_bytes = urlencode(body_params).encode("utf-8") if body_params else b""
    headers = {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "ChromiumSyncSaaS/1.0",
    }
    timeout = httpx.Timeout(connect=10.0, read=timeout_sec, write=10.0, pool=8.0)
    try:
        client = _get_gateway_http_client()
        resp = await client.post(url, content=body_bytes, headers=headers, timeout=timeout)
    except httpx.TimeoutException:
        raise RuntimeError(f"连接支付宝开放平台网关超时 ({gateway_base})，请检查服务器出站网络或网关地址配置")
    except httpx.RequestError as exc:
        raise RuntimeError(f"无法连接支付宝开放平台网关 ({gateway_base}): {exc}")

    if resp.status_code >= 500:
        raise RuntimeError(f"支付宝网关暂不可用 (HTTP {resp.status_code})，请稍后重试")
    return _decode_alipay_response(resp)


def _format_alipay_error(node: Dict[str, Any], default_prefix: str = "支付宝下单失败") -> str:
    code = str(node.get("code") or "").strip()
    sub_code = str(node.get("sub_code") or "").strip()
    sub_msg = str(node.get("sub_msg") or "").strip()
    msg = str(node.get("msg") or "").strip()
    parts = []
    if sub_msg:
        parts.append(sub_msg)
    elif msg:
        parts.append(msg)
    code_detail = "/".join(x for x in (code, sub_code) if x)
    if code_detail:
        parts.append(f"[{code_detail}]")
    if not parts:
        return f"{default_prefix}: 网关未返回有效响应"
    return f"{default_prefix}: {' '.join(parts)}"


def get_effective_alipay_public_key(cfg: Dict[str, Any]) -> str:
    sign_mode = (cfg.get("sign_mode") or "public_key").strip().lower()
    if sign_mode == "cert" and str(cfg.get("cert_public_key") or "").strip():
        return str(cfg.get("cert_public_key") or "").strip()
    return str(cfg.get("public_key") or "").strip() or str(cfg.get("cert_public_key") or "").strip()


def is_alipay_api_configured(cfg: Dict[str, Any]) -> bool:
    has_base = bool(str(cfg.get("app_id") or "").strip() and str(cfg.get("private_key") or "").strip())
    if not has_base:
        return False
    sign_mode = (cfg.get("sign_mode") or "public_key").strip().lower()
    if sign_mode == "cert":
        return bool(
            str(cfg.get("app_cert") or "").strip()
            and str(cfg.get("cert_public_key") or "").strip()
            and str(cfg.get("root_cert") or "").strip()
        )
    return bool(str(cfg.get("public_key") or "").strip())


def is_wechat_v3_configured(cfg: Dict[str, Any]) -> bool:
    return bool(
        str(cfg.get("app_id") or "").strip()
        and str(cfg.get("mch_id") or "").strip()
        and str(cfg.get("serial_no") or "").strip()
        and str(cfg.get("private_key") or "").strip()
        and len(str(cfg.get("api_v3_key") or "").strip().encode("utf-8")) == 32
    )


def _alipay_sign_content(params: Dict[str, Any], exclude_sign_type: bool = False) -> str:
    items = []
    for k in sorted(params.keys()):
        if k == "sign":
            continue
        if exclude_sign_type and k == "sign_type":
            continue
        v = params[k]
        if v is None or v == "":
            continue
        items.append(f"{k}={v}")
    return "&".join(items)


def _alipay_sign(params: Dict[str, Any], private_key_raw: str) -> str:
    priv = _load_rsa_private_key(private_key_raw)
    unsigned = _alipay_sign_content(params, exclude_sign_type=False)
    sig_bytes = priv.sign(unsigned.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256())
    return base64.b64encode(sig_bytes).decode("ascii")


def verify_alipay_notify_signature(params: Dict[str, Any], alipay_public_key_raw: str) -> bool:
    sign_b64 = str(params.get("sign") or "").strip()
    if not sign_b64 or not alipay_public_key_raw:
        return False
    pub = _load_rsa_public_key(alipay_public_key_raw)
    unsigned = _alipay_sign_content(params, exclude_sign_type=True)
    try:
        pub.verify(base64.b64decode(sign_b64), unsigned.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256())
        return True
    except InvalidSignature:
        return False
    except Exception:
        return False


def _verify_alipay_response_signature(raw_json_str: str, response_node_key: str, sign_b64: str, alipay_public_key_raw: str) -> bool:
    if not alipay_public_key_raw or not sign_b64:
        return True
    marker = f'"{response_node_key}":'
    idx = raw_json_str.find(marker)
    if idx < 0:
        return False
    start = raw_json_str.find("{", idx + len(marker))
    if start < 0:
        return False
    depth = 0
    in_str = False
    escaped = False
    end = -1
    for i in range(start, len(raw_json_str)):
        ch = raw_json_str[i]
        if escaped:
            escaped = False
            continue
        if ch == "\\" and in_str:
            escaped = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if not in_str:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
    if end <= start:
        return False
    content_to_verify = raw_json_str[start:end]
    pub = _load_rsa_public_key(alipay_public_key_raw)
    sig_bytes = base64.b64decode(sign_b64)
    candidates = [content_to_verify]
    if "\\/" in content_to_verify:
        candidates.append(content_to_verify.replace("\\/", "/"))
    for candidate in candidates:
        try:
            pub.verify(sig_bytes, candidate.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256())
            return True
        except Exception:
            continue
    return False


async def create_alipay_order(
    order_no: str,
    amount_yuan_str: str,
    subject: str,
    cfg: Dict[str, Any],
    base_url: str,
) -> Dict[str, Any]:
    mode = (cfg.get("mode") or "precreate").strip().lower()
    sign_mode = (cfg.get("sign_mode") or "public_key").strip().lower()
    app_id = str(cfg.get("app_id") or "").strip()
    priv_key = str(cfg.get("private_key") or "").strip()
    pub_key = get_effective_alipay_public_key(cfg)
    app_cert = str(cfg.get("app_cert") or "").strip()
    root_cert = str(cfg.get("root_cert") or "").strip()
    gateway = _normalize_alipay_gateway_base(str(cfg.get("gateway_url") or "https://openapi.alipay.com/gateway.do"))
    notify_url = str(cfg.get("notify_url") or "").strip() or f"{base_url}/api/billing/recharge/notify/alipay"
    return_url = str(cfg.get("return_url") or "").strip() or f"{base_url}/?tab=billing"
    static_qr = str(cfg.get("qr_url") or "").strip()

    if mode == "static_qr":
        if static_qr:
            return {
                "gateway_used": "alipay_static_qr",
                "pay_url": static_qr,
                "qr_code_text": static_qr,
                "persisted": True,
                "simulated": False,
                "message": "已创建支付宝充值订单，请使用手机支付宝扫码转账，付款后等待管理员核账入账",
            }
    elif app_id and priv_key:
        total_amount = f"{float(amount_yuan_str):.2f}"
        common_params: Dict[str, Any] = {
            "app_id": app_id,
            "charset": "utf-8",
            "format": "JSON",
            "sign_type": "RSA2",
            "timestamp": _now_cst_str(),
            "version": "1.0",
            "notify_url": notify_url,
        }
        if sign_mode == "cert":
            if not (app_cert and root_cert):
                raise RuntimeError("当前支付宝已选「证书模式」，请先在后台填写或上传应用公钥证书与支付宝根证书")
            app_sn = _get_alipay_cert_sn(app_cert)
            root_sn = _get_alipay_root_cert_sn(root_cert)
            if not app_sn or not root_sn:
                raise RuntimeError("支付宝应用公钥证书或根证书解析失败，请重新上传正确的 .crt 文件")
            common_params["app_cert_sn"] = app_sn
            common_params["alipay_root_cert_sn"] = root_sn
        if mode == "page_pay":
            common_params["method"] = "alipay.trade.page.pay"
            common_params["return_url"] = return_url
            common_params["biz_content"] = json.dumps(
                {
                    "out_trade_no": order_no,
                    "product_code": "FAST_INSTANT_TRADE_PAY",
                    "total_amount": total_amount,
                    "subject": subject[:128],
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            common_params["sign"] = _alipay_sign(common_params, priv_key)
            pay_url = f"{gateway}?{urlencode(common_params)}"
            return {
                "gateway_used": "alipay_page_pay",
                "pay_url": pay_url,
                "qr_code_text": "",
                "persisted": True,
                "simulated": False,
                "message": "已生成支付宝收银台支付链接，请点击跳转到支付宝完成付款",
            }

        # 当面付扫码 (alipay.trade.precreate：客户用手机扫网页生成的动态二维码)
        common_params["method"] = "alipay.trade.precreate"
        common_params["biz_content"] = json.dumps(
            {
                "out_trade_no": order_no,
                "total_amount": total_amount,
                "subject": subject[:128],
                "timeout_express": "15m",
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        common_params["sign"] = _alipay_sign(common_params, priv_key)
        raw_text = await _post_alipay_gateway(gateway, common_params, timeout_sec=18.0)
        try:
            data = json.loads(raw_text)
        except Exception:
            snippet = re.sub(r"\s+", " ", raw_text)[:180]
            raise RuntimeError(f"支付宝网关返回非 JSON 响应，请检查网关地址配置: {snippet}")

        if isinstance(data.get("error_response"), dict):
            raise RuntimeError(_format_alipay_error(data["error_response"], "支付宝当面付下单失败"))

        node_key = "alipay_trade_precreate_response"
        node = data.get(node_key) or {}
        if str(node.get("code") or "") != "10000" or not node.get("qr_code"):
            raise RuntimeError(_format_alipay_error(node, "支付宝当面付下单失败"))

        if pub_key and data.get("sign"):
            if not _verify_alipay_response_signature(raw_text, node_key, str(data["sign"]), pub_key):
                raise RuntimeError("支付宝网关响应 RSA2 验签失败，请检查支付宝公钥或公钥证书配置是否与开放平台一致")

        qr_code = str(node["qr_code"]).strip()
        return {
            "gateway_used": "alipay_precreate",
            "pay_url": qr_code,
            "qr_code_text": qr_code,
            "persisted": True,
            "simulated": False,
            "message": "已向支付宝发起当面付下单，请使用手机支付宝扫一扫支付",
        }

    fallback_uri = f"alipay://pay?order_no={order_no}&amount={float(amount_yuan_str):.2f}"
    return {
        "gateway_used": "sandbox_fallback",
        "pay_url": "",
        "qr_code_text": fallback_uri,
        "persisted": False,
        "simulated": True,
        "message": "已生成支付宝沙盒模拟订单（数据未落盘，不会修改数据库与真实余额）",
    }


async def query_alipay_order(order_no: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
    app_id = str(cfg.get("app_id") or "").strip()
    priv_key = str(cfg.get("private_key") or "").strip()
    pub_key = get_effective_alipay_public_key(cfg)
    sign_mode = (cfg.get("sign_mode") or "public_key").strip().lower()
    app_cert = str(cfg.get("app_cert") or "").strip()
    root_cert = str(cfg.get("root_cert") or "").strip()
    gateway = _normalize_alipay_gateway_base(str(cfg.get("gateway_url") or "https://openapi.alipay.com/gateway.do"))
    if not app_id or not priv_key:
        return {"supported": False, "paid": False}

    params: Dict[str, Any] = {
        "app_id": app_id,
        "method": "alipay.trade.query",
        "charset": "utf-8",
        "format": "JSON",
        "sign_type": "RSA2",
        "timestamp": _now_cst_str(),
        "version": "1.0",
        "biz_content": json.dumps({"out_trade_no": order_no}, separators=(",", ":")),
    }
    if sign_mode == "cert" and app_cert and root_cert:
        params["app_cert_sn"] = _get_alipay_cert_sn(app_cert)
        params["alipay_root_cert_sn"] = _get_alipay_root_cert_sn(root_cert)
    params["sign"] = _alipay_sign(params, priv_key)
    raw_text = await _post_alipay_gateway(gateway, params, timeout_sec=10.0)
    try:
        data = json.loads(raw_text)
    except Exception:
        raise RuntimeError("支付宝查单网关返回非 JSON 响应，请检查网关地址配置")
    if isinstance(data.get("error_response"), dict):
        raise RuntimeError(_format_alipay_error(data["error_response"], "支付宝查单失败"))
    node_key = "alipay_trade_query_response"
    node = data.get(node_key) or {}
    if pub_key and data.get("sign") and str(node.get("code") or "") == "10000":
        if not _verify_alipay_response_signature(raw_text, node_key, str(data["sign"]), pub_key):
            raise RuntimeError("支付宝查单响应 RSA2 验签失败，请检查支付宝公钥或公钥证书配置")
    trade_status = str(node.get("trade_status") or "")
    paid = str(node.get("code") or "") == "10000" and trade_status in {"TRADE_SUCCESS", "TRADE_FINISHED"}
    return {
        "supported": True,
        "paid": paid,
        "trade_status": trade_status,
        "trade_no": str(node.get("trade_no") or ""),
        "total_amount": str(node.get("total_amount") or ""),
        "sub_msg": str(node.get("sub_msg") or node.get("msg") or ""),
    }


def _wechat_authorization_header(
    method: str,
    url_path: str,
    body_str: str,
    mch_id: str,
    serial_no: str,
    private_key_raw: str,
) -> str:
    timestamp = str(int(datetime.now().timestamp()))
    nonce_str = secrets.token_hex(16)
    message = f"{method.upper()}\n{url_path}\n{timestamp}\n{nonce_str}\n{body_str}\n"
    priv = _load_rsa_private_key(private_key_raw)
    sig_bytes = priv.sign(message.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256())
    signature = base64.b64encode(sig_bytes).decode("ascii")
    return (
        f'WECHATPAY2-SHA256-RSA2048 mchid="{mch_id}",nonce_str="{nonce_str}",'
        f'timestamp="{timestamp}",serial_no="{serial_no}",signature="{signature}"'
    )


async def create_wechat_native_order(
    order_no: str,
    amount_units: int,
    description: str,
    cfg: Dict[str, Any],
    base_url: str,
) -> Dict[str, Any]:
    mode = (cfg.get("mode") or "native_v3").strip().lower()
    app_id = str(cfg.get("app_id") or "").strip()
    mch_id = str(cfg.get("mch_id") or "").strip()
    serial_no = str(cfg.get("serial_no") or "").strip()
    priv_key = str(cfg.get("private_key") or "").strip()
    gateway = str(cfg.get("gateway_url") or "https://api.mch.weixin.qq.com").strip().rstrip("/")
    notify_url = str(cfg.get("notify_url") or "").strip() or f"{base_url}/api/billing/recharge/notify/wechat"
    static_qr = str(cfg.get("qr_url") or "").strip()

    if mode == "static_qr":
        if static_qr:
            return {
                "gateway_used": "wechat_static_qr",
                "pay_url": static_qr,
                "qr_code_text": static_qr,
                "persisted": True,
                "simulated": False,
                "message": "已创建微信充值订单，请使用手机微信扫码转账，付款后等待管理员核账入账",
            }
    elif app_id and mch_id and serial_no and priv_key:
        url_path = "/v3/pay/transactions/native"
        total_fen = max(1, int(round(int(amount_units or 0) / 100)))
        payload = {
            "appid": app_id,
            "mchid": mch_id,
            "description": (description or "Chromium Sync SaaS 钱包充值")[:127],
            "out_trade_no": order_no,
            "notify_url": notify_url,
            "amount": {"total": total_fen, "currency": "CNY"},
        }
        body_str = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        auth_header = _wechat_authorization_header("POST", url_path, body_str, mch_id, serial_no, priv_key)
        headers = {
            "Authorization": auth_header,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "ChromiumSyncSaaS/1.0",
        }
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.post(f"{gateway}{url_path}", content=body_str.encode("utf-8"), headers=headers)
        if resp.status_code >= 400:
            try:
                err_data = resp.json()
                err_msg = err_data.get("message") or err_data.get("code") or resp.text
            except Exception:
                err_msg = resp.text
            raise RuntimeError(f"微信支付 V3 下单失败 ({resp.status_code}): {err_msg}")
        res_data = resp.json()
        code_url = str(res_data.get("code_url") or "").strip()
        if not code_url:
            raise RuntimeError("微信支付 V3 未返回 code_url")
        return {
            "gateway_used": "wechat_native_v3",
            "pay_url": code_url,
            "qr_code_text": code_url,
            "persisted": True,
            "simulated": False,
            "message": "已向微信支付 V3 发起 Native 下单，请打开微信扫一扫付款",
        }

    yuan_str = f"{int(amount_units or 0) / 10000:.2f}"
    fallback_uri = f"weixin://wxpay/bizpayurl?order_no={order_no}&amount={yuan_str}"
    return {
        "gateway_used": "sandbox_fallback",
        "pay_url": "",
        "qr_code_text": fallback_uri,
        "persisted": False,
        "simulated": True,
        "message": "已生成微信沙盒模拟订单（数据未落盘，不会修改数据库与真实余额）",
    }


async def query_wechat_order(order_no: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
    mch_id = str(cfg.get("mch_id") or "").strip()
    serial_no = str(cfg.get("serial_no") or "").strip()
    priv_key = str(cfg.get("private_key") or "").strip()
    gateway = str(cfg.get("gateway_url") or "https://api.mch.weixin.qq.com").strip().rstrip("/")
    if not mch_id or not serial_no or not priv_key:
        return {"supported": False, "paid": False}

    url_path = f"/v3/pay/transactions/out-trade-no/{order_no}?mchid={mch_id}"
    auth_header = _wechat_authorization_header("GET", url_path, "", mch_id, serial_no, priv_key)
    headers = {
        "Authorization": auth_header,
        "Accept": "application/json",
        "User-Agent": "ChromiumSyncSaaS/1.0",
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(f"{gateway}{url_path}", headers=headers)
    if resp.status_code >= 400:
        return {"supported": True, "paid": False, "trade_state": f"HTTP_{resp.status_code}"}
    data = resp.json()
    trade_state = str(data.get("trade_state") or "")
    amt = data.get("amount") or {}
    return {
        "supported": True,
        "paid": trade_state == "SUCCESS",
        "trade_state": trade_state,
        "trade_no": str(data.get("transaction_id") or ""),
        "total_fen": int(amt.get("total") or 0),
    }


def verify_and_decrypt_wechat_v3_notify(
    headers: Dict[str, str],
    raw_body: bytes,
    cfg: Dict[str, Any],
) -> Dict[str, Any]:
    api_v3_key = str(cfg.get("api_v3_key") or "").strip()
    if len(api_v3_key.encode("utf-8")) != 32:
        raise ValueError("系统未配置有效的 32 位微信 APIv3 密钥")

    platform_pub_raw = str(cfg.get("platform_public_key") or "").strip()
    if platform_pub_raw:
        ts = headers.get("wechatpay-timestamp") or headers.get("Wechatpay-Timestamp") or ""
        nonce = headers.get("wechatpay-nonce") or headers.get("Wechatpay-Nonce") or ""
        sig_b64 = headers.get("wechatpay-signature") or headers.get("Wechatpay-Signature") or ""
        if not ts or not nonce or not sig_b64:
            raise ValueError("缺少微信回调签名请求头")
        msg = f"{ts}\n{nonce}\n{raw_body.decode('utf-8')}\n"
        pub = _load_rsa_public_key(platform_pub_raw)
        try:
            pub.verify(base64.b64decode(sig_b64), msg.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256())
        except Exception as exc:
            raise ValueError(f"微信回调平台证书验签失败: {exc}")

    body_json = json.loads(raw_body.decode("utf-8"))
    resource = body_json.get("resource") or {}
    nonce = str(resource.get("nonce") or "").encode("utf-8")
    ciphertext = base64.b64decode(str(resource.get("ciphertext") or ""))
    aad = str(resource.get("associated_data") or "").encode("utf-8")
    aesgcm = AESGCM(api_v3_key.encode("utf-8"))
    plaintext = aesgcm.decrypt(nonce, ciphertext, aad)
    return json.loads(plaintext.decode("utf-8"))


def infer_base_url_from_request(request) -> str:
    scheme = request.headers.get("x-forwarded-proto") or urlparse(str(request.base_url)).scheme or "https"
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or urlparse(str(request.base_url)).netloc
    return f"{scheme}://{host}".rstrip("/")
