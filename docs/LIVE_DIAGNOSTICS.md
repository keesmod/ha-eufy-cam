# Live playback diagnostics

For a live view that switches to `Live video without sound`, integration 0.8.9
adds `live_playback` to the Home Assistant integration diagnostic download.
After one attempt, close the view and download diagnostics from the integration's
three-dot menu. This also supplies the numeric integration and HA versions.
No bridge restart, session reset or repeated login is needed to collect this
report. The card must have loaded the updated integration resource.

The report keeps the last eight WebRTC attempts per integration in memory.
Each attempt accepts at most one browser sample at each of five stages: five
seconds after readiness, the first acknowledged presented frame, one second
after unmuted playback is available, fifteen seconds after readiness, and fallback.
Samples are independent of frame acknowledgements and never renew a viewer.
Closing the view cancels its timer. HA restart clears the history.

| Evidence | What it establishes |
| --- | --- |
| `offered`, `answered` | HA dispatched an offer and received a go2rtc answer |
| Browser `offer`, `answer`, `connection`, `ice` | The browser's own signaling and transport state |
| `local_candidate`, `remote_candidate`, `protocol` | Selected ICE route categories, without addresses |
| Relay `source_h264_packets`, `source_aac_packets` | go2rtc received packets from a matching codec source |
| Relay `output_h264_packets`, `output_opus_packets` | go2rtc sent packets to consumers, which may include its internal converter |
| Browser `video_packets`, `video_decoded`, `painted` | Received video, successful decoding and video frame callbacks respectively |
| Browser `ticks`, `acks_sent`, `acks_accepted` | The card's frame confirmation chain |
| Attempt `ticks`, `acks` | HA's forwarded ticks and accepted WebRTC acknowledgements, excluding JPEG acknowledgements |
| Browser `audio_packets`, `audio_samples`, `audio_energy` | Received audio packets, samples and whether decoded energy was nonzero |
| `last_frame_ms`, `ready_state`, `paused`, `muted` | Frame recency and player state at the sample |

Packet counts and nonzero decoded energy do not prove a speaker produced audible
sound. An absent field means unavailable, not zero. No browser samples can mean
an older cached card, direct JPEG selection, failure before readiness, or a
closed connection before the report arrived. Do not infer one of these without
other evidence.

For example, an installed answer with no packets and unconnected ICE points to
the media route. Packets without decoded video require checking loss, complete frames and decoding. Decoded video
with no advancing frame callbacks points to presentation. Advancing callbacks
without ticks or accepted acknowledgements points to the confirmation chain.
Compare the early sample with fallback to distinguish startup from a later
stall. EOF after fallback can result from intentional stream cleanup.

Reports contain only fixed categories and bounded scalar counters. They omit
SDP, addresses, URLs, credentials, track IDs, camera identifiers and media.
Relay requests have a one-second timeout and 64 KiB response limit. Diagnostic
failure does not stop playback. Review the download before sharing it.

## Issue 10 evidence boundary

The T8134 / 3.3.6.0 / T8030 / 3.8.5.2 reporter confirmed failure over local IP as
well as the external route. The 14 September bridge capture proves incoming
A/V and media output before the 15-second fallback. It does not contain browser
packet, decoder or presentation evidence. Earlier reports also include a
playback timeout after at least one accepted WebRTC acknowledgement.

Synthetic FFmpeg/go2rtc/Chromium tests pass for continuous A/V, video-only, silent
AAC, three-second audio delay and batched audio. Linux tests use the same FFmpeg
5.1.9 version as the bridge. A simulated audio interruption stalls the joint
encoder, which can lead to fallback, but the reporter's capture does not prove
such an interruption. Changing the MPEG-TS interleave limit did not resolve
that simulation and was not retained.

Local camera observations use T8160/T8213 with T8030. They do not establish T8134
hardware acceptance. Issue #10 remains open pending an instrumented attempt from
the affected installation. No new camera compatibility or audio-fix claim is
made by this diagnostic change.

## Bounded video candidate for issue 10

The unpublished integration/card 0.8.10 and bridge 0.8.9 candidate adds the
following scalar evidence. Missing fields still mean unavailable.

