"""Isolated DPAPI/config and mocked upstream transport regressions."""
import asyncio
import base64
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from adapter.authorization import UpstreamAuthorization
from adapter.paths import runtime_root
from adapter.native import NativeRuntime, RequestContext, RequestTasks, _REQUEST, _upstream_send
from adapter.security import InvalidInput
from adapter.tasks import TaskRecord

from io import BytesIO
from PIL import Image

_image_buffer = BytesIO()
Image.new("RGB", (2, 2), "white").save(_image_buffer, format="PNG")
VALID_IMAGE_B64 = base64.b64encode(_image_buffer.getvalue()).decode("ascii")


def configured(tmp_path):
    auth = UpstreamAuthorization(tmp_path / "private.dpapi")
    auth.update(WavesToken="fake-rank-secret-for-isolated-test", xwtoken="fake-score-secret-for-isolated-test")
    return auth


def record():
    return TaskRecord("auth-fixture", "private:9999977777", "9999977777", "ww评分椿", "fixture", [])


def test_dpapi_persists_only_ciphertext_and_metadata(tmp_path):
    auth = configured(tmp_path)
    data = auth.path.read_bytes()
    assert b"fake-rank" not in data and b"fake-score" not in data
    restored = UpstreamAuthorization(auth.path)
    assert restored.token("rank") == auth.token("rank")
    assert restored.metadata()["score"]["state"] == "configured_unverified"
    assert "fake-" not in str(restored.metadata())
    assert not auth.path.with_suffix(".dpapi.pending").exists()


def test_shared_permissions_and_revision_are_independent(tmp_path):
    auth = configured(tmp_path)
    auth.update(WavesToken="fake-shared-token", shared=True)
    revision = auth.revision
    assert auth.token("rank") == auth.token("score")
    auth.observe("rank", "verified", revision=revision)
    assert auth.metadata()["score"]["state"] == "configured_unverified"
    auth.update(WavesToken="fake-new-token")
    assert not auth.observe("rank", "verified", revision=revision)
    assert auth.metadata()["rank"]["state"] == "configured_unverified"
    with pytest.raises(InvalidInput):
        auth.update(xwtoken="another-fake-token", shared=True)
    with pytest.raises(InvalidInput):
        auth.update(expected_revision=revision)


def test_config_provider_is_copy_and_next_read_hot_updates(tmp_path):
    auth = configured(tmp_path)
    values = {"WavesToken": SimpleNamespace(data=""), "Other": SimpleNamespace(data=17)}
    config = SimpleNamespace(get_config=lambda key, default=None: values[key], set_config=lambda key, value: setattr(values[key], "data", value))
    auth.install_provider(config, "WavesToken", "rank")
    first = config.get_config("WavesToken")
    assert first is not values["WavesToken"]
    assert values["WavesToken"].data == ""
    assert first.data == auth.token("rank")
    auth.update(WavesToken="fake-replaced-token")
    assert config.get_config("WavesToken").data == "fake-replaced-token"
    assert config.get_config("Other") is values["Other"]
    assert values["WavesToken"].data == ""


@pytest.mark.asyncio
async def test_cached_image_requires_allowed_path_and_one_mebibyte(tmp_path):
    runtime = NativeRuntime(tmp_path)
    runtime.permitted = lambda key: True
    runtime.root.joinpath("inputs").mkdir()
    image = runtime.root / "inputs" / "fixture.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\nfixture")
    task = record()
    task.images = [image]
    context = RequestContext(runtime, task, uid="199999981")
    marker = _REQUEST.set(context)
    try:
        result = await runtime._score_images(SimpleNamespace())
        assert base64.b64decode(result[0][9:]) == image.read_bytes()
        image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * (1024 * 1024))
        with pytest.raises(InvalidInput):
            await runtime._score_images(SimpleNamespace())
        task.images = [tmp_path / "outside.png"]
        task.images[0].write_bytes(b"\x89PNG\r\n\x1a\nfixture")
        with pytest.raises(InvalidInput):
            await runtime._score_images(SimpleNamespace())
    finally:
        _REQUEST.reset(marker)


