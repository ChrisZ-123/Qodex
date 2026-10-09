"""Real plugin mappers and real SQLite commits, with isolated fixture accounts."""

import asyncio
import base64
import importlib
import json
import os
import sys
import time
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import delete, select

from adapter.native import PLUGIN, CapturedBot, NativeRuntime
from adapter.paths import runtime_root
from adapter.security import InvalidInput
from adapter.service import WavesService
from adapter.storage import Store
from adapter.tasks import TaskRecord, TaskSink

ROOT = runtime_root()
SENDER = "9999977777"
SCOPE = "private:" + SENDER
OLD_UID, NEW_UID = "199999981", "199999982"
FIXTURE_CREDENTIAL = json.dumps(
    {"token": "non-secret-native-binding-fixture", "did": "fixture-device"}
)


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def native(tmp_path_factory):
    sys.path.insert(0, str(ROOT / "core"))
    old_cwd = Path.cwd()
    os.chdir(ROOT / "core")
    from gsuid_core.utils.database import base_models as database

    path = tmp_path_factory.mktemp("native-binding") / "native.db"
    database.DB_PATH = path
    database.db_url = str(path)
    original_request = httpx.AsyncClient.request

    async def blocked(*_args, **_kwargs):
        raise AssertionError("network forbidden in binding regression")

    httpx.AsyncClient.request = blocked
    runtime = NativeRuntime(ROOT)
    try:
        await runtime.initialize()
        models = importlib.import_module(f"{PLUGIN}.utils.database.models")
        yield runtime, database, models, path
    finally:
        httpx.AsyncClient.request = original_request
        await runtime.close()
        os.chdir(old_cwd)


@pytest_asyncio.fixture
async def binding(native, tmp_path, monkeypatch):
    runtime, database, models, path = native
    store = Store(tmp_path / "adapter.db")
    store.use_native_accounts(path)
    service = WavesService(
        tmp_path, "fixture-only-rpc-token-for-binding-test", runtime, store
    )
    service.tasks.set_policy({SCOPE}, set(), False)
    await service.login.set_public_url("https://binding-fixture.trycloudflare.com")
    async with database.async_maker() as session:
        for model in (models.WavesUser, models.WavesBind, models.WavesStaminaRecord):
            await session.execute(delete(model).where(model.user_id == SENDER))
        await store.unbind_in_transaction(session, SENDER)
        await session.commit()

    async def ticket(uid=NEW_UID, credential=FIXTURE_CREDENTIAL):
        created = await service.login.create(SCOPE, SENDER, "fixture-message")
        login = service.login._by_id[created["requestId"]]
        login.uid, login.nickname, login.status = (
            uid,
            "fixture",
            "awaiting_confirmation",
        )
        login.credential_encrypted = store.dpapi.encrypt(credential)
        return login

    async def state():
        async with database.async_maker() as session:
            users = (
                (
                    await session.execute(
                        select(models.WavesUser).where(
                            models.WavesUser.user_id == SENDER
                        )
                    )
                )
                .scalars()
                .all()
            )
            bindings = (
                (
                    await session.execute(
                        select(models.WavesBind).where(
                            models.WavesBind.user_id == SENDER
                        )
                    )
                )
                .scalars()
                .all()
            )
        return (
            [row.uid for row in users],
            [row.uid for row in bindings],
            store.get_account(SENDER),
        )

    async def invalidate(mode):
        if mode == "url_change":
            await service.login.set_public_url(
                "https://new-binding-fixture.trycloudflare.com"
            )
        elif mode == "replacement":
            await service.login.create(SCOPE, SENDER, "replacement-message")
        elif mode == "unbind":
            await service.unbind(SENDER)
        else:
            async with service.login.commit_lock:
                if mode == "policy":
                    service._apply_policy(
                        {"allowedKeys": [], "pausedKeys": [], "globalPaused": False}
                    )
                elif mode == "expiry":
                    for login in service.login._by_id.values():
                        login.expires_at = time.time() - 1
                else:
                    service.tasks.policy_expires = time.monotonic() - 1
            if mode == "policy_expiry":
                await service.expire_policy()

    def gate(fail=False):
        entered, release = asyncio.Event(), asyncio.Event()

        class CommitGate(AsyncSession):
            async def commit(self):
                # This gate is inside the actual native session.commit call,
                # after projection writes and the final ticket validator.
                entered.set()
                await release.wait()
                if fail:
                    raise RuntimeError("isolated commit failure")
                await super().commit()

        monkeypatch.setattr(
            database,
            "async_maker",
            async_sessionmaker(
                database.engine, class_=CommitGate, expire_on_commit=False
            ),
        )
        return entered, release

    yield service, ticket, state, invalidate, gate
    store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode", ["url_change", "policy", "replacement", "unbind", "policy_expiry"]
)
async def test_commit_first_then_invalidation_both_stores_agree(binding, mode):
    service, ticket, state, invalidate, gate = binding
    login = await ticket()
    entered, release = gate()
    operation = asyncio.create_task(
        service.login.confirm(SENDER, login.request_id, True)
    )
    await asyncio.wait_for(entered.wait(), 2)
    invalidation = asyncio.create_task(invalidate(mode))
    await asyncio.sleep(0)
    assert not invalidation.done()
    assert await state() == ([], [], None)
    release.set()
    assert (await operation)["status"] == "confirmed"
    await invalidation
    users, bindings, account = await state()
    if mode == "unbind":
        assert (users, bindings, account) == ([], [], None)
    else:
        assert users == bindings == [NEW_UID]
        assert account["uid"] == NEW_UID
    assert login.credential_encrypted is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode", ["url_change", "policy", "replacement", "expiry", "policy_expiry"]
)
async def test_invalidation_first_preserves_existing_legal_binding(binding, mode):
    service, ticket, state, invalidate, _gate = binding
    old = await ticket(OLD_UID)
    await service.login.confirm(SENDER, old.request_id, True)
    login = await ticket()
    await invalidate(mode)
    with pytest.raises(InvalidInput):
        await service.login.confirm(SENDER, login.request_id, True)
    users, bindings, account = await state()
    assert users == bindings == [OLD_UID]
    assert account["uid"] == OLD_UID
    assert login.credential_encrypted is None


