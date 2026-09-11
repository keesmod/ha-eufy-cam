"""Push inventory and connection lifecycle; reconnect only to the local bridge."""

from __future__ import annotations

import asyncio
import logging
import random
from collections import OrderedDict
from typing import TYPE_CHECKING

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .api import BridgeAuthError, BridgeClient, BridgeError, BridgeState
from .const import DOMAIN
from .migration import prepare_migration
from .notifications import EVENT_TYPES, notification_signal

if TYPE_CHECKING:
    from .viewers import Viewer

_LOGGER = logging.getLogger(__name__)
type EufyConfigEntry = ConfigEntry[EufyCoordinator]


class EufyCoordinator(DataUpdateCoordinator[BridgeState]):
    """Hold cached inventory without scheduling refresh calls."""

    def __init__(
        self, hass: HomeAssistant, entry: EufyConfigEntry, api: BridgeClient
    ) -> None:
        super().__init__(hass, _LOGGER, name=DOMAIN, config_entry=entry)
        self.api = api
        self.entry = entry
        self.viewers: set[Viewer] = set()
        self._listener: asyncio.Task[None] | None = None
        self._closed = False
        self._seen_events: OrderedDict[str, None] = OrderedDict()

    def start(self) -> None:
        """Subscribe after entity platforms have been set up."""
        self._listener = self.entry.async_create_background_task(
            self.hass, self._listen(), "Eufy bridge events"
        )

    async def _listen(self) -> None:
        delay = 1.0
        while not self._closed:
            try:
                async with await self.api.websocket(
                    "/v1/events?notifications=1"
                ) as socket:
                    async for message in socket:
                        if message.type != aiohttp.WSMsgType.TEXT:
                            break
                        payload = message.json()
                        if (
                            isinstance(payload, dict)
                            and payload.get("type") == "notification"
                        ):
                            self.receive_notification(payload)
                            continue
                        state = BridgeState.parse(payload)
                        if state.bridge_id != self.entry.unique_id:
                            raise BridgeError("Bridge identity changed")
                        if state.migration_error:
                            state = await prepare_migration(
                                self.hass, self.entry, self.api, state
                            )
                        self.async_set_updated_data(state)
                        delay = 1.0
                        if state.auth != "connected":
                            await self.close_viewers()
                            if state.auth != "connecting":
                                self.entry.async_start_reauth(self.hass)
                    raise BridgeError("Bridge disconnected")
            except BridgeAuthError as err:
                self.async_set_update_error(UpdateFailed(str(err)))
                await self.close_viewers()
                self.entry.async_start_reauth(self.hass)
                return
            except (BridgeError, aiohttp.ClientError, ValueError) as err:
                self.async_set_update_error(UpdateFailed(str(err)))
                await self.close_viewers()
            # Retry the local push socket only. Never resume a media session.
            await asyncio.sleep(delay + random.uniform(0, delay / 5))
            delay = min(delay * 2, 60)

    @callback
    def receive_notification(self, payload: dict) -> None:
        """Validate live events without replaying inventory as alerts."""
        if payload.get("bridge_id") != self.entry.unique_id:
            raise BridgeError("Bridge identity changed")
        serial = payload.get("serial")
        event_type = payload.get("event_type")
        event_id = payload.get("id")
        received = payload.get("received_at")
        if (
            not isinstance(serial, str)
            or (serial not in self.data.cameras and serial not in self.data.stations)
            or not isinstance(event_type, str)
            or event_type not in EVENT_TYPES
            or not isinstance(event_id, str)
            or not 1 <= len(event_id) <= 128
            or not isinstance(received, str)
            or len(received) > 64
            or (timestamp := dt_util.parse_datetime(received)) is None
            or timestamp.tzinfo is None
            or payload.get("source") not in ("push", "device")
        ):
            return
        # Delayed delivery must not actuate a device long after detection.
        age = (dt_util.utcnow() - timestamp).total_seconds()
        if not -30 <= age <= 120 or event_id in self._seen_events:
            return
        name = payload.get("person_name")
        recognition = payload.get(
            "recognition",
            "unidentified" if event_type == "person" else "not_applicable",
        )
        if (
            recognition not in ("known", "unknown", "unidentified", "not_applicable")
            or (
                name is not None
                and (
                    not isinstance(name, str)
                    or not 1 <= len(name) <= 128
                    or any(ord(char) < 32 or ord(char) == 127 for char in name)
                )
            )
            or (name is not None and (event_type != "person" or recognition != "known"))
            or (event_type != "person" and recognition != "not_applicable")
        ):
            return
        occurred = payload.get("occurred_at")
        if occurred is not None:
            if not isinstance(occurred, str) or len(occurred) > 64:
                return
            occurrence = dt_util.parse_datetime(occurred)
            if occurrence is None or occurrence.tzinfo is None:
                return
        self._seen_events[event_id] = None
        if len(self._seen_events) > 2048:
            self._seen_events.popitem(last=False)
        event = {
            "id": event_id,
            "serial": serial,
            "device_name": (
                self.data.cameras.get(serial) or self.data.stations[serial]
            ).name,
            "event_type": event_type,
            "received_at": received,
            "source": payload["source"],
            "person_name": name,
            "recognition": recognition,
            "occurred_at": occurred,
            "config_entry_id": self.entry.entry_id,
        }
        for key in ("eufy_event_type",):
            if type(payload.get(key)) is int:
                event[key] = payload[key]
        self.hass.bus.async_fire("eufy_viewer_event", event)
        async_dispatcher_send(
            self.hass, notification_signal(self.entry.entry_id), event
        )

    async def close_viewers(self) -> None:
        """Await all stream cleanup before unloading or changing credentials."""
        await asyncio.gather(*(viewer.close() for viewer in list(self.viewers)))

    async def close(self) -> None:
        """Unload tasks and viewers deterministically."""
        self._closed = True
        if self._listener:
            self._listener.cancel()
            await asyncio.gather(self._listener, return_exceptions=True)
        await self.close_viewers()
