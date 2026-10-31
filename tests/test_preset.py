"""Preset moves (issue #229): protocol flag, capability, client errors, buttons."""

import copy
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from aiohttp import ClientSession, web
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er

from custom_components.eufy_viewer.api import (
    PRESET_ERRORS,
    BridgeAuthError,
    BridgeClient,
    BridgeError,
    BridgePresetError,
    BridgeState,
)
from custom_components.eufy_viewer.button import presettable
from custom_components.eufy_viewer.const import DOMAIN

from .conftest import STATE
from .test_button import setup_bridge, update

MOVE = "custom_components.eufy_viewer.api.BridgeClient.move_to_preset"
START = "custom_components.eufy_viewer.coordinator.EufyCoordinator.start"
COMPONENT = Path(__file__).parents[1] / "custom_components" / "eufy_viewer"
BUTTONS = [f"button.front_door_move_to_preset_{n}" for n in range(1, 5)]


def preset_state(available=True, flag=1, **data):
    """A bridge that advertises the route and the camera's preset capability."""
    state = copy.deepcopy(STATE)
    state["preset_move"] = flag
    state["cameras"][0]["capabilities"] = {
        "presets": {"available": available, "status": "experimental", "reason": None}
    }
    state.update(data)
    return state


def test_state_advertises_preset_move_only_for_exact_version():
    default = BridgeState.parse(STATE)
    assert default.preset_move is False
    for value, supported in [
        (1, True),
        (True, False),
        ("1", False),
        (1.0, False),
        (2, False),
        (0, False),
        (None, False),
    ]:
        state = BridgeState.parse(
            {**STATE, "preset_move": value, "snapshot_refresh": 1}
        )
        assert state.preset_move is supported
        # The new last field leaves the positional fields before it in place.
        assert state.snapshot_refresh is True


def test_presets_capability_is_optional_and_strict():
    camera = BridgeState.parse(STATE).cameras["CAM123"]
    # An older bridge reports no presets. permits() would admit an absent key,
    # so the buttons must not use it.
    assert "presets" not in camera.capabilities
    assert camera.permits("presets")
    assert not presettable(BridgeState.parse({**STATE, "preset_move": 1}), camera)
    data = copy.deepcopy(STATE)
    data["cameras"][0]["capabilities"] = {
        "presets": {
            "available": False,
            "status": "unsupported",
            "reason": "operation_outside_hardware_scope",
            "private_extra": "discard",
        }
    }
    camera = BridgeState.parse(data).cameras["CAM123"]
    assert camera.capabilities == {
        "presets": {
            "available": False,
            "status": "unsupported",
            "reason": "operation_outside_hardware_scope",
        }
    }
    data["cameras"][0]["capabilities"]["presets"] = {
        "available": True,
        "status": "future",
        "reason": "secret upstream detail",
    }
    camera = BridgeState.parse(data).cameras["CAM123"]
    assert camera.capabilities["presets"] == {
        "available": True,
        "status": "unknown",
        "reason": None,
    }
    for value in ([], {}, {"available": "true"}, {"available": 1}, None):
        data["cameras"][0]["capabilities"]["presets"] = value
        with pytest.raises(BridgeError):
            BridgeState.parse(data)


@pytest.mark.parametrize(
    "flag,capability,expected",
    [
        (1, {"available": True}, True),
        (1, {"available": False}, False),
        (None, {"available": True}, False),
        (1, None, False),
    ],
)
def test_presettable_needs_the_route_and_an_explicit_capability(
    flag, capability, expected
):
    data = copy.deepcopy(STATE)
    data["preset_move"] = flag
    if capability is not None:
        data["cameras"][0]["capabilities"] = {"presets": capability}
    state = BridgeState.parse(data)
    assert presettable(state, state.cameras["CAM123"]) is expected
    assert presettable(state, None) is False


async def preset_server(aiohttp_server, handler):
    app = web.Application()
    app.router.add_post("/v1/cameras/{serial}/preset", handler)
    server = await aiohttp_server(app)
    return str(server.make_url(""))


async def test_move_to_preset_posts_once_and_validates_the_body(
    aiohttp_server, socket_enabled
):
    calls = []
    bodies: list[object] = [
        {"accepted": True},
        [],
        {},
        {"accepted": False},
        {"accepted": 1},
        {"accepted": "true"},
        None,
    ]

    async def move(request):
        calls.append(
            (request.method, request.match_info["serial"], await request.json())
        )
        assert request.headers["Authorization"] == "Bearer test"
        return web.json_response(bodies[len(calls) - 1])

    url = await preset_server(aiohttp_server, move)
    async with ClientSession() as session:
        api = BridgeClient(session, url, "test")
        assert await api.move_to_preset("CAM123", 0) is None
        assert calls == [("POST", "CAM123", {"preset": 0})]
        for _ in bodies[1:]:
            with pytest.raises(BridgeError) as error:
                await api.move_to_preset("CAM123", 3)
            assert not isinstance(error.value, BridgePresetError)
    assert calls[1:] == [("POST", "CAM123", {"preset": 3})] * (len(bodies) - 1)


