# Changelog

## 0.8.16 - 2026-09-15

- Handle recording playback client disconnects without logging a traceback when
  the player closes or seeks. Header, chunk and final writes release their reader
  ownership, preserving later range requests and the existing session lifetime.
  Other I/O errors, timeouts and task cancellation still propagate. Addresses #69.

- Preserve `device_request_timeout` and future machine error codes in normal
  startup logs and Home Assistant diagnostic downloads without maintaining a
  separate list of accepted codes in each component. Both validate the complete
  code format and length. Raw error messages and unknown report fields remain
  excluded.
- Correct the HAOS app setup URL to `http://127.0.0.1:8063` in its README.

Update both the HACS integration and HAOS bridge app to 0.8.16. The bundled
client remains 0.12.2. Older integrations may omit newly preserved codes in the
download, so use the updated bridge's startup logs until both are updated.
Back up both components before installation. Restore their previous versions
and preserve app data, credentials and identities to roll back.

This improves diagnosis of issue #66. It does not fix the reported HomeBase
connection timeout or add T84A1 standalone media support. Software tests exercise
the diagnostic failure/download paths and real HTTP playback disconnects, with
reader and storage cleanup. Device commands and encoding remain unchanged.
Reporter verification of closing playback on their installation remains pending.

## 0.8.14 - 2026-09-14

- Replace whole-recording RAM buffers with private temporary files and bounded
  file transfer. Valid H.264 output above 32 MiB can reach both recording cards.
  Native H.264 and HEVC remuxing preserves AAC, duration and byte-range seeking.
- Remove the recording-wide NVIDIA failure latch. One failed conversion may use
  software once, after confirmed process cleanup. The next request tries its
  configured encoder again. Storage limits and storage errors are not GPU faults.
- Apply an aggregate HA recording storage allowance, including unfinished
  preparation and readers closing after session expiry. Interrupted preparation,
  transfer and playback release their owned resources. Both cards explain when
  recording storage is unavailable.
- Keep issue #57 open in Validation. Synthetic FFmpeg and browser checks do not
  replace repeat testing of the failing recording on the reporter's T600.

Includes integration 0.8.15, with unchanged client 0.12.2. Back up both components
before installing. Restore the previous integration and bridge together to roll
back, preserving credentials and identities.

## 0.8.13 - 2026-09-14

- Fix premature NVIDIA recording fallback by tracking encoded-frame progress.
  Healthy conversion can pass ten seconds while staying within the existing
  45-second total deadline. A ten-second stall still triggers bounded cleanup
  and one software attempt on the already downloaded recording.
- Always report bounded hardware failure categories, frame count, timeout scope
  and exit status. With `EUFY_DIAGNOSTICS=true`, an unclassified failure also
  includes a short scrubbed excerpt of the original FFmpeg error. Common secret,
  address and path patterns are removed. Review excerpts before sharing them.
- Preserve Auto / Native / H.264, media status, AAC audio, cancellation and
  the circuit breaker. Native remux, audio and seeking have reporter confirmation.
  The intermittent T600 failure still needs a repeat test with this correction.

Accompanies integration/repository 0.8.14. Back up the bridge before updating.
Restore its previous files to roll back while retaining its data and token.

## 0.8.12 - Internal candidate

- Fix premature NVIDIA recording fallback. Track encoded-frame progress instead
  of requiring the complete MP4 within ten seconds. Keep the 45-second total
  conversion deadline, ten-second stall timeout, single software fallback and
  confirmed process cleanup.
- Always log a bounded hardware failure warning with timeout scope, frame count,
  exit status and fixed FFmpeg error categories. Successful processing and
  circuit-breaker observations remain opt-in. Never emit raw FFmpeg output.
- Issue #57 remains in Validation for the reporter's intermittent T600 failure.
  A paced CPU FFmpeg regression reproduces the cutoff and verifies this fix.
  It does not establish the cause of every T600 failure.

Accompanies integration/repository 0.8.13. Back up the existing bridge before
updating. Restore its previous files to roll back while keeping its data and token.

## 0.8.11 - 2026-09-14

- Add bounded live audio format, continuity and processing observations, linked
  to a later browser measurement in Home Assistant diagnostics. Include ADTS
  header facts, buffered audio, stream cleanup and negotiated audio details
  without storing audio payloads. Issue #10 awaits T8134 hardware validation.
