"""Push battery state for cameras which actually report it."""

from __future__ import annotations

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.const import PERCENTAGE
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import CameraInfo
from .coordinator import EufyConfigEntry, EufyCoordinator
from .entity import EufyEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: EufyConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Add battery sensors when the device reports a battery property."""
    known: set[str] = set()

    @callback
    def discover() -> None:
        new = [
            info
            for serial, info in entry.runtime_data.data.cameras.items()
            if serial not in known and info.battery is not None
        ]
        known.update(info.serial for info in new)
        async_add_entities(EufyBattery(entry.runtime_data, info) for info in new)

    discover()
    entry.async_on_unload(entry.runtime_data.async_add_listener(discover))


class EufyBattery(EufyEntity, SensorEntity):
    """The latest battery value delivered by Eufy."""

    _attr_device_class = SensorDeviceClass.BATTERY
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_translation_key = "battery"

    def __init__(self, coordinator: EufyCoordinator, info: CameraInfo) -> None:
        super().__init__(coordinator, info)
        self._attr_unique_id = f"{info.serial}_battery"

    @property
    def native_value(self) -> float | None:
        """Return cached battery percentage."""
        return self.info.battery if self.info else None
