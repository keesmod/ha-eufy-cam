"""Optional audio signaling within an existing, connection-owned live session."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import suppress
from typing import Any

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
from homeassistant.core import HomeAssistant, callback
from webrtc_models import RTCIceServer

from .ice import ice_configuration
from .live_diagnostics import LATE_AUDIO_END_REASONS as END_REASONS
from .live_diagnostics import LATE_AUDIO_STAGES as STAGES


class LateAudioTrack:
    """An audio-only peer cannot start or renew the camera, or replace its video."""

    def __init__(
        self,
        hass: HomeAssistant,
        session: aiohttp.ClientSession,
        url: str,
        name: str,
        emit: Callable[[dict[str, Any]], None],
        evidence: dict[str, Any] | None = None,
    ) -> None:
        self.hass = hass
        self.session = session
        self.url = url
        self.name = name
        self.emit = emit
        self.evidence = evidence
        self.signaling: Go2RtcWsClient | None = None
        self.registered = False
        self.closed = False
        self.offered = False
        self.ice_servers: list[RTCIceServer] = []

    def stage(self, value: str) -> None:
        """Record the furthest fixed stage; never any URL, SDP or error text."""
        if self.evidence is not None and value in STAGES:
            current = self.evidence.get("audio_late")
            if current not in STAGES or STAGES.index(current) < STAGES.index(value):
                self.evidence["audio_late"] = value

    def ended(self, reason: str) -> None:
        """Keep the first fixed reason for ending audio ahead of its video."""
        if self.evidence is not None and reason in END_REASONS:
            self.evidence.setdefault("audio_late_end", reason)

    async def prepare(self, source: str) -> None:
        """Reuse managed go2rtc's AAC-to-Opus path for actual incoming audio."""
        self.registered = True
        async with asyncio.timeout(5):
            await Go2RtcRestClient(self.session, self.url).streams.add(
                self.name, [source, f"ffmpeg:{self.name}#audio=opus"]
            )
        if self.closed:
            return
        self.signaling = Go2RtcWsClient(self.session, self.url, source=self.name)
        self.signaling.subscribe(self._message)
        self.ice_servers, ice_status = ice_configuration(self.hass)
        self.stage("ready")
        self.emit(
            {
                "type": "audio_ready",
                "ice_servers": [server.to_dict() for server in self.ice_servers],
                "ice_configuration": ice_status,
            }
        )

    @callback
    def _message(self, message: ReceiveMessages) -> None:
        if self.closed:
            return
        if isinstance(message, WebRTCAnswer):
            self.stage("answered")
            self.emit({"type": "audio_answer", "sdp": message.sdp})
        elif isinstance(message, WebRTCCandidate):
            self.emit({"type": "audio_candidate", "candidate": message.candidate})
        elif isinstance(message, WsError):
            self.ended("upstream_error")
            self.emit({"type": "audio_ended"})
            self.hass.async_create_background_task(self.close(), "Eufy audio cleanup")

    async def signal(self, offer: str | None, candidate: str | None) -> bool:
        if self.closed or self.signaling is None:
            return False
        try:
            async with asyncio.timeout(10):
                if offer is not None and not self.offered:
                    self.offered = True
                    await self.signaling.send(WebRTCOffer(offer, self.ice_servers))
                    self.stage("offered")
                elif candidate is not None and self.offered:
                    await self.signaling.send(WebRTCCandidate(candidate))
                else:
                    return False
        except Go2RtcClientError, aiohttp.ClientError, TimeoutError:
            self.ended("signaling_failed")
            self.emit({"type": "audio_ended"})
            await self.close()
            return False
        return not self.closed

    async def close(self) -> None:
        self.closed = True
        self.ice_servers = []
        signaling, self.signaling = self.signaling, None
        registered, self.registered = self.registered, False
        if signaling:
            with suppress(Go2RtcClientError, aiohttp.ClientError, TimeoutError):
                async with asyncio.timeout(5):
                    await signaling.close()
        if registered:
            with suppress(Go2RtcClientError, aiohttp.ClientError, TimeoutError):
                async with asyncio.timeout(5):
                    async with self.session.delete(
                        self.url.rstrip("/") + "/api/streams",
                        params={"src": self.name},
                    ) as response:
                        await response.read()
