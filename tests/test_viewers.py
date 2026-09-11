"""Real HA WebSocket authorization and media-session teardown."""

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import aiohttp
import pytest
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.eufy_viewer.const import DOMAIN

from .test_config_flow import DATA


class MediaSocket:
    def __init__(self):
        self.queue = asyncio.Queue()
        self.closed = asyncio.Event()
        self.acks = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        self.closed.set()

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.queue.get()

    async def send_str(self, value):
        self.acks.append(value)


@pytest.fixture
async def viewer_setup(hass, bridge):
    await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    with patch("custom_components.eufy_viewer.coordinator.EufyCoordinator.start"):
        await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    yield entry
    await hass.config_entries.async_unload(entry.entry_id)


async def test_frames_ack_connection_ownership_and_close(
    hass, hass_ws_client, viewer_setup
):
    socket = MediaSocket()

    async def open_socket(path):
        assert path == "/v1/live/CAM123"
        return socket

    with patch.object(
        viewer_setup.runtime_data.api, "websocket", side_effect=open_socket
    ):
        client = await hass_ws_client(hass)
        other = await hass_ws_client(hass)
        await client.send_json(
            {"id": 1, "type": "eufy_viewer/watch", "entity_id": "camera.front_door"}
        )
        assert (await client.receive_json())["success"]
        await socket.queue.put(
            SimpleNamespace(type=aiohttp.WSMsgType.BINARY, data=b"jpeg")
        )
        frame = await client.receive_json()
        assert frame["event"]["sequence"] == 1
        await other.send_json(
            {"id": 1, "type": "eufy_viewer/ack", "subscription": 1, "sequence": 1}
        )
        assert not (await other.receive_json())["result"]["accepted"]
        assert not socket.acks
        await client.send_json(
            {"id": 2, "type": "eufy_viewer/ack", "subscription": 1, "sequence": 1}
        )
        assert (await client.receive_json())["result"]["accepted"]
        assert socket.acks == ["ack"]
        await client.send_json(
            {"id": 3, "type": "eufy_viewer/ack", "subscription": 1, "sequence": 1}
        )
        assert not (await client.receive_json())["result"]["accepted"]
        await client.send_json(
            {"id": 4, "type": "unsubscribe_events", "subscription": 1}
        )
        assert (await client.receive_json())["success"]
        await asyncio.wait_for(socket.closed.wait(), 1)
        assert not viewer_setup.runtime_data.viewers
        await client.close()
        await other.close()


async def test_disconnect_releases_camera(hass, hass_ws_client, viewer_setup):
    socket = MediaSocket()
    with patch.object(viewer_setup.runtime_data.api, "websocket", return_value=socket):
        client = await hass_ws_client(hass)
        await client.send_json(
            {"id": 1, "type": "eufy_viewer/watch", "entity_id": "camera.front_door"}
        )
        await client.receive_json()
        await hass.async_block_till_done()
        await client.close()
        await asyncio.wait_for(socket.closed.wait(), 1)
        assert not viewer_setup.runtime_data.viewers


async def test_wrong_entity_cannot_open_media(hass, hass_ws_client, viewer_setup):
    with patch.object(viewer_setup.runtime_data.api, "websocket") as open_socket:
        client = await hass_ws_client(hass)
        await client.send_json(
            {
                "id": 1,
                "type": "eufy_viewer/watch",
                "entity_id": "sensor.front_door_battery",
            }
        )
        assert not (await client.receive_json())["success"]
        open_socket.assert_not_called()
        await client.close()


async def test_unload_closes_active_viewer(hass, hass_ws_client, viewer_setup):
    socket = MediaSocket()
    coordinator = viewer_setup.runtime_data
    with patch.object(coordinator.api, "websocket", return_value=socket):
        client = await hass_ws_client(hass)
        await client.send_json(
            {"id": 1, "type": "eufy_viewer/watch", "entity_id": "camera.front_door"}
        )
        await client.receive_json()
        await hass.async_block_till_done()
        await coordinator.close()
        assert socket.closed.is_set()
        assert not coordinator.viewers
        await client.close()


async def test_permission_denied_before_camera_start(
    hass, hass_ws_client, viewer_setup
):
    from unittest.mock import Mock, PropertyMock

    client = await hass_ws_client(hass)
    permissions = Mock()
    permissions.check_entity.return_value = False
    with (
        patch(
            "homeassistant.auth.models.User.permissions",
            new_callable=PropertyMock,
            return_value=permissions,
        ),
        patch.object(viewer_setup.runtime_data.api, "websocket") as connect,
    ):
        await client.send_json(
            {"id": 1, "type": "eufy_viewer/watch", "entity_id": "camera.front_door"}
        )
        result = await client.receive_json()
        assert result["error"]["code"] == "unauthorized"
        connect.assert_not_called()
    await client.close()


async def test_bad_frame_ends_viewer_and_no_media_retry(
    hass, hass_ws_client, viewer_setup
):
    socket = MediaSocket()
    with patch.object(
        viewer_setup.runtime_data.api, "websocket", return_value=socket
    ) as connect:
        client = await hass_ws_client(hass)
        await client.send_json(
            {"id": 1, "type": "eufy_viewer/watch", "entity_id": "camera.front_door"}
        )
        await client.receive_json()
        await socket.queue.put(
            SimpleNamespace(type=aiohttp.WSMsgType.BINARY, data=b"x" * 256_001)
        )
        assert (await client.receive_json())["event"]["type"] == "ended"
        assert socket.closed.is_set()
        assert connect.call_count == 1
        await client.close()


async def test_unavailable_camera_and_viewer_limits(hass, hass_ws_client, viewer_setup):
    coordinator = viewer_setup.runtime_data
    client = await hass_ws_client(hass)
    with patch.object(coordinator.api, "websocket") as connect:
        coordinator.last_update_success = False
        await client.send_json(
            {"id": 1, "type": "eufy_viewer/watch", "entity_id": "camera.front_door"}
        )
        assert (await client.receive_json())["error"]["code"] == "unavailable"
        coordinator.last_update_success = True
        with patch.object(coordinator, "viewers", set(range(16))):
            await client.send_json(
                {"id": 2, "type": "eufy_viewer/watch", "entity_id": "camera.front_door"}
            )
            assert (await client.receive_json())["error"]["code"] == "busy"
        connect.assert_not_called()
    await client.close()


async def test_unsupported_live_is_rejected_before_any_bridge_socket(
    hass, hass_ws_client, viewer_setup
):
    info = viewer_setup.runtime_data.data.cameras["CAM123"]
    info.capabilities["live"] = {
        "available": False,
        "status": "unsupported",
        "reason": "standalone_transport_unverified",
    }
    with patch.object(viewer_setup.runtime_data.api, "websocket") as opening:
        client = await hass_ws_client(hass)
        await client.send_json(
            {"id": 1, "type": "eufy_viewer/watch", "entity_id": "camera.front_door"}
        )
        result = await client.receive_json()
        assert result["error"]["code"] == "capability_unavailable"
        assert "Standalone" in result["error"]["message"]
        opening.assert_not_called()
