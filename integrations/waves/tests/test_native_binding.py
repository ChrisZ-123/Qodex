"""Real plugin mappers and real SQLite commits, with isolated fixture accounts."""

import asyncio
import base64
import importlib
import json
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import delete, select, update

from adapter.native import PLUGIN, CapturedBot, NativeRuntime, RequestContext
from adapter.security import InvalidInput
from adapter.service import WavesService
from adapter.storage import Store
from adapter.tasks import TaskRecord, TaskSink

from adapter.paths import runtime_root

ROOT = runtime_root()
SENDER = "9999977777"
SCOPE = "private:" + SENDER
OLD_UID, NEW_UID = "199999981", "199999982"
FIXTURE_CREDENTIAL = json.dumps(
    {"token": "non-secret-native-binding-fixture", "did": "fixture-device", "bat": "fixture-bat"}
)
HTTP_REQUEST = httpx.AsyncClient.request


@pytest.mark.asyncio
@pytest.mark.parametrize("is_refresh", [True, False])
@pytest.mark.parametrize("own_cookie,query_uid,expected_count", [
    (True, NEW_UID, 9),
    (False, NEW_UID, 6),
    (True, OLD_UID, 6),
])
async def test_charlist_refresh_uses_all_roles_only_with_own_credentials(
    native, monkeypatch, own_cookie, query_uid, expected_count, is_refresh
):
    runtime = native[0]
    draw = importlib.import_module(f"{PLUGIN}.wutheringwaves_charlist.draw_char_list")
    refresh = importlib.import_module(f"{PLUGIN}.utils.refresh_char_detail")
    role_ids = list(range(1501, 1510))
    requested = []

    async def credential(*_args):
        return own_cookie, "fixture-only-charlist-cookie"

    async def account_info(*_args):
        return SimpleNamespace()

    async def no_cached_roles(*_args):
        return None

    async def hide_uid(*_args):
        return False

    async def roles(*_args):
        return SimpleNamespace(success=True, data={
            "roleList": [{
                "roleId": role_id, "level": 90, "roleName": "fixture",
                "starLevel": 5, "attributeId": 1, "weaponTypeId": 1,
            } for role_id in role_ids],
            "showRoleIdList": role_ids[:6],
            "showToGuest": True,
        })

    async def detail(role_id, *_args):
        requested.append(int(role_id))
        return SimpleNamespace(success=True, data={})

    async def no_save(*_args, **_kwargs):
        return None

    monkeypatch.setattr(draw.waves_api, "get_ck_result", credential)
    monkeypatch.setattr(draw.waves_api, "get_role_info", roles)
    monkeypatch.setattr(draw.waves_api, "get_role_detail_info", detail)
    monkeypatch.setattr(draw.base_info_cache, "get_or_fetch_account_info", account_info)
    monkeypatch.setattr(draw, "get_all_roleid_detail_info_int", no_cached_roles)
    monkeypatch.setattr(draw, "get_hide_uid_pref", hide_uid)
    monkeypatch.setattr(draw.WutheringWavesConfig, "get_config", lambda _key: SimpleNamespace(data=True))
    monkeypatch.setattr(refresh, "save_card_info", no_save)
    event = runtime.event("ww刷新练度统计", SENDER, SCOPE, "charlist-fixture")
    await draw.draw_char_list_img(
        query_uid, event, SENDER, is_refresh, query_uid != NEW_UID, NEW_UID
    )
    assert sorted(requested) == role_ids[:expected_count]


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
    runtime = NativeRuntime(path.parent)
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
    monkeypatch.setattr(runtime, "_bat_lock", asyncio.Lock())
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

    async def ticket(uid=NEW_UID, credential=FIXTURE_CREDENTIAL, auto_sms=False):
        created = await service.login.create(SCOPE, SENDER, "fixture-message")
        login = service.login._by_id[created["requestId"]]
        login.uid, login.nickname, login.status = (
            uid,
            "fixture",
            "awaiting_confirmation",
        )
        login.credential_encrypted = store.dpapi.encrypt(credential)
        if auto_sms:
            login.uid = login.nickname = None
            login.status = "sms_sent"
            login.credential_encrypted = None
            login.phone_encrypted = store.dpapi.encrypt("13800138000")

            async def verified(*_args):
                return uid, "fixture", credential

            monkeypatch.setattr(runtime, "verify_sms", verified)
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
        json.dumps({"token": "changed-non-secret-fixture", "did": "changed-device", "bat": "changed-fixture-bat"}),
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
async def test_sms_requires_confirm_then_waits_for_native_commit_and_deduplicates(binding):
    service, ticket, state, _invalidate, gate = binding
    login = await ticket(auto_sms=True)
    entered, release = gate()
    verified = await service.login.verify_sms(login.ticket, "123456")
    assert verified["status"] == "awaiting_confirmation"
    assert await state() == ([], [], None)
    first = asyncio.create_task(service.login.confirm(SENDER, login.request_id, True))
    await asyncio.wait_for(entered.wait(), 2)
    second = asyncio.create_task(service.login.confirm(SENDER, login.request_id, True))
    await asyncio.sleep(0)
    assert not first.done() and not second.done()
    assert await state() == ([], [], None)
    release.set()
    results = await asyncio.wait_for(asyncio.gather(first, second), 2)
    assert all(result["status"] == "confirmed" for result in results)
    users, bindings, account = await state()
    assert users == bindings == [NEW_UID]
    assert account["uid"] == NEW_UID
    assert login.verify_attempts == 1
    assert login.phone_encrypted is login.credential_encrypted is None
    models = importlib.import_module(f"{PLUGIN}.utils.database.models")
    from gsuid_core.utils.database import base_models as database
    async with database.async_maker() as session:
        account_row = (await session.execute(select(models.WavesUser).where(
            models.WavesUser.user_id == SENDER, models.WavesUser.uid == NEW_UID,
        ))).scalar_one()
        assert account_row.bat == "fixture-bat"
        assert account_row.platform == "ios"


