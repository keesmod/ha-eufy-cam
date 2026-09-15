"""Real concurrent HTTP readers survive session removal and release their files."""

import asyncio
import os
import threading
from unittest.mock import patch

import pytest
from aiohttp import ClientSession, web

from custom_components.eufy_viewer.api import BridgeRecordingError
from custom_components.eufy_viewer.playback import Playback, PlaybackView


@pytest.mark.parametrize("removal", ["close", "expiry", "unload"])
@pytest.mark.parametrize("disconnect", [False, True])
async def test_overlapping_ranges_outlive_session_and_allow_next_recording(
    aiohttp_server, socket_enabled, tmp_path, caplog, removal, disconnect
):
    store = PlaybackView(str(tmp_path))
    # Distinct bytes at overlapping offsets expose shared seek-position bugs.
    payload = bytes(range(251)) * 1200
    async with store.reserve() as file:
        await file.write(payload)
        file.retain()
        expiry = asyncio.get_running_loop().call_later(3600, store.remove, "clip")
        store.sessions["clip"] = Playback("user", "camera.test", "entry", file, expiry)
    descriptor = file.file
    started = [asyncio.Event(), asyncio.Event()]
    release = [asyncio.Event(), asyncio.Event()]
    completed = [asyncio.Event(), asyncio.Event()]
    requests = []
    responses = []
    original_read = file.read
    ranges = [(123, 140_123), (70_321, 230_321)]

    async def held_read(offset, size):
        for index, (start, _) in enumerate(ranges):
            if offset == start:
                started[index].set()
                await release[index].wait()
        return await original_read(offset, size)

    async def serve_file(request):
        if "clip" not in store.sessions:
            raise web.HTTPNotFound
        index = len(requests)
        requests.append(request)
        try:
            return await store.send(request, file)
        finally:
            completed[index].set()

    app = web.Application()
    app.router.add_get("/clip", serve_file)
    try:
        server = await aiohttp_server(app)
        async with ClientSession() as client:
            with patch.object(file, "read", side_effect=held_read):
                for start, stop in ranges:
                    responses.append(
                        await client.get(
                            server.make_url("/clip"),
                            headers={"Range": f"bytes={start}-{stop - 1}"},
                        )
                    )
                await asyncio.wait_for(
                    asyncio.gather(*(event.wait() for event in started)), 2
                )
                assert file.owners == 3
                assert store.readers == 2
                if removal == "expiry":
                    expiry.cancel()
                    asyncio.get_running_loop().call_soon(store.remove, "clip")
                    await asyncio.sleep(0)
                elif removal == "unload":
                    store.close_entry("entry")
                else:
                    store.remove("clip")
                assert not store.sessions
                assert file.owners == 2
                assert descriptor is not None and not descriptor.closed
                assert store.budget.used == len(payload)
                with patch(
                    "custom_components.eufy_viewer.playback.MAX_RECORDING_FILES", 1
                ):
                    with pytest.raises(BridgeRecordingError, match="recording_busy"):
                        async with store.reserve():
                            pytest.fail("Reader-owned file was reclaimed too early")
                async with client.get(server.make_url("/clip")) as expired:
                    assert expired.status == 404

                if disconnect:
                    # Wait for the actual server-side transport close before
                    # releasing disk reads. No response writes are mocked.
                    closed = asyncio.Event()
                    protocol_type = type(requests[0].protocol)
                    connection_lost = protocol_type.connection_lost

                    def on_close(protocol, error):
                        connection_lost(protocol, error)
                        if protocol is requests[0].protocol:
                            closed.set()

                    with patch.object(protocol_type, "connection_lost", on_close):
                        responses[0].close()
                        await asyncio.wait_for(closed.wait(), 2)
                release[0].set()
                if not disconnect:
                    assert await responses[0].read() == payload[slice(*ranges[0])]
                await asyncio.wait_for(completed[0].wait(), 2)
                assert store.readers == 1
                assert file.owners == 1
                assert not descriptor.closed
                assert store.budget.used == len(payload)

                release[1].set()
                for response, (start, stop) in zip(responses, ranges, strict=True):
                    assert response.status == 206
                    assert response.headers["Content-Range"] == (
                        f"bytes {start}-{stop - 1}/{len(payload)}"
                    )
                assert await responses[1].read() == payload[slice(*ranges[1])]
                await asyncio.wait_for(completed[1].wait(), 2)
        assert file.owners == 0
        assert descriptor.closed
        assert store.readers == 0
        assert store.budget.used == 0
        # The next recording must regain both storage and a preparation slot.
        with patch("custom_components.eufy_viewer.playback.MAX_RECORDING_FILES", 1):
            async with store.reserve() as later:
                await later.write(b"next recording")
                assert await later.read(5, 9) == b"recording"
        assert store.budget.used == 0
        assert not list(tmp_path.iterdir())
        assert not [record for record in caplog.records if record.levelno >= 40]
    finally:
        for event in release:
            event.set()
        for response in responses:
            response.close()
        store.remove("clip")


async def test_cancelled_disk_reader_holds_file_until_worker_finishes(
    tmp_path, monkeypatch
):
    """Cancellation during a real pread must not close/reuse its descriptor."""
    store = PlaybackView(str(tmp_path))
    started, release = threading.Event(), threading.Event()
    pread = os.pread

    def blocked_read(fd, size, offset):
        started.set()
        assert release.wait(3)
        return pread(fd, size, offset)

    monkeypatch.setattr(os, "pread", blocked_read)

    async def reader():
        async with store.reserve() as file:
            await file.write(b"recording")
            return await file.read(0, 9)

    task = asyncio.create_task(reader())
    try:
        assert await asyncio.to_thread(started.wait, 2)
        file = store.files[0]
        descriptor = file.file
        for _ in range(2):
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
            assert descriptor is not None and not descriptor.closed
            assert store.budget.used == 9
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert descriptor.closed
        assert file.owners == 0
        assert store.budget.used == 0
        assert not list(tmp_path.iterdir())
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