@pytest.mark.asyncio
@pytest.mark.parametrize("service,status,payload,expected", [
    ("rank", 200, {"code": 0}, "verified"),
    ("rank", 403, {"detail": "fake-rank-secret-for-isolated-test"}, "authorization_failed"),
    ("rank", 500, {}, "service_error"),
    ("rank", 200, {"code": 403}, "authorization_failed"),
    ("rank", 200, {"code": 123, "success": True}, "service_error"),
    ("rank", 200, {}, "service_error"),
    ("score", 200, {"result_image_base64": VALID_IMAGE_B64}, "verified"),
    ("score", 200, {"result_image_base64": "malformed===base64"}, "service_error"),
    ("score", 200, {"result_image_base64": base64.b64encode(b"not an image").decode()}, "service_error"),
    ("score", 200, {"result_image_base64": base64.b64encode(b"\x89PNG\r\n\x1a\ntruncated").decode()}, "service_error"),
    ("score", 200, {"result_image_base64": VALID_IMAGE_B64, "matched_character": "../escape"}, "service_error"),
    ("score", 401, {}, "authorization_failed"),
    ("score", 200, {"code": 401}, "authorization_failed"),
    ("score", 200, {"message": "invalid image"}, "service_error"),
])
async def test_actual_mock_response_controls_separate_service_states(tmp_path, service, status, payload, expected):
    runtime = NativeRuntime(tmp_path)
    runtime.authorization = configured(tmp_path)
    runtime.permitted = lambda key: True
    if payload.get("matched_character") == "../escape":
        runtime.authorization.observe("score", "verified", revision=runtime.authorization.revision)
    context = RequestContext(runtime, record(), uid="199999981")
    operation = runtime._operation(context, service, "fixture")
    marker = _REQUEST.set(context)
    endpoint = "https://wh.loping151.site/top/waves/upload" if service == "rank" else "https://scoreecho.loping151.site/score"
    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(status, json=payload))) as client:
            if expected == "verified":
                await _upstream_send(client, client.build_request("POST", endpoint))
            else:
                with pytest.raises(InvalidInput) as error:
                    await _upstream_send(client, client.build_request("POST", endpoint))
                assert "fake-" not in str(error.value)
        assert operation["state"] == expected
        assert runtime.authorization.metadata()[service]["state"] == expected
        other = "score" if service == "rank" else "rank"
        assert runtime.authorization.metadata()[other]["state"] == "configured_unverified"
    finally:
        _REQUEST.reset(marker)


@pytest.mark.asyncio
async def test_no_task_pause_cancel_or_revision_change_blocks_network(tmp_path):
    runtime = NativeRuntime(tmp_path)
    runtime.authorization = configured(tmp_path)
    runtime.permitted = lambda key: True
    calls = []
    context = RequestContext(runtime, record(), uid="199999981")
    runtime._operation(context, "rank", "fixture")
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: calls.append(req) or httpx.Response(200, json={"code": 0}))) as client:
        req = client.build_request("POST", "https://wh.loping151.site/top/waves/upload")
        with pytest.raises(InvalidInput):
            await _upstream_send(client, req)
        marker = _REQUEST.set(context)
        try:
            runtime.permitted = lambda key: False
            with pytest.raises(InvalidInput):
                await _upstream_send(client, req)
            runtime.permitted = lambda key: True
            context.record.status = "cancelled"
            with pytest.raises(InvalidInput):
                await _upstream_send(client, req)
            context.record.status = "running"
            runtime.authorization.update(WavesToken="fake-updated-token")
            with pytest.raises(InvalidInput):
                await _upstream_send(client, req)
            assert not calls
        finally:
            _REQUEST.reset(marker)


@pytest.mark.parametrize("queue,uid_field", [
    ("waves_score_rank", "waves_id"),
    ("waves_abyss_record", "waves_id"),
    ("waves_slash_record", "wavesId"),
    ("waves_matrix_record", "wavesId"),
])
def test_upload_queue_uses_each_native_uid_field_and_rejects_spoofed_alias(tmp_path, queue, uid_field):
    runtime = NativeRuntime(tmp_path)
    runtime.permitted = lambda key: True
    context = RequestContext(runtime, record(), uid="199999981")
    marker = _REQUEST.set(context)
    other_field = "wavesId" if uid_field == "waves_id" else "waves_id"
    try:
        payload = {uid_field: context.uid}
        runtime._capture_upload(queue, payload)
        assert context.pending == [(queue, payload)]
        assert context.pending[0][1] is not payload
        with pytest.raises(InvalidInput, match="bound UID"):
            runtime._capture_upload(queue, {uid_field: "199999982", other_field: context.uid})
        with pytest.raises(InvalidInput, match="bound UID"):
            runtime._capture_upload(queue, {other_field: context.uid})
        with pytest.raises(InvalidInput, match="current sender"):
            runtime._capture_upload(queue, {uid_field: context.uid, "user_id": "11111"})
        assert len(context.pending) == 1
    finally:
        _REQUEST.reset(marker)


