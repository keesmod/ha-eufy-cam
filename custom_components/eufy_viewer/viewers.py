"""Connection-bound viewer subscriptions with end-to-end frame acknowledgement."""

from __future__ import annotations

import asyncio
import base64
from typing import Any

import aiohttp
import voluptuous as vol
from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er

from .api import BridgeError
from .const import DOMAIN, MAX_FRAME_BYTES
from .coordinator import EufyCoordinator


class Viewer:
    """One user gesture, one frontend connection, one bridge lease."""

    def __init__(
        self,
        hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        subscription: int,
        coordinator: EufyCoordinator,
        serial: str,
        entity_id: str,
    ) -> None:
        self.hass = hass
        self.connection = connection
        self.subscription = subscription
        self.coordinator = coordinator
        self.serial = serial
        self.entity_id = entity_id
        self.socket: aiohttp.ClientWebSocketResponse | None = None
        self.task: asyncio.Task[None] | None = None
        self.closed = False
        self.pending = False
        self.sequence = 0

    @callback
    def cancel(self) -> None:
        """Called synchronously by HA on unsubscribe or socket loss."""
        self.closed = True
        self.coordinator.viewers.discard(self)
        self.hass.data[DOMAIN]["viewers"].pop(
            (self.connection, self.subscription), None
        )
        if self.task:
            self.task.cancel()

    async def close(self) -> None:
        """Await actual socket teardown when unloading HA."""
        self.cancel()
        if self.task and self.task is not asyncio.current_task():
            await asyncio.gather(self.task, return_exceptions=True)

    async def run(self) -> None:
        """Relay at most one unacknowledged frame. Never reconnect media."""
        try:
            async with await self.coordinator.api.websocket(
                f"/v1/live/{self.serial}"
            ) as socket:
                self.socket = socket
                if self.closed:
                    return
                async with asyncio.timeout(125):
                    async for message in socket:
                        if message.type != aiohttp.WSMsgType.BINARY:
                            break
                        if not self.connection.user.permissions.check_entity(
                            self.entity_id, POLICY_READ
                        ):
                            break
                        if self.pending or len(message.data) > MAX_FRAME_BYTES:
                            raise BridgeError("Invalid media backpressure")
                        self.pending = True
                        self.sequence += 1
                        self.connection.send_event(
                            self.subscription,
                            {
                                "type": "frame",
                                "subscription": self.subscription,
                                "sequence": self.sequence,
                                "jpeg": base64.b64encode(message.data).decode("ascii"),
                            },
                        )
        except BridgeError, aiohttp.ClientError, TimeoutError:
            pass
        finally:
            self.socket = None
            self.coordinator.viewers.discard(self)
            self.hass.data[DOMAIN]["viewers"].pop(
                (self.connection, self.subscription), None
            )
            # Leave HA's subscription callback in place until frontend unsubscribe;
            # deleting it while ActiveConnection iterates would break disconnect.
            if not self.closed:
                self.connection.send_event(self.subscription, {"type": "ended"})
            self.closed = True

    async def ack(self, sequence: int) -> bool:
        """Only accept a once-only acknowledgement of the current frame."""
        if (
            self.closed
            or not self.socket
            or not self.pending
            or sequence != self.sequence
        ):
            return False
        self.pending = False
        try:
            await self.socket.send_str("ack")
        except aiohttp.ClientError, ConnectionError:
            self.cancel()
            return False
        return True


