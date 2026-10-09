"""Short-lived, single-account SMS login tickets for the public listener."""

from __future__ import annotations

import asyncio
import re
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from datetime import datetime, timezone
from typing import Protocol

from .security import InvalidInput, check_scope, validate_public_url
from .storage import Store

PHONE = re.compile(r"^1[3-9][0-9]{9}$")
SMS_CODE = re.compile(r"^[0-9]{4,8}$")


def iso_time(timestamp: float) -> str:
    return (
        datetime.fromtimestamp(timestamp, timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


class LoginProvider(Protocol):
    async def request_sms(self, phone: str, captcha: dict) -> None: ...
    async def verify_sms(self, phone: str, code: str) -> tuple[str, str, str]: ...


@dataclass
class LoginTicket:
    request_id: str
    ticket: str
    sender_qq: str
    source_key: str
    source_message_id: str
    expires_at: float
    phone_encrypted: bytes | None = None
    credential_encrypted: bytes | None = None
    uid: str | None = None
    nickname: str | None = None
    status: str = "pending"
    requests: int = 0
    sms_attempts: int = 0
    verify_attempts: int = 0
    lock: asyncio.Lock = dataclass_field(default_factory=asyncio.Lock)

    def overview(self) -> dict:
        data = {
            "requestId": self.request_id,
            "status": self.status,
            "expiresAt": iso_time(self.expires_at),
        }
        if self.uid and self.nickname:
            data["account"] = {"uid": self.uid, "nickname": self.nickname}
        return data


class LoginManager:
    def __init__(
        self,
        store: Store,
        provider: LoginProvider,
        permitted: Callable[[str], bool] | None = None,
        on_bind: Callable[..., Awaitable[None]] | None = None,
    ) -> None:
        self.store = store
        self.provider = provider
        self.public_url: str | None = None
        self._by_ticket: dict[str, LoginTicket] = {}
        self._by_id: dict[str, LoginTicket] = {}
        self.permitted = permitted or (lambda key: True)
        self.on_bind = on_bind
        # Commit and all consent invalidations have one explicit ordering.
        # A revocation arriving during commit waits and takes effect afterwards.
        self.commit_lock = asyncio.Lock()

    async def set_public_url(self, raw_url: str | None) -> bool:
        url = None if raw_url is None else validate_public_url(raw_url)
        async with self.commit_lock:
            changed = url != self.public_url
            if changed:
                for login in list(self._by_id.values()):
                    self.invalidate(login)
                self.public_url = url
            return changed

    async def create(self, key: str, sender_qq: str, message_id: str) -> dict:
        async with self.commit_lock:
            return self._create(key, sender_qq, message_id)

    def _create(self, key: str, sender_qq: str, message_id: str) -> dict:
        check_scope(key, sender_qq)
        if not self.permitted(key):
            raise InvalidInput("conversation is paused or not allowed")
        if not self.public_url:
            raise InvalidInput("public login is unavailable")
        if not isinstance(message_id, str) or not message_id or len(message_id) > 128:
            raise InvalidInput("invalid source message")
        for old in list(self._by_id.values()):
            if old.sender_qq == sender_qq:
                self.invalidate(old)
        ticket = secrets.token_urlsafe(32)
        request_id = "login-" + secrets.token_urlsafe(18)
        login = LoginTicket(
            request_id, ticket, sender_qq, key, message_id, time.time() + 180
        )
        self._by_id[request_id] = login
        self._by_ticket[ticket] = login
        return {
            "requestId": request_id,
            "expiresAt": iso_time(login.expires_at),
            "url": f"{self.public_url}/l/{ticket}",
        }

    def _active(self, login: LoginTicket) -> LoginTicket:
        if self._by_id.get(login.request_id) is not login or not self.permitted(
            login.source_key
        ):
            login.phone_encrypted = None
            login.credential_encrypted = None
            raise InvalidInput("login session invalidated")
        if time.time() >= login.expires_at:
            login.status = "expired"
            login.phone_encrypted = None
            login.credential_encrypted = None
            raise InvalidInput("login expired")
        return login

    async def by_ticket(self, ticket: str) -> LoginTicket:
        async with self.commit_lock:
            return self._by_ticket_checked(ticket)

    def _by_ticket_checked(self, ticket: str) -> LoginTicket:
        login = self._by_ticket.get(ticket)
        if login is None:
            raise InvalidInput("invalid login")
        self._active(login)
        login.requests += 1
        if login.requests > 100:
            login.status = "expired"
            login.credential_encrypted = None
            login.phone_encrypted = None
            raise InvalidInput("login request limit reached")
        return login

    async def request_sms(self, ticket: str, phone: str, captcha: dict) -> None:
        login = await self.by_ticket(ticket)
        async with login.lock:
            self._active(login)
            if (
                login.status not in ("pending", "sms_sent")
                or not isinstance(phone, str)
                or not PHONE.fullmatch(phone)
            ):
                raise InvalidInput("login request denied")
            login.sms_attempts += 1
            if login.sms_attempts > 2:
                raise InvalidInput("SMS request limit reached")
            await self.provider.request_sms(phone, captcha)
            self._active(login)
            login.phone_encrypted = self.store.dpapi.encrypt(phone)
            login.status = "sms_sent"

    async def verify_sms(self, ticket: str, code: str) -> dict:
        login = await self.by_ticket(ticket)
        async with login.lock:
            self._active(login)
            if (
                login.status != "sms_sent"
                or not login.phone_encrypted
                or not isinstance(code, str)
                or not SMS_CODE.fullmatch(code)
            ):
                raise InvalidInput("login verification denied")
            login.verify_attempts += 1
            if login.verify_attempts > 5:
                raise InvalidInput("verification request limit reached")
            phone = self.store.dpapi.decrypt(login.phone_encrypted)
            uid, nickname, credential = await self.provider.verify_sms(phone, code)
            self._active(login)
            login.phone_encrypted = None
            login.credential_encrypted = self.store.dpapi.encrypt(credential)
            login.uid = str(uid)
            login.nickname = str(nickname)[:100]
            login.status = "awaiting_confirmation"
            return login.overview()

    async def pending(self, sender_qq: str) -> dict:
        async with self.commit_lock:
            return self._pending(sender_qq)

    def _pending(self, sender_qq: str) -> dict:
        for login in self._by_id.values():
            if login.sender_qq == sender_qq:
                try:
                    self._active(login)
                except InvalidInput:
                    pass
                return login.overview()
        return {"status": "none"}

    async def confirm(self, sender_qq: str, request_id: str, accept: bool) -> dict:
        login = self._by_id.get(request_id)
        if login is None or login.sender_qq != sender_qq:
            raise InvalidInput("login not found for sender")
        async with login.lock, self.commit_lock:
            self._active(login)
            if login.status != "awaiting_confirmation":
                raise InvalidInput("login is not awaiting confirmation")
            if accept:
                if (
                    not login.credential_encrypted
                    or not login.uid
                    or not login.nickname
                ):
                    raise InvalidInput("login has no verified credential")
                credential = self.store.dpapi.decrypt(login.credential_encrypted)
                if self.on_bind:
                    await self.on_bind(
                        login, credential, self.store, lambda: self._active(login)
                    )
                else:
                    self.store.bind(sender_qq, login.uid, login.nickname, credential)
                login.status = "confirmed"
            else:
                login.status = "rejected"
            login.credential_encrypted = None
            login.phone_encrypted = None
            self._by_ticket.pop(login.ticket, None)
            self._by_id.pop(login.request_id, None)
            return {
                "requestId": request_id,
                "status": login.status,
                "account": {"uid": login.uid, "nickname": login.nickname},
            }

    def invalidate(self, login: LoginTicket) -> None:
        login.credential_encrypted = None
        login.phone_encrypted = None
        self._by_id.pop(login.request_id, None)
        self._by_ticket.pop(login.ticket, None)

    def apply_policy_locked(self) -> None:
        """Caller holds commit_lock while updating the authoritative policy."""
        for login in list(self._by_id.values()):
            if not self.permitted(login.source_key):
                self.invalidate(login)

    async def apply_policy(self) -> None:
        async with self.commit_lock:
            self.apply_policy_locked()
