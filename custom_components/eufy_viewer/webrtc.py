"""Connection-scoped signaling through Home Assistant's managed go2rtc server."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
from contextlib import suppress
from secrets import token_hex
from time import monotonic
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
from webrtc_models import RTCIceServer

from .api import BridgeError
from .const import DOMAIN, MAX_FRAME_BYTES
from .ice import ice_configuration
from .late_audio import LateAudioTrack
from .live_diagnostics import browser_report, relay_report
from .viewers import Viewer, ended_event

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

    def __init__(self, *args: Any, late_audio: bool = False, **kwargs: Any) -> None:
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
        self.ice_servers: list[RTCIceServer] = []
        self.registered = False
        self.jpeg = False
        self.fallback_supported = False
        self.fallback_requested = False
        self.cleanup_task: asyncio.Task[None] | None = None
        self.browser_triggers: set[str] = set()
        self.late_audio = late_audio
        self.audio: LateAudioTrack | None = None
        self.audio_task: asyncio.Task[None] | None = None
        self.media_path: str | None = None
        self.playback_evidence: dict[str, Any] = {
            "_created": monotonic(),
            "schema": 1,
            "offered": False,
            "answered": False,
            "ticks": 0,
            "acks": 0,
            "browser": [],
            "relay": [],
        }
        # Keep only the last eight attempts per integration in memory.
        reports = self.coordinator.live_diagnostics
        reports.append(self.playback_evidence)
        del reports[:-8]

    async def record_browser_report(self, report: dict[str, Any]) -> bool:
        """One sample per fixed stage, without extending camera ownership."""
        trigger = report.get("trigger")
        if (
            trigger not in {"startup", "playing", "unmuted", "fallback", "audio_check"}
            or trigger in self.browser_triggers
        ):
            return False
        self.browser_triggers.add(trigger)
        self.playback_evidence["browser"].append(browser_report(report))
        if self.registered and not self.jpeg and not self.fallback_requested:
            # This request runs independently of frame acknowledgements. Do not
            # hold cleanup for a slow or unavailable diagnostic endpoint.
            row: dict[str, Any] = {"trigger": trigger}
            try:
                async with asyncio.timeout(1):
                    row.update(await self._relay_stats(self.name))
            except aiohttp.ClientError, TimeoutError, ValueError:
                return True
            # AAC never travels in the video stream: late audio has its own
            # go2rtc stream, whose codec counters are added to the same row.
            audio = self.audio
            if audio and audio.registered and not audio.closed:
                with suppress(aiohttp.ClientError, TimeoutError, ValueError):
                    async with asyncio.timeout(1):
                        stats = await self._relay_stats(audio.name)
                    row["audio_late"] = True
                    for key, value in stats.items():
                        row[key] = row.get(key, 0) + value
            self.playback_evidence["relay"].append(row)
        return True

    async def _relay_stats(self, name: str) -> dict[str, int]:
        """Codec packet totals of one of this viewer's own go2rtc streams."""
        async with self.config.session.get(
            self.config.url.rstrip("/") + "/api/streams", params={"src": name}
        ) as response:
            response.raise_for_status()
            try:
                raw = await response.content.readexactly(65537)
            except asyncio.IncompleteReadError as err:
                raw = err.partial
            if len(raw) > 65536:
                raise ValueError("Oversized relay report")
            return relay_report(json.loads(raw))

    async def ack(self, sequence: int) -> bool:
        accepted = await super().ack(sequence)
        if accepted and not self.jpeg:
            self.playback_evidence["acks"] += 1
        return accepted

    @callback
    def _message(self, message: ReceiveMessages) -> None:
        if self.closed or self.jpeg or self.fallback_requested:
            return
        if isinstance(message, WebRTCAnswer):
            self.playback_evidence["answered"] = True
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

    async def signal(
        self,
        offer: str | None,
        candidate: str | None,
        audio: bool = False,
        stop: bool = False,
    ) -> bool:
        """Only the owning frontend connection may signal this lease."""
        if (
            self.closed
            or self.jpeg
            or self.fallback_requested
            or not self.ready
            or self.signaling is None
        ):
            return False
        if audio:
            if not self.audio:
                return False
            if stop:
                self.audio.ended("stopped")
                await self.audio.close()
                return True
            return await self.audio.signal(offer, candidate)
        if stop:
            return False
        try:
            async with asyncio.timeout(10):
                if offer is not None:
                    if self.offered:
                        return False
                    self.offered = True
                    # Use the same per-peer configuration sent to its browser.
                    await self.signaling.send(WebRTCOffer(offer, self.ice_servers))
                    self.playback_evidence["offered"] = True
                elif candidate is not None and self.offered:
                    await self.signaling.send(WebRTCCandidate(candidate))
                else:
                    return False
        except Go2RtcClientError, aiohttp.ClientError, TimeoutError:
            await self._failed("signaling_error")
            return self.fallback_requested and not self.closed
        return not self.closed

    async def _prepare(
        self, path: str, audio: bool | None = None, audio_attempt: Any = None
    ) -> None:
        if self.ready or not re.fullmatch(r"/v1/media/[a-f0-9]{64}", path):
            raise BridgeError("Invalid media grant")
        if audio is not None and not isinstance(audio, bool):
            raise BridgeError("Invalid media audio capability")
        if audio is not None:
            self.playback_evidence["audio_expected"] = audio
        self.media_path = path
        if type(audio_attempt) is int and 1 <= audio_attempt < 2**48:
            self.playback_evidence["audio_attempt"] = audio_attempt
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
        self.ice_servers, ice_status = ice_configuration(self.hass)
        self.ready = True
        self.connection.send_event(
            self.subscription,
            {
                "type": "ready",
                "subscription": self.subscription,
                "fallback": self.fallback_supported,
                "diagnostics": True,
                "ice_servers": [server.to_dict() for server in self.ice_servers],
                "ice_configuration": ice_status,
            },
        )

    def _audio_event(self, event: dict[str, Any]) -> None:
        if not self.closed and not self.jpeg and not self.fallback_requested:
            self.connection.send_event(self.subscription, event)

    async def _prepare_audio(self, path: str) -> None:
        """Audio setup failure ends only audio; video and its lease continue."""
        assert self.audio is not None
        try:
            await self.audio.prepare(self.coordinator.api.url + path)
        except asyncio.CancelledError:
            await self.audio.close()
            raise
        except Go2RtcClientError, aiohttp.ClientError, TimeoutError:
            self.audio.ended("setup_failed")
            self._audio_event({"type": "audio_ended"})
            await self.audio.close()

    def _audio_announced(self, data: dict[str, Any]) -> None:
        """Start late audio when this ready, opted-in viewer owns the route."""
        if (
            not self.late_audio
            or self.media_path is None
            or data.get("path") != f"{self.media_path}/audio"
        ):
            # Only an opted-in viewer may open its own grant's audio route.
            raise BridgeError("Invalid late audio control")
        if self.audio is not None:
            # The bridge announces audio once. A repeat cannot replace or end
            # the current attempt, whether it is still connecting or failed.
            return
        self.playback_evidence["audio_late"] = "announced"
        if (
            not self.ready
            or self.jpeg
            or self.fallback_requested
            or self.playback_evidence.get("audio_expected") is not False
        ):
            # A warm start announces audio right after ready, so it can be
            # queued behind a failed or downgraded video setup. Audio is then
            # unavailable, but the video session or its JPEG fallback continues.
            self.playback_evidence.setdefault("audio_late_end", "unavailable")
            return
        self.audio = LateAudioTrack(
            self.hass,
            self.config.session,
            self.config.url,
            self.name + "_audio",
            self._audio_event,
            self.playback_evidence,
        )
        # Setup must not block video ticks or renew ownership.
        self.audio_task = self.hass.async_create_background_task(
            self._prepare_audio(data["path"]), "Eufy late audio"
        )

    async def _cleanup(self) -> None:
        if self.audio_task and not self.audio_task.done():
            self.audio_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.audio_task
        if self.audio:
            await self.audio.close()
        self.ice_servers = []
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
        ended = ended_event(None)
        try:
            async with await self.coordinator.api.websocket(
                f"/v1/live/{self.serial}?transport=webrtc"
                + ("&late_audio=1" if self.late_audio else "")
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
                                        data.get("path", ""),
                                        data.get("audio"),
                                        data.get("audio_attempt"),
                                    )
                            except Go2RtcClientError, aiohttp.ClientError, TimeoutError:
                                await self._failed("signaling_error")
                        elif data.get("type") == "audio_ready":
                            self._audio_announced(data)
                        elif data.get("type") == "fallback":
                            reason = data.get("reason")
                            if self.jpeg or reason not in FALLBACK_REASONS:
                                raise BridgeError("Invalid fallback control")
                            self.playback_evidence["fallback"] = reason
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
                            self.playback_evidence["ticks"] += 1
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
                # A bridge close ends the iteration; its code may name the reason.
                ended = ended_event(socket.close_code)
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
                self.connection.send_event(self.subscription, ended)
            self.closed = True
            await self._cleanup()
            if self.cleanup_task:
                await self.cleanup_task
