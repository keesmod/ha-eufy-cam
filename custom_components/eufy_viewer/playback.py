"""Bounded, short-lived recording playback using HA's signed-path authentication."""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from datetime import timedelta
from uuid import uuid4

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.components.http.auth import async_sign_path
from homeassistant.components.http.const import (
    KEY_HASS,
    KEY_HASS_REFRESH_TOKEN_ID,
    KEY_HASS_USER,
)

from .api import BridgeError, BridgeRecordingError
from .recordings import camera_access, serve

PLAYBACK_SECONDS = 300
MAX_CLIP_BYTES = 32 * 1024 * 1024
MAX_PLAYBACK_BYTES = 64 * 1024 * 1024
MAX_PLAYBACKS = 8


@dataclass
class Playback:
    """Memory-only media owned by the requesting user and camera entity."""

    user_id: str
    entity_id: str
    entry_id: str
    body: bytes
    expiry: asyncio.TimerHandle


class PlaybackView(HomeAssistantView):
    """Range requests reuse one download; close or expiry releases its bytes."""

    url = "/api/eufy_viewer/playback/{playback_id}"
    name = "api:eufy_viewer:playback"
    requires_auth = True

    def __init__(self) -> None:
        self.sessions: dict[str, Playback] = {}

    def remove(self, playback_id: str) -> None:
        """Release media even if the browser disappeared without a DELETE."""
        if session := self.sessions.pop(playback_id, None):
            session.expiry.cancel()

    def close_entry(self, entry_id: str) -> None:
        """Release this integration entry's media on unload or shutdown."""
        for playback_id, session in list(self.sessions.items()):
            if session.entry_id == entry_id:
                self.remove(playback_id)

    def add(self, request: web.Request, entity_id: str, body: bytes) -> dict[str, str]:
        """Sign only for the authenticated caller, never HA's content user."""
        refresh_token_id = request.get(KEY_HASS_REFRESH_TOKEN_ID)
        if not refresh_token_id:
            raise web.HTTPForbidden
        if not body or len(body) > MAX_CLIP_BYTES:
            raise BridgeError("Invalid recording size")
        if (
            len(self.sessions) >= MAX_PLAYBACKS
            or sum(len(s.body) for s in self.sessions.values()) + len(body)
            > MAX_PLAYBACK_BYTES
        ):
            raise BridgeRecordingError("recording_busy", 409)
        playback_id = uuid4().hex
        path = f"/api/eufy_viewer/playback/{playback_id}"
        url = async_sign_path(
            request.app[KEY_HASS],
            path,
            timedelta(seconds=PLAYBACK_SECONDS),
            refresh_token_id=refresh_token_id,
        )
        self.sessions[playback_id] = Playback(
            request[KEY_HASS_USER].id,
            entity_id,
            camera_access(request, entity_id)[0].entry.entry_id,
            body,
            asyncio.get_running_loop().call_later(
                PLAYBACK_SECONDS, self.remove, playback_id
            ),
        )
        return {"url": url, "path": path}

    def owned(self, request: web.Request, playback_id: str) -> Playback:
        """A signed URL still passes HA authentication and current permissions."""
        session = self.sessions.get(playback_id)
        if session is None:
            raise web.HTTPNotFound
        if session.user_id != request[KEY_HASS_USER].id:
            raise web.HTTPForbidden
        return session

    async def get(self, request: web.Request, playback_id: str) -> web.Response:
        """Serve a full MP4 or one byte range without touching the HomeBase."""
        session = self.owned(request, playback_id)
        camera_access(request, session.entity_id)
        size = len(session.body)
        headers = {
            "Cache-Control": "no-store",
            "Accept-Ranges": "bytes",
            "Referrer-Policy": "no-referrer",
        }
        start, stop, status = 0, size, 200
        if "Range" in request.headers:
            try:
                part = request.http_range
                start = part.start if part.start is not None else 0
                if start < 0:
                    start = max(0, size + start)
                stop = min(part.stop, size) if part.stop is not None else size
                if start >= size or stop <= start:
                    raise ValueError
            except ValueError as err:
                raise web.HTTPRequestRangeNotSatisfiable(
                    headers={**headers, "Content-Range": f"bytes */{size}"}
                ) from err
            status = 206
            headers["Content-Range"] = f"bytes {start}-{stop - 1}/{size}"
        return web.Response(
            body=session.body[start:stop],
            status=status,
            content_type="video/mp4",
            headers=headers,
        )

    async def head(self, request: web.Request, playback_id: str) -> web.Response:
        """Let native players inspect the same authorized resource."""
        return await self.get(request, playback_id)

    async def delete(self, request: web.Request, playback_id: str) -> web.Response:
        """Authenticated close works even if the camera just became unavailable."""
        self.owned(request, playback_id)
        self.remove(playback_id)
        return web.Response(status=204)


class PreparePlaybackView(HomeAssistantView):
    """Prepare one recording before giving a native player its temporary URL."""

    url = "/api/eufy_viewer/recordings/{entity_id}/{recording_id}/playback"
    name = "api:eufy_viewer:prepare_playback"
    requires_auth = True

    def __init__(self, playback: PlaybackView) -> None:
        self.playback = playback

    async def post(
        self, request: web.Request, entity_id: str, recording_id: str
    ) -> web.Response:
        """Abort the download when preparation is cancelled by the browser."""
        coordinator, serial = camera_access(request, entity_id)
        if not re.fullmatch(r"[a-f0-9]{32}", recording_id):
            raise web.HTTPBadRequest
        if not request.get(KEY_HASS_REFRESH_TOKEN_ID):
            raise web.HTTPForbidden

        output_format = request.query.get("format", "h264")
        if output_format not in {"h264", "native"}:
            raise web.HTTPBadRequest

        async def prepare() -> dict[str, str]:
            body = await coordinator.api.recording_video(
                serial,
                recording_id,
                **({"native": True} if output_format == "native" else {}),
            )
            # Recheck access after the potentially long download.
            camera_access(request, entity_id)
            return self.playback.add(request, entity_id, body)

        return await serve(request, prepare())
