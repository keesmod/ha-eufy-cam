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
    support_report,
)

from .test_config_flow import DATA

STAMP = "2026-09-11T12:00:00.000Z"


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
