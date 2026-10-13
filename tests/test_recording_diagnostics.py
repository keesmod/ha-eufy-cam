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


@pytest.mark.parametrize(
    ("integration", "card", "flagged"),
    [
        ("0.8.47-beta.1", "0.8.47-beta.1", False),
        ("0.8.47", "0.8.47", False),
        ("0.8.47-beta.2", "0.8.47-beta.1", True),
        ("0.8.47", "0.8.47-beta.2", True),
        ("0.8.47-beta.1", "unavailable", True),
        ("unavailable", "unavailable", True),
    ],
)
def test_loaded_card_must_be_the_integration_build_including_its_beta(
    integration, card, flagged
):
    # A beta card keeps its suffix through the recording projection.
    assert project_attempt({"card_version": card})["card_version"] == card
    assert PlaybackDiagnostics().begin("h264", card).snapshot()["card_version"] == card
    for sample in (
        {"live_playback": [{"browser": [{"card_version": card}]}]},
        {"recording_playback": {"attempts": [{"card_version": card}]}},
    ):
        missing = assess({"integration": integration, **sample})["missing_evidence"]
        assert ("loaded_card_version_missing_or_different" in missing) is flagged


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


def _owner_report(events, discovery=None):
    return {
        "support": {
            "last_discovery": discovery
            or [
                {"event": "summary", "report": 2},
                {"event": "device", "ref": 1, "report": 2, "station_status": "error"},
                {
                    "event": "device",
                    "ref": 4,
                    "owner_ref": 2,
                    "report": 2,
                    "owner_status": "error",
                },
                {
                    "event": "device",
                    "ref": 3,
                    "report": 2,
                    "station_status": "connected",
                },
            ],
            "recent_events": events,
        }
    }


def _connect_error(**row):
    return {
        "event": "station_connection",
        "phase": "connect",
        "status": "error",
        "report": 2,
        "device_ref": 1,
        "reason": "device_request_timeout",
        **row,
    }


def _owner_finding(report):
    (finding,) = [
        f for f in assess(report)["findings"] if f["stage"] == "owner_connection"
    ]
    return finding


@pytest.mark.parametrize(
    ("row", "expected"),
    [
        (
            {"stage": "lookup", "inventory_address": False},
            "No HomeBase answered the local lookup, and the inventory had no LAN "
            "address for it.",
        ),
        (
            {"stage": "lookup", "inventory_address": True},
            "No HomeBase answered the local lookup at its inventory LAN address "
            "or by broadcast.",
        ),
        ({"stage": "station_found"}, "did not complete the P2P handshake"),
        ({"stage": "session_open"}, "the command key was not established"),
        (
            {"stage": "session_open", "reason": "device_disconnected"},
            "the command key was not established",
        ),
    ],
)
def test_owner_connection_finding_names_the_stage_it_reached(row, expected):
    finding = _owner_finding(
        _owner_report([_connect_error(stage="lookup"), _connect_error(**row)])
    )
    assert expected in finding["observation"]
    assert finding["evidence"] == "support.recent_events.station_connection"


@pytest.mark.parametrize(
    "event",
    [
        # No stage was recorded.
        _connect_error(),
        # The attempt did not run out of time, another one was in progress.
        _connect_error(stage="none", reason="connection_busy"),
        _connect_error(stage="lookup", reason="client_closed"),
        # An earlier discovery report failed at the lookup, the current one did not.
        _connect_error(stage="lookup", report=1),
        # Another HomeBase, which connected in the current report, failed later.
        _connect_error(stage="session_open", device_ref=3),
    ],
)
def test_owner_connection_keeps_the_generic_finding_without_a_matching_stage(event):
    finding = _owner_finding(_owner_report([event]))
    assert "does not identify the network cause" in finding["observation"]
    assert finding["evidence"] == "support.last_discovery"


def test_owner_connection_names_the_latest_connect_that_ran_out_of_time():
    finding = _owner_finding(
        _owner_report(
            [
                _connect_error(stage="station_found"),
                _connect_error(stage="lookup", reason="client_closed"),
            ]
        )
    )
    assert "did not complete the P2P handshake" in finding["observation"]


