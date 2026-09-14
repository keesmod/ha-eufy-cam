"""Private recording files with explicit owners and bounded storage admission."""

from __future__ import annotations

import asyncio
import os
import tempfile
from collections.abc import Callable
from functools import partial
from pathlib import Path
from typing import Any, BinaryIO

RECORDING_BYTES = 256 * 1024 * 1024
MAX_RECORDING_FILES = 8
CHUNK_BYTES = 64 * 1024


async def disk_call(function: Callable[..., Any], *args: Any) -> Any:
    """Join disk work on cancellation before its file can be closed or reused."""
    future = asyncio.get_running_loop().run_in_executor(None, partial(function, *args))
    cancelled = False
    while not future.done():
        try:
            await asyncio.shield(future)
        except asyncio.CancelledError:
            cancelled = True
        except Exception:
            break
    try:
        return future.result()
    finally:
        if cancelled:
            raise asyncio.CancelledError


class RecordingStorageError(ValueError):
    """A recording exceeds the shared storage allowance."""


class RecordingBudget:
    """One aggregate allowance for all pending, playing and closing recordings."""

    def __init__(self) -> None:
        self.used = 0

    def claim(self, size: int) -> None:
        if self.used + size > RECORDING_BYTES:
            raise RecordingStorageError("Recording storage limit")
        self.used += size


class RecordingFile:
    """An anonymous file survives only while preparation or a reader owns it."""

    def __init__(
        self, directory: str | None = None, budget: RecordingBudget | None = None
    ) -> None:
        self.budget = budget if budget is not None else RecordingBudget()
        self.directory = directory
        self.file: BinaryIO | None = None
        self.size = 0
        self.owners = 1

    async def open(self) -> None:
        """Create without leaving a pathname behind on process termination."""

        # Assign inside the worker so cancelled creation can still close it.
        def create() -> None:
            if self.directory is not None:
                Path(self.directory).mkdir(mode=0o700, parents=True, exist_ok=True)
            self.file = tempfile.TemporaryFile(buffering=0, dir=self.directory)

        await disk_call(create)

    def retain(self) -> None:
        """Keep the descriptor and its storage reservation during a response."""
        if not self.owners:
            raise ValueError("Recording closed")
        self.owners += 1

    def close(self) -> None:
        """The final owner releases the file, including on expiry and errors."""
        self.owners -= 1
        if not self.owners:
            self.budget.used -= self.size
            if self.file is not None:
                self.file.close()
                self.file = None

    async def write(self, chunk: bytes) -> None:
        """Apply the disk budget before writing, without whole-clip copies."""
        self.budget.claim(len(chunk))
        self.size += len(chunk)
        assert self.file is not None
        written = await disk_call(self.file.write, chunk)
        if written != len(chunk):
            raise OSError("Incomplete recording write")

    async def read(self, offset: int, size: int) -> bytes:
        """Independent offsets allow concurrent seek requests on one file."""
        assert self.file is not None
        return await disk_call(os.pread, self.file.fileno(), size, offset)
