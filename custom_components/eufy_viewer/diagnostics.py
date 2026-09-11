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

_CODES = set(
    """
invalid_device_identity invalid_device_relationship unsupported_device
unsupported_station standalone_transport_unverified camera_inventory_empty
expected_devices_missing inventory_required inventory_invalid bridge_identity_mismatch
invalid_inventory inventory_completeness_unconfirmed authentication_rejected
authentication_required invalid_authentication domain_discovery_failed domain_unresolved
request_failed request_rejected http_error invalid_response response_decryption_failed
response_too_large key_exchange_failed invalid_key_exchange client_closed
camera_media_unverified device_initialization_failed device_connection_failed
unknown_device unknown_camera unknown_station invalid_connection_credentials
station_busy connection_failed unclassified_error
""".split()
)
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
    "outcome": _CODES
    | set("accepted connected disconnected connecting captcha verify error".split()),
    "code": _CODES,
    "reason": _CODES,
    "relationship_reason": _CODES,
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
        | _NUMBERS.keys()
        | _BOOLEANS
        | _VERSIONS
        | _MODELS
        | {"timestamp"}
    ):
        if key not in raw:
            continue
        value = raw[key]
        if key in _ENUMS:
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
