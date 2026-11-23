"""Bounded support download with explicit field and value allowlists."""

import asyncio
import math
import re
from time import monotonic
from typing import Any

from homeassistant.const import __version__ as HA_VERSION
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.loader import async_get_integration

from .api import BridgeClient, BridgeError
from .const import CONF_TOKEN, CONF_URL, DOMAIN, LIVE_BOUND_DEFAULT_SECONDS
from .coordinator import EufyConfigEntry
from .diagnostic_assessment import assess
from .live_diagnostics import LATE_AUDIO_END_REASONS, LATE_AUDIO_STAGES, browser_report
from .recording_diagnostics import diagnostic_code, recording_report, release_version

_CODE_FIELDS = {"outcome", "code", "reason", "relationship_reason"}
# Live evidence stays downloadable for the bridge's session cap plus this grace,
# so an attempt that ran to the cap is still in a download taken after its end.
EVIDENCE_GRACE_SECONDS = 900
_ENUMS = {
    "event": set(
        (
            "summary device issue end cloud connection station_connection fault "
            "recording_query accessory"
        ).split()
    ),
    # A HomeBase accessory or a recognized chime, bridge 0.8.44 (#275).
    "category": {"entry_sensor", "keypad", "chime"},
    "diagnostic": {"discovery"},
    "kind": {"camera", "station", "unavailable"},
    "availability": {"online", "offline", "disabled"},
    "relationship": {"station", "standalone", "unsupported", "unavailable"},
    "relationship_transport": {"experimental"},
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
            "experimental unsupported unavailable completed"
        ).split()
    ),
    "phase": set("authentication events connect refresh_state observation".split()),
    "stage": set("none lookup station_found session_open encryption_ready".split()),
    # The class of the first reply from the inventory address, bridge 0.8.38.
    "lookup_inventory_reply": set("none own account foreign near".split()),
    "operation": set("inventory login region key_exchange verification".split()),
    "scope": {"public_discovery_result"},
    "baseline": {"present", "absent", "unavailable"},
    "platform": {"linux", "darwin", "win32", "other"},
    "arch": {"x64", "arm64", "arm", "other"},
    # A recording query of the bridge, its owner and how far it got, bridge 0.8.39.
    # A probe is the opt-in standalone recording probe at login, issue #178.
    "query": {"list", "calendar", "thumbnail", "download", "probe"},
    "owner": {"standalone", "station"},
    "query_stage": set("admission connect query validate transfer".split()),
    "unhandled_reason": {"unknown_cmd", "parse_error"},
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
    # Device, issue and accessory rows plus rejections, bridge 0.8.44 (#275).
    "rows": (0, 297),
    **dict.fromkeys(
        (
            "cameras stations issues expected_cameras expected_stations "
            "missing_expected_cameras missing_expected_stations accessories"
        ).split(),
        (0, 100),
    ),
    # What the local lookup of a station connection attempt saw, bridge 0.8.38.
    "lookup_rounds": (0, 99),
    "lookup_broadcast_targets": (0, 16),
    "lookup_own_round": (0, 99),
    **dict.fromkeys(
        (
            "lookup_send_errors lookup_datagrams lookup_other_headers "
            "lookup_own_replies lookup_account_replies lookup_foreign_replies "
            "lookup_near_replies"
        ).split(),
        (0, 999),
    ),
    # The command key setup of a station connection attempt and the time its
    # session opened, bridge 0.8.40 (client #142).
    "session_open_ms": (0, 120000),
    **dict.fromkeys(
        (
            "key_request_sends key_answers key_data_datagrams key_other_messages "
            "key_heartbeats key_results key_control_messages key_media_datagrams "
            "key_repeated_datagrams key_signed_messages"
        ).split(),
        (0, 999),
    ),
    # The result to the key request and the commands of the other messages,
    # bridge 0.8.40 (client #142). Protocol numbers, not identifiers.
    "key_result_code": (-999999, 999999),
    **dict.fromkeys(
        "key_other_command_1 key_other_command_2 key_other_command_3".split(),
        (0, 65535),
    ),
    # What the device answered to a recording query, bridge 0.8.39. The row
    # counts are of a query page, not the discovery rows counted in rows.
    "pages": (0, 4),
    "query_limit": (0, 10000),
    "unhandled_replies": (0, 99),
    "returned": (100, 599),
    **dict.fromkeys(
        "ack_code query_result_code unhandled_result_code".split(), (-999999, 999999)
    ),
    **dict.fromkeys(
        (
            "query_rows rows_own rows_other_device rows_station_mismatch "
            "rows_invalid_time rows_other_day rows_cipher_id"
        ).split(),
        (0, 10000),
    ),
}
# The elapsed time of a recording query may include a download. Other rows keep
# the two-minute bound of a cloud request.
_EVENT_NUMBERS = {
    "recording_query": {"elapsed_ms": (0, 3600000)},
    # Accessory refs follow up to 99 device refs, bridge 0.8.44 (#275).
    "accessory": {"ref": (1, 198)},
}
_BOOLEANS = set(
    (
        "station_connected owner_connected push_connected available "
        "inventory_available truncated unchanged inventory_address "
        "experimental_standalone lookup_broadcast_enabled "
        "inventory_address_on_subnet inventory_address_shared "
        "session_open query_answered standalone_recording_probe "
        "key_request_acknowledged key_result_wait_expired key_ended "
        "key_result_encrypted key_without_answer has_station"
    ).split()
)
_VERSIONS = set("firmware hardware parent_firmware node".split())
# Bridge and client library releases may carry a -beta.N suffix. Device and Node
# versions stay numeric.
_RELEASE_VERSIONS = {"bridge", "library"}
_MODELS = {"model", "parent_model"}


