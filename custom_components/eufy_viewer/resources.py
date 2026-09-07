"""Register the bundled cards without replacing unrelated dashboard resources."""

import logging

from homeassistant.components.lovelace import LOVELACE_DATA
from homeassistant.components.lovelace.resources import ResourceStorageCollection
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.loader import async_get_integration

from .const import CARD_URL, DOMAIN

_LOGGER = logging.getLogger(__name__)


async def async_register_card(hass: HomeAssistant) -> None:
    """Create or update our module once during component setup."""
    version = (await async_get_integration(hass, DOMAIN)).version
    url = f"{CARD_URL}?v={version}"
    resources = hass.data[LOVELACE_DATA].resources
    if not isinstance(resources, ResourceStorageCollection):
        if not any(
            item["url"] == url and item["type"] == "module"
            for item in resources.async_items()
        ):
            _LOGGER.warning(
                "Dashboard resources are managed in YAML. Add or update %s as a "
                "module resource in your Lovelace YAML configuration",
                url,
            )
        return

    try:
        # Listing alone does not load the collection. Load before matching so
        # existing resources survive setup before the first dashboard visit.
        await resources.async_get_info()
        matches = [
            item
            for item in resources.async_items()
            if item["url"].split("?", 1)[0].split("#", 1)[0] == CARD_URL
        ]
        if not matches:
            await resources.async_create_item({"url": url, "res_type": "module"})
            return

        first, *duplicates = matches
        if first["url"] != url or first["type"] != "module":
            await resources.async_update_item(
                first["id"], {"url": url, "res_type": "module"}
            )
        for duplicate in duplicates:
            await resources.async_delete_item(duplicate["id"])
    except HomeAssistantError, OSError:
        _LOGGER.exception(
            "Unable to register the dashboard cards automatically. Add %s as a "
            "JavaScript module in dashboard Resources, then reload the browser",
            url,
        )
