# Changelog

## 0.8.26 - 2026-09-19

### Longer live sessions for mains powered cameras, candidate

- Bridge 0.8.22 includes client 0.14.0. Its per-start live bound and its free
  primary session are the library side of
  [keesmod/eufy-mega-client#163](https://github.com/keesmod/eufy-mega-client/issues/163).
- Add the optional app option `live_max_seconds_mains` (Docker:
  `EUFY_LIVE_MAX_SECONDS_MAINS`, a whole number of seconds from 120 to 3600,
  default 120). It raises the absolute live session cap only for cameras the
  inventory reports without a battery value. Battery cameras keep the
  120-second cap in every case, and the default keeps 120 seconds for every
  camera. The bridge passes the bound per start to the client, the client
  sends the STOP at the bound, and the bridge's own watchdog uses the same
  value, so a session still ends without any help from the viewer.
- With `live_max_streams_per_station` above 1 the client now keeps the
  HomeBase's primary session free, so guard mode commands and snapshots work
  while cameras are live. Recording playback still waits until no camera on
  that HomeBase is live.
- The 10-second viewer lease, the 20-second startup timeout and the card's
  no-restart rule are unchanged. A session that reaches the cap still ends
  with `camera_timeout`, `stream_failure` and `session_end` and needs a new
  start. The bridge's state reports the configured value as
  `live_max_seconds_mains`.
- Diagnostics: the bridge's live audio report and the integration's filter
  keep elapsed times up to 3600000 ms, so long sessions keep their rows.

### Evidence and limits

The library evidence is one T8030 HomeBase 3 (firmware 3.8.7.4) with one
eufyCam 3 on the maintainer's bench: a ten-minute stream at a flat rate,
control on the idle primary session while a stream ran on its own session,
and a 180-second stream ended by the client's bound with a device-confirmed
STOP, see the
[library research note](https://github.com/keesmod/eufy-mega-client/blob/main/docs/research/LIVE_BOUND_2026-09-19.md).
The bridge's hub and backend tests cover the per-camera cap, the pass-through
of the bound and the battery rule. No mains powered camera has run through
this bridge with a raised cap yet. That observation belongs to the reporter
of #94 with three mains powered cameras: one camera for 30 to 60 minutes with
`diagnostics: true`, the `stream_metrics` from `/v1/state` before and after,
the integration's diagnostics download, GPU load and the final confirmed
stop. Until then the option is a candidate and installations that leave it
unset are unchanged.

### Upgrade and rollback

Update the bridge to 0.8.22 and the integration to 0.8.26, restart Home
Assistant and refresh the dashboard. Leave `live_max_seconds_mains` unset
unless you take part in the observation. To roll back, restore bridge 0.8.21
and integration 0.8.25 from your backup. The bridge's private data is
compatible in both directions.

## 0.8.25 - 2026-09-19

### Autostart cards stay live while scrolled out of view

- An inline card with `live_autostart: true` keeps its live session while it
  is scrolled out of view and keeps acknowledging frames, so scrolling a long
  dashboard no longer stops and restarts its cameras. A card that scrolls back
  into view is still the same session. Reported on #94 from a mobile
  dashboard with three autostart cards in one column, where every scroll cost
  a device-confirmed stop and a fresh start of several seconds.
- Autostart still starts when the card first comes into view after the view
  opens, so a card below the fold starts the first time you scroll to it, and
  again when the page becomes visible again. Scrolling back into view is no
  longer a trigger of its own. The two-minute cap still ends the session, and
  the session still stops on close, pause, stop, page hide, navigation, card
  removal and disconnection, each confirmed by the bridge. A session that
  ended never restarts by itself, scrolling included, and opening the view
  again applies autostart again. The focus return to the snapshot after a stop
  no longer scrolls the page, so a session that ends while its card is out of
  view leaves the page where it is.
- Inline cards without autostart and the popup keep stopping when the card
  scrolls out of view. No new card option, the editor is unchanged. The bridge
  stays at 0.8.21.

### Evidence and limits

Playwright covers an autostart card that keeps its session and its
acknowledgement counter while scrolled out of view on the JPEG path and on the
WebRTC tick path, no second session when it scrolls back, the cap ending an
out-of-view session without a restart on scroll, a manual inline card and the
popup still stopping on scroll out, an autostart card scrolled out of view
still stopping on hidden page, pagehide, disconnection and removal with the
next trigger waiting until it is in view, and three autostart cards in one
narrow column that stay live while the page scrolls between them and all stop
when the page hides or the cards are removed. In headless Chromium both
acknowledgement paths ran at the same rate for a video element 4000 pixels
below the viewport as in view. The reporter's mobile dashboard has not
confirmed this release yet.

### Upgrade and rollback

Integration-only release, the bridge stays at 0.8.21. Update the integration,
restart Home Assistant and refresh the dashboard. Coming from 0.8.23, this
update also brings the 0.8.24 toolbar below the video on narrow cards. To roll
back, restore the previous integration version from your backup and reload the
dashboard.

## 0.8.24 - 2026-09-19

### Inline live controls below the video on narrow cards

- On a card narrower than 500 px, about a phone in portrait, the inline live
  controls (pause, stop, sound and close) leave the overlay on the video for a
  compact toolbar directly below it, so the camera image stays fully visible.
  The paused bar with resume and stop sits below the snapshot in the same way.
  The card's own width decides through a CSS container query, not the screen,
  so a narrow card in a multi-column desktop view gets the toolbar as well and
  a wide card on a tablet keeps the overlay. Cards of 500 px and wider are
  unchanged.
- Layout only. The controls and their order, focus handling, status messages,
  the popup dialog mode and the card editor are unchanged. There is no new
  card option.

### Evidence and limits

Playwright covers a 360 px card with the four controls in one toolbar row
below the video, the paused bar below the snapshot after a pause, the toolbar
gone when the view closes, a 700 px card with the overlay on the video and
the paused bar on the snapshot, the threshold at 499 and 500 px while a
session stays open without a new lease, and the popup dialog at a narrow
width. The change answers a report from a phone dashboard, and confirmation
on that phone is still open.

### Upgrade and rollback

Integration-only release, the bridge stays at 0.8.21. Update the integration,
restart Home Assistant and refresh the dashboard. In the companion app close
and reopen the app if the card still shows the overlay on a narrow card. To
roll back, restore the previous integration version from your backup and
reload the dashboard.

## 0.8.23 - 2026-09-18

### Optional automatic live start for inline cards

- New card option `live_autostart: true`, default false and only valid with
  `live_mode: inline`. The card starts its live view without a tap when it is
  attached in view: when the view opens, when the card scrolls back into view
  or when the page becomes visible again. Each trigger starts at most one
  session per card, up to the bridge's `live_max_streams_per_station`. A card
  refused at the limit shows "Another camera on this HomeBase is live",
  returns to its snapshot and does not retry by itself. The visual card editor
  offers the switch for inline cards.
- Pause, resume and stop per card, next to the existing sound and close
  controls. Pause releases the lease and shows the snapshot with a resume
  control, which starts a new session with a fresh lease. Stop ends the session
  and disables autostart for that card until the view is opened again.
- Every rule holds: one lease per card with the frame acknowledgement loop,
  the two-minute cap, and a device-confirmed stop on close, page hide,
  navigation, card removal, disconnection or when the card scrolls out of
  view. When the bridge ends a session, at the cap or for any other reason,
  the card returns to its snapshot and does not restart by itself. Opening the
  view again applies autostart again. There is no retry loop and no
  keep-alive. The default stays the explicit start by tap.

### Evidence and limits

Playwright covers autostart on attach, on the page becoming visible again and
on the card scrolling back into view, no autostart in the dialog mode or
without the option, pause, resume, stop from the live bar and from the paused
bar, three autostart cards with the third refused at the limit and no retry,
an end at the cap without restart, cleanup on hidden page, pagehide,
disconnection and removal, the card editor, and real decoded WebRTC media that
starts inline without a tap. On 2026-09-18 four autostart cards on one
HomeBase 3 (T8030, firmware 3.8.7.4) with the bridge option at 3 started
without a tap in Chromium in two rounds: two cameras played through WebRTC
with late audio each time, the fourth card was refused at the limit and did
not retry, pause, resume and stop worked per card, a session that reached the
two-minute cap stayed on its snapshot, and leaving the view stopped the
remaining session with a device-confirmed stop, see
[the test record](docs/CONCURRENT_LIVE_2026-09-18.md#four-autostart-cards-in-a-browser-2026-09-18).
The third admitted camera timed out at startup in both rounds. A supervised
bridge-path test on 2026-09-19 then delivered three concurrent eufyCam 3 through
the bridge's own viewer path with device-confirmed stops and no startup timeout,
which locates that third-stream browser timeout on the WebRTC consumer path and
host CPU headroom rather than the HomeBase or the bridge, see
[the 2026-09-19 record](docs/CONCURRENT_LIVE_2026-09-19.md). Three concurrent
WebRTC streams in a browser on a software-transcoding host remain unverified.

### Upgrade and rollback

Integration-only release, the bridge stays at 0.8.21. Update the integration,
restart Home Assistant and refresh the dashboard. If you update from 0.8.20,
the 0.8.22 and 0.8.21 notes below apply as well. Existing cards keep their
behaviour until you set `live_autostart: true`. To roll back, restore the
previous integration version from your backup and reload the dashboard.

## 0.8.22 - 2026-09-18

### Inline live mode for several live cameras

- New card option `live_mode: inline` plays the live view inside the card
  instead of the modal dialog, so a dashboard can show several cameras live at
  the same time, up to the bridge's `live_max_streams_per_station` limit per
  HomeBase. The default `dialog` keeps today's popup. The visual card editor
  offers the choice.
- An inline card keeps every rule of the dialog: one tap starts one lease with
  the frame acknowledgement loop, the two-minute cap, WebRTC with the JPEG
  fallback, the sound toggle and late audio, the diagnostics download, and a
  stop on close, Escape, page hide, navigation, card removal, disconnection or
  when the card scrolls out of view. Its close and sound controls sit on the
  video and status messages appear below the camera name. A card refused by
  the HomeBase limit shows "Another camera on this HomeBase is live" there and
  returns to its snapshot.
- Nothing starts automatically. Each live camera still needs its own tap.

### Evidence and limits

Playwright covers the inline mode with simulated Home Assistant dispatch: start
on both transports, frame acknowledgements, stop on close, Escape, hidden page,
page hide, disconnection and removal, three inline cards on one page with two
live at once and the third refused at the limit, the card editor, and real
decoded WebRTC media plus the JPEG fallback inside the card. On 2026-09-18 two inline
cards played two eufyCam 3 (T8160) cameras of one HomeBase 3 (T8030, firmware
3.8.7.4) at the same time in Chromium through WebRTC with late audio, with
bridge 0.8.21 and the option at 4, and both closed with device-confirmed stops,
see [the test record](docs/CONCURRENT_LIVE_2026-09-18.md#two-inline-cards-in-a-browser-2026-09-18).
Three or four concurrent streams remain unverified.

### Upgrade and rollback

Integration-only release, the bridge stays at 0.8.21. Update the integration,
restart Home Assistant and refresh the dashboard. If you update from 0.8.20,
the 0.8.21 notes below apply as well. Existing cards keep the dialog until you
set `live_mode: inline`. To roll back, restore the previous integration version
from your backup and reload the dashboard.

## 0.8.21 - 2026-09-18

### Configurable live cameras per HomeBase

- The bridge includes client 0.13.0, whose `maxLiveStreamsPerStation` option
  lets further cameras on one HomeBase stream live at the same time, each on
  its own P2P session with its own confirmed STOP and 120-second cap. The new
  optional app option `live_max_streams_per_station` (Docker
  `EUFY_LIVE_MAX_STREAMS_PER_STATION`, a whole number from 1 to 4) sets that
  limit. The default 1 keeps today's one live camera per HomeBase.
- The bridge admits a camera while the number of live and starting cameras on
  its HomeBase is below the limit instead of refusing every second camera on
  the same HomeBase. The 8 camera slots, 4 viewers per camera, the recording
  interlock and stop recovery are unchanged. `/v1/state` reports the configured
  limit as `live_max_streams_per_station`.
- A viewer refused by that limit is closed with code 4013 instead of the
  generic 1013. Home Assistant forwards it as `reason: "station_limit"` on the
  `ended` event, and the card says that another camera on this HomeBase is live
  (English and Dutch) instead of "Live view ended".
- Client 0.13.0 also renews the cloud identity after Mega result code 4404 or
  4416, which the bridge hit once as HTTP 463 during the library research.

### Evidence and limits

Two concurrent streams are verified by the library on one HomeBase 3 (T8030,
firmware 3.8.7.4) with two eufyCam 3 (T8160) cameras at full rate with audio.
The bridge path was exercised on the maintainer's HomeBase 3 with two eufyCam 3
on 2026-09-18 (see [that record](docs/CONCURRENT_LIVE_2026-09-18.md)) and with
three eufyCam 3 on 2026-09-19, all reaching the first frame with device-confirmed
stops and no startup timeout (see
[the 2026-09-19 record](docs/CONCURRENT_LIVE_2026-09-19.md)). Software
transcoding of three streams saturated a 2-core host, so the sustainable value
depends on host CPU and transport. Four streams, and three concurrent WebRTC
streams in a browser on a software-transcoding host, remain unverified. The card still opens
one modal live view per card, so a grid of simultaneous live cards needs the
inline live mode that follows [issue #84](https://github.com/keesmod/ha-eufy-cam/issues/84).
Each concurrent camera adds an encoder pipeline on the bridge host (two FFmpeg
processes, one go2rtc stream per viewer, one NVENC session when accelerated).

### Upgrade and rollback

Update both the integration and bridge to 0.8.21, restart Home Assistant and
refresh the dashboard. The limit stays 1 unless you set the option. Back up
both components with their private data first and restore the previous versions
together to roll back. Bridge 0.8.21 with integration 0.8.20 keeps working; the
refused-camera message then stays generic.

## 0.8.20 - 2026-09-15

### Live audio whenever the camera starts sending it

The reporter's T8134 cameras behind a HomeBase 3 send their first AAC frame
four to five seconds after the first video frame on a cold start and 40 ms
after it on a warm start. The library's three-second startup deadline excluded
audio on every cold start, and admitted audio was muxed into the video encoder,
which emits nothing until its first audio frame and holds video for the length
of every audio gap.

- The bridge never muxes audio into the live video stream. Every session starts
  a video-only encoder and delivers AAC on the existing late-audio route as soon
  as its first complete frame arrives, whether that is 40 ms or 5 s after video.
  `ready` always reports `audio: false`; an audio transport error ends only the
  audio feed. The library's startup classification remains as observational
  `audio_supported`/`audio_absent` marks.
- Home Assistant never ends a live session for an `audio_ready` it cannot use
  (video setup failed or was downgraded, an older bridge reporting `audio: true`)
  or for a repeated announcement. Older bridges keep their joint audio source.
- Diagnostics record the late-audio stage and end reason per attempt, include
  the late-audio go2rtc stream's counters in relay rows, report the card's audio
  peer state, and assess the new states. `audio_expected` now only mirrors the
  bridge's initial classification.

### Bounded live encoder and arrival-time stamps

- The live WebRTC encoder is capped with a VBV window (default `4M`, add-on
  option `live_max_bitrate`, Docker `EUFY_LIVE_MAX_BITRATE`). The reporter's
  relay counters measured 9.8-12.4 Mbit/s unbounded output with 300-500 KB
  keyframe bursts alongside stalled decoding. Those counters alone do not
  establish the cause of the reporter's playback failure.
- Frames are stamped with their arrival time instead of being counted at the
  camera's announced rate. A HomeBase delivering 16-17.5 frames per second
  against a 15 fps header made the browser's jitter-buffer delay grow steadily.

### Upgrade and rollback

Update both the integration and bridge to 0.8.20, restart Home Assistant and
refresh the dashboard. Back up both components with their private data first
and restore the previous versions together to roll back. The bundled client
remains 0.12.3. The card makes one late-audio attempt per live view; close and
reopen the view to retry audio.

### Scope and known limits

References #10. Bridge tests cover the arrival-time stamping and the bounded
output with real FFmpeg; HA and card tests cover warm and cold audio ordering.
Exact T8134 hardware acceptance still needs the reporter's local retest. A
dashboard proxy does not carry the separate WebRTC media connection. When no
direct media route is available, use reachable TURN or routed LAN/VPN access.

## 0.8.19 - 2026-09-15

### More useful playback reports

One diagnostic download now connects the stages of a failed recording, reducing
the separate logs and repeat attempts needed to investigate an issue.

- Extend the existing diagnostic download with recent recording preparation,
  processing, limits, cancellation and cleanup. Anonymous attempt references
  connect bridge and Home Assistant observations. Reports retain at most eight
  attempts for fifteen minutes and exclude identifiers, addresses and media.
- Add a bounded diagnostic download action at relevant player errors, using
  Home Assistant's existing administrator permissions. Report loaded card and
  component versions, observed failure stages and missing or stale evidence.

### Stronger regression checks

- Cover concurrent recording readers, close/expiry/unload, interrupted reads
  and reopening after fallback or closure before late audio. The new scenarios
  preserve existing playback behavior and improve the synthetic test fixture.

### Simpler device maintenance

- Include client 0.12.3 with one registry for all 51 existing device profiles
  and separate snapshot, live and recording policies. Existing model/type,
  owner and firmware admission remains unchanged. Preserve the released
  late-audio and Home Assistant STUN/TURN behavior.
- Give maintainers one place to add and review profiles within supported device
  families, backed by automatic admission checks. A new protocol or an untested
  model still needs its own implementation and hardware evidence.

### Upgrade and rollback

Update both the integration and bridge to 0.8.19, restart Home Assistant and
refresh the dashboard. Back up the integration and bridge with its private
data first. Restore their previous files or versions together to roll back,
preserving credentials and entity identities. Older bridges remain usable but
cannot provide the added recording evidence. Download diagnostics before a
restart or the fifteen-minute retention window expires.

### Scope and known limits

References #76, #77 and #78, with
[client #139](https://github.com/keesmod/eufy-mega-client/issues/139).
This batch adds no model or hardware support claim. Exact external T8134
acceptance remains in #10. The known Home Assistant cryptography dependency
limitation remains open in #30. No security finding is suppressed or fixed by
this update.

## 0.8.18 - 2026-09-15

- Use Home Assistant's configured and provider-supplied STUN/TURN servers for
  both live video and optional late audio, on the browser and managed go2rtc.
  Resolve fresh credentials for each peer without changing HA network settings.
- Send ICE candidates as they arrive so an unreachable STUN server does not
  prevent direct local playback. Existing startup, fallback and cleanup limits
  still apply. If HA cannot supply ICE configuration, try direct connectivity.
- Add bounded candidate-type, pair-state and ICE-error counters for failed
  connection attempts. Diagnostics exclude addresses, candidate strings, SDP,
  server URLs and relay credentials.

Back up Home Assistant, update the HACS integration, restart Home Assistant and
refresh the dashboard. Bridge 0.8.17 and client 0.12.2 remain unchanged. Restore
the backed-up integration to roll back.
References #10. The reporter's external T8134 route still needs acceptance.
A dashboard proxy alone does not provide a WebRTC media relay.
See the [validation method and acceptance boundary](docs/WEBRTC_ICE.md).

## 0.8.17 - 2026-09-15

- Add AAC audio that arrives after a live session started without an audio track.
  Video keeps its existing encoder and connection. The same camera owner supplies
  complete AAC frames to an optional audio-only WebRTC connection. Failed audio
  setup does not interrupt video or extend the camera's viewing deadline.
- Keep initial A/V, video-only cameras, JPEG fallback, recordings, GPU settings,
  credentials and entity identities unchanged. Audio readers use the existing
  per-viewer grant and close with their owner. Older cards and integrations do
  not receive the new audio control events unless they opt in.
- Record `audio_late` when actual AAC becomes available, with browser audio
  negotiation and decoding counters covering the added track. No audio payload
  is retained in diagnostics.

Update both the bridge and HACS integration to 0.8.17, reload the integration or
restart Home Assistant, and refresh the dashboard. The published client remains
0.12.2. Back up both components before installation. Restore their previous files
or versions together to roll back, preserving app data and login state.

References #10. Tests confirm late-audio delivery and continued video. Exact
T8134 reporter acceptance remains pending. This release makes the change
available for testing. An external WebRTC connection that cannot establish ICE
still uses video-only JPEG fallback and needs reachable media connectivity.

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

## 0.8.15 - 2026-09-14

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

Includes bridge 0.8.14, with unchanged client 0.12.2. Back up both components
before installing. Restore the previous integration and bridge together to roll
back, preserving credentials and identities.

## 0.8.14 - 2026-09-14

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

Includes bridge 0.8.13. Back up both components before updating. Restore their
previous files to roll back, preserving data, credentials and entity identities.

## 0.8.13 - Internal candidate

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

Includes bridge 0.8.12. Back up both components before updating. Restore their
previous files to roll back, preserving bridge data and Home Assistant identities.

## 0.8.12 - 2026-09-14

- Add bounded live audio format, continuity and processing observations, linked
  to a later browser measurement in Home Assistant diagnostics. Include ADTS
  header facts, buffered audio, stream cleanup and negotiated audio details
  without storing audio payloads. Issue #10 awaits T8134 hardware validation.
- Add Auto / Native / H.264 to recording playback in both camera and events
  cards. Remember the choice in this browser and retain position and pause
  when changing it. Auto requests HEVC conversion when NVIDIA recording
  acceleration is configured or the browser lacks HEVC support.
- Display the actual per-recording remux, software or NVIDIA processing result,
  including software fallback. Older bridges retain browser-based selection
  and show processing as unknown. Explicit Native never silently transcodes.
- Includes bridge 0.8.11. After release, the reporter confirmed the Auto/UI
  NVIDIA route, playback and GPU cleanup on T600/T8030/T8425, plus a Live
  regression check. The reporter later confirmed Native, audio and seeking, but also reported
  intermittent NVIDIA fallback. An H.264 source remains untested by the reporter.
  See the [hardware validation record](docs/NVIDIA.md#auto-playback-validation-on-2026-09-14).
  Back up both components before installation and restore their previous files
  to roll back, preserving credentials and entity identities.

## 0.8.11 - Unreleased

- Restore the software live encoder defaults by removing the 4 Mbit/s target,
  maximum rate and 1 Mbit VBV limit introduced in the previous candidate.
  Bitrate was not established as the cause of issue #10 and the image-quality
  cost was not measured. Retain the added playback and audio diagnostics.
- Keep the existing NVIDIA settings, video dimensions, frame rate and audio
  conversion unchanged. Integration/card 0.8.11 accompanies bridge 0.8.10.

Issue #10 remains open. No T8134 fix or hardware acceptance is claimed. Back up
both components before updating and restore their previous files to roll back.

## 0.8.10 - Withdrawn candidate

- Bound software live H.264 output to a 4 Mbit/s target and maximum rate with
  a 1 Mbit VBV buffer. Retain H.265 decoding, the existing scale limit, AAC audio,
  encoder ownership and playback deadlines. High-complexity scenes may lose
  detail to keep the output within this budget.
- Include RTP loss, complete frames, NACK/PLI/FIR, jitter-buffer counters and
  negotiated audio presence in bounded playback diagnostics. Preserve absent
  values as unavailable, including absent audio counters.

Integration/card 0.8.10 and bridge 0.8.9 are unpublished candidates for issue #10.
The software cap was withdrawn in 0.8.11. Synthetic overload results did not
establish the reporter's root cause or justify the unmeasured quality cost. Late audio discovery and consumer track admission remain
separate from this video change. Back up both components before an update and
restore their previous files to roll back, preserving the existing data/token.

## 0.8.9 - 2026-09-14

- Add bounded live playback evidence to the integration diagnostic download.
  Record signaling, go2rtc codec packet counters, browser reception and decoding,
  presented frames and acknowledgements. Retain only fixed statuses and numbers,
  with no SDP, addresses, device identifiers or media.
- Compare successful playback with blocked ICE, a missing answer and stalled
  painting or ticks using real FFmpeg, go2rtc and Chromium. Cover video-only,
  silent, delayed and batched AAC input.

This is a diagnostic update for the unresolved T8134 live playback report #10.
It does not claim to fix or validate that camera's audio. The integration and
card change, while bridge 0.8.8 remains unchanged. When published, update the HACS
integration and restart HA, preserving the existing account and bridge data.
Back up the integration first and restore it to roll back.

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

Follow the [four upgrade steps](docs/MEGA_MIGRATION.md). New-build hardware acceptance and the
Python security gate remain open in camera #31 and #30. Do not treat this
unpublished candidate as an accepted production release.

## 0.7.3 - Unpublished

- Remove the repeated experimental/hardware warning from camera cards. The
  capability status describes software availability, not hardware verification.
- Keep unavailable-operation explanations, disabled controls and capability
  attributes. No camera transport or hardware-support claim changes.
- Integration-only update with bridge 0.7.1 retained. Publication and deployment
  remain separate actions. Refresh the card resource after upgrading.

## 0.7.2 - Candidate, not published

- Consolidate the completed camera capability and upgrade/rollback evidence,
  including exact model, firmware, topology and feature limits.
- Keep bridge 0.7.1 and the pinned Mega client 0.10.0. Only integration version
  metadata and documentation change. No media, authentication or device-command
  behavior changes and no additional hardware support is claimed.
- Preserve the legacy selection until camera #24 completes its separate gate.
  T8134 live/recovery and other family obligations remain open.

See [candidate notes](docs/CAMERA_RELEASE_CANDIDATE_0_7_2.md) for reproducible
packaging, software validation and publication boundaries. After separately
authorized publication, update the integration while keeping bridge 0.7.1.
Retain the integration 0.7.1 archive, existing entry and private backup for
rollback. A backend/version migration still follows the [migration guide](docs/MEGA_MIGRATION.md).
No publication or deployment is authorized by preparation story #21. The
existing Python dependency alert is recorded in the candidate notes and remains
an explicit gate for later publication/deployment acceptance.

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
  bridge package and private data for rollback. There was no separate 0.7.0 publication.

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

## 0.6.0 — 2026-09-10

- Add the independent Eufy Mega client for T8030 HomeBase 3, T8160 cameras and
  the T8213 doorbell. Select one backend at startup; retain separate sessions
  and never retry a command through the legacy backend.
- Preserve camera/entity identities, notifications, snapshots, live video and
  audio, recording formats and Guard Mode with observed device confirmation.
- Recover cancelled starts, downloads and network loss with device STOP
  acknowledgements. Close UDP sockets and restore idle station connectivity.
- Wait for delayed first audio packets before deciding a live stream has no
  audio. Normal streams start as soon as their media is identified.
- Use host networking and the loopback endpoint `http://127.0.0.1:8063` for the
  HAOS app. Reconfigure the existing integration entry when upgrading.

Update bridge and integration together. The HAOS app endpoint changes to
`http://127.0.0.1:8063`; select `mega` explicitly and reconfigure the existing HA
entry with its existing token. Keep the previous image and private session backup.
See [Mega migration and rollback](docs/MEGA_MIGRATION.md). The agreed overnight
observation lasted about 11 hours 26 minutes; it is not a completed 24-hour
reliability or battery-life test.

## 0.5.1 — 2026-09-09

- Preserve H.265 recordings in an Apple-compatible `hvc1` MP4 when the player
  reports HEVC support. Copy AAC audio without re-encoding. Both Events and
  camera recording dialogs use the same capability check.
- Fall back once to H.264 on a native decoding/codec error, including errors
  during playback. Preserve position and pause state, show recovery progress,
  and cancel recovery when the viewer closes or changes recordings. Unsupported clients
  request H.264 immediately; network errors and cancellation do not retry.
- Allow up to 45 seconds for the H.264 compatibility conversion of H.265 clips,
  within the existing 60-second operation and 32 MiB media limits.
- Emit one complete MP4 fragment so the macOS native player sees the whole
  recording instead of ending after the first fragment.
- Keep authenticated HTTP playback, byte ranges, expiry and close cleanup.

Update the bridge and integration together to **0.5.1**, bridge first. Restart
Home Assistant and refresh the dashboard in every app/browser. For manually
configured resources, change the existing URL to
`/eufy_viewer/eufy-viewer-card.js?v=0.5.1`. No camera settings need to change.

## 0.5.0 — 2026-09-09

- Add camera event entities and the `eufy_viewer_event` automation event for
  doorbell rings, motion, people, vehicles, pets, sound and package detections.
- Include Eufy-recognized person names and distinguish known, explicitly unknown
  and unidentified people. Merge parallel push formats and derived SDK callbacks
  into one actionable event per detection. Unclassified device alerts remain
  available as `notification`; account data and raw message bodies are excluded.
- Add an Eufy push connection diagnostic binary sensor. Login connectivity and
  push connectivity are separate states.
- Subscribe without starting camera streams; ignore detector reset events,
  suppress duplicate push deliveries, and never replay alerts on HA reconnect.

Requires integration and bridge **0.5.0**. Update the bridge first, then the
integration, restart Home Assistant and verify the push connection sensor.
Existing bridge clients continue receiving state-only messages until they opt
in. See [events and notifications](docs/NOTIFICATIONS.md) for automation examples,
account/phone filtering and delivery limitations.

## 0.4.4 — 2026-09-08

- Fix recording playback in the Home Assistant macOS app in both Events and
  the per-camera Recordings dialog. Use a native HTTP video source instead of
  a browser blob, which stalls in this app.
- Prepare each clip once, support byte-range seeking and keep camera permissions
  enforced. Playback URLs use Home Assistant authentication, expire after five
  minutes and are scoped to the requesting user and one recording. Media stays
  in bounded memory and is released on close, expiry or integration unload.
- Show a retry message and release media when native playback fails or stalls.

Update **Eufy Security Viewer** to **0.4.4** in HACS, restart Home Assistant,
then refresh the dashboard in the macOS app. Open **Events**, load the date and
select a recording. For YAML-managed resources, update the existing module URL
to `/eufy_viewer/eufy-viewer-card.js?v=0.4.4`. The bridge remains at **0.4.1**;
no bridge update or camera reconfiguration is needed from that version.

## 0.4.3 — 2026-09-08

- Fix live viewing in the Home Assistant macOS app. Check client WebRTC and
  video-frame callback support before opening a stream, and use the existing
  JPEG transport when either is unavailable. JPEG live view has no audio.
- Keep WebRTC with audio on supported clients and preserve explicit-start,
  frame acknowledgement and stream cleanup behavior.
- Reproduce the missing WebRTC API in the macOS app and verify actual JPEG
  live playback and zero remaining active or quarantined streams.

Update **Eufy Security Viewer** to **0.4.3** in HACS, restart Home Assistant,
then refresh the dashboard in the macOS app. For YAML-managed resources, update
the existing module URL to `/eufy_viewer/eufy-viewer-card.js?v=0.4.3`.
The bridge stays at **0.4.1**; no bridge update or camera reconfiguration is
needed when it is already on that version. Use Safari for live audio.

## 0.4.2 — 2026-09-07

- Register the bundled dashboard cards automatically when the integration loads.
  Update the existing resource URL to the installed integration version and
  remove duplicate entries for the bundled card. Keep unrelated resources.
- Leave YAML-managed resources unchanged and log the required module URL when
  manual configuration is needed. Registration errors do not block the cameras.

Update the HACS integration to **0.4.2**, restart Home Assistant and reload the
dashboard. The integration adds or updates its card resource automatically.
For YAML-managed resources, update the existing module URL to
`/eufy_viewer/eufy-viewer-card.js?v=0.4.2`. The bridge remains at **0.4.1**;
no bridge update is required when it is already on that version.

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
