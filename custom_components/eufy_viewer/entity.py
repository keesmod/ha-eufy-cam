"""Shared device ownership and push availability."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .api import CameraInfo
from .const import DOMAIN
from .coordinator import EufyCoordinator


class EufyEntity(CoordinatorEntity[EufyCoordinator]):
    """An entity backed only by cached push data."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, coordinator: EufyCoordinator, info: CameraInfo) -> None:
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
    def info(self) -> CameraInfo | None:
        """Return the current inventory record, or None if removed."""
        return self.coordinator.data.cameras.get(self.serial)

    @property
    def available(self) -> bool:
        """Treat disconnection and removal as unavailable, preserving registry IDs."""
        return (
            super().available
            and self.coordinator.data.auth == "connected"
            and self.info is not None
        )
