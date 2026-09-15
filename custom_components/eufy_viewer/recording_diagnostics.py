"""Bounded scalar recording evidence, independent of playback file ownership."""

from __future__ import annotations

import re
import secrets
from collections.abc import Callable
from time import monotonic
from typing import Any

RETENTION_MS = 900000
EVENTS = set(
    "admission download conversion transfer cleanup recording_active_nvidia "
    "recording_active_software recording_remuxed recording_hardware_failed "
    "recording_hardware_timeout recording_failed recording_software_fallback "
    "preparing prepared serving client_disconnect response_complete released "
    "expired unloaded failed cancelled file_closed".split()
)
ENUMS = {
    "format": {"auto", "native", "h264"},
    "outcome": {"active", "completed", "failed", "cancelled", "prepared"},
    "stage": {
        "admission",
        "download",
        "conversion",
        "transfer",
        "preparing",
        "prepared",
    },
    "error": set(
        "live_busy live_stopping recording_busy recording_expired "
        "recording_unavailable recording_storage_unavailable "
        "capability_unavailable unclassified".split()
    ),
}
FAILURES = set(
    "spawn process output_io timeout cancelled output_limit "
    "cleanup_unconfirmed empty_output".split()
)
CATEGORIES = set(
    "storage memory cuda_device cuda_driver nvenc_session "
    "nvenc_open_session nvenc_unavailable unsupported_format decode "
    "invalid_input unclassified".split()
)
NUMBERS = {
    "attempt": (1, 2**48 - 1),
    "bridge_attempt": (1, 2**48 - 1),
    "age_ms": (0, 2**31 - 1),
    "duration_ms": (0, 120000),
    "source_bytes": (0, 2**31 - 1),
    "output_bytes": (0, 2**31 - 1),
}


def version(value: Any) -> str:
    """Version numbers only, never arbitrary build strings."""
    return (
        str(value)
        if isinstance(value, str)
        and re.fullmatch(r"[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}", value)
        else "unavailable"
    )


def attempt_header(value: Any) -> int | None:
    """An anonymous reference is not a device or recording identifier."""
    if isinstance(value, str) and re.fullmatch(r"[0-9]{1,15}", value):
        result = int(value)
        if 1 <= result < 2**48:
            return result
    return None


def project_attempt(raw: Any) -> dict[str, Any]:
    """Apply strict field/value allowlists at the download boundary."""
    if not isinstance(raw, dict):
        return {}
    result: dict[str, Any] = {}
    for key, allowed in ENUMS.items():
        value = raw.get(key)
        if isinstance(value, str) and value in allowed:
            result[key] = value
    for key, (low, high) in NUMBERS.items():
        value = raw.get(key)
        if type(value) is int and low <= value <= high:
            result[key] = value
    for key in ("source_cancel_confirmed", "files_removed", "file_closed"):
        if type(raw.get(key)) is bool:
            result[key] = raw[key]
    if "card_version" in raw:
        result["card_version"] = version(raw["card_version"])
    media = raw.get("media")
    if isinstance(media, dict):
        result["media"] = {
            key: media[key]
            for key, values in {
                "source": {"h264", "hevc"},
                "output": {"h264", "hevc"},
                "processing": {"remux", "software", "nvidia"},
            }.items()
            if isinstance(media.get(key), str) and media[key] in values
        }
        if type(media.get("fallback")) is bool:
            result["media"]["fallback"] = media["fallback"]
    if isinstance(raw.get("limits"), dict):
        result["limits"] = {
            key: raw["limits"][key]
            for key in (
                "operation_ms",
                "output_bytes",
                "conversion_ms",
                "hardware_progress_ms",
                "cleanup_ms",
                "storage_bytes",
                "files",
                "playback_seconds",
            )
            if type(raw["limits"].get(key)) is int
            and 0 <= raw["limits"][key] <= 2**31 - 1
        }
    progress = raw.get("progress")
    if isinstance(progress, dict):
        result["progress"] = {
            key: progress[key]
            for key in ("output_bytes", "encoded_frames")
            if type(progress.get(key)) is int and 0 <= progress[key] <= 2**31 - 1
        }
        if type(progress.get("process_closed")) is bool:
            result["progress"]["process_closed"] = progress["process_closed"]
    if isinstance(raw.get("events"), list):
        events = result["events"] = []
        for row in raw["events"][:16]:
            if (
                not isinstance(row, dict)
                or not isinstance(row.get("event"), str)
                or row["event"] not in EVENTS
            ):
                continue
            elapsed = row.get("elapsed_ms")
            if type(elapsed) is not int or not 0 <= elapsed <= RETENTION_MS:
                continue
            event: dict[str, Any] = {"event": row["event"], "elapsed_ms": elapsed}
            for field in ("failure", "progress"):
                source = row.get(field)
                if not isinstance(source, dict):
                    continue
                safe: dict[str, Any] = {}
                for key in ("output_bytes", "encoded_frames", "timeout_ms"):
                    value = source.get(key)
                    if type(value) is int and 0 <= value <= 2**31 - 1:
                        safe[key] = value
                for key, allowed in (
                    ("reason", FAILURES),
                    ("timeout_scope", {"conversion", "hardware_progress"}),
                ):
                    value = source.get(key)
                    if isinstance(value, str) and value in allowed:
                        safe[key] = value
                if type(source.get("process_closed")) is bool:
                    safe["process_closed"] = source["process_closed"]
                if isinstance(source.get("ffmpeg"), list):
                    safe["ffmpeg"] = [
                        v
                        for v in source["ffmpeg"][:11]
                        if isinstance(v, str) and v in CATEGORIES
                    ]
                event[field] = safe
            events.append(event)
    return result


