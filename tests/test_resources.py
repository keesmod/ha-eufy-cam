"""Dashboard registration against Home Assistant's real resource storage."""

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.components.lovelace import LOVELACE_DATA, LovelaceData
from homeassistant.components.lovelace.dashboard import LovelaceStorage
from homeassistant.components.lovelace.resources import (
    RESOURCE_STORAGE_KEY,
    ResourceStorageCollection,
    ResourceYAMLCollection,
)
from homeassistant.const import EVENT_HOMEASSISTANT_FINAL_WRITE
from homeassistant.loader import async_get_integration
from homeassistant.setup import async_setup_component

from custom_components.eufy_viewer.const import CARD_URL, DOMAIN
from custom_components.eufy_viewer.resources import async_register_card


@pytest.fixture
def resources(hass):
    collection = ResourceStorageCollection(hass, LovelaceStorage(hass, None))
    hass.data[LOVELACE_DATA] = LovelaceData("storage", {}, collection, {})
    return collection


async def test_fresh_registration_persists_and_is_idempotent(hass, resources):
    await async_register_card(hass)
    items = resources.async_items()
    assert len(items) == 1
    version = (await async_get_integration(hass, DOMAIN)).version
    assert items[0] == {
        "id": items[0]["id"],
        "url": f"{CARD_URL}?v={version}",
        "type": "module",
    }
    with (
        patch.object(resources, "async_create_item") as create,
        patch.object(resources, "async_update_item") as update,
    ):
        await async_register_card(hass)
        create.assert_not_called()
        update.assert_not_called()

    # A new collection sees what the next HA startup will load from storage.
    hass.bus.async_fire(EVENT_HOMEASSISTANT_FINAL_WRITE)
    await hass.async_block_till_done()
    restored = ResourceStorageCollection(hass, LovelaceStorage(hass, None))
    await restored.async_get_info()
    assert restored.async_items() == items


async def test_component_registers_a_resource_that_serves_both_cards(hass, hass_client):
    assert await async_setup_component(hass, DOMAIN, {})
    items = hass.data[LOVELACE_DATA].resources.async_items()
    assert len(items) == 1
    client = await hass_client()
    response = await client.get(items[0]["url"])
    assert response.status == 200
    bundle = (
        Path(__file__).parents[1]
        / "custom_components/eufy_viewer/frontend/eufy-viewer-card.js"
    )
    assert await response.read() == bundle.read_bytes()


async def test_upgrade_loads_existing_storage_and_preserves_other_cards(
    hass, hass_storage, resources
):
    unrelated = [
        {"id": "other", "url": "/local/other-card.js?v=7", "type": "module"},
        {
            "id": "external",
            "url": f"https://example.com{CARD_URL}?v=custom",
            "type": "module",
        },
        {"id": "similar", "url": f"{CARD_URL}.backup", "type": "js"},
    ]
    hass_storage[RESOURCE_STORAGE_KEY] = {
        "version": 1,
        "data": {
            "items": [
                *unrelated,
                {"id": "keep", "url": f"{CARD_URL}?v=0.4.0", "type": "js"},
                {"id": "duplicate", "url": CARD_URL, "type": "module"},
            ]
        },
    }
    assert not resources.loaded
    await async_register_card(hass)
    assert resources.loaded
    version = (await async_get_integration(hass, DOMAIN)).version
    assert resources.async_items() == [
        *unrelated,
        {"id": "keep", "url": f"{CARD_URL}?v={version}", "type": "module"},
    ]


@pytest.mark.parametrize("current", [False, True])
async def test_yaml_resources_are_never_modified(hass, caplog, current):
    version = (await async_get_integration(hass, DOMAIN)).version
    items = [{"url": f"{CARD_URL}?v={version}", "type": "module"}] if current else []
    resources = ResourceYAMLCollection(items.copy())
    hass.data[LOVELACE_DATA] = LovelaceData("yaml", {}, resources, {})
    await async_register_card(hass)
    assert resources.async_items() == items
    assert ("YAML" in caplog.text) is not current


async def test_storage_failure_does_not_break_integration(hass, resources, caplog):
    with patch.object(
        resources, "async_get_info", AsyncMock(side_effect=OSError("read failed"))
    ):
        await async_register_card(hass)
    assert "Unable to register" in caplog.text
    assert CARD_URL in caplog.text
