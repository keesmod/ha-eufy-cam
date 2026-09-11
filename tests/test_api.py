"""Protocol validation and bounded snapshot requests."""

import copy

import pytest
from aiohttp import ClientSession, web

from custom_components.eufy_viewer.api import (
    BridgeClient,
    BridgeError,
    BridgeState,
    normalize_url,
)

from .conftest import STATE


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "https://user:password@host",
        "http://host/path",
        "http://host?token=x",
        "http://host/#fragment",
        "ws://host",
        "https://",
    ],
)
def test_reject_endpoint(url):
    with pytest.raises(BridgeError):
        normalize_url(url)


def test_protocol():
    assert BridgeState.parse(STATE).cameras["CAM123"].battery == 72
    for data in ({}, {**STATE, "protocol": 2}, {**STATE, "auth": "fake"}):
        with pytest.raises(BridgeError):
            BridgeState.parse(data)
    for field, value in [
        ("serial", "../../secret"),
        ("battery", 101),
        ("name", []),
        ("snapshot_received_at", 123),
    ]:
        data = copy.deepcopy(STATE)
        data["cameras"][0][field] = value
        with pytest.raises(BridgeError):
            BridgeState.parse(data)


async def test_snapshot_never_starts_camera(aiohttp_server, socket_enabled):
    calls = []

    async def cached(request):
        calls.append(request.path)
        assert request.headers["Authorization"] == "Bearer test"
        return web.Response(body=b"\xff\xd8\xff\xd9", content_type="image/jpeg")

    app = web.Application()
    app.router.add_get("/v1/snapshot/CAM123", cached)
    server = await aiohttp_server(app)
    async with ClientSession() as session:
        api = BridgeClient(session, str(server.make_url("")), "test")
        assert await api.snapshot("CAM123") == b"\xff\xd8\xff\xd9"
    assert calls == ["/v1/snapshot/CAM123"]


async def test_fragmented_http_and_auth_errors(aiohttp_server, socket_enabled):
    import json

    from custom_components.eufy_viewer.api import BridgeAuthError

    mode = "state"

    async def route(request):
        if mode == "unauthorized":
            return web.Response(status=401)
        if mode == "redirect":
            return web.Response(status=302, headers={"Location": "/unexpected"})
        if mode == "invalid":
            return web.Response(body=b"invalid")
        if mode == "oversized":
            return web.Response(body=b"x" * 1_048_577)
        if mode == "no_snapshot":
            return web.Response(status=404)
        if mode == "bad_image":
            return web.Response(body=b"html", content_type="text/html")
        if mode == "big_image":
            return web.Response(body=b"x" * 5_000_001, content_type="image/jpeg")
        if mode == "login":
            return web.json_response({"state": "connected"})
        if mode == "bad_login":
            return web.json_response([])
        response = web.StreamResponse(headers={"Content-Type": "application/json"})
        await response.prepare(request)
        raw = json.dumps(STATE).encode()
        for part in (raw[:10], raw[10:50], raw[50:]):
            await response.write(part)
        await response.write_eof()
        return response

    app = web.Application()
    app.router.add_route("*", "/{path:.*}", route)
    server = await aiohttp_server(app)
    async with ClientSession() as session:
        api = BridgeClient(session, str(server.make_url("")), "test")
        assert (await api.state()).bridge_id == "bridge-123"
        for mode in ("unauthorized", "redirect", "invalid", "oversized"):
            with pytest.raises(
                BridgeAuthError if mode == "unauthorized" else BridgeError
            ):
                await api.state()
        mode = "login"
        assert await api.login({"verifyCode": "123456"}) == {"state": "connected"}
        mode = "bad_login"
        with pytest.raises(BridgeError):
            await api.login({})
        mode = "no_snapshot"
        assert await api.snapshot("CAM123") is None
        for response_mode in ("bad_image", "big_image"):
            mode = response_mode
            with pytest.raises(BridgeError):
                await api.snapshot("CAM123")


