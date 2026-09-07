"""HomeBase alarm state and security profiles, driven by station telemetry."""

from __future__ import annotations

from homeassistant.components.alarm_control_panel import (
    AlarmControlPanelEntity,
    AlarmControlPanelEntityFeature,
    AlarmControlPanelState,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import StationInfo
from .coordinator import EufyConfigEntry, EufyCoordinator
from .station import EufyStationEntity

STATES = {
    0: AlarmControlPanelState.ARMED_AWAY,
    1: AlarmControlPanelState.ARMED_HOME,
    3: AlarmControlPanelState.ARMED_CUSTOM_BYPASS,
    4: AlarmControlPanelState.ARMED_NIGHT,
    5: AlarmControlPanelState.ARMED_VACATION,
    6: AlarmControlPanelState.DISARMED,
    63: AlarmControlPanelState.DISARMED,
}
FEATURES = {
    0: AlarmControlPanelEntityFeature.ARM_AWAY,
    1: AlarmControlPanelEntityFeature.ARM_HOME,
    3: AlarmControlPanelEntityFeature.ARM_CUSTOM_BYPASS,
    4: AlarmControlPanelEntityFeature.ARM_NIGHT,
    5: AlarmControlPanelEntityFeature.ARM_VACATION,
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EufyConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    known: set[str] = set()

    @callback
    def discover() -> None:
        new = [
            s for key, s in entry.runtime_data.data.stations.items() if key not in known
        ]
        known.update(s.serial for s in new)
        async_add_entities(EufyAlarm(entry.runtime_data, s) for s in new)

    discover()
    entry.async_on_unload(entry.runtime_data.async_add_listener(discover))


class EufyAlarm(EufyStationEntity, AlarmControlPanelEntity):
    """Report current mode, including pending/arming/triggered without optimism."""

    _attr_name = None
    _attr_code_arm_required = False

    def __init__(self, coordinator: EufyCoordinator, info: StationInfo) -> None:
        super().__init__(coordinator, info)
        self._attr_unique_id = f"{info.serial}_alarm"

    @property
    def supported_features(self) -> AlarmControlPanelEntityFeature:
        features = AlarmControlPanelEntityFeature(0)
        for mode in self.info.modes if self.info else []:
            features |= FEATURES.get(mode, AlarmControlPanelEntityFeature(0))
        return features

    @property
    def alarm_state(self) -> AlarmControlPanelState | None:
        info = self.info
        if info is None:
            return None
        if info.alarm:
            return AlarmControlPanelState.TRIGGERED
        if info.alarm_delay > 0:
            return AlarmControlPanelState.PENDING
        if info.arm_delay > 0:
            return AlarmControlPanelState.ARMING
        return STATES.get(info.current_mode) if info.current_mode is not None else None

    async def async_alarm_disarm(self, code: str | None = None) -> None:
        await self.set_mode(63)

    async def async_alarm_arm_home(self, code: str | None = None) -> None:
        await self.set_mode(1)

    async def async_alarm_arm_away(self, code: str | None = None) -> None:
        await self.set_mode(0)

    async def async_alarm_arm_custom_bypass(self, code: str | None = None) -> None:
        await self.set_mode(3)

    async def async_alarm_arm_night(self, code: str | None = None) -> None:
        await self.set_mode(4)

    async def async_alarm_arm_vacation(self, code: str | None = None) -> None:
        await self.set_mode(5)