@pytest.mark.asyncio
@pytest.mark.parametrize("prior", ["none", "different_uid", "same_uid"])
async def test_sms_confirm_failure_preserves_native_and_projection(binding, prior):
    service, ticket, state, _invalidate, gate = binding
    if prior != "none":
        old = await ticket(OLD_UID)
        await service.login.confirm(SENDER, old.request_id, True)
    login = await ticket(
        OLD_UID if prior == "same_uid" else NEW_UID,
        json.dumps({"token": "changed-non-secret-fixture", "did": "changed-device", "bat": "changed-fixture-bat"}),
        auto_sms=True,
    )
    entered, release = gate(fail=True)
    assert (await service.login.verify_sms(login.ticket, "123456"))["status"] == "awaiting_confirmation"
    operation = asyncio.create_task(service.login.confirm(SENDER, login.request_id, True))
    await asyncio.wait_for(entered.wait(), 2)
    release.set()
    with pytest.raises(RuntimeError, match="isolated commit failure"):
        await operation
    users, bindings, account = await state()
    if prior == "none":
        assert (users, bindings, account) == ([], [], None)
    else:
        assert users == bindings == [OLD_UID]
        assert account["uid"] == OLD_UID
        assert account["credential"] == FIXTURE_CREDENTIAL
    assert login.status == "failed"
    assert login.phone_encrypted is login.credential_encrypted is None


