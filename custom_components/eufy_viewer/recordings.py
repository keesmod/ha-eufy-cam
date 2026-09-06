"""Authenticated, entity-authorized access to existing HomeBase recordings."""

from __future__ import annotations

import asyncio
import re
from typing import Any

import aiohttp
from aiohttp import web
from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components.http import HomeAssistantView
from homeassistant.components.http.const import KEY_HASS, KEY_HASS_USER
from homeassistant.helpers import entity_registry as er

from .api import BridgeError, BridgeRecordingError
from .const import DOMAIN
from .coordinator import EufyCoordinator


class RecordingsView(HomeAssistantView):
    """No anonymous media URLs, tokens in URLs, or camera control through paths."""

    url = "/api/eufy_viewer/recordings/{entity_id}"
    extra_urls = ["/api/eufy_viewer/recordings/{entity_id}/{recording_id}"]
    name = "api:eufy_viewer:recordings"
    requires_auth = True

    async def get(
        self, request: web.Request, entity_id: str, recording_id: str | None = None
    ) -> web.Response:
        """Cancel the bridge request if the browser leaves during preparation."""
        hass = request.app[KEY_HASS]
        if not request[KEY_HASS_USER].permissions.check_entity(entity_id, POLICY_READ):
            raise web.HTTPForbidden
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
            raise web.HTTPNotFound
        coordinator: EufyCoordinator = entry.runtime_data
        serial = entity.unique_id.removesuffix("_camera")
        if (
            serial not in coordinator.data.cameras
            or not coordinator.last_update_success
            or coordinator.data.auth != "connected"
        ):
            raise web.HTTPServiceUnavailable
        date = request.query.get("date", "")
        if recording_id is not None:
            if not re.fullmatch(r"[a-f0-9]{32}", recording_id):
                raise web.HTTPBadRequest
        elif not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            raise web.HTTPBadRequest

        async def fetch() -> Any:
            if recording_id:
                return await coordinator.api.recording_video(serial, recording_id)
            return await coordinator.api.request(
                "GET", f"/v1/recordings/{serial}?date={date}"
            )

        task = asyncio.create_task(fetch())
        try:
            async with asyncio.timeout(65):
                while not task.done():
                    await asyncio.wait({task}, timeout=0.5)
                    if request.transport is None or request.transport.is_closing():
                        raise asyncio.CancelledError
                result = task.result()
            if recording_id:
                return web.Response(
                    body=result,
                    content_type="video/mp4",
                    headers={"Cache-Control": "no-store"},
                )
            return web.json_response(result, headers={"Cache-Control": "no-store"})
        except BridgeRecordingError as err:
            return web.json_response(
                {"error": err.code},
                status=err.status,
                headers={"Cache-Control": "no-store"},
            )
        except (BridgeError, aiohttp.ClientError, TimeoutError) as err:
            raise web.HTTPBadGateway(text="HomeBase recording request failed") from err
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
