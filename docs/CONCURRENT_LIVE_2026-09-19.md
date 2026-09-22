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
  change to the lifecycle of the tester's own local card, not the bundled card,
  let all three play.

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
stopping when they scrolled out of view and reported that removing the stop on
scroll out and on page hide from his own local card, not the bundled card, then
let all three cameras play at once, with go2rtc `unexpected EOF` logged on audio
at some stops. On 2026-09-19 he also reported a session on one camera that ended
at 120 s with `camera_timeout`, `stream_failure` and `session_end` and a new
session started by his card at once, which is the documented two-minute cap
followed by that card's own restart, and he shared the integration's redacted
diagnostics download: all three cameras are mains powered, seven of the last
eight attempts carry no card report, and the discovery events hold eight HomeBase
disconnect and reconnect pairs between 08:04 and 08:58 UTC after the start-up
connection, each reconnecting within about a second, in a list capped at 22
events. A second download of the same day, after a bridge restart at 19:03 UTC
and the 30-minute session of integration 0.8.27, held four pairs that all match
the bridge's four completed recoveries and none during the session, see the
0.8.27 mains powered session in [COMPATIBILITY.md](COMPATIBILITY.md). Source:
the tester's comments on issue #94.

### The 0.8.28 session of 2026-09-20 (reported)

Same tester, HomeBase and T8425, now bridge 0.8.23 with client 0.14.0,
integration 0.8.28, NVIDIA transcoding, `live_max_seconds_mains: 1800`, Google
Chrome 153 on Windows, one camera, page visible, no guard mode change. Bridge
pipeline: `frame_ack` 2285 ms, `fallback_playback_timeout` 54626 ms,
`camera_timeout` 1800218 ms, `stream_failure` and `session_end` 1800219 ms.
Audio row: 28111 AAC chunks, last data at 1800157 ms, largest gap 627 ms, stop
confirmed. The card's four samples of the WebRTC leg, cumulative `getStats`
inbound video counters, with the jitter buffer wait per frame computed over the
frames emitted since the previous sample:

| Sample | Elapsed | Frames received / decoded / dropped | Painted | Keyframes | PLI | Lost / NACK | Wait per frame | Target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `playing` | 2.3 s | 7 / 3 / 0 | 1 | 1 | 0 | 0 / 0 | 6 ms over 3 frames | 12 ms |
| `startup` | 6.8 s | 63 / 63 / 0 | 58 | 3 | 0 | 0 / 0 | 54 ms over 60 frames | 47 ms |
| `audio_check` | 16.8 s | 172 / 155 / 0 | 148 | 6 | 1 | 0 / 0 | 635 ms over 92 frames | 42 ms |
| `fallback` | 54.6 s | 645 / 552 / 68 | 540 | 20 | 8 | 0 / 0 | 914 ms over 426 frames | 48 ms |

- Connection and ICE were `connected` at every sample, host to host over UDP.
  RTP jitter 5 to 43 ms. 15.7 MB of video by 54.6 s, 2.5 Mbit/s over the last
  interval under the 4M cap. The last painted frame was 6009 ms before the
  fallback sample, at about 48.6 s. Ticks 306, acknowledgements 305.
- At the first three samples every frame that left the jitter buffer was
  decoded. At the fallback sample 581 frames had left the buffer and 552 were
  decoded.
- The frames arrived at 11 to 12.5 per second and the 20 keyframes match the
  encoder's `-g 30`, one every 2.6 s. A PLI from the browser cannot reach an
  HTTP MPEG-TS source through go2rtc, so after a break in decoding the browser
  waits for the encoder's next periodic keyframe.
- The same PC's short attempt 40 s earlier was healthy at 6.3 s: 67 frames
  received and decoded, 36 ms per frame against a 52 ms target, no PLI, then
  `no_viewers` at 11.3 s.
- The maintainer's bench samples of 2026-09-14 with software transcoding show
  45 to 57 ms per frame at 7 s against a target of 64 to 78 ms, no dropped
  frame and no PLI. The 0.8.11 report that led to the arrival-time stamps of
  0.8.20 showed the same kind of growth, 48 to 238 ms in four seconds with
  zero loss, see [live diagnostics](LIVE_DIAGNOSTICS.md).