| Evidence | Meaning |
| --- | --- |
| Attempt `audio_expected` | The bridge admitted AAC at initial stream setup |
| Browser `audio_negotiated` | The current peer connection has a receiving audio transceiver |
| `video_lost`, `audio_lost` | RTP packet loss counters, which can be negative after duplicates |
| `video_received`, `video_decoded`, `painted` | Complete received frames, decoded frames and presented callbacks |
| `video_nack`, `video_pli`, `video_fir` | Retransmission and keyframe requests |
| `video_jitter_ms`, `audio_jitter_ms` | RTP jitter in milliseconds |
| Per-kind `buffer_delay_ms`, `buffer_target_delay_ms`, `buffer_min_delay_ms`, `buffer_emitted` | Cumulative jitter-buffer delays and emitted counts |

Dividing a cumulative buffer delay by its corresponding emitted count gives
an average delay for that sample. Compare changes between samples when examining
a stall. Packet receipt without decoding can also mean incomplete frames or
loss, including frame damage that does not leave sequence gaps.

The software encoder uses its original libx264 ultrafast/zerolatency defaults,
without an explicit video bitrate or VBV limit. The 4 Mbit/s software cap added
in PR #59 was withdrawn because the reporter's failure was not attributed to
bitrate and its image-quality cost was not measured. The existing NVIDIA
settings and the added playback diagnostics are unchanged.

The following comparison records the experiment, not a deployed fix.

Twenty-four comparisons used identical prerecorded synthetic H.264 sources and
identical AAC input through FFmpeg 5.1.9, go2rtc 1.9.14 and Chromium 152 on Linux.
They compared current transcoding, bounded transcoding and H.264 stream copy.
H.265 retained its H.264 conversion in all three configurations.

| Synthetic input | Current transcode | Bounded transcode | H.264 stream copy |
| --- | --- | --- | --- |
| Moderate, approximately 8.6 Mbit/s | 320 decoded, no loss | 320 decoded, 3.96 Mbit/s, no loss | 320 decoded, no loss |
| Extreme complexity | 16 decoded, 5141 lost, fallback | 315 decoded, 4.00 Mbit/s, no loss | 205 decoded, 939 lost, final frame 4.1 s old |
| Two-second moderate bursts, video-only | 298 decoded, no loss | 297 decoded, no loss | 159 decoded, 253 lost |
| Deliberate RTP gaps | Fallback | Fallback | Fallback |

Ordinary A/V, actual video-only and H.265 conversion remained operational. With
AAC deliberately delayed five seconds but declared present, all routes waited
roughly 5.5 seconds for their first presented frame. All 24 attempts passed the
single-owner, stop and cleanup assertions. Fault-injection binaries were used
only for the deliberate-gap cases and never for normal tests or deployment.

Browser RTP estimated playout clocks were also sampled. For ordinary A/V, the
median absolute audio/video clock difference was 51/75/79 ms for current,
bounded and copy, respectively. Moderate input measured 72/132/66 ms. Initial
transients reached 547 ms across the tests. These are clock estimates from
independently paced inputs, not physical lip-sync or speaker measurements.

The cap prevented overload in the extreme synthetic case. This does not
establish a suitable default or prove that bitrate caused the reporter's
failure. Approximately 8.6 Mbit/s traffic was healthy in the loss-free synthetic
controls. No objective before/after image-quality measurement was performed.
Issue #10 remains open for diagnosis and reporter validation.

## Separate late-audio boundary