def test_owner_connection_reconnected_later_in_the_report_keeps_the_generic_text():
    finding = _owner_finding(
        _owner_report(
            [
                _connect_error(stage="lookup"),
                {
                    "event": "station_connection",
                    "phase": "observation",
                    "status": "connected",
                    "report": 2,
                    "device_ref": 1,
                },
            ]
        )
    )
    assert "does not identify the network cause" in finding["observation"]


def _observation(status, phase="observation"):
    return {
        "event": "station_connection",
        "phase": phase,
        "status": status,
        "report": 2,
        "device_ref": 1,
    }


@pytest.mark.parametrize(
    ("events", "expected"),
    [
        (
            [
                _connect_error(stage="lookup"),
                _observation("connected"),
                {
                    **_observation("error", "refresh_state"),
                    "reason": "device_request_timeout",
                },
            ],
            "does not identify the network cause",
        ),
        (
            [
                _connect_error(stage="lookup"),
                _observation("connected"),
                _observation("disconnected"),
            ],
            "does not identify the network cause",
        ),
        (
            [
                _connect_error(stage="lookup"),
                _observation("connected"),
                _observation("disconnected"),
                _connect_error(stage="station_found"),
            ],
            "did not complete the P2P handshake",
        ),
        (
            # Another HomeBase connecting does not clear this one's failure.
            [
                _connect_error(stage="lookup"),
                {**_observation("connected"), "device_ref": 2},
            ],
            "No HomeBase answered the local lookup",
        ),
    ],
)
def test_owner_connection_only_explains_failures_after_the_last_connection(
    events, expected
):
    assert expected in _owner_finding(_owner_report(events))["observation"]


def test_owner_connection_names_only_a_stage_of_each_homebase_latest_attempt():
    # The latest attempt of ref 1 reached no named stage, so its earlier
    # station_found is not named. Ref 2's lookup stays its latest attempt, also
    # when ref 1 fails after it.
    assert (
        "does not identify the network cause"
        in (
            _owner_finding(
                _owner_report(
                    [
                        _connect_error(stage="station_found"),
                        _connect_error(stage="none"),
                    ]
                )
            )["observation"]
        )
    )
    assert (
        "No HomeBase answered the local lookup"
        in _owner_finding(
            _owner_report(
                [
                    _connect_error(stage="lookup", device_ref=2),
                    _connect_error(stage="none"),
                ]
            )
        )["observation"]
    )


def test_owner_connection_uses_the_failing_camera_owner_reference():
    finding = _owner_finding(
        _owner_report([_connect_error(stage="station_found", device_ref=2)])
    )
    assert "did not complete the P2P handshake" in finding["observation"]


def _standalone_report(events, owner_status="error", homebase_status="connected"):
    """A HomeBase row and an opted-in standalone T84A1 row, ref 5, in report 2."""
    return _owner_report(
        events,
        [
            {"event": "summary", "report": 2},
            {
                "event": "device",
                "ref": 1,
                "report": 2,
                "station_status": homebase_status,
            },
            {
                "event": "device",
                "ref": 5,
                "owner_ref": 5,
                "report": 2,
                "relationship": "standalone",
                "relationship_transport": "experimental",
                "owner_status": owner_status,
            },
        ],
    )


def _standalone_findings(report):
    return [
        f for f in assess(report)["findings"] if f["stage"] == "standalone_connection"
    ]


@pytest.mark.parametrize(
    ("row", "expected"),
    [
        (
            {"stage": "lookup", "inventory_address": False},
            "The experimental standalone camera did not answer the local lookup, "
            "and the inventory had no LAN address for it.",
        ),
        ({"stage": "station_found"}, "did not complete the P2P handshake"),
        ({"stage": "session_open"}, "the command key was not established"),
        (
            {"stage": "none", "reason": "invalid_connection_credentials"},
            "did not start its local lookup (invalid_connection_credentials)",
        ),
    ],
)
def test_standalone_connection_names_its_own_stage_and_never_a_homebase(row, expected):
    report = _standalone_report([_connect_error(device_ref=5, **row)])
    (finding,) = _standalone_findings(report)
    assert expected in finding["observation"]
    assert "HomeBase" not in finding["observation"]
    assert finding["evidence"] == "support.recent_events.station_connection"
    # The HomeBase connected, so no owner finding blames it.
    assert not [
        f for f in assess(report)["findings"] if f["stage"] == "owner_connection"
    ]


