# WebRTC 0.2.0 candidate validation — 2026-09-06

This is local implementation evidence, not a published release or a physical-camera acceptance record. The working Home Assistant 0.1.0 installation was not changed for these tests.

- Home Assistant 2026.9.0 / Python 3.14: 41 tests passed, 96% coverage. Tests include connection-scoped SDP/ICE, entity permissions, old-bridge/missing-go2rtc rejection before camera start, bounded messages, upstream error redaction and cleanup.
- Official hassfest: one integration, zero invalid integrations. Ruff formatting/lint and mypy passed; both TypeScript projects compile in strict mode.
- All 14 Node 24 bridge tests passed. They cover actual FFmpeg decoding, independent viewer expiry, shared-viewer stop semantics, late starts, stop quarantine, media grant revocation and existing-reader isolation.
- Browser suite: eight existing card checks plus three real WebRTC acceptance cases. Actual Chromium receives generated 1280×720 video and decoded audio via FFmpeg and go2rtc 1.9.14. Audio energy is checked after the sound button unmutes playback. Closing, navigation and frozen rendering each end with one fake-camera start, one stop and zero active/quarantined cameras. Frozen rendering uses an injected watchdog clock; navigation exercises normal lease expiry.
- The WebRTC fixture uses the actual media relay and go2rtc but simulates HA dispatch and Eufy hardware. HA signaling is tested separately. It never accesses a production account, real camera or microphone.

Both the Supervisor app and standalone bridge Docker images built successfully. The standalone image passed isolated, network-disabled startup, authentication, empty-account state and graceful-shutdown checks. Installation archives and SHA-256 checksums were generated locally. GitHub CI has been updated to require real-media tests but has not run for this unpublished branch.

## Required physical acceptance

Update the bridge and HA integration together, retaining a rollback to 0.1.0. Verify actual picture and listen-only audio on all intended models, then close the dialog and correlate SDK stop confirmation with zero active viewers. Verify idle does not start a camera, multiple viewers, tablet/iOS background behavior and any remote/VPN route. H.265 and the range of AAC device variants need hardware evidence; the real-media fixture supplies H.264 and ordinary AAC. CPU load and sustained battery impact have not been measured.

HA-managed go2rtc must be loaded. Its media endpoint must be reachable by the browser; an HTTPS reverse proxy alone is insufficient. No STUN/TURN service is supplied. Hard bridge/host failure still cannot deliver a physical stop command.

## Live recovery — 2026-09-06

After a bridge restart, cached-login profile loading received application response code 200. The pinned SDK accepted only 0, leaving its legacy API disconnected while the newer authentication path reported connected. The resulting inventory was empty. This matches upstream https://github.com/bropat/eufy-security-client/pull/975.

The bridge now normalizes application code 200 to 0 only when HTTP status is 200. Payloads, legacy success, authentication challenges and HTTP failures remain unchanged. Two regression tests include the actual SDK profile loader; all 16 bridge tests passed. The correction is bundled in the app build and does not require modifying installed SDK files.

On the live installation, all four cameras and their snapshots returned with zero stream starts. Chromium then received Tuinhuis WebRTC video at 1920×1080. The sound toggle changed to Mute sound; audible output was not independently verified. Start requested at 10:24:56.515 UTC, camera start confirmed at 10:24:58.280 UTC, close requested stop at 10:25:17.403 UTC and camera stop confirmed at 10:25:17.408 UTC. Final counters: one start, one stop, 151 JPEG readiness/snapshot frames, zero active cameras and zero quarantined stops.

The separate old Eufy alarm integration remained unavailable; this camera-bridge correction does not update that separate SDK runtime. Temporary diagnostic instrumentation was restored before deployment. No cloud polling timer was added.

## Existing HomeBase recordings — same unpublished branch

The recording follow-up succeeded without replacing the pinned SDK or reverting the working WebRTC/audio code. The actual HA card listed Voordeur recordings on 5 and 6 September and played one existing clip from each date to completion at 1920×1080. A third download was cancelled by closing the dialog. End state: 2 completed downloads, 1 cancellation, 0 active recording operations; 0 live starts and 0 active/quarantined streams. All four camera entities were idle and all four snapshots returned HTTP 200. See [the protocol investigation and exact playback evidence](RECORDINGS_PROBE_2026-09-06.md#actual-ha-dashboard-playback-and-cleanup).

The expanded local checks passed: 46 HA tests, 95.92% coverage, 20 bridge tests, 13 browser tests including all three existing real WebRTC/audio cases, strict TypeScript, mypy, Ruff and hassfest (zero invalid integrations). The installed local app was rebuilt from the repository, backed up and validated with `ha core check`; Core was restarted for the additional authenticated recording HTTP views. No GitHub publication or release was performed.

## Closed-viewer recording failure — 2026-09-06

The user's Tuinhuis failure was reproduced at the bridge: an authenticated calendar request returned HTTP 400 in 4 ms, with `active_cameras=0`, `quarantined=1`, and `recording_metrics.active=false`. No calendar command ran. Three live start requests had produced only two start/stop events. The SDK's `stopStationLivestream` is a no-op without a connected, streaming channel; the hub nevertheless waited indefinitely for a stop event. The previous generic UI incorrectly instructed the user to close already closed viewers.

The hub now rejects recording-time live admission before creating an owner. After three bounded stops, and only with no viewers or pending start calls anywhere in the hub, it attempts one station transport closure. New live/recording operations remain blocked until the SDK emits transport close; only sessions belonging to that station are cleared. A failed or unconfirmed closure retains quarantine with no retry loop. This proves transport teardown, not an independently acknowledged physical camera stop. Allowlisted error codes distinguish active viewers, stopping/recovering sessions, concurrent recordings, expired references and disconnection; arbitrary upstream errors remain private.

Live reproduction with the updated app: two live requests at `12:22:18 UTC` were closed after 300 ms, producing zero start/stop events and two quarantined sessions. At 10 seconds, after six bounded stop requests, metrics showed one recovery attempt, one completion, zero failures, zero active cameras and zero quarantined sessions. No video frames were received. A subsequent HA Tuinhuis query returned the existing 6 September clip `12:03:45–12:04:42`; its actual browser player decoded 1920×1080 video and advanced to 35.118183 s of 56.930729 s with readyState 4.

Local checks: 24 bridge tests, 50 HA tests (96.02% coverage), 14 browser tests including all three real WebRTC/audio cases, TypeScript builds, Ruff, mypy and hassfest passed. Recovery tests cover pending starts, other viewers, admission during teardown, missing stop events, failed recovery without repeated resets, station-scoped release and waiting for the real SDK close event. Live files were backed up at `/homeassistant/backups/eufy-recordings-20260906T142034`; `ha core check` passed. Dashboard resource version is `0.2.0-recordings2`. No publication occurred.

Final runtime verification after the Tuinhuis playback: one query, one download, one completed MP4, no active recording operation; zero active/quarantined streams. All four HA camera entities were `idle`. Snapshot HTTP responses were 200 for Voordeur (52326 bytes), Achtertuin (15253), Tuinhuis (29092) and Deurbel (81323). The viewer container had only its normal init/Node processes and no FFmpeg process. The browser recording dialog was closed at final inspection; playback completion to the last frame was not measured in this follow-up.
