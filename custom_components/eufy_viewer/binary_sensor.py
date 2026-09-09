"""Expose the Eufy push connection separately from cloud login."""

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .coordinator import EufyConfigEntry, EufyCoordinator


async def async_setup_entry(
    hass: HomeAssistant, entry: EufyConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    async_add_entities([EufyPushConnection(entry.runtime_data)])


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