def test_standalone_and_homebase_failures_are_explained_separately():
    report = _standalone_report(
        [
            _connect_error(device_ref=1, stage="station_found"),
            _connect_error(device_ref=5, stage="lookup"),
        ],
        homebase_status="error",
    )
    assert "HomeBase answered the local lookup" in _owner_finding(report)["observation"]
    (finding,) = _standalone_findings(report)
    assert "did not answer the local lookup" in finding["observation"]


def test_standalone_session_that_connected_and_closed_is_not_called_a_failure():
    report = _standalone_report(
        [
            {
                "event": "station_connection",
                "phase": "connect",
                "status": "connected",
                "report": 2,
                "device_ref": 5,
            },
            {
                "event": "station_connection",
                "phase": "observation",
                "status": "disconnected",
                "report": 2,
                "device_ref": 5,
            },
        ],
        owner_status="disconnected",
    )
    (finding,) = _standalone_findings(report)
    assert "connected on the local route" in finding["observation"]


def test_standalone_without_a_recorded_connect_keeps_a_generic_finding():
    (finding,) = _standalone_findings(_standalone_report([]))
    assert "does not show how far it got" in finding["observation"]
    assert finding["evidence"] == "support.last_discovery"


def test_connected_or_unverified_standalone_cameras_add_no_finding():
    assert not _standalone_findings(_standalone_report([], owner_status="connected"))
    report = _standalone_report([], owner_status="not_applicable")
    report["support"]["last_discovery"][2].pop("relationship_transport")
    assert not _standalone_findings(report)
    # Its summary carries no option state, so it is no admission result (#154).
    assert not _admission_findings(report)


# A lookup of three rounds that received nothing, as bridge 0.8.38 reports it (#152).
_SILENT_LOOKUP = {
    "lookup_rounds": 3,
    "lookup_broadcast_targets": 2,
    "lookup_broadcast_enabled": True,
    "lookup_send_errors": 0,
    "lookup_datagrams": 0,
    "lookup_other_headers": 0,
    "lookup_own_replies": 0,
    "lookup_account_replies": 0,
    "lookup_foreign_replies": 0,
    "lookup_near_replies": 0,
    "lookup_inventory_reply": "none",
    "inventory_address_on_subnet": True,
    "inventory_address_shared": False,
}
_STANDALONE_LOOKUP = (
    "The experimental standalone camera did not answer the local lookup at its "
    "inventory LAN address or by broadcast."
)
_OWNER_LOOKUP = (
    "Owner connection was not established. No HomeBase answered the local lookup "
    "at its inventory LAN address or by broadcast. The bridge host did not reach "
    "the HomeBase on its LAN."
)
_FORMAT = "A lookup reply carried this {device}'s ID in a different format."
_SEND = "Some lookup requests could not be sent from the bridge host."
_FOREIGN = (
    "The device at the inventory LAN address answered with an ID outside this account."
)
_SHARED = "The inventory LAN address belongs to another device in this account."
_ACCOUNT = (
    "Other devices in this account answered the broadcast, but this {device} did not."
)


def _lookup_failure(device_ref=5, **lookup):
    return _connect_error(
        device_ref=device_ref,
        stage="lookup",
        inventory_address=True,
        **{**_SILENT_LOOKUP, **lookup},
    )


