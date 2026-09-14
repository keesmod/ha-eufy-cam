"""Support downloads stay bounded and private, including failed HA setup."""

import json
from unittest.mock import AsyncMock, patch

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.eufy_viewer.api import BridgeError
from custom_components.eufy_viewer.const import DOMAIN
from custom_components.eufy_viewer.diagnostics import (
    _fields,
    _version,
    async_get_config_entry_diagnostics,
    audio_report,
    support_report,
)

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
            "first_data_ms": 120001,
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
