"""Recording downloads explain observed stages without retaining private values."""

import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock, Mock, patch

import pytest
from aiohttp import web

from custom_components.eufy_viewer.api import BridgeClient, BridgeRecordingError
from custom_components.eufy_viewer.diagnostic_assessment import assess
from custom_components.eufy_viewer.diagnostics import (
    async_get_config_entry_diagnostics,
    playback_report,
    support_report,
)
from custom_components.eufy_viewer.playback import PlaybackView
from custom_components.eufy_viewer.recording_diagnostics import (
    EVENTS,
    PlaybackDiagnostics,
    attempt_header,
    project_attempt,
    recording_report,
)
from custom_components.eufy_viewer.recording_file import RecordingFile

from .test_playback import PREPARE
from .test_viewers import viewer_setup as _viewer_setup

viewer_setup = _viewer_setup


def test_projection_bounds_private_fields_versions_and_expiration():
    row = {
        "attempt": 123,
        "age_ms": 10,
        "format": "auto",
        "stage": "conversion",
        "outcome": "failed",
        "error": "recording_storage_unavailable",
        "source_cancel_confirmed": True,
        "files_removed": True,
        "source_bytes": 12,
        "output_bytes": 45,
        "duration_ms": 23,
        "card_version": "0.8.18",
        "bridge_attempt": 456,
        "file_closed": True,
        "limits": {"output_bytes": 268435456},
        "media": {
            "source": "hevc",
            "output": "h264",
            "processing": "nvidia",
            "fallback": False,
        },
        "progress": {"encoded_frames": 10, "output_bytes": 45, "process_closed": True},
        "events": [
            {
                "event": "recording_failed",
                "elapsed_ms": 23,
                "failure": {
                    "reason": "output_limit",
                    "output_bytes": 45,
                    "timeout_ms": 100,
                    "encoded_frames": 10,
                    "timeout_scope": "conversion",
                    "process_closed": True,
                    "ffmpeg": ["storage"],
                },
            }
        ],
    }
    assert project_attempt(row) == row
    raw = {
        **row,
        "token": "PRIVATE",
        "serial": "PRIVATE",
        "path": "PRIVATE",
        "events": [
            {
                **row["events"][0],
                "url": "PRIVATE",
                "failure": {
                    **row["events"][0]["failure"],
                    "ffmpeg_detail": "PRIVATE",
                    "ffmpeg": ["storage", "PRIVATE"],
                },
            }
        ]
        * 20,
    }
    result = recording_report({"schema": 1, "attempts": [raw] * 12, "expired": 2})
    assert len(result["attempts"]) == 8
    assert len(result["attempts"][0]["events"]) == 16
    assert "PRIVATE" not in json.dumps(result)
    assert (
        recording_report({"schema": 1, "attempts": [{**row, "age_ms": 900000}, {}]})[
            "omitted"
        ]
        == 2
    )
    for value in (None, [], {"schema": True}, {"schema": 2}):
        assert recording_report(value) == {"status": "unavailable"}
    assert recording_report({"schema": 1, "attempts": {}}) == {
        "status": "invalid_report"
    }
    assert project_attempt(None) == {}
    bad = project_attempt(
        {
            "card_version": "PRIVATE",
            "attempt": True,
            "stage": [],
            "events": [None, {"event": []}, {"event": "failed", "elapsed_ms": True}],
            "media": {"source": "PRIVATE", "fallback": "PRIVATE"},
            "limits": {"output_bytes": True},
            "progress": {"output_bytes": -1},
        }
    )
    assert bad == {
        "card_version": "unavailable",
        "media": {},
        "limits": {},
        "progress": {},
        "events": [],
    }
    for value in (None, [], "", "PRIVATE", "0", str(2**48), "1\n", "1" * 50):
        assert attempt_header(value) is None
    assert attempt_header(str(2**48 - 1)) == 2**48 - 1


def test_attempt_retention_snapshot_isolation_and_no_ownership():
    now = 0.0
    store = PlaybackDiagnostics(lambda: now)
    for _ in range(10):
        row = store.begin("native", "0.8.18")
    row.received("567")
    row.received("PRIVATE")
    for event in [*EVENTS, *EVENTS, "PRIVATE"]:
        row.mark(event)
    result = store.report()
    assert len(result["attempts"]) == 8
    assert len(result["attempts"][-1]["events"]) == 16
    assert result["attempts"][-1]["bridge_attempt"] == 567
    result["attempts"][-1]["format"] = "PRIVATE"
    assert store.report()["attempts"][-1]["format"] == "native"
    now = 900
    assert store.report() == {
        "schema": 1,
        "retention_ms": 900000,
        "attempts": [],
        "expired": 8,
    }


