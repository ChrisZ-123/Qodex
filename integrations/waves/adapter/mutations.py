"""Short lived consent records; the original QQ and scope remain attached."""

from __future__ import annotations

import secrets
import time

from .login import iso_time
from .security import InvalidInput, check_qq, check_scope


class Mutations:
    def __init__(self, tasks, unbind, sign):
        self.tasks = tasks
        self.unbind = unbind
        self.sign = sign
        self.pending = {}

    def prepare(self, key, sender_qq, message_id, action):
        check_scope(key, sender_qq)
        if not self.tasks.permitted(key):
            raise InvalidInput("conversation is paused or not allowed")
        if action not in ("sign", "unbind"):
            raise InvalidInput("unsupported mutation")
        if not isinstance(message_id, str) or not message_id or len(message_id) > 128:
            raise InvalidInput("invalid source message")
        request_id = "mutation-" + secrets.token_urlsafe(18)
        self.pending[request_id] = {
            "senderQQ": sender_qq,
            "key": key,
            "messageId": message_id,
            "action": action,
            "expiresAt": time.time() + 180,
        }
        return {
            "requestId": request_id,
            "action": action,
            "expiresAt": iso_time(self.pending[request_id]["expiresAt"]),
        }

    async def confirm(self, sender_qq, request_id, accept):
        check_qq(sender_qq)
        consent = self.pending.get(request_id)
        if not consent or consent["senderQQ"] != sender_qq:
            raise InvalidInput("mutation not found for sender")
        if consent["expiresAt"] <= time.time() or not self.tasks.permitted(
            consent["key"]
        ):
            self.pending.pop(request_id)
            raise InvalidInput("mutation expired or conversation paused")
        self.pending.pop(request_id)
        if not accept:
            return {"requestId": request_id, "status": "rejected"}
        if consent["action"] == "unbind":
            await self.unbind(sender_qq)
            return {"requestId": request_id, "status": "completed"}
        await self.sign(request_id, consent)
        return {"requestId": request_id, "status": "running"}

    def apply_policy(self):
        for request_id, consent in list(self.pending.items()):
            if not self.tasks.permitted(consent["key"]):
                self.pending.pop(request_id)
