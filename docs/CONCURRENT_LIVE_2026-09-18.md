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
