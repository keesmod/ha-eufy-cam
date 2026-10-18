"""Explicit snapshot refresh, the only request that wakes a camera for a picture."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import BridgeError, BridgeSnapshotError, BridgeState, CameraInfo
from .const import DOMAIN
from .coordinator import EufyConfigEntry, EufyCoordinator
from .entity import EufyEntity


def refreshable(state: BridgeState, info: CameraInfo | None) -> bool:
    """The bridge must advertise the route and admit snapshot and live media."""
    return (
        state.snapshot_refresh
        and info is not None
        and info.permits("snapshot")
        and info.permits("live")
    )


async def async_setup_entry(
    hass: HomeAssistant, entry: EufyConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Add a button once the bridge and the camera's capabilities allow it."""
    known: set[str] = set()

    @callback
    def discover() -> None:
        state = entry.runtime_data.data
        new = [
            info
            for serial, info in state.cameras.items()
            if serial not in known and refreshable(state, info)
        ]
        known.update(info.serial for info in new)
        async_add_entities(
            EufySnapshotRefreshButton(entry.runtime_data, info) for info in new
        )

    discover()
    entry.async_on_unload(entry.runtime_data.async_add_listener(discover))


class EufySnapshotRefreshButton(EufyEntity, ButtonEntity):
    """Start the camera like a live viewer, keep a settled frame, then stop it."""

    _attr_translation_key = "refresh_snapshot"

    def __init__(self, coordinator: EufyCoordinator, info: CameraInfo) -> None:
        super().__init__(coordinator, info)
        self._attr_unique_id = f"{info.serial}_refresh_snapshot"

    @property
    def available(self) -> bool:
        """A bridge downgrade or a withdrawn capability disables the button."""
        return super().available and refreshable(self.coordinator.data, self.info)

    async def async_press(self) -> None:
        """Show only allowlisted bridge codes, never bridge text."""
        try:
            await self.coordinator.api.refresh_snapshot(self.serial)
        except BridgeSnapshotError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key=f"snapshot_refresh_{err.code}",
            ) from err
        except BridgeError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="snapshot_refresh_failed",
            ) from err
