"""Support downloads stay bounded and private, including failed HA setup."""

import json
from pathlib import Path
from time import monotonic
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.eufy_viewer.api import BridgeError, BridgeState
from custom_components.eufy_viewer.const import DOMAIN
from custom_components.eufy_viewer.diagnostics import (
    _fields,
    _version,
    async_get_config_entry_diagnostics,
    audio_report,
    support_report,
)

from .conftest import STATE
from .test_config_flow import DATA

STAMP = "2026-09-11T12:00:00.000Z"


def test_audio_evidence_is_bounded_and_contains_no_payload_or_identifiers():
    row = {
        "attempt": 123,
        "model": "T8134",
        "state": "ended",
        "initial_codec": "none",
        "first_data_codec": "aac-lc",
        "admission": "excluded",
        "header": "adts",
        "metadata_ms": 3000,
        "first_data_ms": 5000,
        "first_data_after_metadata_ms": 2000,
        "duration_ms": 10000,
        "chunks": 12,
        "bytes": 1200,
    }
    result = support_report(
        {
            "schema": 2,
            "last_discovery": [],
            "recent_events": [],
            "live_audio": [{**row, "payload": "PRIVATE", "serial": "PRIVATE"}] * 10,
        }
    )
    assert result["live_audio"] == [row] * 8
    invalid = audio_report(
        {
            "attempt": True,
            "model": "T8134\nPRIVATE",
            "state": "PRIVATE",
            "initial_codec": [],
            "first_data_codec": "PRIVATE",
            "header": "PRIVATE",
            "admission": "PRIVATE",
            "bytes": -1,
            "chunks": 2**31,
            "first_data_ms": 3600001,
            "duration_ms": 2.5,
            "payload": "PRIVATE",
        }
    )
    assert "PRIVATE" not in json.dumps(invalid)
    assert set(invalid) == {"model"}
    assert audio_report(None) == {}


def test_report_projects_values_and_never_passes_unknown_fields():
    row = {
        "diagnostic": "discovery",
        "schema": 2,
        "timestamp": STAMP,
        "event": "device",
        "ref": 2,
        "owner_ref": 1,
        "model": "T8160",
        "firmware": "3.4.3.0",
        "hardware": "1",
        "station_status": "not_applicable",
        "owner_status": "connected",
        "station_connected": None,
        "owner_connected": True,
        "software": {
            "bridge": "0.8.5",
            "library": "0.12.2",
            "node": "24.21.0",
            "platform": "linux",
            "arch": "x64",
            "token": "PRIVATE",
        },
        "media": {
            "snapshot": {
                "available": True,
                "status": "experimental",
                "reason": None,
                "url": "PRIVATE",
            },
            "live": None,
            "recordings": {},
        },
        "token": "PRIVATE",
        "name": "PRIVATE",
        "deviceId": "PRIVATE",
        "context": {"parentId": "PRIVATE"},
    }
    result = support_report(
        {
            "schema": 2,
            "generated_at": STAMP,
            "last_discovery": [row],
            "recent_events": [{"event": "fault", "code": "connection_failed"}],
        }
    )
    assert "PRIVATE" not in json.dumps(result)
    assert result["last_discovery"][0]["owner_connected"] is True
    assert result["last_discovery"][0]["owner_status"] == "connected"
    assert result["last_discovery"][0]["media"]["snapshot"]["available"] is True
    assert result["recent_events"][0]["code"] == "connection_failed"
    assert _fields(None) == {}


def test_report_bounds_malformed_values_and_collection_sizes():
    row = {
        "event": "issue",
        "code": "PRIVATE",
        "owner_ref": True,
        "report": -1,
        "device_type": 65536,
        "model": "T8160\nPRIVATE",
        "firmware": "PRIVATE",
        "owner_connected": "PRIVATE",
        "timestamp": "PRIVATE",
        "media": [],
        "software": "PRIVATE",
    }
    result = support_report(
        {
            "schema": 2,
            "generated_at": "PRIVATE",
            "last_discovery": [row] * 250,
            "recent_events": [row] * 150,
        }
    )
    assert len(result["last_discovery"]) == 200
    assert len(result["recent_events"]) == 100
    assert "PRIVATE" not in json.dumps(result)
    assert result["last_discovery"][0]["device_type"] is None
    assert result["last_discovery"][0]["owner_ref"] is None
    assert support_report(
        {"schema": 2, "last_discovery": [], "recent_events": None}
    ) == {"status": "invalid_report"}
    assert (
        support_report(
            {
                "schema": 2,
                "last_discovery": [None, {"event": []}, {"event": "PRIVATE"}],
                "recent_events": [],
            }
        )["last_discovery"]
        == []
    )
    for value in (None, [], {"schema": True}, {"schema": 1}):
        assert support_report(value) == {"status": "unsupported_schema"}
    for value in (None, [], 12, "1\n", "1" * 20, "PRIVATE"):
        assert _version(value) == "unavailable"


