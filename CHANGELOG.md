# Changelog

## Unreleased

- Register the bundled dashboard cards automatically when the integration loads.
  Update the existing resource URL to the installed integration version and
  remove duplicate entries for the bundled card. Keep unrelated resources.
- Leave YAML-managed resources unchanged and log the required module URL when
  manual configuration is needed. Registration errors do not block the cameras.

## 0.4.1 — 2026-09-07

- Restore the saved Eufy session automatically after a Home Assistant or bridge
  restart. Home Assistant now waits for a connecting bridge instead of asking
  users to sign in again.
- Cancel the SDK's country lookup after ten seconds and retry temporary
  initialization failures with backoff. Keep genuine account verification and
  CAPTCHA requests visible, and cancel pending retries during shutdown.
- Clear stale "Camera unavailable" messages when the camera reconnects. Live
  viewing still requires a tap and never resumes automatically after recovery.
- Verify two complete HA OS VM reboots, all ten retained entity identities,
  1920×1080 live playback and device-confirmed stream shutdown. See
  [startup recovery validation](docs/STARTUP_RECOVERY_2026-09-07.md).

Update **both the bridge and integration to 0.4.1**, restart Home Assistant, then
reload the dashboard. Update the existing card resource to
`/eufy_viewer/eufy-viewer-card.js?v=0.4.1` if needed. Keep the bridge data and token;
no new Eufy account setup is required. Actual expired credentials or verification
challenges still require the normal reauthentication flow.

## 0.4.0 — 2026-09-07

- Add HomeBase alarm and Guard Mode entities to the existing camera integration
  and bridge, including Home/Away, Disarmed, custom profiles, Schedule and Geofencing.
- Report actual station state, entry delay, exit delay and triggered alarms. Wait
  for matching device acknowledgements before completing mode commands; reject
  unavailable stations, unsupported modes, concurrent commands and uncertain retries.
- Document migration from another Eufy integration while retaining entity-based
  automation and dashboard references.
- Validate both HA command routes on HomeBase 3 with the previous bridge stopped;
  four camera snapshots remain available. 61 HA tests and 37 bridge tests passed.

Update **both the bridge and integration to 0.4.0**, then restart HA. Existing
Viewer configuration and camera IDs are retained. Manual siren triggering is not
exposed. See [migration and validation](docs/ALARM_MIGRATION_2026-09-06.md).

## 0.3.1 — 2026-09-06

- Remove the snapshot receive date/time and “Capture time unknown” line from camera cards in English and Dutch.
- Keep snapshot receive timestamps in entity attributes and use them to refresh newly received images.
- Update the README to describe the simplified card.

Update the HACS integration to 0.3.1, restart HA and reload the dashboard. If the old card remains cached, edit the existing resource to `?v=0.3.1`. The bridge remains at 0.3.0; no bridge update is required.

## 0.3.0 — 2026-09-06

- New Eufy Events card: all-camera timeline, camera/date filters, HomeBase recording-day calendar and previous/next playback.
- Existing-event thumbnails, 12 visual results per page and bounded browser image caching; no live capture or cloud polling.
- Expand the SDK's 100-row day limit using the hardware-verified count field. Reject ambiguous/inconsistent histories rather than silently truncate them.
- Batch cameras by HomeBase; retain entity permissions, private file paths, expiring references and cancellation. Calendar markers require access to the full bridge inventory.
- Verified 95 camera recordings from a 105-row day and played an existing clip beyond the former first-100 cutoff in HA.
- Preserve WebRTC/audio, viewer leases and bounded stop recovery. Physical iPhone suspension/audio and other HomeBase firmware remain unverified.

Update the bridge app and HACS integration to 0.3.0, restart HA and change the existing dashboard resource to `?v=0.3.0`. Add **Eufy Events** through the card picker. HACS updates the integration/cards; the bridge updates separately through the HA App Store.

## 0.2.0 — 2026-09-06

- Browse existing HomeBase recordings by date from each camera card and play a selected clip in HA.
- Use verified calendar query 10006; camera-scoped, expiring references prevent arbitrary path downloads.
- Authenticated HA proxy with entity permissions, bounded in-memory MP4 preparation and cancellation on navigation.
- Preserve the unpublished WebRTC/audio functionality and idle battery safeguards.
- Recover idle sessions stranded by a missing live-stop event through bounded HomeBase transport closure; distinguish active viewers, pending stops and recording failures in the UI.

- On-demand WebRTC H.264 video and listen-only Opus audio through HA-managed go2rtc.
- Muted autoplay with an explicit sound toggle; native camera dialogs remain snapshot-only.
- Ephemeral media grants cannot start or renew a camera; browser-painted frames renew the existing local viewer lease.
- Real Chromium, FFmpeg and go2rtc tests cover audio/video, close, navigation and frozen playback.
- Live validation confirmed four camera entities/snapshots, 1920×1080 WebRTC video and existing HomeBase 3 recording playback in HA.
- Requires HA go2rtc and browser-to-HA media connectivity. Wider model coverage, physical audio output, iOS suspension, remote routes and complete history pagination remain unverified.

Upgrade both the bridge and HACS integration, restart HA, update the existing card resource to `?v=0.2.0` and reload the dashboard. See the README for the upgrade steps.

## 0.1.0 — 2026-09-05

Initial public release for HACS custom-repository installation.

- UI configuration, account verification/reauthentication, battery sensors and redacted diagnostics.
- Bundled visual-editor camera card: snapshots at rest, live video only after a tap.
- Shared viewers, immediate stop on close, independent bridge watchdog and a two-minute session cap.
- Home Assistant OS bridge app and standalone Docker build, with pinned Node dependencies.
- English/Dutch translations; Home Assistant 2026.9.0 baseline.
- Four cameras reported working in the first installation; instrumented start/close confirmation for one camera.

Live video is JPEG-based, up to 8 fps / 960 pixels wide, without audio. iOS suspension, power-loss behavior, long-term battery impact and broad model compatibility remain unverified. See the validation record.
