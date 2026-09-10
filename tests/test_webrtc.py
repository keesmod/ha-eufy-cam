"""WebRTC signaling authorization, cancellation and independent bridge leases."""

import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import aiohttp
import pytest
from go2rtc_client.exceptions import Go2RtcClientError
from go2rtc_client.ws import WebRTCAnswer, WebRTCCandidate, WsError

from custom_components.eufy_viewer.const import DOMAIN

from .test_viewers import MediaSocket
from .test_viewers import viewer_setup as base_viewer_setup

viewer_setup = base_viewer_setup


class DeleteResponse:
    async def __aenter__(self):
        return SimpleNamespace(read=AsyncMock(return_value=b""))

    async def __aexit__(self, *_):
        pass


class Session:
    def __init__(self):
        self.deleted = []

    def delete(self, url, **kwargs):
        self.deleted.append((url, kwargs))
        return DeleteResponse()


class Signaling:
    def __init__(self, *_args, **_kwargs):
        self.send = AsyncMock()
        self.close = AsyncMock()

    def subscribe(self, callback):
        self.callback = callback


@pytest.fixture
async def rtc_setup(hass, viewer_setup):
    coordinator = viewer_setup.runtime_data
    coordinator.data = replace(coordinator.data, webrtc=True)
    session = Session()
    hass.data["go2rtc"] = SimpleNamespace(session=session, url="http://go2rtc")
    socket = MediaSocket()
    rest = SimpleNamespace(streams=SimpleNamespace(add=AsyncMock()))
    with (
        patch.object(
            coordinator.api, "websocket", AsyncMock(return_value=socket)
        ) as connect,
        patch(
            "custom_components.eufy_viewer.webrtc.Go2RtcRestClient", return_value=rest
        ),
        patch("custom_components.eufy_viewer.webrtc.Go2RtcWsClient", Signaling),
    ):
        yield socket, rest, session, connect


async def open_viewer(hass, hass_ws_client):
    client = await hass_ws_client(hass)
    await client.send_json(
        {
            "id": 1,
            "type": "eufy_viewer/watch",
            "entity_id": "camera.front_door",
            "transport": "webrtc",
        }
    )
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    return client, next(iter(hass.data[DOMAIN]["viewers"].values()))


async def ready(client, socket):
    await socket.queue.put(
        SimpleNamespace(
            type=aiohttp.WSMsgType.TEXT,
            data='{"type":"ready","path":"/v1/media/' + "a" * 64 + '"}',
        )
    )
    assert (await client.receive_json())["event"]["type"] == "ready"


async def test_real_ha_signaling_scoped_to_connection(hass, hass_ws_client, rtc_setup):
    socket, rest, session, connect = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client)
    await ready(client, socket)
    connect.assert_awaited_once_with("/v1/live/CAM123?transport=webrtc")
    assert rest.streams.add.await_count == 1
    other = await hass_ws_client(hass)
    await other.send_json(
        {"id": 1, "type": "eufy_viewer/signal", "subscription": 1, "offer": "sdp"}
    )
    assert not (await other.receive_json())["result"]["accepted"]
    await client.send_json(
        {"id": 2, "type": "eufy_viewer/signal", "subscription": 1, "offer": "sdp"}
    )
    assert (await client.receive_json())["result"]["accepted"]
    assert not await viewer.signal("duplicate", None)
    assert not await viewer.signal(None, None)
    assert await viewer.signal(None, "candidate:1")
    viewer._message(WebRTCAnswer("answer"))
    assert (await client.receive_json())["event"] == {"type": "answer", "sdp": "answer"}
    viewer._message(WebRTCCandidate("candidate:2"))
    assert (await client.receive_json())["event"]["candidate"] == "candidate:2"
    await socket.queue.put(
        SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data='{"type":"tick"}')
    )
    assert (await client.receive_json())["event"]["sequence"] == 1
    assert not socket.acks  # HA never manufactures a heartbeat.
    await client.send_json(
        {"id": 3, "type": "eufy_viewer/ack", "subscription": 1, "sequence": 1}
    )
    assert (await client.receive_json())["result"]["accepted"]
    assert socket.acks == ["ack"]
    signal = viewer.signaling
    await client.close()
    await hass.async_block_till_done()
    assert socket.closed.is_set()
    signal.close.assert_awaited_once()
    assert session.deleted[0][1]["params"] == {"src": viewer.name}
    assert not await viewer.signal("late", None)
    viewer._message(WebRTCAnswer("late"))


