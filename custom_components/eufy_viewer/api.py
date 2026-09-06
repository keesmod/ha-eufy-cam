"""Async client for the local, authenticated Eufy Viewer bridge protocol."""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any

import aiohttp
from yarl import URL


class BridgeError(Exception):
    """Bridge unavailable or returned an invalid response."""


class BridgeRecordingError(BridgeError):
    """An allowlisted recording failure safe to display to the viewer."""

    def __init__(self, code: str, status: int) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


async def check_recording_error(response: aiohttp.ClientResponse) -> None:
    """Forward only known codes, never arbitrary bridge error details."""
    if response.status not in {409, 410, 503}:
        return
    data = json.loads(await read_bounded(response.content, 4096))
    code = data.get("error") if isinstance(data, dict) else None
    statuses = {
        "live_busy": 409,
        "live_stopping": 409,
        "recording_busy": 409,
        "recording_unavailable": 503,
        "recording_expired": 410,
        "history_incomplete": 503,
        "thumbnail_unavailable": 503,
    }
    if isinstance(code, str) and statuses.get(code) == response.status:
        raise BridgeRecordingError(code, response.status)


class BridgeAuthError(BridgeError):
    """Bridge rejected its access token."""


@dataclass(frozen=True, slots=True)
class CameraInfo:
    """Whitelisted, non-secret inventory fields."""

    serial: str
    name: str
    model: str
    hardware: str
    software: str
    battery: float | None
    snapshot_received_at: str | None


@dataclass(frozen=True, slots=True)
class BridgeState:
    """Protocol version and current push inventory."""

    bridge_id: str
    auth: str
    cameras: dict[str, CameraInfo]
    webrtc: bool = False

    @classmethod
    def parse(cls, data: Any) -> BridgeState:
        """Validate the protocol at the boundary, before updating HA state."""
        try:
            if data["protocol"] != 1 or not isinstance(data["cameras"], list):
                raise ValueError
            bridge_id, auth = data["bridge_id"], data["auth"]
            if not isinstance(bridge_id, str) or not 1 <= len(bridge_id) <= 128:
                raise ValueError
            if auth not in {
                "unconfigured",
                "connected",
                "connecting",
                "error",
                "verify",
                "captcha",
            }:
                raise ValueError
            cameras = {}
            if len(data["cameras"]) > 100:
                raise ValueError
            for item in data["cameras"]:
                serial = item["serial"]
                if (
                    not isinstance(serial, str)
                    or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", serial)
                    or serial in cameras
                ):
                    raise ValueError
                for field in ("name", "model", "hardware", "software"):
                    if not isinstance(item[field], str) or len(item[field]) > 256:
                        raise ValueError
                battery = item["battery"]
                if battery is not None and (
                    type(battery) not in (int, float) or not 0 <= battery <= 100
                ):
                    raise ValueError
                received = item["snapshot_received_at"]
                if received is not None and not isinstance(received, str):
                    raise ValueError
                cameras[serial] = CameraInfo(
                    **{key: item[key] for key in CameraInfo.__dataclass_fields__}
                )
            return cls(bridge_id, auth, cameras, "webrtc" in data.get("transports", []))
        except (KeyError, TypeError, ValueError) as err:
            raise BridgeError("Invalid bridge protocol") from err


def normalize_url(value: str) -> str:
    """Accept explicit HTTP(S) endpoints without embedded secrets or paths."""
    try:
        url = URL(value)
        if (
            url.scheme not in {"http", "https"}
            or not url.host
            or url.user
            or url.password
            or url.query_string
            or url.fragment
            or url.path not in {"", "/"}
        ):
            raise ValueError
        _ = url.port
        return str(url.with_path(""))
    except (TypeError, ValueError) as err:
        raise BridgeError("Invalid bridge URL") from err


