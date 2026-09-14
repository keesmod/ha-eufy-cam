# Live playback diagnostics

For a live view that switches to `Live video without sound`, integration 0.8.9
adds `live_playback` to the Home Assistant integration diagnostic download.
After one attempt, close the view and download diagnostics from the integration's
three-dot menu. This also supplies the numeric integration and HA versions.
No bridge restart, session reset or repeated login is needed to collect this
report. The card must have loaded the updated integration resource.

The report keeps the last eight WebRTC attempts per integration in memory.
Each attempt accepts at most one browser sample at each of three stages: five
seconds after readiness, the first acknowledged presented frame, and fallback.
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
the media route. Packets without decoded video point to decoding. Decoded video
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
