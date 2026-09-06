"""Snapshot-only native cameras; live media requires a companion viewer lease."""

from __future__ import annotations

from typing import Any

from homeassistant.components.camera import Camera
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import BridgeError, CameraInfo
from .coordinator import EufyConfigEntry, EufyCoordinator
from .entity import EufyEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: EufyConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Discover existing and newly pushed cameras."""
    known: set[str] = set()

    @callback
    def discover() -> None:
        new = [
            info
            for serial, info in entry.runtime_data.data.cameras.items()
            if serial not in known
        ]
        known.update(info.serial for info in new)
        async_add_entities(EufyCamera(entry.runtime_data, info) for info in new)

    discover()
    entry.async_on_unload(entry.runtime_data.async_add_listener(discover))


class EufyCamera(EufyEntity, Camera):
    """Never wake a camera from image, preload, more-info or stream_source."""

    _attr_name = None
    _attr_use_stream_for_stills = False

    def __init__(self, coordinator: EufyCoordinator, info: CameraInfo) -> None:
        Camera.__init__(self)
        EufyEntity.__init__(self, coordinator, info)
        self._attr_unique_id = f"{info.serial}_camera"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose receive time honestly, without inventing capture time."""
        return {
            "snapshot_received_at": self.info.snapshot_received_at
            if self.info
            else None,
            "viewer_card": True,
            "viewer_webrtc": self.coordinator.data.webrtc,
        }

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes | None:
        """Retrieve only the bridge's latest cached picture."""
        if not self.available:
            return None
        try:
            image = await self.coordinator.api.snapshot(self.serial)
            if image:
                self.content_type = (
                    "image/png"
                    if image.startswith(b"\x89PNG\r\n\x1a\n")
                    else "image/jpeg"
                )
            return image
        except BridgeError:
            return None
