"""Explicit snapshot refresh: protocol flag, client errors and the button."""

import copy
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from aiohttp import ClientSession, web
from homeassistant.exceptions import HomeAssistantError
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.eufy_viewer.api import (
    PRESET_ERRORS,
    SNAPSHOT_ERRORS,
    BridgeAuthError,
    BridgeClient,
    BridgeError,
    BridgeSnapshotError,
    BridgeState,
)
from custom_components.eufy_viewer.button import preset_error_key
from custom_components.eufy_viewer.const import DOMAIN
from custom_components.eufy_viewer.diagnostics import video_report

from .conftest import STATE
from .test_config_flow import DATA

BUTTON = "button.front_door_refresh_snapshot"
REFRESH = "custom_components.eufy_viewer.api.BridgeClient.refresh_snapshot"
COMPONENT = Path(__file__).parents[1] / "custom_components" / "eufy_viewer"


def test_state_advertises_snapshot_refresh_only_for_exact_version():
    default = BridgeState.parse(STATE)
    assert default.snapshot_refresh is False
    assert default.live_max_seconds_mains == 120
    for value, supported in [
        (1, True),
        (True, False),
        ("1", False),
        (1.0, False),
        (2, False),
        (None, False),
    ]:
        state = BridgeState.parse(
            {
                **STATE,
                "snapshot_refresh": value,
                "recording_playback": 1,
                "live_max_seconds_mains": 1800,
            }
        )
        assert state.snapshot_refresh is supported
        # The new last field leaves the positional fields before it in place.
        assert state.recording_playback is True
        assert state.live_max_seconds_mains == 1800


async def refresh_server(aiohttp_server, handler):
    app = web.Application()
    app.router.add_post("/v1/snapshot/{serial}/refresh", handler)
    server = await aiohttp_server(app)
    return str(server.make_url(""))


async def test_refresh_snapshot_posts_once_and_validates_the_body(
    aiohttp_server, socket_enabled
):
    calls = []
    bodies: list[object] = [
        {"snapshot_received_at": "2026-10-18T10:00:00.000Z"},
        [],
        {},
        {"snapshot_received_at": ""},
        {"snapshot_received_at": 1},
        {"snapshot_received_at": None},
        {"snapshot_received_at": "x" * 65},
    ]

    async def refresh(request):
        calls.append((request.method, request.match_info["serial"]))
        assert request.headers["Authorization"] == "Bearer test"
        return web.json_response(bodies[len(calls) - 1])

    url = await refresh_server(aiohttp_server, refresh)
    async with ClientSession() as session:
        api = BridgeClient(session, url, "test")
        assert await api.refresh_snapshot("CAM123") == "2026-10-18T10:00:00.000Z"
        assert calls == [("POST", "CAM123")]
        for _ in bodies[1:]:
            with pytest.raises(BridgeError) as error:
                await api.refresh_snapshot("CAM123")
            assert not isinstance(error.value, BridgeSnapshotError)
    assert calls == [("POST", "CAM123")] * len(bodies)


@pytest.mark.parametrize("code,status", sorted(SNAPSHOT_ERRORS.items()))
async def test_refresh_snapshot_forwards_allowlisted_errors(
    aiohttp_server, socket_enabled, code, status
):
    async def rejected(_request):
        return web.json_response({"error": code, "detail": "secret"}, status=status)

    url = await refresh_server(aiohttp_server, rejected)
    async with ClientSession() as session:
        api = BridgeClient(session, url, "test")
        with pytest.raises(BridgeSnapshotError) as error:
            await api.refresh_snapshot("CAM123")
    assert (error.value.code, error.value.status) == (code, status)
    assert "secret" not in str(error.value)


@pytest.mark.parametrize(
    "status,body",
    [
        (409, {"error": "secret"}),
        (503, {"error": "station_limit"}),
        (409, {"error": "refresh_timeout"}),
        (404, {"error": "camera_busy"}),
        (500, {"error": "refresh_failed"}),
        (400, {"error": "not_found"}),
        (409, ["station_limit"]),
        (409, {"error": 409}),
        (502, "<html>secret</html>"),
    ],
)
async def test_refresh_snapshot_keeps_other_errors_generic(
    aiohttp_server, socket_enabled, status, body
):
    async def rejected(_request):
        if isinstance(body, str):
            return web.Response(text=body, status=status, content_type="text/html")
        return web.json_response(body, status=status)

    url = await refresh_server(aiohttp_server, rejected)
    async with ClientSession() as session:
        api = BridgeClient(session, url, "test")
        with pytest.raises(BridgeError) as error:
            await api.refresh_snapshot("CAM123")
    assert not isinstance(error.value, BridgeSnapshotError)
    assert "secret" not in str(error.value)


async def test_refresh_snapshot_reports_a_rejected_token(
    aiohttp_server, socket_enabled
):
    async def unauthorized(_request):
        return web.Response(status=401)

    url = await refresh_server(aiohttp_server, unauthorized)
    async with ClientSession() as session:
        with pytest.raises(BridgeAuthError):
            await BridgeClient(session, url, "test").refresh_snapshot("CAM123")