@websocket_api.websocket_command(
    {
        vol.Required("type"): "eufy_viewer/watch",
        vol.Required("entity_id"): str,
        vol.Optional("transport", default="jpeg"): vol.In(["jpeg", "webrtc"]),
    }
)
@websocket_api.async_response
async def websocket_watch(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Authorize the exact entity before opening a camera session."""
    entity_id = msg["entity_id"]
    if not connection.user.permissions.check_entity(entity_id, POLICY_READ):
        connection.send_error(msg["id"], "unauthorized", "Camera access denied")
        return
    entity = er.async_get(hass).async_get(entity_id)
    entry = (
        hass.config_entries.async_get_entry(entity.config_entry_id)
        if entity and entity.config_entry_id
        else None
    )
    if (
        not entity
        or entity.platform != DOMAIN
        or entity.domain != "camera"
        or entity.disabled
        or not entry
        or not hasattr(entry, "runtime_data")
    ):
        connection.send_error(msg["id"], "not_found", "Viewer camera unavailable")
        return
    coordinator: EufyCoordinator = entry.runtime_data
    serial = entity.unique_id.removesuffix("_camera")
    if (
        serial not in coordinator.data.cameras
        or not coordinator.last_update_success
        or coordinator.data.auth != "connected"
    ):
        connection.send_error(msg["id"], "unavailable", "Camera unavailable")
        return
    info = coordinator.data.cameras[serial]
    if not info.permits("live"):
        connection.send_error(
            msg["id"], "capability_unavailable", info.capability_reason("live")
        )
        return
    viewers = hass.data[DOMAIN]["viewers"]
    if (
        len(coordinator.viewers) >= 16
        or sum(v.connection is connection for v in viewers.values()) >= 4
    ):
        connection.send_error(msg["id"], "busy", "Too many viewers")
        return
    if msg["transport"] == "webrtc":
        from .webrtc import WebRTCViewer

        if not coordinator.data.webrtc:
            connection.send_error(msg["id"], "unsupported", "Update the Eufy bridge")
            return
        try:
            viewer: Viewer = WebRTCViewer(
                hass, connection, msg["id"], coordinator, serial, entity_id
            )
        except BridgeError:
            connection.send_error(
                msg["id"], "unavailable", "Home Assistant go2rtc is unavailable"
            )
            return
    else:
        viewer = Viewer(hass, connection, msg["id"], coordinator, serial, entity_id)
    viewers[(connection, msg["id"])] = viewer
    coordinator.viewers.add(viewer)
    connection.subscriptions[msg["id"]] = viewer.cancel
    connection.send_result(msg["id"])
    viewer.task = entry.async_create_background_task(
        hass, viewer.run(), "Eufy camera viewer"
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "eufy_viewer/ack",
        vol.Required("subscription"): vol.All(int, vol.Range(min=1)),
        vol.Required("sequence"): vol.All(int, vol.Range(min=1)),
    }
)
@websocket_api.async_response
async def websocket_ack(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """A different connection can never renew another viewer's session."""
    viewer = hass.data[DOMAIN]["viewers"].get((connection, msg["subscription"]))
    accepted = bool(viewer and await viewer.ack(msg["sequence"]))
    connection.send_result(msg["id"], {"accepted": accepted})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "eufy_viewer/signal",
        vol.Required("subscription"): vol.All(int, vol.Range(min=1)),
        vol.Exclusive("offer", "signal"): vol.All(str, vol.Length(min=1, max=65536)),
        vol.Exclusive("candidate", "signal"): vol.All(str, vol.Length(max=2048)),
    }
)
@websocket_api.async_response
async def websocket_signal(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Connection-bound WebRTC offer/candidate dispatch, without camera starts."""
    from .webrtc import WebRTCViewer

    viewer = hass.data[DOMAIN]["viewers"].get((connection, msg["subscription"]))
    accepted = bool(
        isinstance(viewer, WebRTCViewer)
        and connection.user.permissions.check_entity(viewer.entity_id, POLICY_READ)
        and await viewer.signal(msg.get("offer"), msg.get("candidate"))
    )
    connection.send_result(msg["id"], {"accepted": accepted})


@callback
def async_register_commands(hass: HomeAssistant) -> None:
    """Register authenticated commands once per HA process."""
    websocket_api.async_register_command(hass, websocket_watch)
    websocket_api.async_register_command(hass, websocket_ack)
    websocket_api.async_register_command(hass, websocket_signal)
