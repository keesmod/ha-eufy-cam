# Playback, recovery and technical details

Return to the [quick start](../README.md). These details explain playback limits,
network requirements and diagnostic behavior. For installation problems, see
the [installation guide](INSTALLATION.md#troubleshooting).

## Events timeline

**Eufy Events** is a second card bundled in the same dashboard resource. It shows all your Eufy Viewer cameras in one timeline, with a camera filter, date selection, a calendar marking HomeBase recording days, existing-event previews, and previous/next playback. Add **Eufy Events** in the card picker, all accessible Viewer cameras are selected by default. Optional card configuration supports `entities` and `title`.

Requests begin with an explicit action. The card fetches at most 12 stored previews per displayed page, keeps at most 24 previews in browser memory and cancels work when hidden, disconnected or removed. Previews use the thumbnail path from the existing event, no snapshot capture or live recording is used. Calendar marks apply to all cameras on the HomeBase, and are only available to a user authorized for the entire bridge camera inventory. Filtering the timeline to a camera does not change the calendar's scope.

On the tested HB3, increasing the SDK's existing query limit retrieved 105 database rows for 5 September, including events beyond the original first 100. These contained 95 files from the four known cameras and 10 zero-byte rows outside that camera inventory. The day list grows through bounded requests instead of silently stopping at 100. If the HomeBase returns an unchanged full prefix, inconsistent IDs or reaches the safety ceiling, the UI reports that completeness could not be confirmed. Firmware outside the tested device may behave differently. See [0.3 validation](VALIDATION_0.3.md).

## What it does

- UI-only integration setup, reauthentication, endpoint reconfiguration, verification-code and captcha flows.
- Camera entities show Eufy's latest received snapshot, image requests never start a camera.
- A visual-editor Lovelace card starts live video after a click or keyboard activation. Supported clients use WebRTC with optional listen-only audio, clients without WebRTC use JPEG video.
- Choose **Recordings → Date → Show recordings** to play an existing HomeBase event in Home Assistant. This reads stored events, it does not record a new live stream.
- Closing the dialog, leaving the dashboard, hiding the tab, disconnecting or failing to process frames releases the viewer.
- Multiple viewers of a camera share one upstream stream. Closing one viewer does not interrupt the others.
- The bridge independently expires silent viewers and stops the camera after the last viewer leaves.
- HomeBase alarm and Guard Mode entities with station-confirmed commands and push status.
- Push discovery and battery sensors, stable registry IDs, clean unload, English/Dutch UI and allowlisted diagnostics.
- No cloud polling timer: the pinned Eufy client is configured with `pollingIntervalMinutes: 0`. Login, push-triggered refreshes, token renewal and the library's local station communication still occur.

### Honest snapshot and streaming limits

A sleeping battery camera cannot provide a newly captured photo on every dashboard visit without waking. Idle views show the **latest received snapshot**. The receive time remains available in the camera entity attributes, the card omits snapshot timestamps. If none exists, the card says so. New Eufy image events replace it. The last decoded live frame becomes the snapshot when viewing ends.

On supported clients, live viewing uses **WebRTC video with listen-only audio** through Home Assistant's managed go2rtc. The bridge converts H.264/H.265 to browser-compatible H.264, up to **1920 pixels wide and 30 fps**, limited by the camera's source frame rate. Supported camera audio is converted to Opus. Playback starts muted, tap **Sound on / Geluid aan** to listen. A camera that supplies no supported audio remains video-only.

A normal HA camera card/more-info dialog shows snapshots only. Use the companion card for live video. Talkback, new live recordings, HLS, PTZ and permanent RTSP are not provided. Use **Recordings** on a companion card to choose a date and play an existing HomeBase recording. The date and times are HomeBase-local. Clips are downloaded on demand into bounded memory, then played as MP4, close or navigation cancels preparation. No Eufy Cloud subscription is required for these local files.

Clients without WebRTC or video-frame callback support, including the Home Assistant macOS app, automatically use JPEG live video at up to **8 fps / 960 pixels**, without audio. The same explicit-start and stream cleanup rules apply. Use Safari on the Mac for WebRTC with live audio. If an established WebRTC attempt fails, the viewer can switch once to video-only JPEG. See [automatic fallback](#automatic-live-video-fallback).

WebRTC requires Home Assistant's **go2rtc integration** to be loaded and the browser to have a media route to HA (the managed service uses TCP port **18555**). A dashboard accessible through an HTTPS reverse proxy alone does not establish this media route. Routed LAN/VPN access can provide it, no public STUN/TURN service is configured by this integration. Do not expose the bridge API to solve WebRTC connectivity. See [0.2 validation](VALIDATION_0.2.md).

Sessions have a **two-minute absolute limit**, continuing requires another tap. Normal close immediately issues stop. After a network partition or frozen page the bridge expires a viewer within **10 seconds**, plus its 250 ms watchdog tick. Startup without frames expires after 20 seconds. A bridge or host hard failure cannot deliver a stop command, camera firmware/P2P behavior in that case must be verified on the intended hardware. No software can promise instantaneous physical stop across a dead network.

## Recovery and maintenance

- Use the integration's **Reconfigure** action when the bridge address or token changes. Its stable bridge ID must match.
- Complete the HA **Reauthenticate** flow if the Eufy account or bridge token requires attention.
- During startup, Home Assistant waits for the bridge to restore its saved Eufy session. Temporary network failures during initialization are retried automatically, they do not require entering your credentials again.
- On bridge connection loss, entities become unavailable and all live viewers end. The local push socket reconnects with bounded backoff, media never automatically restarts.
- If a camera does not confirm stopping, the bridge makes at most three stop attempts. Once all viewers and pending starts have left, it makes one attempt to close the HomeBase connection and waits for confirmation before allowing playback again. A failed recovery keeps the affected session blocked. If the recording dialog says the previous live session is still stopping, wait about ten seconds and load the date again. Persistent failures require checking the bridge state, they do not trigger a polling or restart loop.
- A camera removed from Eufy becomes unavailable in HA, its registry entry is preserved so reappearance keeps IDs. Remove obsolete devices through HA's normal UI.
- Snapshot age is normal when there has been no new event. This integration does not wake a camera to make an old snapshot look fresh.

## Dependencies

| Component | Runtime requirements |
|---|---|
| Integration | Home Assistant ≥ 2026.9.0, built-in `camera`, `http`, `lovelace`, `websocket_api`, `go2rtc-client` 0.4.0 (installed automatically), HA-managed `go2rtc` for WebRTC |
| Card | Bundled JavaScript, Home Assistant frontend and a modern browser, no separate frontend runtime package |
| Bridge | Node.js 24, FFmpeg and tini, all included in the app/container |
| Bridge libraries | `@keesmod/eufy-mega-client` 0.10.0 from its checksum-pinned GitHub release and `ws` 8.21.3. Mega retains MIT and Apache-2.0 attribution. Dependencies are pinned by `bridge/package-lock.json`. |
| External services | Eufy account with camera access, Eufy cloud/push connectivity and local connectivity to camera/HomeBase |

No MQTT, separately installed RTSP server, existing Eufy integration or `eufy-security-ws` app is required. WebRTC uses HA's managed go2rtc and its FFmpeg audio conversion. Upgrade the bridge and integration together for the new transport. A dedicated shared Eufy account is recommended for ongoing use. Simultaneous operation with another Eufy client using the same account has only been briefly observed, not long-term validated. TypeScript, Playwright and Python test tools are development-only dependencies.

Maintainers use the [validated release flow](RELEASING.md) for both repositories. HACS updates the integration, the app store or Docker updates the bridge. A library release reaches HA only after a separately tested bridge release.

See [architecture and safety](ARCHITECTURE.md), [bridge protocol](PROTOCOL.md), [development](DEVELOPMENT.md) and [validation](VALIDATION.md).

## Existing HomeBase recordings

Previous release hardware evidence covers HomeBase 3 T8030 firmware 3.8.6.0 through Mega 0.10.0. The later 0.8.0 acceptance is recorded in [camera #31](https://github.com/keesmod/ha-eufy-cam/issues/31). The bridge uses the working calendar query `10006` with an empty device filter and `[selected day, next day]`, then filters returned records to the authorized camera. Legacy `10017` is not used. Only device-returned paths can be downloaded, the browser receives opaque expiring IDs.

The bridge expands the existing query limit to retrieve the selected day on the tested HB3 firmware. Ambiguous boundaries, inconsistent responses and the final safety ceiling are reported as errors instead of silent truncation. Firmware-wide pagination and bulk retention/export completeness are not claimed. One query or download runs at a time, close live viewers before loading recordings. Clip preparation is limited to 60 seconds and 32 MiB, with no persistent video cache. Failed requests require an explicit retry. See [recording protocol and live evidence](RECORDINGS_PROBE_2026-09-06.md).

### Live-stream diagnostics

In the bridge app configuration, enable `diagnostics: true`, save and restart
that app. The option defaults to false and older saved configurations may omit
it. Reproduce one live-view attempt and copy the lines containing
`"diagnostic":"live"` from the app logs. Disable the option and restart after
collecting the evidence. It applies to the Mega backend.

For Docker, set `EUFY_DIAGNOSTICS=true` and recreate the bridge container with
its existing data volume. Remove it or set it to `false` afterward.

Each attempt has a temporary number and elapsed milliseconds. `video_input`
and `audio_input` mean input bytes arrived, not that decoding succeeded.
`jpeg_frame` and `media_output` identify output from the two encoders.
`media_reader` means a client requested the media stream, not that it played.
`frame_ack` means the viewer acknowledged a delivered frame. `viewer_timeout`
means that acknowledgement deadline expired. `camera_timeout` means the
camera frame deadline or maximum viewing duration expired. `stream_failure`
is a general termination category. Encoder error, exit, invalid-data and
decode-error categories narrow the failure without exposing raw FFmpeg text.

Diagnostics emit each category once per attempt and never include device
identifiers, tokens, addresses, media grants, images or raw SDK/encoder errors.
Attempt numbers reset when the app restarts. Ordinary logs from other components
are outside this filter, so review any additional logs before sharing them.
This option does not change timeouts, keep cameras awake or enable SDK debug.

### Automatic live-video fallback

When WebRTC signaling, connection or playback fails, the viewer switches once
to live JPEG through the existing authenticated HA connection. The live popup
shows **Live video without sound** and hides its audio button. WebRTC is kept
when it works. The next explicit opening can try WebRTC again.

The bridge initiates fallback five seconds before the initial viewer deadline
(normally after 15 seconds for a new stream, or five seconds when joining an
existing stream), or six seconds without a subsequent playback acknowledgement.
These thresholds leave room to display JPEG within the existing 20/10-second
viewer deadlines. Switching
never extends those deadlines, starts another camera or resets the two-minute
maximum session lifetime. Hidden or disconnected viewers still expire.

Each viewer switches independently. Other viewers can continue using WebRTC.
HA logs a fixed fallback reason, and optional bridge diagnostics add matching
`fallback_*` categories. No raw ICE candidates, upstream error text or tokens
are logged. This does not add audio to JPEG or change network-provider terms.
Upgrade the integration and bridge together for this protocol capability.
