"""Eufy Security Viewer integration."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.const import EVENT_HOMEASSISTANT_STOP, Platform
from homeassistant.core import Event, HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .api import BridgeAuthError, BridgeClient, BridgeError
from .const import CARD_URL, CONF_TOKEN, CONF_URL, DOMAIN
from .coordinator import EufyConfigEntry, EufyCoordinator
from .recordings import EventsView, RecordingsView
from .viewers import async_register_commands

PLATFORMS = [
    Platform.CAMERA,
    Platform.SENSOR,
    Platform.ALARM_CONTROL_PANEL,
    Platform.SELECT,
]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register shared frontend/API once, before concurrent entry setups."""
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                CARD_URL,
                str(Path(__file__).parent / "frontend" / "eufy-viewer-card.js"),
                False,
            )
        ]
    )
    hass.http.register_view(RecordingsView())
    hass.http.register_view(EventsView())
    async_register_commands(hass)
    hass.data[DOMAIN] = {"viewers": {}}
    return True


async def async_setup_entry(hass: HomeAssistant, entry: EufyConfigEntry) -> bool:
    """Validate bridge identity and set up push entities."""
    api = BridgeClient(
        async_get_clientsession(hass), entry.data[CONF_URL], entry.data[CONF_TOKEN]
    )
    try:
        state = await api.state()
    except BridgeAuthError as err:
        raise ConfigEntryAuthFailed("Bridge token was rejected") from err
    except BridgeError as err:
        raise ConfigEntryNotReady("Cannot connect to Eufy Viewer bridge") from err
    if state.bridge_id != entry.unique_id:
        raise ConfigEntryNotReady(
            "Bridge identity changed; reconfigure the integration"
        )
    if state.auth == "connecting":
        raise ConfigEntryNotReady("Eufy Viewer bridge is connecting")
    if state.auth != "connected":
        raise ConfigEntryAuthFailed("Eufy login needs attention")
    coordinator = entry.runtime_data = EufyCoordinator(hass, entry, api)
    coordinator.async_set_updated_data(state)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    async def shutdown(_: Event) -> None:
        await coordinator.close()

    entry.async_on_unload(
        hass.bus.async_listen_once(
            EVENT_HOMEASSISTANT_STOP,
            shutdown,
        )
    )
    coordinator.start()
    return True


async def async_unload_entry(hass: HomeAssistant, entry: EufyConfigEntry) -> bool:
    """Stop all viewers before removing entities."""
    await entry.runtime_data.close()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
