# Local installation and bounded physical test

User-authorized deployment on Home Assistant OS, Core 2026.9.0 / Python 3.14.6 / amd64. Existing Eufy credentials were reused entirely on the host; no credentials were copied into this repository. The existing bridge was briefly paused for the login and camera test, then restarted and its integration reloaded. The alarm entity subsequently returned to `armed_home`; no alarm-mode service was called.

## Installed surfaces

- Integration: `/homeassistant/custom_components/eufy_viewer`, version 0.1.0.
- Local Supervisor app: `local_eufy_viewer_bridge`, built from `ha_app` and canonical `bridge` sources. Internal port only; no host port mapping.
- Automatic startup enabled and read back as `auto` after explicit user approval; the existing bridge also retained `auto` startup.
- Bundled module resource: `/eufy_viewer/eufy-viewer-card.js?v=0.1.0`.
- Separate UI-managed dashboard: `/eufy-viewer/0`, four cards for Tuinhuis, Achtertuin, Deurbel and Voordeur. Existing dashboard and alarm rules unchanged.
- A pre-installation backup completed successfully. Private host paths and backup identifiers are retained only in the installation record.

The real UI configuration flow completed account login without a verification challenge. All four cameras received initial snapshots at approximately 21:20:58 UTC. Camera entities were idle. Opening the dashboard and the visual card editor left all start/stop/frame counters at zero.

## Tuinhuis live test (UTC)

| Observation | Evidence |
|---|---|
| Tap requested start | 21:27:36.159 |
| SDK camera start event | 21:27:38.851; about 2.7 seconds after request |
| Live image in browser | Decoded image, complete, natural dimensions 960 × 540 |
| Last live frame retained as snapshot | Card receive time updated to 21:27:59 |
| Close requested stop | 21:28:00.041 |
| SDK stop event | 21:28:00.043 |
| Counters after close | 1 start, 1 stop, 1 started event, 1 stopped event, 174 decoded frames |
| Stable post-close state | 0 active cameras, 0 quarantined cameras; frame count remained 174 during subsequent checks |

The test used the Tuinhuis T8160 camera via HomeBase 3. This demonstrates normal start/close behavior and a device-protocol stop acknowledgement, not an electrical battery measurement or a guarantee under network/power failure. The installer instrumented one camera. Subsequently the owner reported that all four cameras worked in their own tests; individual timing and stop counters were not recorded for those additional sessions. Multi-browser, forced disconnection, iOS suspension, two-minute expiry and power-loss tests remain hardware acceptance work; corresponding simulated tests do not replace those physical checks.

After restoration both `eufy_security` and `eufy_viewer` entries were loaded. Final `ha core check` passed. Existing and new bridges run side by side for this local evaluation; long-term shared-account behavior has not been established. The hardware test was a manual local installation; it is separate from the subsequent GitHub/HACS release validation.
