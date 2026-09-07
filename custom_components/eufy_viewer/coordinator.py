"""Push inventory and connection lifecycle; reconnect only to the local bridge."""

from __future__ import annotations

import asyncio
import logging
import random
from typing import TYPE_CHECKING

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import BridgeAuthError, BridgeClient, BridgeError, BridgeState
from .const import DOMAIN

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

    def start(self) -> None:
        """Subscribe after entity platforms have been set up."""
        self._listener = self.entry.async_create_background_task(
            self.hass, self._listen(), "Eufy bridge events"
        )

    async def _listen(self) -> None:
        delay = 1.0
        while not self._closed:
            try:
                async with await self.api.websocket("/v1/events") as socket:
                    async for message in socket:
                        if message.type != aiohttp.WSMsgType.TEXT:
                            break
                        state = BridgeState.parse(message.json())
                        if state.bridge_id != self.entry.unique_id:
                            raise BridgeError("Bridge identity changed")
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
