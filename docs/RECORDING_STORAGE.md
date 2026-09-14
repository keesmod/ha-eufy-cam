# Recording resource ownership

Issue [#57](https://github.com/keesmod/ha-eufy-cam/issues/57) exposed two separate
problems. A valid NVIDIA conversion crossed a 32 MiB output buffer limit. The
catch path then treated that storage limit as a persistent hardware failure.
The same size limit existed again in HA, so changing only the bridge could not
fix playback.

## Design

A source recording and its H.264 conversion do not have the same compressed
size. The client still limits the encrypted-source download to 32 MiB and bounds
its stream backlog. Those are client transport constraints, not supported camera
resolution, duration or model claims. The bridge no longer concatenates the raw
tracks or the MP4 into whole-recording buffers. HA no longer holds complete MP4s
or copies a whole requested range into RAM.

The bridge spools the two source tracks to a private directory in its data
volume, `/data` by default or `EUFY_DATA_DIR`. After confirmed download completion,
FFmpeg reads those files and writes a seekable MP4. `faststart` moves metadata to
the front. This removes the whole-fragment buffer and special fragmented-output
flags while preserving complete duration, AAC discovery and native seeking.
The output travels to HA in stream chunks with backpressure. One bridge operation
owns download, conversion, response transfer and cleanup. A slow recipient cannot
release the operation early and accumulate completed files behind it.

HA stores the MP4 in an anonymous temporary file under its configuration volume,
`.eufy_recordings`. This uses the installation's existing writable storage contract.
It makes no claim about whether an administrator backed that volume with disk,
RAM or network storage. The bridge uses its data volume for the same reason.
Neither component assumes `/tmp` is disk, that a particular GPU exists, or that
the maintainer's free space represents another installation.

Files are necessary for two existing behaviors: native players make later seek
requests, and one software attempt must reuse a completed source after NVIDIA
fails. Retaining the source avoids another camera transfer. Retaining one MP4
avoids another conversion on every range request. There is no cross-request
recording cache, deduplication cache or permanent archive.

## Resource policy

- The bridge allows one recording operation, including delivery. Its existing
  60-second outer deadline remains. Conversion shares a 45-second budget across
  at most one hardware and one software attempt. Native remux uses 20 seconds.
  The existing hardware frame-progress watchdog remains 10 seconds. These are
  service budgets, not performance claims for a GPU or CPU model.
- A bridge output has a 256 MiB temporary storage ceiling, independently of
  source size. FFmpeg stops writing at this limit, allowing its final packet and
  trailer overhead. The bridge checks final file size and rejects output at or
  above the ceiling even if FFmpeg exits successfully. It never publishes a
  shortened clip as successful playback. This is a finite storage policy with
  eight times the previous source-sized allowance, not a claim that every
  possible H.264 conversion fits. Output beyond it remains unsupported.
- HA shares one 256 MiB allowance across all pending, playing and closing
  recording files. Bytes are charged before asynchronous writes. A file keeps
  its charge until the last owner closes it. Eight small recordings cannot each
  consume 256 MiB. No disk capacity is preallocated or assumed to exist.
- HA admits at most eight pending or prepared files and eight response readers.
  Full responses and ranges use 64 KiB reads, independent file offsets and a
  65-second response deadline. Slow or abandoned reads cannot retain storage
  indefinitely. Expiry closes session ownership while an already admitted
  reader temporarily retains its own reference.
- Disk exhaustion, denied writes and storage limits fail the current request.
  Both cards display a storage-specific message. Available filesystem capacity
  can be lower than the allowance. The allowance is a maximum, never a promise
  that the installation can supply it. Close other recordings or use Native
  when conversion output exceeds available recording storage.

The selected ceiling makes the reported 33,563,861-byte output admissible without
replacing a 32 MiB RAM buffer with a larger RAM buffer. A fixed aggregate policy
also prevents the eight-session count from multiplying the storage allowance.
Deployments still need writable volumes with space for their requested workloads.
No recording limit can reserve resources against unrelated applications.

## Failure, cancellation and access

A hardware failure may select software once after process termination is
confirmed. There is no persistent hardware-failure latch. The next request tries
its configured encoder again. A storage limit, storage write failure or browser
cancellation never triggers a software retry or marks the GPU unavailable.
`recording_failed` distinguishes terminal preparation/storage failures from
`recording_hardware_failed` and `recording_hardware_timeout`.

Unconfirmed process cleanup still blocks further conversions until restart.
This prevents overlapping an unknown process with a replacement. Source transfer
cancellation continues through the unchanged client's stop-confirmation path.
Normal completion, response errors and cancellation remove the bridge workspace.
On the first new recording after restart, the bridge removes workspaces belonging
to dead bridge processes, retaining directories for still-running processes.
Anonymous HA files disappear when their last descriptor closes, including process
termination. Disk workers finish before cancellation can close their descriptor.

Signed URLs keep their five-minute expiry, authenticated user ownership and
current camera permission checks. DELETE, expiry and integration unload release
session ownership. HEAD and single byte ranges use the same access checks.
Seeking never contacts the HomeBase. Both cards retain Auto / Native / H.264,
shared preference, per-request media status, stale-answer cleanup, position and
pause restoration, and one codec-only recovery attempt. Live video and the
shared client are unchanged.

## Evidence and remaining acceptance

Automated tests exercise real FFmpeg conversion of a 132,139-byte synthetic
HEVC/AAC source into a valid 58,029,770-byte H.264/AAC MP4. A CPU encoder is
intentionally configured to emit a high bitrate to reproduce output expansion.
The Node buffer increase at the completed-file boundary remains below 8 MiB.
The test decodes audio and video, checks duration, seeks both ways, refuses a
concurrent bridge request during delivery and verifies file removal. Another
real FFmpeg test reaches the disk ceiling and rejects the shortened result,
then proves that another hardware-route attempt is still admitted.

HA HTTP tests cross the old limit, check ranges around 32 MiB, reject truncated,
empty, oversized and failed writes, and verify aggregate accounting through
cancellation and response ownership. Chromium tests play a valid MP4 above the
reported cutoff in both cards and preserve seeking, pause and close behavior.
Storage errors do not trigger a codec-recovery retry.

These automated results are software and synthetic-media evidence. Separate
[reporter acceptance on 2026-09-14](https://github.com/keesmod/ha-eufy-cam/issues/57#issuecomment-5669792989)
confirms integration/card 0.8.15 and bridge 0.8.14 on the reporter's NVIDIA T600.
Five recordings passed, including the previously failing clips. Auto, Native,
H.264, audio, seeking and repeated playback passed, with GPU activity returning
to 0% after completion or closing the player.

This completes the reported issue #57 acceptance. It does not establish behavior
on other hardware or Apple clients. The retest does not specify the source codec
and camera model for each clip, so it does not add a separate H.264-source claim.
See [the scoped hardware record](NVIDIA.md#recording-fix-acceptance-on-2026-09-14).