def test_every_error_code_has_a_message_in_each_language():
    expected = (
        {f"snapshot_refresh_{code}" for code in SNAPSHOT_ERRORS}
        | {"snapshot_refresh_failed"}
        | {preset_error_key(code) for code in PRESET_ERRORS}
        | {"preset_failed"}
    )
    assert {preset_error_key(code) for code in PRESET_ERRORS} == {
        "preset_capability_unavailable",
        "preset_not_connected",
        "preset_not_sent",
        "preset_station_busy",
        "preset_rejected",
        "preset_unconfirmed",
        "preset_not_found",
    }
    for path in ("strings.json", "translations/en.json", "translations/nl.json"):
        data = json.loads((COMPONENT / path).read_text(encoding="utf-8"))
        assert set(data["exceptions"]) == expected
        # Home Assistant drops the final period, the tests rely on it.
        assert all(row["message"].endswith(".") for row in data["exceptions"].values())
        assert data["entity"]["button"]["refresh_snapshot"]["name"]
        assert "{number}" in data["entity"]["button"]["preset"]["name"]


def test_diagnostics_keep_the_snapshot_refresh_pipeline_event():
    pipeline = [{"event": "snapshot_refresh", "elapsed_ms": 4}]
    assert video_report({"pipeline": pipeline})["pipeline"] == pipeline


def refresh_state(**camera):
    """A bridge that advertises the refresh, with optional camera fields."""
    data = copy.deepcopy(STATE)
    data["snapshot_refresh"] = 1
    data["cameras"][0].update(camera)
    return data


def media(snapshot=True, live=True):
    return {
        "capabilities": {
            "snapshot": {"available": snapshot, "status": "experimental"},
            "live": {"available": live, "status": "experimental"},
        }
    }


async def setup_bridge(hass, bridge, data):
    assert await async_setup_component(hass, "http", {})
    bridge[0].return_value = BridgeState.parse(data)
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def update(hass, entry, data):
    entry.runtime_data.async_set_updated_data(BridgeState.parse(data))
    await hass.async_block_till_done()


async def test_button_appears_only_when_the_bridge_and_camera_allow_it(hass, bridge):
    with (
        patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"),
        patch(REFRESH, new_callable=AsyncMock) as refresh,
    ):
        entry = await setup_bridge(hass, bridge, STATE)
        assert hass.states.get("camera.front_door")
        # An older bridge does not advertise the route.
        assert hass.states.get(BUTTON) is None
        await update(hass, entry, refresh_state(**media(live=False)))
        assert hass.states.get(BUTTON) is None
        await update(hass, entry, refresh_state(**media(snapshot=False)))
        assert hass.states.get(BUTTON) is None
        # A capability that becomes available later still gets the button.
        await update(hass, entry, refresh_state(**media()))
        assert hass.states.get(BUTTON).state == "unknown"
        await update(
            hass,
            entry,
            {
                **refresh_state(),
                "cameras": [
                    refresh_state()["cameras"][0],
                    {**STATE["cameras"][0], "serial": "CAM2", "name": "Back door"},
                ],
            },
        )
        assert hass.states.get("button.back_door_refresh_snapshot")
        assert entry.runtime_data.data.snapshot_refresh
        # Nothing is refreshed on setup or on an inventory update.
        refresh.assert_not_called()
        assert await hass.config_entries.async_unload(entry.entry_id)


async def test_button_created_at_setup_and_its_availability(hass, bridge):
    with patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"):
        entry = await setup_bridge(hass, bridge, refresh_state())
        assert hass.states.get(BUTTON).state == "unknown"
        for data in (
            STATE,
            refresh_state(**media(live=False)),
            refresh_state(**media(snapshot=False)),
            {**refresh_state(), "auth": "error"},
            {**refresh_state(), "cameras": []},
        ):
            await update(hass, entry, data)
            assert hass.states.get(BUTTON).state == "unavailable"
        await update(hass, entry, refresh_state())
        assert hass.states.get(BUTTON).state == "unknown"
        assert await hass.config_entries.async_unload(entry.entry_id)


async def test_press_refreshes_once(hass, bridge):
    with (
        patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"),
        patch(REFRESH, AsyncMock(return_value="2026-10-18T10:00:00.000Z")) as refresh,
    ):
        entry = await setup_bridge(hass, bridge, refresh_state())
        refresh.assert_not_called()
        await hass.services.async_call(
            "button", "press", {"entity_id": BUTTON}, blocking=True
        )
        refresh.assert_awaited_once_with("CAM123")
        assert hass.states.get(BUTTON).state != "unknown"
        assert await hass.config_entries.async_unload(entry.entry_id)


@pytest.mark.parametrize(
    "error,key",
    [
        *(
            (BridgeSnapshotError(code, status), f"snapshot_refresh_{code}")
            for code, status in sorted(SNAPSHOT_ERRORS.items())
        ),
        (BridgeError("secret"), "snapshot_refresh_failed"),
        (BridgeAuthError("secret"), "snapshot_refresh_failed"),
    ],
)
async def test_press_errors_use_translated_messages(hass, bridge, error, key):
    messages = json.loads((COMPONENT / "translations/en.json").read_text())
    with (
        patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"),
        patch(REFRESH, AsyncMock(side_effect=error)),
    ):
        entry = await setup_bridge(hass, bridge, refresh_state())
        with pytest.raises(HomeAssistantError) as raised:
            await hass.services.async_call(
                "button", "press", {"entity_id": BUTTON}, blocking=True
            )
        assert raised.value.translation_domain == DOMAIN
        assert raised.value.translation_key == key
        # Home Assistant drops the final period of a translated message.
        assert str(raised.value) == messages["exceptions"][key]["message"][:-1]
        assert "secret" not in str(raised.value)
        assert await hass.config_entries.async_unload(entry.entry_id)
