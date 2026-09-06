"""Connection-scoped signaling through Home Assistant's managed go2rtc server."""

from __future__ import annotations

import asyncio
import json
import re
from contextlib import suppress
from secrets import token_hex
from typing import Any, Protocol, cast

import aiohttp
from go2rtc_client import Go2RtcRestClient
from go2rtc_client.exceptions import Go2RtcClientError
from go2rtc_client.ws import (
    Go2RtcWsClient,
    ReceiveMessages,
    WebRTCAnswer,
    WebRTCCandidate,
    WebRTCOffer,
    WsError,
)
from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.core import callback

from .api import BridgeError
from .const import DOMAIN
from .viewers import Viewer


class Go2RtcConnection(Protocol):
    """The connection HA exposes for its managed go2rtc component."""

    session: aiohttp.ClientSession
    url: str


class WebRTCViewer(Viewer):
    """A/V goes directly to the browser; HA relays signaling and painted ticks."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        # HA owns the authenticated session (normally a Unix socket), not us.
        config = self.hass.data.get("go2rtc")
        if config is None:
            raise BridgeError("Home Assistant go2rtc is unavailable")
        self.config = cast(Go2RtcConnection, config)
        self.name = f"eufy_viewer_{token_hex(16)}"
        self.signaling: Go2RtcWsClient | None = None
        self.ready = False
        self.offered = False
        self.registered = False

    @callback
    def _message(self, message: ReceiveMessages) -> None:
        if self.closed:
            return
        if isinstance(message, WebRTCAnswer):
            self.connection.send_event(
                self.subscription, {"type": "answer", "sdp": message.sdp}
            )
        elif isinstance(message, WebRTCCandidate):
            self.connection.send_event(
                self.subscription, {"type": "candidate", "candidate": message.candidate}
            )
        elif isinstance(message, WsError):
            # Never forward upstream errors: these may contain private media URLs.
            self.connection.send_event(self.subscription, {"type": "ended"})
            self.cancel()

    async def signal(self, offer: str | None, candidate: str | None) -> bool:
        """Only the owning frontend connection may signal this lease."""
        if self.closed or not self.ready or self.signaling is None:
            return False
        try:
            async with asyncio.timeout(10):
                if offer is not None:
                    if self.offered:
                        return False
                    self.offered = True
                    # No external STUN/TURN service is silently introduced.
                    await self.signaling.send(WebRTCOffer(offer, []))
                elif candidate is not None and self.offered:
                    await self.signaling.send(WebRTCCandidate(candidate))
                else:
                    return False
        except Go2RtcClientError, aiohttp.ClientError, TimeoutError:
            self.cancel()
            return False
        return not self.closed

    async def _prepare(self, path: str) -> None:
        if self.ready or not re.fullmatch(r"/v1/media/[a-f0-9]{64}", path):
            raise BridgeError("Invalid media grant")
        client = Go2RtcRestClient(self.config.session, self.config.url)
        self.registered = True
        async with asyncio.timeout(10):
            await client.streams.add(
                self.name,
                [
                    self.coordinator.api.url + path,
                    f"ffmpeg:{self.name}#audio=opus",
                ],
            )
        if self.closed:
            return
        self.signaling = Go2RtcWsClient(
            self.config.session, self.config.url, source=self.name
        )
        self.signaling.subscribe(self._message)
        self.ready = True
        self.connection.send_event(
            self.subscription, {"type": "ready", "subscription": self.subscription}
        )

    async def _cleanup(self) -> None:
        if self.signaling:
            with suppress(
                asyncio.CancelledError, Go2RtcClientError, aiohttp.ClientError
            ):
                await self.signaling.close()
        if self.registered:
            with suppress(Go2RtcClientError, aiohttp.ClientError, TimeoutError):
                async with asyncio.timeout(5):
                    async with self.config.session.delete(
                        self.config.url.rstrip("/") + "/api/streams",
                        params={"src": self.name},
                    ) as response:
                        await response.read()

    async def run(self) -> None:
        """Own a bridge lease until close; never reconnect or preload media."""
        try:
            async with await self.coordinator.api.websocket(
                f"/v1/live/{self.serial}?transport=webrtc"
            ) as socket:
                self.socket = socket
                if self.closed:
                    return
                async with asyncio.timeout(125):
                    async for message in socket:
                        if message.type != aiohttp.WSMsgType.TEXT:
                            break
                        if not self.connection.user.permissions.check_entity(
                            self.entity_id, POLICY_READ
                        ):
                            break
                        if len(message.data) > 1024:
                            raise BridgeError("Invalid media control")
                        data = json.loads(message.data)
                        if data.get("type") == "ready":
                            await self._prepare(data.get("path", ""))
                        elif data.get("type") == "tick" and self.ready:
                            if self.pending:
                                raise BridgeError("Invalid media backpressure")
                            self.pending = True
                            self.sequence += 1
                            self.connection.send_event(
                                self.subscription,
                                {
                                    "type": "tick",
                                    "subscription": self.subscription,
                                    "sequence": self.sequence,
                                },
                            )
                        else:
                            raise BridgeError("Invalid media control")
        except (
            BridgeError,
            Go2RtcClientError,
            aiohttp.ClientError,
            TimeoutError,
            ValueError,
            TypeError,
            AttributeError,
        ):
            pass
        finally:
            self.socket = None
            self.coordinator.viewers.discard(self)
            self.hass.data[DOMAIN]["viewers"].pop(
                (self.connection, self.subscription), None
            )
            if not self.closed:
                self.connection.send_event(self.subscription, {"type": "ended"})
            self.closed = True
            await self._cleanup()
