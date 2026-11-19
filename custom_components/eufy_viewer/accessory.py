"""HomeBase accessories and recognized chimes, never cameras or stations."""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .api import AccessoryInfo, Reading
from .const import DOMAIN
from .coordinator import EufyConfigEntry, EufyCoordinator
from .station import station_device_fields

# A device name for an accessory whose inventory row has no name (#275).
FALLBACK_NAMES = {
    "entry_sensor": "Entry Sensor",
    "keypad": "Keypad",
    "chime": "Doorbell Chime",
}


def accessory_device_fields(info: AccessoryInfo) -> dict[str, Any]:
    """Device fields without the HomeBase link. Empty versions stay unset."""
    return {
        "identifiers": {(DOMAIN, info.serial)},
        "manufacturer": "Eufy",
        "name": info.name or FALLBACK_NAMES.get(info.category, "Eufy accessory"),
        "model": info.model,
        "hw_version": info.hardware or None,
        "sw_version": info.software or None,
    }


def ensure_accessory_device(
    hass: HomeAssistant, entry: EufyConfigEntry, info: AccessoryInfo
) -> str | None:
    """Register the accessory device and return the id of its HomeBase device.

    The HomeBase device is registered first with exactly the fields its own
    entities use, so the link exists before any accessory entity is added.
    """
    registry = dr.async_get(hass)
    via: str | None = None
    station = (
        entry.runtime_data.data.stations.get(info.station) if info.station else None
    )
    if station is not None:
        via = registry.async_get_or_create(
            config_entry_id=entry.entry_id, **station_device_fields(station)
        ).id
    registry.async_get_or_create(
        config_entry_id=entry.entry_id,
        **accessory_device_fields(info),
        via_device_id=via,
    )
    return via


def sync_accessory_devices(
    hass: HomeAssistant, entry: EufyConfigEntry, known: dict[str, AccessoryInfo]
) -> None:
    """Register new or changed accessory devices, including chimes without entities.

    Devices of accessories that leave the inventory stay in the registry until
    the user removes them.
    """
    for serial, info in entry.runtime_data.data.accessories.items():
        old = known.get(serial)
        if old is None or _device_changed(old, info):
            ensure_accessory_device(hass, entry, info)
        known[serial] = info


def _device_changed(old: AccessoryInfo, new: AccessoryInfo) -> bool:
    return (old.name, old.model, old.hardware, old.software, old.station) != (
        new.name,
        new.model,
        new.hardware,
        new.software,
        new.station,
    )


class EufyAccessoryEntity(CoordinatorEntity[EufyCoordinator]):
    """An accessory value backed only by pushed bridge state.

    The accessory is unavailable while its HomeBase connection is lost. Its last
    observed value comes back with the connection.
    """

    _attr_has_entity_name = True
    _attr_should_poll = False
    _reading_key: str

    def __init__(
        self, coordinator: EufyCoordinator, info: AccessoryInfo, via: str | None
    ) -> None:
        super().__init__(coordinator)
        self.serial = info.serial
        self._attr_unique_id = f"{info.serial}_{self._reading_key}"
        self._attr_device_info = DeviceInfo(
            **accessory_device_fields(info),
            via_device_id=via,
        )

    @property
    def info(self) -> AccessoryInfo | None:
        return self.coordinator.data.accessories.get(self.serial)

    @property
    def reading(self) -> Reading | None:
        info = self.info
        return info.readings.get(self._reading_key) if info else None

    @property
    def available(self) -> bool:
        info = self.info
        if (
            not super().available
            or self.coordinator.data.auth != "connected"
            or info is None
        ):
            return False
        # Only HomeBase accessories have entities. A chime has a device only.
        station = (
            self.coordinator.data.stations.get(info.station) if info.station else None
        )
        return station is not None and station.connected
