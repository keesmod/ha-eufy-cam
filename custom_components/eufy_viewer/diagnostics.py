"""Bounded support download with explicit field and value allowlists."""

import asyncio
import re
from typing import Any

from homeassistant.const import __version__ as HA_VERSION
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.loader import async_get_integration

from .api import BridgeClient, BridgeError
from .const import CONF_TOKEN, CONF_URL, DOMAIN
from .coordinator import EufyConfigEntry
from .live_diagnostics import browser_report

_CODE_FIELDS = {"outcome", "code", "reason", "relationship_reason"}
_ENUMS = {
    "event": set(
        "summary device issue end cloud connection station_connection fault".split()
    ),
    "diagnostic": {"discovery"},
    "kind": {"camera", "station", "unavailable"},
    "availability": {"online", "offline", "disabled"},
    "relationship": {"station", "standalone", "unsupported", "unavailable"},
    "parent_status": set(
        "none self present missing ambiguous invalid unavailable".split()
    ),
    "station_status": set(
        "not_checked connected disconnected error not_applicable".split()
    ),
    "owner_status": set(
        "not_checked connected disconnected error not_applicable".split()
    ),
    "status": set(
        (
            "not_checked connected disconnected error not_applicable "
            "experimental unsupported unavailable"
        ).split()
    ),
    "phase": set("authentication events connect refresh_state observation".split()),
    "operation": set("inventory login region key_exchange verification".split()),
    "scope": {"public_discovery_result"},
    "baseline": {"present", "absent", "unavailable"},
    "platform": {"linux", "darwin", "win32", "other"},
    "arch": {"x64", "arm64", "arm", "other"},
}
_NUMBERS = {
    **dict.fromkeys("ref owner_ref device_ref".split(), (1, 99)),
    "inventory_row": (0, 98),
    "schema": (2, 2),
    "report": (0, 2**53 - 1),
    "device_type": (0, 65535),
    "http_status": (100, 599),
    "result_code": (-999999, 999999),
    "elapsed_ms": (0, 120000),
    "rows": (0, 198),
    **dict.fromkeys(
        (
            "cameras stations issues expected_cameras expected_stations "
            "missing_expected_cameras missing_expected_stations"
        ).split(),
        (0, 100),
    ),
}
_BOOLEANS = set(
    (
        "station_connected owner_connected push_connected available "
        "inventory_available truncated unchanged"
    ).split()
)
_VERSIONS = set("firmware hardware parent_firmware bridge library node".split())
_MODELS = {"model", "parent_model"}


def _version(value: Any) -> str:
    return (
        value
        if isinstance(value, str)
        and len(value) <= 19
        and re.fullmatch(r"[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}", value)
        else "unavailable"
    )


def _timestamp(value: Any) -> str | None:
    return (
        value
        if isinstance(value, str)
        and re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z", value
        )
        else None
    )