def test_upload_queue_requires_current_owner_and_background_task_retention(tmp_path):
    runtime = NativeRuntime(tmp_path)
    runtime.permitted = lambda key: True
    runtime._capture_upload("waves_score_rank", {"waves_id": "199999981"})
    context = RequestContext(runtime, record(), uid="199999981")
    marker = _REQUEST.set(context)
    try:
        runtime._capture_upload("waves_score_rank", {"waves_id": "199999981", "user_id": context.record.sender_qq})
        assert len(context.pending) == 1
        with pytest.raises(InvalidInput):
            runtime._capture_upload("waves_score_rank", {"waves_id": "199999982"})
        with pytest.raises(InvalidInput):
            runtime._capture_upload("waves_score_rank", {"waves_id": "199999981", "user_id": "11111"})
        context.record.status = "cancelled"
        with pytest.raises(InvalidInput):
            runtime._capture_upload("waves_abyss_record", {"waves_id": "199999981"})
    finally:
        _REQUEST.reset(marker)


@pytest.mark.asyncio
async def test_gateway_none_return_does_not_report_verified(tmp_path, monkeypatch):
    runtime = NativeRuntime(tmp_path)
    runtime.authorization = configured(tmp_path)
    runtime.permitted = lambda key: True
    context = RequestContext(runtime, record(), uid="199999981")
    calls = []
    async def upload(item):
        calls.append(item)
    monkeypatch.setattr("adapter.native.importlib.import_module", lambda name: SimpleNamespace(upload_score=upload))
    marker = _REQUEST.set(context)
    try:
        runtime._capture_upload("waves_score_rank", {"waves_id": context.uid})
        await runtime._flush_uploads(context)
        assert len(calls) == 1
        assert context.record.operations[0]["state"] == "service_error"
        assert runtime.authorization.metadata()["rank"]["state"] != "verified"
    finally:
        _REQUEST.reset(marker)


@pytest.mark.asyncio
async def test_original_compressor_accepts_normal_large_screenshot(tmp_path):
    import ast
    import math
    from io import BytesIO
    from PIL import Image
    source = runtime_root() / "core" / "gsuid_core" / "plugins" / "ScoreEcho" / "ScoreEcho" / "scoreecho_score" / "__init__.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_compress_image")
    namespace = {"Image": Image, "BytesIO": BytesIO, "math": math, "_MAX_IMAGE_BYTES": 1024 * 1024, "_MAX_IMAGE_PIXELS": 3840 * 2160}
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), namespace)
    runtime = NativeRuntime(tmp_path)
    runtime.score_module = SimpleNamespace(_compress_image=namespace["_compress_image"])
    runtime.permitted = lambda key: True
    runtime.root.joinpath("inputs").mkdir()
    path = runtime.root / "inputs" / "large.png"
    Image.new("RGB", (1200, 1000), "white").save(path, compress_level=0)
    assert path.stat().st_size > 1024 * 1024
    task = record()
    task.images = [path]
    marker = _REQUEST.set(RequestContext(runtime, task, uid="199999981"))
    try:
        images = await runtime._score_images(SimpleNamespace())
        encoded = await runtime._score_encode(images)
        assert len(base64.b64decode(encoded[0])) <= 1024 * 1024
        assert base64.b64decode(encoded[0])[8:12] == b"WEBP"
    finally:
        _REQUEST.reset(marker)


