"""Resolve Home Assistant's ICE configuration for one peer negotiation."""

from __future__ import annotations

import logging

from homeassistant.components.web_rtc import async_get_ice_servers
from homeassistant.core import HomeAssistant
from webrtc_models import RTCIceServer

_LOGGER = logging.getLogger(__name__)


def ice_configuration(hass: HomeAssistant) -> tuple[list[RTCIceServer], str]:
    """Refresh provider credentials per peer, without retaining them in diagnostics."""
    try:
        return (
            [
                RTCIceServer.from_dict(server.to_dict())
                for server in async_get_ice_servers(hass)
            ],
            "home_assistant",
        )
    except Exception:
        # A provider failure must not prevent direct LAN playback. Exception
        # strings can contain relay credentials, so retain only this category.
        _LOGGER.warning(
            "Home Assistant ICE configuration unavailable, trying direct ICE"
        )
        return [], "unavailable"