def test_old_failed_cached_and_stale_bridge_evidence_is_explicit():
    base = {"schema": 2, "last_discovery": [], "recent_events": []}
    assert support_report(base)["recording"] == {"status": "unavailable"}
    raw = {
        **base,
        "software": {"bridge": "0.8.17", "node": "24.1.0", "token": "PRIVATE"},
        "recording": {"schema": 1, "attempts": [{"attempt": 1, "age_ms": 10}]},
        "live_audio": [{"attempt": 2, "age_ms": 10}],
        "cache_age_ms": 900000,
    }
    safe = support_report(raw)
    assert safe["recording"]["attempts"] == [] and safe["live_audio"] == []
    assert safe["recording"]["omitted"] == 1
    # The download widens the window by the bridge's live cap, audio rows follow.
    assert support_report(raw, window_ms=2_700_000)["live_audio"] == [
        {"attempt": 2, "age_ms": 10}
    ]
    assert "PRIVATE" not in json.dumps(safe)
    assert (
        support_report({**base, "cache_age_ms": "PRIVATE"})["cache_age_ms"] == 2**31 - 1
    )
    gaps = assess({"support": safe})["missing_evidence"]
    assert "bridge_report_cached_after_disconnect" in gaps
    assert "recording_evidence_expired_or_omitted" in gaps


def test_interpretation_preserves_stage_and_uncertainty_instead_of_guessing_causes():
    report = {
        "integration": "0.8.18",
        "support": {
            "last_discovery": [
                {"timestamp": "2000-01-01T00:00:00.000Z", "owner_status": "error"}
            ],
            "live_audio": [
                {
                    "attempt": 1,
                    "admission": "excluded",
                    "stop_confirmed": False,
                    "pipeline": [{"event": "stream_failure"}, {"event": "audio_late"}],
                }
            ],
            "recording": {
                "schema": 1,
                "attempts": [
                    {
                        "attempt": 2,
                        "stage": "conversion",
                        "progress": {"process_closed": False},
                        "outcome": "failed",
                        "events": [{"failure": {"reason": "output_limit"}}],
                    }
                ],
            },
        },
        "live_playback": [
            {
                "audio_attempt": 1,
                "browser": [
                    {"ice": "failed", "video_packets": 10, "video_decoded": 0},
                    {"video_decoded": 1, "painted": 0, "audio_samples": 10},
                ],
            }
        ],
        "recording_playback": {
            "attempts": [
                {
                    "attempt": 3,
                    "bridge_attempt": 2,
                    "error": "recording_storage_unavailable",
                    "events": [{"event": "client_disconnect"}, {"event": "released"}],
                }
            ]
        },
    }
    result = assess(report)
    stages = {f["stage"] for f in result["findings"]}
    assert stages == {
        "owner_connection",
        "media_input",
        "audio_admission",
        "live_cleanup",
        "browser_connection",
        "browser_decode",
        "browser_presentation",
        "browser_audio",
        "recording_conversion",
        "recording_storage",
        "viewer_connection",
        "viewer_closure",
        "ha_recording_storage",
    }
    assert "recording_source_or_file_cleanup_unconfirmed" in result["missing_evidence"]
    assert "ha_recording_file_cleanup_unconfirmed" in result["missing_evidence"]
    assert "discovery_stale_or_clock_mismatch" in result["missing_evidence"]
    assert "loaded_card_version_missing_or_different" in result["missing_evidence"]
    assert "Physical audibility remains unverified" in json.dumps(result)
    assert len(assess({})["missing_evidence"]) >= 3
    assert (
        "bridge_report_unavailable"
        in assess({"support": {"status": "unavailable"}})["missing_evidence"]
    )


