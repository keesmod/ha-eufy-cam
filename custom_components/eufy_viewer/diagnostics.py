"""Allowlisted diagnostics: no account, serial, endpoint, images or tokens."""

from typing import Any

from homeassistant.core import HomeAssistant

from .coordinator import EufyConfigEntry


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: EufyConfigEntry
) -> dict[str, Any]:
    """Return only operational counts and model/firmware capabilities."""
    coordinator = entry.runtime_data
    return {
        "protocol": 1,
        "bridge_available": coordinator.last_update_success,
        "account_connected": coordinator.data.auth == "connected",
        "active_viewers": len(coordinator.viewers),
        "cameras": [
            {
                "model": info.model,
                "software": info.software,
                "has_battery": info.battery is not None,
                "has_snapshot": info.snapshot_received_at is not None,
            }
            for info in coordinator.data.cameras.values()
        ],
    }
