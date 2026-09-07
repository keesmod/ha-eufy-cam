"""HomeBase profile selector, including Eufy schedule and geofencing."""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import StationInfo
from .coordinator import EufyConfigEntry, EufyCoordinator
from .station import MODES, EufyStationEntity


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
        async_add_entities(EufyGuardMode(entry.runtime_data, s) for s in new)

    discover()
    entry.async_on_unload(entry.runtime_data.async_add_listener(discover))


class EufyGuardMode(EufyStationEntity, SelectEntity):
    _attr_translation_key = "guard_mode"

    def __init__(self, coordinator: EufyCoordinator, info: StationInfo) -> None:
        super().__init__(coordinator, info)
        self._attr_unique_id = f"{info.serial}_guard_mode"

    @property
    def options(self) -> list[str]:
        return [MODES[mode] for mode in self.info.modes] if self.info else []

    @property
    def current_option(self) -> str | None:
        return (
            MODES.get(self.info.guard_mode)
            if self.info and self.info.guard_mode is not None
            else None
        )

    async def async_select_option(self, option: str) -> None:
        await self.set_mode(
            next(mode for mode, name in MODES.items() if name == option)
        )