def install_login_protocol_mock(monkeypatch, bat_response=None, encoded_stages=()):
    client_type = httpx.AsyncClient
    calls = []

    def transport(request):
        calls.append(request)
        fields = parse_qs(request.content.decode())
        assert request.url.host == "api.kurobbs.com"
        assert request.headers["source"] == "ios"
        assert request.headers["content-type"].startswith("application/x-www-form-urlencoded")
        if request.url.path == "/user/sdkLogin":
            assert fields["devCode"] == [request.headers["devCode"]]
            data = {"code": 0, "data": {"token": "fixture-protocol-token"}}
        elif request.url.path == "/gamer/role/list":
            assert fields == {"gameId": ["3"]}
            data = {"code": 0, "data": [{"gameId": 3, "roleId": NEW_UID, "roleName": "fixture", "serverId": "fixture-server"}]}
        elif request.url.path == "/aki/roleBox/requestToken":
            assert fields == {"roleId": [NEW_UID], "serverId": ["fixture-server"]}
            assert request.headers["did"] == calls[0].headers["devCode"]
            assert request.headers["b-at"] == ""
            assert request.headers["token"] == "fixture-protocol-token"
            data = bat_response if bat_response is not None else {"code": 0, "data": {"accessToken": "fixture-protocol-bat"}}
        else:
            raise AssertionError("network route outside protocol mock")
        if request.url.path in encoded_stages and "data" in data:
            data["data"] = json.dumps(data["data"])
        return httpx.Response(200, json=data)

    monkeypatch.setattr(client_type, "request", HTTP_REQUEST)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client_type(transport=httpx.MockTransport(transport), **kwargs))
    return calls


@pytest.mark.asyncio
@pytest.mark.parametrize("encoded_stages", [(), ("/gamer/role/list",), ("/aki/roleBox/requestToken",), ("/gamer/role/list", "/aki/roleBox/requestToken")])
async def test_sms_login_gets_bat_with_actual_official_http_contract(binding, monkeypatch, encoded_stages):
    service, _ticket, _state, _invalidate, _gate = binding
    calls = install_login_protocol_mock(monkeypatch, encoded_stages=encoded_stages)
    uid, _nickname, serialized = await service.runtime.verify_sms("13800138000", "0000")
    credential = json.loads(serialized)
    assert uid == NEW_UID
    assert credential["bat"] == "fixture-protocol-bat"
    assert credential["did"] == calls[0].headers["devCode"]
    assert [request.url.path for request in calls] == ["/user/sdkLogin", "/gamer/role/list", "/aki/roleBox/requestToken"]


@pytest.mark.asyncio
@pytest.mark.parametrize("response", [{"code": 400}, {"code": 0, "data": {}}, {"code": 0, "data": {"accessToken": ""}}])
async def test_sms_login_requires_successful_nonempty_bat(binding, monkeypatch, response):
    service, _ticket, state, _invalidate, _gate = binding
    calls = install_login_protocol_mock(monkeypatch, response)
    with pytest.raises(InvalidInput, match="数据令牌获取失败"):
        await service.runtime.verify_sms("13800138000", "0000")
    assert len(calls) == 3
    assert await state() == ([], [], None)


async def prepare_missing_bat(binding):
    service, ticket, _state, _invalidate, _gate = binding
    login = await ticket()
    await service.login.confirm(SENDER, login.request_id, True)
    from gsuid_core.utils.database import base_models as database
    models = importlib.import_module(f"{PLUGIN}.utils.database.models")
    async with database.async_maker() as session:
        await session.execute(update(models.WavesUser).where(
            models.WavesUser.user_id == SENDER, models.WavesUser.uid == NEW_UID,
        ).values(bat="", platform=""))
        await session.commit()
    record = TaskRecord("fixture-bat-repair", SCOPE, SENDER, "ww刷新练度统计", "fixture-message", [])
    context = RequestContext(service.runtime, record, uid=NEW_UID)
    return service, database, models, context


