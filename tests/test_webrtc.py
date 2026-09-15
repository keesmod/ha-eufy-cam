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
from custom_components.eufy_viewer.diagnostics import async_get_config_entry_diagnostics

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
        patch(
            "custom_components.eufy_viewer.late_audio.Go2RtcRestClient",
            return_value=rest,
        ),
        patch("custom_components.eufy_viewer.late_audio.Go2RtcWsClient", Signaling),
    ):
        yield socket, rest, session, connect


async def open_viewer(hass, hass_ws_client, *, late_audio=False):
    client = await hass_ws_client(hass)
    await client.send_json(
        {
            "id": 1,
            "type": "eufy_viewer/watch",
            "entity_id": "camera.front_door",
            "transport": "webrtc",
            "late_audio": late_audio,
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
@pytest.mark.parametrize("attempt", [123, None, True, -1, 2**48, "PRIVATE"])
async def test_audio_conversion_matches_stream_capability(
    hass, hass_ws_client, rtc_setup, audio, attempt
):
    socket, rest, _, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client)
    payload = {"type": "ready", "path": "/v1/media/" + "a" * 64}
    payload["audio_attempt"] = attempt
    if audio is not None:
        payload["audio"] = audio
    await socket.queue.put(
        SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(payload))
    )
    assert (await client.receive_json())["event"]["type"] == "ready"
    sources = rest.streams.add.call_args.args[1]
    if audio is not None:
        assert viewer.playback_evidence["audio_expected"] is audio
    else:
        assert "audio_expected" not in viewer.playback_evidence
    assert len(sources) == (1 if audio is False else 2)
    assert sources[0].endswith(payload["path"])
    if audio is not False:
        assert sources[1] == f"ffmpeg:{viewer.name}#audio=opus"
    with patch.object(
        viewer.coordinator.api,
        "request",
        AsyncMock(
            return_value={
                "schema": 2,
                "last_discovery": [],
                "recent_events": [],
                "live_audio": [{"attempt": attempt, "model": "T8134"}],
            }
        ),
    ):
        downloaded = await async_get_config_entry_diagnostics(
            hass, viewer.coordinator.entry
        )
    evidence = downloaded["live_playback"][-1]
    if attempt == 123:
        assert viewer.playback_evidence["audio_attempt"] == attempt
        assert evidence["audio_attempt"] == attempt
        assert downloaded["support"]["live_audio"][0]["attempt"] == attempt
    else:
        assert "audio_attempt" not in evidence
        assert "audio_attempt" not in viewer.playback_evidence
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


@pytest.mark.parametrize(
    "reason", ["connection_failed", "signaling_error", "playback_error"]
)
async def test_fallback_keeps_same_socket_and_rejects_other_owner(
    hass, hass_ws_client, rtc_setup, caplog, reason
):
    socket, rest, session, connect = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client)
    await socket.queue.put(
        SimpleNamespace(
            type=aiohttp.WSMsgType.TEXT,
            data=json.dumps(
                {
                    "type": "ready",
                    "path": "/v1/media/" + "a" * 64,
                    "audio": True,
                    "fallback": True,
                }
            ),
        )
    )
    assert (await client.receive_json())["event"]["fallback"]
    await socket.queue.put(
        SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data='{"type":"tick"}')
    )
    assert (await client.receive_json())["event"]["sequence"] == 1
    other = await hass_ws_client(hass)
    await other.send_json(
        {"id": 1, "type": "eufy_viewer/fallback", "subscription": 1, "reason": reason}
    )
    assert not (await other.receive_json())["result"]["accepted"]
    assert not socket.acks
    await client.send_json(
        {"id": 2, "type": "eufy_viewer/fallback", "subscription": 1, "reason": reason}
    )
    assert (await client.receive_json())["result"]["accepted"]
    assert socket.acks == ["fallback:" + reason]
    assert await viewer.fallback(reason)  # Duplicate requests never send twice.
    assert socket.acks == ["fallback:" + reason]
    await socket.queue.put(
        SimpleNamespace(
            type=aiohttp.WSMsgType.TEXT,
            data=json.dumps({"type": "fallback", "reason": reason}),
        )
    )
    assert (await client.receive_json())["event"] == {"type": "fallback"}
    frame = b"\xff\xd8\xff\xd9"
    await socket.queue.put(SimpleNamespace(type=aiohttp.WSMsgType.BINARY, data=frame))
    event = (await client.receive_json())["event"]
    assert event["type"] == "frame" and event["sequence"] == 2
    assert not await viewer.ack(1)  # A stale WebRTC ACK cannot consume this frame.
    assert await viewer.ack(2)
    assert socket.acks == ["fallback:" + reason, "ack:jpeg"]
    connect.assert_awaited_once()
    assert not socket.closed.is_set()
    assert not await viewer.signal("late-offer", None)
    await client.close()
    await hass.async_block_till_done()
    assert socket.closed.is_set()
    assert len(session.deleted) == 1
    assert reason in caplog.text
    assert "a" * 64 not in caplog.text


