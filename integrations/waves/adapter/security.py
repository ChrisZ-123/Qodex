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