The P2P session ran for the whole 1800 s, the JPEG frames behind the ticks and
the AAC row prove it. Until the fallback the encoder, the bridge's HTTP source
and go2rtc's input were delivering, 15.7 MB of video reached the browser by
54.6 s, and go2rtc logged its `unexpected EOF` only at the moment the bridge
revoked the grant, see the 0.8.28 session in
[COMPATIBILITY.md](COMPATIBILITY.md). The WebRTC leg degraded in the browser's
receive path from about 7 s on, in episodes that held frames far beyond the
target, dropped them and asked for keyframes, until one episode passed 6 s
without a painted frame. The four samples cannot separate an H.264 stream from
the T600 that the browser's decoder rejects intermittently from decoding or
timing on that PC. One attempt with software transcoding, one attempt in the
same browser with hardware video decoding off, and the `decoderImplementation`,
`freezeCount` and `totalFreezesDuration` values of `chrome://webrtc-internals`
are the discriminators, see #94. Source: the tester's comment and redacted
download on issue #94.

### The 0.8.29 attempts of 2026-09-22 with the decoder and the encoder swapped (reported)

Same tester, HomeBase and T8425, bridge 0.8.23 with client 0.14.0, integration
0.8.29, Home Assistant 2026.9.3 on Home Assistant OS 18.3 in a VM,
`live_max_streams_per_station: 3`, diagnostics on, Google Chrome 153 on
Windows, one camera, page visible, no guard mode change. The two discriminating
attempts of the 2026-09-20 analysis, both reproducing the fallback: first with
the browser's hardware video decoding disabled in `chrome://flags` and
`live_acceleration: nvidia`, where the tester read
`decoderImplementation=FFmpeg`, `powerEfficientDecoder=false`, `codec=H264` and
`profile-level-id=42001f` in `chrome://webrtc-internals`, then with hardware
decoding restored and `live_acceleration: software`, the bridge recreated for
the option and the value verified in the running container, and recreated
again to restore `nvidia` after the test. One redacted download 56 s after that
last bridge start holds eight attempt rows. Times are UTC on the bridge's
clock, the download's `generated_at` of 11:17:51 minus each row's `age_ms`.
Per interval, the wait per frame is the jitter buffer delay over the frames
emitted since the previous sample, the decode time is `video_decode_ms` over
the frames decoded since the previous sample, and the freezes are cumulative.
The go2rtc column is `source_h264_packets` / `output_h264_packets` of the
relay row taken with the sample.

| Attempt | Start | Browser decoder | Bridge encoder | Outcome |
| --- | --- | --- | --- | --- |
| A | 11:08:31.6 | FFmpeg software, read by the tester | NVIDIA, tester's report | `fallback_playback_timeout` at 20.828 s |
| B | 11:09:36.0 | FFmpeg software | NVIDIA | `fallback_playback_timeout` at 50.904 s |
| C | 11:12:53.2 | hardware, restored | software, tester's report | no fallback, three samples to 16.6 s, 176 ticks and 176 acknowledgements, end not in the download |
| D | 11:15:25.5 | hardware | software | `fallback_playback_timeout` at 54.201 s |

Attempt A, last painted frame at 15.07 s, 4157 video packets and 4785975 bytes
at both of the last two samples, audio packets 787 at 17.2 s and 966 at 20.8 s:

| Sample | Elapsed | Frames received / decoded / dropped | Painted | Keyframes | PLI | Lost / NACK | Freezes | Wait per frame | Target | Decode per frame | go2rtc H.264 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `playing` | 3.2 s | 9 / 3 / 0 | 1 | 1 | 0 | 0 / 0 | 0 | 10 ms over 4 frames | 50 ms | 5.7 ms | 11 / 11 |
| `startup` | 7.2 s | 89 / 88 / 0 | 82 | 3 | 0 | 0 / 0 | 0 | 40 ms over 84 frames | 39 ms | 3.3 ms | 89 / 89 |
| `audio_check` | 17.2 s | 204 / 204 / 0 | 198 | 7 | 0 | 0 / 0 | 1 of 235 ms | 66 ms over 116 frames | 64 ms | 3.3 ms | 204 / 204 |
| `fallback` | 20.8 s | 204 / 204 / 0 | 198 | 7 | 1 | 0 / 0 | 1 of 235 ms | no frame | | | no row |

Attempt B, last painted frame at 44.9 s, 15.5 MB of video by 50.9 s:

