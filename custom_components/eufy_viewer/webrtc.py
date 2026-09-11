"""Connection-scoped signaling through Home Assistant's managed go2rtc server."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
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
from .const import DOMAIN, MAX_FRAME_BYTES
from .viewers import Viewer

_LOGGER = logging.getLogger(__name__)
FALLBACK_REASONS = {
    "startup_timeout",
    "playback_timeout",
    "connection_failed",
    "signaling_error",
    "playback_error",
}


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
        self.jpeg = False
        self.fallback_supported = False
        self.fallback_requested = False
        self.cleanup_task: asyncio.Task[None] | None = None

    @callback
    def _message(self, message: ReceiveMessages) -> None:
        if self.closed or self.jpeg or self.fallback_requested:
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
            self.hass.async_create_background_task(
                self._failed("signaling_error"), "Eufy WebRTC failure"
            )

    async def _failed(self, reason: str) -> None:
        if not await self.fallback(reason) and not self.closed:
            _LOGGER.warning("Live connection failed: %s", reason)
            self.connection.send_event(self.subscription, {"type": "ended"})
            self.cancel()

    async def fallback(self, reason: str) -> bool:
        """Change transport on this exact owner, without a reconnect or ack."""
        if reason not in {"connection_failed", "signaling_error", "playback_error"}:
            return False
        if self.closed or not self.socket or not self.fallback_supported:
            return False
        if self.jpeg or self.fallback_requested:
            return True
        self.fallback_requested = True
        self.pending = False
        try:
            await self.socket.send_str("fallback:" + reason)
        except aiohttp.ClientError, ConnectionError:
            self.cancel()
            return False
        return True

    async def signal(self, offer: str | None, candidate: str | None) -> bool:
        """Only the owning frontend connection may signal this lease."""
        if (
            self.closed
            or self.jpeg
            or self.fallback_requested
            or not self.ready
            or self.signaling is None
        ):
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
            await self._failed("signaling_error")
            return self.fallback_requested and not self.closed
        return not self.closed

    async def _prepare(self, path: str, audio: bool | None = None) -> None:
        if self.ready or not re.fullmatch(r"/v1/media/[a-f0-9]{64}", path):
            raise BridgeError("Invalid media grant")
        if audio is not None and not isinstance(audio, bool):
            raise BridgeError("Invalid media audio capability")
        sources = [self.coordinator.api.url + path]
        # Older bridges omit this field. Preserve their A/V behavior, but never
        # ask go2rtc to convert audio when this stream is explicitly video-only.
        if audio is not False:
            sources.append(f"ffmpeg:{self.name}#audio=opus")
        client = Go2RtcRestClient(self.config.session, self.config.url)
        self.registered = True
        async with asyncio.timeout(5):
            await client.streams.add(
                self.name,
                sources,
            )
        if self.closed or self.jpeg or self.fallback_requested:
            return
        self.signaling = Go2RtcWsClient(
            self.config.session, self.config.url, source=self.name
        )
        self.signaling.subscribe(self._message)
        self.ready = True
        self.connection.send_event(
            self.subscription,
            {
                "type": "ready",
                "subscription": self.subscription,
                "fallback": self.fallback_supported,
            },
        )

    async def _cleanup(self) -> None:
        signaling, self.signaling = self.signaling, None
        registered, self.registered = self.registered, False
        if signaling:
            with suppress(
                asyncio.CancelledError, Go2RtcClientError, aiohttp.ClientError
            ):
                await signaling.close()
        if registered:
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
                        if not self.connection.user.permissions.check_entity(
                            self.entity_id, POLICY_READ
                        ):
                            break
                        if message.type == aiohttp.WSMsgType.BINARY:
                            if (
                                not self.jpeg
                                or self.pending
                                or len(message.data) > MAX_FRAME_BYTES
                            ):
                                raise BridgeError("Invalid fallback frame")
                            self.pending = True
                            self.sequence += 1
                            self.connection.send_event(
                                self.subscription,
                                {
                                    "type": "frame",
                                    "subscription": self.subscription,
                                    "sequence": self.sequence,
                                    "jpeg": base64.b64encode(message.data).decode(
                                        "ascii"
                                    ),
                                },
                            )
                            continue
                        if message.type != aiohttp.WSMsgType.TEXT:
                            break
                        if len(message.data) > 1024:
                            raise BridgeError("Invalid media control")
                        data = json.loads(message.data)
                        if data.get("type") == "ready":
                            if self.jpeg:
                                raise BridgeError("Unexpected ready after fallback")
                            self.fallback_supported = data.get("fallback") is True
                            budget = data.get("fallback_after_ms", 5000)
                            if type(budget) is not int or not 1 <= budget <= 15000:
                                raise BridgeError("Invalid startup budget")
                            try:
                                # Do not block JPEG control behind stalled go2rtc setup.
                                async with asyncio.timeout(min(5000, budget) / 1000):
                                    await self._prepare(
                                        data.get("path", ""), data.get("audio")
                                    )
                            except Go2RtcClientError, aiohttp.ClientError, TimeoutError:
                                await self._failed("signaling_error")
                        elif data.get("type") == "fallback":
                            reason = data.get("reason")
                            if self.jpeg or reason not in FALLBACK_REASONS:
                                raise BridgeError("Invalid fallback control")
                            self.jpeg = True
                            self.ack_command = "ack:jpeg"
                            self.pending = False
                            _LOGGER.warning(
                                "Live video switched to JPEG without audio: %s", reason
                            )
                            self.connection.send_event(
                                self.subscription, {"type": "fallback"}
                            )
                            self.cleanup_task = self.hass.async_create_background_task(
                                self._cleanup(), "Eufy WebRTC transport cleanup"
                            )
                        elif data.get("type") == "tick" and self.fallback_requested:
                            continue
                        elif (
                            data.get("type") == "tick" and self.ready and not self.jpeg
                        ):
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
            if self.cleanup_task:
                await self.cleanup_task