- Resolve recording Auto mode after reading the source codec. With configured
  NVIDIA acceleration, HEVC converts to H.264. Otherwise browser compatibility
  determines the format. Existing H.264 recordings and explicit Native remux.
- Return bounded per-request processing metadata to integration/card 0.8.12.
  Retain existing timeouts, cancellation, software fallback and process cleanup.
- After release, the reporter confirmed the Auto/UI NVIDIA route, playback
  and GPU cleanup on T600/T8030/T8425, plus a Live regression check. The reporter later confirmed Native, audio and seeking, but also reported
  intermittent NVIDIA fallback. An H.264 source remains untested by the reporter.
  See the [hardware validation record](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/NVIDIA.md#auto-playback-validation-on-2026-09-14).
  Back up the bridge and integration files before updating. Restore the previous
  files to roll back without changing data, token, credentials or entity identities.

## 0.8.10 - Unreleased

- Remove the software live bitrate and VBV limit from the previous candidate.
  Restore the original software encoder defaults while retaining diagnostics
  and existing NVIDIA settings. The cap was not supported by evidence of the
  reporter's root cause and its image-quality cost was not measured.
- Issue #10 remains open. Integration/card 0.8.11 retains playback diagnostics.
  Back up the bridge files and restore them to roll back, keeping its data/token.

## 0.8.9 - Withdrawn candidate

- Bound software live video to a 4 Mbit/s target/maxrate and 1 Mbit VBV buffer,
  matching the existing NVIDIA output budget. Preserve H.264/H.265 input,
  AAC conversion, ownership and cleanup. Complex scenes may lose detail.
- This is a robustness candidate for issue #10, not confirmed T8134 acceptance.
  Integration/card 0.8.10 carries the additional playback counters. Restore the
  previous bridge package to roll back while keeping the existing data/token.

## 0.8.8 - 2026-09-13

- Add separate Docker opt-in `EUFY_RECORDING_ACCELERATION=nvidia` for required
  HEVC-to-H.264 recording conversion. Keep native HEVC and H.264 remuxing and
  copied AAC audio. Software remains the default, including HAOS.
- Bound GPU conversion and retry once with software on the same downloaded
  bytes after confirmed process cleanup. Preserve cancellation, output limits
  and the overall deadline. Block conversion after unconfirmed cleanup.
- Add anonymous recording-route diagnostics and document the reported T600 live
  validation separately from pending NVIDIA recording validation.

Update integration and bridge when this version is published. Back up the
previous installation and preserve its token/data. Disable the new option and
recreate the container to return to software. Actual NVIDIA recording operation
requires a compatible GPU test before claiming hardware support.

## 0.8.7 - 2026-09-13

- Add experimental Docker opt-in NVIDIA live transcoding with
  `EUFY_LIVE_ACCELERATION=nvidia`. Software remains the default, including HAOS.
- Bound hardware startup to five seconds and 8 MiB of initial A/V. On a startup
  error, retry once with software inside the same camera session. Disable GPU
  attempts until bridge restart after a hardware failure. A later encoder failure
  ends the view safely, and the next view uses software.
- Add anonymous active-encoder and fallback events to opt-in live diagnostics.
  Document GPU exposure, driver capabilities and recovery in the
  [NVIDIA guide](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/NVIDIA.md).

Update both integration and bridge when this version is published. Preserve the
existing token and bridge data. Back up the previous matching installation for
rollback. Omit the acceleration setting to retain software operation.

No NVIDIA GPU was available for validation. T600 support, NVDEC/NVENC operation,
A/V synchronisation, image quality and performance remain unvalidated in issue
#49. This feature does not establish a startup-latency fix for issue #48. The
existing Python dependency limitation in issue #30 remains unchanged.

## 0.8.6 - 2026-09-13

### Live startup

- Start WebRTC signaling when the live encoder has actual audio metadata,
  without waiting for the JPEG fallback decoder's first frame.
- Bound FFmpeg analysis for both video and AAC inputs and the JPEG decoder.
  Keep analyzed packets so the initial keyframe remains available.
- Retain at most 1 MB of initial encoded output for at most two seconds so
  signaling can attach readers without losing the first video keyframe.
  Viewer revocation, slow-reader limits, fallback and camera stop ownership
  remain enforced.

### Upgrade and recovery

Update the integration and bridge together to 0.8.6 when available. This is a
software startup fix. The exact T8425/T8030 Docker startup time in issue #48
still needs an observation on that installation. No networking change is
required. Back up the previous integration, bridge and private bridge data
before updating. Restore that matching backup to roll back.

## 0.8.5 - 2026-09-11

### Logging improvements for diagnostics

This release includes all diagnostic changes since 0.8.1. Versions 0.8.2 through
0.8.4 were not published as GitHub releases.

- Include discovery rejection reasons and bounded received model/type pairs in
  normal bridge logs so missing devices can be investigated without debug mode.
- Collect one complete startup report with actual bridge/library/Node versions,
  authentication and inventory results, model/firmware details, anonymous device
  and HomeBase references, migration counts and push startup. Preserve available
  evidence when setup fails and distinguish missing observations from failures.
- Show explicit HomeBase/owner connection states, distinguish connection from
  state-refresh failures and record timestamped connection loss and recovery.
  Suppress unchanged repeated logs.
- Add an authenticated support download containing the complete latest discovery
  and up to 100 recent diagnostic events. Include it in Home Assistant's standard
  diagnostic download with actual HA/integration versions, also for failed setup.
- Bundle the verified eufy-mega-client 0.12.2 release for bounded received firmware
  and parent context on rejected devices. Independently filter shared reports in
  the bridge and HA integration to exclude credentials and device identities.
- Document collection steps, required versions, privacy checks and report field
  meanings. Link the guide from support pages and both issue forms.

### Upgrade and recovery

Update the Eufy Viewer integration to 0.8.5 through HACS and restart Home
Assistant. Separately update the bridge app or Docker installation to 0.8.5.
The bridge includes library 0.12.2, which needs no manual installation.

Download diagnostics from the integration's menu after the bridge has completed
one startup discovery. Alternatively, collect the complete `Eufy discovery:`
and `Eufy backend:` lines from the bridge's normal Logs tab. Debug is not needed
and bridge logs remain usable with an older integration. Review the file before
sharing it. See the [diagnostic collection guide](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/DISCOVERY_DIAGNOSTICS.md).

Existing Mega installations need no new login or migration because of this
update. Installations older than 0.8.0 must still follow the
[Mega migration guide](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/MEGA_MIGRATION.md).
Keep a backup of the previous integration, bridge and private bridge data.
For rollback, restore that matching backup through the normal installation or
Supervisor restore path.

### Scope and known limitations

Device admission, camera commands and media behavior are unchanged. This release
adds evidence for [issue #40](https://github.com/keesmod/ha-eufy-cam/issues/40),
not a confirmed fix for the reporter's missing C30 or floodlight camera.
The C30 model is already recognized by the library. The reporter's actual
model/type, topology and discovery result are still needed to locate the failure.
No additional hardware or media support is claimed.

The existing Home Assistant Python dependency limitation tracked in
[issue #30](https://github.com/keesmod/ha-eufy-cam/issues/30) remains unresolved.
The affected cryptography dependency and its alert are unchanged. This release
does not fix that vulnerability or claim a clean Python dependency audit.

## 0.8.1 - 2026-09-11

- Upgrade the camera bridge to the verified eufy-mega-client 0.12.0 release.
- Include its additional exact camera profiles and explicit unsupported-connection
  reasons. See the [library release scope](https://github.com/keesmod/eufy-mega-client/blob/v0.12.0/docs/RELEASE_0_12_0.md).
- Preserve camera identities, sessions and existing media capability checks.
  New profiles have software coverage, not a whole-family hardware guarantee.
- Retain bridge 0.8.0 and its private data backup for rollback. Existing 0.8.0
  installations need no new login or session migration. Older installations
  still follow the documented Mega migration steps.

## 0.8.0 - Candidate, not published

**BREAKING CHANGE: Mega is now the only camera backend.** Existing users must
update the HA integration before the bridge. The integration automatically saves
and transfers the device list. Legacy users sign in to Mega again. Old sessions,
credentials, entity IDs and backups are preserved. Missing devices pause migration.

- Remove the deprecated backend and direct eufy-security-client dependency.
- Handle old HA app backend settings automatically. Standalone Docker users
  remove EUFY_BACKEND=legacy when updating the container.
- Keep the previous bridge release and data backup for rollback.

Follow the [four upgrade steps](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/MEGA_MIGRATION.md). New-build hardware acceptance and the
Python security gate remain open in camera #31 and #30. Do not treat this
unpublished candidate as an accepted production release.

## 0.7.1 - 2026-09-11

- Automatically switch failed WebRTC playback to live JPEG over the existing
  authenticated Home Assistant connection. The player displays "Live video
  without sound" and hides the audio control after switching.
- Reuse the exact bridge socket and camera owner. Revoke only that viewer's
  WebRTC media grant. Do not issue another camera start, reconnect, extend the
  original lease or reset the absolute viewing limit. Ignore late WebRTC ACKs.
- Log fixed fallback reasons in HA and opt-in bridge diagnostics, without
  exposing upstream errors, media URLs or device identifiers.

Update the bridge and HACS integration together and restart HA. Keep the
existing account, token and data. WebRTC still provides audio when it works.
JPEG fallback has no audio and requires a working HA connection. It cannot fix
an unavailable camera. T8134 live-audio validation remains pending. Preserve a
backup and version 0.6.4 for rollback.

## 0.7.0 - Included in 0.7.1

- Carry camera snapshot, live and recording software capabilities into HA and
  both cards. Mark available operations experimental and show unsupported reasons.
- Reject unsupported media before bridge or HA requests can start a stream or
  recording operation. Preserve optional-field compatibility and existing IDs.
- Keep standalone cameras separate from HomeBase alarm entities. A failed owner
  does not prevent independent camera inventory setup.
- Pin the verified published client 0.10.0 package with SHA512 integrity. No new hardware
  support is claimed. Camera migration, release and legacy retirement remain open.
- No session or entity migration is required. Keep the previous integration,
  bridge package and private data for rollback. This version is not published.

## 0.6.4 - 2026-09-10

- Add opt-in live-stream diagnostics with per-attempt timing, incoming media,
  encoder output, playback acknowledgements and timeout categories.
- Keep diagnostics off by default. Emit fixed categories rather than raw
  encoder output, credentials, camera identifiers or media URLs. Limit repeated
  events to one per category per attempt.

Enable `diagnostics: true` in the bridge app configuration and restart the app.
For Docker, set `EUFY_DIAGNOSTICS=true` and recreate the container. Reproduce
one failed live view, save the diagnostic lines, then disable the option and
restart. This is a diagnostic aid. T8134 live playback remains unconfirmed.
Keep the existing account, token and data. Keep a backup and version 0.6.3 for
rollback. No camera timeout or ownership policy is changed.

## 0.6.3 - 2026-09-10

- Keep video-only live streams usable by forwarding the actual audio capability
  to Home Assistant and omitting go2rtc audio conversion when no supported audio
  track is present. Preserve audio conversion for audio-capable streams and
  compatibility with older bridges.
- Allow a corrected account login to replace automatic session-restore retries.
  Wait for any in-flight initialization to finish before creating another SDK
  owner. No session deletion or integration recreation is required.
- Add regression coverage for video-only and audio-capable negotiation, invalid
  metadata, recovery during backoff and serialized in-flight recovery.

Update the bridge and HACS integration together to 0.6.3, then
restart Home Assistant. Preserve the existing token, account and data. Keep the
previous version and a private backup for rollback. These fixes address code
paths implicated by issue #10. T8134 live playback still needs reporter
validation. Person event entities retain the last event, not a motion/idle state.

## 0.6.2 — 2026-09-10

- Update the independent Mega client to 0.1.1. Include T8142 eufyCam S220 / 2C
  Pro and T8134 SoloCam S220 paired with T8030 HomeBase 3 in camera discovery.
  Previously the model filter silently skipped these cameras, as reported in #10.
- Preserve existing camera protocol commands and the HomeBase 3 parent check.
  Standalone SoloCam operation is not included. Legacy behavior is unchanged.
- Automated discovery and protocol tests pass; S220 hardware validation of
  snapshots, live video/audio, recordings and real events is still pending.

Update the bridge to **0.6.2**, then the HACS integration to **0.6.2** and restart
Home Assistant. Keep the existing token, data and integration entry. This fix
applies to `backend: mega`; upgrading does not change your selected backend.
Report your backend, model, camera/HomeBase firmware and test results in issue
#10. Keep a backup and bridge/integration 0.6.1 available for rollback.

## 0.6.1 — 2026-09-10

- Fix silent recordings in Safari and the Home Assistant iOS/macOS apps. The MP4
  header now includes the AAC decoder configuration before playback starts.
- Preserve encoded audio and native video without extra transcoding. The fix
  applies to H.264, native H.265 and H.264 compatibility playback on both backends.
- Add regression checks for AAC profile, channel count and decoder configuration.

Update the bridge to **0.6.1**, then the HACS integration. Restart Home Assistant
and close and reopen any prepared recording. Existing HomeBase recordings need
no repair or camera setting change. Keep the existing data and bridge token.

## 0.5.1 — 2026-09-09

- Preserve native H.265 recordings as Apple-compatible hvc1 MP4 when requested
  by a compatible player. Copy AAC audio without re-encoding.
- Allow up to 45 seconds for H.264 compatibility conversion within the existing
  operation and media size limits.
- Write one complete MP4 fragment so native Apple players can play the full clip.

Update this bridge first, then the HACS integration to **0.5.1**. Restart Home
Assistant and refresh the dashboard in each app/browser. Keep existing app data
and credentials. The updated cards select the supported codec and handle one
H.264 fallback for native codec failures before or during playback.

## 0.4.1 — 2026-09-07

- Report session restoration as connecting from the start, so Home Assistant can
  wait for startup instead of requiring another login.
- Bound the Eufy country lookup to ten seconds and retry temporary initialization
  failures with backoff. Shutdown cancels pending retries; account verification
  and CAPTCHA challenges are not retried automatically.
- Verify automatic recovery after two complete HA OS VM reboots, with the same
  four cameras and HomeBase and no automatically started streams.

Update the HACS integration to **0.4.1** too, restart Home Assistant and reload the
dashboard. Keep the existing app data and token. The integration and bundled card
also fix the waiting state and stale unavailable messages.

## 0.3.0 — 2026-09-06

- New Eufy Events card: all-camera timeline, camera/date filters, HomeBase recording-day calendar and previous/next playback.
- Existing-event thumbnails, 12 visual results per page and bounded browser image caching; no live capture or cloud polling.
- Expand the SDK's 100-row day limit using the hardware-verified count field. Reject ambiguous/inconsistent histories rather than silently truncate them.
- Batch cameras by HomeBase; retain entity permissions, private file paths, expiring references and cancellation. Calendar markers require access to the full bridge inventory.
- Verified 95 camera recordings from a 105-row day and played an existing clip beyond the former first-100 cutoff in HA.
- Preserve WebRTC/audio, viewer leases and bounded stop recovery. Physical iPhone suspension/audio and other HomeBase firmware remain unverified.

Update the bridge app and HACS integration to 0.3.0, restart HA and change the existing dashboard resource to `?v=0.3.0`. Add **Eufy Events** through the card picker. HACS updates the integration/cards; the bridge updates separately through the HA App Store.

## 0.2.0 — 2026-09-06

- WebRTC video and listen-only audio through HA-managed go2rtc.
- On-demand listing and playback of existing HomeBase recordings by camera and date.
- Bounded recovery for live sessions that never emit a stop confirmation, without background polling or automatic stream restarts.
- Compatibility fix for successful Eufy profile responses that otherwise leave camera discovery empty after restart.

Update the HACS integration to 0.2.0 too, restart HA and refresh the bundled card resource. Existing app token and private data are retained. HomeBase 3 recording playback and four camera snapshots were validated; see the repository README for limits.

## 0.1.0 — 2026-09-05

Initial public release for HACS custom-repository installation.

- UI configuration, account verification/reauthentication, battery sensors and redacted diagnostics.
- Bundled visual-editor camera card: snapshots at rest, live video only after a tap.
- Shared viewers, immediate stop on close, independent bridge watchdog and a two-minute session cap.
- Home Assistant OS bridge app and standalone Docker build, with pinned Node dependencies.
- English/Dutch translations; Home Assistant 2026.9.0 baseline.
- Four cameras reported working in the first installation; instrumented start/close confirmation for one camera.

Live video is JPEG-based, up to 8 fps / 960 pixels wide, without audio. iOS suspension, power-loss behavior, long-term battery impact and broad model compatibility remain unverified. See the validation record.
