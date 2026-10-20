import json

import pytest
from aiohttp.test_utils import TestClient, TestServer

from adapter.authorization import UpstreamAuthorization
from test_service import service  # noqa: F401 -- reuse the isolated RPC fixture


@pytest.mark.asyncio
async def test_authorization_private_revision_and_no_secret_response(service):
    app, client = service
    path = app.root / "data" / "upstream-authorization.dpapi"
    app.runtime.authorization = UpstreamAuthorization(path)
    assert (await client.get("/v1/authorization", headers={"Authorization": ""})).status == 401
    response = await client.post("/v1/authorization", json={
        "revision": 0, "shared": True, "WavesToken": "fixture-rank-score-secret",
    })
    assert response.status == 200
    result = await response.json()
    assert result["revision"] == 1 and result["shared"] is True
    assert all(result[k]["state"] == "configured_unverified" for k in ("rank", "score"))
    assert "fixture-rank-score-secret" not in json.dumps(result)
    assert b"fixture-rank-score-secret" not in path.read_bytes()
    restored = UpstreamAuthorization(path)
    assert restored.token("rank") == restored.token("score") == "fixture-rank-score-secret"
    assert (await client.get("/v1/authorization")).status == 200
    assert (await client.post("/v1/authorization", json={"revision": 0, "shared": True})).status == 409
    assert (await client.post("/v1/authorization", json={"revision": 1, "shared": False, "xwtoken": ""})).status == 400
    assert (await client.post("/v1/authorization", json={"revision": 1, "shared": True, "path": "outside"})).status == 400
    assert restored.revision == 1


@pytest.mark.asyncio
async def test_authorization_not_on_public_login_listener(service):
    app, _ = service
    app.runtime.authorization = UpstreamAuthorization(app.root / "data" / "test.dpapi")
    public = TestClient(TestServer(app.public_app()))
    await public.start_server()
    try:
        for route in ("/v1/authorization", "/api/waves/authorization", "/v1/accounts"):
            assert (await public.get(route)).status == 404
            assert (await public.post(route, json={"revision": 0, "shared": True})).status == 404
    finally:
        await public.close()