async def test_local_websocket_protocol(aiohttp_server, socket_enabled):
    from custom_components.eufy_viewer.api import BridgeAuthError

    mode = "normal"

    async def route(request):
        if mode == "401":
            return web.Response(status=401)
        if mode == "403":
            return web.Response(status=403)
        socket = web.WebSocketResponse()
        await socket.prepare(request)
        await socket.send_json(STATE)
        await socket.close()
        return socket

    app = web.Application()
    app.router.add_get("/v1/events", route)
    server = await aiohttp_server(app)
    async with ClientSession() as session:
        api = BridgeClient(session, str(server.make_url("")), "test")
        async with await api.websocket("/v1/events") as socket:
            assert (await socket.receive_json())["protocol"] == 1
        for mode in ("401", "403"):
            with pytest.raises(BridgeAuthError if mode == "401" else BridgeError):
                await api.websocket("/v1/events")


async def test_recording_media_type_auth_and_redirect_boundary(
    aiohttp_server, socket_enabled
):
    mode = "video"
    formats = []

    async def route(request):
        formats.append(request.query.get("format"))
        assert request.headers["Authorization"] == "Bearer test"
        if mode == "redirect":
            return web.Response(
                status=302, headers={"Location": "http://example.invalid"}
            )
        if mode == "html":
            return web.Response(body=b"not video", content_type="text/html")
        return web.Response(body=b"finite clip", content_type="video/mp4")

    app = web.Application()
    app.router.add_get("/v1/recordings/CAM123/abc/video", route)
    server = await aiohttp_server(app)
    async with ClientSession() as session:
        api = BridgeClient(session, str(server.make_url("")), "test")
        assert await api.recording_video("CAM123", "abc") == b"finite clip"
        assert await api.recording_video("CAM123", "abc", native=True) == b"finite clip"
        assert formats == [None, "native"]
        for response_mode in ("redirect", "html"):
            mode = response_mode
            with pytest.raises(BridgeError):
                await api.recording_video("CAM123", "abc")


@pytest.mark.parametrize(
    "code,status", [("live_stopping", 409), ("secret", 409), ("live_busy", 400)]
)
async def test_recording_errors_allowlist(aiohttp_server, socket_enabled, code, status):
    from custom_components.eufy_viewer.api import BridgeRecordingError

    async def rejected(_request):
        return web.json_response({"error": code}, status=status)

    app = web.Application()
    app.router.add_get("/v1/recordings/{tail:.*}", rejected)
    server = await aiohttp_server(app)
    async with ClientSession() as session:
        api = BridgeClient(session, str(server.make_url("")), "test")
        for action in (
            api.request("GET", "/v1/recordings/CAM123?date=2026-09-06"),
            api.recording_video("CAM123", "a" * 32),
        ):
            with pytest.raises(BridgeError) as error:
                await action
            if code == "live_stopping":
                assert isinstance(error.value, BridgeRecordingError)
                assert error.value.code == code
            else:
                assert not isinstance(error.value, BridgeRecordingError)
                assert "secret" not in str(error.value)


def test_capabilities_are_optional_and_unknown_fields_are_ignored():
    data = copy.deepcopy(STATE)
    data["cameras"][0]["future_optional"] = {"anything": True}
    assert BridgeState.parse(data).cameras["CAM123"].permits("live")
    data["cameras"][0]["capabilities"] = {
        "live": {
            "available": False,
            "status": "future",
            "reason": "standalone_transport_unverified",
            "private_extra": "discard",
        },
        "future_feature": {"anything": True},
    }
    camera = BridgeState.parse(data).cameras["CAM123"]
    assert not camera.permits("live")
    assert camera.permits("snapshot")
    assert (
        camera.capability_reason("live")
        == "Standalone camera transport is not implemented"
    )
    assert camera.capability_reason("snapshot") == "This media operation is unavailable"
    assert camera.capabilities["live"]["status"] == "unknown"
    assert "discard" not in str(camera.capabilities)
    data["cameras"][0]["capabilities"]["live"]["reason"] = "secret upstream detail"
    assert (
        BridgeState.parse(data).cameras["CAM123"].capabilities["live"]["reason"] is None
    )
    for value in ([], {"live": []}, {"live": {"available": "false"}}):
        data["cameras"][0]["capabilities"] = value
        with pytest.raises(BridgeError):
            BridgeState.parse(data)