@pytest.mark.parametrize(
    ("lookup", "sentence"),
    [
        (
            {"lookup_rounds": 0, "lookup_broadcast_enabled": False},
            "No lookup request left the bridge.",
        ),
        ({"lookup_broadcast_enabled": False}, _SEND),
        ({"lookup_send_errors": 2, "lookup_near_replies": 1}, _SEND),
        ({"lookup_near_replies": 1, "lookup_datagrams": 1}, _FORMAT),
        (
            {"lookup_inventory_reply": "near", "lookup_foreign_replies": 1},
            _FORMAT,
        ),
        (
            {
                "lookup_inventory_reply": "foreign",
                "lookup_foreign_replies": 1,
                "lookup_datagrams": 1,
                "inventory_address_shared": True,
            },
            _FOREIGN,
        ),
        (
            {
                "lookup_inventory_reply": "account",
                "lookup_account_replies": 1,
                "lookup_datagrams": 1,
            },
            _SHARED,
        ),
        ({"inventory_address_shared": True}, _SHARED),
        ({"lookup_account_replies": 2, "lookup_datagrams": 2}, _ACCOUNT),
        (
            {
                "lookup_account_replies": 1,
                "lookup_foreign_replies": 4,
                "lookup_datagrams": 5,
            },
            _ACCOUNT,
        ),
        ({}, "No reply of any kind reached the bridge during the 3 lookup rounds."),
        (
            {"lookup_rounds": 1},
            "No reply of any kind reached the bridge during the 1 lookup round.",
        ),
        (
            {"lookup_rounds": None},
            "No reply of any kind reached the bridge during the lookup.",
        ),
        (
            {"lookup_foreign_replies": 3, "lookup_datagrams": 3},
            "Only devices outside this account answered.",
        ),
    ],
)
def test_standalone_lookup_fields_add_one_fixed_sentence_in_order(lookup, sentence):
    (finding,) = _standalone_findings(_standalone_report([_lookup_failure(**lookup)]))
    expected = f"{_STANDALONE_LOOKUP} {sentence.format(device='camera')}"
    assert finding["observation"] == expected
    assert finding["evidence"] == "support.recent_events.station_connection"
    assert ";" not in finding["observation"]
    assert "HomeBase" not in finding["observation"]


@pytest.mark.parametrize(
    ("lookup", "sentence"),
    [
        ({"lookup_near_replies": 1, "lookup_datagrams": 1}, _FORMAT),
        ({"lookup_account_replies": 1, "lookup_datagrams": 1}, _ACCOUNT),
        ({}, "No reply of any kind reached the bridge during the 3 lookup rounds."),
    ],
)
def test_owner_lookup_fields_add_one_fixed_sentence_for_the_homebase(lookup, sentence):
    finding = _owner_finding(_owner_report([_lookup_failure(device_ref=1, **lookup)]))
    expected = f"{_OWNER_LOOKUP} {sentence.format(device='HomeBase')}"
    assert finding["observation"] == expected


@pytest.mark.parametrize(
    "lookup",
    [
        # An own reply, or datagrams that were no lookup replies, name nothing.
        {"lookup_own_replies": 1, "lookup_own_round": 0, "lookup_datagrams": 1},
        {"lookup_other_headers": 2, "lookup_datagrams": 2},
        # Foreign replies next to an own reply are not only foreign.
        {"lookup_foreign_replies": 1, "lookup_own_replies": 1, "lookup_datagrams": 2},
        # Values the download replaced are no evidence.
        dict.fromkeys(_SILENT_LOOKUP),
    ],
)
def test_lookup_fields_without_a_matching_observation_keep_the_text(lookup):
    (finding,) = _standalone_findings(_standalone_report([_lookup_failure(**lookup)]))
    assert finding["observation"] == _STANDALONE_LOOKUP


def test_lookup_text_is_unchanged_without_the_fields_and_at_other_stages():
    plain = _connect_error(device_ref=5, stage="lookup", inventory_address=True)
    (finding,) = _standalone_findings(_standalone_report([plain]))
    assert finding["observation"] == _STANDALONE_LOOKUP
    owner = _owner_finding(_owner_report([{**plain, "device_ref": 1}]))
    assert owner["observation"] == _OWNER_LOOKUP
    # Only a failure at lookup gets a lookup sentence.
    found = {**_lookup_failure(), "stage": "station_found"}
    (finding,) = _standalone_findings(_standalone_report([found]))
    assert finding["observation"] == (
        "The experimental standalone camera answered the local lookup but did not "
        "complete the P2P handshake."
    )
    # Hostile raw values are replaced at the download boundary and add nothing.
    raw = {
        **_lookup_failure(),
        "lookup_rounds": "0",
        "lookup_broadcast_enabled": 0,
        "lookup_send_errors": 1.0,
        "lookup_near_replies": True,
        "lookup_inventory_reply": "PRIVATE",
        "inventory_address_shared": "true",
        "lookup_account_replies": 1000,
        "lookup_datagrams": -1,
        "lookup_foreign_replies": [3],
    }
    report = _standalone_report([])
    report["support"]["recent_events"] = support_report(
        {"schema": 2, "last_discovery": [], "recent_events": [raw]}
    )["recent_events"]
    (finding,) = _standalone_findings(report)
    assert finding["observation"] == _STANDALONE_LOOKUP