Library PR [138](https://github.com/keesmod/eufy-mega-client/pull/138) keeps actual
codec discovery open after the three-second video startup deadline. AAC at
900, 2999, 3001 and 5000 ms is classified with one start event, and current live
metadata reflects its codec. The no-audio deadline is unchanged. This library
candidate is not part of the bridge's still-pinned 0.12.2 dependency.

A separate real browser test started a video-only mux, then supplied AAC after
five seconds. Video continued for 322 decoded/presented frames without fallback,
but the connection had no audio track. This proves the remaining consumer
boundary: initial metadata chooses the mux streams, go2rtc sources and SDP once.
Corrected library discovery alone cannot add audio to that existing connection.
A late-track implementation must explicitly coordinate mux admission and peer
negotiation while preserving video progress, one camera owner and bounded stop.
Increasing the initial wait merely moves the cutoff and is not a solution.

## Audio admission observations

Bridges with audio observation support include up to eight recent attempts in
`support.live_audio`. The matching `live_playback.audio_attempt` identifies the
same stream without exposing a camera identifier. Older bridges omit these fields.

Each attempt reports the camera and owner model/firmware, initial codec metadata
and audio admission. Data observations include first and last data times, largest
inter-chunk gap, chunk-size range and total bytes. Buffered bytes at admission and
at the latest observation distinguish pending data from an empty library stream.
Stream end/destruction and device stop confirmation are separate fields. Missing
first-data fields mean no data was consumed by this observation.

`format` inspects at most 128 ADTS frames or 256 KiB per attempt. It uses a rolling
seven-byte window and skips frame payloads without retaining them. The first and
latest recognized ADTS headers report MPEG version, audio object type, sample rate,
channel configuration, CRC presence, frame length and raw-data-block count. Object
type 2 denotes AAC-LC. Channel configuration is not always a channel count, notably
0 requires a program configuration element. Frame counts, configuration changes,
multi-block frames, skipped bytes, pending frame bytes and the inspection-limit
flag show incomplete framing or changes within the inspected prefix. Trailing
header bytes count an unfinished header search, not decoded samples.

`format_hint` recognizes initial ADTS, LOAS, ADIF, Ogg and RIFF signatures. These
are transport/container hints. Unknown data is not assigned an invented codec.
`first_adts` and `adts` may identify headers after an unrecognized initial prefix.
Structural frame completion does not validate payload decoding, CRC or an AAC
extension such as SBR. This observation is not a universal codec detector.

`pipeline` records each named media/input/output/reader/error/cleanup event at
most once, with at most 48 events. Encoder stderr is classified into fixed
categories, including `media_audio_error`, without copying its contents into the
report. This cached evidence does not require debug logging to be enabled. The
JSON contains no audio payload, raw header bytes or raw encoder messages.
Observations expire from the bounded history or disappear on bridge restart.

Times are milliseconds since the bridge requested the stream, capped at 120000.
`first_data_after_metadata_ms` starts when the library returns its stream metadata.
These are library stream consumption times, not raw network arrival times. The
observer does not start or consume the stream independently of the existing player.
The format inspection limit does not stop continuity counters or playback.

`initial_codec=none` with `admission=excluded` and later ADTS data exposes a mismatch
between audio admission and the bytes observed. It does not prove those bytes were
absent before admission, because the library may already have buffered them. In
library 0.12.2, metadata can remain `none` after the audio deadline, including
`first_data_codec` and `latest_codec`. Header parsing is independent of that value.
The library may already have normalized the data. No raw protocol audioType,
sequence number or camera timestamp is available from this bridge observation.

The browser's `audio_check` sample runs fifteen seconds after readiness. It adds
actual received-track state, volume, negotiated audio codec/clock rate/channels,
and the existing packet, sample, concealment and energy counters. HA also samples
the matching go2rtc stream. Compare these with bridge admission and output events
using `audio_attempt`. An existing relay packet count does not prove the browser
played it, and decoded energy does not prove a physical speaker emitted sound.

For one collection attempt, install the matching integration and bridge, restart
both, refresh the viewer, enable sound and leave the view open for about 25 seconds
after readiness when possible. Close it, then use Settings > Devices & services >
Integrations > Eufy Security Viewer > integration entry menu > Download diagnostics.
Download before restarting HA or the bridge. If playback fails earlier, download
that attempt as it is instead of requiring it to reach the late sample.

Local tests compare parsed 16 kHz mono and 48 kHz stereo AAC-LC generated by FFmpeg
against FFprobe. Fragmentation, unknown prefixes, CRC/header fields, configuration
changes, incomplete frames, inspection limits, privacy, stream preservation and
browser timer cleanup have regression coverage. Exact T8134 hardware validation
remains open. These observations do not themselves change playback.

## Late audio admission, 0.8.17

The [September 15 issue #10 report](https://github.com/keesmod/ha-eufy-cam/issues/10#issuecomment-5676491961)
contains complete AAC arriving after startup excluded audio. Client 0.12.2 can
retain metadata `none` throughout that attempt. The bridge now recognizes complete
ADTS frames from the existing audio drain and offers them to an opted-in viewer
without restarting its video or camera session. See [the protocol](PROTOCOL.md#late-live-audio-0817).

`audio_expected` still describes the initial A/V route. A later `audio_late`
pipeline event changes bridge audio admission to `forwarded`. Browser audio
counters include the optional audio peer. Video ICE fields and go2rtc relay
counters continue to describe the original stream, so absence of audio in those
relay counters does not exclude playback through the late audio peer.

Regression tests use real AAC starting six seconds after video. They verify
decoded audio, advancing video, one camera start and stop, and video continuity
when the audio answer is lost. Exact T8134 playback still needs reporter evidence.
The report's external ICE connection failure is a separate acceptance gap.
