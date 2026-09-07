"""Push/outage semantics and cancellation, without cloud or polling."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import aiohttp
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.eufy_viewer.api import BridgeAuthError, BridgeClient, BridgeState
from custom_components.eufy_viewer.const import DOMAIN
from custom_components.eufy_viewer.coordinator import EufyCoordinator

from .conftest import STATE
from .test_config_flow import DATA
from .test_viewers import MediaSocket


async def test_push_then_disconnect_closes_viewers(hass):
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    api = AsyncMock(spec=BridgeClient)
    socket = MediaSocket()
    api.websocket.return_value = socket
    coordinator = EufyCoordinator(hass, entry, api)
    coordinator.async_set_updated_data(BridgeState.parse(STATE))
    stopped = asyncio.Event()
    close = AsyncMock(side_effect=stopped.set)
    with patch.object(coordinator, "close_viewers", close):
        coordinator.start()
        updated = {**STATE, "cameras": [{**STATE["cameras"][0], "battery": 18}]}
        await socket.queue.put(
            SimpleNamespace(type=aiohttp.WSMsgType.TEXT, json=lambda: updated)
        )
        await hass.async_block_till_done()
        assert coordinator.data.cameras["CAM123"].battery == 18
        await socket.queue.put(SimpleNamespace(type=aiohttp.WSMsgType.CLOSE))
        await asyncio.wait_for(stopped.wait(), 1)
        assert not coordinator.last_update_success
        await coordinator.close()
        assert socket.closed.is_set()
        api.state.assert_not_called()


async def test_bridge_auth_failure_requests_reauth_without_retry(hass):
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    api = AsyncMock(spec=BridgeClient)
    api.websocket.side_effect = BridgeAuthError()
    coordinator = EufyCoordinator(hass, entry, api)
    with patch.object(type(entry), "async_start_reauth") as reauth:
        await coordinator._listen()
        reauth.assert_called_once()
        assert api.websocket.call_count == 1
        assert not coordinator.last_update_success


async def test_account_expiry_ends_viewers_and_requests_reauth(hass):
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    api = AsyncMock(spec=BridgeClient)
    socket = MediaSocket()
    api.websocket.return_value = socket
    coordinator = EufyCoordinator(hass, entry, api)
    with (
        patch.object(type(entry), "async_start_reauth") as reauth,
        patch.object(coordinator, "close_viewers", AsyncMock()) as close,
    ):
        coordinator.start()
        await socket.queue.put(
            SimpleNamespace(
                type=aiohttp.WSMsgType.TEXT, json=lambda: {**STATE, "auth": "error"}
            )
        )
        await hass.async_block_till_done()
        reauth.assert_called_once()
        close.assert_awaited_once()
        await coordinator.close()


async def test_bridge_restart_waits_for_session_without_reauth(hass):
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    api = AsyncMock(spec=BridgeClient)
    socket = MediaSocket()
    api.websocket.return_value = socket
    coordinator = EufyCoordinator(hass, entry, api)
    coordinator.async_set_updated_data(BridgeState.parse(STATE))
    with (
        patch.object(type(entry), "async_start_reauth") as reauth,
        patch.object(coordinator, "close_viewers", AsyncMock()) as close,
    ):
        coordinator.start()
        await socket.queue.put(
            SimpleNamespace(
                type=aiohttp.WSMsgType.TEXT,
                json=lambda: {**STATE, "auth": "connecting", "cameras": []},
            )
        )
        await hass.async_block_till_done()
        close.assert_awaited_once()
        reauth.assert_not_called()
        await socket.queue.put(
            SimpleNamespace(type=aiohttp.WSMsgType.TEXT, json=lambda: STATE)
        )
        await hass.async_block_till_done()
        assert coordinator.data.auth == "connected"
        assert "CAM123" in coordinator.data.cameras
        reauth.assert_not_called()
        await coordinator.close()