async def test_bridge_startup_fallback_before_ready(hass, hass_ws_client, rtc_setup):
    socket, rest, _, connect = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client)
    await socket.queue.put(
        SimpleNamespace(
            type=aiohttp.WSMsgType.TEXT,
            data='{"type":"fallback","reason":"startup_timeout"}',
        )
    )
    assert (await client.receive_json())["event"]["type"] == "fallback"
    await socket.queue.put(SimpleNamespace(type=aiohttp.WSMsgType.BINARY, data=b"jpeg"))
    assert (await client.receive_json())["event"]["type"] == "frame"
    assert not socket.acks
    rest.streams.add.assert_not_awaited()
    connect.assert_awaited_once()
    await client.close()


async def test_signaling_error_uses_supported_fallback(hass, hass_ws_client, rtc_setup):
    socket, _, _, connect = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client)
    await ready(client, socket)
    viewer.fallback_supported = True
    viewer._message(WsError("PRIVATE URL AND TOKEN"))
    await hass.async_block_till_done()
    assert socket.acks == ["fallback:signaling_error"]
    assert not viewer.closed
    connect.assert_awaited_once()
    await client.close()


async def test_stalled_go2rtc_setup_cannot_consume_fallback_budget(
    hass, hass_ws_client, rtc_setup
):
    socket, rest, _, connect = rtc_setup
    cancelled = asyncio.Event()

    async def stall(*_args):
        try:
            await asyncio.Future()
        finally:
            cancelled.set()

    rest.streams.add.side_effect = stall
    client, viewer = await open_viewer(hass, hass_ws_client)
    await socket.queue.put(
        SimpleNamespace(
            type=aiohttp.WSMsgType.TEXT,
            data=json.dumps(
                {
                    "type": "ready",
                    "path": "/v1/media/" + "a" * 64,
                    "fallback": True,
                    "fallback_after_ms": 10,
                }
            ),
        )
    )
    await asyncio.wait_for(cancelled.wait(), 1)
    await hass.async_block_till_done()
    assert socket.acks == ["fallback:signaling_error"]
    await socket.queue.put(
        SimpleNamespace(
            type=aiohttp.WSMsgType.TEXT,
            data='{"type":"fallback","reason":"startup_timeout"}',
        )
    )
    assert (await client.receive_json())["event"]["type"] == "fallback"
    await socket.queue.put(SimpleNamespace(type=aiohttp.WSMsgType.BINARY, data=b"jpeg"))
    assert (await client.receive_json())["event"]["type"] == "frame"
    connect.assert_awaited_once()
    assert not viewer.closed
    await client.close()


async def audio_ready(client, socket):
    await socket.queue.put(
        SimpleNamespace(
            type=aiohttp.WSMsgType.TEXT,
            data=json.dumps(
                {
                    "type": "ready",
                    "path": "/v1/media/" + "a" * 64,
                    "audio": False,
                    "fallback": True,
                }
            ),
        )
    )
    assert (await client.receive_json())["event"]["type"] == "ready"
    await socket.queue.put(
        SimpleNamespace(
            type=aiohttp.WSMsgType.TEXT,
            data=json.dumps(
                {
                    "type": "audio_ready",
                    "path": "/v1/media/" + "a" * 64 + "/audio",
                }
            ),
        )
    )
    assert (await client.receive_json())["event"]["type"] == "audio_ready"


async def test_late_audio_preserves_video_owner_and_scopes_signaling(
    hass, hass_ws_client, rtc_setup
):
    socket, rest, session, connect = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client, late_audio=True)
    await audio_ready(client, socket)
    connect.assert_awaited_once_with("/v1/live/CAM123?transport=webrtc&late_audio=1")
    assert rest.streams.add.await_count == 2
    assert rest.streams.add.call_args.args[0] == viewer.name + "_audio"
    assert rest.streams.add.call_args.args[1][0].endswith("a" * 64 + "/audio")
    video_signal = viewer.signaling
    other = await hass_ws_client(hass)
    await other.send_json(
        {
            "id": 1,
            "type": "eufy_viewer/signal",
            "subscription": 1,
            "audio": True,
            "offer": "sdp",
        }
    )
    assert not (await other.receive_json())["result"]["accepted"]
    await client.send_json(
        {
            "id": 2,
            "type": "eufy_viewer/signal",
            "subscription": 1,
            "audio": True,
            "offer": "sdp",
        }
    )
    assert (await client.receive_json())["result"]["accepted"]
    assert not await viewer.signal("duplicate", None, True)
    assert not await viewer.signal(None, None, True)
    assert await viewer.signal(None, "candidate:1", True)
    viewer.audio._message(WebRTCAnswer("audio-answer"))
    assert (await client.receive_json())["event"] == {
        "type": "audio_answer",
        "sdp": "audio-answer",
    }
    viewer.audio._message(WebRTCCandidate("candidate:2"))
    assert (await client.receive_json())["event"]["type"] == "audio_candidate"
    assert not socket.acks
    await socket.queue.put(
        SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data='{"type":"tick"}')
    )
    tick = (await client.receive_json())["event"]
    assert await viewer.ack(tick["sequence"])
    assert socket.acks == ["ack"]
    audio_signal = viewer.audio.signaling
    await client.send_json(
        {
            "id": 3,
            "type": "eufy_viewer/signal",
            "subscription": 1,
            "audio": True,
            "stop": True,
        }
    )
    assert (await client.receive_json())["result"]["accepted"]
    assert not viewer.closed and not socket.closed.is_set()
    video_signal.close.assert_not_called()
    audio_signal.close.assert_awaited_once()
    assert not await viewer.signal("late", None, True)
    assert not await viewer.signal(None, None, False, True)
    await client.close()
    await hass.async_block_till_done()
    video_signal.close.assert_awaited_once()
    assert {row[1]["params"]["src"] for row in session.deleted} == {
        viewer.name,
        viewer.name + "_audio",
    }
    assert socket.closed.is_set()