def test_healthy_partial_and_missing_samples_do_not_become_faults():
    result = assess(
        {
            "integration": "0.8.18",
            "support": {
                "last_discovery": [
                    {
                        "timestamp": datetime.now(UTC).isoformat(),
                        "owner_status": "connected",
                    }
                ],
                "live_audio": [{"attempt": 1}],
                "recording": {
                    "attempts": [
                        {
                            "attempt": 2,
                            "stage": "transfer",
                            "outcome": "completed",
                            "files_removed": True,
                            "source_cancel_confirmed": True,
                        }
                    ]
                },
            },
            "live_playback": [
                {
                    "age_ms": 1,
                    "audio_attempt": 1,
                    "browser": [
                        {
                            "card_version": "0.8.18",
                            "video_packets": 5,
                            "video_decoded": 2,
                            "painted": 2,
                        }
                    ],
                }
            ],
            "recording_playback": {
                "attempts": [
                    {
                        "attempt": 3,
                        "bridge_attempt": 2,
                        "card_version": "0.8.18",
                        "events": [],
                    }
                ]
            },
        }
    )
    assert result["findings"] == []
    assert result["missing_evidence"] == ["recording_browser_playback_not_observed"]
    partial = assess(
        {
            "support": {"last_discovery": [{"event": "device"}]},
            "live_playback": [{}],
            "recording_playback": {"attempts": [{}]},
        }
    )
    assert "discovery_time_unavailable" in partial["missing_evidence"]
    assert "live_browser_sample_unavailable" in partial["missing_evidence"]
    assert "live_bridge_correlation_unavailable" in partial["missing_evidence"]
    assert "recording_bridge_correlation_unavailable" in partial["missing_evidence"]


def test_live_projection_keeps_late_audio_ice_but_removes_arbitrary_stored_text():
    result = playback_report(
        {
            "_created": float("nan"),
            "audio_attempt": True,
            "ticks": "PRIVATE",
            "acks": 5,
            "offered": True,
            "answered": False,
            "audio_expected": True,
            "fallback": "startup_timeout",
            "relay": [
                None,
                {"source_h264_packets": 12, "trigger": "startup", "sdp": "PRIVATE"},
            ],
            "browser": [
                {
                    "card_version": "0.8.18",
                    "audio_ice": "failed",
                    "audio_relay_configured": True,
                    "sdp": "PRIVATE",
                }
            ],
        }
    )
    assert "PRIVATE" not in json.dumps(result)
    assert result["age_ms"] is None
    assert result["relay"] == [{"source_h264_packets": 12, "trigger": "startup"}]
    assert result["browser"][0]["audio_ice"] == "failed"
    assert "audio_late" not in result and "audio_late_end" not in result
    assert (
        playback_report({"fallback": [], "relay": "PRIVATE", "browser": "PRIVATE"})[
            "relay"
        ]
        == []
    )
    late = playback_report(
        {
            "audio_expected": False,
            "audio_late": "answered",
            "audio_late_end": "upstream_error",
            "relay": [
                {"source_aac_packets": 3, "audio_late": True, "trigger": "playing"},
                {"source_h264_packets": 1, "audio_late": "PRIVATE"},
            ],
            "browser": [{"trigger": "audio_check", "audio_late": "attached"}],
        }
    )
    assert late["audio_late"] == "answered"
    assert late["audio_late_end"] == "upstream_error"
    assert late["relay"] == [
        {"source_aac_packets": 3, "audio_late": True, "trigger": "playing"},
        {"source_h264_packets": 1},
    ]
    assert late["browser"] == [{"trigger": "audio_check", "audio_late": "attached"}]
    unknown = playback_report(
        {"audio_late": "PRIVATE", "audio_late_end": 1, "browser": [{"audio_late": 1}]}
    )
    assert "audio_late" not in unknown and "audio_late_end" not in unknown
    assert unknown["browser"] == [{}]


@pytest.mark.parametrize(
    ("live", "observations", "stages"),
    [
        ({"audio_expected": False}, ["no late audio had been announced"], set()),
        (
            {"audio_expected": False, "audio_late": "announced"},
            ["reached the 'announced' stage"],
            set(),
        ),
        (
            {
                "audio_expected": False,
                "audio_late": "ready",
                "audio_late_end": "stopped",
            },
            ["reached the 'ready' stage"],
            set(),
        ),
        (
            {
                "audio_expected": False,
                "audio_late": "offered",
                "audio_late_end": "signaling_failed",
            },
            ["reached the 'offered' stage", "ended before its video session"],
            {"late_audio"},
        ),
        (
            {
                "audio_expected": False,
                "audio_late": "announced",
                "audio_late_end": "unavailable",
            },
            ["reached the 'announced' stage", "could not use it"],
            {"late_audio"},
        ),
        ({"audio_expected": True}, [], set()),
        ({"audio_late": "PRIVATE"}, [], set()),
    ],
)
def test_late_audio_assessment_separates_route_from_initial_classification(
    live, observations, stages
):
    result = assess({"support": {}, "live_playback": [{"age_ms": 1, **live}]})
    text = json.dumps(result)
    assert "PRIVATE" not in text
    for observation in observations:
        assert observation in text
    findings = [f for f in result["findings"] if f["stage"] != "audio_admission"]
    assert {f["stage"] for f in findings} == stages
    assert len(result["findings"]) == len(observations)