@pytest.mark.asyncio
async def test_missing_own_bat_prepares_once_and_existing_bat_does_not_request(binding, monkeypatch):
    service, database, models, context = await prepare_missing_bat(binding)
    calls = []

    async def request(uid, cookie, did, server_id):
        calls.append(uid)
        assert uid == NEW_UID
        assert cookie == json.loads(FIXTURE_CREDENTIAL)["token"]
        assert did == "fixture-device"
        await asyncio.sleep(0)
        return "fixture-repaired-bat"

    monkeypatch.setattr(service.runtime, "_request_bat", request)
    await asyncio.gather(service.runtime._ensure_account_bat(context), service.runtime._ensure_account_bat(context))
    await service.runtime._ensure_account_bat(context)
    assert calls == [NEW_UID]
    async with database.async_maker() as session:
        account = (await session.execute(select(models.WavesUser).where(models.WavesUser.user_id == SENDER))).scalar_one()
        assert account.bat == "fixture-repaired-bat"
        assert account.platform == "ios"
        assert account.cookie == json.loads(FIXTURE_CREDENTIAL)["token"]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["cancel", "pause", "credential_change", "binding_change"])
async def test_missing_bat_repair_preserves_cancel_and_concurrent_login_boundaries(binding, monkeypatch, mode):
    service, database, models, context = await prepare_missing_bat(binding)
    entered, release = asyncio.Event(), asyncio.Event()

    async def request(*_args):
        entered.set()
        await release.wait()
        return "fixture-stale-bat"

    monkeypatch.setattr(service.runtime, "_request_bat", request)
    operation = asyncio.create_task(service.runtime._ensure_account_bat(context))
    await asyncio.wait_for(entered.wait(), 2)
    if mode == "cancel":
        context.record.status = "cancelled"
    elif mode == "pause":
        service.tasks.set_policy({SCOPE}, {SCOPE}, False)
    else:
        async with database.async_maker() as session:
            if mode == "credential_change":
                await session.execute(update(models.WavesUser).where(models.WavesUser.user_id == SENDER).values(
                    cookie="new-fixture-token", did="new-fixture-device", bat="new-fixture-bat",
                ))
            else:
                await session.execute(update(models.WavesBind).where(models.WavesBind.user_id == SENDER).values(uid=OLD_UID))
            await session.commit()
    release.set()
    with pytest.raises(InvalidInput):
        await operation
    async with database.async_maker() as session:
        account = (await session.execute(select(models.WavesUser).where(models.WavesUser.user_id == SENDER))).scalar_one()
        assert account.bat == ("new-fixture-bat" if mode == "credential_change" else "")


@pytest.mark.asyncio
async def test_missing_bat_request_failure_is_explicit_and_keeps_account(binding, monkeypatch):
    service, database, models, context = await prepare_missing_bat(binding)
    prior = service.store.get_account(SENDER)

    async def rejected(*_args):
        raise InvalidInput("鸣潮数据令牌获取失败，请重新登录或稍后重试")

    monkeypatch.setattr(service.runtime, "_request_bat", rejected)
    with pytest.raises(InvalidInput, match="数据令牌获取失败"):
        await service.runtime._ensure_account_bat(context)
    assert service.store.get_account(SENDER) == prior
    async with database.async_maker() as session:
        account = (await session.execute(select(models.WavesUser).where(models.WavesUser.user_id == SENDER))).scalar_one()
        assert account.bat == ""


