"""Shared HomeBase ownership and command handling."""

from __future__ import annotations

from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .api import BridgeError, StationInfo
from .const import DOMAIN
from .coordinator import EufyCoordinator

MODES = {
    0: "Away",
    1: "Home",
    2: "Schedule",
    3: "Custom 1",
    4: "Custom 2",
    5: "Custom 3",
    47: "Geofencing",
    63: "Disarmed",
}


class EufyStationEntity(CoordinatorEntity[EufyCoordinator]):
    """A station is unavailable when its local connection is lost."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, coordinator: EufyCoordinator, info: StationInfo) -> None:
        super().__init__(coordinator)
        self.serial = info.serial
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, info.serial)},
            manufacturer="Eufy",
            name=info.name,
            model=info.model,
            hw_version=info.hardware,
            sw_version=info.software,
        )

    @property
    def info(self) -> StationInfo | None:
        return self.coordinator.data.stations.get(self.serial)

    @property
    def available(self) -> bool:
        return (
            super().available
            and self.coordinator.data.auth == "connected"
            and self.info is not None
            and self.info.connected
        )

    async def set_mode(self, mode: int) -> None:
        if not self.available or self.info is None or mode not in self.info.modes:
            raise HomeAssistantError("HomeBase or requested security mode unavailable")
        try:
            await self.coordinator.api.set_guard_mode(self.serial, mode)
        except BridgeError as err:
            raise HomeAssistantError("HomeBase did not confirm the command") from err
