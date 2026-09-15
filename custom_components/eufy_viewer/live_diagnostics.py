"""Bounded playback evidence. Never retain SDP, URLs, addresses or track IDs."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN

ENUMS = {
    "trigger": {"startup", "playing", "unmuted", "fallback", "audio_check"},
    "audio_codec": {
        "audio/opus",
        "audio/pcma",
        "audio/pcmu",
        "audio/g722",
        "audio/mp4a-latm",
    },
    "connection": {
        "new",
        "connecting",
        "connected",
        "disconnected",
        "failed",
        "closed",
    },
    "ice": {
        "new",
        "checking",
        "connected",
        "completed",
        "disconnected",
        "failed",
        "closed",
    },
    "local_candidate": {"host", "srflx", "prflx", "relay"},
    "remote_candidate": {"host", "srflx", "prflx", "relay"},
    "protocol": {"udp", "tcp"},
}
NUMBERS = {
    **dict.fromkeys(
        "elapsed_ms last_frame_ms ticks acks_sent acks_accepted painted "
        "video_packets video_bytes video_decoded video_dropped audio_packets "
        "audio_bytes audio_samples concealed_samples video_received video_keyframes "
        "video_nack video_pli video_fir video_jitter_ms audio_jitter_ms "
        "video_buffer_delay_ms audio_buffer_delay_ms "
        "video_buffer_target_delay_ms audio_buffer_target_delay_ms "
        "video_buffer_min_delay_ms audio_buffer_min_delay_ms "
        "video_buffer_emitted audio_buffer_emitted".split(),
        (0, 2**53 - 1),
    ),
    "audio_volume_percent": (0, 100),
    "audio_clock_rate": (1, 192000),
    "audio_channels": (1, 8),
    **dict.fromkeys(
        "audio_tracks audio_tracks_muted "
        "audio_tracks_enabled audio_tracks_ended".split(),
        (0, 8),
    ),
    "ready_state": (0, 4),
    "video_lost": (-(2**53 - 1), 2**53 - 1),
    "audio_lost": (-(2**53 - 1), 2**53 - 1),
}
BOOLEANS = set(
    "offer answer muted paused audio_energy stats_available audio_negotiated".split()
)


# Counts and fixed categories remain useful when ICE has no selected pair.
for prefix in ("", "audio_"):
    ENUMS[prefix + "ice_configuration"] = {"home_assistant", "unavailable", "legacy"}
    ENUMS[prefix + "ice_gathering"] = {"new", "gathering", "complete"}
    ENUMS[prefix + "ice"] = ENUMS["ice"]
    BOOLEANS.add(prefix + "relay_configured")
    for key in (
        [
            f"{side}_{kind}"
            for side in ("local", "remote")
            for kind in ("host", "srflx", "prflx", "relay")
        ]
        + [
            f"pairs_{state}"
            for state in ("frozen", "waiting", "in_progress", "failed", "succeeded")
        ]
        + [f"ice_errors_{kind}" for kind in ("unreachable", "auth", "other")]
    ):
        NUMBERS[prefix + key] = (0, 4096)


def browser_report(raw: Any) -> dict[str, Any]:
    """Project only recognized scalar values, including for downloaded evidence."""
    if not isinstance(raw, dict):
        return {}
    result: dict[str, Any] = {}
    for key, values in ENUMS.items():
        value = raw.get(key)
        if isinstance(value, str) and value in values:
            result[key] = value
    for key, (low, high) in NUMBERS.items():
        value = raw.get(key)
        if type(value) is int and low <= value <= high:
            result[key] = value
    for key in BOOLEANS:
        if type(raw.get(key)) is bool:
            result[key] = raw[key]
    return result


@websocket_api.websocket_command(
    {
        vol.Required("type"): "eufy_viewer/live_diagnostics",
        vol.Required("subscription"): vol.All(int, vol.Range(min=1)),
        vol.Required("report"): {
            **{vol.Optional(key): vol.In(values) for key, values in ENUMS.items()},
            **{
                vol.Optional(key): vol.All(int, vol.Range(min=low, max=high))
                for key, (low, high) in NUMBERS.items()
            },
            **{vol.Optional(key): bool for key in BOOLEANS},
        },
    }
)
@websocket_api.async_response
async def websocket_live_diagnostics(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Only the existing viewer owner can submit evidence. This never renews it."""
    from .webrtc import WebRTCViewer

    viewer = hass.data[DOMAIN]["viewers"].get((connection, msg["subscription"]))
    accepted = bool(
        isinstance(viewer, WebRTCViewer)
        and not viewer.closed
        and connection.user.permissions.check_entity(viewer.entity_id, POLICY_READ)
        and await viewer.record_browser_report(browser_report(msg["report"]))
    )
    connection.send_result(msg["id"], {"accepted": accepted})


def relay_report(raw: Any) -> dict[str, int]:
    """Only codec packet totals from this viewer's go2rtc stream are retained."""
    result: dict[str, int] = {}
    if not isinstance(raw, dict):
        return result
    for group, tracks, prefix in (
        ("producers", "receivers", "source"),
        ("consumers", "senders", "output"),
    ):
        peers = raw.get(group)
        if not isinstance(peers, list):
            continue
        for peer in peers[:16]:
            rows = peer.get(tracks) if isinstance(peer, dict) else None
            if not isinstance(rows, list):
                continue
            for track in rows[:16]:
                if not isinstance(track, dict) or not isinstance(
                    track.get("codec"), dict
                ):
                    continue
                codec = track["codec"].get("codec_name")
                if not isinstance(codec, str):
                    continue
                name = codec.upper()
                if name not in {"H264", "H265", "AAC", "OPUS", "PCMA", "PCMU"}:
                    continue
                for metric in ("packets", "bytes"):
                    value = track.get(metric)
                    if type(value) is int and 0 <= value <= 2**48:
                        key = f"{prefix}_{name.lower()}_{metric}"
                        result[key] = result.get(key, 0) + value
    return result