@pytest.mark.parametrize(
    "data",
    [
        "{}",
        "[]",
        "invalid",
        '{"type":"tick"}',
        '{"type":"ready","path":"http://evil"}',
        "x" * 1025,
    ],
)
async def test_bad_bridge_messages_stop_without_ack(
    hass, hass_ws_client, rtc_setup, data
):
    socket, _, _, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client)
    await socket.queue.put(SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=data))
    assert (await client.receive_json())["event"]["type"] == "ended"
    await viewer.task
    assert socket.closed.is_set() and not socket.acks


async def test_duplicate_tick_ends_session(hass, hass_ws_client, rtc_setup):
    socket, _, _, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client)
    await ready(client, socket)
    for _ in range(2):
        await socket.queue.put(
            SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data='{"type":"tick"}')
        )
    assert (await client.receive_json())["event"]["type"] == "tick"
    assert (await client.receive_json())["event"]["type"] == "ended"
    await viewer.task


async def test_upstream_error_redacted_and_signaling_failure_closes(
    hass, hass_ws_client, rtc_setup
):
    socket, _, _, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client)
    assert not await viewer.signal("early", None)
    await ready(client, socket)
    viewer._message(WsError("private bearer token and URL"))
    assert (await client.receive_json())["event"] == {"type": "ended"}
    await asyncio.gather(viewer.task, return_exceptions=True)
    await client.close()
    client, viewer = await open_viewer(hass, hass_ws_client)
    await ready(client, socket)
    viewer.signaling.send.side_effect = Go2RtcClientError("private")
    assert not await viewer.signal("offer", None)
    await hass.async_block_till_done()
    assert viewer.closed


async def test_missing_go2rtc_or_old_bridge_never_wakes_camera(
    hass, hass_ws_client, rtc_setup
):
    _, _, _, connect = rtc_setup
    hass.data.pop("go2rtc")
    client = await hass_ws_client(hass)
    await client.send_json(
        {
            "id": 1,
            "type": "eufy_viewer/watch",
            "entity_id": "camera.front_door",
            "transport": "webrtc",
        }
    )
    assert (await client.receive_json())["error"]["code"] == "unavailable"
    assert not connect.called
    entry = hass.config_entries.async_entries(DOMAIN)[0]
    entry.runtime_data.data = replace(entry.runtime_data.data, webrtc=False)
    await client.send_json(
        {
            "id": 2,
            "type": "eufy_viewer/watch",
            "entity_id": "camera.front_door",
            "transport": "webrtc",
        }
    )
    assert (await client.receive_json())["error"]["code"] == "unsupported"
    assert not connect.called


@pytest.mark.parametrize("audio", [False, True, None])
async def test_audio_conversion_matches_stream_capability(
    hass, hass_ws_client, rtc_setup, audio
):
    socket, rest, _, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client)
    payload = {"type": "ready", "path": "/v1/media/" + "a" * 64}
    if audio is not None:
        payload["audio"] = audio
    await socket.queue.put(
        SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(payload))
    )
    assert (await client.receive_json())["event"]["type"] == "ready"
    sources = rest.streams.add.call_args.args[1]
    assert len(sources) == (1 if audio is False else 2)
    assert sources[0].endswith(payload["path"])
    if audio is not False:
        assert sources[1] == f"ffmpeg:{viewer.name}#audio=opus"
    await client.close()
    await hass.async_block_till_done()


async def test_invalid_audio_capability_cannot_register_stream(
    hass, hass_ws_client, rtc_setup
):
    socket, rest, _, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client)
    await socket.queue.put(
        SimpleNamespace(
            type=aiohttp.WSMsgType.TEXT,
            data=json.dumps(
                {"type": "ready", "path": "/v1/media/" + "a" * 64, "audio": "false"}
            ),
        )
    )
    assert (await client.receive_json())["event"]["type"] == "ended"
    await viewer.task
    rest.streams.add.assert_not_called()
    await client.close()
