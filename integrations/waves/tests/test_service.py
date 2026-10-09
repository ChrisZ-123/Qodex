import asyncio
import secrets
import subprocess
import sys
import time
from pathlib import Path

import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer
from sqlalchemy import Integer, create_engine, select, update
from sqlalchemy.orm import DeclarativeBase, Session, mapped_column

from adapter.encrypted_column import EncryptedToken
from adapter.scheduling import Schedules
from adapter.security import (
    InvalidInput,
    check_request_id,
    check_scope,
    validate_public_url,
)
from adapter.service import WavesService
from adapter.storage import CredentialError, Store

PNG = b"\x89PNG\r\n\x1a\n" + b"fixture-png"
SENDER = "12345"
SCOPE = "group:67890"


class Runtime:
    login_ready = True
    sign_time = (8, 0)

    def __init__(self):
        self.gate = asyncio.Event()
        self.sign_count = self.bind_count = 0

    def status(self):
        return {"ready": True, "capabilities": [], "versions": {}, "commands": []}

    def validate_command(self, command):
        if command not in ("ww帮助", "ww慢", "ww失败"):
            raise InvalidInput("outside catalog")

    def validate_sign(self):
        pass

    async def bind_account(self, login, credential, store, validate):
        validate()
        store.bind(login.sender_qq, login.uid, login.nickname, credential)
        self.bind_count += 1

    async def unbind(self, sender, store):
        store.unbind(sender)

    async def request_sms(self, phone, captcha):
        pass

    async def verify_sms(self, phone, code):
        return "123456789", "测试玩家", "fixture-credential"

    async def run(self, record, sink):
        if record.command == "ww失败":
            raise RuntimeError("fixture error")
        if record.command == "__sign":
            self.sign_count += 1
            sink.text("模拟签到完成")
            return
        sink.text("进度 " + record.sender_qq)
        if record.command == "ww慢":
            try:
                await self.gate.wait()
            except asyncio.CancelledError:
                sink.text("late output")
                raise RuntimeError("late failure after cancellation")
        sink.image(PNG, "image/png")
        await asyncio.sleep(0)
        sink.text("完成 " + record.sender_qq)
        sink.image(PNG, "image/png")

    async def reminder(self, subscription, now):
        return "模拟体力达到阈值"


@pytest_asyncio.fixture
async def service(tmp_path):
    store = Store(tmp_path / "adapter.db")
    runtime = Runtime()
    service = WavesService(
        tmp_path, "fixture-only-rpc-token-for-test-suite", runtime, store
    )
    client = TestClient(TestServer(service.private_app()))
    client.session.headers["Authorization"] = (
        "Bearer fixture-only-rpc-token-for-test-suite"
    )
    await client.start_server()
    await client.post(
        "/v1/policy",
        json={"allowedKeys": [SCOPE], "pausedKeys": [], "globalPaused": False},
    )
    yield service, client
    for task in service.tasks.tasks.values():
        service.tasks.cancel(task.request_id)
    await asyncio.gather(
        *(task.job for task in service.tasks.tasks.values()), return_exceptions=True
    )
    await client.close()
    store.close()


def request(request_id="request-1", sender=SENDER, command="ww帮助"):
    return {
        "requestId": request_id,
        "key": SCOPE,
        "senderQQ": sender,
        "messageId": "real-message",
        "command": command,
        "images": [],
    }


async def completed(service, request_id):
    await service.tasks.get(request_id).job
    return service.tasks.get(request_id).response()