@pytest.mark.parametrize(
    "preset", [-1, 4, 1.5, 1.0, "1", True, False, None, "PRESET_1"]
)
async def test_move_to_preset_refuses_invalid_presets_before_any_request(
    aiohttp_server, socket_enabled, preset
):
    calls = []

    async def move(request):
        calls.append(request)
        return web.json_response({"accepted": True})

    url = await preset_server(aiohttp_server, move)
    async with ClientSession() as session:
        with pytest.raises(BridgeError) as error:
            await BridgeClient(session, url, "test").move_to_preset("CAM123", preset)
    assert not isinstance(error.value, BridgePresetError)
    assert calls == []


@pytest.mark.parametrize("code,status", sorted(PRESET_ERRORS.items()))
async def test_move_to_preset_forwards_allowlisted_errors(
    aiohttp_server, socket_enabled, code, status
):
    async def rejected(_request):
        return web.json_response({"error": code, "detail": "secret"}, status=status)

    url = await preset_server(aiohttp_server, rejected)
    async with ClientSession() as session:
        api = BridgeClient(session, url, "test")
        with pytest.raises(BridgePresetError) as error:
            await api.move_to_preset("CAM123", 1)
    assert (error.value.code, error.value.status) == (code, status)
    assert "secret" not in str(error.value)


@pytest.mark.parametrize(
    "status,body",
    [
        (400, {"error": "invalid_preset"}),
        (503, {"error": "secret"}),
        (409, {"error": "preset_rejected"}),
        (502, {"error": "station_busy"}),
        (504, {"error": "not_found"}),
        (404, {"error": "capability_unavailable"}),
        (503, {"error": "preset_unconfirmed"}),
        (500, {"error": "preset_unconfirmed"}),
        (400, {"error": "request_failed"}),
        (504, ["preset_unconfirmed"]),
        (502, {"error": 502}),
        (503, "<html>secret</html>"),
        (503, {"error": "not_connected", "detail": "x" * 5000}),
    ],
)
async def test_move_to_preset_keeps_other_errors_generic(
    aiohttp_server, socket_enabled, status, body
):
    async def rejected(_request):
        if isinstance(body, str):
            return web.Response(text=body, status=status, content_type="text/html")
        return web.json_response(body, status=status)

    url = await preset_server(aiohttp_server, rejected)
    async with ClientSession() as session:
        api = BridgeClient(session, url, "test")
        with pytest.raises(BridgeError) as error:
            await api.move_to_preset("CAM123", 2)
    assert not isinstance(error.value, BridgePresetError)
    assert "secret" not in str(error.value)


async def test_preset_codes_apply_only_to_the_preset_route(
    aiohttp_server, socket_enabled
):
    async def busy(_request):
        return web.json_response({"error": "station_busy"}, status=409)

    app = web.Application()
    app.router.add_post("/v1/cameras/{serial}/preset/extra", busy)
    app.router.add_post("/v1/stations/{serial}/mode", busy)
    server = await aiohttp_server(app)
    async with ClientSession() as session:
        api = BridgeClient(session, str(server.make_url("")), "test")
        for path in ("/v1/cameras/CAM123/preset/extra", "/v1/stations/HB3/mode"):
            with pytest.raises(BridgeError) as error:
                await api.request("POST", path, {})
            assert not isinstance(error.value, BridgePresetError)


async def test_move_to_preset_reports_a_rejected_token(aiohttp_server, socket_enabled):
    async def unauthorized(_request):
        return web.Response(status=401)

    url = await preset_server(aiohttp_server, unauthorized)
    async with ClientSession() as session:
        with pytest.raises(BridgeAuthError):
            await BridgeClient(session, url, "test").move_to_preset("CAM123", 0)