def _version(value: Any) -> str:
    return (
        str(value)
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
    event = raw.get("event")
    bounds = _EVENT_NUMBERS.get(event, {}) if isinstance(event, str) else {}
    for key in (
        _ENUMS.keys()
        | _CODE_FIELDS
        | _NUMBERS.keys()
        | _BOOLEANS
        | _VERSIONS
        | _RELEASE_VERSIONS
        | _MODELS
        | {"timestamp"}
    ):
        if key not in raw:
            continue
        value = raw[key]
        if key in _CODE_FIELDS:
            result[key] = diagnostic_code(value)
        elif key in _ENUMS:
            result[key] = (
                value if isinstance(value, str) and value in _ENUMS[key] else None
            )
        elif key in _NUMBERS:
            low, high = bounds.get(key, _NUMBERS[key])
            result[key] = value if type(value) is int and low <= value <= high else None
        elif key in _BOOLEANS:
            result[key] = value if type(value) is bool else None
        elif key in _VERSIONS:
            result[key] = _version(value)
        elif key in _RELEASE_VERSIONS:
            result[key] = release_version(value)
        elif key in _MODELS:
            # A received model code such as T8113-Z or T8410C, the same bound as
            # the bridge. Serials and free text never match, and the value is
            # kept as received or replaced, never trimmed or truncated.
            result[key] = (
                value
                if isinstance(value, str)
                and len(value) <= 8
                and re.fullmatch(
                    r"T[A-Z0-9]{4}(?:[A-Z0-9]{1,3}|-[A-Z0-9]{1,2})?", value
                )
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
    if isinstance(raw.get("descriptor"), dict):
        # Presence of a standalone row's connection fields, never their values.
        descriptor = raw["descriptor"]
        result["descriptor"] = {
            key: descriptor.get(key) if type(descriptor.get(key)) is bool else None
            for key in ("did", "license", "admin_user", "lan_address")
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
    "media_audio_error audio_transport_error "
    # A snapshot refresh attached to this live session, bridge 0.8.39.
    "snapshot_refresh".split()
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
        "age_ms": (0, 2**31 - 1),
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
            (0, 3600000),
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
        result["pipeline"] = _pipeline(raw["pipeline"])
    return result


def _pipeline(rows: list[Any]) -> list[dict[str, Any]]:
    return [
        {"event": row["event"], "elapsed_ms": row["elapsed_ms"]}
        for row in rows[:48]
        if isinstance(row, dict)
        and isinstance(row.get("event"), str)
        and row["event"] in _AUDIO_PIPELINE_EVENTS
        and type(row.get("elapsed_ms")) is int
        and 0 <= row["elapsed_ms"] <= 3600000
    ]


def _bounded(raw: Any, bounds: dict[str, tuple[int, int]]) -> dict[str, int]:
    if not isinstance(raw, dict):
        return {}
    return {
        key: value
        for key, (low, high) in bounds.items()
        if type(value := raw.get(key)) is int and low <= value <= high
    }


_VIDEO_STAGE_BOUNDS = {
    "chunks": (0, 2**31 - 1),
    "bytes": (0, 2**31 - 1),
    **dict.fromkeys(
        ("first_data_ms", "last_data_ms", "last_data_age_ms", "max_gap_ms"),
        (0, 3600000),
    ),
}
_VIDEO_READER_BOUNDS = {
    **dict.fromkeys(("attached", "backpressure", "closed", "revoked"), (0, 2**31 - 1)),
    "last_destroy_ms": (0, 3600000),
}
# The encoder process and FFmpeg's progress counters from its latest block.
_VIDEO_ENCODER_BOUNDS = {
    **dict.fromkeys(
        "exits stderr_chunks frames dropped duplicated out_time_ms bytes".split(),
        (0, 2**31 - 1),
    ),
    **dict.fromkeys(
        (
            "software_fallback_ms last_progress_ms last_progress_age_ms "
            "last_frame_ms last_drop_ms"
        ).split(),
        (0, 3600000),
    ),
}


# How far the library's live start got, on the bridge's clock, and the
# station's numeric answer to START. Bridge 0.8.28 sends it for every row.
_VIDEO_START_BOUNDS = {
    **dict.fromkeys(
        "session_ready_ms issued_ms result_ms no_data_end_ms metadata_ms".split(),
        (0, 3600000),
    ),
    "return_code": (-(2**31), 2**31 - 1),
}


def video_report(raw: Any) -> dict[str, Any]:
    """Preserve the bridge's video path counters, never encoder text or payloads."""
    if not isinstance(raw, dict):
        return {}
    result: dict[str, Any] = {}
    enums = {
        "state": {"starting", "streaming", "ended", "failed", "closed"},
        "codec": {"h264", "hevc"},
    }
    numbers = {
        "attempt": (1, 2**48 - 1),
        "audio_attempt": (1, 2**48 - 1),
        "age_ms": (0, 2**31 - 1),
        "duration_ms": (0, 3600000),
    }
    for key, allowed in enums.items():
        value = raw.get(key)
        if isinstance(value, str) and value in allowed:
            result[key] = value
    result.update(_bounded(raw, numbers))
    if "model" in raw:
        result["model"] = _fields({"model": raw["model"]})["model"]
    encoder = raw.get("encoder")
    if isinstance(encoder, dict):
        safe: dict[str, Any] = _bounded(encoder, _VIDEO_ENCODER_BOUNDS)
        mode = encoder.get("mode")
        if isinstance(mode, str) and mode in {"software", "nvidia", "unavailable"}:
            safe["mode"] = mode
        result["encoder"] = safe
    for stage in ("input", "output", "jpeg"):
        if isinstance(raw.get(stage), dict):
            result[stage] = _bounded(raw[stage], _VIDEO_STAGE_BOUNDS)
    for readers in ("readers", "audio_readers"):
        if isinstance(raw.get(readers), dict):
            result[readers] = _bounded(raw[readers], _VIDEO_READER_BOUNDS)
    if isinstance(raw.get("start"), dict):
        result["start"] = _bounded(raw["start"], _VIDEO_START_BOUNDS)
    if isinstance(raw.get("pipeline"), list):
        result["pipeline"] = _pipeline(raw["pipeline"])
    return result


# Standalone push counts of the bridge's client, bridge 0.8.39 with client
# 0.30.1, issue #185. Numbers only, never a serial, address or image.
_PUSH_COUNT = (0, 2**31 - 1)
_PUSH_REFUSALS = (
    "events_not_enabled",
    "owner_unavailable",
    "serial_mismatch",
    "type_mismatch",
    "unsupported_event",
)
# At most 16 numeric event codes or push types, plus none and other.
_PUSH_ROWS = 18


def _push_rows(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    rows: list[dict[str, Any]] = []
    for row in raw[:_PUSH_ROWS]:
        if not isinstance(row, dict):
            continue
        code, count = row.get("code"), row.get("count")
        if not (type(count) is int and _PUSH_COUNT[0] <= count <= _PUSH_COUNT[1]):
            continue
        if (type(code) is int and 0 <= code <= 99999) or (
            isinstance(code, str) and code in {"none", "other"}
        ):
            rows.append({"code": code, "count": count})
    return rows


# What the bridge's client observed for HomeBase accessories, by route, bridge
# 0.8.44 with client 0.31.0 (#275). Counts only, never a serial or a door state.
_ACCESSORY_OBSERVATIONS = (
    "hub_notify",
    "sensor_status",
    "push_door_sensor",
    "camera_info",
    "cloud_seeded",
    "conflicts",
    "unknown_channel",
)


def accessory_observations_report(raw: Any) -> dict[str, int] | None:
    """Keep the accessory observation counts, bounded integers only."""
    if not isinstance(raw, dict):
        return None
    return _bounded(raw, dict.fromkeys(_ACCESSORY_OBSERVATIONS, _PUSH_COUNT))


# Parameters and battery codes of each keypad, bridge 0.8.47 with client 0.31.3
# (#286), and of each entry sensor, bridge 0.8.47-beta.6 with client
# 0.31.3-beta.6 (#306). Parameter types and battery codes only, never another
# value.
_PARAMETER_ROUTES = ("cloud", "camera_info", "hub_notify")
_KEYPAD_CODE_KEYS = ("1101", "1653", "1654", "1655")
_ENTRY_SENSOR_CODE_KEYS = ("1101", "1552")
_PARAMETER_CODE = re.compile(r"-?[0-9]{1,6}")
# The client keeps 64 parameter types per route besides the battery keys.
_PARAMETER_TYPES = 64
_KEYPAD_ROWS = 8
_ENTRY_SENSOR_ROWS = 16


def _parameter_route(raw: Any, code_keys: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {"types": [], "codes": {}}
    types = raw.get("types")
    codes = raw.get("codes")
    return {
        "types": sorted(
            {
                value
                for value in (types[:256] if isinstance(types, list) else [])
                if type(value) is int and 0 <= value <= 65535
            }
        )[: _PARAMETER_TYPES + len(code_keys)],
        "codes": {
            key: codes[key]
            for key in code_keys
            if isinstance(codes, dict)
            and isinstance(codes.get(key), str)
            and (codes[key] == "other" or _PARAMETER_CODE.fullmatch(codes[key]))
        },
    }


def _parameters_report(
    raw: Any, code_keys: tuple[str, ...], limit: int
) -> list[dict[str, Any]] | None:
    """Keep each accessory's parameter types and battery codes, by inventory row."""
    if not isinstance(raw, list):
        return None
    rows = []
    for row in raw[:limit]:
        if not isinstance(row, dict):
            continue
        index = row.get("inventory_row")
        rows.append(
            {
                "inventory_row": index
                if type(index) is int and 0 <= index <= 98
                else None,
                **{
                    route: _parameter_route(row.get(route), code_keys)
                    for route in _PARAMETER_ROUTES
                },
            }
        )
    return rows


def keypad_parameters_report(raw: Any) -> list[dict[str, Any]] | None:
    """Keep each keypad's parameter types and battery codes, by inventory row."""
    return _parameters_report(raw, _KEYPAD_CODE_KEYS, _KEYPAD_ROWS)


def entry_sensor_parameters_report(raw: Any) -> list[dict[str, Any]] | None:
    """Keep each entry sensor's parameter types and battery codes, by inventory row."""
    return _parameters_report(raw, _ENTRY_SENSOR_CODE_KEYS, _ENTRY_SENSOR_ROWS)


# How the client refreshes snapshots from latest event rows, bridge 0.8.47 with
# client 0.31.3 (#293). A model code, enums and counts only.
_SNAPSHOT_TRIGGERS = ("push", "request", "connect")
_SNAPSHOT_ROW_OUTCOMES = (
    "no_row",
    "homebase_path",
    "unchanged_path",
    "cloud_path_only",
    "no_path",
    "path_absent",
    "invalid_path",
)
_SNAPSHOT_CHANGES = ("first", "increased", "unchanged", "decreased", "unavailable")
_SNAPSHOT_DOWNLOADS = ("kept", "not_jpeg", "too_large", "superseded", "no_reply")
_SNAPSHOT_ROWS = 96


def _snapshot_rows(raw: Any, keys: dict[str, tuple[str, ...]]) -> list[dict[str, Any]]:
    """Keep rows of a model, known enum values and a count from 1."""
    if not isinstance(raw, list):
        return []
    rows = []
    for row in raw[:_SNAPSHOT_ROWS]:
        if not isinstance(row, dict):
            continue
        count = row.get("count")
        if type(count) is not int or not 1 <= count <= 2**31 - 1:
            continue
        if any(row.get(key) not in allowed for key, allowed in keys.items()):
            continue
        model = row.get("model")
        rows.append(
            {
                "model": "other"
                if model == "other"
                else _fields({"model": model})["model"],
                **{key: row[key] for key in keys},
                "count": count,
            }
        )
    return rows


def snapshot_refresh_report(raw: Any) -> dict[str, Any] | None:
    """Keep the snapshot refresh counts, by model, enums and counts only."""
    if not isinstance(raw, dict):
        return None
    return {
        "replies": _bounded(
            raw.get("replies"),
            dict.fromkeys((*_SNAPSHOT_TRIGGERS, "failed"), _PUSH_COUNT),
        ),
        "rows": _snapshot_rows(
            raw.get("rows"),
            {"trigger": _SNAPSHOT_TRIGGERS, "outcome": _SNAPSHOT_ROW_OUTCOMES},
        ),
        "event_counts": _snapshot_rows(
            raw.get("event_counts"),
            {"trigger": _SNAPSHOT_TRIGGERS, "change": _SNAPSHOT_CHANGES},
        ),
        "downloads": _snapshot_rows(
            raw.get("downloads"), {"outcome": _SNAPSHOT_DOWNLOADS}
        ),
    }


def standalone_pushes_report(raw: Any) -> dict[str, Any] | None:
    """Keep the bridge's standalone push counts, bounded integers only."""
    if not isinstance(raw, dict):
        return None
    return {
        **_bounded(raw, dict.fromkeys(("arrived", "admitted"), _PUSH_COUNT)),
        "refused": _bounded(
            raw.get("refused"), dict.fromkeys(_PUSH_REFUSALS, _PUSH_COUNT)
        ),
        "sources": _bounded(
            raw.get("sources"), dict.fromkeys(("cloud", "local"), _PUSH_COUNT)
        ),
        "event_codes": _push_rows(raw.get("event_codes")),
        "push_types": _push_rows(raw.get("push_types")),
    }


def support_report(
    raw: Any, window_ms: int = EVIDENCE_GRACE_SECONDS * 1000
) -> dict[str, Any]:
    """Project known schema fields even if a bridge returns arbitrary input.

    Live audio rows older than the window are left out. The default window is
    the fifteen-minute grace alone, the download adds the bridge's live cap.
    """
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
    # A summary, 99 device, 99 issue and 99 accessory rows and an end row (#275).
    for key, limit in (("last_discovery", 299), ("recent_events", 100)):
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
    cache_age = raw.get("cache_age_ms", 0)
    cache_age = (
        cache_age
        if type(cache_age) is int and 0 <= cache_age <= 2**31 - 1
        else 2**31 - 1
    )
    result["cache_age_ms"] = cache_age
    recording = raw.get("recording")
    if isinstance(recording, dict) and isinstance(recording.get("attempts"), list):
        recording = {
            **recording,
            "attempts": [
                {**row, "age_ms": min(2**31 - 1, row["age_ms"] + cache_age)}
                if isinstance(row, dict)
                and type(row.get("age_ms")) is int
                and row["age_ms"] >= 0
                else row
                for row in recording["attempts"][-8:]
            ],
        }
    result["recording"] = recording_report(recording)
    if isinstance(raw.get("software"), dict):
        result["software"] = _fields({"software": raw["software"]})["software"]
    if isinstance(raw.get("live_audio"), list):
        result["live_audio"] = [
            audio_report(row)
            for row in raw["live_audio"][-8:]
            if cache_age < window_ms
            and (
                not isinstance(row, dict)
                or type(row.get("age_ms")) is not int
                or row["age_ms"] + cache_age < window_ms
            )
        ]
    if isinstance(raw.get("live_video"), list):
        # The bridge takes these rows from its own history at download time,
        # so their ages are current even when the rest of the report is cached.
        result["live_video"] = [
            video_report(row)
            for row in raw["live_video"][-8:]
            if not isinstance(row, dict)
            or type(row.get("age_ms")) is not int
            or row["age_ms"] < window_ms
        ]
    # Null for a bridge before 0.8.39-beta.5 or without a client.
    result["standalone_pushes"] = standalone_pushes_report(raw.get("standalone_pushes"))
    # Null for a bridge before 0.8.44 or without a client.
    result["accessory_observations"] = accessory_observations_report(
        raw.get("accessory_observations")
    )
    # Null for a bridge before 0.8.47 or a client before 0.31.3.
    result["keypad_parameters"] = keypad_parameters_report(raw.get("keypad_parameters"))
    # Null for a bridge before 0.8.47-beta.6 or a client before 0.31.3-beta.6.
    result["entry_sensor_parameters"] = entry_sensor_parameters_report(
        raw.get("entry_sensor_parameters")
    )
    # Null for a bridge before 0.8.47-beta.3 or a client before 0.31.3-beta.3.
    result["snapshot_refresh"] = snapshot_refresh_report(raw.get("snapshot_refresh"))
    return result


def playback_report(raw: dict[str, Any]) -> dict[str, Any]:
    """Project stored HA observations again before downloading them."""
    created = raw.get("_created")
    result: dict[str, Any] = {
        "schema": 1,
        "age_ms": max(0, round((monotonic() - created) * 1000))
        if isinstance(created, (int, float))
        and not isinstance(created, bool)
        and math.isfinite(created)
        else None,
    }
    for key in ("audio_expected", "offered", "answered"):
        if type(raw.get(key)) is bool:
            result[key] = raw[key]
    # Late audio is a separate route from the initial A/V classification.
    for key, values in (
        ("audio_late", LATE_AUDIO_STAGES),
        ("audio_late_end", LATE_AUDIO_END_REASONS),
    ):
        value = raw.get(key)
        if isinstance(value, str) and value in values:
            result[key] = value
    for key, low, high in (
        ("audio_attempt", 1, 2**48 - 1),
        ("ticks", 0, 2**53 - 1),
        ("acks", 0, 2**53 - 1),
    ):
        value = raw.get(key)
        if type(value) is int and low <= value <= high:
            result[key] = value
    fallback = raw.get("fallback")
    if isinstance(fallback, str) and fallback in {
        "startup_timeout",
        "playback_timeout",
        "connection_failed",
        "signaling_error",
        "playback_error",
    }:
        result["fallback"] = fallback
    result["browser"] = (
        [browser_report(row) for row in raw["browser"][:5]]
        if isinstance(raw.get("browser"), list)
        else []
    )
    result["relay"] = []
    keys = {
        f"{side}_{codec}_{metric}"
        for side in ("source", "output")
        for codec in ("h264", "h265", "aac", "opus", "pcma", "pcmu")
        for metric in ("packets", "bytes")
    }
    for row in raw["relay"][:5] if isinstance(raw.get("relay"), list) else []:
        if not isinstance(row, dict):
            continue
        safe = {
            key: value
            for key in keys
            if type(value := row.get(key)) is int and 0 <= value <= 2**53 - 1
        }
        if row.get("audio_late") is True:
            safe["audio_late"] = True  # Counters include the late audio stream.
        trigger = browser_report({"trigger": row.get("trigger")})
        result["relay"].append({**safe, **trigger})
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
    # The bridge's configured cap is the longest any camera on it may run.
    window = (
        coordinator.data.live_max_seconds_mains
        if coordinator
        else LIVE_BOUND_DEFAULT_SECONDS
    ) + EVIDENCE_GRACE_SECONDS
    result: dict[str, Any] = {
        "protocol": 1,
        "report_schema": 1,
        "recording_playback": coordinator.recording_diagnostics.report()
        if coordinator
        else {"schema": 1, "attempts": [], "expired": 0},
        "home_assistant": _version(HA_VERSION),
        "integration": release_version(integration.version),
        "entry_state": entry.state.value,
        "bridge_available": coordinator.last_update_success if coordinator else None,
        "account_connected": coordinator.data.auth == "connected"
        if coordinator
        else None,
        "live_playback": [
            playback_report(report)
            for report in getattr(coordinator, "live_diagnostics", [])[-8:]
            if isinstance(report, dict)
            and (
                type(report.get("_created")) not in (int, float)
                or not math.isfinite(report["_created"])
                or monotonic() - report["_created"] < window
            )
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
        # The category, model and value sources only. Never a serial, a name, a
        # door state or an observation time.
        "accessories": [
            {
                "category": info.category,
                "model": _fields({"model": info.model})["model"],
                "software": _version(info.software),
                "has_station": info.station is not None,
                "sources": {
                    key: reading.source for key, reading in info.readings.items()
                },
            }
            for info in list(coordinator.data.accessories.values())[:99]
        ]
        if coordinator
        else [],
        "accessories_dropped": coordinator.data.accessories_dropped
        if coordinator
        else 0,
    }
    try:
        async with asyncio.timeout(10):
            raw = await api.request("GET", "/v1/diagnostics")
        result["support"] = support_report(raw, window * 1000)
    except BridgeError, TimeoutError:
        result["support"] = {"status": "unavailable"}
    result["assessment"] = assess(result)
    return result
