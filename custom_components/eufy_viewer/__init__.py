"""Eufy Security Viewer integration."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.const import EVENT_HOMEASSISTANT_STOP, Platform
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .accessory import sync_accessory_devices
from .api import AccessoryInfo, BridgeAuthError, BridgeClient, BridgeError
from .const import CARD_URL, CONF_TOKEN, CONF_URL, DOMAIN
from .coordinator import EufyConfigEntry, EufyCoordinator
from .migration import prepare_migration
from .playback import PlaybackView, PreparePlaybackView
from .recordings import EventsView, RecordingsView
from .resources import async_register_card
from .viewers import async_register_commands

PLATFORMS = [
    Platform.CAMERA,
    Platform.EVENT,
    Platform.BINARY_SENSOR,
    Platform.SENSOR,
    Platform.ALARM_CONTROL_PANEL,
    Platform.SELECT,
    Platform.BUTTON,
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
    playback = PlaybackView(hass.config.path(".eufy_recordings"))
    hass.http.register_view(PreparePlaybackView(playback))
    hass.http.register_view(playback)
    hass.http.register_view(RecordingsView())
    hass.http.register_view(EventsView())
    async_register_commands(hass)
    hass.data[DOMAIN] = {"viewers": {}, "playback": playback}
    await async_register_card(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: EufyConfigEntry) -> bool:
    """Validate bridge identity and set up push entities."""
    api = BridgeClient(
        async_get_clientsession(hass), entry.data[CONF_URL], entry.data[CONF_TOKEN]
    )
    try:
        state = await api.state()
        state = await prepare_migration(hass, entry, api, state)
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
    # Chimes have no entities, so their devices are registered here. Sensors and
    # keypads are registered the same way before their entities are added.
    devices: dict[str, AccessoryInfo] = {}

    @callback
    def forget(serial: str) -> None:
        # HA clears the via link of every device under a removed HomeBase, so
        # its accessories are registered again when it returns.
        for key, info in list(devices.items()):
            if key == serial or info.station == serial:
                del devices[key]

    entry.async_on_unload(coordinator.on_forget(forget))
    sync_accessory_devices(hass, entry, devices)
    entry.async_on_unload(
        coordinator.async_add_listener(
            lambda: sync_accessory_devices(hass, entry, devices)
        )
    )
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    async def shutdown(_: Event) -> None:
        hass.data[DOMAIN]["playback"].close_entry(entry.entry_id)
        await coordinator.close()

    entry.async_on_unload(
        hass.bus.async_listen_once(
            EVENT_HOMEASSISTANT_STOP,
            shutdown,
        )
    )
    coordinator.start()
    return True


async def async_remove_config_entry_device(
    hass: HomeAssistant, entry: EufyConfigEntry, device: dr.DeviceEntry
) -> bool:
    """Allow removing a device only after it left the bridge inventory.

    Only a connected bridge frame lists the full inventory. While the bridge
    connects or needs a login, its frames are empty, so nothing is removable.
    """
    coordinator = getattr(entry, "runtime_data", None)
    if coordinator is None or not coordinator.last_update_success:
        return False
    data = coordinator.data
    if data is None or data.auth != "connected":
        return False
    serials = [serial for domain, serial in device.identifiers if domain == DOMAIN]
    if any(
        serial in data.cameras or serial in data.stations or serial in data.accessories
        for serial in serials
    ):
        return False
    # Home Assistant removes the device and its entities next. If the bridge
    # lists it again, the platforms add it anew.
    for serial in serials:
        coordinator.forget(serial)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: EufyConfigEntry) -> bool:
    """Stop all viewers before removing entities."""
    hass.data[DOMAIN]["playback"].close_entry(entry.entry_id)
    await entry.runtime_data.close()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
