# Validation record — 2026-09-05

This release candidate was built in a new empty folder. The existing Claude implementation was neither read nor used. Initial validation was local only. A subsequently authorized live installation and physical camera test is recorded in [the live validation report](LIVE_VALIDATION_2026-09-05.md).

## Executed locally

| Check | Result |
|---|---|
| Home Assistant tests | **31 passed**, Home Assistant **2026.9.0**, Python **3.14.6** |
| Python coverage | **96%** statement coverage, 511 statements / 22 not covered; CI requires at least 95% |
| Ruff lint and formatting | Passed |
| Mypy integration checks | Passed, 10 Python source modules |
| Official HA hassfest | **All checks passed; 1 integration, 0 invalid** |
| Bridge TypeScript | Strict compilation passed, Node **24.16.0** |
| Bridge tests | **12 passed**, including actual FFmpeg decoding, simulated SDK media, authenticated local WebSockets, multiple viewers, expiry, late starts and bounded stop retries |
| Card TypeScript | Strict compilation passed; bundled JavaScript generated from TypeScript |
| Browser tests | **8 passed** in Chromium, including snapshot rendering, user tap, Escape, hidden tab, pagehide, removal, disconnect, invalid frames and late subscribe completion |
| Dependency audit | Bridge production dependencies: **0 reported vulnerabilities** at check time |
| Container build | Docker Desktop local Linux ARM64 image built successfully |
| Container startup/shutdown | Passed with **network disabled**: startup, token enforcement, unconfigured state and graceful SIGTERM shutdown |

Hassfest source: official Home Assistant `2026.9.0` tag, commit `dfb5a9e690daaf204b542896e4b595e61a11a401`. The complete integration validation ran without skipped plugins. A passing custom-integration check does not establish core acceptance.

The tests exercise HA's real config flow, entity registry, camera and battery entities, WebSocket command dispatch, permission checks and unload behavior. Eufy behavior is simulated. FFmpeg media tests generate synthetic H.264; the bridge SDK-adapter test runs its actual JPEG path. PNG/JPEG snapshot handling and fragmented/oversized HTTP responses are covered. H.265 selection compiles but real H.265 Eufy footage has not been verified.

## Not executed / not claimed

- Broad physical camera compatibility, 2FA/captcha, motion-triggered snapshot delivery and firmware behavior during failures. Real login, four initial snapshots and one Tuinhuis tap-and-close test passed; see the live report.
- Exact battery drain or a guarantee of physical stop during network, host or power failure.
- HACS installation from GitHub, because the repository has not been published.
- Remote CI runs, iOS/WebKit/Safari behavior, or review/acceptance by HA maintainers. The local Supervisor app subsequently ran successfully on amd64.
- Audio, talkback, recording, WebRTC/HLS or high-frame-rate video. These are outside this version's implemented transport.

## Hardware acceptance before production rollout

Run only after approval of a specific bridge host, dedicated Eufy account, camera and bounded test window. Back up existing live configuration before installing anything.

| Scenario | Evidence required |
|---|---|
| First login and discovery | Intended camera model/firmware appears; secrets absent from logs/diagnostics |
| Dashboard idle for 15 minutes | Snapshot stays visible; **zero start commands** and no active camera P2P stream |
| Eufy motion/image event | New snapshot appears without a dashboard stream start; receive time updates honestly |
| Tap and close | Start command, arriving frames, close command and device/SDK stop confirmation; last live frame retained |
| Close during startup | Any late start is stopped; no hidden stream is retained |
| Two browsers | One upstream start; first close leaves second viewer intact; final close stops camera |
| Tab background/app suspension | No frame acknowledgements while hidden; bridge expires absent viewer within configured bounds |
| Browser/HA crash | Bridge watchdog stops the last viewer independently of HA |
| Bridge crash/network interruption | Determine firmware/P2P teardown duration; do not infer physical stop from software state |
| Two-minute limit | Session stops; card requires another tap to resume |
| Authentication expiry/restart | Reauth works; identity persists; media never silently resumes |
| Home Assistant unload/reload | Tasks and viewer sockets are removed; physical end state verified |

Record start/close/last-frame/stop-confirmation timestamps and actual model/firmware. Quarantined streams and missing stop acknowledgements are failures requiring investigation, not success. Keep the rollout as a release candidate until this matrix passes on the intended devices.
