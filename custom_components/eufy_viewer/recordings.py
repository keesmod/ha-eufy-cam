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


def camera_access(
    request: web.Request, entity_id: str, *, require_recordings: bool = True
) -> tuple[EufyCoordinator, str]:
    """Resolve the current owner only after checking the caller permission."""
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
    if require_recordings and not coordinator.data.cameras[serial].permits(
        "recordings"
    ):
        raise web.HTTPServiceUnavailable(
            text='{"error":"capability_unavailable"}', content_type="application/json"
        )
    return coordinator, serial


class RecordingsView(HomeAssistantView):
    """No anonymous media URLs, tokens in URLs, or camera control through paths."""

    url = "/api/eufy_viewer/recordings/{entity_id}"
    extra_urls = [
        "/api/eufy_viewer/recordings/{entity_id}/{recording_id}",
        "/api/eufy_viewer/recordings/{entity_id}/{recording_id}/{media}",
    ]
    name = "api:eufy_viewer:recordings"
    requires_auth = True

    async def get(
        self,
        request: web.Request,
        entity_id: str,
        recording_id: str | None = None,
        media: str | None = None,
    ) -> web.Response:
        """Cancel the bridge request if the browser leaves during preparation."""
        if media not in {None, "thumbnail"}:
            raise web.HTTPBadRequest
        coordinator, serial = camera_access(request, entity_id)
        date = request.query.get("date", "")
        if recording_id is not None:
            if not re.fullmatch(r"[a-f0-9]{32}", recording_id):
                raise web.HTTPBadRequest
        elif not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            raise web.HTTPBadRequest

        async def fetch() -> Any:
            if recording_id:
                if media == "thumbnail":
                    return await coordinator.api.recording_video(
                        serial, recording_id, thumbnail=True
                    )
                return await coordinator.api.recording_video(serial, recording_id)
            return await coordinator.api.request(
                "GET", f"/v1/recordings/{serial}?date={date}"
            )

        return await serve(
            request,
            fetch(),
            "image/jpeg"
            if media == "thumbnail"
            else "video/mp4"
            if recording_id
            else None,
        )


async def serve(
    request: web.Request, operation: Any, content_type: str | None = None
) -> web.Response:
    """A disconnected viewer always cancels the one bounded upstream operation."""
    task = asyncio.create_task(operation)
    try:
        async with asyncio.timeout(65):
            while not task.done():
                await asyncio.wait({task}, timeout=0.5)
                if request.transport is None or request.transport.is_closing():
                    raise asyncio.CancelledError
            result = task.result()
        if content_type:
            return web.Response(
                body=result,
                content_type=content_type,
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


class EventsView(HomeAssistantView):
    """One history query per bridge, with camera permissions before any request."""

    url = "/api/eufy_viewer/events"
    name = "api:eufy_viewer:events"
    requires_auth = True

    async def get(self, request: web.Request) -> web.Response:
        """Return authorized event handles or HomeBase-wide calendar markers."""
        entities = list(dict.fromkeys(request.query.get("entities", "").split(",")))
        if (
            not entities
            or len(entities) > 100
            or any(not re.fullmatch(r"camera\.[a-z0-9_]+", e) for e in entities)
        ):
            raise web.HTTPBadRequest
        month, date = request.query.get("month"), request.query.get("date")
        if bool(month) == bool(date) or not re.fullmatch(
            r"\d{4}-\d{2}" if month else r"\d{4}-\d{2}-\d{2}", month or date or ""
        ):
            raise web.HTTPBadRequest
        groups: dict[EufyCoordinator, dict[str, str]] = {}
        for entity_id in entities:
            coordinator, serial = camera_access(request, entity_id)
            groups.setdefault(coordinator, {})[serial] = entity_id
        # The firmware's calendar is HomeBase-wide. Never expose the presence of
        # other cameras' events to a user without access to the full inventory.
        if month:
            hass = request.app[KEY_HASS]
            registry = er.async_get(hass)
            for coordinator in groups:
                for serial in coordinator.data.cameras:
                    calendar_entity = registry.async_get_entity_id(
                        "camera", DOMAIN, f"{serial}_camera"
                    )
                    if calendar_entity is None:
                        raise web.HTTPForbidden
                    camera_access(request, calendar_entity, require_recordings=False)

        async def fetch() -> dict[str, Any]:
            days: set[str] = set()
            recordings: list[dict[str, Any]] = []
            for coordinator, serial_map in groups.items():
                cameras = ",".join(serial_map)
                path = (
                    f"/v1/recording-days?cameras={cameras}&month={month}"
                    if month
                    else f"/v1/recordings?cameras={cameras}&date={date}"
                )
                data = await coordinator.api.request("GET", path)
                if not isinstance(data, dict):
                    raise BridgeError("Invalid event response")
                if month:
                    values = data.get("days")
                    if (
                        not isinstance(values, list)
                        or len(values) > 31
                        or any(
                            not isinstance(day, str)
                            or not re.fullmatch(re.escape(month) + r"-\d{2}", day)
                            for day in values
                        )
                    ):
                        raise BridgeError("Invalid calendar")
                    days.update(values)
                else:
                    values = data.get("recordings")
                    if (
                        data.get("complete") is not True
                        or not isinstance(values, list)
                        or len(values) > 10000
                    ):
                        raise BridgeError("Incomplete history")
                    for row in values:
                        if (
                            not isinstance(row, dict)
                            or row.get("serial") not in serial_map
                            or not re.fullmatch(r"[a-f0-9]{32}", str(row.get("id", "")))
                            or any(
                                not isinstance(row.get(k), str)
                                for k in ("start", "end")
                            )
                        ):
                            raise BridgeError("Invalid event")
                        recordings.append(
                            {
                                "entity_id": serial_map[row["serial"]],
                                "id": row["id"],
                                "start": row["start"],
                                "end": row["end"],
                                "thumbnail": row.get("thumbnail") is True,
                            }
                        )
            if len(recordings) > 10000:
                raise BridgeError("Too many events")
            return (
                {"days": sorted(days), "scope": "homebase"}
                if month
                else {
                    "recordings": sorted(
                        recordings, key=lambda r: r["start"], reverse=True
                    ),
                    "complete": True,
                }
            )

        return await serve(request, fetch())
