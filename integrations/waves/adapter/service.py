"""Two loopback HTTP listeners in one process. The core admin app is never run."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from aiohttp import web

from .paths import listener_ports, runtime_root
from .login import LoginManager
from .mutations import Mutations
from .security import (
    InvalidInput,
    SafeOperationError,
    bearer_valid,
    check_qq,
    check_request_id,
    check_scope,
    local_image,
)
from .storage import Store
from .tasks import TaskManager, TaskRecord

ROOT = runtime_root()


async def body(request):
    if request.content_type != "application/json":
        raise InvalidInput("JSON body required")
    try:
        value = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise InvalidInput("invalid JSON") from None
    if not isinstance(value, dict):
        raise InvalidInput("JSON object required")
    return value


def fields(data, allowed, required=()):
    if set(data) - set(allowed) or set(required) - set(data):
        raise InvalidInput("invalid request fields")


def boolean(value):
    if not isinstance(value, bool):
        raise InvalidInput("boolean required")
    return value


class WavesService:
    def __init__(self, root: Path, token: str, runtime, store: Store):
        if not token or len(token) < 32 or not token.isascii():
            raise ValueError("QBOT_WAVES_TOKEN must be a strong ASCII token")
        self.root, self.token, self.runtime, self.store = root, token, runtime, store
        (root / "inputs").mkdir(parents=True, exist_ok=True)
        (root / "results").mkdir(parents=True, exist_ok=True)
        self.tasks = TaskManager(root / "results", runtime.run)
        runtime.permitted = self.tasks.permitted
        self.login = LoginManager(
            store, runtime, self.tasks.permitted, runtime.bind_account
        )
        self.mutations = Mutations(self.tasks, self.unbind, self.sign)
        self.schedules = None

    async def unbind(self, sender):
        async with self.login.commit_lock:
            await self._unbind_locked(sender)

    async def _unbind_locked(self, sender):
        for record in self.tasks.tasks.values():
            if record.sender_qq == sender and record.status == "running":
                self.tasks.cancel(record.request_id)
        await self.runtime.unbind(sender, self.store)
        self.store.clear_account_activity(sender)
        if self.schedules:
            self.schedules.apply_policy()
        for login in list(self.login._by_id.values()):
            if login.sender_qq == sender:
                self.login.invalidate(login)

    async def sign(self, request_id, consent):
        self.runtime.validate_sign()
        record = TaskRecord(
            request_id,
            consent["key"],
            consent["senderQQ"],
            "__sign",
            consent["messageId"],
            [],
        )
        self.tasks.submit(record)

    def private_app(self):
        @web.middleware
        async def auth(request, handler):
            if not bearer_valid(request.headers.get("Authorization"), self.token):
                return web.json_response({"error": "unauthorized"}, status=401)
            try:
                await self.expire_policy()
                response = await handler(request)
            except InvalidInput as error:
                response = web.json_response({"error": str(error)}, status=400)
            except web.HTTPException as error:
                response = web.json_response(
                    {"error": "request denied"}, status=error.status
                )
            except Exception:
                response = web.json_response(
                    {"error": "Waves service operation failed"}, status=500
                )
            response.headers["Cache-Control"] = "no-store"
            return response

        app = web.Application(middlewares=[auth], client_max_size=65536)
        app.add_routes(
            [
                web.get("/v1/status", self.status),
                web.get("/v1/authorization", self.authorization_status),
                web.post("/v1/authorization", self.authorization_update),
                web.post("/v1/execute", self.execute),
                web.get("/v1/tasks/{request_id}", self.task),
                web.post("/v1/cancel", self.cancel),
                web.get("/v1/accounts", self.accounts),
                web.post("/v1/binding/delete", self.binding_delete),
                web.post("/v1/login/create", self.login_create),
                web.post("/v1/login/cancel", self.login_cancel),
                web.get("/v1/login/pending", self.login_pending),
                web.post("/v1/login/confirm", self.login_confirm),
                web.post("/v1/public-url", self.public_url),
                web.get("/v1/subscriptions", self.subscriptions),
                web.post("/v1/subscriptions", self.subscription_update),
                web.post("/v1/policy", self.policy),
                web.get("/v1/notices", self.notices),
                web.post("/v1/notices/ack", self.notice_ack),
                web.post("/v1/mutations/prepare", self.mutation_prepare),
                web.post("/v1/mutations/confirm", self.mutation_confirm),
            ]
        )
        return app

    async def expire_policy(self):
        async with self.login.commit_lock:
            if self.tasks.expire_policy():
                self.store.drop_notices_for_policy(set(), set(), True)
                self.login.apply_policy_locked()
                self.mutations.apply_policy()
                if self.schedules:
                    self.schedules.apply_policy()

    async def status(self, request):
        value = self.runtime.status()
        value.update(
            active=sum(
                record.status == "running" for record in self.tasks.tasks.values()
            ),
            publicLoginReady=bool(self.login.public_url and self.runtime.login_ready),
        )
        return web.json_response(value)

    async def execute(self, request):
        data = await body(request)
        fields(
            data,
            ("requestId", "key", "senderQQ", "messageId", "command", "images"),
            ("requestId", "key", "senderQQ", "messageId", "command"),
        )
        check_request_id(data["requestId"])
        check_scope(data["key"], data["senderQQ"])
        if (
            not isinstance(data["messageId"], str)
            or not data["messageId"]
            or len(data["messageId"]) > 128
        ):
            raise InvalidInput("invalid message ID")
        self.runtime.validate_command(data["command"])
        images = data.get("images", [])
        if not isinstance(images, list) or len(images) > 6:
            raise InvalidInput("invalid image list")
        paths = []
        for item in images:
            if not isinstance(item, dict) or set(item) != {"path"}:
                raise InvalidInput("only local image paths are accepted")
            paths.append(local_image(item["path"], self.root / "inputs")[0])
        record = TaskRecord(
            data["requestId"],
            data["key"],
            data["senderQQ"],
            data["command"],
            data["messageId"],
            paths,
        )
        self.tasks.submit(record)
        return web.json_response(
            {"requestId": record.request_id, "status": "running"}, status=202
        )

    async def task(self, request):
        request_id = check_request_id(request.match_info["request_id"])
        record = self.tasks.get(request_id)
        if not record:
            raise web.HTTPNotFound()
        return web.json_response(record.response())

    async def cancel(self, request):
        data = await body(request)
        fields(data, ("requestId",), ("requestId",))
        record = self.tasks.cancel(check_request_id(data["requestId"]))
        if not record:
            raise web.HTTPNotFound()
        return web.json_response(record.response())

    async def authorization_status(self, request):
        authorization = getattr(self.runtime, "authorization", None)
        if authorization is None:
            raise web.HTTPServiceUnavailable()
        return web.json_response(authorization.metadata())

    async def authorization_update(self, request):
        data = await body(request)
        fields(data, ("revision", "WavesToken", "xwtoken", "shared"), ("revision", "shared"))
        authorization = getattr(self.runtime, "authorization", None)
        if authorization is None:
            raise web.HTTPServiceUnavailable()
        if type(data["revision"]) is not int or data["revision"] < 0:
            raise InvalidInput("invalid authorization revision")
        for field in ("WavesToken", "xwtoken"):
            if field in data and (not isinstance(data[field], str) or not data[field]):
                raise InvalidInput("empty credentials must be omitted")
        if data["revision"] != authorization.revision:
            return web.json_response({"error": "authorization revision changed"}, status=409)
        result = authorization.update(
            WavesToken=data.get("WavesToken"),
            xwtoken=data.get("xwtoken"),
            shared=boolean(data["shared"]),
            expected_revision=data["revision"],
        )
        return web.json_response(result)

    async def accounts(self, request):
        return web.json_response({"accounts": self.store.list_accounts()})

    async def binding_delete(self, request):
        data = await body(request)
        fields(data, ("senderQQ",), ("senderQQ",))
        await self.unbind(check_qq(data["senderQQ"]))
        return web.json_response({"deleted": True})

    async def login_create(self, request):
        data = await body(request)
        fields(data, ("senderQQ", "key", "messageId"), ("senderQQ", "key", "messageId"))
        if not self.runtime.login_ready:
            raise InvalidInput("official login provider is unavailable")
        return web.json_response(
            await self.login.create(data["key"], data["senderQQ"], data["messageId"])
        )

    async def login_pending(self, request):
        return web.json_response(
            await self.login.pending(check_qq(request.query.get("senderQQ")))
        )

    async def login_cancel(self, request):
        data = await body(request)
        fields(data, ("requestId", "key", "senderQQ"), ("requestId", "key", "senderQQ"))
        check_scope(data["key"], data["senderQQ"])
        return web.json_response(
            await self.login.cancel(
                check_request_id(data["requestId"]), data["key"], data["senderQQ"]
            )
        )

    async def login_confirm(self, request):
        data = await body(request)
        fields(
            data,
            ("senderQQ", "requestId", "accept"),
            ("senderQQ", "requestId", "accept"),
        )
        return web.json_response(
            await self.login.confirm(
                check_qq(data["senderQQ"]),
                check_request_id(data["requestId"]),
                boolean(data["accept"]),
            )
        )

    async def public_url(self, request):
        data = await body(request)
        fields(data, ("url",), ("url",))
        changed = await self.login.set_public_url(data["url"])
        return web.json_response(
            {"ready": bool(self.login.public_url and self.runtime.login_ready), "changed": changed}
        )

    async def subscriptions(self, request):
        return web.json_response({"subscriptions": self.store.list_subscriptions()})

    async def subscription_update(self, request):
        data = await body(request)
        fields(
            data,
            ("senderQQ", "key", "signEnabled", "reminderEnabled", "threshold"),
            ("senderQQ", "key"),
        )
        check_scope(data["key"], data["senderQQ"])
        permitted = self.tasks.permitted(data["key"])
        if not permitted:
            changes = set(data) - {"senderQQ", "key"}
            if (
                not changes
                or changes - {"signEnabled", "reminderEnabled"}
                or any(data[name] is not False for name in changes)
                or not self.store.has_subscription(data["senderQQ"], data["key"])
            ):
                raise InvalidInput("only disabling an existing subscription is allowed")
        old = self.store.get_subscription(data["senderQQ"], data["key"])
        sign = boolean(data.get("signEnabled", old["signEnabled"]))
        reminder = boolean(data.get("reminderEnabled", old["reminderEnabled"]))
        threshold = data.get("threshold", old["threshold"])
        if (
            not isinstance(threshold, int)
            or isinstance(threshold, bool)
            or not 120 <= threshold <= 240
        ):
            raise InvalidInput("threshold must be 120 to 240")
        if permitted and (sign or reminder) and not self.store.get_account(data["senderQQ"]):
            raise InvalidInput("own confirmed binding required")
        result = self.store.set_subscription(
            data["senderQQ"], data["key"], sign, reminder, threshold
        )
        if self.schedules:
            self.schedules.apply_policy()
        return web.json_response(result)

    async def policy(self, request):
        data = await body(request)
        fields(
            data,
            ("allowedKeys", "pausedKeys", "globalPaused"),
            ("allowedKeys", "pausedKeys", "globalPaused"),
        )
        for values in (data["allowedKeys"], data["pausedKeys"]):
            if not isinstance(values, list) or len(values) > 10000:
                raise InvalidInput("invalid policy keys")
            for key in values:
                if not isinstance(key, str) or ":" not in key:
                    raise InvalidInput("invalid policy key")
                check_scope(key, key.split(":", 1)[1])
        async with self.login.commit_lock:
            self._apply_policy(data)
        return web.json_response({"applied": True})

    def _apply_policy(self, data):
        self.tasks.set_policy(
            set(data["allowedKeys"]),
            set(data["pausedKeys"]),
            boolean(data["globalPaused"]),
        )
        self.store.drop_notices_for_policy(
            self.tasks.allowed_keys, self.tasks.paused_keys, self.tasks.global_paused
        )
        self.login.apply_policy_locked()
        self.mutations.apply_policy()
        if self.schedules:
            self.schedules.apply_policy()

    async def notices(self, request):
        self.store.drop_notices_for_policy(
            self.tasks.allowed_keys, self.tasks.paused_keys, self.tasks.global_paused
        )
        return web.json_response({"notices": self.store.pending_notices()})

    async def notice_ack(self, request):
        data = await body(request)
        fields(data, ("id", "sent"), ("id", "sent"))
        return web.json_response(
            {
                "acknowledged": self.store.ack_notice(
                    check_request_id(data["id"]), boolean(data["sent"])
                )
            }
        )

    async def mutation_prepare(self, request):
        data = await body(request)
        fields(
            data,
            ("senderQQ", "key", "messageId", "action"),
            ("senderQQ", "key", "messageId", "action"),
        )
        return web.json_response(
            self.mutations.prepare(
                data["key"], data["senderQQ"], data["messageId"], data["action"]
            )
        )

    async def mutation_confirm(self, request):
        data = await body(request)
        fields(
            data,
            ("senderQQ", "requestId", "accept"),
            ("senderQQ", "requestId", "accept"),
        )
        return web.json_response(
            await self.mutations.confirm(
                data["senderQQ"],
                check_request_id(data["requestId"]),
                boolean(data["accept"]),
            )
        )

    def public_app(self):
        @web.middleware
        async def boundary(request, handler):
            try:
                if request.method == "POST":
                    origin = request.headers.get("Origin")
                    if origin and origin != self.login.public_url:
                        raise InvalidInput("origin denied")
                response = await handler(request)
            except SafeOperationError as error:
                response = web.json_response({"error": str(error)}, status=error.http_status)
            except (InvalidInput, web.HTTPException) as error:
                response = web.json_response(
                    {
                        "error": "登录链接无效、已过期或本次请求失败，请返回 QQ 重新发起。"
                    },
                    status=error.status
                    if isinstance(error, web.HTTPException)
                    else 400,
                )
            except Exception:
                response = web.json_response(
                    {"error": "官方登录请求未完成，请稍后重新发起。"}, status=502
                )
            response.headers.update(
                {
                    "Cache-Control": "no-store",
                    "Referrer-Policy": "no-referrer",
                    "X-Content-Type-Options": "nosniff",
                    "X-Frame-Options": "DENY",
                    "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline' https://static.geetest.com https://*.geetest.com; style-src 'unsafe-inline' https://*.geetest.com; img-src data: https://*.geetest.com; connect-src 'self' https://*.geetest.com; frame-src https://*.geetest.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
                }
            )
            return response

        app = web.Application(middlewares=[boundary], client_max_size=16384)
        app.add_routes(
            [
                web.get("/l/{ticket}", self.form),
                web.get("/l/{ticket}/status", self.login_status),
                web.post("/l/{ticket}/sms", self.sms),
                web.post("/l/{ticket}/verify", self.verify),
            ]
        )
        return app

    async def form(self, request):
        await self.login.by_ticket(request.match_info["ticket"])
        html = (Path(__file__).parent / "login.html").read_text(encoding="utf-8")
        return web.Response(text=html, content_type="text/html")

    async def login_status(self, request):
        login = await self.login.by_ticket(request.match_info["ticket"])
        return web.json_response(login.overview())

    async def sms(self, request):
        data = await body(request)
        fields(data, ("phone", "captcha"), ("phone", "captcha"))
        result = await self.login.request_sms(
            request.match_info["ticket"], data["phone"], data["captcha"]
        )
        return web.json_response(result)

    async def verify(self, request):
        data = await body(request)
        fields(data, ("code",), ("code",))
        result = await self.login.verify_sms(request.match_info["ticket"], data["code"])
        return web.json_response(result)


async def main():
    from .native import NativeRuntime
    from .scheduling import Schedules

    rpc_port, login_port = listener_ports()
    token = os.environ.get("QBOT_WAVES_TOKEN", "")
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(ROOT / "browsers"))
    os.chdir(ROOT / "core")
    store = Store(ROOT / "data/adapter.db")
    runtime = NativeRuntime(ROOT)
    service = WavesService(ROOT, token, runtime, store)
    runners = []
    for port, app in ((rpc_port, service.private_app()), (login_port, service.public_app())):
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", port).start()
        runners.append(runner)
    try:
        await runtime.initialize()
        from gsuid_core.utils.database import base_models as database

        store.use_native_accounts(Path(database.engine.url.database))
        service.schedules = Schedules(service)
        await service.schedules.run_forever()
    finally:
        for record in service.tasks.tasks.values():
            service.tasks.cancel(record.request_id)
        if service.schedules:
            await service.schedules.close()
        await runtime.close()
        for runner in runners:
            await runner.cleanup()
        store.close()


if __name__ == "__main__":
    asyncio.run(main())