@pytest.mark.asyncio
async def test_true_completion_multi_output_two_callers(service):
    service, client = service
    await client.post("/v1/execute", json=request(command="ww慢"))
    await asyncio.sleep(0)
    response = await (await client.get("/v1/tasks/request-1")).json()
    assert response["status"] == "running"
    assert len(response["outputs"]) == 1
    await client.post("/v1/execute", json=request("request-2", "54321"))
    other = await completed(service, "request-2")
    assert other["status"] == "completed"
    assert len(other["outputs"]) == 4
    service.runtime.gate.set()
    first = await completed(service, "request-1")
    assert len(first["outputs"]) == 4
    for response in (first, other):
        for output in response["outputs"]:
            if output["type"] == "image":
                assert Path(output["path"]).parent.name == response["requestId"]
                assert Path(output["path"]).is_file()


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["pause", "cancel", "expire"])
async def test_cancel_suppresses_late_output_and_late_error(service, action):
    service, client = service
    await client.post("/v1/execute", json=request(command="ww慢"))
    await asyncio.sleep(0)
    if action == "pause":
        await client.post(
            "/v1/policy",
            json={"allowedKeys": [SCOPE], "pausedKeys": [SCOPE], "globalPaused": False},
        )
    elif action == "expire":
        service.tasks.policy_expires = time.monotonic() - 1
        await client.get("/v1/status")
    else:
        await client.post("/v1/cancel", json={"requestId": "request-1"})
    record = await completed(service, "request-1")
    assert record["status"] == "cancelled"
    assert not record["outputs"]


@pytest.mark.asyncio
async def test_survive_plugin_error(service):
    service, client = service
    await client.post("/v1/execute", json=request(command="ww失败"))
    assert (await completed(service, "request-1"))["status"] == "failed"
    await client.post("/v1/execute", json=request("request-2"))
    assert (await completed(service, "request-2"))["status"] == "completed"


@pytest.mark.asyncio
async def test_auth_identity_privilege_catalog_and_media(service, tmp_path):
    service, client = service
    response = await client.get("/v1/status", headers={"Authorization": "invalid"})
    assert response.status == 401
    for data in [
        dict(request(), user_pm=1),
        dict(request(), senderQQ="oops"),
        dict(request(), key="private:54321"),
        dict(request(), command="core安装插件"),
        dict(request(), command="ww获取token"),
    ]:
        assert (await client.post("/v1/execute", json=data)).status == 400
    outside = tmp_path / "outside.png"
    outside.write_bytes(PNG)
    assert (
        await client.post(
            "/v1/execute", json=dict(request(), images=[{"path": str(outside)}])
        )
    ).status == 400
    bad = service.root / "inputs" / "fake.png"
    bad.write_text("not image", encoding="utf-8")
    assert (
        await client.post(
            "/v1/execute", json=dict(request(), images=[{"path": str(bad)}])
        )
    ).status == 400


def test_path_ids_and_scope_validation():
    for value in ("..", "CON", "../parent", "a:b", "a."):
        with pytest.raises(InvalidInput):
            check_request_id(value)
    with pytest.raises(InvalidInput):
        check_scope("private:54321", SENDER)
    for value in (
        "http://example.trycloudflare.com",
        "https://evil.trycloudflare.com.evil",
        "https://user:pass@example.trycloudflare.com",
        "https://example.trycloudflare.com:443",
        "https://example.trycloudflare.com:broken",
    ):
        with pytest.raises(InvalidInput):
            validate_public_url(value)


