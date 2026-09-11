"""Automatic pre-upgrade inventory capture and post-upgrade transfer."""

from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.helpers.storage import Store
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.eufy_viewer.api import BridgeClient, BridgeError, BridgeState
from custom_components.eufy_viewer.const import DOMAIN
from custom_components.eufy_viewer.migration import prepare_migration

from .conftest import STATE


@pytest.mark.parametrize("backend", ["legacy", "mega"])
async def test_capture_transfer_and_preserve_expected_inventory(hass, backend):
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123")
    entry.add_to_hass(hass)
    api = AsyncMock(spec=BridgeClient)
    old = BridgeState.parse({**STATE, "backend": backend})
    store = Store(hass, 1, f"{DOMAIN}.migration.{entry.entry_id}")
    with (
        patch(
            "custom_components.eufy_viewer.migration.persistent_notification.async_create"
        ) as notify,
        patch(
            "custom_components.eufy_viewer.migration.persistent_notification.async_dismiss"
        ) as dismiss,
    ):
        assert await prepare_migration(hass, entry, api, old) == old
        saved = await store.async_load()
        assert saved == {
            "version": 1,
            "bridge_id": "bridge-123",
            "backend": backend,
            "cameras": ["CAM123"],
            "stations": [],
        }
        assert notify.call_count == 1
        partial = BridgeState.parse({**STATE, "backend": backend, "cameras": []})
        await prepare_migration(hass, entry, api, partial)
        assert await store.async_load() == saved
        new = BridgeState.parse(
            {
                **STATE,
                "backend": "mega",
                "auth": "error",
                "cameras": [],
                "migration": {"version": 1, "error": "inventory_required"},
            }
        )
        connected = BridgeState.parse(
            {**STATE, "backend": "mega", "migration": {"version": 1}}
        )
        api.request.return_value = {"accepted": True}
        api.state.return_value = connected
        assert await prepare_migration(hass, entry, api, new) == connected
        api.request.assert_awaited_once_with("POST", "/v1/migration", saved)
        assert await store.async_load() == saved
        dismiss.assert_called_once()


async def test_no_capture_of_empty_disconnected_or_new_bridge(hass):
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123")
    entry.add_to_hass(hass)
    api = AsyncMock(spec=BridgeClient)
    store = Store(hass, 1, f"{DOMAIN}.migration.{entry.entry_id}")
    with patch(
        "custom_components.eufy_viewer.migration.persistent_notification.async_dismiss"
    ):
        for payload in [
            STATE,
            {**STATE, "backend": "mega", "cameras": []},
            {**STATE, "backend": "mega", "auth": "connecting"},
            {**STATE, "backend": "mega", "migration": {"version": 1}},
        ]:
            await prepare_migration(hass, entry, api, BridgeState.parse(payload))
    assert await store.async_load() is None
    api.request.assert_not_called()


async def test_migration_failures_are_visible_and_never_erase_baseline(hass):
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123")
    entry.add_to_hass(hass)
    api = AsyncMock(spec=BridgeClient)
    store = Store(hass, 1, f"{DOMAIN}.migration.{entry.entry_id}")
    new = {
        **STATE,
        "backend": "mega",
        "migration": {"version": 1, "error": "inventory_required"},
    }
    with patch(
        "custom_components.eufy_viewer.migration.persistent_notification.async_create"
    ) as notify:
        with pytest.raises(BridgeError, match="requires attention"):
            await prepare_migration(hass, entry, api, BridgeState.parse(new))
        notify.assert_called_once()
        saved = {"bridge_id": "wrong", "cameras": ["CAM123"]}
        await store.async_save(saved)
        with pytest.raises(BridgeError, match="another bridge"):
            await prepare_migration(hass, entry, api, BridgeState.parse(new))
        saved["bridge_id"] = "bridge-123"
        await store.async_save(saved)
        api.request.return_value = {"accepted": False}
        with pytest.raises(BridgeError, match="not accepted"):
            await prepare_migration(hass, entry, api, BridgeState.parse(new))
        assert await store.async_load() == saved
        with pytest.raises(BridgeError, match="identity changed"):
            await prepare_migration(
                hass, entry, api, BridgeState.parse({**STATE, "bridge_id": "wrong"})
            )
