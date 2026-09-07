# Startup recovery validation

The clean HA OS installation of public release 0.4.0 failed to recover after a full VM reboot. Its bridge HTTP server was running while SDK initialization was still pending, but advertised `unconfigured`. Home Assistant treated every state other than `connected` as an authentication failure. Restarting the bridge and manually reloading the integration restored the same saved account and entity identities.

## Patch

- Advertise `connecting` throughout saved-session restoration, including SDK initialization. A fresh bridge without saved credentials still becomes `unconfigured`.
- Give the SDK's country-domain lookup a 10-second abortable request timeout. The original lookup in eufy-security-client 4.1.1-1 had no timeout. Cancel the request itself so retries do not accumulate unfinished SDK instances.
- Retry thrown restoration failures after 5 seconds, backing off to at most one attempt per minute. Returned authentication errors, CAPTCHA and verification challenges remain terminal and are not retried automatically. Shutdown cancels a pending retry, and interactive login cannot overlap restoration.
- Have Home Assistant retry setup during `connecting`, and keep its existing push subscription waiting through that state without opening a reauthentication flow. Token rejection and other terminal account states retain the authentication flow. This follows Home Assistant's [setup-failure handling](https://developers.home-assistant.io/docs/integration_setup_failures/).
- Clear the card's stale unavailable message when the camera becomes available again. Ordinary updates preserve messages about a stream that ended.

The app build context is regenerated from the canonical bridge source. The patch is included in 0.4.1. The installation guidance from commit `a0fad81` is retained, with the release versions and startup recovery instructions updated.

## Checks

- Python: 63 tests passed, 96.08% integration coverage, Ruff and mypy passed.
- Bridge: 43 tests passed on Node 24, including delayed initialization, retry, request cancellation, shutdown, real media conversion and refusal to replace a session while a viewer is active.
- Cards, recordings and events: 16 browser tests passed, including clearing the restored camera's unavailable message without opening a stream.
- TypeScript builds passed. The complete HA app Docker image built successfully from the updated source.

## Live test

The retained clean Proxmox HA OS VM was used, with HA OS 18.2, Core 2026.9.1 and Supervisor 2026.08.0. Only that test VM received this patch. The original image and integration files were backed up locally on the VM before replacement.

Two complete VM reboots recovered automatically. All ten entity identities stayed unchanged, all ten entities became available, and no Eufy reauthentication flow appeared. The four cameras stayed idle. The bridge reported four cameras, one connected HomeBase and zero automatically started streams. SHA-256 checks confirmed that the five backend files surviving both reboots matched the final local patch.

After the second reboot, Tuinhuis live video decoded at 1920×1080 with `readyState=4`; playback time advanced from 1.909 to 11.582 seconds. Closing the viewer produced a stop request at 14:40:24.378 UTC and a device stop event at 14:40:24.380 UTC. Across the two short live attempts, the bridge recorded two starts and two stops, 321 frames, zero active streams and zero quarantined streams.

A separate stop/start of only the bridge also restored all ten entities through the existing Home Assistant session, without manual reload or reauthentication.

The final card was checked through another bridge stop/start in the browser. All four cards showed unavailable with disabled controls during the outage. After reconnection, all four status messages became empty and the controls re-enabled without refreshing the page. The test deployment also replaced the previously installed `.js.gz` file; raw and gzip responses were verified against the final generated JavaScript. Updating only the raw file had initially left browsers running the previous card.

These checks cover the reported startup failure on this HomeBase 3 installation. They do not establish compatibility with every Eufy model or recovery from every possible long-running network outage. Synthetic tests cover a failed initialization and an aborted country lookup; no real credentials were intentionally invalidated.

The test VM was shut down and retained with the patch and rollback copies. Final production checks confirmed its original bridge was connected, with four cameras, a connected HomeBase and zero active streams. Production did not receive the patch during this validation.