@pytest.mark.asyncio
@pytest.mark.parametrize("module,name,requires_bat", [
    ("wutheringwaves_charlist", "send_char_list_msg_new", True),
    ("wutheringwaves_charinfo", "send_card_info", True),
    ("wutheringwaves_charinfo", "send_one_char_detail_msg", True),
    ("wutheringwaves_abyss", "send_waves_abyss_info", True),
    ("wutheringwaves_abyss", "send_waves_challenge_info", True),
    ("wutheringwaves_abyss", "send_waves_slash_info", True),
    ("wutheringwaves_abyss", "send_waves_matrix_info", True),
    ("wutheringwaves_charinfo", "send_score_explain_msg", False),
    ("wutheringwaves_abyss", "send_waves_rank_slash_info", False),
    ("wutheringwaves_abyss", "send_waves_rank_slash_list_info", False),
    ("wutheringwaves_abyss", "send_waves_rank_matrix_info", False),
    ("wutheringwaves_abyss", "send_waves_rank_matrix_list_info", False),
    ("wutheringwaves_help", "send_help_img", False),
    ("wutheringwaves_wiki", "send_role_guide_pic", False),
    ("wutheringwaves_rank", "send_rank_list_card", False),
    ("score_help", "send_score_help", False),
])
async def test_bat_preparation_only_precedes_explicit_own_data_handlers(binding, monkeypatch, tmp_path, module, name, requires_bat):
    service, _database, _models, context = await prepare_missing_bat(binding)
    events = []

    async def handler(_bot, _event):
        events.append("handler")

    handler.__module__ = f"{PLUGIN}.{module}" if module != "score_help" else "gsuid_core.plugins.ScoreEcho.ScoreEcho.scoreecho_help"
    handler.__name__ = name

    class Trigger:
        func = staticmethod(handler)

        async def get_command(self, event):
            return event

    async def prepare(_context):
        events.append("prepare")

    monkeypatch.setattr(service.runtime, "matching", lambda *_args: [Trigger()])
    monkeypatch.setattr(service.runtime, "_ensure_account_bat", prepare)
    await service.runtime._run_handlers(context.record, TaskSink(context.record, tmp_path / "sink"), context)
    assert events == (["prepare", "handler"] if requires_bat else ["handler"])


@pytest.mark.asyncio
async def test_original_matrix_upload_model_reaches_own_task_queue(native, monkeypatch):
    from adapter.native import _REQUEST

    runtime = native[0]
    matrix = importlib.import_module(f"{PLUGIN}.wutheringwaves_abyss.draw_matrix_card")
    util = importlib.import_module(f"{PLUGIN}.utils.util")
    data = matrix.MatrixDetail.model_validate({
        "isUnlock": True,
        "modeDetails": [{"modeId": 1, "hasRecord": True, "teams": [{"score": 1000}]}],
    })

    async def hide_uid(*_args):
        return False

    monkeypatch.setattr(runtime, "permitted", lambda key: key == SCOPE)
    monkeypatch.setattr(matrix.WutheringWavesConfig, "get_config", lambda _key: SimpleNamespace(data="fixture-only-token"))
    monkeypatch.setattr(util, "resolve_hide_uid", hide_uid)
    record = TaskRecord("matrix-upload-fixture", SCOPE, SENDER, "wwjz", "fixture", [])
    context = RequestContext(runtime, record, uid=NEW_UID)
    marker = _REQUEST.set(context)
    try:
        await matrix.upload_matrix_record(True, NEW_UID, data, {(1, 0): [1501]}, "", SENDER, "onebot")
        assert len(context.pending) == 1
        queue, payload = context.pending[0]
        assert queue == "waves_matrix_record"
        assert payload["wavesId"] == NEW_UID
        assert payload["teams"][0]["char_ids"] == [1501]
    finally:
        _REQUEST.reset(marker)


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

@pytest.mark.asyncio
async def test_native_file_images_use_runtime_root_not_adapter_source(native, tmp_path, monkeypatch):
    from gsuid_core.models import Message
    runtime = native[0]
    monkeypatch.setenv("QBOT_WAVES_ROOT", str(tmp_path))
    image = b"\x89PNG\r\n\x1a\nfixture-image"
    path = tmp_path / "core" / "data" / "fixture.png"
    path.parent.mkdir(parents=True)
    path.write_bytes(image)
    record = TaskRecord("file-image-output", SCOPE, SENDER, "ww帮助", "fixture", [])
    bot = CapturedBot(TaskSink(record, tmp_path / "sink"), runtime.event("ww帮助", SENDER, SCOPE, "fixture"))
    await bot.send(Message(type="image", data="file://" + str(path)))
    assert Path(record.outputs[0]["path"]).read_bytes() == image
    outside = tmp_path.parent / "outside-image.png"
    outside.write_bytes(image)
    with pytest.raises(ValueError):
        await bot.send(Message(type="image", data="file://" + str(outside)))
