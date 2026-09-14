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
    viewer.jpeg = True
    assert await viewer.record_browser_report(
        {"trigger": "fallback", "video_packets": 0}
    )
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
    assert download["live_playback"][0]["browser"] == [
        msg["report"],
        {"trigger": "fallback", "video_packets": 0},
    ]
    assert download["live_playback"][0]["relay"][0]["source_h264_packets"] == 9
    assert "CAM123" not in json.dumps(download)

    await client.close()
    await other.close()
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
