# Live startup latency

The 0.8.6 bridge addresses the startup sequencing reported in [issue #48](https://github.com/keesmod/ha-eufy-cam/issues/48).
It does not change camera transport or Docker networking.

## Evidence and cause

At tag v0.5.1, `server.ts` sent WebRTC `ready` immediately after attaching a
viewer. By 0.8.5, it waited for `Peer.send`, which only runs when the JPEG
decoder produces a frame. The later readiness protected video-only streams by
waiting for actual audio metadata, but also put JPEG decoding on the WebRTC
startup path. The report's first encoded output at 3625 ms was discarded until
the media reader attached at 6215 ms, after the first JPEG at 6008 ms.

The A/V encoder also analyzed video for up to one second, with the AAC input
using FFmpeg's default analysis. The JPEG input used default analysis. These
settings were already present in 0.5.1, but JPEG analysis became a WebRTC gate
with the readiness change. The report alone cannot assign every millisecond
to a specific FFmpeg stage or keyframe interval.

## Change

The bridge sends `ready` when the encoder has real audio metadata. A second
viewer can use metadata from the existing encoder. Readiness neither delivers
a frame nor acknowledges it. JPEG ticks, fallback and the original ownership
deadlines continue to govern acknowledgements, timeout and cleanup.

All three elementary inputs have a 32 KiB probe size and 100 ms analysis
budget. Formats remain explicit. Probed packets are retained, including the
initial keyframe. These are analysis limits, not a promised wall-clock bound
on a camera that has not supplied the necessary codec headers or media.

Initial MPEG-TS output is retained for at most two seconds after first output,
up to 1 MB per active camera. A signaling reader receives that complete prefix.
If either bound is exceeded, the entire prefix is discarded, preserving normal
live fan-out without replaying an arbitrary truncated prefix. Stop clears the
cache and timer. A revoked grant cannot attach or keep a reader alive. Later
viewers use the ongoing stream and may wait for its next keyframe as before.

## Validation and limits

Regression tests feed one second of independently generated H.264 or H.265,
with and without AAC, and leave inputs open. Unchanged 0.8.5 fails all four
three-second output deadlines. With the fix, all four produce output before
EOF, containing a decodable H.264 keyframe and the expected audio track. On the
local Node 24.19.0 test host, first output followed input by about 27 to 29 ms.
These are synthetic processing measurements, not camera startup times.

The readiness tests fail on 0.8.5 and pass with the fix before any JPEG frame.
They also cover actual audio metadata, duplicate signals, expired grants,
disconnect before metadata, fallback, multiple viewers and unchanged deadlines.
The browser suite exercises real FFmpeg, go2rtc and decoded Chromium video and
audio, plus close, navigation, frozen playback and connection/media failure.

The exact T8425 through T8030 installation on Debian 13 still needs a new
bounded observation of first visible video, audio and stop cleanup. Keep issue
#48 open for that evidence. A synthetic pass does not establish the previous
three-second camera performance target or validate reporter hardware.