async def read_bounded(content: aiohttp.StreamReader, limit: int) -> bytes:
    """Consume fragmented HTTP bodies to EOF without exceeding the size limit."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in content.iter_chunked(65536):
        size += len(chunk)
        if size > limit:
            raise BridgeError("Bridge response too large")
        chunks.append(chunk)
    return b"".join(chunks)


class BridgeClient:
    """No cloud access, no automatic media reconnect, no polling."""

    def __init__(self, session: aiohttp.ClientSession, url: str, token: str) -> None:
        self._session = session
        self.url = normalize_url(url)
        self._headers = {"Authorization": f"Bearer {token}"}

    async def request(
        self, method: str, path: str, data: dict[str, Any] | None = None
    ) -> Any:
        """Execute a bounded request; never forward secrets across redirects."""
        try:
            async with asyncio.timeout(62):
                async with self._session.request(
                    method,
                    self.url + path,
                    json=data,
                    headers=self._headers,
                    allow_redirects=False,
                ) as response:
                    if response.status == 401:
                        raise BridgeAuthError("Bridge authentication failed")
                    if response.status != 200:
                        if path.startswith(("/v1/recordings", "/v1/recording-days")):
                            await check_recording_error(response)
                        raise BridgeError("Bridge request failed")
                    raw = await read_bounded(
                        response.content,
                        4_194_304 if path.startswith("/v1/recordings") else 1_048_576,
                    )

                    return json.loads(raw)
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise BridgeError("Cannot communicate with bridge") from err

    async def state(self) -> BridgeState:
        """Read cached bridge inventory once during setup."""
        return BridgeState.parse(await self.request("GET", "/v1/state"))

    async def login(self, data: dict[str, Any]) -> dict[str, Any]:
        """Submit credentials or a challenge without retaining them in HA."""
        result = await self.request("POST", "/v1/login", data)
        if not isinstance(result, dict) or "state" not in result:
            raise BridgeError("Invalid login response")
        return result

    async def snapshot(self, serial: str) -> bytes | None:
        """Read an existing image from bridge memory; never capture a new frame."""
        try:
            async with asyncio.timeout(10):
                async with self._session.get(
                    self.url + f"/v1/snapshot/{serial}",
                    headers=self._headers,
                    allow_redirects=False,
                ) as response:
                    if response.status == 404:
                        return None
                    if response.status != 200 or response.content_type not in {
                        "image/jpeg",
                        "image/png",
                    }:
                        raise BridgeError("Snapshot unavailable")
                    return await read_bounded(response.content, 5_000_000)
        except (aiohttp.ClientError, TimeoutError) as err:
            raise BridgeError("Snapshot unavailable") from err

    async def recording_video(
        self, serial: str, recording_id: str, *, thumbnail: bool = False
    ) -> bytes:
        """Fetch one finite existing clip; cancellation closes the upstream socket."""
        try:
            async with asyncio.timeout(62):
                async with self._session.get(
                    self.url
                    + f"/v1/recordings/{serial}/{recording_id}/"
                    + ("thumbnail" if thumbnail else "video"),
                    headers=self._headers,
                    allow_redirects=False,
                ) as response:
                    await check_recording_error(response)
                    if response.status != 200 or response.content_type != (
                        "image/jpeg" if thumbnail else "video/mp4"
                    ):
                        raise BridgeError("Recording unavailable")
                    return await read_bounded(
                        response.content, (2 if thumbnail else 32) * 1024 * 1024
                    )
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise BridgeError("Recording unavailable") from err

    async def websocket(self, path: str) -> aiohttp.ClientWebSocketResponse:
        """Open an authenticated local socket with bounded receive frames."""
        try:
            async with asyncio.timeout(10):
                return await self._session.ws_connect(
                    self.url + path,
                    headers=self._headers,
                    heartbeat=20,
                    max_msg_size=1_048_576,
                    compress=0,
                )
        except aiohttp.WSServerHandshakeError as err:
            if err.status == 401:
                raise BridgeAuthError("Bridge authentication failed") from err
            raise BridgeError("Bridge socket rejected") from err
        except (aiohttp.ClientError, TimeoutError) as err:
            raise BridgeError("Bridge socket unavailable") from err
