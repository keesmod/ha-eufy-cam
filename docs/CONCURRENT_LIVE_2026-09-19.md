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

### The 0.8.31 attempt of 2026-09-23 with the bridge video row (reported)

Same tester, HomeBase and T8425, bridge 0.8.24 with client 0.14.0, integration
0.8.31, Home Assistant 2026.9.3, Google Chrome on Windows with the browser's
hardware video decoding disabled, `live_acceleration: nvidia`, one camera,
diagnostics on, no restart and no option change between the attempt and the
download. One redacted download 24.9 s after the session's end holds the first
bridge video row of a fallback (#114), next to its audio row and HA's
`live_playback` row of the same attempt, `audio_attempt` 234874200826295 in
all three, and the first relay row with trigger `fallback`. Times are UTC on
the bridge's clock, the download's `generated_at` of 10:04:42.175 minus the
row's `age_ms`: the bridge requested the stream at 10:03:10.886 and the
elapsed times below count from that moment. The attempt switched from WebRTC
to the JPEG fallback (`fallback_playback_timeout`) at 51.130 s.

The bridge video row, `support.live_video` attempt 76510626341049, HEVC from
the camera, encoder `nvidia` with 0 exits and no software fallback:

| Elapsed | Event |
| --- | --- |
| 1.383 s | `hevc`, `audio_supported` |
| 1.393 s | `audio_input`, `audio_late` |
| 1.470 s | `video_input`, the first P2P video chunk |
| 1.499 s | `media_reader`, go2rtc's reader attached |
| 1.736 s | `jpeg_frame`, the first JPEG frame |
| 1.953 s | `media_active_nvidia` and `media_output`, the first MPEG-TS chunk |
| 2.026 s | `frame_ack` |
| 45.116 s | the last MPEG-TS chunk from the encoder |
| 51.130 s | `fallback_playback_timeout`, the video reader revoked at 51.129 s and the audio reader at 51.130 s |
| 66.318 s | the last P2P video chunk |
| 66.339 s | the last JPEG frame |
| 66.383 s | `no_viewers` and `session_end`, the tester closed the view |

The three points of the row, each with its last data age frozen at the
session's end:

| Point | Chunks | Bytes | First | Last | Age at the end | Largest gap |
| --- | --- | --- | --- | --- | --- | --- |
| `input`, P2P video from the HomeBase | 973 | 5446637 | 1.470 s | 66.318 s | 66 ms | 399 ms |
| `output`, the encoder's MPEG-TS | 676 | 21771528 | 1.953 s | 45.116 s | 21268 ms | 1373 ms |
| `jpeg`, frames of the fallback decoder | 517 | 35493464 | 1.736 s | 66.339 s | 45 ms | 461 ms |

Readers: video `attached` 1, `backpressure` 0, `closed` 0, `revoked` 1 with
`last_destroy_ms` 51129; audio the same with 51130. The audio row of the same
attempt: 1025 AAC chunks, 196741 bytes, last data 52 ms before the end, largest
gap 310 ms, stop confirmed. `assessment.findings` holds the `video_stall`
finding: before the session's end the encoder output had stopped 21268 ms.

The browser and go2rtc samples of the same attempt, HA's `live_playback` row
with `fallback: playback_timeout`, 284 ticks and 283 acknowledgements, the
elapsed time on the browser's clock from the card's start:

| Sample | Elapsed | Frames received / decoded / dropped | Painted | Keyframes | PLI | Lost / NACK | Freezes | Wait per frame | Target | Decode per frame | go2rtc H.264 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `playing` | 2.0 s | 10 / 1 / 0 | 1 | 1 | 0 | 0 / 0 | 0 | 6 ms over 1 frame | 13 ms | 8.0 ms | 10 / 10 |
| `startup` | 6.4 s | 53 / 46 / 0 | 38 | 2 | 0 | 0 / 0 | 2 of 1660 ms | 139 ms over 45 frames | 60 ms | 3.4 ms | 53 / 53 |
| `audio_check` | 16.4 s | 202 / 193 / 8 | 183 | 7 | 0 | 0 / 0 | 3 of 2273 ms | 454 ms over 147 frames | 90 ms | 3.6 ms | 202 / 202 |
| `fallback` | 51.2 s | 630 / 620 / 10 | 608 | 21 | 1 | 0 / 0 | 4 of 2540 ms | 231 ms over 427 frames | 72 ms | 3.5 ms | 630 / 630 |

The last painted frame was 6.066 s before the fallback sample, at 45.13 s on
the browser's clock, with 15565295 bytes of video by 51.2 s. The audio peer had
received 2492 Opus packets, 49 to 50 per second in every interval to the
fallback.

- The row locates the stop in the bridge's live encoder process. The P2P
  video from the HomeBase never stopped: 973 chunks to 66 ms before the end
  with no gap above 399 ms, 0.67 Mbit/s of HEVC. The bridge's JPEG decoder,
  fed from the same Readable, turned those bytes into frames to the end, 517 at
  its 8 per second with no gap above 461 ms. The live encoder's MPEG-TS output,
  4.0 Mbit/s at its CBR cap until then, stopped at 45.116 s and did not resume
  in the 21.3 s to the end. The encoder process did not exit (`exits` 0 and
  no `media_encoder_exit`), wrote nothing to its stderr at `-loglevel error`
  (no `media_encoder_stderr`, which `bridge/src/diagnostics.ts` marks on any
  stderr data), and go2rtc's reader stayed attached with no backpressure until
  the fallback revoked it. The relay row at the fallback says go2rtc had
  received 630 H.264 packets and sent 630, the 630 frames the browser had
  received, so nothing after the encoder held a frame back. 6.014 s after the
  last output chunk the bridge's playback timeout fired the fallback, as
  designed.
- The encoder kept reading its input. The input observer is a prepended `data`
  listener on the Readable that `bridge/src/live-transcoder.ts` pipes into the
  encoder's stdin (`this.video.pipe(input)`) and that `bridge/src/eufy.ts`
  pipes into the JPEG decoder's stdin. Node pauses a piped Readable as soon as
  one destination stops draining, and no `data` event fires while it is
  paused, so a blocked encoder would have frozen the input count and the JPEG
  frames within about a second. Both ran to the end: FFmpeg consumed 21 s of
  HEVC while emitting nothing.
- What the row cannot say. Inside that process three things fit, and all three
  are silent at `-loglevel error`: the CUDA HEVC decoder delivering no frames,
  for example while waiting for a keyframe after a stream hiccup, the VFR sync
  dropping every wall-clock stamped frame (FFmpeg logs sync drops at verbose
  level only), or the NVENC encoder or the MPEG-TS muxer accepting frames
  without emitting. Issue #116 adds FFmpeg's own progress counters to the row
  to separate them.
- Not yet covered on 0.8.31: `live_acceleration: software`. Attempt D of
  2026-09-22 with software transcoding also ended in a gap longer than 6 s, but
  without a bridge row, so whether the software encoder stops in the same place
  is open. One software attempt with a download before any restart answers it
  without code.
- The browser side repeats 2026-09-22: connected host to host over UDP, zero
  packets lost, zero NACK, 3.4 to 3.6 ms of decode time per frame with the
  FFmpeg software decoder, 2.5 s of freezes in total and one PLI when the
  frames stopped. It describes a browser waiting for frames, not one rejecting
  them.
- Three rows without media at 09:54:35, T8416, T8425 and T8417 for 5 to 7 s
  each, ending in `no_viewers` with no offer in HA, are dashboard starts ten
  minutes before the attempt, not test attempts, and are not analysed.

Reported, not independently reproduced. Source: the tester's comment and
redacted download on issue #94.

### The 0.8.33 attempt of 2026-09-24 with FFmpeg's counters (reported)

Same tester, HomeBase and T8425 (firmware 1.6.4.6), bridge 0.8.26 with client
0.18.1, integration 0.8.33, Home Assistant 2026.9.3, Google Chrome on Windows
with the browser's hardware video decoding disabled, `live_acceleration:
nvidia` on the T600, one camera, diagnostics on, no restart and no option
change between the attempt and the download. One redacted download 4.5 s
after the session's end holds the first bridge video row with FFmpeg's
progress counters (#116, #118) after a fallback, next to its audio row and
HA's `live_playback` row of the same attempt, `audio_attempt` 20840570930025
in all three. Times are UTC on the bridge's clock, the download's
`generated_at` of 07:38:36.322 minus the row's `age_ms`: the bridge requested
the stream at 07:37:19.406 and the elapsed times below count from that moment.
The attempt switched from WebRTC to the JPEG fallback
(`fallback_playback_timeout`) at 52.847 s.

The bridge video row, `support.live_video` attempt 205400944465486, HEVC from
the camera, encoder `nvidia` with 0 exits, 0 stderr chunks and no software
fallback:

| Elapsed | Event |
| --- | --- |
| 1.435 s | `hevc`, `audio_supported` |
| 1.443 s | `audio_input`, `audio_late` |
| 1.454 s | `video_input`, the first P2P video chunk |
| 1.534 s | `media_reader`, go2rtc's reader attached |
| 1.666 s | `jpeg_frame`, the first JPEG frame |
| 2.068 s | `media_active_nvidia` and `media_output`, the first MPEG-TS chunk |
| 2.160 s | `frame_ack` |
| 46.969 s | the last MPEG-TS chunk from the encoder |
| 47.359 s | the last progress block in which `frames` rose |
| 52.847 s | `fallback_playback_timeout`, the video and audio readers revoked |
| 71.860 s | the last progress block, `dropped` still rising |
| 72.337 s | the last JPEG frame |
| 72.398 s | the last P2P video chunk |
| 72.431 s | `no_viewers` and `session_end`, the tester closed the view |

The three points of the row, each with its last data age frozen at the
session's end:

| Point | Chunks | Bytes | First | Last | Age at the end | Largest gap |
| --- | --- | --- | --- | --- | --- | --- |
| `input`, P2P video from the HomeBase | 1064 | 7372559 | 1.454 s | 72.398 s | 34 ms | 716 ms |
| `output`, the encoder's MPEG-TS | 659 | 21432376 | 2.068 s | 46.969 s | 25463 ms | 3455 ms |
| `jpeg`, frames of the fallback decoder | 566 | 48741710 | 1.666 s | 72.337 s | 95 ms | 714 ms |

FFmpeg's counters from the last progress block, 572 ms before the end:
`frames` 625, `dropped` 429, `duplicated` 0, `out_time_ms` 40899, `bytes`
21432376, `last_frame_ms` 47359, `last_drop_ms` 71860. Readers: video and
audio each `attached` 1, `backpressure` 0, `closed` 0, `revoked` 1 with
`last_destroy_ms` 52847. The audio row of the same attempt: 1117 AAC chunks,
214507 bytes, last data 73 ms before the end, largest gap 881 ms, stop
confirmed. `assessment.findings` holds the `video_stall` finding with the sync
case: FFmpeg's frame count stopped with the output while its drop count kept
rising for 24891 ms after the last output chunk.

The browser and go2rtc samples of the same attempt, HA's `live_playback` row
with `fallback: playback_timeout`, 255 ticks and 254 acknowledgements, the
elapsed time on the browser's clock from the card's start:

| Sample | Elapsed | Frames received / decoded / dropped | Painted | Keyframes | PLI | Lost / NACK | Freezes | Wait per frame | Target | Decode per frame | go2rtc H.264 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `playing` | 2.2 s | 9 / 2 / 0 | 1 | 1 | 0 | 0 / 0 | 0 | 11 ms over 3 frames | 12 ms | 6.0 ms | 10 / 10 |
| `startup` | 6.5 s | 56 / 55 / 1 | 47 | 2 | 0 | 0 / 0 | 3 of 875 ms | 70 ms over 55 frames | 42 ms | 3.3 ms | 56 / 56 |
| `audio_check` | 16.5 s | 172 / 128 / 11 | 119 | 5 | 1 | 0 / 0 | 6 of 5634 ms | 376 ms over 128 frames | 61 ms | 3.6 ms | 172 / 172 |
| `fallback` | 53.0 s | 622 / 547 / 75 | 526 | 20 | 2 | 0 / 0 | 14 of 9454 ms | 756 ms over 547 frames | 92 ms | 3.6 ms | 622 / 622 |

The last painted frame was 6.012 s before the fallback sample, at 47.0 s on
the browser's clock. At the `startup` sample the last painted frame was
1.103 s old, from 5.37 s. The audio peer had received 2521 Opus packets, about
50 per second from the `startup` sample to the fallback. Connection and ICE
were `connected` host to host over UDP at every sample.

- The counters name the stage: the video sync dropped every frame. From 47 s
  the P2P video and the JPEG frames kept flowing to the end and FFmpeg kept
  reporting to 0.6 s before it, while its frame count stood still at 625 from
  the block at 47.359 s and its drop count rose to 429 until the last block.
  625 frames encoded and 429 dropped against 1064 P2P video chunks, so after
  47 s the decoded frames kept reaching the sync and were dropped there. With
  Debian Bookworm's FFmpeg 5.1 of the bridge images `frame` counts the frames
  the sync handed to the encoder. The three frames between those 625 and the
  622 H.264 packets go2rtc received were in flight: FFmpeg 5.1's NVENC wrapper
  hands out a packet only while three frames are queued, so it keeps two, and
  the MPEG-TS muxer omits the length of video packets by default, so a reader
  completes the last one only when the next one starts. The bridge's playback
  timeout (`bridge/src/server.ts`, 6 s after the card's last acknowledgement)
  switched the viewer to JPEG 5.9 s after the last output chunk, as designed.
- Why the sync dropped them. `liveArgs` in `bridge/src/live-transcoder.ts`
  stamps each decoded frame with the wall clock since `RTCSTART`
  (`setpts='(time(0)-RTCSTART/1000000)/TB'`). FFmpeg 5.1's `setpts` sets
  `RTCSTART` whenever the filter graph is configured, and FFmpeg configures the
  graph again whenever a decoded frame's size or pixel format differs from the
  previous frame's, or its hardware frames context or display matrix changes.
  After such a rebuild the stamps start again near 0 while the sync's output
  clock continues from the old stamps, and with `-fps_mode vfr` the sync drops
  every frame more than one frame duration behind that clock until the new
  stamps catch up, which takes as long as the previous graph had run. None of
  it is logged at `-loglevel error` and the process stays alive. The FFmpeg
  source lines, at tag n5.1.9, are in
  [issue #122](https://github.com/keesmod/ha-eufy-cam/issues/122).
- The row also holds the short form of the same event. The output's largest
  gap, 3455 ms, lies early in the session: at the `startup` sample the last
  painted frame was 1.1 s old, and by `audio_check` the browser had counted
  three more freezes of 4759 ms in total. The output recovered from it.
  `out_time_ms` ended at 40899 after 44.9 s of output, about 4 s behind, and
  429 drops are about 50 more than the 25 s after 47.4 s account for at the
  input's 15 chunks per second. A rebuild about 3.5 s after the first one
  costs 3.5 s of frames and recovers before the playback timeout. The rebuild
  at 47 s would have needed about 41 s. After the early episode the frames
  continued the old stamps while arriving 3.5 s later, which may account for
  part of the browser's wait of 756 ms per frame and its 75 dropped frames,
  against 231 ms and 10 on 2026-09-23. That part is not established.
- Local reproduction of the mechanism by the maintainer, FFmpeg 9.0.1 on
  macOS, the unchanged `liveArgs` in software mode, synthetic HEVC elementary
  streams at 15 fps paced in real time:

  | Stream | Stamp | Frames encoded / dropped | Output |
  | --- | --- | --- | --- |
  | 2560x1440 for 12 s, then 1920x1080 for 25 s | `RTCSTART` | 384 / 171 | stopped at 11.51 s for 11.52 s, then resumed with `out_time` 11.5 s behind the wall clock |
  | 2560x1440 for 12 s, 1280x720 for 8 s, 2560x1440 full range for 8 s | `RTCSTART` | 180 / 241 | stopped at 11.53 s and never resumed, the second rebuild restarted the clock during the drops |
  | the first stream | origin fixed at spawn | 555 / 0 | continuous, largest gap 0.19 s |
  | the second stream | origin fixed at spawn | 420 / 0 | continuous, largest gap 0.16 s, 1920x1080 yuv420p throughout |

  With the fixed origin the output keeps one size and pixel format, because
  FFmpeg's autoscale holds the encoder's input across a rebuild. The same
  logic is in the FFmpeg 5.1 source, and #122 carries the fix with a check on
  5.1.
- What changes in the T8425's stream at those two moments, the frame size,
  the pixel format such as the full-range flag, or a display matrix, is not in
  the download. The bridge's JPEG decoder scales to at most 960 pixels wide
  (`bridge/src/eufy.ts`), so a change between two 16:9 sizes does not show
  there either. The fix does not depend on it, and because the cause lies
  before the encoder it also fits the software transcoding attempt of
  2026-09-22 that fell back.
- The earlier fallbacks of this camera, from 20.8 s to 54.2 s, fit the same
  cause, but only the 0.8.31 row shows the encoder stop and none has the
  counters, so the cause is shown for this attempt only.
- The browser side repeats 2026-09-23: zero packets lost, zero NACK and 3.3
  to 3.6 ms of decode time per frame with the FFmpeg software decoder.

Reported, not independently reproduced, apart from the local reproduction of
the mechanism. Source: the tester's comment and redacted download on issue
#94.

### The 0.8.34 attempt of 2026-09-24 with the stamp fix (reported)

Same tester, HomeBase and T8425 (firmware 1.6.4.6), bridge 0.8.27 with client
0.18.1, integration 0.8.34, Home Assistant 2026.9.3, Google Chrome on Windows
with the browser's hardware video decoding disabled, `live_acceleration:
nvidia` on the T600, one camera, diagnostics on, no restart and no option
change between the attempt and the download. This is the field check that
#122 asked for after the stamp fix (#124, released in v0.8.34): the tester let
the live view run for a little over three minutes and then closed it. One
redacted download 4.4 s after the session's end holds the attempt's bridge
video row, its audio row and HA's `live_playback` row, `audio_attempt`
8205685772019 in all three. Times are UTC on the bridge's clock, the
download's `generated_at` of 14:44:31.490 minus the row's `age_ms`: the bridge
requested the stream at 14:41:19.474 and the elapsed times below count from
that moment. The attempt did not fall back.

The bridge video row, `support.live_video` attempt 263082665176971, HEVC from
the camera, encoder `nvidia` with 0 exits, 0 stderr chunks and no software
fallback:

| Elapsed | Event |
| --- | --- |
| 1.037 s | `hevc`, `audio_supported`, the bridge starts the live encoder |
| 1.044 s | `audio_input`, `audio_late` |
| 1.071 s | `video_input`, the first P2P video chunk |
| 1.137 s | `media_reader`, go2rtc's reader attached |
| 1.319 s | `jpeg_frame`, the first JPEG frame |
| 1.541 s | `media_active_nvidia`, with `media_output` at 1.542 s, the first MPEG-TS chunk |
| 1.671 s | `frame_ack` |
| 187.591 s | the last P2P video chunk |
| 187.592 s | the last JPEG frame |
| 187.604 s | the last MPEG-TS chunk and the last progress block, in which `frames` rose |
| 187.612 s | `no_viewers` and `session_end`, the tester closed the view |

The three points of the row, each with its last data age frozen at the
session's end:

| Point | Chunks | Bytes | First | Last | Age at the end | Largest gap |
| --- | --- | --- | --- | --- | --- | --- |
| `input`, P2P video from the HomeBase | 2791 | 24021124 | 1.071 s | 187.591 s | 23 ms | 1297 ms |
| `output`, the encoder's MPEG-TS | 2970 | 95903312 | 1.542 s | 187.604 s | 10 ms | 1306 ms |
| `jpeg`, frames of the fallback decoder | 1487 | 132037191 | 1.319 s | 187.592 s | 22 ms | 1339 ms |

FFmpeg's counters from the last progress block, `last_progress_age_ms` 9:
`frames` 2790, `dropped` 0, `duplicated` 0, `out_time_ms` 186416, `bytes`
95903312, `last_frame_ms` 187604, and no `last_drop_ms` because `dropped`
never rose. Readers: video and audio each `attached` 1, `backpressure` 0,
`closed` 1, `revoked` 0. The audio row of the same attempt: AAC in ADTS at
16 kHz mono, 2915 chunks, 559741 bytes, last data 144 ms before the end,
largest gap 1758 ms, stream ended and destroyed, stop confirmed.
`assessment.findings` holds no `video_stall` finding, only three audio
findings for this attempt.

The browser and go2rtc samples of the same attempt, HA's `live_playback` row
without a `fallback`, 1248 ticks and 1247 acknowledgements, the elapsed time
on the browser's clock from the card's start:

| Sample | Elapsed | Frames received / decoded / dropped | Painted | Keyframes | PLI | Lost / NACK | Freezes | Wait per frame | Target | Decode per frame | go2rtc H.264 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `playing` | 1.7 s | 6 / 1 / 0 | 1 | 1 | 0 | 0 / 0 | 0 | 11 ms over 2 frames | 12.5 ms | 9.0 ms | 6 / 6 |
| `startup` | 6.1 s | 68 / 65 / 1 | 62 | 3 | 0 | 0 / 0 | 2 of 729 ms | 120 ms over 65 frames | 96 ms | 3.6 ms | 68 / 68 |
| `audio_check` | 16.1 s | 219 / 216 / 1 | 213 | 8 | 0 | 0 / 0 | 2 of 729 ms | 95 ms over 216 frames | 87 ms | 3.5 ms | 219 / 219 |

The card takes no further sample unless it falls back, so the browser's
counters after 16.1 s are not in the download. The late audio peer had
received 720 Opus packets by 16.1 s.

- The row holds no trace of the stall that #122 fixed. FFmpeg's video sync
  handed 2790 frames to the encoder and dropped none against 2791 P2P video
  chunks. The encoder's output flowed from 1.542 s to 10 ms before the end
  with no gap above 1306 ms, the order of the largest gaps in the input
  (1297 ms) and the JPEG frames (1339 ms). On 0.8.33 the output stopped at
  46.969 s while `dropped` rose to 429, and on 0.8.31 it stopped at 45.116 s.
- `out_time_ms` ended at 186416, 151 ms short of the 186567 ms from the
  encoder's start at 1.037 s to its last chunk, where the 0.8.33 row ended
  about 4 s behind its 44.9 s of output. With the origin fixed at the spawn a
  rebuild can no longer set the stamps back, so this agrees with `dropped` 0
  but does not show whether a rebuild happened.
- The seven dated fallbacks of this camera recorded here since 2026-09-19 came
  between 18.4 s and 54.6 s: 18.4 s on 0.8.27, 54.6 s on 0.8.28, 20.8, 50.9
  and 54.2 s on 0.8.29, 51.1 s on 0.8.31 and 52.8 s on 0.8.33. This attempt
  ran 187.6 s, more than three times the latest of them. Whether the T8425's
  stream changed its frame size or pixel format during it is not in the
  download, as on 0.8.33, so the evidence is a run far past every earlier
  stall with nothing dropped, not a rebuild observed and survived.
- At 16.1 s the browser had waited 95 ms per frame, dropped one frame and sent
  no PLI, against 376 ms, 11 dropped frames and one PLI at the same sample on
  0.8.33. That fits the 0.8.33 note that its early rebuild episode may account
  for part of the browser's wait, but one attempt does not establish it. The
  browser side otherwise repeats the earlier attempts: connected host to host
  over UDP, zero packets lost, zero NACK and 3.5 to 3.6 ms of decode time per
  frame with the FFmpeg software decoder.
- go2rtc closed its video reader when the view closed. The bridge destroyed no
  reader and revoked no grant, because no fallback happened.
- The 1800-second cap and the free primary session are not touched by this
  run, and the stop at its end was device-confirmed. A WebRTC session up to
  the cap on this hardware remains unverified.

Three starts without media before the attempt. The download holds three
earlier rows of this camera after the bridge's start-up connection at
14:28:45 UTC that the tester's comment does not mention:

| Start (UTC) | Duration | Bridge events | HA row |
| --- | --- | --- | --- |
| 14:32:57.341 | 14.728 s | `start`, `no_viewers` at 14.727 s | no offer |
| 14:39:15.924 | 10.787 s | `start`, `no_viewers` at 10.786 s | no offer |
| 14:39:29.516 | 20.189 s | `start`, `fallback_startup_timeout` at 14.999 s, `viewer_timeout` at 20.188 s, `no_viewers` at 20.189 s | no offer, `fallback: startup_timeout` |

None of the three has an input chunk, a codec or an encoder mode, and each
audio row ends as `failed` with no data, 0.6, 0.6 and 0.4 s after its viewer
left.

- The HomeBase sent no stream metadata in any of them. `client.startLive` had
  not resolved when the viewer left, while the three recorded attempts on this
  camera that played received it 1.0 to 1.4 s after the request (`hevc` at
  1.383 s on 0.8.31, 1.435 s on 0.8.33 and 1.037 s here). The first two ended
  when the view was closed before the bridge's 15 s startup fallback. The
  third switched at 15.0 s to a JPEG fallback that had no frame to show, and
  ended at the 20 s that `StreamHub` in `bridge/src/streams.ts` gives a first
  viewer to acknowledge a frame. HA's rows hold no WebRTC offer, as expected
  without the bridge's `ready` message.
- The camera's P2P session and its command channel worked in all three. With
  `live_max_streams_per_station: 3` the client opens a separate session per
  start (`openExtraLive` in `src/device-transport.ts` of client 0.18.1). When
  the caller cancels after START was issued, the client confirms a STOP on
  that session and emits `live-stop` with `confirmed: true` only if the
  HomeBase answered `CMD_STOP_REALTIME_MEDIA` with return code 0. The bridge
  admitted the third start 2.8 s after the second ended, which
  `StreamHub.attach` allows only after `stopped`. `stopped` follows either
  that confirmed `live-stop` or a completed recovery, which starts 9 s after
  the end at the earliest and closes and reconnects the station session. The
  download holds no station reconnect after the start-up connection, so no
  recovery ran after any of the three and each STOP was confirmed. The audio
  rows end when the cancelled start returned from the client, after that
  confirmation. So each START went out on a working session and the HomeBase
  acknowledged the STOP, but it sent no stream.
- Why is not in the download. The P2P library receives the HomeBase's result
  for `CMD_START_REALTIME_MEDIA` and, when no data follows it within 5 s, ends
  the stream and sends STOP by itself (`waitForStreamData` in the client's
  vendored `vendor/src/p2p/session.ts`). The client's start waits only for the
  stream's metadata and records neither that result nor that end, so whether
  the HomeBase refused the start, accepted it and sent nothing, or never
  answered it is open.
  [eufy-mega-client issue #187](https://github.com/keesmod/eufy-mega-client/issues/187)
  adds that report to the client. A bridge row can carry it after a client
  release.
- The 0.8.31 download of 2026-09-23 also held starts without media, the
  dashboard starts of all three cameras at 09:54:35 for 5 to 7 s, followed by
  one station reconnect from 09:54:49 to 09:54:51 UTC that fits a recovery 9 s
  after the T8425's end. The three here are single starts of one camera, up to
  20 s long, and none needed a recovery.

Reported, not independently reproduced. Source: the tester's comment and
redacted download on issue #94.
