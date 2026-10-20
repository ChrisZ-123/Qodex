"""Input boundaries shared by the private RPC and public login listener."""

from __future__ import annotations

import hmac
import mimetypes
import re
from pathlib import Path
from urllib.parse import urlsplit

QQ_RE = re.compile(r"^[1-9][0-9]{4,14}$")
GROUP_RE = re.compile(r"^group:([1-9][0-9]{4,14})$")
PRIVATE_RE = re.compile(r"^private:([1-9][0-9]{4,14})$")
REQUEST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
PHONE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
TOKEN_RE = re.compile(r"(?i)(?:token|cookie|ck|authorization)\s*[:=]\s*[^\s,;]+")
MIME_TYPES = {"image/png", "image/jpeg", "image/webp"}


class InvalidInput(ValueError):
    pass


class SafeOperationError(InvalidInput):
    """Only adapter-owned fixed messages may cross task and public boundaries."""

    STAGES = {
        "sms": "官方短信发送失败",
        "login": "官方验证码登录失败",
        "roles": "官方角色查询失败",
        "bat": "鸣潮数据令牌获取失败",
        "official": "官方请求失败",
    }
    REASONS = {
        "http_400": "HTTP 400，官方拒绝请求",
        "http_401": "HTTP 401，官方拒绝登录授权",
        "http_403": "HTTP 403，官方拒绝访问",
        "http_429": "HTTP 429，请稍后重试",
        "http_server": "官方服务器暂时不可用",
        "http_error": "官方 HTTP 请求未成功",
        "code_102": "官方业务码 102，服务器外部错误",
        "code_130": "官方业务码 130，验证码错误",
        "code_132": "官方业务码 132，验证码已过期",
        "code_220": "官方业务码 220，登录已过期",
        "code_270": "官方业务码 270，当前网络环境被拒绝",
        "code_999": "官方业务码 999，服务暂时不可用",
        "code_1000": "官方业务码 1000，角色查询失败",
        "code_10903": "官方业务码 10903，数据令牌已失效",
        "business_rejected": "官方业务请求被拒绝",
        "timeout": "请求超时，请稍后重试",
        "network": "网络连接失败，请稍后重试",
        "invalid_response": "官方响应格式无效",
        "missing_credential": "官方响应未提供有效票据",
        "missing_role": "未找到可用的国服鸣潮角色",
        "credential_incomplete": "本人登录凭据不完整或已过期，请重新登录",
        "account_changed": "本人登录账户已变更，请重新发起查询",
        "request_failed": "请求未完成，请稍后重试",
    }

    def __init__(self, stage: str, reason: str):
        self.stage = stage
        self.reason = reason
        self.http_status = 504 if reason == "timeout" else 400 if reason.startswith("code_") or reason in {"business_rejected", "missing_role", "credential_incomplete", "account_changed"} else 502
        super().__init__(f"{self.STAGES[stage]}：{self.REASONS[reason]}")


def check_qq(value: str) -> str:
    if not isinstance(value, str) or not QQ_RE.fullmatch(value):
        raise InvalidInput("invalid QQ identity")
    return value


def check_scope(key: str, sender_qq: str) -> tuple[str, str]:
    check_qq(sender_qq)
    if not isinstance(key, str):
        raise InvalidInput("invalid conversation scope")
    match = GROUP_RE.fullmatch(key)
    if match:
        return "group", match.group(1)
    match = PRIVATE_RE.fullmatch(key)
    if match and match.group(1) == sender_qq:
        return "private", sender_qq
    raise InvalidInput("invalid conversation scope")


def check_request_id(value: str) -> str:
    if (
        not isinstance(value, str)
        or not REQUEST_RE.fullmatch(value)
        or value.endswith(".")
        or value.split(".", 1)[0].upper()
        in {
            "CON",
            "PRN",
            "AUX",
            "NUL",
            *(f"COM{i}" for i in range(1, 10)),
            *(f"LPT{i}" for i in range(1, 10)),
        }
    ):
        raise InvalidInput("invalid request ID")
    return value


def bearer_valid(header: str | None, expected: str) -> bool:
    if not header or not header.startswith("Bearer "):
        return False
    received = header[7:]
    return bool(received) and hmac.compare_digest(received, expected)


def validate_public_url(raw: str) -> str:
    if not isinstance(raw, str):
        raise InvalidInput("invalid tunnel URL")
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        raise InvalidInput("invalid tunnel URL") from None
    if (
        parts.scheme != "https"
        or not parts.hostname
        or not parts.hostname.lower().endswith(".trycloudflare.com")
        or parts.hostname.lower() == "trycloudflare.com"
        or parts.username is not None
        or parts.password is not None
        or port is not None
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
    ):
        raise InvalidInput("invalid tunnel URL")
    host = parts.hostname.lower()
    if not re.fullmatch(
        r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.trycloudflare\.com",
        host,
    ):
        raise InvalidInput("invalid tunnel URL")
    return f"https://{host}"


def local_image(path: str, root: Path) -> tuple[Path, str]:
    if not isinstance(path, str) or not path:
        raise InvalidInput("invalid image path")
    candidate = Path(path)
    if not candidate.is_absolute():
        raise InvalidInput("image path must be absolute")
    root = root.resolve(strict=True)
    try:
        candidate = candidate.resolve(strict=True)
        candidate.relative_to(root)
    except (OSError, ValueError):
        raise InvalidInput("image outside input directory") from None
    if not candidate.is_file() or candidate.stat().st_size > 20 * 1024 * 1024:
        raise InvalidInput("invalid image asset")
    mime, _ = mimetypes.guess_type(candidate.name)
    if mime not in MIME_TYPES:
        raise InvalidInput("unsupported image type")
    data = candidate.read_bytes()
    if not image_signature(data, mime):
        raise InvalidInput("invalid image content")
    return candidate, mime


def image_signature(data: bytes, mime: str) -> bool:
    return {
        "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg": data.startswith(b"\xff\xd8\xff"),
        "image/webp": data.startswith(b"RIFF") and data[8:12] == b"WEBP",
    }.get(mime, False)


def sanitize_text(value: object) -> str:
    text = str(value)
    text = PHONE_RE.sub("[phone redacted]", text)
    text = TOKEN_RE.sub("[credential redacted]", text)
    return text[:20000]
