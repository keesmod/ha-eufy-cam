# Compatibility and community testing

You can install ordinary upgrades without a maintainer having tested your exact
hardware. Missing test evidence is not an incompatibility verdict. Actual missing
protocol support and [migration checks](MEGA_MIGRATION.md) still apply, including
the check that existing devices remain present. Reports are voluntary.

We record unconfirmed implementation, reported working, confirmed behavior,
known problems and not implemented per feature. A reproducible community report
can establish confirmed behavior without maintainer ownership of the device.
Keep versions, firmware, topology, date and source with every result. Partial
reports count, and historical evidence keeps its original date after upgrades.
See the [shared policy](https://github.com/keesmod/eufy-mega-client/blob/main/docs/COMMUNITY_VALIDATION.md)
and [model matrix](https://github.com/keesmod/eufy-mega-client/blob/main/docs/MODEL_MATRIX.md).

The historical results below come from one maintainer installation. The dated
0.7.1 acceptance now records exact models and firmware. These results do not
certify whole camera families or additional installations.

| Component or feature | Confirmed evidence | Still to confirm |
|---|---|---|
| Home Assistant | 2026.9.0 | Later releases and other installations |
| HomeBase | HomeBase 3, T8030, firmware 3.8.6.0 | Other firmware, HomeBase 2 and standalone storage |
| Cameras and snapshots | Four camera entities available; all four snapshots returned successfully | Exact camera models and wider combinations |
| Stored recordings | H.264/AAC and native H.265/AAC `hvc1` playback. T8213 doorbell 1600×2300 clips played to completion in the macOS app, including a 49-second clip and seeking. H.264 compatibility conversion also decoded successfully. | Other HEVC profiles, installations and large archives; audible output was not independently assessed |
| Events browsing | Date/camera filters, calendar presence, stored previews, previous/next playback; 95 known-camera files on a tested day | Other retention windows and firmware limits |
| Live WebRTC | Hardware video at 1920×1080; automated video/audio decoding tests | Audible output on each camera, physical iPhone background behavior and remote routes |
| Home Assistant macOS app | App 2026.9.0 build 2026.2874: native H.265 recording playback through both cards; JPEG live playback after client capability detection; 249 decoded frames and confirmed stream cleanup | JPEG has no audio; other macOS app versions |
| Home Assistant iOS app | Maintainer user report on 2026-09-09: live image starts in about 3 seconds | App/iOS versions and independent reproduction |
| Windows Chrome | Maintainer user report on 2026-09-09: live image starts in about 6 seconds; stored recordings in 3–5 seconds | Browser version, clip details and independent reproduction |
| Bridge app | amd64 tested on hardware | aarch64 hardware acceptance |
| Viewer cleanup | Normal close, cancellation and zero remaining active/quarantined streams in live validation | Long-term battery measurements and physical stop during a hard host/network failure |

Detailed evidence: [0.3.0 validation](VALIDATION_0.3.md). Model support in the underlying SDK alone does not count as a successful installation report.

## Independent Mega backend in 0.6.0

Tested on T8030 firmware 3.8.6.0, three T8160 cameras on 3.4.3.0 and a T8213
doorbell on 0.2.1.8. Test and production HA checks covered all four snapshots and
WebRTC video/audio, native H.264/H.265 and converted recordings, a complete
138-record day with camera filters, observed Guard Mode and stream cleanup.
Real rings/person/pet events and recognized names reached HA. The existing
fifteen entity identities were preserved.

An agreed overnight observation lasted about 11 hours 26 minutes, with no
unwanted stream starts. HA recorder independently covered gaps caused by an
expired token in the auxiliary observer. This is not a completed 24-hour or
battery-life test. See the library's [full results and limits](https://github.com/keesmod/eufy-mega-client/blob/main/docs/COMPATIBILITY.md).

## Dated 0.7.1 hardware acceptance

On 2026-09-11, camera #20 completed the 0.6.4 to 0.7.1 upgrade and actual rollback
on HA 2026.9.1, amd64 and Node 24.21.0. T8160 firmware 3.4.3.0 and T8213 firmware
0.2.1.8 used T8030 firmware 3.8.6.0. Stored snapshots, decoded live video/audio,
confirmed stop, complete recording queries, decoded recording audio/video and
seeking passed for both tuples. Fifteen HA identities and dashboard/automation
content were preserved. A real T8160 person event reached HA after a fresh
upgrade. Cleanup and recovery passed. See the [full record](CAMERA_UPGRADE_ROLLBACK_2026_09_11.md).

The historical 0.7.2 candidate used bridge 0.7.1 and client 0.10.0 without a new
physical claim. The later [0.8.0 acceptance](https://github.com/keesmod/ha-eufy-cam/issues/31)
covers the declared T8160/T8213/T8030 combinations, migration and retained-release
rollback, including a real doorbell event. Other combinations retain their own
evidence. See the [0.8.0 upgrade guide](MEGA_MIGRATION.md).

## Dated 0.8.21 concurrent live test

On 2026-09-18, after the 0.8.21 bridge deployment on HA OS 2026.9.2 and amd64,
two T8160 (firmware 3.4.3.0) on one T8030 (firmware 3.8.7.4) streamed live at
the same time through the bridge with `live_max_streams_per_station: 2` on the
JPEG transport. Both stops were device-confirmed, a third camera was refused at
the limit before any device command, and station telemetry, push and snapshots
were intact afterwards. Later that day, with integration 0.8.22 and its inline
card mode, two inline cards played the same two T8160 through WebRTC at 1920 by
1080 in Chromium at the same time with the bridge option at 4, and both closed
with device-confirmed stops. Later still, with integration 0.8.23 and four
autostart cards with the option at 3, two cameras played at the same time in
each of two rounds while the third admitted camera timed out at startup and
the fourth card was refused. See the
[test record](CONCURRENT_LIVE_2026-09-18.md).

On 2026-09-19, with the option at 3 and bounded diagnostics, three T8160
(firmware 3.4.3.0) on that T8030 (firmware 3.8.7.4) streamed live at the same
time through the bridge on the JPEG transport, in a staggered round, a
simultaneous round and a simultaneous round that replaced one camera with the
T8213 doorbell (HEVC). All three admitted cameras reached `frame_ack` in every
round, every stop was device-confirmed, and there were no startup timeouts, stop
retries, recovery attempts or quarantine. Software transcoding of three streams
saturated the 2-core host CPU (six ffmpeg processes) while still delivering about
6 to 8 JPEG frames per second per camera. This shows the earlier third-stream
browser timeout was on the WebRTC consumer path and host CPU headroom, not the
HomeBase, the P2P sessions or the bridge encoder. Three concurrent WebRTC streams
in a browser on this software-transcoding host remain unverified. See the
[2026-09-19 test record](CONCURRENT_LIVE_2026-09-19.md).

An external tester reported a second HomeBase 3 (T8030 firmware 3.8.5.2) with
T8416, T8417 and T8425 on an NVIDIA T600: three streams reached `frame_ack`
together with the GPU at about 7 percent, with an intermittent third-stream
`fallback_startup_timeout` that a Home Assistant side card-lifecycle change
resolved. Reported, not independently reproduced. Source: comments on
[issue #94](https://github.com/keesmod/ha-eufy-cam/issues/94).

## Dated 0.8.27 mains powered live session

On 2026-09-19 an external tester ran one mains powered T8425 (firmware 1.6.4.6,
reported without a battery value) behind a second HomeBase 3 (T8030 firmware
3.8.5.2) with an NVIDIA T600, bridge 0.8.22 with client 0.14.0, integration
0.8.27, `live_max_streams_per_station: 3` and `live_max_seconds_mains: 1800`,
for one session in the bundled card from a Windows PC that stayed on the page.
The session ended at 1800.156 s with `camera_timeout`, `stream_failure` and
`session_end` and without a `no_viewers`, the stop was device-confirmed 27 ms
after the stop request without a retry, two guard mode changes from Home
Assistant applied during the session without interrupting it, the recovery
counters did not change and nothing was quarantined, and the GPU returned to
idle after the end. That verifies the raised cap, the free primary session for
control and the confirmed stop on this hardware. The session switched from
WebRTC to the JPEG fallback at 18.4 s (`fallback_playback_timeout`, no frame
acknowledgement for 6 s with the page visible), so the 30 minutes ran on the
JPEG transport and a long WebRTC session on this hardware is not verified.

The tester's redacted diagnostics download of that run, taken about three
minutes after the end, holds no `station_connection` event between the start of
the session at 20:37:11 UTC and its end at 21:07:12 UTC, so the HomeBase
connection stayed up for the whole session. After the bridge start at 19:03 UTC
the download holds exactly four HomeBase disconnect and reconnect pairs, all
between 19:55:33 and 19:56:36 UTC during the rapid and concurrent attempts
before the run, each reconnecting within 1.3 s, and the bridge counted four
completed recoveries before and after the run. A completed recovery closes the
station session after the confirmed STOP and reconnects it by design, so those
four pairs are the four recoveries and that download holds no HomeBase
reconnect the bridge does not explain. Seven of the eight pairs in the morning
download recorded in the [2026-09-19 test record](CONCURRENT_LIVE_2026-09-19.md)
remain without a bridge explanation.
Reported, not independently reproduced. Source: comments on
[issue #94](https://github.com/keesmod/ha-eufy-cam/issues/94).

## Dated 0.8.28 mains powered live session

On 2026-09-20 the same external tester ran the mains powered T8425 (firmware
1.6.4.6) behind the second HomeBase 3 (T8030 firmware 3.8.5.2) with the NVIDIA
T600 again, now with bridge 0.8.23 and client 0.14.0, integration 0.8.28, Home
Assistant 2026.9.3 on Home Assistant OS 18.2 in a VM,
`live_max_seconds_mains: 1800`, `live_max_streams_per_station: 3`,
`live_acceleration: nvidia` and diagnostics on, for one session in the bundled
card from Google Chrome 153 on Windows with the page visible, one camera and no
guard mode change. The session started at 18:48:56 UTC, reached `frame_ack` at
2.3 s and ended at 1800.219 s with `camera_timeout`, `stream_failure` and
`session_end`. The bridge's audio row holds the device-confirmed stop, the
stream ended and destroyed, and AAC arriving until 1800.157 s. No
`station_connection` event occurred after the bridge's start-up connection at
18:39:42 UTC. The redacted diagnostics download, taken 11 s after the end,
holds the attempt's playback report and the bridge's audio row, which is the
0.8.28 retention fix working after an 1800-second session.

The session switched from WebRTC to the JPEG fallback at 54.6 s
(`fallback_playback_timeout`). The tester's Home Assistant core log holds two
go2rtc warnings with `error="unexpected EOF"` for the bridge's media URL at
20:49:51.024 local time, which is 18:49:51.024 UTC. On the bridge's own clock
the fallback event is at 18:49:51.02 UTC, the same moment. The bridge's fallback
revokes the media grant and destroys both HTTP readers of that grant, the
MPEG-TS video and the late audio AAC (`bridge/src/media.ts`, `revoke`), so
go2rtc logs one EOF per reader. The two warnings are the effect of the fallback
and not its cause. The card's four samples in the download locate the break on
the browser's receive side, with the numbers in the
[2026-09-19 test record](CONCURRENT_LIVE_2026-09-19.md): packets and frames
kept arriving without a lost packet or a NACK, but the average wait per frame
in the browser's jitter buffer grew from 54 ms between 2 and 7 s to 635 ms
between 7 and 17 s and 914 ms between 17 and 55 s against a target of about
45 ms, 68 frames were dropped, the browser sent eight keyframe requests that
go2rtc cannot pass to an HTTP source, and at the fallback 29 frames had left
the jitter buffer without being decoded. The 1800-second cap, the confirmed
stop and the free primary session hold on this hardware. A long WebRTC session
on it remains unverified, and whether the H.264 stream from the T600 or the
decoder and timing of that PC's browser breaks the leg is not decided by this
download. Reported, not independently reproduced. Source: comments on
[issue #94](https://github.com/keesmod/ha-eufy-cam/issues/94).

## Dated 0.8.29 attempts with the decoder and the encoder swapped

On 2026-09-22 the same external tester ran the mains powered T8425 (firmware
1.6.4.6) behind the second HomeBase 3 (T8030 firmware 3.8.5.2) with bridge
0.8.23 and client 0.14.0, integration 0.8.29, Home Assistant 2026.9.3 on Home
Assistant OS 18.3 in a VM, `live_max_streams_per_station: 3`, diagnostics on,
one camera, no guard mode change, from Google Chrome 153 on Windows with the
page visible, in the two discriminating configurations asked for on issue #94.
First with the browser's hardware video decoding disabled in `chrome://flags`
and `live_acceleration: nvidia`, where the tester read
`decoderImplementation=FFmpeg` and `powerEfficientDecoder=false` in
`chrome://webrtc-internals`: two attempts switched from WebRTC to the JPEG
fallback (`fallback_playback_timeout`) at 20.8 s and 50.9 s. Then with
hardware decoding restored and `live_acceleration: software`, the bridge
recreated for the option and the value verified in the running container: one
attempt switched at 54.2 s and one ran at least 16.6 s without a fallback and
ended for a reason the download does not carry. Neither the NVIDIA T600 nor
the Windows hardware decoder is needed for the fallback on this installation.
The download confirms the decoder swap by itself, 3.3 to 3.6 ms of decode time
per decoded frame in the two attempts with hardware decoding off and 0.6 to
0.9 ms in the two with it on. The encoder setting is the tester's report,
because the two bridge recreations dropped the bridge's own rows for all four
attempts.

In the attempt that switched at 20.8 s the video stopped before the browser.
At the card's sample 2.1 s after the last painted frame go2rtc had received
204 H.264 packets from the bridge's stream and sent 204, equal to the frames
the browser had received and decoded, and at the fallback sample 3.6 s later
the browser's video counters were unchanged, 204 frames, 4157 RTP packets and
4785975 bytes, while the late audio peer had received 179 further Opus packets
at its normal rate. So go2rtc's video input delivered nothing for at least the
two seconds before that sample and no video reached the browser for 5.75 s,
with the audio of the same camera and P2P session flowing. The tester's
Home Assistant core log holds one go2rtc `unexpected EOF` in that attempt's
window, at the fallback moment, and none before it, so the bridge neither cut
go2rtc's reader nor lost its encoder process before the fallback, see the
test record. In the two attempts
that switched after 50 s the download cannot say whether video was still
arriving during the final gap of more than 6 s, because the fallback sample
carries no go2rtc row when the bridge initiated the fallback and the bridge's
rows are gone. Every sample is in the
[2026-09-19 test record](CONCURRENT_LIVE_2026-09-19.md). A bridge video row per
attempt and a go2rtc sample at the fallback are in bridge 0.8.24 and
integration 0.8.31 (#114, released in v0.8.31 on 2026-09-23), see
[issue #112](https://github.com/keesmod/ha-eufy-cam/issues/112) and the next
section. The 1800-second cap, the confirmed stop and the free primary session
are not touched by this run. Reported, not independently reproduced. Source:
comments on [issue #94](https://github.com/keesmod/ha-eufy-cam/issues/94).

## Dated 0.8.31 attempt with the bridge video row

On 2026-09-23 the same external tester ran the mains powered T8425 (firmware
1.6.4.6) behind the second HomeBase 3 (T8030 firmware 3.8.5.2) with bridge
0.8.24 and client 0.14.0, integration 0.8.31, Home Assistant 2026.9.3, Google
Chrome on Windows with the browser's hardware video decoding disabled and
`live_acceleration: nvidia`, diagnostics on, one camera, and downloaded 25 s
after the session's end without a restart or an option change. The attempt
switched from WebRTC to the JPEG fallback (`fallback_playback_timeout`) at
51.1 s. The bridge video row of #114 locates the stop in the bridge's live
encoder process: the P2P video from the HomeBase flowed to the session's end
(973 chunks, the last 66 ms before the end, no gap above 399 ms) and the JPEG
decoder produced frames from the same bytes to the end, while the encoder's
MPEG-TS output stopped at 45.1 s and did not resume in the 21 s to the end,
with the process alive, silent on stderr at error level, and go2rtc's reader
attached without backpressure until the fallback revoked it 6.0 s after the
last chunk. The go2rtc sample at the fallback equals the frames the browser
received, so nothing after the encoder held a frame back. Because the input
count and the JPEG decoder sit on the stream piped into the encoder's stdin,
the encoder kept reading its input, and the stop is inside FFmpeg: the CUDA
HEVC decoder, the VFR sync or the NVENC encoder and the muxer, which the row
cannot separate.
[Issue #116](https://github.com/keesmod/ha-eufy-cam/issues/116) added FFmpeg's
progress counters to the row for that (#118, released in v0.8.32 on
2026-09-23), see the next section. Not yet covered on 0.8.31:
`live_acceleration: software`. Every number is in the
[2026-09-19 test record](CONCURRENT_LIVE_2026-09-19.md). The 1800-second cap,
the confirmed stop and the free primary session are not touched by this run.
Reported, not independently reproduced. Source: comments on
[issue #94](https://github.com/keesmod/ha-eufy-cam/issues/94).

## Dated 0.8.33 attempt with FFmpeg's counters

On 2026-09-24 the same external tester ran the T8425 (firmware 1.6.4.6) behind
the second HomeBase 3 with bridge 0.8.26 and client 0.18.1, integration 0.8.33,
Home Assistant 2026.9.3, Google Chrome on Windows with the browser's hardware
video decoding disabled and `live_acceleration: nvidia`, one camera,
diagnostics on, and downloaded 4.5 s after the session's end without a restart
or an option change. The attempt switched from WebRTC to the JPEG fallback
(`fallback_playback_timeout`) at 52.8 s. FFmpeg's progress counters name the
stage: the video sync dropped every frame. From 47.0 s the P2P video and the
JPEG frames kept flowing to the end, while the encoder's frame count stood
still at 625 and its drop count rose to 429 until 0.6 s before the end, with
the process alive and silent. The cause is the origin of the encoder's
wall-clock stamps. `liveArgs` stamps each decoded frame with the time since
`setpts`'s `RTCSTART`, which FFmpeg sets again whenever it rebuilds the filter
graph, and it rebuilds the graph when a decoded frame's size or pixel format
changes. After a rebuild the stamps restart near 0 and the VFR sync drops every
frame until they catch up with the old clock, which takes as long as the
previous graph had run. The same row shows an earlier rebuild after about
3.5 s that cost 3.5 s of frames and recovered. A local reproduction with a
mid-stream size change gives the same counters, and a stamp origin fixed when
the bridge starts the encoder plays through without a drop.
[Issue #122](https://github.com/keesmod/ha-eufy-cam/issues/122) carries that
fix. Which parameter of the T8425's stream changes is not in the download.
Every number is in the [2026-09-19 test record](CONCURRENT_LIVE_2026-09-19.md).
The 1800-second cap, the confirmed stop and the free primary session are not
touched by this run. Reported, not independently reproduced, apart from the
local reproduction of the mechanism. Source: comments on
[issue #94](https://github.com/keesmod/ha-eufy-cam/issues/94).

## Report your installation

You do not need to be a developer or complete every check. There is no required
number of reports before a release. Report both successes and failures on the
features you use, with the date and exact known versions.

1. Follow the [installation instructions](../README.md#installation). Record the integration and bridge versions separately.
2. Confirm your cameras appear and show their latest received snapshots. An older snapshot is expected when no new image has arrived.
3. Close live viewers. In **Eufy Events**, choose a date with a recording you already see in the Eufy app, preferably yesterday. Confirm the camera/time is listed and play that existing clip through to the end.
4. Check the camera filter and, if another clip exists, **Next recording** and **Previous recording**. Open the calendar and check a known recording day; calendar marks describe the whole HomeBase.
5. Close recordings. Open **Watch live**, optionally enable sound, then close it. Confirm you return to the snapshot. Report sound as untested if you could not hear it.
6. If practical, leave the dashboard or background your phone during viewing. Note any continuing playback or failure when returning. Visual closure alone does not prove the physical camera stopped; report bridge diagnostics if available.
   Also note any supported real event you observed and whether the same devices
   recovered after a normal restart. Do not provoke network or device failures.
7. [Submit a compatibility report](https://github.com/keesmod/ha-eufy-cam/issues/new?template=compatibility.yml) with model numbers, firmware, browser/phone and each outcome. No serial numbers, account details or footage are needed.

For an existing problem, add your results to its original issue. A new problem
that needs investigation can use the [bug form](https://github.com/keesmod/ha-eufy-cam/issues/new?template=bug_report.yml).
The compatibility form also accepts failed and partial results. See
[support guidance](../.github/SUPPORT.md) before optionally sharing diagnostics.
Review every excerpt before submitting it. A maintainer reviews the method and
results before recording the claim, including its limits and source.

## Community results

[Camera #10](https://github.com/keesmod/ha-eufy-cam/issues/10) contains partial
T8134 reporter evidence for discovery, stored snapshots, battery, person events
and recording video/audio. A [later iOS report](https://github.com/keesmod/ha-eufy-cam/issues/10#issuecomment-5631252411)
observed working live video with no audio. Its exact app/component versions and
route were not specified. Keep that result alongside the remote Cloudflare
failure. The requested 0.7.1 retest, audio diagnosis and session recovery remain
open. These scoped reports do not establish full T8134 acceptance.