def _fields(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    result: dict[str, Any] = {}
    for key in (
        _ENUMS.keys()
        | _CODE_FIELDS
        | _NUMBERS.keys()
        | _BOOLEANS
        | _VERSIONS
        | _MODELS
        | {"timestamp"}
    ):
        if key not in raw:
            continue
        value = raw[key]
        if key in _CODE_FIELDS:
            result[key] = (
                value
                if isinstance(value, str)
                and len(value) <= 64
                and re.fullmatch(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)*", value)
                else None
            )
        elif key in _ENUMS:
            result[key] = (
                value if isinstance(value, str) and value in _ENUMS[key] else None
            )
        elif key in _NUMBERS:
            low, high = _NUMBERS[key]
            result[key] = value if type(value) is int and low <= value <= high else None
        elif key in _BOOLEANS:
            result[key] = value if type(value) is bool else None
        elif key in _VERSIONS:
            result[key] = _version(value)
        elif key in _MODELS:
            result[key] = (
                value
                if isinstance(value, str) and re.fullmatch(r"T[A-Z0-9]{4}", value)
                else "unavailable"
            )
        else:
            result[key] = _timestamp(value)
    if isinstance(raw.get("software"), dict):
        result["software"] = {
            key: value
            for key, value in _fields(
                {
                    key: raw["software"].get(key)
                    for key in ("bridge", "library", "node", "platform", "arch")
                }
            ).items()
        }
    if isinstance(raw.get("media"), dict):
        result["media"] = {
            feature: _fields(
                {
                    key: raw["media"][feature].get(key)
                    for key in ("available", "status", "reason")
                }
            )
            if isinstance(raw["media"].get(feature), dict)
            else None
            for feature in ("snapshot", "live", "recordings")
        }
    return result


_AUDIO_CODECS = {"aac", "aac-lc", "aac-eld", "none", "unknown", "unavailable"}


_AUDIO_PIPELINE_EVENTS = set(
    "media_active_nvidia media_active_software media_hardware_failed "
    "media_hardware_timeout media_hardware_buffer_limit media_software_fallback "
    "fallback_startup_timeout fallback_playback_timeout fallback_connection_failed "
    "fallback_signaling_error fallback_playback_error start video_input audio_input "
    "jpeg_frame media_output media_reader frame_ack viewer_timeout camera_timeout "
    "session_end stream_failure no_viewers h264 hevc audio_supported audio_absent "
    "audio_late "
    "jpeg_encoder_exit media_encoder_exit jpeg_encoder_error media_encoder_error "
    "jpeg_invalid_data media_invalid_data jpeg_decode_error media_decode_error "
    "jpeg_encoder_stderr media_encoder_stderr "
    "media_audio_error audio_transport_error".split()
)


def audio_format_report(raw: Any) -> dict[str, Any]:
    """Project structural fields without retaining any source bytes."""
    if not isinstance(raw, dict):
        return {}
    result: dict[str, Any] = {}
    bounds = {
        "inspected_bytes": 262144,
        "adts_frames": 128,
        "adts_header_changes": 128,
        "adts_multiblock_frames": 128,
        "skipped_bytes": 262144,
        "pending_frame_bytes": 8191,
        "trailing_header_bytes": 6,
        "adts_min_frame_bytes": 8191,
        "adts_max_frame_bytes": 8191,
    }
    for key, high in bounds.items():
        value = raw.get(key)
        if type(value) is int and 0 <= value <= high:
            result[key] = value
    if type(raw.get("inspection_limited")) is bool:
        result["inspection_limited"] = raw["inspection_limited"]
    hint = raw.get("format_hint")
    if isinstance(hint, str) and hint in {
        "adts",
        "loas",
        "adif",
        "ogg",
        "riff",
        "unknown",
    }:
        result["format_hint"] = hint
    for field in ("adts", "first_adts"):
        header = raw.get(field)
        if not isinstance(header, dict):
            continue
        safe: dict[str, Any] = {}
        for key, low, high in (
            ("object_type", 1, 4),
            ("channel_config", 0, 7),
            ("frame_bytes", 7, 8191),
            ("raw_data_blocks", 1, 4),
        ):
            value = header.get(key)
            if type(value) is int and low <= value <= high:
                safe[key] = value
        for key, allowed in (
            ("mpeg_version", {2, 4}),
            (
                "sample_rate_hz",
                {
                    96000,
                    88200,
                    64000,
                    48000,
                    44100,
                    32000,
                    24000,
                    22050,
                    16000,
                    12000,
                    11025,
                    8000,
                    7350,
                },
            ),
        ):
            value = header.get(key)
            if type(value) is int and value in allowed:
                safe[key] = value
        if type(header.get("crc_present")) is bool:
            safe["crc_present"] = header["crc_present"]
        result[field] = safe
    return result


def audio_report(raw: Any) -> dict[str, Any]:
    """Preserve bounded audio observations, never codec text or payloads."""
    if not isinstance(raw, dict):
        return {}
    result: dict[str, Any] = {}
    enums = {
        "state": {"starting", "streaming", "ended", "failed", "closed"},
        "initial_codec": _AUDIO_CODECS,
        "first_data_codec": _AUDIO_CODECS,
        "latest_codec": _AUDIO_CODECS,
        "admission": {"forwarded", "excluded"},
        "header": {"adts", "other", "incomplete"},
    }
    numbers = {
        "attempt": (1, 2**48 - 1),
        **dict.fromkeys(
            (
                "metadata_ms",
                "first_data_ms",
                "first_data_after_metadata_ms",
                "duration_ms",
                "last_data_ms",
                "last_data_age_ms",
                "max_gap_ms",
            ),
            (0, 120000),
        ),
        "chunks": (0, 2147483647),
        "initial_buffered_bytes": (0, 2147483647),
        "buffered_bytes": (0, 2147483647),
        "min_chunk_bytes": (0, 2147483647),
        "max_chunk_bytes": (0, 2147483647),
        "bytes": (0, 2147483647),
    }
    for key in ("stream_ended", "stream_destroyed", "stop_confirmed"):
        if type(raw.get(key)) is bool:
            result[key] = raw[key]
    for key, allowed in enums.items():
        value = raw.get(key)
        if isinstance(value, str) and value in allowed:
            result[key] = value
    for key, (low, high) in numbers.items():
        value = raw.get(key)
        if type(value) is int and low <= value <= high:
            result[key] = value
    if "model" in raw:
        result["model"] = _fields({"model": raw["model"]})["model"]
    if "owner_model" in raw:
        result["owner_model"] = _fields({"model": raw["owner_model"]})["model"]
    for key in ("firmware", "owner_firmware"):
        if key in raw:
            result[key] = _version(raw[key])
    if isinstance(raw.get("format"), dict):
        result["format"] = audio_format_report(raw["format"])
    if isinstance(raw.get("pipeline"), list):
        result["pipeline"] = [
            {"event": row["event"], "elapsed_ms": row["elapsed_ms"]}
            for row in raw["pipeline"][:48]
            if isinstance(row, dict)
            and isinstance(row.get("event"), str)
            and row["event"] in _AUDIO_PIPELINE_EVENTS
            and type(row.get("elapsed_ms")) is int
            and 0 <= row["elapsed_ms"] <= 120000
        ]
    return result


def support_report(raw: Any) -> dict[str, Any]:
    """Project known schema fields even if a bridge returns arbitrary input."""
    if (
        not isinstance(raw, dict)
        or type(raw.get("schema")) is not int
        or raw["schema"] != 2
    ):
        return {"status": "unsupported_schema"}
    result: dict[str, Any] = {
        "schema": 2,
        "generated_at": _timestamp(raw.get("generated_at")),
    }
    for key, limit in (("last_discovery", 200), ("recent_events", 100)):
        rows = raw.get(key)
        if not isinstance(rows, list):
            return {"status": "invalid_report"}
        result[key] = [
            _fields(row)
            for row in rows[:limit]
            if isinstance(row, dict)
            and isinstance(row.get("event"), str)
            and row["event"] in _ENUMS["event"]
        ]
    if isinstance(raw.get("live_audio"), list):
        result["live_audio"] = [audio_report(row) for row in raw["live_audio"][-8:]]
    return result


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: EufyConfigEntry
) -> dict[str, Any]:
    """Download cached discovery and recent failures, including failed setups."""
    coordinator = getattr(entry, "runtime_data", None)
    api = (
        coordinator.api
        if coordinator
        else BridgeClient(
            async_get_clientsession(hass), entry.data[CONF_URL], entry.data[CONF_TOKEN]
        )
    )
    integration = await async_get_integration(hass, DOMAIN)
    result: dict[str, Any] = {
        "protocol": 1,
        "home_assistant": _version(HA_VERSION),
        "integration": _version(integration.version),
        "entry_state": entry.state.value,
        "bridge_available": coordinator.last_update_success if coordinator else None,
        "account_connected": coordinator.data.auth == "connected"
        if coordinator
        else None,
        "live_playback": [
            {
                "schema": 1,
                **(
                    {"audio_expected": report["audio_expected"]}
                    if type(report.get("audio_expected")) is bool
                    else {}
                ),
                **(
                    {"audio_attempt": report["audio_attempt"]}
                    if type(report.get("audio_attempt")) is int
                    and 1 <= report["audio_attempt"] < 2**48
                    else {}
                ),
                "offered": report.get("offered") is True,
                "answered": report.get("answered") is True,
                "ticks": report.get("ticks", 0),
                "acks": report.get("acks", 0),
                "fallback": report.get("fallback"),
                "relay": report.get("relay", [])[:5],
                "browser": [
                    browser_report(row) for row in report.get("browser", [])[:5]
                ],
            }
            for report in getattr(coordinator, "live_diagnostics", [])[-8:]
        ],
        "active_viewers": len(coordinator.viewers) if coordinator else 0,
        "cameras": [
            {
                "model": _fields({"model": info.model})["model"],
                "software": _version(info.software),
                "has_battery": info.battery is not None,
                "has_snapshot": info.snapshot_received_at is not None,
            }
            for info in list(coordinator.data.cameras.values())[:99]
        ]
        if coordinator
        else [],
    }
    try:
        async with asyncio.timeout(10):
            raw = await api.request("GET", "/v1/diagnostics")
        result["support"] = support_report(raw)
    except BridgeError, TimeoutError:
        result["support"] = {"status": "unavailable"}
    return result
