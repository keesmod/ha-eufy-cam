"""Recording access must enforce HA entity permissions and propagate cancellation."""

import asyncio
from unittest.mock import AsyncMock, Mock, PropertyMock, patch

import pytest

from custom_components.eufy_viewer.api import BridgeError

from .test_viewers import viewer_setup as _viewer_setup

viewer_setup = _viewer_setup

BASE = "/api/eufy_viewer/recordings/camera.front_door"
CLIP = "a" * 32


async def test_history_and_clip_are_authenticated_entity_routes(
    hass, hass_client, viewer_setup
):
    client = await hass_client()
    api = viewer_setup.runtime_data.api
    data = {"recordings": [{"id": CLIP}], "returned": 1}
    with patch.object(api, "request", AsyncMock(return_value=data)) as query:
        response = await client.get(BASE + "?date=2026-09-05")
        assert response.status == 200
        assert await response.json() == data
        assert response.headers["Cache-Control"] == "no-store"
        query.assert_awaited_once_with("GET", "/v1/recordings/CAM123?date=2026-09-05")
    with patch.object(api, "recording_video", AsyncMock(return_value=b"mp4")) as video:
        response = await client.get(BASE + "/" + CLIP)
        assert response.status == 200
        assert response.content_type == "video/mp4"
        assert await response.read() == b"mp4"
        video.assert_awaited_once_with("CAM123", CLIP)


async def test_denied_entity_and_invalid_paths_never_reach_bridge(
    hass, hass_client, viewer_setup
):
    client = await hass_client()
    api = viewer_setup.runtime_data.api
    with (
        patch.object(api, "request") as query,
        patch.object(api, "recording_video") as video,
    ):
        for url, status in [
            (BASE, 400),
            (BASE + "/not-an-id", 400),
            (BASE.replace("camera.", "sensor.") + "?date=2026-09-05", 404),
        ]:
            assert (await client.get(url)).status == status
        permissions = Mock()
        permissions.check_entity.return_value = False
        with patch(
            "homeassistant.auth.models.User.permissions",
            new_callable=PropertyMock,
            return_value=permissions,
        ):
            assert (await client.get(BASE + "/" + CLIP)).status == 403
        query.assert_not_called()
        video.assert_not_called()


async def test_upstream_error_is_redacted(hass, hass_client, viewer_setup):
    client = await hass_client()
    with patch.object(
        viewer_setup.runtime_data.api,
        "recording_video",
        side_effect=BridgeError("secret path and token"),
    ):
        response = await client.get(BASE + "/" + CLIP)
        assert response.status == 502
        assert "secret" not in await response.text()


