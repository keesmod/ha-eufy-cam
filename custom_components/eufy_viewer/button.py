"""Explicit camera actions that each send one request only when pressed.

Refresh snapshot is the only request that wakes a camera for a picture. The
preset buttons each send one move to a position saved in the Eufy app.
"""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import (
    BridgeError,
    BridgePresetError,
    BridgeSnapshotError,
    BridgeState,
    CameraInfo,
)
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


def presettable(state: BridgeState, info: CameraInfo | None) -> bool:
    """The bridge must advertise the route and explicitly admit presets.

    An absent capability means an older bridge or client and never admits.
    """
    return (
        state.preset_move
        and info is not None
        and info.capabilities.get("presets", {}).get("available") is True
    )


def preset_error_key(code: str) -> str:
    """Translation key of an allowlisted preset error code."""
    return code if code.startswith("preset_") else f"preset_{code}"


async def async_setup_entry(
    hass: HomeAssistant, entry: EufyConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Add buttons once the bridge and the camera's capabilities allow them."""
    known: set[str] = set()
    known_presets: set[str] = set()

    @callback
    def discover() -> None:
        state = entry.runtime_data.data
        new = [
            info
            for serial, info in state.cameras.items()
            if serial not in known and refreshable(state, info)
        ]
        known.update(info.serial for info in new)
        presets = [
            info
            for serial, info in state.cameras.items()
            if serial not in known_presets and presettable(state, info)
        ]
        known_presets.update(info.serial for info in presets)
        async_add_entities(
            [
                *(EufySnapshotRefreshButton(entry.runtime_data, info) for info in new),
                *(
                    EufyPresetButton(entry.runtime_data, info, number)
                    for info in presets
                    for number in range(1, 5)
                ),
            ]
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


class EufyPresetButton(EufyEntity, ButtonEntity):
    """Move the camera to one of the four presets saved in the Eufy app.

    The button shows the app's preset number 1 to 4 and sends index n - 1. A
    press sends one move and ends when the HomeBase accepts it, not when the
    camera stops. Nothing presses it at setup or on an inventory update.
    """

    _attr_translation_key = "preset"

    def __init__(
        self, coordinator: EufyCoordinator, info: CameraInfo, number: int
    ) -> None:
        super().__init__(coordinator, info)
        self.number = number
        self._attr_translation_placeholders = {"number": str(number)}
        self._attr_unique_id = f"{info.serial}_preset_{number}"

    @property
    def available(self) -> bool:
        """A bridge downgrade or a withdrawn capability disables the button."""
        return super().available and presettable(self.coordinator.data, self.info)

    async def async_press(self) -> None:
        """Show only allowlisted bridge codes, never bridge text."""
        try:
            await self.coordinator.api.move_to_preset(self.serial, self.number - 1)
        except BridgePresetError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key=preset_error_key(err.code),
            ) from err
        except BridgeError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="preset_failed",
            ) from err
