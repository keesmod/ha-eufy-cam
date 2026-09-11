"""Prepare the device baseline before a bridge update and transfer it locally."""

from typing import Any

from homeassistant.components import persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .api import BridgeClient, BridgeError, BridgeState
from .const import DOMAIN


async def prepare_migration(
    hass: HomeAssistant, entry: ConfigEntry, api: BridgeClient, state: BridgeState
) -> BridgeState:
    """Never replace the pre-upgrade baseline with a partial new inventory."""
    if state.bridge_id != entry.unique_id:
        raise BridgeError("Bridge identity changed")
    if state.backend is None:
        return state
    store: Store[dict[str, Any]] = Store(
        hass, 1, f"{DOMAIN}.migration.{entry.entry_id}"
    )
    saved = await store.async_load()
    notification_id = f"{DOMAIN}_migration_{entry.entry_id}"
    if not state.migration:
        if saved is None and state.auth == "connected" and state.cameras:
            await store.async_save(
                {
                    "version": 1,
                    "bridge_id": state.bridge_id,
                    "backend": state.backend,
                    "cameras": sorted(state.cameras),
                    "stations": sorted(state.stations),
                }
            )
            persistent_notification.async_create(
                hass,
                "Your camera list is saved. Back up Home Assistant, then update the "
                "Eufy bridge. "
                "Keep your existing integration and bridge data.",
                title="Eufy: ready for the bridge update",
                notification_id=notification_id,
            )
        return state
    if state.migration_error == "inventory_required" and saved is not None:
        if saved.get("bridge_id") != state.bridge_id:
            raise BridgeError("Migration baseline belongs to another bridge")
        result = await api.request("POST", "/v1/migration", saved)
        if not isinstance(result, dict) or result.get("accepted") is not True:
            raise BridgeError("Migration baseline was not accepted")
        state = await api.state()
    if state.migration_error:
        persistent_notification.async_create(
            hass,
            "The camera update needs attention. Keep your existing integration. "
            "[Open the short recovery steps]"
            "(https://github.com/keesmod/ha-eufy-cam/blob/main/docs/MEGA_MIGRATION.md#recovery).",
            title="Eufy: migration paused",
            notification_id=notification_id,
        )
        raise BridgeError("Camera migration requires attention")
    if state.auth == "connected":
        persistent_notification.async_dismiss(hass, notification_id)
    return state