@pytest.mark.parametrize(
    "failure", [None, BridgeError("PRIVATE"), TimeoutError("PRIVATE")]
)
async def test_download_without_successful_setup(hass, failure):
    entry = MockConfigEntry(domain=DOMAIN, unique_id="PRIVATE", data=DATA)
    entry.add_to_hass(hass)
    response = {
        "schema": 2,
        "generated_at": STAMP,
        "last_discovery": [{"event": "summary", "outcome": "camera_inventory_empty"}],
        "recent_events": [],
    }
    with patch(
        "custom_components.eufy_viewer.api.BridgeClient.request",
        AsyncMock(return_value=response, side_effect=failure),
    ) as request:
        result = await async_get_config_entry_diagnostics(hass, entry)
    request.assert_awaited_once_with("GET", "/v1/diagnostics")
    assert result["active_viewers"] == 0
    assert result["bridge_available"] is None
    assert result["home_assistant"] != "unavailable"
    assert result["integration"] != "unavailable"
    assert "PRIVATE" not in json.dumps(result) and DATA["token"] not in json.dumps(
        result
    )
    if failure:
        assert result["support"] == {"status": "unavailable"}
    else:
        assert (
            result["support"]["last_discovery"][0]["outcome"]
            == "camera_inventory_empty"
        )


def test_extended_audio_report_projects_header_timing_and_pipeline_only():
    from custom_components.eufy_viewer.diagnostics import audio_format_report

    header = {
        "mpeg_version": 4,
        "object_type": 2,
        "sample_rate_hz": 16000,
        "channel_config": 1,
        "crc_present": False,
        "frame_bytes": 123,
        "raw_data_blocks": 1,
    }
    fmt = {
        "inspected_bytes": 123,
        "inspection_limited": False,
        "format_hint": "adts",
        "first_adts": header,
        "adts": header,
        "adts_frames": 1,
        "adts_header_changes": 0,
        "adts_multiblock_frames": 0,
        "skipped_bytes": 0,
        "pending_frame_bytes": 0,
        "trailing_header_bytes": 0,
        "adts_min_frame_bytes": 123,
        "adts_max_frame_bytes": 123,
    }
    row = {
        "firmware": "3.3.6.0",
        "owner_model": "T8030",
        "owner_firmware": "3.8.5.2",
        "stop_confirmed": True,
        "stream_ended": True,
        "stream_destroyed": True,
        "initial_buffered_bytes": 123,
        "buffered_bytes": 0,
        "last_data_ms": 6000,
        "last_data_age_ms": 1000,
        "max_gap_ms": 30,
        "min_chunk_bytes": 12,
        "max_chunk_bytes": 123,
        "latest_codec": "none",
        "format": fmt,
        "pipeline": [{"event": "media_audio_error", "elapsed_ms": 6001}],
    }
    assert audio_report(row) == row
    # A raised session cap keeps rows of long sessions up to one hour.
    long_row = {
        **row,
        "duration_ms": 1800000,
        "pipeline": [
            {"event": "media_audio_error", "elapsed_ms": 3600000},
            {"event": "media_audio_error", "elapsed_ms": 3600001},
        ],
    }
    assert audio_report(long_row)["duration_ms"] == 1800000
    assert audio_report(long_row)["pipeline"] == [
        {"event": "media_audio_error", "elapsed_ms": 3600000}
    ]
    assert "duration_ms" not in audio_report({**row, "duration_ms": 3600001})
    bad = audio_format_report(
        {
            "format_hint": "PRIVATE",
            "inspected_bytes": 262145,
            "adts_frames": True,
            "adts": {
                "payload": "PRIVATE",
                "object_type": 5,
                "sample_rate_hz": 13,
                "mpeg_version": 3,
                "crc_present": "PRIVATE",
            },
        }
    )
    assert bad == {"adts": {}}
    assert audio_format_report(None) == {}
    bad_row = audio_report(
        {
            "firmware": "PRIVATE",
            "owner_model": "PRIVATE",
            "owner_firmware": "PRIVATE",
            "format": {"payload": "PRIVATE"},
            "pipeline": [
                {"event": "media_audio_error", "elapsed_ms": True},
                {"event": "PRIVATE", "elapsed_ms": 1},
                None,
            ],
        }
    )
    assert "PRIVATE" not in json.dumps(bad_row)
    assert bad_row["pipeline"] == []


