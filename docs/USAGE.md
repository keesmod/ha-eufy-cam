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
- A visual-editor Lovelace card starts live video after a click or keyboard activation. Supported clients use WebRTC with optional listen-only audio, clients without WebRTC use JPEG video. The live view opens as a popup dialog, or inside the card with `live_mode: inline`, see [card options](#card-options).
- Choose **Recordings → Date → Show recordings** to play an existing HomeBase event in Home Assistant. This reads stored events, it does not record a new live stream.
- Closing the live view, leaving the dashboard, hiding the tab, disconnecting or failing to process frames releases the viewer.
- Multiple viewers of a camera share one upstream stream. Closing one viewer does not interrupt the others.
- By default one camera per HomeBase is live at a time. A second camera on the same HomeBase is refused until the first live view has stopped, and its card says that another camera on this HomeBase is live. The bridge option `live_max_streams_per_station` raises that limit, see [live cameras per HomeBase](#live-cameras-per-homebase).
- The bridge independently expires silent viewers and stops the camera after the last viewer leaves.
- HomeBase alarm and Guard Mode entities with station-confirmed commands and push status.
- Push discovery and battery sensors, stable registry IDs, clean unload, English/Dutch UI and allowlisted diagnostics. The card shows the battery level next to the camera name, see [battery level](#battery-level).
- No cloud polling timer: the pinned Eufy client is configured with `pollingIntervalMinutes: 0`. Login, push-triggered refreshes, token renewal and the library's local station communication still occur.

### Card options

The visual editor sets these. Its **Live view** choice offers **Popup dialog
(default)** or **Inside the card, for several live cameras**. The **Start live
automatically** switch appears once the inside option is selected. In YAML:

```yaml
type: custom:eufy-viewer-card
entity: camera.front_door
name: Front door
live_mode: inline
```

| Option | Values | Meaning |
|---|---|---|
| `entity` | a Eufy Viewer camera entity | Required. |
| `name` | text | Optional title. The default is the entity's friendly name. |
| `live_mode` | `dialog` (default) or `inline` | `dialog` opens the live view in a popup dialog that closes on Escape or a tap outside. `inline` plays the live view inside the card with its controls in a toolbar below the video, so several cards can be live at once. |
| `live_autostart` | `true` or `false` (default) | Only with `live_mode: inline`. Starts the live view without a tap when the view opens, up to the bridge's `live_max_streams_per_station`, keeps it while the card is scrolled out of view, and adds pause, resume and stop controls to the card. See [automatic live start](#automatic-live-start). |

An inline card follows the same rules as the dialog: one tap starts one live
session, the two-minute cap applies, the sound toggle and late audio work the
same, the diagnostics download stays available to administrators, and the view
stops on close, Escape while it has focus, page hide, navigation, card removal
or disconnection. A card without `live_autostart` also stops when it scrolls
out of view. Status messages appear below the camera name. A card refused by
the HomeBase live limit shows that message there and returns to its snapshot.
Nothing starts automatically unless the card has `live_autostart: true`.

At every card width, in portrait and landscape, the live controls sit in a
compact toolbar directly below the video instead of on it, and the paused bar
of an autostart card sits below the snapshot. The whole camera image stays
visible, including a timestamp the camera draws in a top corner. The popup
dialog keeps its bar above the video.

#### Automatic live start

With `live_autostart: true` an inline card starts its live view without a tap
when it comes into view after the view opens, and again when the page becomes
visible again. A card below the fold starts the first time you scroll to it.
Each trigger starts at most one session per card, up to the bridge's
`live_max_streams_per_station`. The card keeps its live session while it is
scrolled out of view and keeps acknowledging frames, so scrolling a long
dashboard does not stop and restart its cameras, and a card that scrolls back
into view is still the same session. A card refused at the limit shows the
station-limit message, returns to its snapshot and does not retry by itself.
When the bridge ends a session, at the two-minute cap or for any other reason,
the card returns to its snapshot and does not restart by itself, scrolling
included. Opening the view again applies autostart again. There is no retry
loop and no keep-alive. A camera that is unavailable when the view opens
starts once it becomes available while the view stays open.

The live view gets two controls next to the sound and close controls.
**Pause** releases the lease and shows the snapshot with a **Resume** control,
which starts a new session with a fresh lease. The next autostart trigger also
resumes a paused card. **Stop** ends the session and disables autostart for
that card until the view is opened again. A tap on the snapshot always starts
a session by hand, and the close control keeps its meaning. Every rule above
still applies: one lease per card with the frame acknowledgement loop, the
two-minute cap, and a stop on close, page hide, navigation, card removal and
disconnection, each confirmed by the bridge. Scrolling the card out of view is
the one exception: an autostart card stays live. The visual editor shows the
switch for inline cards, and the default is stored as an absent key.

#### Battery level

A camera that reports a battery value shows it next to its name on the card:
a battery icon whose fill width follows the percentage and whose colour
follows the Home Assistant theme, green from 50 percent, amber from 20 to 49
and red below 20, with the percentage as text and an accessible label. The
value is the camera entity's `battery` attribute, the same figure as the
camera's battery sensor, delivered by push. The card never requests it and
the display starts nothing. A camera without a battery value, such as a mains
powered camera, shows nothing there, and an unavailable camera hides it.

### Honest snapshot and streaming limits

A sleeping battery camera cannot provide a newly captured photo on every dashboard visit without waking. Idle views show the **latest received snapshot**. The receive time remains available in the camera entity attributes, the card omits snapshot timestamps. If none exists, the card says so. New Eufy image events replace it. The last decoded live frame becomes the snapshot when viewing ends. From bridge 0.8.39 that frame stays the snapshot until a newer image arrives. Earlier bridges could put the older event image back at the next unrelated update.

From integration 0.8.48 with bridge 0.8.39 each camera has a **Refresh snapshot** button ([issue #182](https://github.com/keesmod/ha-eufy-cam/issues/182)). A press starts the camera the way a live viewer does, keeps a frame about one second after the first one, because a battery camera that just woke can still be adjusting its exposure, and then stops the camera with the normal confirmed stop. The card then shows the new snapshot. Each press wakes the camera and costs battery like a short live view, and it can take up to about 20 seconds while the camera starts. A refresh counts against `live_max_streams_per_station` like any live view. It is refused, not queued, for example while the HomeBase is at its live limit, while a recording is being prepared or while a previous live session is still stopping, and Home Assistant then shows an error that says why. When the camera is already live, the refresh joins that session and keeps its newest frame, and the other viewers keep watching. Nothing presses the button by itself. An automation can press it with the `button.press` action, and every such press wakes the camera. The button appears only with bridge 0.8.39 or newer and only for cameras whose snapshot and live capabilities are available, see [camera capabilities](CAMERA_CAPABILITIES.md).

On supported clients, live viewing uses **WebRTC video with listen-only audio** through Home Assistant's managed go2rtc. The bridge converts H.264/H.265 to browser-compatible H.264, up to **1920 pixels wide and 30 fps**, limited by the camera's source frame rate. Supported camera audio is converted to Opus. Playback starts muted, tap **Sound on / Geluid aan** to listen. A camera that supplies no supported audio remains video-only.

A normal HA camera card/more-info dialog shows snapshots only. Use the companion card for live video. Talkback, new live recordings, HLS, PTZ and permanent RTSP are not provided. Use **Recordings** on a companion card to choose a date and play an existing HomeBase recording. The date and times are HomeBase-local. Clips are downloaded on demand into private temporary files, then played as MP4. Close or navigation cancels preparation. No Eufy Cloud subscription is required for these local files.

#### Live cameras per HomeBase

By default one camera per HomeBase streams live at a time. The bridge refuses a second camera on the same HomeBase while the first is live, and that card says that another camera on this HomeBase is live. Close the first live view, then start the other camera.

From bridge 0.8.21 the optional app option `live_max_streams_per_station` (Docker: `EUFY_LIVE_MAX_STREAMS_PER_STATION`, a whole number from 1 to 4) raises that limit. From bridge 0.8.22 with client 0.14.0 every live camera on such a HomeBase streams on its own P2P session, with its own confirmed STOP and cap, and the HomeBase's primary session stays free, so guard mode commands and snapshots work while cameras are live. Recording playback still waits until no camera on that HomeBase is live. Other values stop the bridge at startup.

Three concurrent streams are verified through the bridge on one HomeBase 3 (T8030, firmware 3.8.7.4) with three eufyCam 3 (T8160) cameras. On 2026-09-19 three cameras streamed at the same time through the bridge's own viewer path (JPEG, each acknowledging every frame), staggered and simultaneous, all reaching the first frame with device-confirmed stops and no startup timeout, see [the test record](CONCURRENT_LIVE_2026-09-19.md). Two concurrent streams were verified earlier by the client each at full rate with audio and exercised on the bridge path on 2026-09-18, see [that record](CONCURRENT_LIVE_2026-09-18.md). On 2026-10-06 a user reported four concurrent streams on another HomeBase 3 with NVIDIA live acceleration, not independently reproduced, see [compatibility](COMPATIBILITY.md#dated-0821-concurrent-live-test). Each concurrent camera adds an encoder pipeline on the bridge host (two ffmpeg processes per camera with software transcoding), and three streams saturated the CPU of a 2-core host, so **for a browser dashboard on a low-core host without hardware acceleration, 2 is the recommended value and 3 needs a GPU or ample CPU headroom**. For a dashboard with several live cards at once, set `live_mode: inline` on each card, and `live_autostart: true` to start them when the view opens, see [card options](#card-options). Each card is admitted or refused by the bridge on its own tap or automatic start, up to the limit. Two inline cards played two eufyCam 3 cameras of one HomeBase 3 at the same time in a browser on 2026-09-18 with device-confirmed stops, see [the test record](CONCURRENT_LIVE_2026-09-18.md#two-inline-cards-in-a-browser-2026-09-18). Later that day four autostart cards with the option at 3 played two cameras at the same time while the third admitted camera timed out at startup, which the 2026-09-19 bridge-path test traced to the WebRTC consumer path and host CPU headroom rather than the HomeBase or the bridge, so three concurrent WebRTC streams in a browser on a software-transcoding host remain unverified. Cameras on different HomeBases are admitted independently within the bridge's eight camera slots, but that combination has not been validated on hardware.

Clients without WebRTC or video-frame callback support, including the Home Assistant macOS app, automatically use JPEG live video at up to **8 fps / 960 pixels**, without audio. The same explicit-start and stream cleanup rules apply. Use Safari on the Mac for WebRTC with live audio. If an established WebRTC attempt fails, the viewer can switch once to video-only JPEG. See [automatic fallback](#automatic-live-video-fallback).

WebRTC requires Home Assistant's **go2rtc integration** to be loaded and the browser to have a media route to HA (the managed service uses TCP port **18555**). A dashboard accessible through an HTTPS reverse proxy alone does not establish this media route. The viewer uses Home Assistant's existing [WebRTC ICE configuration](https://www.home-assistant.io/integrations/web_rtc/) for both live video and optional late audio. HA supplies configured STUN/TURN servers and any registered providers, with its default STUN servers when no custom servers are configured. STUN discovers possible routes but cannot relay media. A route blocked by NAT or firewall may require an existing TURN provider or routed LAN/VPN access. This integration does not configure a separate relay service. If HA's ICE provider fails, direct playback is still attempted and the existing video-only JPEG fallback remains available. Do not expose the bridge API to solve WebRTC connectivity. See [0.2 validation](VALIDATION_0.2.md).

Sessions have a **two-minute absolute limit** for battery cameras and by default for every camera. From bridge 0.8.22 the app option `live_max_seconds_mains` (Docker: `EUFY_LIVE_MAX_SECONDS_MAINS`, a whole number of seconds from 120 to 3600, default 120) raises that limit only for cameras the inventory reports without a battery value, verified on 2026-09-19 with one mains powered camera for a full 1800-second session, see [compatibility](COMPATIBILITY.md#dated-0827-mains-powered-live-session). From integration 0.8.27 the Home Assistant viewer follows that cap as well, before that it ended every session at 125 seconds. Continuing after the cap requires another tap, also on a card with `live_autostart`. Normal close immediately issues stop. After a network partition or frozen page the bridge expires a viewer within **10 seconds**, plus its 250 ms watchdog tick. Startup without frames expires after 20 seconds. A bridge or host hard failure cannot deliver a stop command, camera firmware/P2P behavior in that case must be verified on the intended hardware. No software can promise instantaneous physical stop across a dead network.

## Experimental standalone cameras

Cameras that are not connected to a HomeBase normally show their snapshot, live
and recording features as unsupported with `standalone_transport_unverified`.
From bridge 0.8.34 the app option `experimental_standalone: true` (Docker:
`EUFY_EXPERIMENTAL_STANDALONE=true`) lets a standalone Wall Light Cam S100
`T84A1`, Indoor Cam 2K Pan & Tilt `T8410` or Indoor Cam Pan&Tilt 2K `T8410C`
try its own local session. The T8410 needs bridge 0.8.35 or newer and the
T8410C bridge 0.8.38 or newer. The option is off by default. Only these three
models are included, and no other camera or HomeBase changes. Update the
integration to 0.8.43 or newer before turning it on.

Any other standalone camera that the bundled library keeps at
`standalone_transport_unverified` stays there with the option on, because the
library admits only these models to the experimental route. So does a
standalone `T8410C` on bridge 0.8.36 or 0.8.37, whose client 0.29.2 admits
only the T84A1 and T8410. From bridge 0.8.37 the app log names its model in a
line beginning with `Eufy experimental standalone:`, and from integration 0.8.46
**Download diagnostics** explains it under `standalone_admission`. That is not
a failed connection attempt. The bridge makes no attempt for such a camera. Two
other cases get neither, with the option on or off. A camera whose model the
library supports only behind a HomeBase, found without one, appears as an
`invalid_device_relationship` issue row. A camera whose model/type pair the
library does not recognize, including a known model code reported with another
type, appears as an `unsupported_device` issue row with its model code and type
in the `Eufy discovery:` report and in **Download diagnostics**, and as an
`Eufy backend: unsupported_device` line.

With the option on, the bridge connects to each admitted camera at every
discovery, normally at startup, over the same local lookup and command key it
uses for a HomeBase. From bridge 0.8.40 with client 0.30.2, an admitted camera
that answers the key request with a successful result and no key gets its
commands without encryption, so they cross your LAN readable, including the
account ID they carry, see
[key setup fields](DISCOVERY_DIAGNOSTICS.md#key-setup-fields-of-a-connection-attempt). Each camera that does not answer adds up to 20 seconds to
startup. The camera's snapshot and live view are offered as experimental
features and work only if that session works. From bridge 0.8.39 with client
0.30.1 its recordings show as not available, see below. On
[issue #152](https://github.com/keesmod/ha-eufy-cam/issues/152), live video was
reported working on two standalone T8410s, with firmware 2.3.2.4 and 2.3.1.6.
The camera on 2.3.1.6 first ended its connection at the lookup in several runs,
so a failure is still possible and useful evidence. In a report on 2026-10-16
it ended the same way, with lookup replies only from other devices in the
account, while it was unpowered. Whether it was unpowered in the earlier runs
is not known. The same report had a snapshot and live video working on a
standalone T8410C with firmware 3.3.4.4, another firmware line than the T8410
([issue #168](https://github.com/keesmod/ha-eufy-cam/issues/168),
[report](https://github.com/keesmod/ha-eufy-cam/issues/152#issuecomment-6208097780)).
On 2026-10-17 a standalone T84A1 with firmware 1.1.0.4 was reported with a
snapshot and live video with audio working
([report](https://github.com/keesmod/eufy-mega-client/issues/142#issuecomment-6236984885)).
These results are reported, not independently reproduced.
Recordings that would need a cloud key cannot be downloaded. From bridge 0.8.39
with client 0.30.1 a standalone T84A1 delivers motion and person events, see
[standalone T84A1 events](#standalone-t84a1-events). The T8410 and T8410C still
have no events, and guard mode and alarm state are not part of this route for
any of the three.

Recordings on a standalone camera are not confirmed to work. On 2026-10-15 the
issue #152 reporter's standalone T8410 on firmware 2.3.2.4 showed live view,
but "Show recordings" failed with "The HomeBase connection is unavailable. Try
again shortly." The cause was not known at the time. From integration 0.8.48
the dialog says "Recordings are unavailable for this camera right now. Try
again shortly." instead. Bridge 0.8.39-beta.1 recorded each list, calendar and
download on a standalone camera and each failed thumbnail as a
`recording_query` record that says how far it got and what the camera
answered, and integration 0.8.48-beta.1 kept these records in **Download
diagnostics**, see [failed recordings](DISCOVERY_DIAGNOSTICS.md#failed-recordings).
A download refused because it would need a cloud key showed
`recording_cipher_unavailable` as the `cause` of its playback attempt.

On 2026-10-16 the same reporter opened the recordings of three standalone
cameras with integration 0.8.48-beta.1, bridge 0.8.39-beta.1 and client
0.30.1-beta.1, with every live view closed
([report](https://github.com/keesmod/ha-eufy-cam/issues/152#issuecomment-6208097780)).
Both T8410s, on firmware 2.3.2.4 and 2.3.1.6 with a microSD card, acknowledged
the list query with `ack_code=0` but never answered it. Each such attempt ended
with `device_request_timeout` after about 16 seconds, twice per camera. The
T8410C on firmware 3.3.4.4, which has no microSD card, answered after about a
second and rejected the list with `history_rejected` and `result_code=-1100`,
twice. In the Eufy app the T8410s show only a continuous timeline and no
separate event clips, and the T8410C shows no recordings. Reported, not
independently reproduced. Recording playback on a standalone T8410 therefore
does not work with the list query 10006 that bridge 0.8.38 sent.

One reading is that a standalone T8410 on firmware 2.3.x accepts the database
query 10006 that the list sent but does not answer it. That fits the public
analog
[bropat/eufy-security-client#963](https://github.com/bropat/eufy-security-client/issues/963),
where a standalone E30 never answered 10006, and the camera's continuous-only
recording. Which request the camera answers for its continuous timeline is not
known. The reporter reads the T8410C's -1100 as the result of missing storage.
Neither reading is proven.

From integration 0.8.48 with bridge 0.8.39 and client 0.30.1
([issue #175](https://github.com/keesmod/ha-eufy-cam/issues/175)), the
recordings of a standalone T84A1, T8410 or T8410C on the experimental route
show as not available, with reason `standalone_recordings_unverified`. The
card disables its Recordings button and shows "Recordings: not available on
the standalone camera connection", in Dutch "Opnames: niet beschikbaar via de
standalone cameraverbinding". Opening the recordings no longer waits about 15
seconds before it fails, because the bridge refuses each list, calendar,
thumbnail and download before any request reaches the camera. The events card
leaves such a camera out. Snapshot and live view stay available, and HomeBase
cameras and their recordings are unchanged. With integration 0.8.47 the card
shows the generic "Recordings: unavailable for this camera connection"
instead. In **Download diagnostics** and on the `Eufy discovery:` log line, the
camera's device row has `media.recordings` with `available=false`,
`status=unsupported` and `reason=standalone_recordings_unverified`, and no
`recording_query` record appears for the camera when you open its recordings.
Only the opt-in
[standalone recording probe](#standalone-recording-probe) adds one, with
`query=probe`.

No known request lists and plays the recordings of a standalone T8410, so the
client sends none when you open the recordings. The candidates, strongest
first:

1. The database query 10017 in the shape the Eufy app sends it, with start
   time `0` and no device filter. A public report describes an iPhone app
   capture on a standalone T86P2 that answered it with rows, while the same
   camera acknowledged 10006 without answering, like the T8410s
   ([peakwellnv/eufy-bridge](https://github.com/peakwellnv/eufy-bridge/blob/4c21849/docs/RECORDINGS_RESEARCH.md),
   a public report from a repository without a licence, so nothing is copied
   from it). A variant with the camera's own serial as device filter is
   claimed to work on the standalone T8171 and T817L
   ([mscodemonkey/eufy-mega-security](https://github.com/mscodemonkey/eufy-mega-security/tree/603e668),
   `first-party-ppcs.ts`, hardware claim). The app's model descriptions
   declare 10017 for models without an event list command, and the T8410
   description lacks that command
   ([alaraun/python-eufy-home-security](https://github.com/alaraun/python-eufy-home-security/tree/a729675),
   `commands.md`, an app declaration from decompilation, not a hardware
   result). A standalone E30 answered 10017 while it stayed silent on 10006
   ([#963](https://github.com/bropat/eufy-security-client/issues/963),
   reported). None of these public sources covers a T84xx camera. Because the
   reporter's T8410s keep no event clips, an empty list was expected. The
   reported T84xx results, one listed record among them, are under
   [standalone recording probe](#standalone-recording-probe). A list would
   not play either, because no evidenced decryption path exists for a
   standalone camera's recordings. From bridge 0.8.39 the opt-in
   [standalone recording probe](#standalone-recording-probe) sends this
   request once per camera at login, so a tester can report how a camera
   answers it.
2. The count-by-date query 10008 and the latest-info query 10013 have public
   answers from standalone cameras, but they list and play nothing. They are
   diagnostic only.
3. The continuous range query 1700 with 6000, and 6001 for playback, fits a
   continuous timeline. Its only evidence is a HomeBase 3 T8030 with a T8600
   ([ferryhe/eufy-agent-hub](https://github.com/ferryhe/eufy-agent-hub),
   reported). Nothing covers a standalone or T84xx camera.
4. Variants of 10006, with the camera's own serial as device filter, channel
   255 or extra fields, have HomeBase-only evidence. 10006 stays silent on the
   standalone T86P2 and E30.
5. The commands 1041, 1042, 1025 and 1026 are rejected. No public request
   body, reply or capture exists for them, only their names, and neighbouring
   command numbers delete a recording or format the microSD card.

To test it, update the app and the integration, set `experimental_standalone`
to true in the app's configuration, restart the app, wait for the startup
result, try a snapshot and live view, then use **Download diagnostics** as
described in [discovery diagnostics](DISCOVERY_DIAGNOSTICS.md#experimental-standalone-cameras).
Turn the option off again to return to the previous behavior.

### Standalone T84A1 events

From bridge 0.8.39 with client 0.30.1
([issue #185](https://github.com/keesmod/ha-eufy-cam/issues/185)), a standalone
Wall Light Cam S100 `T84A1` on the experimental route fires its event entity
and the `eufy_viewer_event` automation event for motion and person, as a
camera behind a HomeBase does, see [camera events](NOTIFICATIONS.md). It needs
no other option than `experimental_standalone`. Integration 0.8.48 is not
needed for the events, only for the push counts in **Download diagnostics**.

- The client admits a push only when its device and station serial both name
  the camera, its type is 151 and its event code is 3101 (motion) or 3102
  (person). It refuses every other push, including guard mode, alarm, microSD
  and pushes it cannot decode.
- A standalone camera gets no guard mode, alarm or microSD state, and its
  person events have `recognition: unidentified` without a name.
- An event opens no camera connection and loads no image. It brings no new
  event image, and it does not refresh the camera's snapshot. Use **Refresh
  snapshot** or live view for a new picture.
- A standalone `T8410` or `T8410C` has no events. Its pushes are refused and
  counted with `events_not_enabled`.
- HomeBase cameras and their events are unchanged.

This is experimental. Its tests use synthetic pushes, and no standalone T84A1
push has been captured yet, so the result on hardware is pending. To report
it, turn on `experimental_standalone`, trigger motion and a person in front of
the camera, check that the Eufy app shows the event and whether Home Assistant
shows the matching event on that camera and on no other camera, then take
**Download diagnostics** and read
`support.standalone_pushes` as described in
[standalone push counts](DISCOVERY_DIAGNOSTICS.md#standalone-push-counts).

### Standalone recording probe

From bridge 0.8.39 with client 0.30.1, the app option
`standalone_recording_probe: true` (Docker:
`EUFY_STANDALONE_RECORDING_PROBE=true`) sends the first candidate above, the
database query 10017 in the shape the Eufy app sends it, to each experimental
standalone camera
([issue #178](https://github.com/keesmod/ha-eufy-cam/issues/178)). It is a
diagnostic that is off by default, and it needs `experimental_standalone` on
as well. With only the probe option on, the bridge logs a note at startup and
probes nothing. The option stays in stable releases as a documented
diagnostic, off by default.

What it sends and when:

- One read-only request per camera, right after the camera's connection in
  the login discovery. That discovery runs when the bridge starts or restores
  its saved session, and when you log in with credentials. A camera whose
  connection failed is not probed. A discovery after a cloud reconnect sends
  no probe, so a camera that was offline at startup is probed at the next
  restart. A login that is retried after a failure probes again.
- The request asks for the newest 20 records of today on channel 0, with start
  time `0` and no device filter. Today is the local date of the bridge host,
  which depends on the time zone of the app or Docker container. Clips from
  earlier days are not requested.
- It only reads. It downloads and deletes nothing, and the integration gets
  no recordings from it. It sends nothing to a HomeBase or to a camera behind
  a HomeBase. All other requests and their payloads are unchanged. Recordings
  on the standalone cards stay "not available" with the option on or off.

What it costs:

- The bridge reports ready only after its login discovery, so each standalone
  camera adds up to about 15 seconds after its connection to startup. Home
  Assistant shows the integration as connecting until then. In a setup that
  also has a HomeBase, its cameras wait too.
- Turn the option off before you enter your Eufy credentials again in Home
  Assistant, for example to reauthenticate. That login waits for the
  discovery, and Home Assistant gives up after about a minute with "Cannot
  communicate with the bridge" while the bridge still finishes.
- When a camera does not answer within 15 seconds, its session is closed, as
  after any timed-out query. Live view connects again when you open it.
  Opening the snapshot does not connect, so it keeps its last picture, if any,
  until a live view replaces it. The app log then shows a `station_connection`
  line with `"phase":"observation"` and `"status":"disconnected"` just before
  the probe line, and the camera's device row in that report shows
  `"owner_status":"disconnected"`. The assessment in **Download diagnostics**
  then lists a `standalone_connection` finding saying that the camera connected
  and its session later closed. That is the probe's close, not a connection
  fault. An answer, also a rejection, keeps the session open.

Each probed camera leaves one `recording_query` line with `"query":"probe"` in
the app log, and the discovery `summary` line has
`"standalone_recording_probe":true`. How to collect and read them is in
[discovery diagnostics](DISCOVERY_DIAGNOSTICS.md#standalone-recording-probe).
Integration 0.8.48 or newer keeps both in **Download diagnostics**.
Integration 0.8.48 betas from before the probe replace the record's `query`
with `null`
and drop the summary field, and integration 0.8.47 drops the record. The app
log shows both in full with any integration.

On 2026-10-23 the issue #152 reporter ran the probe with bridge 0.8.39 on
three standalone cameras ([report](https://github.com/keesmod/ha-eufy-cam/issues/178#issuecomment-6372936541)).
The T8410 with firmware 2.3.2.4 answered with an empty page for that day. The
T8410 with firmware 2.3.1.6, which has a microSD card, and the T8410C without
one rejected it with `result_code=-1100`. In an earlier beta run on
2026-10-19 one of the two T8410s listed one record of its own for that day.
So both T8410s answer this query, where neither answered the list query
10006. One record in three quoted T8410 probes over two runs, with an empty
page and a rejection in the others, is too little evidence to open
recordings, and the client has no playback path for a standalone camera's
records. Their recordings stay not available. Reported, not independently
reproduced. The readings are in the
[model matrix](https://github.com/keesmod/eufy-mega-client/blob/main/docs/MODEL_MATRIX.md#reported-standalone-recording-probe-results-2026-10-23).

## Recovery and maintenance

- Use the integration's **Reconfigure** action when the bridge address or token changes. Its stable bridge ID must match.
- Complete the HA **Reauthenticate** flow if the Eufy account or bridge token requires attention.
- During startup, Home Assistant waits for the bridge to restore its saved Eufy session. Temporary network failures during initialization are retried automatically, they do not require entering your credentials again.
- On bridge connection loss, entities become unavailable and all live viewers end. The local push socket reconnects with bounded backoff, media never automatically restarts.
- If a camera does not confirm stopping, the bridge makes at most three stop attempts. Once all viewers and pending starts have left, it makes one attempt to close the HomeBase connection and waits for confirmation before allowing playback again. A failed recovery keeps the affected session blocked. If the recording dialog says the previous live session is still stopping, wait about ten seconds and load the date again. Persistent failures require checking the bridge state, they do not trigger a polling or restart loop.
- A camera removed from Eufy becomes unavailable in HA, its registry entry is preserved so reappearance keeps IDs. Remove obsolete devices through HA's normal UI.
- Snapshot age is normal when there has been no new event. This integration does not wake a camera by itself to make an old snapshot look fresh. Press the camera's **Refresh snapshot** button for a new one, see [snapshot limits](#honest-snapshot-and-streaming-limits).

## Dependencies

| Component | Runtime requirements |
|---|---|
| Integration | Home Assistant ≥ 2026.9.0, built-in `camera`, `http`, `lovelace`, `web_rtc`, `websocket_api`, `go2rtc-client` 0.4.0 or newer (installed automatically), HA-managed `go2rtc` for WebRTC |
| Card | Bundled JavaScript, Home Assistant frontend and a modern browser, no separate frontend runtime package |
| Bridge | Node.js 24, FFmpeg and tini, all included in the app/container |
| Bridge libraries | `@keesmod/eufy-mega-client` from its checksum-pinned GitHub release and `ws`. The release notes name the bundled client version. Mega retains MIT and Apache-2.0 attribution. Dependencies are pinned by `bridge/package-lock.json`. |
| External services | Eufy account with camera access, Eufy cloud/push connectivity and local connectivity to camera/HomeBase |

No MQTT, separately installed RTSP server, existing Eufy integration or `eufy-security-ws` app is required. WebRTC uses HA's managed go2rtc and its FFmpeg audio conversion. Upgrade the bridge and integration together for the new transport. A dedicated shared Eufy account is recommended for ongoing use. Simultaneous operation with another Eufy client using the same account has only been briefly observed, not long-term validated. TypeScript, Playwright and Python test tools are development-only dependencies.

Maintainers use the [validated release flow](RELEASING.md) for both repositories. HACS updates the integration, the app store or Docker updates the bridge. A library release reaches HA only after a separately tested bridge release.

See [architecture and safety](ARCHITECTURE.md), [bridge protocol](PROTOCOL.md), [development](DEVELOPMENT.md) and [validation](VALIDATION.md).

## Existing HomeBase recordings

Previous release hardware evidence covers HomeBase 3 T8030 firmware 3.8.6.0 through Mega 0.10.0. The later 0.8.0 acceptance is recorded in [camera #31](https://github.com/keesmod/ha-eufy-cam/issues/31). The bridge uses the working calendar query `10006` with an empty device filter and `[selected day, next day]`, then filters returned records to the authorized camera. Legacy `10017` is not used. Only device-returned paths can be downloaded, the browser receives opaque expiring IDs.

The bridge expands the existing query limit to retrieve the selected day on the tested HB3 firmware. Ambiguous boundaries, inconsistent responses and the final safety ceiling are reported as errors instead of silent truncation. Firmware-wide pagination and bulk retention/export completeness are not claimed. One query or download runs at a time, close live viewers before loading recordings. The recording operation remains bounded to 60 seconds. Compressed downloads retain the client's 32 MiB limit. Converted output and HA playback use separate storage allowances described in [recording storage](RECORDING_STORAGE.md). No permanent video archive is kept. Failed requests require an explicit retry. See [recording protocol and live evidence](RECORDINGS_PROBE_2026-09-06.md).

### Live-stream diagnostics

In the bridge app configuration, enable `diagnostics: true`, save and restart
that app. The option defaults to false and older saved configurations may omit
it. Reproduce one live-view attempt and copy the lines containing
`"diagnostic":"live"` from the app logs. Disable the option and restart after
collecting the evidence. It applies to the Mega backend.

For Docker, set `EUFY_DIAGNOSTICS=true` and recreate the bridge container with
its existing data volume. Remove it or set it to `false` afterward.

From bridge 0.8.20 the live WebRTC encoder is bounded at 4 Mbit/s. Change it
with the optional app option `live_max_bitrate` (Docker: `EUFY_LIVE_MAX_BITRATE`),
for example `2500k` for a weaker WiFi viewer or `8M` for a wired one. Values
between `200k` and `50M` are accepted. Other values stop the bridge at startup.
The cap applies at the camera's announced frame rate, so a HomeBase that delivers
more frames than it announces uses proportionally more. Live audio no longer
depends on the camera sending audio within three seconds: it is delivered on its
own route whenever it starts, so there is nothing to configure for it.

Each attempt has a temporary number and elapsed milliseconds. `video_input`
and `audio_input` mean input bytes arrived, not that decoding succeeded.
`jpeg_frame` and `media_output` identify output from the two encoders.
`media_reader` means a client requested the media stream, not that it played.
`frame_ack` means the viewer acknowledged a delivered frame. `viewer_timeout`
means that acknowledgement deadline expired. `snapshot_refresh` means a
**Refresh snapshot** press attached to that live session. `camera_timeout`
means the camera frame deadline or the maximum viewing duration expired (120 s, or the
configured `live_max_seconds_mains` for a camera without a battery value), so a
session that reaches the cap ends with `camera_timeout`, `stream_failure` and
`session_end` by design. `stream_failure` is a general termination category. Encoder error, exit, invalid-data and
decode-error categories narrow the failure without exposing raw FFmpeg text.

Diagnostics emit each category once per attempt and never include device
identifiers, tokens, addresses, media grants, images or raw SDK/encoder errors.
Attempt numbers reset when the app restarts. Ordinary logs from other components
are outside this filter, so review any additional logs before sharing them.
This option does not change timeouts, keep cameras awake or enable SDK debug.

### Automatic live-video fallback

When WebRTC signaling, connection or playback fails, the viewer switches once
to live JPEG through the existing authenticated HA connection. The live view
shows **Live video without sound** (below the camera name for an inline card)
and hides its audio button. WebRTC is kept
when it works. The next explicit opening can try WebRTC again.

The bridge initiates fallback five seconds before the initial viewer deadline
(normally after 15 seconds for a new stream, or five seconds when joining an
existing stream), or six seconds without a subsequent playback acknowledgement.
These thresholds leave room to display JPEG within the existing 20/10-second
viewer deadlines. Switching
never extends those deadlines, starts another camera or resets the
maximum session lifetime. Hidden or disconnected viewers still expire.

Each viewer switches independently. Other viewers can continue using WebRTC.
HA logs a fixed fallback reason, and optional bridge diagnostics add matching
`fallback_*` categories. No raw ICE candidates, upstream error text or tokens
are logged. This does not add audio to JPEG or change network-provider terms.
Upgrade the integration and bridge together for this protocol capability.
