# Optional NVIDIA media transcoding

This experimental Docker option requests NVIDIA decoding and H.264 encoding for
live A/V and, from bridge 0.8.8, HEVC-to-H.264 recording conversion. Each has a
separate opt-in setting. Software remains the default. JPEG previews, camera
transport and Home Assistant identities are unchanged.

## Requirements and image checks

Use a Linux Docker host with a compatible NVIDIA GPU, an already working host
driver and NVIDIA Container Toolkit configured for Docker. Check the GPU's
H.264/HEVC decode profiles and H.264 encode support in NVIDIA's
[codec support matrix](https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new).
A community reporter confirmed live NVENC/NVDEC on a T600 with bridge 0.8.7
and HEVC-to-H.264 recording conversion with bridge 0.8.8. The complete Auto
recording playback flow was subsequently confirmed with integration/card 0.8.12
and bridge 0.8.11 on a T600/T8030/T8425 setup. The reporter also confirmed the
recording fixes in integration/card 0.8.15 and bridge 0.8.14. See the scoped
[community validation](#recording-fix-acceptance-on-2026-09-14) below.

The bridge image uses Debian Bookworm's FFmpeg from `node:24-bookworm-slim`.
The Docker host can run a different distribution, including Debian 13. The
container supplies FFmpeg, while the NVIDIA runtime exposes the host's compatible
driver libraries and selected GPU. There is no CUDA base-image requirement and
no host driver installation inside this image. The HAOS app keeps its existing
software configuration and has no NVIDIA option.

Before enabling this option, inspect the image you actually built:

```sh
docker run --rm --network none --entrypoint ffmpeg eufy-viewer-bridge:local -version
docker run --rm --network none --entrypoint ffmpeg eufy-viewer-bridge:local -encoders
docker run --rm --network none --entrypoint ffmpeg eufy-viewer-bridge:local -hwaccels
```

Look for `h264_nvenc`, `libx264` and `cuda`. Their presence only proves FFmpeg
build support. Actual support also depends on driver compatibility, GPU access,
codec profile and available encoder sessions. Verify each image architecture.
Do not assume all ARM64 systems, Jetson devices or HAOS installations support
this route. See [FFmpeg's hardware acceleration options](https://ffmpeg.org/ffmpeg.html#Advanced-Video-options)
and [NVIDIA's FFmpeg guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu/index.html).

## Enable on an existing Docker installation

Build a checkout containing this feature using the existing Docker instructions.
The following additions use `eufy-viewer-bridge:local` as that local image tag.
Keep your existing token, volume, bind address and host networking. Back up the
current image and private data before recreating the container.

Add these flags to the existing `docker run` command:

```sh
--gpus device=0 \
-e NVIDIA_DRIVER_CAPABILITIES=compute,video,utility \
-e EUFY_LIVE_ACCELERATION=nvidia
```

Select your intended GPU index rather than exposing every GPU. `compute` exposes
CUDA support and `video` exposes codec libraries. `utility` permits `nvidia-smi`
checks. NVIDIA's default capabilities omit `video`. Follow the official
[Container Toolkit setup](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
and [GPU exposure instructions](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/docker-specialized.html).
Do not add privileged mode, host driver directories or extra network ports.

For Compose, add this to the existing bridge service:

```yaml
environment:
  EUFY_LIVE_ACCELERATION: nvidia
  NVIDIA_DRIVER_CAPABILITIES: compute,video,utility
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          device_ids: ["0"]
          capabilities: [gpu]
```

Preserve other environment settings in that service. An unavailable Docker GPU
runtime can prevent the container itself from starting. FFmpeg fallback cannot
handle that Docker failure. Remove the GPU reservation and acceleration setting
to recover the normal software installation. See
[Docker's GPU reservation guide](https://docs.docker.com/compose/how-tos/gpu-support/).

## Selection, fallback and diagnostics

`EUFY_LIVE_ACCELERATION` accepts `software` or `nvidia`. Omission means
`software`. Other values fail configuration validation with a fixed error.

The NVIDIA command requests CUDA decoding, transfers frames to system memory for
the existing maximum-1920-pixel scaler, and uses `h264_nvenc` with low-latency
settings. Audio never enters this encoder; it travels on its own late-audio
route. GPU memory transfers and CPU scaling remain, so this is not a fully
GPU-resident pipeline. NVENC targets `EUFY_LIVE_MAX_BITRATE` (default 4 Mbit/s)
with no B frames, the same cap that bounds the software encoder since 0.8.20.
Its quality and load need actual camera validation.

The first actual hardware stream is the capability test. If FFmpeg fails before
producing output, the bridge kills that process and replays the initial video
to one software encoder within the same owned camera session. A silent
hardware start gets five seconds. Process cleanup gets one additional second.
Replay is limited to 8 MiB across both tracks. No camera start command is retried.
A hardware failure disables GPU attempts across the bridge until restart.

If replay exceeds the limit, process termination cannot be confirmed, or hardware
fails after output has started, the current view ends safely. Open a new view to
use software. This avoids replaying a truncated video prefix or joining two
incompatible MPEG-TS timelines. A software failure follows normal stream cleanup
and does not start a retry loop. Closing the view cancels a pending retry.

Temporarily enable `EUFY_DIAGNOSTICS=true` and inspect the bridge logs:

| Event | Meaning |
| --- | --- |
| `media_active_nvidia` | The requested NVIDIA pipeline produced media output |
| `media_active_software` | The software encoder produced media output |
| `media_hardware_failed` | The hardware process or input failed |
| `media_hardware_timeout` | No hardware output within five seconds |
| `media_hardware_buffer_limit` | The initial replay buffer reached its limit |
| `media_software_fallback` | A single software replacement started |

These events contain an anonymous attempt number and elapsed time, with no
camera identifier, driver error text or media. They identify the active encoder
route, not proof that every decode operation was hardware accelerated. Disable
diagnostics after testing. Existing discovery downloads do not contain these
opt-in live log events.

To disable acceleration, remove `EUFY_LIVE_ACCELERATION` or set it to `software`
and recreate the container. Remove GPU exposure as well if it is no longer
needed. Keep the same private bridge data and token.

## Validation still required

Local Debian Bookworm FFmpeg 5.1.9 image builds for AMD64 and ARM64 both listed
`h264_nvenc` and `cuda`. On both architectures, network-disabled container tests
produced and decoded H.264/AAC MPEG-TS from synthetic H.264 and HEVC input in
software mode and after actual missing-GPU fallback. AMD64 ran under emulation.
This evidence concerns the built images, not every future Debian package.

Software checks cover command construction, startup error and timeout fallback,
replay bounds, cancellation, runtime failure and real FFmpeg software output.
No compatible NVIDIA GPU is available in the development environment. The
community live validation below adds evidence for one installation. Other
GPU/driver combinations, picture quality and concurrent-session limits still
need their own evidence. Compare the same codec, camera, image
and host on software and NVIDIA before drawing performance conclusions.

## Recording playback

From bridge 0.8.8, add `EUFY_RECORDING_ACCELERATION=nvidia` to the same Docker
service with the GPU exposure and driver capabilities described above. It is
independent of `EUFY_LIVE_ACCELERATION`. Both accept only `software` or `nvidia`,
and both default to software. HAOS retains software defaults.

NVIDIA is used only when an HEVC recording must be converted to H.264 for the
player. H.264 recordings and native HEVC playback copy the existing video and AAC
into MP4 without decoding or encoding. Zero GPU activity is expected for these
remuxes, which preserve the original picture and avoid unnecessary conversion.
The browser still owns decoding and displaying the resulting recording.

With integration/card 0.8.12 and bridge 0.8.11, both recording players offer
Auto / Native / H.264. Auto converts HEVC when NVIDIA recording acceleration is
configured, even if the browser supports HEVC. The per-recording status shows
the completed processing route, including software fallback. See the
[playback mode guide](INSTALLATION.md#recording-playback-format) for all modes.

Conversion requests CUDA decoding and `h264_nvenc` encoding at the original
resolution and frame rate. NVENC uses preset p4, the high-quality tune, VBR with
CQ 23 and no B frames. These settings do not imply identical quality to software.
Pixel-format conversion can transfer frames through system memory. AAC is copied.

The complete recording is downloaded once. From bridge 0.8.12, hardware gets
10 seconds to begin advancing encoded frames and is stopped after 10 seconds
without further frame progress. Healthy conversion may take longer than 10
seconds, within the unchanged 45-second total conversion deadline. Repeated
frame counts and stderr messages cannot reset that deadline or the stall timer.
The private FFmpeg progress pipe is drained separately from MP4 and error output.
After a failure, the
bridge waits up to one second for confirmed process termination, discards all
partial output and makes one software attempt on the same downloaded bytes with
the remaining time. It does not repeat a camera download. From bridge 0.8.14, failure applies only to that request. The next request
tries the configured encoder again. Live acceleration has separate ownership.
Native remuxing retains its 20-second deadline. Output uses a private file with
a separate 256 MiB disk allowance. See [storage ownership](RECORDING_STORAGE.md).
The existing overall recording-operation deadline also remains in effect.

Cancellation, storage errors and oversized output do not trigger fallback or
disable later NVIDIA requests. If process cleanup
cannot be confirmed, further recording conversion is blocked until restart to
prevent overlapping processes. A failed software attempt ends the operation.

From bridge 0.8.12, hardware failures always produce a warning in the bridge
logs. `EUFY_DIAGNOSTICS=true` additionally enables successful processing and
fallback events. Each line has an anonymous attempt number and elapsed time:

| Event | Meaning |
| --- | --- |
| `recording_active_nvidia` | NVIDIA completed the MP4 conversion |
| `recording_active_software` | Software completed the MP4 conversion |
| `recording_remuxed` | Compatible video and audio were copied without transcoding |
| `recording_hardware_failed` | The hardware attempt failed |
| `recording_hardware_timeout` | The hardware attempt reached its deadline |
| `recording_software_fallback` | One software replacement was selected |
| `recording_failed` | Preparation failed without a hardware retry, including a storage limit or storage error |

Failure details identify process/input errors, empty output, output limits,
unconfirmed cleanup or timeout. A timeout names `hardware_progress` or
`conversion`, its budget in milliseconds and the last encoded-frame count.
Exit status and a fixed FFmpeg category can distinguish memory, CUDA device or
driver, NVENC session/open-session, missing encoder, format, decode and input
errors. `unclassified` means FFmpeg emitted text outside these categories. An
empty category list means no stderr was observed. Categories are clues, not a
claim that every message in that category has the same underlying cause.
Default warnings contain no stderr text. From bridge 0.8.13, enable
`EUFY_DIAGNOSTICS=true` to add `failure.ffmpeg_detail` for an `unclassified`
hardware error. The excerpt retains up to 2,000 characters from a bounded
4,096-character stderr tail. A partial first line is omitted when that tail was
truncated. Common credentials, URLs, paths, addresses, email addresses and
identifier patterns are redacted, and terminal control sequences are removed.
Review an excerpt before sharing it, since arbitrary driver text cannot be
fully identified by pattern matching. Known categories, successful processing
and cancellation never include an error excerpt. Disable diagnostics after the
reproduction. In the HA app, the equivalent setting is `diagnostics: true`.

To investigate a repeat failure, close playback and restart the bridge once to
reset the recording circuit breaker. Open one HEVC recording in Auto and collect
the first `recording_hardware_failed` or `recording_hardware_timeout` warning.
Record the clip duration and whether playback succeeds through software. Further
software playbacks after that first failure do not attempt NVIDIA again until
restart. This explains why Live can still work while recordings stay on software.
Verbose diagnostics are optional and can be disabled again after testing.

Elapsed time starts after the recording download, so it is not total playback
startup time. Completion identifies the encoder route. Confirm NVDEC/NVENC engine
activity separately on the GPU while preparing a new HEVC-to-H.264 recording.
The bridge finishes preparing the MP4 before playback starts, so GPU activity
can already be zero while the browser plays it. Native playback or a cached MP4
cannot validate conversion acceleration. Compare the same clip on software and
NVIDIA, checking duration, audio sync, picture quality, elapsed time and GPU load.

Disable recording acceleration by removing `EUFY_RECORDING_ACCELERATION` or
setting it to `software`, then recreate the container with the same data and token.

## Community hardware validation

### Earlier live and recording conversion tests

On 2026-09-13, a reporter using a T600 4 GB, driver 610.57.04, Debian 13/Docker,
HomeBase 3 T8030 and cameras T8416/T8417/T8425 confirmed live video/audio and actual
NVENC/NVDEC activity with bridge 0.8.7 and client 0.12.2. Activity stopped when
live view closed and resumed on reopening. See the
[reported hardware test](https://github.com/keesmod/ha-eufy-cam/issues/49#issuecomment-5653261791).
This establishes live-path evidence for that reported installation.

Recording command, fallback, deadline, cancellation and byte-limit checks use
synthetic tests. Real CPU FFmpeg tests verify complete H.264/AAC output, native
remuxing and missing-GPU fallback. On the same date, the reporter
[confirmed successful recording conversion](https://github.com/keesmod/ha-eufy-cam/issues/49#issuecomment-5655533108)
on bridge 0.8.8 with `EUFY_RECORDING_ACCELERATION=nvidia` and the same T600,
driver and Docker host. `recording_active_nvidia` reported about 2983 ms for
attempt 1. GPU monitoring showed peaks of 69% NVENC, 23% NVDEC, 17% SM and 8%
memory-engine activity. Activity returned to zero afterwards, with no hardware
failure, timeout or software fallback. Live NVIDIA operation continued to work,
and discovery retained all three cameras and one station.

Normal viewer playback selected `format=native`, correctly remuxing HEVC without
GPU work. To exercise conversion, the reporter temporarily forced the request
to `format=h264`, then restored the unmodified 0.8.8 source. This validates the
NVIDIA conversion route. It does not imply that native playback should transcode
or that users need to modify the source for normal operation.

These earlier successful live and recording tests are accepted as hardware
confirmation for this installation. The earlier recording's individual camera model and
device firmware were not specified, so this is not a separate recording-support
claim for every listed camera or for other GPU/driver combinations. Conversion
time excludes downloading the recording and is not a software-versus-GPU speed
comparison. Issues #49 and #54 retain the implementation and test history.


### Auto playback validation on 2026-09-14

The reporter [confirmed the complete v0.8.12 Auto playback flow](https://github.com/keesmod/ha-eufy-cam/issues/57#issuecomment-5666931668)
with the following environment. These are community-reported observations,
not an independent maintainer GPU test.

| Component | Reported value |
| --- | --- |
| Home Assistant | 2026.9.2 |
| Integration/card | 0.8.12 |
| Bridge | 0.8.11 |
| GPU and driver | NVIDIA T600 4 GB, 610.57.04 |
| HomeBase | HomeBase 3 T8030 |
| Recording source | T8425, HEVC |
| Acceleration settings | `EUFY_LIVE_ACCELERATION=nvidia`, `EUFY_RECORDING_ACCELERATION=nvidia` |

The earlier report identifies the host as Debian 13/Docker. The new report does
not restate the host OS or specify camera/HomeBase firmware or browser version.

With Playback format set to Auto, the UI showed **NVIDIA transcode** and the
recording played successfully. At the same time, `nvidia-smi dmon -s u` showed
peaks of 74% NVENC, 25% NVDEC, 19% SM and 9% memory activity. GPU activity returned
to 0% after preparation. This confirms Auto selection, the bridge conversion
route, the processing indicator and playback for this reported recording/setup.
It extends the earlier v0.8.8 test, which manually forced the H.264 request.

The reporter also retested Live with bridge 0.8.11. NVENC reached 6% and NVDEC 3%,
with GPU activity returning to 0% after closing Live. This is a live-path
regression check on the reported installation. The new comment does not name
the individual camera used for Live.

The main Auto/NVIDIA flow has a successful hardware test, but the reporter's
[later finding](https://github.com/keesmod/ha-eufy-cam/issues/57#issuecomment-5667209426)
adds intermittent NVIDIA failures followed by successful software playback.
Native remux, audio and forward/backward seeking passed. The reporter has not yet
found an H.264 source for the remux check at that point. The subsequent failure
investigation and accepted retest are recorded below.

Code review found that bridge 0.8.11 killed the entire hardware conversion at
10 seconds, even while it was encoding frames. A real, paced CPU FFmpeg test
reproduced this policy error without a GPU: 139 frames were encoded before the
10-second cutoff caused fallback. With progress-aware timing, the same 180-frame
input completed in about 11.5 seconds using one process. Bridge 0.8.12 fixes this
cutoff and reports bounded failure details for any remaining error. This proves
the watchdog correction, not that the reporter's T600 had no other failure.
The subsequent v0.8.14 report identified a separate 32 MiB output-limit failure.
Integration/card 0.8.15 and bridge 0.8.14 address that limit and remove the
persistent NVIDIA failure latch. The reporter then completed the retest below.

This evidence does not extend to every listed camera, other GPU/driver
combinations or the T8134 investigation in #10.

### Recording fix acceptance on 2026-09-14

The reporter [confirmed integration/card 0.8.15 and bridge 0.8.14 on the NVIDIA T600](https://github.com/keesmod/ha-eufy-cam/issues/57#issuecomment-5669792989).
Five different recordings passed, including those that previously triggered
`NVIDIA failure`. All five showed `NVIDIA transcode`. Auto, Native, H.264, audio,
seeking and repeated playback also passed.

Using `nvidia-smi dmon -s u`, the reporter observed approximately 70% NVENC and
24% NVDEC activity during conversion. Activity returned to 0% after playback
completed or the player closed. These are reported GPU utilization observations,
not memory-capacity measurements.

This completes reporter acceptance for issue #57 on the reported setup. The
retest does not identify each recording's camera model, firmware, browser or
source codec, and it does not restate the driver or host OS. Preserve the earlier
environment details as historical context. Do not generalize the result to all
cameras, other NVIDIA configurations or Apple clients.
