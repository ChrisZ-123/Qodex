"""Public SMS verification only prepares a binding; exact original QQ confirms it."""

import asyncio
import time

import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer

from adapter.security import InvalidInput
from adapter.service import WavesService
from adapter.storage import Store

SENDER = "12345"
SCOPE = "group:67890"


class Runtime:
    login_ready = True

    def __init__(self):
        self.sms_calls = self.verify_calls = self.bind_calls = 0
        self.verify_entered = asyncio.Event()
        self.verify_release = asyncio.Event()
        self.verify_release.set()
        self.bind_entered = asyncio.Event()
        self.bind_release = asyncio.Event()
        self.bind_release.set()
        self.bind_fail = False

    async def run(self, *_args):
        raise AssertionError("task execution is outside login tests")

    async def request_sms(self, *_args):
        self.sms_calls += 1

    async def verify_sms(self, *_args):
        self.verify_calls += 1
        self.verify_entered.set()
        await self.verify_release.wait()
        return "123456789", "fixture-player", "fixture-only-credential"

    async def bind_account(self, login, credential, store, validate):
        self.bind_calls += 1
        self.bind_entered.set()
        await self.bind_release.wait()
        validate()
        if self.bind_fail:
            raise RuntimeError("fixture commit failure")
        store.bind(login.sender_qq, login.uid, login.nickname, credential)

    async def unbind(self, sender, store):
        store.unbind(sender)


@pytest_asyncio.fixture
async def fixture(tmp_path):
    store = Store(tmp_path / "adapter.db")
    runtime = Runtime()
    service = WavesService(tmp_path, "fixture-only-rpc-token-for-login-tests", runtime, store)
    service.tasks.set_policy({SCOPE}, set(), False)
    await service.login.set_public_url("https://fixture.trycloudflare.com")
    created = await service.login.create(SCOPE, SENDER, "fixture-message")
    login = service.login._by_id[created["requestId"]]
    await service.login.request_sms(login.ticket, "13800138000", {})
    yield service, login
    for item in list(service.login._by_id.values()):
        service.login.invalidate(item)
    store.close()


@pytest.mark.asyncio
async def test_public_verification_never_binds_and_confirm_is_idempotent(fixture):
    service, login = fixture
    results = await asyncio.wait_for(asyncio.gather(
        service.login.verify_sms(login.ticket, "123456"),
        service.login.verify_sms(login.ticket, "123456"),
    ), 2)
    assert all(result["status"] == "awaiting_confirmation" for result in results)
    assert results[0]["targetQQ"] == SENDER
    assert results[0]["account"] == {"uid": "123456789", "nickname": "fixture-player"}
    assert service.store.get_account(SENDER) is None
    assert service.runtime.bind_calls == 0
    assert login.phone_encrypted is None and login.credential_encrypted is not None
    with pytest.raises(InvalidInput):
        await service.login.confirm("54321", login.request_id, True)
    confirmed = await asyncio.gather(*(
        service.login.confirm(SENDER, login.request_id, True) for _ in range(2)
    ))
    assert all(result["status"] == "confirmed" for result in confirmed)
    assert service.store.get_account(SENDER)["uid"] == "123456789"
    assert login.phone_encrypted is login.credential_encrypted is None
    assert service.runtime.sms_calls == service.runtime.verify_calls == service.runtime.bind_calls == 1


async def invalidate(service, login, mode):
    if mode == "url":
        await service.login.set_public_url("https://newfixture.trycloudflare.com")
    elif mode == "url_stop":
        await service.login.set_public_url(None)
    elif mode in ("paused", "revoked", "global_paused"):
        async with service.login.commit_lock:
            service._apply_policy({
                "allowedKeys": [] if mode == "revoked" else [SCOPE],
                "pausedKeys": [SCOPE] if mode == "paused" else [],
                "globalPaused": mode == "global_paused",
            })
    elif mode == "replacement":
        await service.login.create(SCOPE, SENDER, "replacement-message")
    elif mode == "expired":
        login.expires_at = time.time() - 1
    elif mode == "cancel":
        assert (await service.login.cancel(login.request_id, SCOPE, SENDER))["status"] == "cancelled"
    else:
        await service.unbind(SENDER)


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["verifying", "awaiting_confirmation"])
@pytest.mark.parametrize("mode", ["url", "url_stop", "paused", "revoked", "global_paused", "replacement", "expired", "unbind", "cancel"])
async def test_invalidation_prevents_commit_at_both_sms_and_confirmation(fixture, mode, stage):
    service, login = fixture
    if stage == "verifying":
        service.runtime.verify_release.clear()
        operation = asyncio.create_task(service.login.verify_sms(login.ticket, "123456"))
        await asyncio.wait_for(service.runtime.verify_entered.wait(), 2)
    else:
        assert (await service.login.verify_sms(login.ticket, "123456"))["status"] == "awaiting_confirmation"
    await invalidate(service, login, mode)
    service.runtime.verify_release.set()
    if stage == "verifying":
        with pytest.raises(InvalidInput):
            await operation
    with pytest.raises(InvalidInput):
        await service.login.confirm(SENDER, login.request_id, True)
    assert service.store.get_account(SENDER) is None
    assert service.runtime.bind_calls == 0
    assert login.phone_encrypted is login.credential_encrypted is None


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", [("group:54321", SENDER), (SCOPE, "54321")])
async def test_cancel_rejects_wrong_exact_origin(fixture, origin):
    service, login = fixture
    with pytest.raises(InvalidInput, match="origin"):
        await service.login.cancel(login.request_id, *origin)
    assert service.login._by_id[login.request_id] is login
    assert (await service.login.verify_sms(login.ticket, "123456"))["status"] == "awaiting_confirmation"
    assert service.runtime.bind_calls == 0