@pytest.mark.asyncio
async def test_cancel_during_native_child_work_cancels_child_and_sends_nothing(tmp_path, monkeypatch):
    runtime = NativeRuntime(tmp_path)
    runtime.authorization = configured(tmp_path)
    runtime.permitted = lambda key: True
    task_record = record()
    reached = asyncio.Event()
    child_cancelled = asyncio.Event()
    calls = []
    async def own_uid(*args):
        return "199999981"
    async def child():
        reached.set()
        try:
            await asyncio.Event().wait()
        finally:
            child_cancelled.set()
    async def handlers(record, sink, context):
        tasks = RequestTasks()
        tasks.add(asyncio.create_task(child()))
        runtime._capture_upload("waves_score_rank", {"waves_id": context.uid})
    async def upload(item):
        calls.append(item)
    models = SimpleNamespace(WavesBind=SimpleNamespace(get_uid_by_game=own_uid))
    monkeypatch.setattr("adapter.native.importlib.import_module", lambda name: models if name.endswith("database.models") else SimpleNamespace(upload_score=upload))
    monkeypatch.setattr(runtime, "_run_handlers", handlers)
    job = asyncio.create_task(runtime.run(task_record, None))
    await reached.wait()
    task_record.status = "cancelled"
    job.cancel()
    with pytest.raises(asyncio.CancelledError):
        await job
    assert child_cancelled.is_set()
    assert not calls
    assert _REQUEST.get() is None


@pytest.mark.asyncio
async def test_gateway_http_result_is_retained_when_native_returns_none(tmp_path, monkeypatch):
    runtime = NativeRuntime(tmp_path)
    runtime.authorization = configured(tmp_path)
    runtime.permitted = lambda key: True
    context = RequestContext(runtime, record(), uid="199999981")
    async def upload(item):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"code": 0}))) as client:
            await _upstream_send(client, client.build_request("POST", "https://wh.loping151.site/top/waves/upload"))
        return None
    monkeypatch.setattr("adapter.native.importlib.import_module", lambda name: SimpleNamespace(upload_score=upload))
    marker = _REQUEST.set(context)
    try:
        runtime._capture_upload("waves_score_rank", {"waves_id": context.uid})
        await runtime._flush_uploads(context)
        assert context.record.operations[0]["state"] == "verified"
        assert runtime.authorization.metadata()["rank"]["state"] == "verified"
    finally:
        _REQUEST.reset(marker)


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["token", "clear", "policy", "cancel"])
async def test_score_waiting_rate_lock_rechecks_before_sending(tmp_path, change):
    runtime = NativeRuntime(tmp_path)
    runtime.authorization = configured(tmp_path)
    runtime.permitted = lambda key: True
    context = RequestContext(runtime, record(), uid="199999981")
    operation = runtime._operation(context, "score", "fixture")
    calls = []
    await runtime._score_lock.acquire()
    marker = _REQUEST.set(context)
    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: calls.append(request) or httpx.Response(200, json={"result_image_base64": VALID_IMAGE_B64}))) as client:
            request = client.build_request("POST", "https://scoreecho.loping151.site/score", headers={"Authorization": "Bearer " + runtime.authorization.token("score")})
            job = asyncio.create_task(_upstream_send(client, request))
            await asyncio.sleep(0)
            assert not job.done()
            if change == "token":
                runtime.authorization.update(xwtoken="fake-rate-replacement")
            elif change == "clear":
                runtime.authorization.update(xwtoken="")
            elif change == "policy":
                runtime.permitted = lambda key: False
            else:
                context.record.status = "cancelled"
            runtime._score_lock.release()
            with pytest.raises(InvalidInput):
                await job
        assert not calls
        assert operation["state"] == "cancelled"
        assert runtime.authorization.metadata()["score"]["state"] != "verified"
    finally:
        if runtime._score_lock.locked():
            runtime._score_lock.release()
        _REQUEST.reset(marker)


