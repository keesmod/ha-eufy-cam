# Two concurrent live cameras through the bridge, 2026-09-18

Supervised physical test on the maintainer's production installation after the
deployment of bridge 0.8.21 (client 0.13.0) for
[issue #84](https://github.com/keesmod/ha-eufy-cam/issues/84). The test ran with
the bridge option `live_max_streams_per_station: 2` and bounded live diagnostics.
Both were restored to their previous values afterwards. This record is sanitized:
no identifiers, names or captures.

## Bench

| Item | Value |
|---|---|
| Home Assistant | HA OS, Core 2026.9.2, amd64 |
| Bridge | Supervisor app 0.8.21, client 0.13.0, Node 24.21.0, software transcoding |
| Integration | 0.8.20, unchanged for this test |
| Station | T8030 HomeBase 3, firmware 3.8.7.4, connected over the LAN |
| Cameras | Three T8160 eufyCam 3, firmware 3.4.3.0, on that HomeBase. A T8213 doorbell on the same HomeBase was not used. |
| Viewers | Direct bridge websocket viewers on the JPEG transport (`/v1/live/{serial}`), each acknowledging every frame, run from inside the bridge container. No Home Assistant viewer was open. |
| Backups | Supervisor partial backup of the app and a private copy of the app data and options before the change |

## Method

One script opened camera A, kept it alone for 5 seconds, opened camera B while A
was live, attempted camera C at the limit, held A and B for 15 seconds, closed
B, kept A for 5 more seconds, closed A, then waited for the bridge to settle.
Every attempt stayed far below the two-minute lease. A local close, socket end
or timeout never counted as a stop.

## Observations

| Step | Result |
|---|---|
| A alone | First JPEG frame 2.6 s after the request, 47 frames in the first 7.8 s |
| B while A is live | Admitted, first frame 3.1 s after the request, A unaffected |
| C at the limit | Refused before any device command: WebSocket close 4013 `HomeBase live limit reached`, no frame, no start |
| 15 s concurrent window | A 119 frames, B 116 frames (about 8 frames per second each, the JPEG cap), 2 active cameras, 0 quarantined, station connected |
| Close B | Device-confirmed stop, A continued with 41 frames in the next 5 s |
| Close A | Device-confirmed stop, bridge settled within 1 s to 0 active and 0 quarantined |
| Counters | 2 start requests, 2 stop requests, 2 started and 2 stopped events, 0 recovery attempts, no faults |
| Station afterwards | Connected, guard mode and current mode unchanged, push connected, account connected |
| Snapshots | Updated for A and B from their last live frame, unchanged for C |
| Diagnostics | Both live attempts `ended` with `stop_confirmed: true`, AAC audio admitted on each |
| Home Assistant | Camera entities returned to idle after each bridge restart, one expected "Bridge disconnected" log line per restart, no other errors |

## Limits of this evidence

One installation, one firmware tuple, two of three cameras, one attempt of about
32 seconds. The JPEG transport was used because no browser viewer took part, so
WebRTC playback of two concurrent cameras in a dashboard is not shown here.
Bridge CPU and NVENC load were not measured. Three or four concurrent streams
remain unverified and are not claimed. The option was reset to its default of 1
after the test.

## Two inline cards in a browser, 2026-09-18

Second supervised test on the same installation, after the integration was
updated to 0.8.22 with the inline live mode of
[issue #87](https://github.com/keesmod/ha-eufy-cam/issues/87), with a backup of
the 0.8.20 integration taken first. The bridge stayed at 0.8.21 with client
0.13.0 and its option `live_max_streams_per_station` at 4, which the maintainer
had set earlier that day. No diagnostics option was changed. The viewers were
two Eufy Security Viewer cards with `live_mode: inline` side by side in a
temporary panel view of a Chromium browser on the LAN, removed after the test.
This record is sanitized: no identifiers, names or captures.

### Bench

| Item | Value |
|---|---|
| Home Assistant | HA OS, Core 2026.9.2, amd64 |
| Bridge | Supervisor app 0.8.21, client 0.13.0, option `live_max_streams_per_station: 4`, software transcoding |
| Integration and card | 0.8.22, card resource `?v=0.8.22` |
| Station | T8030 HomeBase 3, firmware 3.8.7.4, connected over the LAN |
| Cameras | Two T8160 eufyCam 3, firmware 3.4.3.0, on that HomeBase |
| Browser | Chromium on a Mac on the LAN, WebRTC through Home Assistant's go2rtc with HA's ICE configuration, host candidates over UDP, no relay |

### Method

Tap camera A, wait about ten seconds, tap camera B while A is live, hold both
for about a minute, enable sound on B, close B while A continues, close A after
about 100 seconds, then read the bridge counters, the integration's live
diagnostics and the camera snapshots. Card state was read from the page: the
open flag, stage visibility, dialog state, decoded video size and the tick and
acknowledgement counters. Both cards were closed explicitly, so the two-minute
cap was not reached.

### Observations

| Step | Result |
|---|---|
| A alone | Inline, no dialog, WebRTC 1920 by 1080, first "playing" report 3.2 s after the tap, 63 painted frames and 24 acknowledged ticks after 9 s, late audio attached as Opus |
| B while A is live | Admitted, inline, WebRTC 1920 by 1080, first "playing" report 4.5 s after the tap, bridge started event 4.0 s after the start request, late audio attached. A unaffected, its ticks continued from 174 to 235 across B's start |
| Concurrent window | Bridge 2 active cameras, 0 quarantined, station connected. 11 to 14 painted frames and 5 to 6 acknowledged ticks per second per card |
| Sound on B | Element unmuted with one audio track, 2899 audio packets received with energy |
| Close B | B returned to its snapshot with no status message, A continued to 621 accepted ticks and 1371 painted frames at 100 s |
| Close A | Both cards back at their snapshots with no media stream and no dialog |
| Counters | 2 start requests, 2 stop requests, 2 started and 2 stopped events, 0 recovery attempts, 0 active, 0 quarantined. The last stop request and its stopped event were 23 ms apart |
| Integration diagnostics | Two attempts with card version 0.8.22, 636 and 366 ticks each fully acknowledged, ICE host to host over UDP, audio negotiated late on both |
| Snapshots | Both updated from the last live frame at the moment each card closed |
| Home Assistant | No errors in the log, camera entities idle afterwards |

### Limits of this evidence

One installation, one firmware tuple, two of three cameras, one attempt of
about 100 seconds in one browser. Three or four concurrent streams remain
unverified. CPU and NVENC load were not measured. The option stayed at 4
because that is the installation's current setting, so the refusal at the
limit was not exercised in the browser. It is covered by the card suite and by
the JPEG test above.
