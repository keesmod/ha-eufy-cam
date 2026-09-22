"""Playback reports distinguish media receipt, decode, paint and acknowledgement."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import aiohttp
import pytest

from custom_components.eufy_viewer.diagnostics import async_get_config_entry_diagnostics
from custom_components.eufy_viewer.live_diagnostics import browser_report, relay_report
from custom_components.eufy_viewer.webrtc import WebRTCViewer

from .test_webrtc import open_viewer, ready
from .test_webrtc import rtc_setup as base_rtc_setup
from .test_webrtc import viewer_setup as base_viewer_setup

rtc_setup = base_rtc_setup
viewer_setup = base_viewer_setup


class ReportResponse:
    def __init__(self, data):
        self.content = SimpleNamespace(
            readexactly=AsyncMock(side_effect=asyncio.IncompleteReadError(data, 65537))
        )

    def raise_for_status(self):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        pass


def test_reports_drop_unknown_and_malformed_data():
    assert browser_report(None) == {}
    result = browser_report(
        {
            "trigger": "startup",
            "connection": "PRIVATE",
            "ice": "checking",
            "muted": "PRIVATE",
            "answer": True,
            "ready_state": 5,
            "video_packets": True,
            "audio_bytes": -1,
            "painted": 2**53,
            "acks_accepted": 0,
            "sdp": "PRIVATE",
            "url": "PRIVATE",
        }
    )
    assert result == {
        "trigger": "startup",
        "ice": "checking",
        "answer": True,
        "acks_accepted": 0,
    }
    assert relay_report(None) == {}
    raw = {
        "producers": [
            {
                "url": "PRIVATE",
                "receivers": [
                    {"codec": {"codec_name": "H264"}, "packets": 20, "bytes": 900},
                    {"codec": {"codec_name": "AAC"}, "packets": 30, "bytes": 200},
                    {"codec": {"codec_name": "PRIVATE"}, "packets": 123},
                    {"codec": "PRIVATE"},
                    {"codec": {"codec_name": None}},
                    {"codec": {"codec_name": "AAC"}, "packets": True},
                    None,
                ],
            },
            {"receivers": None},
            None,
        ],
        "consumers": [
            {
                "senders": [
                    {"codec": {"codec_name": "OPUS"}, "packets": 25, "bytes": 100}
                ]
            }
        ],
    }
    assert relay_report(raw) == {
        "source_h264_packets": 20,
        "source_h264_bytes": 900,
        "source_aac_packets": 30,
        "source_aac_bytes": 200,
        "output_opus_packets": 25,
        "output_opus_bytes": 100,
    }
    assert "PRIVATE" not in json.dumps(relay_report(raw))


async def test_only_owner_can_report_and_reports_never_ack(
    hass, hass_ws_client, rtc_setup
):
    socket, _, session, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client)
    await ready(client, socket)
    data = json.dumps(
        {
            "producers": [
                {"receivers": [{"codec": {"codec_name": "H264"}, "packets": 9}]}
            ]
        }
    ).encode()
    session.get = Mock(return_value=ReportResponse(data))
    other = await hass_ws_client(hass)
    msg = {
        "id": 2,
        "type": "eufy_viewer/live_diagnostics",
        "subscription": 1,
        "report": {"trigger": "startup", "painted": 0, "ticks": 1},
    }
    await other.send_json(msg)
    assert not (await other.receive_json())["result"]["accepted"]
    session.get.assert_not_called()
    await client.send_json(msg)
    assert (await client.receive_json())["result"]["accepted"]
    assert viewer.playback_evidence["browser"] == [msg["report"]]
    assert viewer.playback_evidence["relay"] == [
        {"trigger": "startup", "source_h264_packets": 9}
    ]
    assert not socket.acks
    assert viewer.playback_evidence["acks"] == 0
    assert not await viewer.record_browser_report(msg["report"])
    assert not await viewer.record_browser_report({"trigger": "PRIVATE"})
    assert session.get.call_count == 1
    with patch.object(client, "send_json", wraps=client.send_json):
        await client.send_json(
            {**msg, "id": 3, "report": {"trigger": "playing", "sdp": "PRIVATE"}}
        )
        assert not (await client.receive_json())["success"]
    viewer.playback_evidence["audio_expected"] = False
    viewer.jpeg = True
    unmuted = {"trigger": "unmuted", "muted": False, "audio_energy": True}
    await client.send_json({**msg, "id": 4, "report": unmuted})
    assert (await client.receive_json())["result"]["accepted"]
    await client.send_json(
        {**msg, "id": 5, "report": {"trigger": "fallback", "video_decoder": "x" * 65}}
    )
    assert not (await client.receive_json())["success"]
    assert await viewer.record_browser_report(
        {"trigger": "fallback", "video_packets": 0}
    )
    late = {
        "trigger": "audio_check",
        "audio_codec": "audio/opus",
        "audio_clock_rate": 48000,
        "audio_channels": 2,
        "audio_tracks": 1,
        "audio_tracks_enabled": 1,
        "audio_tracks_muted": 0,
        "audio_tracks_ended": 0,
        "audio_volume_percent": 100,
    }
    assert await viewer.record_browser_report(late)
    assert not await viewer.record_browser_report(late)
    assert session.get.call_count == 1  # No request after the media grant is revoked.
    with patch.object(
        viewer.coordinator.api,
        "request",
        AsyncMock(
            return_value={"schema": 2, "last_discovery": [], "recent_events": []}
        ),
    ):
        download = await async_get_config_entry_diagnostics(
            hass, viewer.coordinator.entry
        )
    assert download["live_playback"][0]["audio_expected"] is False
    assert download["live_playback"][0]["browser"] == [
        msg["report"],
        unmuted,
        {"trigger": "fallback", "video_packets": 0},
        late,
    ]
    assert download["live_playback"][0]["relay"][0]["source_h264_packets"] == 9
    assert "CAM123" not in json.dumps(download)

    await client.close()
    await other.close()
    await hass.async_block_till_done()


@pytest.mark.parametrize("audio_failure", [None, "http", "oversized"])
async def test_relay_counters_include_the_late_audio_stream(
    hass, hass_ws_client, rtc_setup, audio_failure
):
    """AAC never rides in the video stream, so its own stream is sampled too."""
    from .test_webrtc import audio_ready

    socket, _, session, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client, late_audio=True)
    await audio_ready(client, socket)
    streams = {
        viewer.name: {
            "producers": [
                {"receivers": [{"codec": {"codec_name": "H264"}, "packets": 9}]}
            ],
            "consumers": [
                {"senders": [{"codec": {"codec_name": "H264"}, "packets": 8}]}
            ],
        },
        viewer.name + "_audio": {
            "producers": [
                {
                    "url": "PRIVATE",
                    "receivers": [{"codec": {"codec_name": "AAC"}, "packets": 30}],
                }
            ],
            "consumers": [
                {"senders": [{"codec": {"codec_name": "OPUS"}, "packets": 25}]}
            ],
        },
    }

    def get(_url, params):
        if params["src"].endswith("_audio"):
            if audio_failure == "http":
                raise aiohttp.ClientError()
            if audio_failure == "oversized":
                response = ReportResponse(b"{}")
                response.content.readexactly = AsyncMock(return_value=b"x" * 65537)
                return response
        return ReportResponse(json.dumps(streams[params["src"]]).encode())

    session.get = Mock(side_effect=get)
    assert await viewer.record_browser_report({"trigger": "audio_check"})
    assert session.get.call_count == 2
    row = viewer.playback_evidence["relay"][0]
    expected = {
        "trigger": "audio_check",
        "source_h264_packets": 9,
        "output_h264_packets": 8,
    }
    if audio_failure is None:
        expected |= {
            "audio_late": True,
            "source_aac_packets": 30,
            "output_opus_packets": 25,
        }
    assert row == expected
    # After the browser stops audio, only the video stream is sampled.
    assert await viewer.signal(None, None, True, True)
    assert await viewer.record_browser_report({"trigger": "playing"})
    assert session.get.call_count == 3
    assert "audio_late" not in viewer.playback_evidence["relay"][1]
    with patch.object(
        viewer.coordinator.api,
        "request",
        AsyncMock(
            return_value={"schema": 2, "last_discovery": [], "recent_events": []}
        ),
    ):
        download = await async_get_config_entry_diagnostics(
            hass, viewer.coordinator.entry
        )
    live = download["live_playback"][0]
    assert live["relay"][0] == expected
    assert live["audio_late"] == "ready" and live["audio_late_end"] == "stopped"
    assert "PRIVATE" not in json.dumps(download)
    await client.close()
    await hass.async_block_till_done()


@pytest.mark.parametrize("failure", ["http", "invalid_json", "oversized", "timeout"])
async def test_unavailable_relay_diagnostics_do_not_interrupt_viewer(
    hass, hass_ws_client, rtc_setup, failure
):
    socket, _, session, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client)
    await ready(client, socket)
    response = ReportResponse(b"invalid")
    session.get = Mock(return_value=response)
    if failure == "http":
        session.get.side_effect = aiohttp.ClientError()
    elif failure == "oversized":
        response.content.readexactly = AsyncMock(return_value=b"x" * 65537)
    elif failure == "timeout":
        response.content.readexactly = AsyncMock(side_effect=TimeoutError())
    assert await viewer.record_browser_report({"trigger": "startup", "painted": 0})
    assert not viewer.closed and not socket.acks
    assert not viewer.playback_evidence["relay"]
    await client.close()
    await hass.async_block_till_done()


async def test_attempt_history_is_bounded(hass, hass_ws_client, rtc_setup):
    client, viewer = await open_viewer(hass, hass_ws_client)
    coordinator = viewer.coordinator
    for number in range(12):
        current = WebRTCViewer(
            hass,
            viewer.connection,
            number + 10,
            coordinator,
            "CAM123",
            "camera.front_door",
        )
        assert await current.record_browser_report(
            {"trigger": "startup", "ticks": number}
        )
    assert len(coordinator.live_diagnostics) == 8
    assert coordinator.live_diagnostics[0]["browser"][0]["ticks"] == 4
    await client.close()
    await hass.async_block_till_done()


def test_extended_media_counters_keep_absence_and_signed_rtp_loss():
    """Missing audio counters are unknown and duplicate RTP can mean negative loss."""
    assert browser_report(
        {
            "video_lost": -2,
            "video_received": 8,
            "video_nack": 7,
            "video_pli": 4,
            "video_buffer_delay_ms": 125,
            "audio_negotiated": False,
            "audio_lost": float("nan"),
            "audio_packets": None,
            "video_jitter_ms": 2**53,
            "video_fir": True,
        }
    ) == {
        "video_lost": -2,
        "video_received": 8,
        "video_nack": 7,
        "video_pli": 4,
        "video_buffer_delay_ms": 125,
        "audio_negotiated": False,
    }


def test_decoder_identity_and_freeze_counters_are_bounded():
    """The decoder name is a short product string and durations are whole ms."""
    sample = {
        "video_decoder": "ExternalDecoder (D3D11VideoDecoder)",
        "video_decoder_power_efficient": True,
        "video_freezes": 3,
        "video_freeze_ms": 7200,
        "video_pauses": 0,
        "video_pause_ms": 0,
        "video_decode_ms": 1234,
        "video_processing_ms": 2500,
        "video_assembled": 6,
        "video_assembly_ms": 50,
    }
    assert browser_report(sample) == sample
    assert (
        browser_report(
            {
                "video_decoder": "x" * 65,
                "video_decoder_power_efficient": "true",
                "video_freezes": -1,
                "video_freeze_ms": 1.5,
                "video_decode_ms": None,
            }
        )
        == {}
    )
    assert browser_report({"video_decoder": "PRIVATE\n"}) == {}
    assert browser_report({"video_decoder": "<script>"}) == {}
    assert browser_report({"video_decoder": ""}) == {}


def _text(payload):
    return SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(payload))


async def test_bridge_fallback_samples_go2rtc_before_the_switch_to_jpeg(
    hass, hass_ws_client, rtc_setup
):
    """The fallback row says whether go2rtc's input had stopped, with late audio."""
    from .test_webrtc import audio_ready

    socket, _, session, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client, late_audio=True)
    await audio_ready(client, socket)
    streams = {
        viewer.name: {
            "producers": [
                {"receivers": [{"codec": {"codec_name": "H264"}, "packets": 204}]}
            ],
            "consumers": [
                {"senders": [{"codec": {"codec_name": "H264"}, "packets": 204}]}
            ],
        },
        viewer.name + "_audio": {
            "producers": [
                {"receivers": [{"codec": {"codec_name": "AAC"}, "packets": 966}]}
            ],
            "consumers": [
                {"senders": [{"codec": {"codec_name": "OPUS"}, "packets": 966}]}
            ],
        },
    }
    deleted_at_sample = []

    def get(_url, params):
        deleted_at_sample.append(len(session.deleted))
        return ReportResponse(json.dumps(streams[params["src"]]).encode())

    session.get = Mock(side_effect=get)
    for trigger in ("playing", "startup", "unmuted", "audio_check"):
        assert await viewer.record_browser_report({"trigger": trigger})
    assert len(viewer.playback_evidence["relay"]) == 4
    await socket.queue.put(_text({"type": "fallback", "reason": "playback_timeout"}))
    assert (await client.receive_json())["event"] == {"type": "fallback"}
    assert viewer.jpeg
    expected = {
        "trigger": "fallback",
        "source_h264_packets": 204,
        "output_h264_packets": 204,
        "audio_late": True,
        "source_aac_packets": 966,
        "output_opus_packets": 966,
    }
    assert viewer.playback_evidence["relay"][-1] == expected
    assert session.get.call_count == 10
    # Both streams still existed in go2rtc when they were sampled.
    assert deleted_at_sample == [0] * 10
    # The card's own fallback sample adds a browser row and no second relay row.
    assert await viewer.record_browser_report({"trigger": "fallback", "painted": 198})
    assert session.get.call_count == 10
    assert len(viewer.playback_evidence["relay"]) == 5
    await socket.queue.put(
        SimpleNamespace(type=aiohttp.WSMsgType.BINARY, data=b"\xff\xd8\xff\xd9")
    )
    assert (await client.receive_json())["event"]["type"] == "frame"
    with patch.object(
        viewer.coordinator.api,
        "request",
        AsyncMock(
            return_value={"schema": 2, "last_discovery": [], "recent_events": []}
        ),
    ):
        download = await async_get_config_entry_diagnostics(
            hass, viewer.coordinator.entry
        )
    live = download["live_playback"][0]
    assert live["fallback"] == "playback_timeout"
    assert [row["trigger"] for row in live["relay"]] == [
        "playing",
        "startup",
        "unmuted",
        "audio_check",
        "fallback",
    ]
    assert live["relay"][-1] == expected
    assert live["browser"][-1]["trigger"] == "fallback"
    await client.close()
    await hass.async_block_till_done()
    assert len(session.deleted) == 2