def _reporter_download(lookup):
    """The #152 topology: two opted-in standalone T8410 cameras and no HomeBase."""
    stamp = "2026-10-13T18:20:00.000Z"

    def record(**row):
        return {"diagnostic": "discovery", "schema": 2, "timestamp": stamp, **row}

    def camera(ref, firmware, status):
        return record(
            event="device",
            report=1,
            ref=ref,
            kind="camera",
            model="T8410",
            firmware=firmware,
            relationship="standalone",
            relationship_transport="experimental",
            relationship_reason=None,
            owner_ref=ref,
            owner_status=status,
            owner_connected=True if status == "connected" else None,
            station_status="not_applicable",
            station_connected=None,
        )

    return {
        "schema": 2,
        "generated_at": stamp,
        "last_discovery": [
            record(
                event="summary",
                report=1,
                outcome="accepted",
                cameras=2,
                stations=0,
                issues=0,
                experimental_standalone=True,
            ),
            camera(1, "2.3.2.4", "connected"),
            camera(2, "2.3.1.6", "error"),
            record(event="end", report=1, rows=2),
        ],
        "recent_events": [
            record(
                event="station_connection",
                report=1,
                device_ref=1,
                model="T8410",
                phase="connect",
                status="connected",
                reason=None,
            ),
            record(
                event="station_connection",
                report=1,
                device_ref=2,
                model="T8410",
                phase="connect",
                status="error",
                reason="device_request_timeout",
                stage="lookup",
                inventory_address=True,
                **lookup,
            ),
            record(event="fault", code="device_request_timeout", report=1),
        ],
        "live_video": [
            {
                "attempt": 36787778134067,
                "model": "T8410",
                "state": "failed",
                "duration_ms": 20012,
                "start": {},
                "input": {"chunks": 0, "bytes": 0},
                "output": {"chunks": 0, "bytes": 0},
                "jpeg": {"chunks": 0, "bytes": 0},
            }
        ],
    }


@pytest.mark.parametrize(
    ("lookup", "sentence"),
    [
        ({}, ""),
        (
            _SILENT_LOOKUP,
            " No reply of any kind reached the bridge during the 3 lookup rounds.",
        ),
    ],
)
def test_reporter_topology_without_a_homebase_explains_connection_and_live_start(
    lookup, sentence
):
    # Issue #152: every camera is standalone. Camera B's assessment was empty.
    support = support_report(_reporter_download(lookup))
    findings = assess({"support": support})["findings"]
    stages = [f["stage"] for f in findings]
    assert "standalone_connection" in stages
    assert "live_start" in stages
    assert "owner_connection" not in stages
    (connection,) = [f for f in findings if f["stage"] == "standalone_connection"]
    assert connection["observation"] == _STANDALONE_LOOKUP + sentence
    (start,) = [f for f in findings if f["stage"] == "live_start"]
    assert start["observation"] == (
        "No P2P video reached the bridge. The start failed before the camera's "
        "P2P session was ready."
    )
    assert start["attempt"] == 36787778134067


ADMISSION = (
    "The experimental_standalone option is on, but the bridge's library does not "
    "admit a standalone camera with model code {model} to the experimental route. "
    "It keeps standalone_transport_unverified and the bridge makes no connection "
    "attempt. This follows from the library's admitted models, not from a failed "
    "connection."
)
_OPTION_ON = {"event": "summary", "report": 2, "experimental_standalone": True}


def _unadmitted(ref, model="T8410C", **row):
    """A standalone row the library kept at standalone_transport_unverified."""
    return {
        "event": "device",
        "ref": ref,
        "owner_ref": ref,
        "report": 2,
        "model": model,
        "relationship": "standalone",
        "relationship_reason": "standalone_transport_unverified",
        "relationship_transport": None,
        "owner_status": "not_applicable",
        **row,
    }