async def test_late_audio_failure_cannot_end_video_or_leak_upstream_errors(
    hass, hass_ws_client, rtc_setup
):
    socket, _, _, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client, late_audio=True)
    await audio_ready(client, socket)
    viewer.audio._message(WsError("PRIVATE URL AND TOKEN"))
    assert (await client.receive_json())["event"] == {"type": "audio_ended"}
    await hass.async_block_till_done()
    assert viewer.audio.closed and not viewer.closed
    assert not socket.acks and not socket.closed.is_set()
    await socket.queue.put(
        SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data='{"type":"tick"}')
    )
    tick = (await client.receive_json())["event"]
    assert await viewer.ack(tick["sequence"])
    await client.close()


async def test_close_cancels_pending_audio_setup_and_releases_both_streams(
    hass, hass_ws_client, rtc_setup
):
    socket, rest, session, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client, late_audio=True)
    await ready(client, socket)
    viewer.playback_evidence["audio_expected"] = False
    started = asyncio.Event()

    async def stall(*_args):
        started.set()
        await asyncio.Future()

    rest.streams.add.side_effect = stall
    await socket.queue.put(
        SimpleNamespace(
            type=aiohttp.WSMsgType.TEXT,
            data=json.dumps(
                {
                    "type": "audio_ready",
                    "path": "/v1/media/" + "a" * 64 + "/audio",
                }
            ),
        )
    )
    await started.wait()
    await client.close()
    await hass.async_block_till_done()
    assert viewer.audio_task.done() and viewer.audio.closed
    assert len(session.deleted) == 2 and socket.closed.is_set()


@pytest.mark.parametrize(
    "path", ["http://untrusted/audio", "/v1/media/" + "b" * 64 + "/audio"]
)
async def test_late_audio_cannot_open_an_unowned_media_url(
    hass, hass_ws_client, rtc_setup, path
):
    socket, rest, _, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client, late_audio=True)
    await ready(client, socket)
    viewer.playback_evidence["audio_expected"] = False
    await socket.queue.put(
        SimpleNamespace(
            type=aiohttp.WSMsgType.TEXT,
            data=json.dumps({"type": "audio_ready", "path": path}),
        )
    )
    assert (await client.receive_json())["event"]["type"] == "ended"
    await viewer.task
    assert rest.streams.add.await_count == 1
    await client.close()


@pytest.mark.parametrize("phase", ["prepare", "signal"])
async def test_audio_transport_exception_keeps_video_and_releases_audio(
    hass, hass_ws_client, rtc_setup, phase
):
    socket, rest, session, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client, late_audio=True)
    if phase == "prepare":
        await ready(client, socket)
        viewer.playback_evidence["audio_expected"] = False
        rest.streams.add.side_effect = Go2RtcClientError("PRIVATE DETAILS")
        await socket.queue.put(
            SimpleNamespace(
                type=aiohttp.WSMsgType.TEXT,
                data=json.dumps(
                    {"type": "audio_ready", "path": "/v1/media/" + "a" * 64 + "/audio"}
                ),
            )
        )
    else:
        await audio_ready(client, socket)
        viewer.audio.signaling.send.side_effect = Go2RtcClientError("PRIVATE DETAILS")
        assert not await viewer.signal("offer", None, True)
    assert (await client.receive_json())["event"] == {"type": "audio_ended"}
    await hass.async_block_till_done()
    assert viewer.audio.closed and not viewer.closed and not socket.closed.is_set()
    await socket.queue.put(
        SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data='{"type":"tick"}')
    )
    tick = (await client.receive_json())["event"]
    assert await viewer.ack(tick["sequence"])
    assert session.deleted[0][1]["params"]["src"] == viewer.name + "_audio"
    await client.close()
