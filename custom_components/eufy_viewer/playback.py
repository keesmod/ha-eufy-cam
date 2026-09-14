"""Bounded, short-lived recording playback using HA's signed-path authentication."""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import timedelta
from typing import Any
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
from .recording_file import (
    CHUNK_BYTES,
    MAX_RECORDING_FILES,
    RecordingBudget,
    RecordingFile,
)
from .recordings import camera_access, serve

PLAYBACK_SECONDS = 300


@dataclass
class Playback:
    """File media owned by the requesting user and camera entity."""

    user_id: str
    entity_id: str
    entry_id: str
    body: RecordingFile
    expiry: asyncio.TimerHandle


class PlaybackView(HomeAssistantView):
    """Range requests reuse one download; close or expiry releases its bytes."""

    url = "/api/eufy_viewer/playback/{playback_id}"
    name = "api:eufy_viewer:playback"
    requires_auth = True

    def __init__(self, directory: str) -> None:
        self.directory = directory
        self.sessions: dict[str, Playback] = {}
        self.files: list[RecordingFile] = []
        self.budget = RecordingBudget()
        self.readers = 0

    @asynccontextmanager
    async def reserve(self) -> AsyncIterator[RecordingFile]:
        """Admit before downloading, including files still held by readers."""
        self.files = [file for file in self.files if file.owners]
        if len(self.files) >= MAX_RECORDING_FILES:
            raise BridgeRecordingError("recording_busy", 409)
        file = RecordingFile(self.directory, self.budget)
        self.files.append(file)
        try:
            await file.open()
            yield file
        except OSError as err:
            raise BridgeRecordingError("recording_storage_unavailable", 503) from err
        finally:
            file.close()

    def remove(self, playback_id: str) -> None:
        """Release media even if the browser disappeared without a DELETE."""
        if session := self.sessions.pop(playback_id, None):
            session.expiry.cancel()
            session.body.close()

    def close_entry(self, entry_id: str) -> None:
        """Release this integration entry's media on unload or shutdown."""
        for playback_id, session in list(self.sessions.items()):
            if session.entry_id == entry_id:
                self.remove(playback_id)

    def add(
        self, request: web.Request, entity_id: str, body: RecordingFile
    ) -> dict[str, str]:
        """Sign only for the authenticated caller, never HA's content user."""
        refresh_token_id = request.get(KEY_HASS_REFRESH_TOKEN_ID)
        if not refresh_token_id:
            raise web.HTTPForbidden
        if not body.size:
            raise BridgeError("Invalid recording size")
        playback_id = uuid4().hex
        path = f"/api/eufy_viewer/playback/{playback_id}"
        url = async_sign_path(
            request.app[KEY_HASS],
            path,
            timedelta(seconds=PLAYBACK_SECONDS),
            refresh_token_id=refresh_token_id,
        )
        entry_id = camera_access(request, entity_id)[0].entry.entry_id
        body.retain()
        self.sessions[playback_id] = Playback(
            request[KEY_HASS_USER].id,
            entity_id,
            entry_id,
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

    async def get(self, request: web.Request, playback_id: str) -> web.StreamResponse:
        """Serve a full MP4 or one byte range without touching the HomeBase."""
        session = self.owned(request, playback_id)
        camera_access(request, session.entity_id)
        return await self.send(request, session.body)

    async def send(
        self, request: web.Request, body: RecordingFile
    ) -> web.StreamResponse:
        """Bound readers and stream ranges without retaining full response bytes."""
        size = body.size
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
        if self.readers >= MAX_RECORDING_FILES:
            raise web.HTTPServiceUnavailable
        response = web.StreamResponse(status=status, headers=headers)
        response.content_type = "video/mp4"
        response.content_length = stop - start
        self.readers += 1
        body.retain()
        try:
            async with asyncio.timeout(65):
                await response.prepare(request)
                if request.method != "HEAD":
                    while start < stop:
                        chunk = await body.read(start, min(CHUNK_BYTES, stop - start))
                        if not chunk:
                            raise OSError("Incomplete recording read")
                        await response.write(chunk)
                        start += len(chunk)
                await response.write_eof()
            return response
        finally:
            self.readers -= 1
            body.close()

    async def head(self, request: web.Request, playback_id: str) -> web.StreamResponse:
        """Let native players inspect the same authorized resource."""
        return await self.get(request, playback_id)

    async def delete(
        self, request: web.Request, playback_id: str
    ) -> web.StreamResponse:
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
    ) -> web.StreamResponse:
        """Abort the download when preparation is cancelled by the browser."""
        coordinator, serial = camera_access(request, entity_id)
        if not re.fullmatch(r"[a-f0-9]{32}", recording_id):
            raise web.HTTPBadRequest
        if not request.get(KEY_HASS_REFRESH_TOKEN_ID):
            raise web.HTTPForbidden

        output_format = request.query.get("format", "h264")
        if output_format not in {"auto", "h264", "native"}:
            raise web.HTTPBadRequest

        hevc = request.query.get("hevc_supported", "false")
        if hevc not in {"true", "false"}:
            raise web.HTTPBadRequest

        async def prepare() -> dict[str, Any]:
            async with self.playback.reserve() as body:
                modern = bool(coordinator.data and coordinator.data.recording_playback)
                requested = output_format
                if not modern and output_format == "auto":
                    requested = "native" if hevc == "true" else "h264"
                media = await coordinator.api.recording_media(
                    serial,
                    recording_id,
                    target=body,
                    output_format=requested,
                    hevc_supported=hevc == "true" if modern else False,
                )
                # Recheck access and disconnect before transferring file ownership.
                camera_access(request, entity_id)
                if request.transport is None or request.transport.is_closing():
                    raise asyncio.CancelledError
                result: dict[str, Any] = self.playback.add(request, entity_id, body)
                if modern and media is not None:
                    result["media"] = media
                return result

        return await serve(request, prepare())