@pytest.mark.asyncio
@pytest.mark.parametrize("service", ["rank", "score"])
@pytest.mark.parametrize("network_error", [False, True])
async def test_authorization_change_while_response_pending_cancels_old_operation(tmp_path, service, network_error):
    runtime = NativeRuntime(tmp_path)
    runtime.authorization = configured(tmp_path)
    runtime.permitted = lambda key: True
    context = RequestContext(runtime, record(), uid="199999981")
    operation = runtime._operation(context, service, "fixture")
    sent = asyncio.Event()
    resume = asyncio.Event()
    calls = []
    async def transport(request):
        calls.append(request)
        sent.set()
        await resume.wait()
        if network_error:
            raise httpx.ConnectError("fixture failure", request=request)
        return httpx.Response(200, json={"code": 0} if service == "rank" else {"result_image_base64": VALID_IMAGE_B64})
    marker = _REQUEST.set(context)
    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            endpoint = "https://wh.loping151.site/top/waves/upload" if service == "rank" else "https://scoreecho.loping151.site/score"
            job = asyncio.create_task(_upstream_send(client, client.build_request("POST", endpoint)))
            await sent.wait()
            runtime.authorization.update(**({"WavesToken": "fake-new-rank-permission"} if service == "rank" else {"xwtoken": "fake-new-score-permission"}))
            current = runtime.authorization.metadata()
            resume.set()
            with pytest.raises(InvalidInput):
                await job
        assert len(calls) == 1
        assert operation["state"] == "cancelled"
        assert runtime.authorization.metadata() == current
    finally:
        _REQUEST.reset(marker)


@pytest.mark.asyncio
@pytest.mark.parametrize("encoded,emit_image,expected,skip_request", [
    (VALID_IMAGE_B64, True, "completed", False),
    (VALID_IMAGE_B64, False, "failed", False),
    ("invalid-upstream-base64", False, "failed", False),
    (base64.b64encode(b"not an image").decode(), False, "failed", False),
    (VALID_IMAGE_B64, False, "failed", True),
])
async def test_swallowed_handler_error_or_missing_image_cannot_complete_score_task(tmp_path, monkeypatch, encoded, emit_image, expected, skip_request):
    import sys
    from adapter.native import SCORE
    from adapter.tasks import TaskManager

    runtime = NativeRuntime(tmp_path)
    runtime.authorization = configured(tmp_path)
    runtime.authorization.observe("score", "verified", revision=runtime.authorization.revision)
    runtime.score_module = SimpleNamespace(seconfig=SimpleNamespace(get_config=lambda key: SimpleNamespace(data="https://scoreecho.loping151.site/score")))
    task = record()
    tmp_path.joinpath("inputs").mkdir()
    image = tmp_path / "inputs" / "fixture.png"
    image.write_bytes(base64.b64decode(VALID_IMAGE_B64))
    task.images = [image]
    event = SimpleNamespace(bot_id="onebot", bot_self_id="fixture", user_id=task.sender_qq, group_id=None, regex_dict={}, raw_text=task.command)
    async def own_uid(*args):
        return "199999981"
    models = SimpleNamespace(WavesBind=SimpleNamespace(get_uid_by_game=own_uid))
    monkeypatch.setattr("adapter.native.importlib.import_module", lambda name: models)
    monkeypatch.setitem(sys.modules, "gsuid_core.models", SimpleNamespace(Message=type("Message", (), {})))
    monkeypatch.setattr(runtime, "event", lambda *args: event)
    async def handler(bot, event):
        if skip_request:
            await bot.send("评分请求未执行")
            return
        try:
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"result_image_base64": encoded}))) as client:
                response = await _upstream_send(client, client.build_request("POST", "https://scoreecho.loping151.site/score"))
            if emit_image:
                await bot.send(base64.b64decode(response.json()["result_image_base64"]))
            else:
                # Simulate a native handler swallowing an output/decode failure.
                raise ValueError("fixture handler swallowed image error")
        except Exception:
            await bot.send("评分图片处理失败")
    handler.__name__ = "score_phantom_handler"
    handler.__module__ = f"{SCORE}.scoreecho_score"
    async def command(ev):
        return ev
    trigger = SimpleNamespace(func=handler, get_command=command)
    monkeypatch.setattr(runtime, "matching", lambda *args: [trigger])
    manager = TaskManager(tmp_path / "results", runtime.run)
    runtime.permitted = manager.permitted
    manager.set_policy({task.key}, set(), False)
    manager.submit(task)
    await task.job
    assert task.status == expected
    assert task.operations[0]["state"] == ("verified" if expected == "completed" else "service_error")
    if expected == "completed":
        assert any(output["type"] == "image" for output in task.outputs)
    else:
        assert not task.outputs
        assert runtime.authorization.metadata()["score"]["state"] != "verified"
