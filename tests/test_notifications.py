"""Live alerts stay scoped, fresh and distinct from inventory refreshes."""

from datetime import timedelta
from unittest.mock import patch

import pytest
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.eufy_viewer.api import BridgeError, BridgeState
from custom_components.eufy_viewer.const import DOMAIN

from .conftest import STATE
from .test_config_flow import DATA


async def test_event_entity_bus_privacy_dedup_and_health(hass, bridge):
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    with patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        coordinator = entry.runtime_data
        events = []
        remove = hass.bus.async_listen("eufy_viewer_event", events.append)
        payload = {
            "bridge_id": "bridge-123",
            "serial": "CAM123",
            "id": "one",
            "event_type": "person",
            "person_name": "Peter",
            "recognition": "known",
            "occurred_at": dt_util.utcnow().isoformat(),
            "source": "push",
            "received_at": dt_util.utcnow().isoformat(),
            "pin": "SECRET",
        }
        coordinator.receive_notification(payload)
        coordinator.receive_notification(payload)
        await hass.async_block_till_done()
        assert len(events) == 1
        assert "SECRET" not in str(events[0].data)
        state = hass.states.get("event.front_door_event")
        assert state.attributes["event_type"] == "person"
        assert state.attributes["person_name"] == "Peter"
        assert events[0].data["recognition"] == "known"
        for changes in (
            {"serial": "OTHER"},
            {"event_type": "bad"},
            {"received_at": "bad"},
            {"received_at": "2020-01-01T00:00:00Z"},
            {"received_at": dt_util.utcnow().replace(tzinfo=None).isoformat()},
            {"source": "bad"},
            {"id": ""},
        ):
            coordinator.receive_notification({**payload, "id": "two", **changes})
        coordinator.receive_notification(
            {
                **payload,
                "id": "old",
                "received_at": (dt_util.utcnow() - timedelta(minutes=5)).isoformat(),
            }
        )
        with pytest.raises(BridgeError):
            coordinator.receive_notification({**payload, "bridge_id": "other"})
        coordinator.async_set_updated_data(
            BridgeState.parse(
                {**STATE, "notification_metrics": {"push_connected": True}}
            )
        )
        await hass.async_block_till_done()
        assert len(events) == 1
        assert hass.states.get("binary_sensor.eufy_push_connection").state == "on"
        coordinator.receive_notification(
            {
                **payload,
                "id": "two",
                "event_type": "notification",
                "person_name": None,
                "recognition": "not_applicable",
                "source": "push",
                "eufy_type": 123,
                "eufy_event_type": 2,
                "event_time": 1234,
            }
        )
        await hass.async_block_till_done()
        assert len(events) == 2
        assert events[1].data["eufy_event_type"] == 2
        remove()
        assert await hass.config_entries.async_unload(entry.entry_id)


async def test_notifications_arrive_over_existing_socket(hass):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    import aiohttp

    from custom_components.eufy_viewer.api import BridgeClient
    from custom_components.eufy_viewer.coordinator import EufyCoordinator

    from .test_viewers import MediaSocket

    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    api = AsyncMock(spec=BridgeClient)
    socket = MediaSocket()
    api.websocket.return_value = socket
    coordinator = EufyCoordinator(hass, entry, api)
    coordinator.async_set_updated_data(BridgeState.parse(STATE))
    delivered = []
    remove = hass.bus.async_listen("eufy_viewer_event", delivered.append)
    coordinator.start()
    try:
        await socket.queue.put(
            SimpleNamespace(
                type=aiohttp.WSMsgType.TEXT,
                json=lambda: {
                    "type": "notification",
                    "bridge_id": "bridge-123",
                    "serial": "CAM123",
                    "id": "ws",
                    "event_type": "ring",
                    "source": "device",
                    "received_at": dt_util.utcnow().isoformat(),
                },
            )
        )
        await hass.async_block_till_done()
        assert len(delivered) == 1
        assert coordinator.last_update_success
        api.websocket.assert_called_once_with("/v1/events?notifications=1")
    finally:
        remove()
        await coordinator.close()
