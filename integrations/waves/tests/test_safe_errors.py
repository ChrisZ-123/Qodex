"""Adapter fixed errors cross boundaries; raw upstream material never does."""

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from aiohttp.test_utils import TestClient, TestServer

import adapter.native as native_module
from adapter.native import NativeRuntime, PLUGIN
from adapter.security import InvalidInput, SafeOperationError
from adapter.service import WavesService
from adapter.storage import Store
from adapter.tasks import TaskManager, TaskRecord

HTTP_REQUEST = httpx.AsyncClient.request
SCOPE, SENDER = "group:67890", "12345"
UNSAFE = "fixture-private-token phone-fragment=13800138000 code-fragment=0000"


def protocol_runtime(tmp_path, monkeypatch, response=None, exception=None):
    runtime = NativeRuntime(tmp_path)
    original_import = native_module.importlib.import_module

    def imports(name, *args):
        if name == f"{PLUGIN}.utils.api.request_util":
            return SimpleNamespace(IOS_USER_AGENT="fixture-agent", CONTENT_TYPE="application/x-www-form-urlencoded; charset=utf-8")
        return original_import(name, *args)

    monkeypatch.setattr(native_module.importlib, "import_module", imports)
    client_type = httpx.AsyncClient

    def transport(request):
        if exception:
            raise exception(UNSAFE, request=request)
        return httpx.Response(response[0], json=response[1], request=request)

    monkeypatch.setattr(client_type, "request", HTTP_REQUEST)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client_type(transport=httpx.MockTransport(transport), **kwargs))
    return runtime


@pytest.mark.asyncio
@pytest.mark.parametrize("status,body,reason", [
    (401, {"msg": UNSAFE}, "http_401"),
    (403, {"msg": UNSAFE}, "http_403"),
    (429, {"msg": UNSAFE}, "http_429"),
    (503, {"msg": UNSAFE}, "http_server"),
    (200, {"code": 220, "msg": UNSAFE, "data": UNSAFE}, "code_220"),
    (200, {"code": 130, "msg": UNSAFE}, "code_130"),
    (200, {"code": 99999999, "msg": UNSAFE}, "business_rejected"),
    (200, {"code": UNSAFE, "msg": UNSAFE}, "invalid_response"),
])
async def test_official_errors_expose_only_fixed_stage_and_reason(tmp_path, monkeypatch, status, body, reason):
    runtime = protocol_runtime(tmp_path, monkeypatch, (status, body))
    with pytest.raises(SafeOperationError) as caught:
        await runtime._official("/user/sdkLogin", {"mobile": "13800138000", "code": "0000"})
    error = caught.value
    assert error.stage == "login" and error.reason == reason
    assert str(error) == f"{SafeOperationError.STAGES['login']}：{SafeOperationError.REASONS[reason]}"
    assert UNSAFE not in str(error)
    assert "13800138000" not in str(error) and "0000" not in str(error)
    assert error.__cause__ is None


@pytest.mark.asyncio
@pytest.mark.parametrize("exception,reason", [(httpx.ReadTimeout, "timeout"), (httpx.ConnectError, "network")])
async def test_official_network_errors_are_fixed_and_keep_stage(tmp_path, monkeypatch, exception, reason):
    runtime = protocol_runtime(tmp_path, monkeypatch, exception=exception)
    with pytest.raises(SafeOperationError) as caught:
        await runtime._request_bat("100000001", "fixture-token", "fixture-device", "fixture-server")
    assert caught.value.stage == "bat" and caught.value.reason == reason
    assert UNSAFE not in str(caught.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("data", [{}, {"accessToken": ""}, "invalid fixture JSON"])
async def test_bat_missing_ticket_error_has_fixed_stage(tmp_path, monkeypatch, data):
    runtime = protocol_runtime(tmp_path, monkeypatch, (200, {"code": 0, "data": data, "msg": UNSAFE}))
    with pytest.raises(SafeOperationError) as caught:
        await runtime._request_bat("100000001", "fixture-token", "fixture-device", "fixture-server")
    assert caught.value.stage == "bat" and caught.value.reason == "missing_credential"
    assert UNSAFE not in str(caught.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("encoded", [False, True])
async def test_bat_success_returns_ticket_without_errors(tmp_path, monkeypatch, encoded):
    data = {"accessToken": "fixture-bat"}
    runtime = protocol_runtime(tmp_path, monkeypatch, (200, {"code": 0, "data": json.dumps(data) if encoded else data}))
    assert await runtime._request_bat("100000001", "fixture-token", "fixture-device", "fixture-server") == "fixture-bat"


@pytest.mark.asyncio
@pytest.mark.parametrize("safe", [False, True])
async def test_task_boundary_only_exposes_safe_adapter_error(tmp_path, safe):
    error = SafeOperationError("bat", "code_220") if safe else InvalidInput(UNSAFE)

    async def runner(_record, sink):
        sink.text("discarded incomplete output")
        raise error

    manager = TaskManager(tmp_path / "results", runner)
    manager.set_policy({SCOPE}, set(), False)
    record = TaskRecord("fixture-safe-error", SCOPE, SENDER, "ww刷新练度统计", "fixture-message", [])
    manager.submit(record)
    await asyncio.wait_for(record.job, 2)
    assert record.status == "failed" and record.outputs == []
    assert record.error == (str(error) if safe else "Waves operation failed")
    assert UNSAFE not in record.error


@pytest.mark.asyncio
@pytest.mark.parametrize("safe", [False, True])
async def test_public_boundary_only_exposes_safe_fixed_errors(tmp_path, safe):
    error = SafeOperationError("sms", "code_130") if safe else InvalidInput(UNSAFE)

    class Runtime:
        async def run(self, *_args):
            raise AssertionError("outside fixture")

        async def bind_account(self, *_args):
            raise AssertionError("outside fixture")

        async def request_sms(self, *_args):
            raise error

    store = Store(tmp_path / "adapter.db")
    service = WavesService(tmp_path, "fixture-only-rpc-token-for-safe-error", Runtime(), store)
    service.tasks.set_policy({SCOPE}, set(), False)
    await service.login.set_public_url("https://fixture.trycloudflare.com")
    created = await service.login.create(SCOPE, SENDER, "fixture-message")
    login = service.login._by_id[created["requestId"]]
    client = TestClient(TestServer(service.public_app()))
    await client.start_server()
    try:
        response = await client.post("/l/" + login.ticket + "/sms", json={"phone": "13800138000", "captcha": {}})
        result = await response.json()
        assert response.status == 400
        assert result["error"] == (str(error) if safe else "登录链接无效、已过期或本次请求失败，请返回 QQ 重新发起。")
        assert UNSAFE not in json.dumps(result)
        assert "13800138000" not in json.dumps(result) and "0000" not in json.dumps(result)
    finally:
        await client.close()
        service.login.invalidate(login)
        store.close()


def test_safe_error_rejects_arbitrary_messages():
    with pytest.raises(KeyError):
        SafeOperationError("bat", UNSAFE)
