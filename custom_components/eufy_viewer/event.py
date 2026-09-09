"""Camera events for UI automations, without polling or starting cameras."""

from homeassistant.components.event import EventEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import CameraInfo
from .coordinator import EufyConfigEntry, EufyCoordinator
from .entity import EufyEntity
from .notifications import EVENT_TYPES, notification_signal


async def async_setup_entry(
    hass: HomeAssistant, entry: EufyConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Discover an event entity for every camera, including later additions."""
    known: set[str] = set()

    @callback
    def discover() -> None:
        new = [
            info
            for serial, info in entry.runtime_data.data.cameras.items()
            if serial not in known
        ]
        known.update(info.serial for info in new)
        async_add_entities(EufyCameraEvent(entry.runtime_data, info) for info in new)

    discover()
    entry.async_on_unload(entry.runtime_data.async_add_listener(discover))


class EufyCameraEvent(EufyEntity, EventEntity):
    """Last real event. Restored state is never emitted as a new event."""

    _attr_translation_key = "camera_event"
    _attr_event_types = EVENT_TYPES

    def __init__(self, coordinator: EufyCoordinator, info: CameraInfo) -> None:
        super().__init__(coordinator, info)
        self._attr_unique_id = f"{info.serial}_event"

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                notification_signal(self.coordinator.entry.entry_id),
                self._receive,
            )
        )

    @callback
    def _receive(self, event: dict) -> None:
        if event["serial"] == self.serial:
            self._trigger_event(
                event["event_type"],
                {key: value for key, value in event.items() if key != "event_type"},
            )
            self.async_write_ha_state()
