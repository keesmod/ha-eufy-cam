"""Station telemetry, alarm services, discovery and fail-closed behavior."""

from copy import deepcopy
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.exceptions import HomeAssistantError
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.eufy_viewer.api import BridgeError, BridgeState
from custom_components.eufy_viewer.const import DOMAIN

from .conftest import STATE
from .test_config_flow import DATA

STATION = {
    "serial": "HB3",
    "name": "HomeBase 3",
    "model": "T8030",
    "hardware": "1",
    "software": "2",
    "connected": True,
    "guard_mode": 1,
    "current_mode": 1,
    "alarm": False,
    "alarm_delay": 0,
    "arm_delay": 0,
    "modes": [0, 1, 2, 3, 4, 5, 47, 63],
}


async def test_alarm_discovery_services_and_actual_state(hass, bridge):
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    with (
        patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"),
        patch(
            "custom_components.eufy_viewer.api.BridgeClient.set_guard_mode",
            new_callable=AsyncMock,
        ) as command,
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        assert hass.states.get("alarm_control_panel.homebase_3") is None

        async def update(**values):
            entry.runtime_data.async_set_updated_data(
                BridgeState.parse({**STATE, "stations": [{**STATION, **values}]})
            )
            await hass.async_block_till_done()

        await update()
        entity = "alarm_control_panel.homebase_3"
        assert hass.states.get(entity).state == "armed_home"
        for service, mode in [
            ("alarm_arm_home", 1),
            ("alarm_arm_away", 0),
            ("alarm_disarm", 63),
            ("alarm_arm_night", 4),
            ("alarm_arm_vacation", 5),
            ("alarm_arm_custom_bypass", 3),
        ]:
            await hass.services.async_call(
                "alarm_control_panel", service, {"entity_id": entity}, blocking=True
            )
            command.assert_awaited_with("HB3", mode)
            assert hass.states.get(entity).state == "armed_home"
        selector = "select.homebase_3_guard_mode"
        for option, mode in [
            ("Home", 1),
            ("Away", 0),
            ("Schedule", 2),
            ("Geofencing", 47),
        ]:
            await hass.services.async_call(
                "select",
                "select_option",
                {"entity_id": selector, "option": option},
                blocking=True,
            )
            command.assert_awaited_with("HB3", mode)
        for values, expected in [
            ({"current_mode": 0}, "armed_away"),
            ({"current_mode": 63}, "disarmed"),
            ({"alarm_delay": 10}, "pending"),
            ({"arm_delay": 10}, "arming"),
            ({"alarm": True, "arm_delay": 10}, "triggered"),
            ({"current_mode": None}, "unknown"),
            ({"connected": False}, "unavailable"),
        ]:
            await update(**values)
            assert hass.states.get(entity).state == expected
        await update()
        command.side_effect = BridgeError("private upstream detail")
        with pytest.raises(HomeAssistantError, match="did not confirm"):
            await hass.services.async_call(
                "alarm_control_panel",
                "alarm_arm_away",
                {"entity_id": entity},
                blocking=True,
            )
        assert hass.states.get(entity).state == "armed_home"
        entry.runtime_data.async_set_updated_data(BridgeState.parse(STATE))
        await hass.async_block_till_done()
        assert hass.states.get(entity).state == "unavailable"
        assert await hass.config_entries.async_unload(entry.entry_id)


@pytest.mark.parametrize(
    "key,value",
    [
        ("connected", "yes"),
        ("current_mode", True),
        ("arm_delay", -1),
        ("alarm", 1),
        ("modes", [999]),
        ("serial", "../private"),
    ],
)
def test_invalid_station_telemetry(key, value):
    station = deepcopy(STATION)
    station[key] = value
    with pytest.raises(BridgeError):
        BridgeState.parse({**STATE, "stations": [station]})
