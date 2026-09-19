# Three concurrent live cameras through the bridge, 2026-09-19

Supervised physical test on the maintainer's Home Assistant OS bench for
[issue #94](https://github.com/keesmod/ha-eufy-cam/issues/94), which continues
the four-autostart-card browser test of 2026-09-18 where two eufyCam 3 played and
the third admitted camera timed out at startup (see the
[four autostart cards record](CONCURRENT_LIVE_2026-09-18.md#four-autostart-cards-in-a-browser-2026-09-18)).
The test ran with the bridge option `live_max_streams_per_station: 3` and bounded
live diagnostics, both restored to their pre-test values afterwards
(`live_max_streams_per_station: 4`, diagnostics off) with a bridge restart. A
Supervisor partial backup of the bridge app and a private copy of its options and
data were taken first. This record is sanitized: no identifiers, names or
captures.

## Bench

| Item | Value |
|---|---|
| Home Assistant | HA OS, Core 2026.9.2, amd64 |
| Host | 2-core Intel Xeon D-2141I at 2.20 GHz, 16 GB, software transcoding (no GPU) |
| Bridge | Supervisor app 0.8.21, client 0.13.0, Node 24.21.0, `live_max_streams_per_station: 3` for the test, bounded diagnostics on |
| Station | T8030 HomeBase 3, firmware 3.8.7.4, connected over the LAN |
| Cameras | Three T8160 eufyCam 3, firmware 3.4.3.0 (A battery 85, B 26, C 14), and one T8213 doorbell, firmware 0.2.1.8, all on that HomeBase |
| Viewers | Direct bridge websocket viewers on the JPEG transport (`/v1/live/{serial}`), each acknowledging every frame, run from inside the bridge container. No Home Assistant or browser viewer was open. |
| Sampling | Host CPU from `/proc/stat`, container ffmpeg/node CPU and process count from `docker top`, about every 2 seconds, plus the bridge diagnostics log per attempt |
| Backups | Supervisor partial backup of the bridge app and a private copy of the app data and options before the change |

## Method

Three bounded rounds, each far below the two-minute lease, every viewer
acknowledging every frame, a local close never counting as a stop. The bridge
was confirmed at 0 active and 0 quarantined between rounds.

1. Staggered: open A, then B after 5 s, then C after 5 s, hold all three about
   20 s, close C, B, A with 5 s between.
2. Simultaneous: open A, B and C within the same second, hold about 20 s, close
   all three 1 s apart.
3. Simultaneous with the doorbell: open D (T8213), A and B within the same
   second, hold about 20 s, close them 1 s apart, to add a HEVC source and a
   different camera model to the three concurrent sessions.

## Observations

All three admitted cameras delivered video in every round. There were no startup
timeouts, no `stream_failure`, no stop retries, no recovery attempts and no
quarantine. Every session ended with a device-confirmed stop.

| Round | First frame per camera (ms after request) | Concurrent window | Stops and counters |
|---|---|---|---|
| 1 staggered | A 1997 (alone), B 3282 (2 up), C 4004 (3 up) | 3 active, ~6 to 8 JPEG fps each | 3 start, 3 stop, 3 started, 3 stopped, 0 recovery, 0 quarantined, settled |
| 2 simultaneous | A 2790, B 3861, C 5199 | 3 active, ~6 to 9 fps each | +3 start, +3 stop, +3 started, +3 stopped, 0 recovery, 0 quarantined, settled |
| 3 simultaneous with doorbell | A 3937, D 5153 (HEVC), B 5095 | 3 active (2 eufyCam 3 plus the doorbell), ~5 to 8 fps each | +3 start, +3 stop, +3 started, +3 stopped, 0 recovery, 0 quarantined, settled |

Per-attempt diagnostics were identical in shape for all nine sessions:
`start` -> `video_input` -> `jpeg_frame` -> `media_output` -> `frame_ack`, with
`media_active_software`. Late audio was admitted on every attempt
(`audio_late`, initial codec AAC, largest inter-frame gap under 1.2 s). The
doorbell delivered HEVC, the eufyCam 3 delivered H.264. The live-audio report
recorded `stop_confirmed: true` for all nine attempts.

### Host CPU

| Streams | Host CPU | ffmpeg processes | ffmpeg CPU |
|---|---|---|---|
| 1 camera | ~40 to 55 percent | 2 | ~85 to 95 percent |
| 2 cameras | ~72 to 91 percent | 4 | ~160 to 200 percent |
| 3 cameras | 100 percent (saturated) | 6 | ~176 to 209 percent |

Each concurrent camera runs two ffmpeg processes on the host: the live
transcoder that produces the WebRTC MPEG-TS and the JPEG encoder that produces
the fallback frames. Three cameras therefore run six ffmpeg processes, which
fully use both cores of this host. The 1-minute load average rose to about 2.2
during the three-camera windows. Even at 100 percent CPU the bridge delivered
first frames in about 4 to 5.2 seconds and held roughly 6 to 8 JPEG frames per
second per camera, well inside the 20-second startup deadline and the 10-second
processed-frame lease.

### Station afterwards

Station connected, guard mode and current mode unchanged, push connected,
account connected, 0 active and 0 quarantined after every round and after the
restore.

## What this shows

- The T8030 HomeBase 3 (firmware 3.8.7.4) and the bridge deliver three
  concurrent eufyCam 3 live streams on the bridge's own viewer path, with
  device-confirmed stops. Neither the HomeBase, the three P2P sessions, nor the
  bridge encoder is a two-stream limit on this bench. The client opens one
  independent P2P session per further camera and all three reached `frame_ack`
  together in every round.
- The third-stream startup timeout seen in the 2026-09-18 four-card browser test
  did not occur on the bridge's own viewer path. In that browser test the third
  admitted camera fell back to JPEG with `startup_timeout` and no frame. The
  diagnostics here reach `video_input`, `jpeg_frame`, `media_output` and
  `frame_ack` for every stream, so the stall was not in the HomeBase, the P2P
  media, or the bridge encoder. It was on the consumer side of the WebRTC path
  (Home Assistant go2rtc and the browser), aggravated by host CPU headroom:
  software transcoding of three streams already saturates this 2-core host, and
  go2rtc adds its own per-stream ffmpeg plus the browser's decode, which delays
  the third stream's first playable frame past the card's startup fallback
  window. A direct JPEG viewer that acknowledges frames as they arrive has no
  such consumer-side delay and so it does not time out.
- This is consistent with the external second-HomeBase report on #94, where all
  three streams reached `frame_ack` on a GPU host with the CPU near idle and the
  third stream only intermittently hit `fallback_startup_timeout`, and where a
  Home Assistant side change to the card lifecycle let all three play.

## The 2026-09-18 stop retries and failed recovery explained

The four-card browser test of 2026-09-18 ended with 11 stop requests for 8
starts, one failed recovery and one camera quarantined until the bridge restart.
That behaviour follows from the stop and recovery path in `bridge/src/streams.ts`
and `bridge/src/mega-backend.ts`, and it did not recur in this run because every
session here reached playback and stopped cleanly:

- When a session ends, `StreamHub.end` sets the camera to `stopping` and calls
  `requestStop`, which issues `control.stop` and schedules a retry 3 seconds
  later, up to three attempts. A session that ended at startup without ever
  playing (the browser test's timed-out third camera, and a resume issued 1.5 s
  after a pause on a station still tearing the previous session down) had to have
  its device STOP confirmed while two other P2P sessions were active on the same
  HomeBase. When that confirmation is slow or a UDP packet is lost, the retries
  in `tick` fire, which is the source of the extra stop requests.
- After three retries with no confirmed stop, and only once no camera is active
  and no start is pending, the hub calls `control.recover` once. That maps to
  `recoverStation` -> the client's `ensureLiveStopped`, which connects, confirms
  the STOP, closes the station session and reconnects it. If that stop stays
  unconfirmed the recovery rejects, the metric records one failed recovery, and
  the camera stays in `stopping` (counted as quarantined) with no retry loop
  until the bridge restart clears it. This is the intended bounded behaviour, not
  a crash, and it protects against a new start racing an unconfirmed stop.
- In this run all nine stops were device-confirmed on the first request
  (`stop_requests` equalled `stopped_events` at every step, 0 recovery attempts,
  0 quarantined), so the retry and recovery paths were never entered. The
  difference from 2026-09-18 is that these viewers acknowledge every frame and
  never trigger a WebRTC fallback, so no session ended at startup on a contended
  station.

## Limits of this evidence

One installation, one firmware tuple, three eufyCam 3 plus one doorbell, three
rounds of about 20 to 40 seconds each on the JPEG transport with no browser
viewer. This verifies three concurrent streams through the bridge's own viewer
path, not three concurrent WebRTC streams in a browser, which on this
software-transcoding bench still timed out on the third card in the 2026-09-18
test and remains unverified. Host CPU saturates at three software-transcoded
streams on this 2-core host, so a slower host or a fourth stream would leave
even less headroom. NVENC and four streams were not tested. The doorbell was
included only as a third HEVC source in round 3.

## External second-HomeBase data point (reported)

Reported by an external tester on #94 on 2026-09-18 and 2026-09-19, sanitized and
not independently reproduced by the maintainer. Second HomeBase 3, T8030 firmware
3.8.5.2, cameras T8416 (1.5.6.4), T8417 (1.2.2.2) and T8425 (1.6.4.6), NVIDIA
T600 hardware transcoding, bridge 0.8.21, client 0.13.0, integration 0.8.23,
`live_max_streams_per_station: 3`, diagnostics on. Three streams reached
`media_active_nvidia`, `media_output` and `frame_ack` together with three ffmpeg
processes on the T600, GPU memory about 764 of 4096 MiB and GPU utilisation about
7 percent, so neither the HomeBase nor the GPU was a two-stream limit. The third
stream intermittently hit `fallback_startup_timeout` then `stream_failure`, all
three sometimes hit `fallback_playback_timeout` at 13 to 18 seconds, and sessions
ended with `no_viewers`. The tester attributed the `no_viewers` churn to cards
stopping when they scrolled out of view and reported that a Home Assistant side
change to the card lifecycle then let all three cameras play at once, with go2rtc
`unexpected EOF` logged on audio at some stops. Source: the tester's comments on
issue #94.
