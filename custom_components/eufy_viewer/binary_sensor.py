"""Push connection health and HomeBase accessory states."""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .accessory import EufyAccessoryEntity, ensure_accessory_device
from .coordinator import EufyConfigEntry, EufyCoordinator


async def async_setup_entry(
    hass: HomeAssistant, entry: EufyConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = entry.runtime_data
    async_add_entities([EufyPushConnection(coordinator)])
    known: set[str] = set()

    @callback
    def discover() -> None:
        entities: list[EufyAccessoryEntity] = []
        for serial, info in coordinator.data.accessories.items():
            if serial in known:
                continue
            known.add(serial)
            via = ensure_accessory_device(hass, entry, info)
            entities.extend(
                kind(coordinator, info, via) for kind in ENTITIES[info.category]
            )
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(coordinator.async_add_listener(discover))


class EufyPushConnection(CoordinatorEntity[EufyCoordinator], BinarySensorEntity):
    """Unknown for older bridges which do not report push health."""

    _attr_has_entity_name = True
    _attr_translation_key = "push_connection"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: EufyCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.unique_id}_push_connection"

    @property
    def is_on(self) -> bool | None:
        return self.coordinator.data.push_connected


class EufyOpening(EufyAccessoryEntity, BinarySensorEntity):
    """Open or closed as the HomeBase or a push reported it.

    A cached cloud value is never shown as the door state. The last observed
    value stays after a HomeBase reconnect, with live false until the next one.
    """

    _attr_name = None
    _attr_device_class = BinarySensorDeviceClass.OPENING
    _reading_key = "open"

    @property
    def is_on(self) -> bool | None:
        reading = self.reading
        return reading.value if reading and reading.observed else None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        reading = self.reading
        if reading is None or not reading.observed:
            return None
        return {
            "source": reading.source,
            "observed_at": reading.observed_at,
            "live": reading.live,
        }


class EufyAccessoryDiagnostic(EufyAccessoryEntity, BinarySensorEntity):
    """A diagnostic value. A cached cloud value is shown with its source."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def is_on(self) -> bool | None:
        reading = self.reading
        return reading.value if reading else None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        reading = self.reading
        if reading is None:
            return None
        return {"source": reading.source, "observed_at": reading.observed_at}


class EufyBatteryLow(EufyAccessoryDiagnostic):
    _attr_device_class = BinarySensorDeviceClass.BATTERY
    _reading_key = "battery_low"


class EufyCharging(EufyAccessoryDiagnostic):
    _attr_device_class = BinarySensorDeviceClass.BATTERY_CHARGING
    _reading_key = "charging"


# A chime is recognized only. It has a device entry and no entities.
ENTITIES: dict[str, tuple[type[EufyAccessoryEntity], ...]] = {
    "entry_sensor": (EufyOpening, EufyBatteryLow),
    "keypad": (EufyBatteryLow, EufyCharging),
    "chime": (),
}
