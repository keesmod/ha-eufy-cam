# Changelog

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
