"""Push setup, dynamic discovery, snapshots, diagnostics and unloading."""

from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.components.lovelace import LOVELACE_DATA
from homeassistant.config_entries import ConfigEntryState
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_fire_time_changed,
)

from custom_components.eufy_viewer.api import BridgeState
from custom_components.eufy_viewer.const import CARD_URL, DOMAIN
from custom_components.eufy_viewer.diagnostics import async_get_config_entry_diagnostics

from .conftest import STATE
from .test_config_flow import DATA


async def test_setup_discovery_unload(hass, bridge):
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    with (
        patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"),
        patch(
            "custom_components.eufy_viewer.api.BridgeClient.snapshot",
            AsyncMock(return_value=b"image"),
        ),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        camera = hass.states.get("camera.front_door")
        assert camera is not None
        assert camera.state == "idle"
        assert camera.attributes["supported_features"] == 0
        assert hass.states.get("sensor.front_door_battery").state == "72"
        updated = {
            **STATE,
            "cameras": [
                {**STATE["cameras"][0], "battery": 55},
                {**STATE["cameras"][0], "serial": "CAM2", "name": "Back door"},
            ],
        }
        entry.runtime_data.async_set_updated_data(BridgeState.parse(updated))
        await hass.async_block_till_done()
        assert hass.states.get("sensor.front_door_battery").state == "55"
        assert hass.states.get("camera.back_door")
        diagnostics = await async_get_config_entry_diagnostics(hass, entry)
        assert "CAM123" not in str(diagnostics) and DATA["token"] not in str(
            diagnostics
        )
        coordinator = entry.runtime_data
        assert await hass.config_entries.async_unload(entry.entry_id)
        await hass.async_block_till_done()
        assert not coordinator.viewers


async def test_camera_snapshots_never_offer_stream(hass):
    from custom_components.eufy_viewer.api import BridgeClient, BridgeError
    from custom_components.eufy_viewer.camera import EufyCamera
    from custom_components.eufy_viewer.coordinator import EufyCoordinator

    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    api = AsyncMock(spec=BridgeClient)
    coordinator = EufyCoordinator(hass, entry, api)
    coordinator.async_set_updated_data(BridgeState.parse(STATE))
    camera = EufyCamera(coordinator, coordinator.data.cameras["CAM123"])
    camera.hass = hass
    for image in (b"\xff\xd8\xff\xd9", b"\x89PNG\r\n\x1a\nimage"):
        api.snapshot.return_value = image
        assert await camera.async_camera_image() == image
    assert camera.content_type == "image/png"
    assert await camera.stream_source() is None
    api.websocket.assert_not_called()
    api.snapshot.side_effect = BridgeError()
    assert await camera.async_camera_image() is None
    coordinator.async_set_updated_data(BridgeState.parse({**STATE, "cameras": []}))
    assert not camera.available
    assert await camera.async_camera_image() is None


async def test_setup_distinguishes_retry_auth_and_wrong_identity(hass):
    import pytest
    from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady

    from custom_components.eufy_viewer import async_setup_entry
    from custom_components.eufy_viewer.api import BridgeAuthError, BridgeError

    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    with patch("custom_components.eufy_viewer.api.BridgeClient.state") as state:
        for error, expected in [
            (BridgeError(), ConfigEntryNotReady),
            (BridgeAuthError(), ConfigEntryAuthFailed),
        ]:
            state.side_effect = error
            with pytest.raises(expected):
                await async_setup_entry(hass, entry)
        state.side_effect = None
        state.return_value = BridgeState.parse({**STATE, "bridge_id": "different"})
        with pytest.raises(ConfigEntryNotReady):
            await async_setup_entry(hass, entry)
        state.return_value = BridgeState.parse({**STATE, "auth": "error"})
        with pytest.raises(ConfigEntryAuthFailed):
            await async_setup_entry(hass, entry)


async def test_startup_waits_for_bridge_then_loads_without_reauth(hass, bridge):
    """A running HTTP server does not mean the saved Eufy session is ready."""
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    state, _ = bridge
    state.return_value = BridgeState.parse({**STATE, "auth": "connecting"})
    with (
        patch.object(type(entry), "async_start_reauth") as reauth,
        patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"),
    ):
        assert not await hass.config_entries.async_setup(entry.entry_id)
        assert entry.state is ConfigEntryState.SETUP_RETRY
        reauth.assert_not_called()
        state.return_value = BridgeState.parse(STATE)
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=10))
        await hass.async_block_till_done(wait_background_tasks=True)
        assert entry.state is ConfigEntryState.LOADED
        assert hass.states.get("camera.front_door").state == "idle"
        reauth.assert_not_called()
        assert await hass.config_entries.async_unload(entry.entry_id)


@pytest.mark.parametrize(
    "component_loaded", [False, True], ids=["cold-start", "add-bridges"]
)
async def test_two_bridges_share_frontend_registration_and_reload(
    hass, component_loaded
):
    import asyncio

    from custom_components.eufy_viewer.api import BridgeClient

    await async_setup_component(hass, "http", {})
    # A cold component setup owns loading every registered entry. Only call
    # individual entry setup concurrently after the component is loaded.
    if component_loaded:
        assert await async_setup_component(hass, DOMAIN, {})
    shared = hass.data.get(DOMAIN)
    one = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    two = MockConfigEntry(
        domain=DOMAIN,
        unique_id="bridge-456",
        data={**DATA, "url": "http://second:8080"},
    )
    one.add_to_hass(hass)
    two.add_to_hass(hass)

    state_calls = []

    async def state(client):
        state_calls.append(client.url)
        if client.url == DATA["url"]:
            return BridgeState.parse(STATE)
        return BridgeState.parse(
            {
                **STATE,
                "bridge_id": "bridge-456",
                "cameras": [
                    {**STATE["cameras"][0], "serial": "OTHER", "name": "Other camera"}
                ],
            }
        )

    with (
        patch.object(BridgeClient, "state", state),
        patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"),
    ):
        if component_loaded:
            assert all(
                await asyncio.gather(
                    hass.config_entries.async_setup(one.entry_id),
                    hass.config_entries.async_setup(two.entry_id),
                )
            )
        else:
            assert await async_setup_component(hass, DOMAIN, {})
            shared = hass.data[DOMAIN]
        await hass.async_block_till_done()
        assert hass.states.get("camera.front_door")
        assert hass.states.get("camera.other_camera")
        assert one.state is ConfigEntryState.LOADED
        assert two.state is ConfigEntryState.LOADED
        assert sorted(state_calls) == sorted([DATA["url"], "http://second:8080"])
        assert hass.data[DOMAIN] is shared
        assert await hass.config_entries.async_reload(one.entry_id)
        await hass.async_block_till_done()
        assert hass.states.get("camera.front_door").state == "idle"
        assert hass.states.get("camera.other_camera").state == "idle"
        assert state_calls.count(DATA["url"]) == 2
        assert state_calls.count("http://second:8080") == 1
        assert hass.data[DOMAIN] is shared
        assert await hass.config_entries.async_unload(one.entry_id)
        assert await hass.config_entries.async_unload(two.entry_id)
        resources = hass.data[LOVELACE_DATA].resources.async_items()
        assert len(resources) == 1
        assert resources[0]["url"].startswith(f"{CARD_URL}?v=")