_CODE_CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "diagnostic-codes.json").read_text()
)


@pytest.mark.parametrize("code", _CODE_CASES["accepted"])
def test_machine_codes_survive_download_without_enumerating_codes(code):
    row = {
        "event": "station_connection",
        "phase": "connect",
        "status": "error",
        "reason": code,
        "code": code,
        "outcome": code,
        "relationship_reason": code,
        "media": {
            feature: {"available": False, "status": "unsupported", "reason": code}
            for feature in ("snapshot", "live", "recordings")
        },
    }
    result = support_report(
        {"schema": 2, "last_discovery": [row], "recent_events": [row]}
    )
    assert result["last_discovery"] == [row]
    assert result["recent_events"] == [row]


@pytest.mark.parametrize("value", _CODE_CASES["rejected"])
def test_invalid_code_values_still_rejected_without_coercion(value):
    assert _fields(
        dict.fromkeys(("code", "reason", "outcome", "relationship_reason"), value)
    ) == dict.fromkeys(("code", "reason", "outcome", "relationship_reason"))


async def test_timeout_and_future_codes_reach_failed_setup_download(hass):
    entry = MockConfigEntry(domain=DOMAIN, unique_id="PRIVATE", data=DATA)
    entry.add_to_hass(hass)
    events = [
        {
            "event": "station_connection",
            "phase": "connect",
            "reason": "device_request_timeout",
        },
        {"event": "fault", "code": "future_station_handshake_failed"},
    ]
    with patch(
        "custom_components.eufy_viewer.api.BridgeClient.request",
        AsyncMock(
            return_value={"schema": 2, "last_discovery": [], "recent_events": events}
        ),
    ):
        result = await async_get_config_entry_diagnostics(hass, entry)
    assert result["support"]["recent_events"] == events
    assert "PRIVATE" not in json.dumps(result)


async def test_download_keeps_live_evidence_for_the_cap_plus_fifteen_minutes(hass):
    """A session that ran to a raised cap is still in a download after its end."""
    entry = MockConfigEntry(domain=DOMAIN, unique_id="PRIVATE", data=DATA)
    entry.add_to_hass(hass)
    now = monotonic()
    reports = [
        {"_created": now - 2800, "acks": 1},
        {"_created": now - 1700, "acks": 2},
        {"_created": now - 800, "acks": 3},
    ]
    support = {
        "schema": 2,
        "generated_at": STAMP,
        "last_discovery": [],
        "recent_events": [],
        "live_audio": [
            {"attempt": 1, "age_ms": 2_800_000},
            {"attempt": 2, "age_ms": 1_700_000},
            {"attempt": 3, "age_ms": 800_000},
        ],
    }

    def runtime(state: BridgeState) -> SimpleNamespace:
        return SimpleNamespace(
            api=SimpleNamespace(request=AsyncMock(return_value=support)),
            data=state,
            live_diagnostics=reports,
            viewers={},
            last_update_success=True,
            recording_diagnostics=SimpleNamespace(
                report=lambda: {"schema": 1, "attempts": [], "expired": 0}
            ),
        )

    # With the bridge cap at 1800 s the window is 2700 s for playback and audio.
    entry.runtime_data = runtime(
        BridgeState.parse({**STATE, "live_max_seconds_mains": 1800})
    )
    result = await async_get_config_entry_diagnostics(hass, entry)
    assert [live["acks"] for live in result["live_playback"]] == [2, 3]
    assert [row["attempt"] for row in result["support"]["live_audio"]] == [2, 3]
    assert "recent_live_playback_not_recorded" not in result["assessment"].get(
        "missing_evidence", []
    )
    # A bridge at the default cap keeps the fifteen-minute window plus 120 s.
    entry.runtime_data = runtime(BridgeState.parse(STATE))
    result = await async_get_config_entry_diagnostics(hass, entry)
    assert [live["acks"] for live in result["live_playback"]] == [3]
    assert [row["attempt"] for row in result["support"]["live_audio"]] == [3]
    assert "PRIVATE" not in json.dumps(result)