async def test_ha_requested_fallback_still_samples_go2rtc_at_the_bridge_message(
    hass, hass_ws_client, rtc_setup
):
    socket, _, session, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client)
    await ready(client, socket)
    data = json.dumps(
        {
            "producers": [
                {"receivers": [{"codec": {"codec_name": "H264"}, "packets": 9}]}
            ]
        }
    ).encode()
    session.get = Mock(return_value=ReportResponse(data))
    viewer.fallback_supported = True
    assert await viewer.fallback("playback_error")
    assert socket.acks == ["fallback:playback_error"]
    # A browser sample after the request no longer samples go2rtc.
    assert await viewer.record_browser_report({"trigger": "startup"})
    session.get.assert_not_called()
    await socket.queue.put(_text({"type": "fallback", "reason": "playback_error"}))
    assert (await client.receive_json())["event"] == {"type": "fallback"}
    assert viewer.playback_evidence["relay"] == [
        {"trigger": "fallback", "source_h264_packets": 9}
    ]
    await client.close()
    await hass.async_block_till_done()


@pytest.mark.parametrize("failure", ["http", "timeout", "before_ready"])
async def test_unavailable_go2rtc_at_the_fallback_never_delays_the_jpeg_switch(
    hass, hass_ws_client, rtc_setup, failure
):
    socket, rest, session, _ = rtc_setup
    client, viewer = await open_viewer(hass, hass_ws_client)
    response = ReportResponse(b"{}")
    session.get = Mock(return_value=response)
    if failure == "http":
        session.get.side_effect = aiohttp.ClientError()
    elif failure == "timeout":
        response.content.readexactly = AsyncMock(side_effect=TimeoutError())
    if failure != "before_ready":
        await ready(client, socket)
    await socket.queue.put(_text({"type": "fallback", "reason": "startup_timeout"}))
    assert (await client.receive_json())["event"] == {"type": "fallback"}
    await socket.queue.put(SimpleNamespace(type=aiohttp.WSMsgType.BINARY, data=b"jpeg"))
    assert (await client.receive_json())["event"]["type"] == "frame"
    assert viewer.jpeg and not viewer.closed
    assert viewer.playback_evidence["relay"] == []
    if failure == "before_ready":
        session.get.assert_not_called()
        rest.streams.add.assert_not_awaited()
    else:
        assert session.get.call_count == 1
    await client.close()
    await hass.async_block_till_done()