def test_dpapi_restart_and_no_plaintext(tmp_path):
    path = tmp_path / "adapter.db"
    secret = secrets.token_urlsafe(40)
    store = Store(path)
    store.bind(SENDER, "123456789", "测试", secret)
    store.close()
    raw_has_secret = secret.encode() in path.read_bytes()
    assert not raw_has_secret
    reopened = Store(path)
    equal = reopened.get_account(SENDER)["credential"] == secret
    assert equal
    reopened.close()
    script = "from pathlib import Path; from adapter.storage import Store; s=Store(Path(__import__('sys').argv[1])); print(bool(s.get_account('12345')['credential'])); s.close()"
    reply = subprocess.run(
        [sys.executable, "-c", script, str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    assert reply.stdout.strip() == "True"


def test_real_sql_equal_insert_update_and_restart(tmp_path):
    class Base(DeclarativeBase):
        pass

    class Account(Base):
        __tablename__ = "encrypted_accounts"
        id = mapped_column(Integer, primary_key=True)
        token = mapped_column(EncryptedToken())

    path = tmp_path / "native.db"
    engine = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(engine)
    secret = secrets.token_urlsafe(40)
    replacement = secrets.token_urlsafe(40)
    with Session(engine) as session:
        session.add(Account(id=1, token=secret))
        session.commit()
        found = session.scalar(select(Account).where(Account.token == secret))
        equal = found is not None and found.token == secret
        assert equal
        session.execute(
            update(Account).where(Account.token == secret).values(token=replacement)
        )
        session.commit()
    engine.dispose()
    engine = create_engine(f"sqlite:///{path}")
    with Session(engine) as session:
        found = session.scalar(select(Account).where(Account.token.in_([replacement])))
        equal = found is not None and found.token == replacement
        assert equal
    raw_has_secret = (
        secret.encode() in path.read_bytes()
        or replacement.encode() in path.read_bytes()
    )
    assert not raw_has_secret
    engine.dispose()


@pytest.mark.asyncio
async def test_login_expiry_wrong_qq_confirmation_url_change(service):
    service, client = service
    await service.login.set_public_url("https://fixture.trycloudflare.com")
    created = await service.login.create(SCOPE, SENDER, "real-message")
    ticket = service.login._by_id[created["requestId"]].ticket
    await service.login.request_sms(ticket, "13800138000", {})
    await service.login.verify_sms(ticket, "123456")
    overview = await service.login.pending(SENDER)
    assert overview["status"] == "awaiting_confirmation"
    assert set(overview["account"]) == {"uid", "nickname"}
    assert not service.store.list_accounts()
    with pytest.raises(InvalidInput):
        await service.login.confirm("54321", created["requestId"], True)
    results = await asyncio.gather(
        service.login.confirm(SENDER, created["requestId"], True),
        service.login.confirm(SENDER, created["requestId"], True),
        return_exceptions=True,
    )
    assert sum(isinstance(result, InvalidInput) for result in results) == 1
    assert (
        sum(
            isinstance(result, dict) and result.get("status") == "confirmed"
            for result in results
        )
        == 1
    )
    assert created["expiresAt"].endswith("Z")
    assert service.runtime.bind_count == 1
    assert len(service.store.list_accounts()) == 1
    created = await service.login.create(SCOPE, SENDER, "real-message")
    service.login._by_id[created["requestId"]].expires_at = time.time() - 1
    assert (await service.login.pending(SENDER))["status"] == "expired"
    await service.login.set_public_url("https://newfixture.trycloudflare.com")
    assert (await service.login.pending(SENDER))["status"] == "none"


@pytest.mark.asyncio
async def test_tunnel_stop_revokes_public_url_and_pending_tickets(service):
    service, client = service
    registered = await client.post("/v1/public-url", json={"url": "https://fixture.trycloudflare.com"})
    assert (await registered.json())["ready"] is True
    created = await service.login.create(SCOPE, SENDER, "fixture-message")
    cleared = await client.post("/v1/public-url", json={"url": None})
    assert await cleared.json() == {"ready": False, "changed": True}
    assert service.login.public_url is None
    assert (await service.login.pending(SENDER))["status"] == "none"
    with pytest.raises(InvalidInput):
        await service.login.confirm(SENDER, created["requestId"], True)
    denied = await client.post("/v1/login/create", json={"key": SCOPE, "senderQQ": SENDER, "messageId": "fixture-message"})
    assert denied.status == 400
    status = await client.get("/v1/status")
    assert (await status.json())["publicLoginReady"] is False


@pytest.mark.asyncio
async def test_public_narrow_routes_headers_bounds(service):
    service, _client = service
    public = TestClient(TestServer(service.public_app()))
    await public.start_server()
    try:
        for route in (
            "/v1/status",
            "/admin",
            "/docs",
            "/openapi.json",
            "/waves/login",
            "/health",
            "/",
        ):
            response = await public.get(route)
            assert response.status == 404
            assert response.headers["Cache-Control"] == "no-store"
            assert response.headers["Referrer-Policy"] == "no-referrer"
        await service.login.set_public_url("https://fixture.trycloudflare.com")
        created = await service.login.create(SCOPE, SENDER, "real-message")
        ticket = service.login._by_id[created["requestId"]].ticket
        response = await public.get("/l/" + ticket)
        assert response.status == 200
        response = await public.post(
            "/l/" + ticket + "/sms",
            json={"phone": "13800138000", "captcha": {}},
            headers={"Origin": "https://evil.example"},
        )
        assert response.status == 400
        login = service.login._by_id[created["requestId"]]
        login.requests = 100
        with pytest.raises(InvalidInput):
            await service.login.by_ticket(ticket)
    finally:
        await public.close()


@pytest.mark.asyncio
async def test_subscription_merge_optin_notices_restart_suppression(service):
    service, client = service
    assert not service.store.list_subscriptions()
    response = await client.post(
        "/v1/subscriptions",
        json={"senderQQ": SENDER, "key": SCOPE, "signEnabled": True},
    )
    assert response.status == 400
    service.store.bind(SENDER, "123456789", "测试", "fixture-credential")
    await client.post(
        "/v1/subscriptions",
        json={"senderQQ": SENDER, "key": SCOPE, "signEnabled": True},
    )
    response = await client.post(
        "/v1/subscriptions",
        json={
            "senderQQ": SENDER,
            "key": SCOPE,
            "reminderEnabled": True,
            "threshold": 200,
        },
    )
    subscription = await response.json()
    assert subscription["signEnabled"] and subscription["reminderEnabled"]
    service.schedules = Schedules(service)
    now = time.time()
    await service.schedules.tick(now)
    await asyncio.gather(*service.schedules.jobs.values())
    notices = service.store.pending_notices()
    assert len(notices) == 1
    service.schedules = Schedules(service)
    await service.schedules.tick(now + 30)
    assert not service.schedules.jobs
    await client.post(
        "/v1/policy",
        json={"allowedKeys": [SCOPE], "pausedKeys": [SCOPE], "globalPaused": False},
    )
    assert not service.store.pending_notices()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["paused", "revoked", "global_paused"])
async def test_subscription_revocation_remains_available_after_policy_denial(service, mode):
    service, client = service
    service.store.bind(SENDER, "123456789", "fixture", "fixture-credential")
    service.store.set_subscription(SENDER, SCOPE, True, True, 180)
    service.store.set_subscription("54321", SCOPE, True, True, 200)
    await client.post("/v1/policy", json={
        "allowedKeys": [] if mode == "revoked" else [SCOPE],
        "pausedKeys": [SCOPE] if mode == "paused" else [],
        "globalPaused": mode == "global_paused",
    })
    for changes in ({"signEnabled": True}, {"reminderEnabled": True},
                    {"signEnabled": 0}, {"threshold": 180},
                    {"signEnabled": False, "threshold": 180}, {}):
        response = await client.post("/v1/subscriptions", json={"senderQQ": SENDER, "key": SCOPE, **changes})
        assert response.status == 400
    wrong_scope = await client.post("/v1/subscriptions", json={"senderQQ": SENDER, "key": "group:98765", "signEnabled": False})
    assert wrong_scope.status == 400
    wrong_private_owner = await client.post("/v1/subscriptions", json={"senderQQ": SENDER, "key": "private:54321", "signEnabled": False})
    assert wrong_private_owner.status == 400
    disabled_sign = await client.post("/v1/subscriptions", json={"senderQQ": SENDER, "key": SCOPE, "signEnabled": False})
    assert disabled_sign.status == 200
    assert (await disabled_sign.json())["reminderEnabled"] is True
    disabled_reminder = await client.post("/v1/subscriptions", json={"senderQQ": SENDER, "key": SCOPE, "reminderEnabled": False})
    assert disabled_reminder.status == 200
    own = await disabled_reminder.json()
    assert not own["signEnabled"] and not own["reminderEnabled"]
    other = service.store.get_subscription("54321", SCOPE)
    assert other["signEnabled"] and other["reminderEnabled"] and other["threshold"] == 200


@pytest.mark.asyncio
async def test_mutation_wrong_qq_single_use_and_simulated_sign(service):
    service, client = service
    response = await client.post(
        "/v1/mutations/prepare",
        json={
            "senderQQ": SENDER,
            "key": SCOPE,
            "messageId": "real-message",
            "action": "sign",
        },
    )
    consent = await response.json()
    bad = await client.post(
        "/v1/mutations/confirm",
        json={"senderQQ": "54321", "requestId": consent["requestId"], "accept": True},
    )
    assert bad.status == 400
    assert service.runtime.sign_count == 0
    confirmed = await client.post(
        "/v1/mutations/confirm",
        json={"senderQQ": SENDER, "requestId": consent["requestId"], "accept": True},
    )
    assert confirmed.status == 200
    result = await completed(service, consent["requestId"])
    assert result["status"] == "completed" and service.runtime.sign_count == 1
    repeated = await client.post(
        "/v1/mutations/confirm",
        json={"senderQQ": SENDER, "requestId": consent["requestId"], "accept": True},
    )
    assert repeated.status == 400


@pytest.mark.asyncio
async def test_slow_sms_does_not_block_policy_cancellation(service):
    service, client = service
    entered, release = asyncio.Event(), asyncio.Event()

    async def slow_sms(*_args):
        entered.set()
        await release.wait()

    service.runtime.request_sms = slow_sms
    await service.login.set_public_url("https://sms-fixture.trycloudflare.com")
    created = await service.login.create("group:67890", "12345", "fixture-message")
    login = service.login._by_id[created["requestId"]]
    operation = asyncio.create_task(
        service.login.request_sms(login.ticket, "13800138000", {})
    )
    await entered.wait()
    response = await asyncio.wait_for(
        client.post(
            "/v1/policy",
            json={"allowedKeys": [], "pausedKeys": [], "globalPaused": True},
        ),
        1,
    )
    assert response.status == 200
    assert not operation.done()
    release.set()
    with pytest.raises(InvalidInput):
        await operation


def test_native_account_projection_migration_restart_and_conflict(tmp_path):
    import sqlite3

    source, native_path = tmp_path / "adapter.db", tmp_path / "native.db"
    store = Store(source)
    store.bind(SENDER, "199999983", "fixture", "non-secret-migration-fixture")
    raw = store._conn.execute("SELECT credential FROM accounts").fetchone()[0]
    store.use_native_accounts(native_path)
    assert (
        store._accounts_conn.execute("SELECT credential FROM qbot_accounts").fetchone()[
            0
        ]
        == raw
    )
    assert store._conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0] == 0
    assert store.get_account(SENDER)["credential"] == "non-secret-migration-fixture"
    store.close()
    store = Store(source)
    store.use_native_accounts(native_path)
    assert store.get_account(SENDER)["uid"] == "199999983"
    store.close()
    conflicting = Store(tmp_path / "conflicting-adapter.db")
    conflicting.bind(SENDER, "199999984", "fixture", "other-non-secret-fixture")
    with pytest.raises(CredentialError, match="migration conflict"):
        conflicting.use_native_accounts(native_path)
    assert conflicting.get_account(SENDER)["uid"] == "199999984"
    with sqlite3.connect(native_path) as conn:
        assert (
            conn.execute("SELECT uid FROM qbot_accounts").fetchone()[0] == "199999983"
        )
    conflicting.close()