async def test_buttons_appear_only_with_the_route_and_the_capability(hass, bridge):
    with patch(START), patch(MOVE, new_callable=AsyncMock) as move:
        entry = await setup_bridge(hass, bridge, STATE)
        assert hass.states.get("camera.front_door")
        # An older bridge has neither the route nor the capability.
        assert all(hass.states.get(button) is None for button in BUTTONS)
        for data in (
            preset_state(flag=None),
            preset_state(available=False),
            {**preset_state(), "cameras": STATE["cameras"]},
        ):
            await update(hass, entry, data)
            assert all(hass.states.get(button) is None for button in BUTTONS)
        # A capability that becomes available later still gets the buttons, also
        # for a camera that already has its refresh button.
        await update(
            hass,
            entry,
            {
                **preset_state(available=False),
                "snapshot_refresh": 1,
            },
        )
        assert hass.states.get("button.front_door_refresh_snapshot")
        await update(hass, entry, {**preset_state(), "snapshot_refresh": 1})
        assert [hass.states.get(button).state for button in BUTTONS] == ["unknown"] * 4
        assert hass.states.get("button.front_door_refresh_snapshot")
        registry = er.async_get(hass)
        assert [
            registry.async_get_entity_id("button", DOMAIN, f"CAM123_preset_{n}")
            for n in range(1, 5)
        ] == BUTTONS
        for n, button in enumerate(BUTTONS, start=1):
            assert hass.states.get(button).name == f"Front door Move to preset {n}"
            entity = registry.async_get(button)
            assert entity.entity_category is None
            assert entity.disabled_by is None
        # A second update adds no duplicates.
        await update(hass, entry, {**preset_state(), "snapshot_refresh": 1})
        assert len(hass.states.async_entity_ids("button")) == 5
        # Nothing moves on setup or on an inventory update.
        move.assert_not_called()
        assert await hass.config_entries.async_unload(entry.entry_id)


async def test_buttons_created_at_setup_and_their_availability(hass, bridge):
    with patch(START):
        entry = await setup_bridge(hass, bridge, preset_state())
        assert [hass.states.get(button).state for button in BUTTONS] == ["unknown"] * 4
        for data in (
            STATE,
            preset_state(flag=None),
            preset_state(available=False),
            {**preset_state(), "cameras": STATE["cameras"]},
            preset_state(auth="error"),
            preset_state(cameras=[]),
        ):
            await update(hass, entry, data)
            assert [hass.states.get(button).state for button in BUTTONS] == [
                "unavailable"
            ] * 4
        await update(hass, entry, preset_state())
        assert [hass.states.get(button).state for button in BUTTONS] == ["unknown"] * 4
        assert await hass.config_entries.async_unload(entry.entry_id)


async def test_each_press_sends_one_move_to_the_wire_index(hass, bridge):
    with patch(START), patch(MOVE, AsyncMock(return_value=None)) as move:
        entry = await setup_bridge(hass, bridge, preset_state())
        move.assert_not_called()
        for n, button in enumerate(BUTTONS, start=1):
            await hass.services.async_call(
                "button", "press", {"entity_id": button}, blocking=True
            )
            move.assert_awaited_once_with("CAM123", n - 1)
            assert hass.states.get(button).state != "unknown"
            move.reset_mock()
        assert await hass.config_entries.async_unload(entry.entry_id)


@pytest.mark.parametrize(
    "error,key",
    [
        (
            BridgePresetError("capability_unavailable", 503),
            "preset_capability_unavailable",
        ),
        (BridgePresetError("not_connected", 503), "preset_not_connected"),
        (BridgePresetError("preset_not_sent", 503), "preset_not_sent"),
        (BridgePresetError("station_busy", 409), "preset_station_busy"),
        (BridgePresetError("preset_rejected", 502), "preset_rejected"),
        (BridgePresetError("preset_unconfirmed", 504), "preset_unconfirmed"),
        (BridgePresetError("not_found", 404), "preset_not_found"),
        (BridgeError("secret"), "preset_failed"),
        (BridgeAuthError("secret"), "preset_failed"),
    ],
)
async def test_press_errors_use_translated_messages(hass, bridge, error, key):
    messages = json.loads((COMPONENT / "translations/en.json").read_text())
    with patch(START), patch(MOVE, AsyncMock(side_effect=error)) as move:
        entry = await setup_bridge(hass, bridge, preset_state())
        with pytest.raises(HomeAssistantError) as raised:
            await hass.services.async_call(
                "button", "press", {"entity_id": BUTTONS[1]}, blocking=True
            )
        # A failed move is never repeated.
        move.assert_awaited_once_with("CAM123", 1)
        assert raised.value.translation_domain == DOMAIN
        assert raised.value.translation_key == key
        # Home Assistant drops the final period of a translated message.
        assert str(raised.value) == messages["exceptions"][key]["message"][:-1]
        assert "secret" not in str(raised.value)
        assert await hass.config_entries.async_unload(entry.entry_id)
