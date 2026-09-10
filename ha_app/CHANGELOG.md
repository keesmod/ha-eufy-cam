# Changelog

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