def recording_report(raw: Any) -> dict[str, Any]:
    """Old bridges and expired evidence remain distinguishable."""
    if (
        not isinstance(raw, dict)
        or type(raw.get("schema")) is not int
        or raw["schema"] != 1
    ):
        return {"status": "unavailable"}
    if not isinstance(raw.get("attempts"), list):
        return {"status": "invalid_report"}
    projected = [project_attempt(row) for row in raw["attempts"][-8:]]
    attempts = [
        row
        for row in projected
        if "attempt" in row and "age_ms" in row and row["age_ms"] < RETENTION_MS
    ]
    return {
        "schema": 1,
        "retention_ms": RETENTION_MS,
        "attempts": attempts,
        "expired": min(2**31 - 1, raw["expired"])
        if type(raw.get("expired")) is int and raw["expired"] >= 0
        else 0,
        "omitted": len(projected) - len(attempts),
    }


class PlaybackObservation:
    """Contains no reference to the recording file, camera, user or signed URL."""

    def __init__(
        self, output_format: str, card_version: Any, now: Callable[[], float]
    ) -> None:
        self.now = now
        self.started = now()
        self.data: dict[str, Any] = {
            "attempt": secrets.randbelow(2**48 - 1) + 1,
            "format": output_format,
            "card_version": version(card_version),
            "stage": "preparing",
            "outcome": "active",
            "events": [],
        }
        self.mark("preparing")

    def mark(self, event: str) -> None:
        """Store the first observation of each stage without extending ownership."""
        rows = self.data["events"]
        if (
            event in EVENTS
            and len(rows) < 16
            and not any(row["event"] == event for row in rows)
        ):
            rows.append(
                {
                    "event": event,
                    "elapsed_ms": min(
                        RETENTION_MS, max(0, round((self.now() - self.started) * 1000))
                    ),
                }
            )

    def received(self, value: str | None) -> None:
        """Keep correlation on both success and structured failure responses."""
        if attempt := attempt_header(value):
            self.data["bridge_attempt"] = attempt

    def snapshot(self) -> dict[str, Any]:
        """Return an independently projected export."""
        return project_attempt(
            {**self.data, "age_ms": max(0, round((self.now() - self.started) * 1000))}
        )


class PlaybackDiagnostics:
    """Eight attempts, expiring fifteen minutes after preparation started."""

    def __init__(self, now: Callable[[], float] = monotonic) -> None:
        self.now = now
        self.rows: list[PlaybackObservation] = []
        self.expired = 0

    def prune(self) -> None:
        """Discard stale scalar observations without affecting live playback."""
        rows = [r for r in self.rows if (self.now() - r.started) * 1000 < RETENTION_MS]
        self.expired = min(2**31 - 1, self.expired + len(self.rows) - len(rows))
        self.rows = rows

    def begin(
        self, output_format: str, card_version: Any = None
    ) -> PlaybackObservation:
        """Observe a caller-authorized preparation."""
        self.prune()
        row = PlaybackObservation(output_format, card_version, self.now)
        self.rows.append(row)
        del self.rows[:-8]
        return row

    def report(self) -> dict[str, Any]:
        """Collection never starts a media or device request."""
        self.prune()
        return {
            "schema": 1,
            "retention_ms": RETENTION_MS,
            "expired": self.expired,
            "attempts": [row.snapshot() for row in self.rows],
        }