def _admission_report(discovery, events=()):
    return {"support": {"last_discovery": discovery, "recent_events": list(events)}}


def _admission_findings(report):
    return [
        f for f in assess(report)["findings"] if f["stage"] == "standalone_admission"
    ]


def test_unadmitted_standalone_camera_with_the_option_on_is_named_once():
    (finding,) = _admission_findings(_admission_report([_OPTION_ON, _unadmitted(5)]))
    assert finding == {
        "stage": "standalone_admission",
        "observation": ADMISSION.format(model="T8410C"),
        "evidence": "support.last_discovery",
    }
    assert "HomeBase" not in finding["observation"]


@pytest.mark.parametrize(
    "discovery",
    [
        [{**_OPTION_ON, "experimental_standalone": False}, _unadmitted(5)],
        [{**_OPTION_ON, "experimental_standalone": None}, _unadmitted(5)],
        [{"event": "summary", "report": 2}, _unadmitted(5)],
        # Only an older report had the option on.
        [
            {**_OPTION_ON, "report": 1},
            {"event": "summary", "report": 2},
            _unadmitted(5),
        ],
        # The option state counts only on the summary.
        [
            {"event": "summary", "report": 2},
            _unadmitted(5, experimental_standalone=True),
        ],
        # Without an integer report nothing is current.
        [{**_OPTION_ON, "report": None}, _unadmitted(5, report=None)],
        [{**_OPTION_ON, "report": True}, _unadmitted(5, report=True)],
    ],
)
def test_no_admission_finding_without_the_current_option_state(discovery):
    assert not _admission_findings(_admission_report(discovery))


def test_mixed_standalone_report_separates_admission_from_connection():
    report = _admission_report(
        [
            _OPTION_ON,
            {"event": "device", "ref": 1, "report": 2, "station_status": "connected"},
            {
                **_unadmitted(3, "T84A1", relationship_transport="experimental"),
                "relationship_reason": None,
                "owner_status": "connected",
            },
            {
                **_unadmitted(4, "T8410", relationship_transport="experimental"),
                "relationship_reason": None,
                "owner_status": "error",
            },
            _unadmitted(5, "T8410C"),
            _unadmitted(6, "T8400"),
            _unadmitted(7, "T8400"),
        ],
        [_connect_error(device_ref=4, stage="lookup")],
    )
    findings = assess(report)["findings"]
    assert [f["observation"] for f in _admission_findings(report)] == [
        ADMISSION.format(model="T8410C"),
        ADMISSION.format(model="T8400"),
    ]
    (connection,) = _standalone_findings(report)
    assert "did not answer the local lookup" in connection["observation"]
    assert not [f for f in findings if f["stage"] == "owner_connection"]
    assert all(";" not in f["observation"] for f in findings)


@pytest.mark.parametrize(
    "row",
    [
        _unadmitted(5, relationship_transport="experimental"),
        _unadmitted(5, relationship="unsupported"),
        _unadmitted(5, relationship_reason="unsupported_station"),
        _unadmitted(5, relationship_reason=None),
        {
            "event": "issue",
            "report": 2,
            "code": "standalone_transport_unverified",
            "model": "T8410C",
            "relationship": "standalone",
            "relationship_reason": "standalone_transport_unverified",
        },
    ],
)
def test_only_an_unadmitted_standalone_device_row_is_named(row):
    assert not _admission_findings(_admission_report([_OPTION_ON, row]))


def test_admission_text_names_only_projected_model_codes():
    raw = {
        "schema": 2,
        "last_discovery": [
            _OPTION_ON,
            _unadmitted(5, "T8410PRIVATE0001"),
            _unadmitted(6, "T8400\nPRIVATE"),
            _unadmitted(7, "T8400"),
        ],
        "recent_events": [],
    }
    findings = _admission_findings({"support": support_report(raw)})
    assert [f["observation"] for f in findings] == [
        ADMISSION.format(model="unavailable"),
        ADMISSION.format(model="T8400"),
    ]
    assert "model code unavailable" in findings[0]["observation"]
    assert all(";" not in f["observation"] for f in findings)
    assert "PRIVATE" not in json.dumps(findings)