@pytest.mark.parametrize("failure", [False, True])
async def test_api_correlation_is_retained_on_success_and_failure(
    aiohttp_server, socket_enabled, failure
):
    async def handler(_request):
        headers = {"X-Eufy-Recording-Attempt": "12345"}
        return (
            web.json_response(
                {"error": "recording_storage_unavailable"}, status=503, headers=headers
            )
            if failure
            else web.Response(body=b"mp4", content_type="video/mp4", headers=headers)
        )

    app = web.Application()
    app.router.add_get("/v1/recordings/CAM/clip/video", handler)
    server = await aiohttp_server(app)
    import aiohttp

    async with aiohttp.ClientSession() as session:
        api = BridgeClient(session, str(server.make_url("")).rstrip("/"), "PRIVATE")
        file = RecordingFile()
        observation = PlaybackDiagnostics().begin("h264")
        file.observation = observation
        await file.open()
        try:
            if failure:
                with pytest.raises(BridgeRecordingError):
                    await api.recording_media("CAM", "clip", target=file)
            else:
                await api.recording_media("CAM", "clip", target=file)
            assert observation.data["bridge_attempt"] == 12345
        finally:
            file.close()
        assert observation.data["file_closed"] is True


async def test_prepare_export_release_and_error_preserve_cleanup(
    hass, hass_client, viewer_setup
):
    client = await hass_client()
    coordinator = viewer_setup.runtime_data

    async def download(*_, target, **kwargs):
        target.observation.received("123")
        await target.write(b"recording")

    with patch.object(coordinator.api, "recording_media", side_effect=download):
        response = await client.post(PREPARE + "?card_version=0.8.18")
    data = await response.json()
    assert response.status == 200
    assert (await client.get(data["url"])).status == 200
    assert (await client.delete(data["path"])).status == 204
    with patch.object(
        coordinator.api,
        "request",
        AsyncMock(
            return_value={"schema": 2, "last_discovery": [], "recent_events": []}
        ),
    ) as fetch:
        report = await async_get_config_entry_diagnostics(hass, viewer_setup)
    fetch.assert_awaited_once_with("GET", "/v1/diagnostics")
    row = report["recording_playback"]["attempts"][0]
    assert row["bridge_attempt"] == 123 and row["card_version"] == "0.8.18"
    assert row["file_closed"] is True
    assert {e["event"] for e in row["events"]} >= {
        "prepared",
        "serving",
        "response_complete",
        "released",
        "file_closed",
    }
    assert "CAM123" not in json.dumps(report)
    with patch.object(
        coordinator.api,
        "recording_media",
        side_effect=BridgeRecordingError("recording_storage_unavailable", 503),
    ):
        assert (await client.post(PREPARE)).status == 503
    failed = coordinator.recording_diagnostics.report()["attempts"][-1]
    assert (
        failed["error"] == "recording_storage_unavailable"
        and failed["outcome"] == "failed"
    )
    assert failed["file_closed"] is True


async def test_normal_reader_disconnect_is_distinct_from_closure(tmp_path):
    store = PlaybackView(str(tmp_path))
    observation = PlaybackDiagnostics().begin("native")
    async with store.reserve() as body:
        body.observation = observation
        await body.write(b"clip")
        response = Mock(
            prepare=AsyncMock(),
            write=AsyncMock(side_effect=ConnectionResetError()),
            write_eof=AsyncMock(),
        )
        with patch(
            "custom_components.eufy_viewer.playback.web.StreamResponse",
            return_value=response,
        ):
            await store.send(Mock(headers={}, method="GET"), body)
        assert "file_closed" not in observation.data
        assert "client_disconnect" in {e["event"] for e in observation.data["events"]}
        assert body.owners == 1
    assert observation.data["file_closed"] is True
