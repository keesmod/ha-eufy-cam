"""Storage bounds and cancellation include in-flight I/O and response owners."""

import asyncio
import threading
from unittest.mock import patch

import pytest
from aiohttp import ClientSession, web

from custom_components.eufy_viewer.api import BridgeClient, BridgeError
from custom_components.eufy_viewer.playback import PlaybackView
from custom_components.eufy_viewer.recording_file import RecordingFile


async def test_shared_budget_counts_pending_and_reader_owned_files(tmp_path):
    store = PlaybackView(str(tmp_path))
    with patch("custom_components.eufy_viewer.recording_file.RECORDING_BYTES", 10):
        async with store.reserve() as first:
            await first.write(b"123456")
            first.retain()
        assert first.file is not None
        assert store.budget.used == 6
        async with store.reserve() as second:
            await second.write(b"7890")
            with pytest.raises(ValueError, match="storage limit"):
                await second.write(b"x")
            assert store.budget.used == 10
        assert store.budget.used == 6
        first.close()
        assert store.budget.used == 0
    assert not list(tmp_path.iterdir())


async def test_admission_counts_preparation_before_bytes_arrive(tmp_path):
    store = PlaybackView(str(tmp_path))
    with patch("custom_components.eufy_viewer.playback.MAX_RECORDING_FILES", 1):
        async with store.reserve():
            from custom_components.eufy_viewer.api import BridgeRecordingError

            with pytest.raises(BridgeRecordingError):
                async with store.reserve():
                    pytest.fail("second preparation admitted")
        async with store.reserve() as later:
            assert later.owners == 1
    assert store.budget.used == 0


async def test_cancelled_disk_write_is_joined_before_close(tmp_path):
    file = RecordingFile(str(tmp_path))
    await file.open()
    started, finish = threading.Event(), threading.Event()
    actual = file.file
    assert actual is not None

    def blocked(chunk):
        started.set()
        assert finish.wait(3)
        return actual.write(chunk)

    with patch.object(file, "file") as proxy:
        proxy.write.side_effect = blocked
        task = asyncio.create_task(file.write(b"media"))
        await asyncio.to_thread(started.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        assert file.budget.used == 5
        finish.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    file.close()
    assert actual.closed
    assert file.budget.used == 0
    assert not list(tmp_path.iterdir())


async def test_open_failure_and_cancelled_creation_release_slots(tmp_path):
    store = PlaybackView(str(tmp_path))
    with patch(
        "custom_components.eufy_viewer.recording_file.tempfile.TemporaryFile",
        side_effect=OSError("No space left on device"),
    ):
        with pytest.raises((OSError, BridgeError)):
            async with store.reserve():
                pytest.fail("unavailable storage admitted")
    assert all(not file.owners for file in store.files)
    async with store.reserve() as file:
        assert file.file is not None


async def test_large_http_media_crosses_old_limit_with_ranges_and_cleanup(
    aiohttp_server, socket_enabled, tmp_path
):
    size = 33563861 + 131072
    chunk = b"m" * 65536

    async def source(request):
        response = web.StreamResponse(headers={"Content-Type": "video/mp4"})
        await response.prepare(request)
        remaining = size
        while remaining:
            data = chunk[: min(remaining, len(chunk))]
            await response.write(data)
            remaining -= len(data)
        return response

    app = web.Application()
    app.router.add_get("/v1/recordings/CAM/abc/video", source)
    server = await aiohttp_server(app)
    store = PlaybackView(str(tmp_path))
    async with store.reserve() as file, ClientSession() as session:
        client = BridgeClient(session, str(server.make_url("")), "test")
        assert await client.recording_media("CAM", "abc", target=file) is None
        assert file.size == size
        assert store.budget.used == size
        ranges = web.Application()

        async def serve_file(request):
            return await store.send(request, file)

        ranges.router.add_get("/clip", serve_file)
        target = await aiohttp_server(ranges)
        for value, expected, length in (
            ("bytes=33554430-33554435", "bytes 33554430-33554435/", 6),
            ("bytes=-7", f"bytes {size - 7}-{size - 1}/", 7),
        ):
            async with session.get(
                target.make_url("/clip"), headers={"Range": value}
            ) as response:
                assert response.status == 206
                assert response.headers["Content-Range"] == expected + str(size)
                assert await response.read() == b"m" * length
    assert file.file is None
    assert store.budget.used == 0
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("failure", ["oversized", "empty", "disk", "truncated"])
async def test_failed_http_media_never_leaves_storage(
    aiohttp_server, socket_enabled, tmp_path, failure
):
    async def source(request):
        if failure == "truncated":
            response = web.StreamResponse(
                headers={"Content-Type": "video/mp4", "Content-Length": "99"}
            )
            await response.prepare(request)
            await response.write(b"short")
            request.transport.close()
            return response
        return web.Response(
            body=b"" if failure == "empty" else b"12345678901",
            content_type="video/mp4",
        )

    app = web.Application()
    app.router.add_get("/v1/recordings/CAM/abc/video", source)
    server = await aiohttp_server(app)
    store = PlaybackView(str(tmp_path))
    async with ClientSession() as session:
        client = BridgeClient(session, str(server.make_url("")), "test")
        with pytest.raises(BridgeError):
            async with store.reserve() as file:
                if failure == "disk":
                    with patch.object(file, "write", side_effect=OSError("full")):
                        await client.recording_media("CAM", "abc", target=file)
                else:
                    with patch(
                        "custom_components.eufy_viewer.recording_file.RECORDING_BYTES",
                        10,
                    ):
                        await client.recording_media("CAM", "abc", target=file)
    assert store.budget.used == 0
    assert not list(tmp_path.iterdir())


async def test_reader_keeps_storage_after_session_close_and_releases_on_disconnect(
    aiohttp_server, socket_enabled, tmp_path
):
    store = PlaybackView(str(tmp_path))
    file = RecordingFile(str(tmp_path), store.budget)
    await file.open()
    await file.write(b"recording")
    started, finish = asyncio.Event(), asyncio.Event()
    original = file.read

    async def blocked(offset, size):
        started.set()
        await finish.wait()
        return await original(offset, size)

    app = web.Application()

    async def serve_file(request):
        return await store.send(request, file)

    app.router.add_get("/clip", serve_file)
    server = await aiohttp_server(app)
    async with ClientSession() as client:
        with patch.object(file, "read", side_effect=blocked):
            response = await client.get(server.make_url("/clip"))
            await started.wait()
            file.close()
            assert file.owners == 1
            assert store.budget.used == 9
            assert store.readers == 1
            with patch("custom_components.eufy_viewer.playback.MAX_RECORDING_FILES", 1):
                assert (await client.get(server.make_url("/clip"))).status == 503
            finish.set()
            assert await response.read() == b"recording"
    assert file.file is None
    assert file.owners == 0
    assert store.readers == 0
    assert store.budget.used == 0