def test_video_evidence_is_bounded_and_contains_no_identifiers_or_encoder_text():
    from custom_components.eufy_viewer.diagnostic_assessment import assess
    from custom_components.eufy_viewer.diagnostics import video_report

    row = {
        "attempt": 123,
        "audio_attempt": 456,
        "age_ms": 30000,
        "model": "T8425",
        "state": "ended",
        "codec": "h264",
        "duration_ms": 20828,
        "encoder": {"mode": "nvidia", "exits": 1},
        "input": {
            "chunks": 300,
            "bytes": 4785975,
            "first_data_ms": 900,
            "last_data_ms": 14900,
            "last_data_age_ms": 5928,
            "max_gap_ms": 210,
        },
        "output": {
            "chunks": 2500,
            "bytes": 4785975,
            "first_data_ms": 1100,
            "last_data_ms": 15000,
            "last_data_age_ms": 5828,
            "max_gap_ms": 200,
        },
        "jpeg": {"chunks": 0, "bytes": 0},
        "readers": {
            "attached": 1,
            "backpressure": 0,
            "closed": 0,
            "revoked": 1,
            "last_destroy_ms": 20828,
        },
        "audio_readers": {"attached": 1, "backpressure": 0, "closed": 0, "revoked": 1},
        "pipeline": [
            {"event": "media_active_nvidia", "elapsed_ms": 1100},
            {"event": "fallback_playback_timeout", "elapsed_ms": 20828},
        ],
    }
    result = support_report(
        {
            "schema": 2,
            "last_discovery": [],
            "recent_events": [],
            "live_video": [{**row, "stderr": "PRIVATE", "serial": "PRIVATE"}] * 10,
        }
    )
    assert result["live_video"] == [row] * 8
    invalid = video_report(
        {
            "attempt": True,
            "audio_attempt": 2**48,
            "model": "T8425\nPRIVATE",
            "state": "PRIVATE",
            "codec": "PRIVATE",
            "duration_ms": 3600001,
            "encoder": {"mode": "PRIVATE", "exits": -1, "software_fallback_ms": 2.5},
            "input": {"chunks": 2**31, "bytes": "PRIVATE", "last_data_age_ms": -1},
            "output": "PRIVATE",
            "jpeg": {"path": "PRIVATE", "first_data_ms": 3600001},
            "readers": {"attached": True, "last_destroy_ms": 3600001},
            "audio_readers": [],
            "pipeline": [{"event": "PRIVATE", "elapsed_ms": 1}, None],
        }
    )
    assert "PRIVATE" not in json.dumps(invalid)
    assert invalid == {
        "model": "unavailable",
        "encoder": {},
        "input": {},
        "jpeg": {},
        "readers": {},
        "pipeline": [],
    }
    assert video_report(None) == {}
    # A row's own age decides its retention, even when the report is cached.
    kept = support_report(
        {
            "schema": 2,
            "last_discovery": [],
            "recent_events": [],
            "cache_age_ms": 800_000,
            "live_video": [
                {"attempt": 1, "age_ms": 899_999},
                {"attempt": 2, "age_ms": 900_000},
                {"attempt": 3},
            ],
        }
    )
    assert [r.get("attempt") for r in kept["live_video"]] == [1, 3]
    # A finished row whose input stopped more than 6 s before its end is a finding.
    assessment = assess({"support": {**result, "live_video": [row]}})
    stalls = [f for f in assessment["findings"] if f["stage"] == "video_stall"]
    assert stalls == []
    stalled = {
        **row,
        "input": {**row["input"], "last_data_age_ms": 8123},
        "output": {**row["output"], "last_data_age_ms": 7900},
        "jpeg": {"chunks": 5, "bytes": 5, "last_data_age_ms": 6001},
    }
    assessment = assess({"support": {**result, "live_video": [stalled]}})
    stalls = [f for f in assessment["findings"] if f["stage"] == "video_stall"]
    assert len(stalls) == 1
    assert stalls[0]["attempt"] == 123
    assert stalls[0]["evidence"] == "support.live_video"
    assert (
        "the P2P video input 8123 ms, the encoder output 7900 ms, the JPEG frames "
        "6001 ms had stopped" in stalls[0]["observation"]
    )
    # A session still streaming or one that stopped within 6 s adds no finding.
    for quiet in (
        {**stalled, "state": "streaming"},
        {**stalled, "input": {"last_data_age_ms": 6000}, "output": {}, "jpeg": {}},
    ):
        assessment = assess({"support": {**result, "live_video": [quiet]}})
        assert not [f for f in assessment["findings"] if f["stage"] == "video_stall"]
