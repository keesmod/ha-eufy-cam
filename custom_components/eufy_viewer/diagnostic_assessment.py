"""Explain observations, keeping absent evidence separate from possible causes."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .live_diagnostics import LATE_AUDIO_STAGES

# FFmpeg reports its progress once a second, so a counter that rose within
# two reports after the last output chunk can still date from before it.
_PROGRESS_SLACK_MS = 2000


def _encoder_stage(row: dict[str, Any]) -> str:
    """Name the FFmpeg stage when its progress counters cover an output stop.

    That needs an encoder output that stopped more than 6 s before the end, an
    input that flowed more than 6 s past that stop and FFmpeg's progress blocks
    over the same span. Otherwise the counters cannot name a stage.
    """
    encoder, output, source = (
        row.get(key, {}) for key in ("encoder", "output", "input")
    )
    stopped, age = output.get("last_data_ms"), output.get("last_data_age_ms")
    flowed, reported = source.get("last_data_ms"), encoder.get("last_progress_ms")
    if not (
        type(stopped) is int
        and type(age) is int
        and age > 6000
        and type(flowed) is int
        and flowed - stopped > 6000
        and type(reported) is int
        and reported - stopped > 6000
    ):
        return ""
    frame, drop = encoder.get("last_frame_ms"), encoder.get("last_drop_ms")
    if type(frame) is int and frame - stopped > _PROGRESS_SLACK_MS:
        return (
            f" FFmpeg's frame count kept rising for {frame - stopped} ms after the "
            "last output chunk while the input flowed, so the encoder or the "
            "muxer emitted nothing."
        )
    if type(drop) is int and drop - stopped > _PROGRESS_SLACK_MS:
        return (
            " FFmpeg's frame count stopped with the output while its drop count "
            f"kept rising for {drop - stopped} ms after the last output chunk, "
            "so the video sync dropped the frames."
        )
    return (
        " Neither FFmpeg's frame count nor its drop count rose in the "
        f"{reported - stopped} ms it kept reporting after the last output chunk "
        "while the input flowed, so the decoder delivered no frames."
    )


def assess(report: dict[str, Any]) -> dict[str, Any]:
    """Only inspect the projected report. Findings never contain upstream text."""
    findings: list[dict[str, Any]] = []
    missing: set[str] = set()

    def add(stage: str, observation: str, evidence: str, attempt: Any = None) -> None:
        row: dict[str, Any] = {
            "stage": stage,
            "observation": observation,
            "evidence": evidence,
        }
        if type(attempt) is int and 1 <= attempt < 2**48:
            row["attempt"] = attempt
        findings.append(row)

    support = report.get("support", {})
    if support.get("cache_age_ms", 0) > 0:
        missing.add("bridge_report_cached_after_disconnect")
    if "status" in support:
        missing.add("bridge_report_unavailable")
    discovery = support.get("last_discovery", [])
    if not discovery:
        missing.add("discovery_not_recorded")
    else:
        stamps = [r.get("timestamp") for r in discovery if r.get("timestamp")]
        try:
            age = (
                datetime.now(UTC) - datetime.fromisoformat(max(stamps))
            ).total_seconds()
            if age > 900 or age < -60:
                missing.add("discovery_stale_or_clock_mismatch")
        except ValueError:
            missing.add("discovery_time_unavailable")
    if any(
        r.get("owner_status") in {"error", "disconnected"}
        or r.get("station_status") in {"error", "disconnected"}
        for r in discovery
    ):
        add(
            "owner_connection",
            "Owner connection was not established. The report does not "
            "identify the network cause.",
            "support.last_discovery",
        )
    for row in support.get("live_audio", []):
        attempt = row.get("attempt")
        events = {e["event"] for e in row.get("pipeline", [])}
        if "stream_failure" in events and not {"video_input", "audio_input"} & events:
            add(
                "media_input",
                "The attempt failed before media input was observed.",
                "support.live_audio.pipeline",
                attempt,
            )
        if row.get("admission") == "excluded":
            add(
                "audio_admission",
                "Audio was excluded at the observed admission point. "
                "This does not prove the source is silent.",
                "support.live_audio.admission",
                attempt,
            )
        if "audio_late" in events:
            times = {
                e.get("event"): e.get("elapsed_ms") for e in row.get("pipeline", [])
            }
            first, video = times.get("audio_late"), times.get("video_input")
            delay = (
                f" {first - video} ms after the first video data"
                if isinstance(first, int) and isinstance(video, int) and first >= video
                else ""
            )
            add(
                "audio_admission",
                f"Complete AAC was offered on the late-audio route{delay}. "
                "Since bridge 0.8.20 this is the only live audio route.",
                "support.live_audio.pipeline",
                attempt,
            )
        if row.get("stop_confirmed") is False:
            add(
                "live_cleanup",
                "The device stop was not confirmed.",
                "support.live_audio.stop_confirmed",
                attempt,
            )
    for row in support.get("live_video", []):
        if row.get("state") not in {"ended", "failed", "closed"}:
            continue
        stopped = [
            f"{label} {age} ms"
            for stage, label in (
                ("input", "the P2P video input"),
                ("output", "the encoder output"),
                ("jpeg", "the JPEG frames"),
            )
            if type(age := row.get(stage, {}).get("last_data_age_ms")) is int
            and age > 6000
        ]
        if stopped:
            add(
                "video_stall",
                "Before the session's end " + ", ".join(stopped) + " had stopped. "
                "The earliest point in the chain from the P2P input through the "
                "encoder output to the JPEG frames locates the stall, and a later "
                "point that kept flowing clears the points before it."
                + _encoder_stage(row),
                "support.live_video",
                row.get("attempt"),
            )
    lives = report.get("live_playback", [])
    if not lives:
        missing.add("recent_live_playback_not_recorded")
    audio_attempts = {r.get("attempt") for r in support.get("live_audio", [])}
    for live in lives:
        attempt = live.get("audio_attempt")
        if live.get("age_ms") is None:
            missing.add("live_evidence_time_unavailable")
        if attempt is None or attempt not in audio_attempts:
            missing.add("live_bridge_correlation_unavailable")
        # The bridge's initial classification is video-only whenever audio is
        # delivered through the late audio route, so it alone proves nothing.
        late = live.get("audio_late")
        if live.get("audio_expected") is False and late is None:
            add(
                "audio_admission",
                "Startup metadata excluded audio and no late audio had been "
                "announced for this attempt when the report was made. "
                "Audio may still arrive later or be absent at the source.",
                "live_playback.audio_late",
                attempt,
            )
        elif late in LATE_AUDIO_STAGES:
            add(
                "audio_admission",
                f"Late audio reached the '{late}' stage for this attempt. "
                "Browser audio counters describe its separate peer.",
                "live_playback.audio_late",
                attempt,
            )
        end = live.get("audio_late_end")
        if end in {"setup_failed", "signaling_failed", "upstream_error"}:
            add(
                "late_audio",
                "Late audio ended before its video session, at the recorded "
                "fixed reason. Video playback was not interrupted by this.",
                "live_playback.audio_late_end",
                attempt,
            )
        elif end == "unavailable":
            add(
                "late_audio",
                "The bridge announced late audio while this viewer could not "
                "use it, for example during video setup failure or fallback.",
                "live_playback.audio_late_end",
                attempt,
            )
        browser = live.get("browser", [])
        if not browser:
            missing.add("live_browser_sample_unavailable")
        for row in browser:
            if row.get("card_version") != report.get("integration"):
                missing.add("loaded_card_version_missing_or_different")
            if row.get("ice") == "failed":
                add(
                    "browser_connection",
                    "The browser reported ICE connection failure. "
                    "Candidate counters describe the attempted route, "
                    "not its root cause.",
                    "live_playback.browser.ice",
                    attempt,
                )
            if row.get("video_packets", 0) > 0 and row.get("video_decoded") == 0:
                add(
                    "browser_decode",
                    "Video packets arrived but the sample contains no decoded frames.",
                    "live_playback.browser",
                    attempt,
                )
            if row.get("video_decoded", 0) > 0 and row.get("painted") == 0:
                add(
                    "browser_presentation",
                    "Frames decoded but no presented frame was "
                    "acknowledged in this sample.",
                    "live_playback.browser",
                    attempt,
                )
            if row.get("audio_samples", 0) > 0:
                add(
                    "browser_audio",
                    "The browser reported decoded audio samples. "
                    "Physical audibility remains unverified.",
                    "live_playback.browser.audio_samples",
                    attempt,
                )
    bridge_recording = support.get("recording", {})
    if bridge_recording.get("status"):
        missing.add("bridge_recording_schema_unavailable")
    if (
        bridge_recording.get("expired")
        or bridge_recording.get("omitted")
        or report.get("recording_playback", {}).get("expired")
    ):
        missing.add("recording_evidence_expired_or_omitted")
    recordings = bridge_recording.get("attempts", [])
    if not recordings:
        missing.add("recent_bridge_recording_not_recorded")
    for row in recordings:
        attempt = row.get("attempt")
        if row.get("progress", {}).get("process_closed") is False:
            missing.add("recording_process_cleanup_unconfirmed")
        if row.get("outcome") == "failed":
            add(
                "recording_" + row.get("stage", "unknown"),
                "Recording preparation failed at the last observed "
                "stage. Inspect the fixed failure categories and "
                "limits.",
                "support.recording.attempts",
                attempt,
            )
        for event in row.get("events", []):
            failure = event.get("failure", {})
            if failure.get("reason") in {
                "output_limit",
                "output_io",
            } or "storage" in failure.get("ffmpeg", []):
                add(
                    "recording_storage",
                    "The converter reported an output storage failure "
                    "or size limit. This does not establish a GPU "
                    "fault.",
                    "support.recording.attempts.events.failure",
                    attempt,
                )
        if (
            row.get("outcome") != "active"
            and row.get("stage") != "admission"
            and (
                row.get("source_cancel_confirmed") is not True
                or row.get("files_removed") is not True
            )
        ):
            missing.add("recording_source_or_file_cleanup_unconfirmed")
    playback = report.get("recording_playback", {}).get("attempts", [])
    if playback:
        missing.add("recording_browser_playback_not_observed")
    bridge_attempts = {r.get("attempt") for r in recordings}
    if not playback:
        missing.add("recent_ha_recording_not_recorded")
    for row in playback:
        attempt = row.get("attempt")
        if row.get("bridge_attempt") not in bridge_attempts:
            missing.add("recording_bridge_correlation_unavailable")
        if row.get("card_version") != report.get("integration"):
            missing.add("loaded_card_version_missing_or_different")
        events = {e["event"] for e in row.get("events", [])}
        if "client_disconnect" in events:
            add(
                "viewer_connection",
                "A recording HTTP reader disconnected. Closing or "
                "seeking can cause this during normal playback.",
                "recording_playback.attempts.events",
                attempt,
            )
        if "released" in events:
            add(
                "viewer_closure",
                "The viewer explicitly released the prepared recording.",
                "recording_playback.attempts.events",
                attempt,
            )
        if row.get("error") == "recording_storage_unavailable":
            add(
                "ha_recording_storage",
                "Home Assistant reported recording storage unavailable. "
                "This may be its shared budget or the bridge storage "
                "result.",
                "recording_playback.attempts.error",
                attempt,
            )
        if {
            "released",
            "expired",
            "unloaded",
            "failed",
            "cancelled",
        } & events and row.get("file_closed") is not True:
            missing.add("ha_recording_file_cleanup_unconfirmed")
    # The same fixed observation can occur at multiple sampled triggers.
    unique = list(
        {(r["stage"], r["observation"], r.get("attempt")): r for r in findings}.values()
    )
    return {
        "schema": 1,
        "findings": unique[:64],
        "missing_evidence": sorted(missing),
        "scope": (
            "Observed software stages only. Missing samples are not "
            "proof of absent media or a hardware failure."
        ),
    }