| Sample | Elapsed | Frames received / decoded / dropped | Painted | Keyframes | PLI | Lost / NACK | Freezes | Wait per frame | Target | Decode per frame | go2rtc H.264 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `playing` | 2.0 s | 7 / 1 / 0 | 1 | 1 | 0 | 0 / 0 | 0 | 7 ms over 2 frames | 12 ms | 8.0 ms | 7 / 7 |
| `startup` | 6.1 s | 45 / 39 / 0 | 35 | 2 | 0 | 0 / 0 | 2 of 1715 ms | 148 ms over 38 frames | 40 ms | 3.6 ms | 45 / 45 |
| `audio_check` | 16.1 s | 194 / 187 / 5 | 181 | 7 | 0 | 0 / 0 | 3 of 2222 ms | 398 ms over 147 frames | 80 ms | 3.3 ms | 195 / 195 |
| `fallback` | 50.9 s | 621 / 615 / 6 | 608 | 21 | 1 | 0 / 0 | 4 of 2533 ms | 199 ms over 428 frames | 65 ms | 3.5 ms | no row |

Attempt C, no fallback sample:

| Sample | Elapsed | Frames received / decoded / dropped | Painted | Keyframes | PLI | Lost / NACK | Freezes | Wait per frame | Target | Decode per frame | go2rtc H.264 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `playing` | 2.3 s | 12 / 10 / 1 | 1 | 0 | 0 | 0 / 0 | 0 | 13 ms over 12 frames | 20 ms | 29.4 ms | 12 / 12 |
| `startup` | 6.6 s | 65 / 60 / 1 | 50 | 2 | 0 | 0 / 0 | 3 of 1269 ms | 276 ms over 49 frames | 87 ms | 0.9 ms | 65 / 65 |
| `audio_check` | 16.6 s | 215 / 213 / 1 | 202 | 7 | 0 | 0 / 0 | 3 of 1269 ms | 208 ms over 153 frames | 75 ms | 0.6 ms | 215 / 215 |

Attempt D, last painted frame at 48.2 s, 16.7 MB of video by 54.2 s, 553
frames emitted by the jitter buffer against 523 decoded at the fallback:

| Sample | Elapsed | Frames received / decoded / dropped | Painted | Keyframes | PLI | Lost / NACK | Freezes | Wait per frame | Target | Decode per frame | go2rtc H.264 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `playing` | 2.9 s | 4 / 3 / 0 | 1 | 1 | 0 | 0 / 0 | 0 | 3 ms over 3 frames | 24 ms | 16.3 ms | 4 / 4 |
| `startup` | 7.5 s | 60 / 60 / 0 | 59 | 2 | 0 | 0 / 0 | 1 of 297 ms | 32 ms over 57 frames | 39 ms | 0.6 ms | 60 / 60 |
| `audio_check` | 17.5 s | 180 / 161 / 2 | 152 | 6 | 1 | 0 / 0 | 2 of 3635 ms | 700 ms over 101 frames | 75 ms | 0.7 ms | 180 / 180 |
| `fallback` | 54.2 s | 634 / 523 / 83 | 511 | 20 | 10 | 0 / 0 | 7 of 7302 ms | 914 ms over 392 frames | 92 ms | 0.6 ms | no row |

- Connection and ICE were `connected` at every sample of every attempt, host
  to host over UDP, zero packets lost and zero NACK, RTP jitter 2 to 75 ms.
- The decode time per frame sorts the attempts on its own: 3.3 to 3.6 ms in A
  and B, the FFmpeg software decoder the tester read, and 0.6 to 0.9 ms after
  the first frame in C and D, a hardware decoder. Neither the T600 nor the
  Windows hardware decoder is needed for the fallback. The encoder mode of each
  attempt is the tester's report, because the bridge's rows are gone, see the
  last point.
- In attempt A the video stopped before the browser. At 17.2 s, 2.1 s after
  the last painted frame, go2rtc had received 204 H.264 packets from the
  bridge's stream and sent 204, and the browser had received and decoded 204
  frames. At 20.8 s the browser's video counters were unchanged, 204 frames,
  4157 RTP packets and 4785975 bytes, and the audio peer had received 179 more
  Opus packets, 49 per second as in every earlier interval. So go2rtc's video
  input delivered nothing for at least the two seconds before the 17.2 s
  sample and no video packet reached the browser for 5.75 s, while the late
  audio of the same camera and P2P session kept flowing. That fallback
  happened upstream of go2rtc's WebRTC sender, in the P2P video from the
  HomeBase, in the bridge's encoder or the HTTP reader of its output, or in
  go2rtc's input. The bridge sent one more tick after the 95th
  acknowledgement, so its JPEG decoder emitted at least one frame after
  15.1 s, which does not date the P2P input because of that decoder's own
  buffering.