@pytest.mark.asyncio
async def test_confirm_waits_for_commit_and_policy_change_has_explicit_order(fixture):
    service, login = fixture
    await service.login.verify_sms(login.ticket, "123456")
    service.runtime.bind_release.clear()
    operation = asyncio.create_task(service.login.confirm(SENDER, login.request_id, True))
    await asyncio.wait_for(service.runtime.bind_entered.wait(), 2)
    assert not operation.done()
    assert service.store.get_account(SENDER) is None
    policy = asyncio.create_task(service.login.set_public_url(None))
    await asyncio.sleep(0)
    assert not policy.done()
    service.runtime.bind_release.set()
    assert (await operation)["status"] == "confirmed"
    await policy
    assert service.store.get_account(SENDER)["uid"] == "123456789"
    assert login.phone_encrypted is login.credential_encrypted is None


@pytest.mark.asyncio
async def test_commit_failure_preserves_prior_account_and_clears_login_secrets(fixture):
    service, login = fixture
    service.store.bind(SENDER, "987654321", "prior-player", "prior-fixture-credential")
    prior = service.store.get_account(SENDER)
    await service.login.verify_sms(login.ticket, "123456")
    assert service.store.get_account(SENDER) == prior
    service.runtime.bind_fail = True
    with pytest.raises(RuntimeError, match="fixture commit failure"):
        await service.login.confirm(SENDER, login.request_id, True)
    assert service.store.get_account(SENDER) == prior
    assert login.status == "failed"
    assert login.phone_encrypted is login.credential_encrypted is None
    with pytest.raises(InvalidInput):
        await service.login.confirm(SENDER, login.request_id, True)
    assert service.runtime.verify_calls == service.runtime.bind_calls == 1


@pytest.mark.asyncio
async def test_public_summary_and_private_authenticated_exact_qq_confirm(fixture):
    service, login = fixture
    public = TestClient(TestServer(service.public_app()))
    private = TestClient(TestServer(service.private_app()), headers={"Authorization": "Bearer " + service.token})
    await public.start_server()
    await private.start_server()
    try:
        path = "/l/" + login.ticket
        response = await public.post(path + "/verify", json={"code": "123456", "targetQQ": "54321"})
        assert response.status == 400
        assert service.runtime.verify_calls == 0
        response = await public.post(path + "/verify", json={"code": "123456"})
        assert response.status == 200
        result = await response.json()
        assert set(result) == {"requestId", "status", "targetQQ", "expiresAt", "account"}
        assert result["status"] == "awaiting_confirmation"
        assert set(result["account"]) == {"uid", "nickname"}
        assert "credential" not in str(result)
        assert (await (await public.get(path + "/status")).json()) == result
        assert (await (await public.post(path + "/sms", json={"phone": "", "captcha": {}})).json()) == result
        payload = {"senderQQ": SENDER, "requestId": login.request_id, "accept": True}
        assert (await public.post("/v1/login/confirm", json=payload)).status == 404
        assert (await private.post("/v1/login/confirm", json=payload, headers={"Authorization": ""})).status == 401
        assert (await private.post("/v1/login/confirm", json={**payload, "senderQQ": "54321"})).status == 400
        assert service.store.get_account(SENDER) is None
        assert service.runtime.bind_calls == 0
        for _ in range(2):
            response = await private.post("/v1/login/confirm", json=payload)
            assert response.status == 200
            assert (await response.json())["status"] == "confirmed"
        assert service.runtime.bind_calls == 1
        login.expires_at = time.time() - 1
        await service.login.expire()
        assert login.expiry_handle is None
        assert login.request_id not in service.login._by_id
        assert service.store.get_account(SENDER)["uid"] == "123456789"
    finally:
        await public.close()
        await private.close()

@pytest.mark.asyncio
async def test_cancel_rpc_requires_exact_origin_and_public_listener_has_no_cancel(fixture):
    service, login = fixture
    public = TestClient(TestServer(service.public_app()))
    private = TestClient(TestServer(service.private_app()), headers={"Authorization": "Bearer " + service.token})
    await public.start_server()
    await private.start_server()
    try:
        payload = {"requestId": login.request_id, "key": SCOPE, "senderQQ": SENDER}
        for wrong in ({"key": "group:54321"}, {"senderQQ": "54321"}, {"requestId": "bad/id"}, {"extra": True}):
            assert (await private.post("/v1/login/cancel", json={**payload, **wrong})).status == 400
        assert (await public.post("/v1/login/cancel", json=payload)).status == 404
        assert (await private.post("/v1/login/cancel", json=payload)).status == 200
        assert (await (await private.post("/v1/login/cancel", json=payload)).json())["status"] == "none"
        assert (await public.get("/l/" + login.ticket + "/status")).status == 400
        assert login.expiry_handle is None
        assert service.runtime.bind_calls == 0
    finally:
        await public.close()
        await private.close()