@pytest.mark.asyncio
@pytest.mark.parametrize("prior", ["none", "different_uid", "same_uid"])
async def test_commit_failure_rolls_back_both_and_preserves_prior(binding, prior):
    service, ticket, state, _invalidate, gate = binding
    if prior != "none":
        old = await ticket(OLD_UID)
        await service.login.confirm(SENDER, old.request_id, True)
    login = await ticket(
        OLD_UID if prior == "same_uid" else NEW_UID,
        json.dumps({"token": "changed-non-secret-fixture", "did": "changed-device"}),
    )
    entered, release = gate(fail=True)
    operation = asyncio.create_task(
        service.login.confirm(SENDER, login.request_id, True)
    )
    await asyncio.wait_for(entered.wait(), 2)
    release.set()
    with pytest.raises(RuntimeError, match="isolated commit failure"):
        await operation
    users, bindings, account = await state()
    if prior != "none":
        assert users == bindings == [OLD_UID]
        assert account["uid"] == OLD_UID
        assert account["credential"] == FIXTURE_CREDENTIAL
        from gsuid_core.utils.database import base_models as database

        models = importlib.import_module(f"{PLUGIN}.utils.database.models")
        async with database.async_maker() as session:
            row = (
                await session.execute(
                    select(models.WavesUser).where(models.WavesUser.user_id == SENDER)
                )
            ).scalar_one()
            assert row.cookie == json.loads(FIXTURE_CREDENTIAL)["token"]
            assert row.did == json.loads(FIXTURE_CREDENTIAL)["did"]
    else:
        assert (users, bindings, account) == ([], [], None)


@pytest.mark.asyncio
async def test_ticket_expires_before_commit_validator_rolls_back(binding, monkeypatch):
    service, ticket, state, _invalidate, _gate = binding
    old = await ticket(OLD_UID)
    await service.login.confirm(SENDER, old.request_id, True)
    login = await ticket()
    original = service.store.bind_in_transaction

    async def expire_after_writes(*args):
        await original(*args)
        login.expires_at = time.time() - 1

    monkeypatch.setattr(service.store, "bind_in_transaction", expire_after_writes)
    with pytest.raises(InvalidInput, match="expired"):
        await service.login.confirm(SENDER, login.request_id, True)
    users, bindings, account = await state()
    assert users == bindings == [OLD_UID]
    assert account["uid"] == OLD_UID


@pytest.mark.asyncio
async def test_unbind_commit_failure_preserves_native_and_projection(binding):
    service, ticket, state, _invalidate, gate = binding
    login = await ticket(OLD_UID)
    await service.login.confirm(SENDER, login.request_id, True)
    entered, release = gate(fail=True)
    operation = asyncio.create_task(service.unbind(SENDER))
    await asyncio.wait_for(entered.wait(), 2)
    release.set()
    with pytest.raises(RuntimeError, match="isolated commit failure"):
        await operation
    users, bindings, account = await state()
    assert users == bindings == [OLD_UID]
    assert account["uid"] == OLD_UID


@pytest.mark.asyncio
async def test_original_bare_guide_images_and_message_images_are_captured(
    native, tmp_path
):
    from gsuid_core.models import Message

    runtime = native[0]
    record = TaskRecord("guide-output", SCOPE, SENDER, "ww帮助", "fixture-message", [])
    bot = CapturedBot(
        TaskSink(record, tmp_path / record.request_id),
        runtime.event("ww帮助", SENDER, SCOPE, "fixture-message"),
    )
    image = b"\x89PNG\r\n\x1a\nfixture-image"
    encoded = "base64://" + base64.b64encode(image).decode()
    await bot.send(["攻略作者：fixture", encoded, Message(type="image", data=encoded)])
    assert [item["type"] for item in record.outputs] == ["text", "image", "image"]
    assert all(
        Path(item["path"]).read_bytes() == image
        for item in record.outputs
        if item["type"] == "image"
    )
    assert record.outputs[0]["text"] == "攻略作者：fixture"
