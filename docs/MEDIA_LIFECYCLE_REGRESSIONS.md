# Media lifecycle regression scenarios

[Story #77](https://github.com/keesmod/ha-eufy-cam/issues/77) adds the missing
cross-request sequences to the existing media tests. The starting point is
integration 0.8.18 and bridge 0.8.17 at
`61f72292b016d82b296ae0b5ca3a9663d9e17a33`.

## Coverage decisions

| Issue source | Existing coverage retained | Added scenario |
| --- | --- | --- |
| [#10](https://github.com/keesmod/ha-eufy-cam/issues/10) and [#48](https://github.com/keesmod/ha-eufy-cam/issues/48) | Delayed/batched AAC, video-only startup, late audio, TURN, missing answers, lost presentation and JPEG fallback | Close a viewer after fallback, then reopen on the same bridge and browser with working WebRTC audio/video. Also close before AAC arrives, then reopen and admit late AAC. |
| [#57](https://github.com/keesmod/ha-eufy-cam/issues/57) and [#69](https://github.com/keesmod/ha-eufy-cam/issues/69) | Real FFmpeg output above 32 MiB, codec recovery, seeking, HTTP disconnect and bounded storage | Two overlapping HTTP range readers while the session closes, expires or unloads. One reader can disconnect while the other continues. Check exact bytes and admission of the next recording. |
| Recording cancellation | Cancelled file writes wait for their worker | Repeated cancellation during an actual file read waits for the worker before releasing its descriptor and byte reservation. |

The new scenarios use the existing admitted media path. They do not change
protocol admission, runtime behavior, storage limits, startup deadlines or
component versions.

## Real browser sequences

`frontend/webrtc.spec.js` reuses the existing FFmpeg, go2rtc and Chromium fixture.
Only the camera source and HA message dispatch are simulated. H.264 video and AAC
audio are generated locally. The tests require decoded video, advancing viewer
acknowledgements and nonzero received audio energy after reopening.

Each cycle confirms a stop, zero active or quarantined camera sessions and exit
of the source and bridge encoder processes. Reopening also requires removal of
the previous go2rtc streams. The fixture removes its audio data listener before cancelling pending timers
when the source is disposed. FFmpeg can flush buffered stdout after a kill, so
otherwise it can create new delay timers after cleanup. The new process and
timer assertions reproduced this fixture race for delayed and batched audio.

The blocked-route fixture previously replaced only one local interface address
in go2rtc candidates. A machine with multiple interfaces could still connect
through another candidate. The new sequence reproduced that fixture defect.
The fixture now rewrites every candidate address in both directions, including
SDP and trickled candidates. Its first cycle must show JPEG fallback with no
decoded WebRTC playback, followed by successful WebRTC playback after reopening.

## Concurrent recording readers

`tests/test_playback_lifecycle.py` uses real aiohttp connections and anonymous
recording files. It holds two reads at different offsets while removing their
session through close, expiry callback or entry unload. HTTP writes are real.
The disconnect variants wait for the server transport to close before releasing
the first read.

The remaining reader must retain the file and its full byte reservation. Only
the final reader can release them. Every response is checked against distinct
source bytes at its requested offset. The next recording must regain a storage
slot and be readable. A local mutation that made every read start at offset zero
failed this test. The source was restored byte for byte afterward.

## Running the scenarios

Use the repository's pinned dependencies, Node 24 and Python 3.14. FFmpeg is
required. The full browser suite also needs go2rtc 1.9.14, Chromium and coturn.
CI installs its pinned go2rtc binary with checksum verification.

```sh
uv run pytest tests/test_playback_lifecycle.py tests/test_recording_storage.py tests/test_playback.py
cd frontend
GO2RTC_BINARY=/path/to/go2rtc npm test -- --grep 'and reopens' --workers=1
```

Run the existing `Validate` checks before integrating. The browser fixture uses
fixed local ports, so only one copy may run on a host at a time.

## Evidence limits

These tests establish software lifecycle behavior. The synthetic source's stop
confirmation does not establish a physical camera stop. Browser audio energy
does not establish audible sound on a user's speakers. Existing expanded-MP4
tests use CPU encoding and do not establish NVIDIA hardware acceptance.

The exact T8134 external route and audible audio remain in #10. The scoped
hardware acceptance already recorded in #48 and #57 remains unchanged. Final
integration, versioning, live installation and release belong to the batch
coordinator.
