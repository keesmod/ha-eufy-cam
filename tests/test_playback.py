"""Native playback retains authentication, range support and bounded lifetime."""

import asyncio
from unittest.mock import AsyncMock, Mock, PropertyMock, patch

import pytest

from custom_components.eufy_viewer.playback import PlaybackView

from .test_recordings import BASE, CLIP
from .test_viewers import viewer_setup as _viewer_setup

viewer_setup = _viewer_setup
PREPARE = BASE + "/" + CLIP + "/playback"


async def test_signed_playback_ranges_permissions_and_close(
    hass, hass_client, hass_client_no_auth, viewer_setup
):
    client = await hass_client()
    native = await hass_client_no_auth()
    body = b"0123456789"
    with patch.object(
        viewer_setup.runtime_data.api, "recording_video", AsyncMock(return_value=body)
    ) as download:
        assert (await native.post(PREPARE)).status == 401
        response = await client.post(PREPARE)
        assert response.status == 200
        assert response.headers["Cache-Control"] == "no-store"
        data = await response.json()
        assert (await native.get(data["path"])).status == 401
        assert (await native.get(data["url"] + "x")).status == 401
        response = await native.get(data["url"])
        assert response.status == 200
        assert await response.read() == body
        assert response.headers["Accept-Ranges"] == "bytes"
        assert response.headers["Cache-Control"] == "no-store"
        assert (await native.head(data["url"])).headers["Content-Length"] == "10"
        for value, expected, content_range in (
            ("bytes=0-1", b"01", "bytes 0-1/10"),
            ("bytes=4-", b"456789", "bytes 4-9/10"),
            ("bytes=-3", b"789", "bytes 7-9/10"),
            ("bytes=8-99", b"89", "bytes 8-9/10"),
        ):
            response = await native.get(data["url"], headers={"Range": value})
            assert response.status == 206
            assert response.headers["Content-Range"] == content_range
            assert await response.read() == expected
        for value in ("bytes=10-", "bytes=4-2", "bytes=0-1,3-4", "invalid"):
            response = await native.get(data["url"], headers={"Range": value})
            assert response.status == 416
            assert response.headers["Content-Range"] == "bytes */10"
        permissions = Mock()
        permissions.check_entity.return_value = False
        with patch(
            "homeassistant.auth.models.User.permissions",
            new_callable=PropertyMock,
            return_value=permissions,
        ):
            assert (await native.get(data["url"])).status == 403
        other = await hass.auth.async_create_user("Other user")
        token = await hass.auth.async_create_refresh_token(
            other, client_id="http://localhost/"
        )
        headers = {
            "Authorization": "Bearer " + hass.auth.async_create_access_token(token)
        }
        assert (await native.get(data["path"], headers=headers)).status == 403
        assert (await native.delete(data["path"], headers=headers)).status == 403
        assert (await native.delete(data["url"])).status == 401
        assert (await client.delete(data["path"])).status == 204
        assert (await native.get(data["url"])).status == 404
        download.assert_awaited_once_with("CAM123", CLIP)


async def test_expiry_and_capacity_release_memory(hass, hass_client, viewer_setup):
    client = await hass_client()
    with (
        patch.object(
            viewer_setup.runtime_data.api, "recording_video", return_value=b"mp4"
        ),
        patch("custom_components.eufy_viewer.playback.PLAYBACK_SECONDS", 0.1),
        patch("custom_components.eufy_viewer.playback.MAX_PLAYBACK_BYTES", 3),
    ):
        response = await client.post(PREPARE)
        first = await response.json()
        assert response.status == 200
        assert (await client.post(PREPARE)).status == 409
        await asyncio.sleep(0.15)
        assert (await client.get(first["path"])).status == 404
        response = await client.post(PREPARE)
        assert response.status == 200
        assert (await client.delete((await response.json())["path"])).status == 204


async def test_prepare_denial_errors_and_cancel(hass, hass_client, viewer_setup):
    client = await hass_client()
    with patch.object(
        viewer_setup.runtime_data.api, "recording_video", AsyncMock()
    ) as api:
        assert (await client.post(PREPARE.replace(CLIP, "bad"))).status == 400
        api.assert_not_awaited()
        for body in (b"", b"1234"):
            api.return_value = body
            with patch("custom_components.eufy_viewer.playback.MAX_CLIP_BYTES", 3):
                assert (await client.post(PREPARE)).status == 502
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def pending(*_):
        started.set()
        try:
            await asyncio.Future()
        finally:
            cancelled.set()

    with (
        patch.object(
            viewer_setup.runtime_data.api, "recording_video", side_effect=pending
        ),
        patch.object(PlaybackView, "add") as add,
    ):
        task = asyncio.create_task(client.post(PREPARE))
        await asyncio.wait_for(started.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.wait_for(cancelled.wait(), 2)
        add.assert_not_called()


async def test_unload_releases_prepared_recordings(hass, hass_client, viewer_setup):
    from custom_components.eufy_viewer.const import DOMAIN

    client = await hass_client()
    with patch.object(
        viewer_setup.runtime_data.api, "recording_video", return_value=b"mp4"
    ):
        data = await (await client.post(PREPARE)).json()
    cache = hass.data[DOMAIN]["playback"]
    assert len(cache.sessions) == 1
    await hass.config_entries.async_unload(viewer_setup.entry_id)
    assert not cache.sessions
    assert (await client.get(data["path"])).status == 404


async def test_native_preparation_is_explicit_and_validated(
    hass, hass_client, viewer_setup
):
    client = await hass_client()
    with patch.object(
        viewer_setup.runtime_data.api, "recording_video", AsyncMock(return_value=b"mp4")
    ) as download:
        assert (await client.post(PREPARE + "?format=unknown")).status == 400
        download.assert_not_awaited()
        response = await client.post(PREPARE + "?format=native")
        assert response.status == 200
        download.assert_awaited_once_with("CAM123", CLIP, native=True)
        data = await response.json()
        assert await (await client.get(data["path"])).read() == b"mp4"
        assert (await client.delete(data["path"])).status == 204