async def test_browser_abort_cancels_pending_download(hass, hass_client, viewer_setup):
    client = await hass_client()
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def pending(*_):
        started.set()
        try:
            await asyncio.Future()
        finally:
            cancelled.set()

    with patch.object(
        viewer_setup.runtime_data.api, "recording_video", side_effect=pending
    ):
        task = asyncio.create_task(client.get(BASE + "/" + CLIP))
        await asyncio.wait_for(started.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.wait_for(cancelled.wait(), 2)


async def test_stop_recovery_reason_is_forwarded(hass, hass_client, viewer_setup):
    from custom_components.eufy_viewer.api import BridgeRecordingError

    client = await hass_client()
    with patch.object(
        viewer_setup.runtime_data.api,
        "request",
        side_effect=BridgeRecordingError("live_stopping", 409),
    ):
        response = await client.get(BASE + "?date=2026-09-05")
        assert response.status == 409
        assert await response.json() == {"error": "live_stopping"}


async def test_events_and_calendar_map_camera_permissions(
    hass, hass_client, viewer_setup
):
    client = await hass_client()
    api = viewer_setup.runtime_data.api
    url = "/api/eufy_viewer/events?entities=camera.front_door"
    row = {
        "serial": "CAM123",
        "id": CLIP,
        "start": "2026-09-05T12:00:00",
        "end": "2026-09-05T12:01:00",
        "thumbnail": True,
        "storage_path": "must not escape",
    }
    with patch.object(
        api, "request", AsyncMock(return_value={"recordings": [row], "complete": True})
    ) as query:
        response = await client.get(url + "&date=2026-09-05")
        assert response.status == 200
        data = await response.json()
        assert data["recordings"][0]["entity_id"] == "camera.front_door"
        assert "storage_path" not in str(data)
        query.assert_awaited_once_with(
            "GET", "/v1/recordings?cameras=CAM123&date=2026-09-05"
        )
    with patch.object(api, "request", AsyncMock(return_value={"days": ["2026-09-05"]})):
        response = await client.get(url + "&month=2026-09")
        assert response.status == 200
        assert await response.json() == {"days": ["2026-09-05"], "scope": "homebase"}
    with patch.object(api, "recording_video", AsyncMock(return_value=b"jpeg")) as image:
        response = await client.get(BASE + "/" + CLIP + "/thumbnail")
        assert response.content_type == "image/jpeg"
        image.assert_awaited_once_with("CAM123", CLIP, thumbnail=True)


async def test_events_reject_partial_malformed_and_unauthorized_results(
    hass, hass_client, viewer_setup
):
    client = await hass_client()
    api = viewer_setup.runtime_data.api
    url = "/api/eufy_viewer/events?entities=camera.front_door"
    with patch.object(api, "request", AsyncMock()) as query:
        for suffix in ("", "&month=2026-09&date=2026-09-05", "&date=no", "&month=no"):
            assert (await client.get(url + suffix)).status == 400
        assert (
            await client.get("/api/eufy_viewer/events?date=2026-09-05")
        ).status == 400
        assert (await client.get(BASE + "/" + CLIP + "/unsafe")).status == 400
        query.assert_not_called()
        for result in (
            None,
            {"complete": False, "recordings": []},
            {"complete": True, "recordings": [{"serial": "DENIED"}]},
            {
                "complete": True,
                "recordings": [{"serial": "CAM123", "id": CLIP, "start": 0}],
            },
        ):
            query.return_value = result
            assert (await client.get(url + "&date=2026-09-05")).status == 502
        for result in ({"days": ["2026-10-01"]}, {"days": [1]}, {"days": None}):
            query.return_value = result
            assert (await client.get(url + "&month=2026-09")).status == 502
        permissions = Mock()
        permissions.check_entity.return_value = False
        with patch(
            "homeassistant.auth.models.User.permissions",
            new_callable=PropertyMock,
            return_value=permissions,
        ):
            query.reset_mock()
            assert (await client.get(url + "&month=2026-09")).status == 403
            assert (await client.get(BASE + "/" + CLIP + "/thumbnail")).status == 403
            query.assert_not_called()


async def test_calendar_does_not_leak_days_of_other_cameras(
    hass, hass_client, viewer_setup
):
    from dataclasses import replace

    coordinator = viewer_setup.runtime_data
    original = coordinator.data
    coordinator.async_set_updated_data(
        replace(
            original,
            cameras={**original.cameras, "PRIVATE": original.cameras["CAM123"]},
        )
    )
    client = await hass_client()
    with patch.object(coordinator.api, "request") as query:
        response = await client.get(
            "/api/eufy_viewer/events?entities=camera.front_door&month=2026-09"
        )
        assert response.status == 403
        query.assert_not_called()


async def test_unsupported_recordings_never_reach_bridge(
    hass, hass_client, viewer_setup
):
    info = viewer_setup.runtime_data.data.cameras["CAM123"]
    info.capabilities["recordings"] = {
        "available": False,
        "status": "unsupported",
        "reason": "camera_media_unverified",
    }
    client = await hass_client()
    with (
        patch.object(viewer_setup.runtime_data.api, "request") as query,
        patch.object(viewer_setup.runtime_data.api, "recording_video") as media,
    ):
        for path in (
            BASE + "?date=2026-09-11",
            BASE + "/" + CLIP,
            BASE + "/" + CLIP + "/thumbnail",
            "/api/eufy_viewer/events?entities=camera.front_door&date=2026-09-11",
        ):
            response = await client.get(path)
            assert response.status == 503
            assert (await response.json())["error"] == "capability_unavailable"
        query.assert_not_called()
        media.assert_not_called()


async def test_unsupported_other_camera_keeps_authorized_calendar_available(
    hass, hass_client, viewer_setup
):
    from custom_components.eufy_viewer.api import BridgeState

    from .conftest import STATE

    second = {
        **STATE["cameras"][0],
        "serial": "SOLO",
        "name": "Standalone",
        "capabilities": {
            "recordings": {
                "available": False,
                "status": "unsupported",
                "reason": "standalone_transport_unverified",
            }
        },
    }
    viewer_setup.runtime_data.async_set_updated_data(
        BridgeState.parse({**STATE, "cameras": [STATE["cameras"][0], second]})
    )
    await hass.async_block_till_done()
    client = await hass_client()
    with patch.object(
        viewer_setup.runtime_data.api,
        "request",
        AsyncMock(return_value={"days": ["2026-09-11"]}),
    ) as query:
        url = "/api/eufy_viewer/events?entities=camera.front_door&month=2026-09"
        assert (await client.get(url)).status == 200
        query.assert_awaited_once_with(
            "GET", "/v1/recording-days?cameras=CAM123&month=2026-09"
        )
        permissions = Mock()
        permissions.check_entity.side_effect = lambda entity, policy: (
            entity != "camera.standalone"
        )
        with patch(
            "homeassistant.auth.models.User.permissions",
            new_callable=PropertyMock,
            return_value=permissions,
        ):
            query.reset_mock()
            assert (await client.get(url)).status == 403
            query.assert_not_called()