- The tester's Home Assistant core log holds one go2rtc `unexpected EOF` for
  the bridge's media URL in the window of attempt A, at 13:08:52.454 local
  time, 11:08:52.454 UTC, which is the bridge's fallback at 11:08:52.48 UTC on
  its own clock, and none between 11:08:46 and 11:08:52. The bridge destroys a
  grant's HTTP reader only for backpressure or a revoke
  (`bridge/src/media.ts`, `destroyReader`), and an exit of the live encoder
  after its first output ends the session and revokes the grant
  (`bridge/src/live-transcoder.ts`, `hardwareFailure` and `fail`, then
  `Video encoder failed` in `bridge/src/eufy.ts`), so before that fallback the
  bridge neither cut go2rtc's reader nor lost its encoder process. What
  remains for attempt A is the P2P video input stopping while the audio
  continued, an encoder process that ran without emitting, or go2rtc's input
  reading without emitting frames, which the `live_video` row of #114
  separates in the next download. The same logger holds 12 warnings between
  10:57:53 and 11:16:19 UTC, the last at attempt D's fallback, two per cut and
  the rest from the session's end of attempt C and from attempts before
  11:07:56 UTC that are no longer among the download's eight rows, which the
  log's timestamps would confirm.
- Attempts B and D both end in a gap of more than 6 s without a painted frame,
  from 44.9 s and 48.2 s. Whether video was still arriving in that gap is not
  in the download, no sample falls inside it and the fallback sample has no
  go2rtc row. D repeats the 2026-09-20 signature almost exactly with the
  hardware decoder, 700 and 914 ms of wait per frame against 75 to 92 ms,
  83 dropped frames, 10 PLI and 30 frames that left the jitter buffer without
  being decoded. B, with the software decoder, decoded 615 of 621 frames with
  6 dropped and one PLI, so the drops and keyframe requests belong to the
  hardware decoder path and are not the cause of the fallback, and it still
  held frames 148 to 398 ms against 40 to 80 ms before its gap.
- Attempt C, hardware decoder and software transcoding, held frames 208 to
  276 ms with three freezes of 1269 ms in total in the first 6.6 s, no drop
  after the first frame and no PLI, and ended without a fallback for a reason
  the download does not carry.
- The maintainer's bench with integration 0.8.29 on 2026-09-21, Chromium 152
  on macOS, software transcoding, one T8160, showed 6 freezes of 1800 ms in
  total and 161 ms of processing delay per decoded frame at 18.7 s and no
  fallback, see [live diagnostics](LIVE_DIAGNOSTICS.md). Freezes and waits of
  this order occur on the bench too. What the bench has never shown is the gap
  of more than 6 s.
- Four rows without a browser sample, at 11:07:56 offered without an answer,
  at 11:07:59 without an offer and ending in `startup_timeout`, at 11:13:17
  without an offer and at 11:13:22 without an offer and ending in
  `startup_timeout`, are starts around the browser relaunch and the bridge
  recreation, not test attempts, and are not analysed.
- Two limits of this download, both addressed by #112. The fallback sample has
  no go2rtc row when the bridge initiated the fallback, because HA switches
  the viewer to JPEG when the bridge's `fallback` message arrives and
  `record_browser_report` in `custom_components/eufy_viewer/webrtc.py` then
  skips the relay sample. And the bridge's own rows for all four attempts were
  dropped by the two bridge recreations, `support.live_audio` is empty and
  `recent_events` starts at the last bridge start at 11:16:55 UTC, so nothing
  in the download says whether the encoder kept emitting or the P2P video kept
  arriving. The bridge also records no per-attempt video evidence at all, and
  `camera_timeout` in `bridge/src/streams.ts` fires only after 10 s without a
  JPEG frame, so a video stall of 6 to 10 s produces exactly this fallback and
  no bridge event.

Source: the tester's comment and redacted download on issue #94.
