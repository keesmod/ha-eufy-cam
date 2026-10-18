# Changelog

## 0.8.39-beta.5
Unreleased

- Pin client 0.30.1 and record recording operations as `recording_query`
  records in the `Eufy discovery:` log lines and the bridge's diagnostics
  download ([issue #152](https://github.com/keesmod/ha-eufy-cam/issues/152)).
  On 2026-10-15 "Show recordings" failed on a standalone T8410 on the
  experimental route with `recording_unavailable`, and nothing said why. The
  bridge passes each list, calendar, thumbnail and download its signal and
  three callbacks. Client 0.30.1 reports through them what the operation saw.
- A HomeBase gets a record only for a failed operation, so its recordings and
  the events timeline do not fill the 100 recent events. Apart from the
  `client_disconnected` record below, a camera on the experimental standalone
  route gets no record when its recordings are opened, see the issue #175 entry
  below. Only the opt-in `standalone_recording_probe` entry below records an
  operation on it, with `query=probe`. When the bridge's client is not
  connected, each owner of the request gets a record with reason
  `client_disconnected`. A
  failure the client did not report, such as `client_closed`, keeps its code,
  and an error that is no client error is `unclassified_error`.
- The record has the stage the operation reached, its reason and numeric
  result, the device's answer to the last query page, the database replies the
  session could not use, row counts of an answered list including rows with a
  cipher ID, the connection stage and lookup fields when the operation had to
  connect, the elapsed time and the HTTP status the bridge answered with. It
  has no ID, path, name or address. The bridge checks each value against its
  bound. A repeat of the previous record of the same owner and query in a
  report adds no record, changed times or counts alone are a repeat.
- A recording attempt in the diagnostics download keeps the client's code
  behind its `error` as `cause`, with the numeric `result_code`, for example
  `recording_cipher_unavailable` behind `recording_unavailable`. A transfer that
  ended incomplete gives `transfer_` plus the client's reason, such as
  `transfer_connection_lost`.
- Observation only for a HomeBase. The HTTP status codes and bodies of its
  recording requests stay the same, and so do the client's queries, page sizes, timeouts
  and error codes. A failed or cancelled operation still closes the owner's
  session.
- Pin client 0.30.1, which reports the recordings of an experimental standalone
  T84A1, T8410 or T8410C as unavailable with reason
  `standalone_recordings_unverified`
  ([issue #175](https://github.com/keesmod/ha-eufy-cam/issues/175)). No known
  request lists or plays the recordings of a standalone T8410. In the
  [report of 2026-10-16](https://github.com/keesmod/ha-eufy-cam/issues/152#issuecomment-6208097780)
  both T8410s acknowledged the list query without answering it, and the T8410C
  rejected it with result -1100. This needs no bridge source change. Its existing
  capability check refuses each list, calendar, thumbnail and download for
  such a camera with `capability_unavailable` (HTTP 503) before any client
  call. The bridge therefore writes no `recording_query` record of its operations,
  and the 15-second wait is gone. The device row's
  `media.recordings` in the `Eufy discovery:` log line and the diagnostics
  download carries the reason. Snapshot and live view stay available. HomeBase
  cameras, their requests and their recordings are unchanged, and this change
  sends no new device request. Only the opt-in probe below adds one.
- Add the app option `standalone_recording_probe` (Docker
  `EUFY_STANDALONE_RECORDING_PROBE=true`), off by default, with client 0.30.1
  and its `probeStandaloneRecordings`
  ([issue #178](https://github.com/keesmod/ha-eufy-cam/issues/178)). With this
  option and `experimental_standalone` both on, the login discovery sends one
  read-only database query 10017 in the shape the Eufy app sends it to each
  experimental standalone camera, right after the camera's successful
  connection. It asks for the newest 20 records of today, the local date of the
  app or container. The bridge records every outcome as a `recording_query`
  record with `query=probe` and `returned=null` in the `Eufy discovery:` log
  lines and the bridge's diagnostics download. The discovery `summary` gains
  `standalone_recording_probe`, `true` when the option is on. The startup log
  says when the option is on, and adds a note when `experimental_standalone` is
  off, because then nothing is probed. Docker accepts `true` or `false`, an unset or empty value
  means off, and any other value stops the bridge with an error.
- The probe runs only in the login discovery. It never runs for a HomeBase or a
  camera behind one, and never in a discovery after a cloud reconnect. A login
  that is retried after a failure probes again. A probe failure is recorded and
  never fails the discovery or the login. HomeBase requests, every other
  payload, the recordings capability and the recording routes are unchanged,
  so recordings on standalone cameras stay unavailable.
- With the option on, the bridge reports ready later. Each standalone camera
  adds up to about 15 seconds plus its connection, and the HomeBase cameras of
  a mixed setup wait too. Turn the option off before you enter your Eufy
  credentials again in Home Assistant, because that login waits for the
  discovery. A camera that does not answer within 15 seconds has its session closed. Live
  view connects again on demand, and the snapshot keeps its last picture until a
  live view replaces it. The log then
  shows a `station_connection` line with `phase=observation` and
  `status=disconnected` before the probe line, and the camera's device row in
  that report shows `owner_status=disconnected`. The option stays in stable
  releases as a documented diagnostic, off by default.
- Add `POST /v1/snapshot/{serial}/refresh`, which refreshes one camera's
  snapshot on demand
  ([issue #182](https://github.com/keesmod/ha-eufy-cam/issues/182)). Until now
  a snapshot was only the latest HomeBase cover or the last frame of a live
  view, and nothing could ask for a new one. The bridge starts the camera as a
  live view would, or joins the live session that already runs. A refresh that
  joins a session that is still starting, such as a second press, waits for
  the same first frame as the viewer that started it. It keeps the
  newest frame about 1 second after the first one, because a battery camera
  that just woke can still adjust its exposure, and then leaves. When nobody
  else watches, the session ends with the usual confirmed stop. The answer is
  `{"snapshot_received_at": "..."}` with the time that frame arrived.
  `/v1/state` advertises the route with `snapshot_refresh: 1`, and
  `stream_metrics` gains `snapshot_refresh_requests`,
  `snapshot_refresh_completed` and `snapshot_refresh_failed`. A live session
  that a refresh started or joined is a normal `support.live_video` row with
  the pipeline event `snapshot_refresh`.
- A refresh wakes the camera and costs battery like a short live view. It
  counts against `live_max_streams_per_station` and is refused, never queued.
  The refusals are `station_limit` while the HomeBase is at its live limit,
  `camera_busy` when the bridge admits no further viewer of the camera,
  `recording_busy` during a recording operation and `live_stopping` while a
  previous session waits for its confirmed stop, all HTTP 409.
  `not_connected` without a connected Eufy session and
  `capability_unavailable` for a camera whose snapshot or live capability is
  unavailable are HTTP 503. A refresh without a frame ends with
  `refresh_timeout` (HTTP 504) when the camera did not deliver one in time,
  and with `refresh_failed` (HTTP 502) when its session ended for another
  reason. A refresh takes at most 30 seconds, and a client that disconnects
  cancels it. Nothing refreshes by itself. Snapshot requests, card loads and
  the event stream still never wake a camera.
- A finished live view's last frame no longer reverts to the older HomeBase
  cover at the next unrelated update. The bridge copied every cover it held
  again on each backend update, such as a station state change, so the
  snapshot and its `snapshot_received_at` went back in time. It now copies a
  cover only when the backend stores a new one, so the newest image stays the
  snapshot until a newer one arrives. Without this, a refreshed snapshot would
  revert the same way.
- Pin client 0.30.1, which delivers motion and person events of an
  experimental standalone Wall Light Cam S100 `T84A1`
  ([issue #185](https://github.com/keesmod/ha-eufy-cam/issues/185)). With
  `experimental_standalone` on, such an event reaches the `/v1/events` stream and the
  integration's event entity like the event of a camera behind a HomeBase. The
  client admits a push only when its device and station serial both name the
  camera, its type is 151 and its event code is 3101 (motion) or 3102
  (person). It refuses guard mode, alarm, microSD, undecoded and every other
  push, and every T8410 or T8410C push. No standalone push reaches the vendored
  station handler, so the camera gets no guard mode or alarm state. An event
  opens no camera connection and loads no image, so it brings no new event
  image and does not refresh the snapshot. No new option is needed. HomeBase
  cameras and their events are unchanged. Synthetic coverage only, the result
  on hardware is pending.
- Add `standalone_pushes` to the diagnostics download, the client's
  `standalonePushStatus` in snake_case: `arrived`, `admitted`, `refused` by
  reason, `sources` with `cloud` and `local`, and `event_codes` and
  `push_types` as rows of `{code, count}`. The bridge checks every value again,
  because it crosses the library boundary. A count is a whole number from 0 to
  2147483647 and else `null`. A code is a whole number from 0 to 99999, `none`
  or `other`, and any other row is left out, with at most 16 numeric rows plus
  `none` and `other` per list. The block is `null` without a client and in the
  setup report before the first login. A failed login keeps the counts of its
  closed client in the cached report. It has no serial, DID, address, name or
  image, and it is not part of the `Eufy discovery:` log lines.
- The startup line of `experimental_standalone` no longer says the route is
  unverified on hardware. It says that live view and snapshot are reported
  working, not independently reproduced, and that T84A1 motion and person
  events are experimental.

Upgrade: keep the same token and session. Update the integration to 0.8.48 to
keep the `recording_query` records and the attempt `cause` in **Download
diagnostics**, for recording texts that no longer name a HomeBase, and for the
standalone recordings text. Integration 0.8.47 still works but drops the
records and the cause, and shows the generic "Recordings: unavailable for this
camera connection" on a standalone camera. The log lines still carry the
records. The `standalone_recording_probe` option stays off until you turn it
on. Integration 0.8.48 also keeps its probe records and the summary field in
**Download diagnostics**, and adds a **Refresh snapshot** button per camera
that uses the new route. Integration 0.8.47 has no such button. Integration
0.8.48 keeps `standalone_pushes` in **Download diagnostics**, and 0.8.47 drops
it. Standalone T84A1 events reach both, because they use the existing event
path. Rollback: restore the 0.8.38 app backup and integration 0.8.47. A
standalone T84A1 then has no events again.

## 0.8.38 - 2026-10-15

- Report a beta bridge or client library version such as `0.8.38-beta.1` as
  received in the `software` field of the discovery `summary` and `connection`
  records. The `Eufy discovery:` log lines and the bridge's diagnostics download
  showed such a version as `unavailable` in bridge 0.8.37. Only a `-beta.N`
  suffix is accepted, with at most 24 characters. Firmware, hardware and Node
  versions stay numeric. The report schema stays 2.
- Pin client 0.30.0 and record what the local lookup of each station
  connection attempt saw
  ([issue #152](https://github.com/keesmod/ha-eufy-cam/issues/152)). A failed
  `connect` record, the `connect` record of a connected experimental standalone
  camera and the `refresh_state` record that follows a HomeBase's connect carry
  flat fields such as `lookup_rounds`, `lookup_datagrams`,
  `lookup_account_replies`, `lookup_foreign_replies`, `lookup_near_replies` and
  `lookup_inventory_reply`. They appear in the `Eufy discovery:` log lines and
  the bridge's diagnostics download. They are counts, booleans and one reply
  class, never an ID, address or port. The bridge checks each value against its
  bound and leaves out any other. The idle reconnect of a HomeBase records its
  lookup the same way. A changed lookup outcome is recorded again, changed
  counts alone are not.
- The lookup observation changes nothing in the lookup. Its targets, timing,
  retries and the ID it accepts are unchanged.
- Release a camera at once when its live start fails before the client library
  reported `start_issued`, for example a standalone camera on the experimental
  route that does not complete its connection
  ([issue #152](https://github.com/keesmod/ha-eufy-cam/issues/152)). A camera
  that never connects no longer stays in `stopping` until a bridge restart, so
  it can be started again, recording requests are no longer refused with
  `live_stopping` and no recovery attempt blocks other live starts. After `start_issued` a
  failed start keeps the quarantine until the device confirms its stop.
- Client 0.30.0 also admits a standalone Indoor Cam Pan&Tilt 2K `T8410C`/type
  31 to the experimental route
  ([issue #168](https://github.com/keesmod/ha-eufy-cam/issues/168)). With
  `experimental_standalone` on, the bridge now connects a standalone T8410C at
  every discovery, normally at startup, as it does for the T8410, and no longer
  names it in an `Eufy experimental standalone:` line. Each standalone T8410C
  that does not answer adds up to 20 seconds to startup. The startup log names
  all three models. Nothing changes for HomeBase cameras or with the option
  off.

Upgrade: keep the same token and session. Update the integration to 0.8.47 to
keep the lookup fields in **Download diagnostics**. Integration 0.8.46 still
works but drops the lookup fields. Rollback: turn
`experimental_standalone` off, which stops the standalone T8410C attempt and
also takes a standalone T84A1 and T8410 off the experimental route, or restore
the 0.8.37 app backup and integration 0.8.46, which keeps them on that route
with the option on.

## 0.8.37 - 2026-10-13

- Record whether `experimental_standalone` is on as `experimental_standalone`
  in the discovery `summary`. The report schema stays 2.
- With the option on, log one info line per standalone camera that the bundled
  client 0.29.2 keeps at `standalone_transport_unverified`, with its model code
  only: `Eufy experimental standalone: model=T8410C is not admitted to the
  experimental route. ...` Admitted T84A1 and T8410 cameras, cameras under a
  HomeBase and unsupported rows get no line
  ([issue #154](https://github.com/keesmod/ha-eufy-cam/issues/154)).
- Nothing else changes with the option on or off. The client pin stays 0.29.2.

Upgrade: keep the same token and session. Update the integration to 0.8.46 to
keep the field and get the `standalone_admission` finding in **Download
diagnostics**. Integration 0.8.45 still works but drops the field. Rollback:
restore the 0.8.36 app backup and integration 0.8.45.

## 0.8.36 - 2026-10-12

- Pin client 0.29.2. It recognizes exactly `T8160-C`/type 19 behind a HomeBase
  3, as reported on
  [issue #149](https://github.com/keesmod/ha-eufy-cam/issues/149), with the H3
  media policy and its owner and firmware checks. On public evidence it also
  recognizes exactly `T8410C`/type 31 behind a HomeBase 3, with the `T8410`
  policy under a HomeBase but without the experimental standalone route.
  Whether the two type 31 rows on issue #149 carry exactly `T8410C` is not
  verified. Hardware results for both remain pending.
- A standalone `T8410C`, with an empty or self parent, is now reported as
  `relationship=standalone` with `standalone_transport_unverified` instead of
  `unsupported_device`. Home Assistant then creates it as a camera whose
  snapshot, live view and recordings are unsupported, also with the option
  `experimental_standalone`.
- Discovery rows, the `Eufy backend:` line and the live video and audio rows
  now show an unhyphenated model code such as `T8410C` as received instead of
  `unavailable`. The bound stays at eight characters, so serial numbers still
  never appear.

Upgrade: keep the same token and session. Update the integration to 0.8.45,
because 0.8.44 shows such model codes as `unavailable` in its download.
Rollback: restore the 0.8.35 app backup and integration 0.8.44.

## 0.8.35 - 2026-10-12

- Pin client 0.29.1. With `experimental_standalone` on, a standalone Indoor Cam
  2K Pan & Tilt `T8410` now also tries its own local session at every
  discovery, normally at startup. On
  [issue #152](https://github.com/keesmod/ha-eufy-cam/issues/152) bridge 0.8.34
  left two such cameras at `standalone_transport_unverified` without an
  attempt. Each standalone T8410 that does not answer adds up to 20 seconds to
  startup. Unverified on hardware, see
  [client #142](https://github.com/keesmod/eufy-mega-client/issues/142).
- The startup log names both models. Nothing changes for HomeBase cameras or
  with the option off.

Upgrade: update the integration in HACS and this app, then restart. Keep the
same token and session. Integration 0.8.43 is also compatible with bridge
0.8.35. Rollback: turn the option off, or restore the 0.8.34 app backup and
integration 0.8.43.

## 0.8.34 - 2026-10-10

- Pin client 0.29.0 and add the option `experimental_standalone`, off by
  default. With it, a standalone Wall Light Cam S100 `T84A1` tries its own
  local session at every discovery, normally at startup. Its snapshot, live view
  and recordings are offered as experimental features and work only if that
  session works. A silent camera adds up to 20 seconds to startup. Unverified on
  hardware, see
  [client #142](https://github.com/keesmod/eufy-mega-client/issues/142).
- Discovery diagnostics report each standalone camera's inventory connection
  fields as booleans and the stage its own connection reached.

Upgrade: keep the same token and session. Without the option nothing changes.
Update the integration to 0.8.43 before turning the option on, because 0.8.42
names a failed standalone connection as a HomeBase failure. Rollback: turn the
option off, or restore the 0.8.33 app backup.

## 0.8.33 - 2026-10-09

- Pin client 0.28.2 to recognize exactly `T8113-V`/type 8 behind a HomeBase 3,
  as reported on [issue #66](https://github.com/keesmod/ha-eufy-cam/issues/66#issuecomment-6083775017).
  It shares T8113/T8113-Z discovery and snapshot/live/recording handling. Owner,
  firmware and lifecycle checks are preserved. Post-upgrade hardware results for
  the V variant remain pending.
- Standalone T84A1 media still requires the unimplemented authentication and
  transport route tracked by client #142. No fallback is enabled.

Upgrade: keep the same token and session. Integration 0.8.41 is compatible,
0.8.42 has the matching release notes. Rollback: restore the 0.8.32 app backup.

## 0.8.32 - 2026-10-08

- Update `ws` from 8.21.3 to 8.22.0 for the event stream and live sessions,
  and `uint8array-extras` from 1.5.0 to 1.6.0, which the client's image type
  detection uses. Live view, snapshots, recordings and events behave the same.

## 0.8.31 - 2026-10-06

- The startup log describes the current live evidence. With
  `live_max_streams_per_station` above 1 it says three concurrent cameras per
  HomeBase are verified and four are reported, and with
  `live_max_seconds_mains` above 120 it says 1800 seconds are verified on one
  mains powered camera. Only the log text changes.

## 0.8.30 - 2026-10-05

- Include client 0.28.0. Discovery admits the Wired Cam C31 that Eufy reports
  as `T817L` with device type 10031 under a HomeBase 3. Earlier versions
  rejected it, as reported on #136. Snapshots, live view, recordings and events
  are implemented but not yet confirmed on a C31 through this bridge. A C31
  without a HomeBase is recognized as a standalone camera without media.
- The lockfile resolves `http-cache-semantics` 4.3.0 for GHSA-ch52-4w7c-c8xp,
  and `date-and-time` 4.6.0 through client 0.27.0.

## 0.8.29 - 2026-09-28

- Include client 0.26.0. Discovery admits eufyCam 2C cameras that Eufy reports
  as `T8113-Z` with device type 8, with the same handling as `T8113`, and
  recognizes the Floodlight Cam 2K `T8424`, as its own station a standalone
  camera without media, as reported on #129. The discovery report keeps a
  model code with a short suffix instead of `unavailable`.
- The local lookup for the HomeBase also broadcasts on every external IPv4
  interface of the host, at most 16, when the inventory's LAN address stays
  silent or is missing, and only the HomeBase's own answer ends it. A failed
  connection records how far it got in `station_connection.stage` and
  `inventory_address`. Refs #130.

## 0.8.28 - 2026-09-25

- Include client 0.21.0. Every live video row in the diagnostics carries a
  `start` object with the library's start stages: the camera's P2P session
  ready, START issued, the station's answer with its return code, the P2P
  library giving the stream up without media, and the stream's metadata. A
  start without video then says how far it got. Refs #94.

## 0.8.27 - 2026-09-24

- The live encoder stamps frames with the wall clock since the bridge started
  it, not with FFmpeg's `RTCSTART`, which FFmpeg sets again when it rebuilds
  its filter graph after a mid-stream change of the frame size or pixel
  format. The video sync then dropped every frame until the stamps caught up,
  and the card switched to the JPEG fallback after 6 s. The output keeps one
  size and pixel format across such a change. Refs #94, #122.

## 0.8.26 - 2026-09-23

- Include client 0.18.1. Discovery admits a Video Doorbell C30 that Eufy
  reports as `T8224` with device type `96`, as reported on #40, with the same
  handling as a C30 with type `95`. Earlier versions rejected it as
  `unsupported_device`. Client 0.15.0 to 0.18.0 only add mower modules, and
  the camera modules are unchanged. Refs #40.

## 0.8.25 - 2026-09-23

- The live encoder writes FFmpeg's progress to a fourth pipe
  (`-progress pipe:3 -stats_period 1`), which the bridge always drains. The
  `encoder` object of the `support.live_video` row gains the counters of the
  latest block, `frames`, `dropped`, `duplicated`, `out_time_ms` and `bytes`,
  with the time of that block, its age frozen at the session's end, the times
  at which `frames` and `dropped` last rose, and `stderr_chunks` for the
  encoder's stderr data events. Whole numbers of five FFmpeg keys only,
  capped, and no FFmpeg text. Media flow, the fallback timing and every other
  encoder argument are unchanged. Refs #116, #94.

## 0.8.24 - 2026-09-22

- The support report gains `support.live_video`, one bounded row per live
  session next to the audio row, with the audio row's attempt as
  `audio_attempt`: chunks, bytes, first and last data times, the last data
  age and the largest gap for the P2P video input, the live encoder's
  MPEG-TS output and the JPEG frames, the encoder mode with its exits and the
  hardware to software transition, and the grant's video and audio readers
  as counts of attached, destroyed for backpressure, closed by the client and
  revoked with the time of the last destroy. The last data age at the
  session's end says how long before the end each point stopped, so a
  download after a `playback_timeout` fallback locates the stall. The row
  observes the existing streams and never changes media flow, the fallback
  timing or the encoder. Retained like the audio row, the configured cap
  plus fifteen minutes, and dropped by a bridge restart. Refs #112, #94.

## 0.8.23 - 2026-09-20

- The support report keeps a live audio row for the configured live session
  cap plus fifteen minutes instead of fifteen minutes from the attempt's
  start, so a session that ran to a raised `live_max_seconds_mains` is still
  in a diagnostics download taken after its end. Nothing else changes.

## 0.8.22 - 2026-09-19

- Include client 0.14.0. Its per-start live bound and its free primary
  session with `maxLiveStreamsPerStation` above 1 are the library side of
  keesmod/eufy-mega-client#163.
- Add the optional `live_max_seconds_mains` option (a whole number of seconds
  from 120 to 3600, default 120). It raises the absolute live session cap only
  for cameras the inventory reports without a battery value. Battery cameras
  keep 120 seconds in every case. The bridge passes the bound per start to the
  client, which sends the STOP at the bound, and the bridge's own watchdog uses
  the same value. Candidate pending observation on mains powered cameras.
- With `live_max_streams_per_station` above 1 the primary HomeBase session
  stays free, so guard mode commands and snapshots work while cameras are
  live. Recording playback still waits until no camera on that HomeBase is
  live.
- Live audio diagnostics keep their times up to 3600000 ms.

## 0.8.21 - 2026-09-18

- Include client 0.13.0. Its `maxLiveStreamsPerStation` option lets further
  cameras on one HomeBase stream live at the same time, each on its own P2P
  session, and its cloud identity renewal recovers from Mega result code 4404
  or 4416 without a manual reset.
- Add the optional `live_max_streams_per_station` option (a whole number from
  1 to 4, default 1). The bridge admits a camera while its HomeBase carries
  fewer live and starting cameras than the limit. Two concurrent streams are
  verified by the library and through this bridge on a HomeBase 3 with two
  eufyCam 3; three or four are unverified.
- Close a viewer refused by that limit with code 4013 so the integration and
  card can say that another camera on this HomeBase is live. Report the
  configured limit in `/v1/state`.
- Pair with integration 0.8.21.

## 0.8.20 - 2026-09-15

- Never mux audio into the live video encoder. Every session starts video-only
  and delivers AAC on the late-audio route as soon as its first complete frame
  arrives, 40 ms or 5 s after video. `ready` always reports `audio: false`; an
  audio transport error ends only the audio feed. Fixes the video stall and the
  missing audio of SoloCam cameras behind a HomeBase 3 whose audio starts
  seconds after video (issue #10).
- Bound the live encoder with a VBV cap, default `4M`, configurable through the
  new optional `live_max_bitrate` option (`200k` to `50M`). Stamp frames with
  their arrival time instead of the camera's announced rate so WebRTC playback
  no longer accumulates delay when the HomeBase delivers more frames.
- Pair with integration 0.8.20. The bundled client remains 0.12.3.

## 0.8.19 - 2026-09-15

- Add bounded recording attempt evidence to the existing diagnostic report,
  including processing, storage limits, cancellation and observed cleanup.
  Anonymous references correlate attempts with Home Assistant. No recording
  identifiers, paths, raw converter output or media enter the report.
- Include client 0.12.3 with shared exact device profiles and per-feature policy.
  Existing admission, command ownership, late audio and cleanup remain covered.
- Pair with the integration's new diagnostic download at player errors. One
  report identifies observed failure stages, loaded versions and missing evidence,
  reducing follow-up requests when investigating an issue.
- Add automatic regressions for concurrent recording readers, cancellation and
  reopening after fallback or late audio. Centralized profiles make known-family
  device additions easier to review without automatically admitting new models.

Update the bridge and HACS integration together to 0.8.19, restart Home
Assistant and refresh the dashboard. Back up both components and bridge data.
Restore the previous versions together to roll back. This batch does not add
hardware support or complete T8134 reporter acceptance. The existing Home
Assistant dependency security limitation remains tracked in camera issue #30.

## 0.8.17 - 2026-09-15

- Add AAC audio that arrives after a live session started without an audio track.
  Video keeps its existing encoder and connection. The same camera owner supplies
  complete AAC frames to an optional audio-only WebRTC connection. Failed audio
  setup does not interrupt video or extend the camera's viewing deadline.
- Keep initial A/V, video-only cameras, JPEG fallback, recordings, GPU settings,
  credentials and entity identities unchanged. Audio readers use the existing
  per-viewer grant and close with their owner. Older cards and integrations do
  not receive the new audio control events unless they opt in.
- Record `audio_late` when actual AAC becomes available, with browser audio
  negotiation and decoding counters covering the added track. No audio payload
  is retained in diagnostics.

Update both the bridge and HACS integration to 0.8.17, reload the integration or
restart Home Assistant, and refresh the dashboard. The published client remains
0.12.2. Back up both components before installation. Restore their previous files
or versions together to roll back, preserving app data and login state.

References #10. Tests confirm late-audio delivery and continued video. Exact
T8134 reporter acceptance remains pending. This release makes the change
available for testing. An external WebRTC connection that cannot establish ICE
still uses video-only JPEG fallback and needs reachable media connectivity.

## 0.8.16 - 2026-09-15

- Handle recording playback client disconnects without logging a traceback when
  the player closes or seeks. Header, chunk and final writes release their reader
  ownership, preserving later range requests and the existing session lifetime.
  Other I/O errors, timeouts and task cancellation still propagate. Addresses #69.

- Preserve `device_request_timeout` and future machine error codes in normal
  startup logs and Home Assistant diagnostic downloads without maintaining a
  separate list of accepted codes in each component. Both validate the complete
  code format and length. Raw error messages and unknown report fields remain
  excluded.
- Correct the HAOS app setup URL to `http://127.0.0.1:8063` in its README.

Update both the HACS integration and HAOS bridge app to 0.8.16. The bundled
client remains 0.12.2. Older integrations may omit newly preserved codes in the
download, so use the updated bridge's startup logs until both are updated.
Back up both components before installation. Restore their previous versions
and preserve app data, credentials and identities to roll back.

This improves diagnosis of issue #66. It does not fix the reported HomeBase
connection timeout or add T84A1 standalone media support. Software tests exercise
the diagnostic failure/download paths and real HTTP playback disconnects, with
reader and storage cleanup. Device commands and encoding remain unchanged.
Reporter verification of closing playback on their installation remains pending.

## 0.8.14 - 2026-09-14

- Replace whole-recording RAM buffers with private temporary files and bounded
  file transfer. Valid H.264 output above 32 MiB can reach both recording cards.
  Native H.264 and HEVC remuxing preserves AAC, duration and byte-range seeking.
- Remove the recording-wide NVIDIA failure latch. One failed conversion may use
  software once, after confirmed process cleanup. The next request tries its
  configured encoder again. Storage limits and storage errors are not GPU faults.
- Apply an aggregate HA recording storage allowance, including unfinished
  preparation and readers closing after session expiry. Interrupted preparation,
  transfer and playback release their owned resources. Both cards explain when
  recording storage is unavailable.
- Keep issue #57 open in Validation. Synthetic FFmpeg and browser checks do not
  replace repeat testing of the failing recording on the reporter's T600.

Includes integration 0.8.15, with unchanged client 0.12.2. Back up both components
before installing. Restore the previous integration and bridge together to roll
back, preserving credentials and identities.

## 0.8.13 - 2026-09-14

- Fix premature NVIDIA recording fallback by tracking encoded-frame progress.
  Healthy conversion can pass ten seconds while staying within the existing
  45-second total deadline. A ten-second stall still triggers bounded cleanup
  and one software attempt on the already downloaded recording.
- Always report bounded hardware failure categories, frame count, timeout scope
  and exit status. With `EUFY_DIAGNOSTICS=true`, an unclassified failure also
  includes a short scrubbed excerpt of the original FFmpeg error. Common secret,
  address and path patterns are removed. Review excerpts before sharing them.
- Preserve Auto / Native / H.264, media status, AAC audio, cancellation and
  the circuit breaker. Native remux, audio and seeking have reporter confirmation.
  The intermittent T600 failure still needs a repeat test with this correction.

Accompanies integration/repository 0.8.14. Back up the bridge before updating.
Restore its previous files to roll back while retaining its data and token.

## 0.8.12 - Internal candidate

- Fix premature NVIDIA recording fallback. Track encoded-frame progress instead
  of requiring the complete MP4 within ten seconds. Keep the 45-second total
  conversion deadline, ten-second stall timeout, single software fallback and
  confirmed process cleanup.
- Always log a bounded hardware failure warning with timeout scope, frame count,
  exit status and fixed FFmpeg error categories. Successful processing and
  circuit-breaker observations remain opt-in. Never emit raw FFmpeg output.
- Issue #57 remains in Validation for the reporter's intermittent T600 failure.
  A paced CPU FFmpeg regression reproduces the cutoff and verifies this fix.
  It does not establish the cause of every T600 failure.

Accompanies integration/repository 0.8.13. Back up the existing bridge before
updating. Restore its previous files to roll back while keeping its data and token.

## 0.8.11 - 2026-09-14

- Add bounded live audio format, continuity and processing observations, linked
  to a later browser measurement in Home Assistant diagnostics. Include ADTS
  header facts, buffered audio, stream cleanup and negotiated audio details
  without storing audio payloads. Issue #10 awaits T8134 hardware validation.
- Resolve recording Auto mode after reading the source codec. With configured
  NVIDIA acceleration, HEVC converts to H.264. Otherwise browser compatibility
  determines the format. Existing H.264 recordings and explicit Native remux.
- Return bounded per-request processing metadata to integration/card 0.8.12.
  Retain existing timeouts, cancellation, software fallback and process cleanup.
- After release, the reporter confirmed the Auto/UI NVIDIA route, playback
  and GPU cleanup on T600/T8030/T8425, plus a Live regression check. The reporter later confirmed Native, audio and seeking, but also reported
  intermittent NVIDIA fallback. An H.264 source remains untested by the reporter.
  See the [hardware validation record](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/NVIDIA.md#auto-playback-validation-on-2026-09-14).
  Back up the bridge and integration files before updating. Restore the previous
  files to roll back without changing data, token, credentials or entity identities.

## 0.8.10 - 2026-09-14

- Remove the software live bitrate and VBV limit from the previous candidate.
  Restore the original software encoder defaults while retaining diagnostics
  and existing NVIDIA settings. The cap was not supported by evidence of the
  reporter's root cause and its image-quality cost was not measured.
- Issue #10 remains open. Integration/card 0.8.11 retains playback diagnostics.
  Back up the bridge files and restore them to roll back, keeping its data/token.

## 0.8.9 - Withdrawn candidate

- Bound software live video to a 4 Mbit/s target/maxrate and 1 Mbit VBV buffer,
  matching the existing NVIDIA output budget. Preserve H.264/H.265 input,
  AAC conversion, ownership and cleanup. Complex scenes may lose detail.
- This is a robustness candidate for issue #10, not confirmed T8134 acceptance.
  Integration/card 0.8.10 carries the additional playback counters. Restore the
  previous bridge package to roll back while keeping the existing data/token.

## 0.8.8 - 2026-09-13

- Add separate Docker opt-in `EUFY_RECORDING_ACCELERATION=nvidia` for required
  HEVC-to-H.264 recording conversion. Keep native HEVC and H.264 remuxing and
  copied AAC audio. Software remains the default, including HAOS.
- Bound GPU conversion and retry once with software on the same downloaded
  bytes after confirmed process cleanup. Preserve cancellation, output limits
  and the overall deadline. Block conversion after unconfirmed cleanup.
- Add anonymous recording-route diagnostics and document the reported T600 live
  validation separately from pending NVIDIA recording validation.

Update integration and bridge when this version is published. Back up the
previous installation and preserve its token/data. Disable the new option and
recreate the container to return to software. Actual NVIDIA recording operation
requires a compatible GPU test before claiming hardware support.

## 0.8.7 - 2026-09-13

- Add experimental Docker opt-in NVIDIA live transcoding with
  `EUFY_LIVE_ACCELERATION=nvidia`. Software remains the default, including HAOS.
- Bound hardware startup to five seconds and 8 MiB of initial A/V. On a startup
  error, retry once with software inside the same camera session. Disable GPU
  attempts until bridge restart after a hardware failure. A later encoder failure
  ends the view safely, and the next view uses software.
- Add anonymous active-encoder and fallback events to opt-in live diagnostics.
  Document GPU exposure, driver capabilities and recovery in the
  [NVIDIA guide](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/NVIDIA.md).

Update both integration and bridge when this version is published. Preserve the
existing token and bridge data. Back up the previous matching installation for
rollback. Omit the acceleration setting to retain software operation.

No NVIDIA GPU was available for validation. T600 support, NVDEC/NVENC operation,
A/V synchronisation, image quality and performance remain unvalidated in issue
#49. This feature does not establish a startup-latency fix for issue #48. The
existing Python dependency limitation in issue #30 remains unchanged.

## 0.8.6 - 2026-09-13

### Live startup

- Start WebRTC signaling when the live encoder has actual audio metadata,
  without waiting for the JPEG fallback decoder's first frame.
- Bound FFmpeg analysis for both video and AAC inputs and the JPEG decoder.
  Keep analyzed packets so the initial keyframe remains available.
- Retain at most 1 MB of initial encoded output for at most two seconds so
  signaling can attach readers without losing the first video keyframe.
  Viewer revocation, slow-reader limits, fallback and camera stop ownership
  remain enforced.

### Upgrade and recovery

Update the integration and bridge together to 0.8.6 when available. This is a
software startup fix. The exact T8425/T8030 Docker startup time in issue #48
still needs an observation on that installation. No networking change is
required. Back up the previous integration, bridge and private bridge data
before updating. Restore that matching backup to roll back.

## 0.8.5 - 2026-09-11

### Logging improvements for diagnostics

This release includes all diagnostic changes since 0.8.1. Versions 0.8.2 through
0.8.4 were not published as GitHub releases.

- Include discovery rejection reasons and bounded received model/type pairs in
  normal bridge logs so missing devices can be investigated without debug mode.
- Collect one complete startup report with actual bridge/library/Node versions,
  authentication and inventory results, model/firmware details, anonymous device
  and HomeBase references, migration counts and push startup. Preserve available
  evidence when setup fails and distinguish missing observations from failures.
- Show explicit HomeBase/owner connection states, distinguish connection from
  state-refresh failures and record timestamped connection loss and recovery.
  Suppress unchanged repeated logs.
- Add an authenticated support download containing the complete latest discovery
  and up to 100 recent diagnostic events. Include it in Home Assistant's standard
  diagnostic download with actual HA/integration versions, also for failed setup.
- Bundle the verified eufy-mega-client 0.12.2 release for bounded received firmware
  and parent context on rejected devices. Independently filter shared reports in
  the bridge and HA integration to exclude credentials and device identities.
- Document collection steps, required versions, privacy checks and report field
  meanings. Link the guide from support pages and both issue forms.

### Upgrade and recovery

Update the Eufy Viewer integration to 0.8.5 through HACS and restart Home
Assistant. Separately update the bridge app or Docker installation to 0.8.5.
The bridge includes library 0.12.2, which needs no manual installation.

Download diagnostics from the integration's menu after the bridge has completed
one startup discovery. Alternatively, collect the complete `Eufy discovery:`
and `Eufy backend:` lines from the bridge's normal Logs tab. Debug is not needed
and bridge logs remain usable with an older integration. Review the file before
sharing it. See the [diagnostic collection guide](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/DISCOVERY_DIAGNOSTICS.md).

Existing Mega installations need no new login or migration because of this
update. Installations older than 0.8.0 must still follow the
[Mega migration guide](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/MEGA_MIGRATION.md).
Keep a backup of the previous integration, bridge and private bridge data.
For rollback, restore that matching backup through the normal installation or
Supervisor restore path.

### Scope and known limitations

Device admission, camera commands and media behavior are unchanged. This release
adds evidence for [issue #40](https://github.com/keesmod/ha-eufy-cam/issues/40),
not a confirmed fix for the reporter's missing C30 or floodlight camera.
The C30 model is already recognized by the library. The reporter's actual
model/type, topology and discovery result are still needed to locate the failure.
No additional hardware or media support is claimed.

The existing Home Assistant Python dependency limitation tracked in
[issue #30](https://github.com/keesmod/ha-eufy-cam/issues/30) remains unresolved.
The affected cryptography dependency and its alert are unchanged. This release
does not fix that vulnerability or claim a clean Python dependency audit.

## 0.8.1 - 2026-09-11

- Upgrade the camera bridge to the verified eufy-mega-client 0.12.0 release.
- Include its additional exact camera profiles and explicit unsupported-connection
  reasons. See the [library release scope](https://github.com/keesmod/eufy-mega-client/blob/v0.12.0/docs/RELEASE_0_12_0.md).
- Preserve camera identities, sessions and existing media capability checks.
  New profiles have software coverage, not a whole-family hardware guarantee.
- Retain bridge 0.8.0 and its private data backup for rollback. Existing 0.8.0
  installations need no new login or session migration. Older installations
  still follow the documented Mega migration steps.

## 0.8.0 - Candidate, not published

**BREAKING CHANGE: Mega is now the only camera backend.** Existing users must
update the HA integration before the bridge. The integration automatically saves
and transfers the device list. Legacy users sign in to Mega again. Old sessions,
credentials, entity IDs and backups are preserved. Missing devices pause migration.

- Remove the deprecated backend and direct eufy-security-client dependency.
- Handle old HA app backend settings automatically. Standalone Docker users
  remove EUFY_BACKEND=legacy when updating the container.
- Keep the previous bridge release and data backup for rollback.

Follow the [four upgrade steps](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/MEGA_MIGRATION.md). New-build hardware acceptance and the
Python security gate remain open in camera #31 and #30. Do not treat this
unpublished candidate as an accepted production release.

## 0.7.1 - 2026-09-11

- Automatically switch failed WebRTC playback to live JPEG over the existing
  authenticated Home Assistant connection. The player displays "Live video
  without sound" and hides the audio control after switching.
- Reuse the exact bridge socket and camera owner. Revoke only that viewer's
  WebRTC media grant. Do not issue another camera start, reconnect, extend the
  original lease or reset the absolute viewing limit. Ignore late WebRTC ACKs.
- Log fixed fallback reasons in HA and opt-in bridge diagnostics, without
  exposing upstream errors, media URLs or device identifiers.

Update the bridge and HACS integration together and restart HA. Keep the
existing account, token and data. WebRTC still provides audio when it works.
JPEG fallback has no audio and requires a working HA connection. It cannot fix
an unavailable camera. T8134 live-audio validation remains pending. Preserve a
backup and version 0.6.4 for rollback.

## 0.7.0 - Included in 0.7.1

- Carry camera snapshot, live and recording software capabilities into HA and
  both cards. Mark available operations experimental and show unsupported reasons.
- Reject unsupported media before bridge or HA requests can start a stream or
  recording operation. Preserve optional-field compatibility and existing IDs.
- Keep standalone cameras separate from HomeBase alarm entities. A failed owner
  does not prevent independent camera inventory setup.
- Pin the verified published client 0.10.0 package with SHA512 integrity. No new hardware
  support is claimed. Camera migration, release and legacy retirement remain open.
- No session or entity migration is required. Keep the previous integration,
  bridge package and private data for rollback. This version is not published.

## 0.6.4 - 2026-09-10

- Add opt-in live-stream diagnostics with per-attempt timing, incoming media,
  encoder output, playback acknowledgements and timeout categories.
- Keep diagnostics off by default. Emit fixed categories rather than raw
  encoder output, credentials, camera identifiers or media URLs. Limit repeated
  events to one per category per attempt.

Enable `diagnostics: true` in the bridge app configuration and restart the app.
For Docker, set `EUFY_DIAGNOSTICS=true` and recreate the container. Reproduce
one failed live view, save the diagnostic lines, then disable the option and
restart. This is a diagnostic aid. T8134 live playback remains unconfirmed.
Keep the existing account, token and data. Keep a backup and version 0.6.3 for
rollback. No camera timeout or ownership policy is changed.

## 0.6.3 - 2026-09-10

- Keep video-only live streams usable by forwarding the actual audio capability
  to Home Assistant and omitting go2rtc audio conversion when no supported audio
  track is present. Preserve audio conversion for audio-capable streams and
  compatibility with older bridges.
- Allow a corrected account login to replace automatic session-restore retries.
  Wait for any in-flight initialization to finish before creating another SDK
  owner. No session deletion or integration recreation is required.
- Add regression coverage for video-only and audio-capable negotiation, invalid
  metadata, recovery during backoff and serialized in-flight recovery.

Update the bridge and HACS integration together to 0.6.3, then
restart Home Assistant. Preserve the existing token, account and data. Keep the
previous version and a private backup for rollback. These fixes address code
paths implicated by issue #10. T8134 live playback still needs reporter
validation. Person event entities retain the last event, not a motion/idle state.

## 0.6.2 — 2026-09-10

- Update the independent Mega client to 0.1.1. Include T8142 eufyCam S220 / 2C
  Pro and T8134 SoloCam S220 paired with T8030 HomeBase 3 in camera discovery.
  Previously the model filter silently skipped these cameras, as reported in #10.
- Preserve existing camera protocol commands and the HomeBase 3 parent check.
  Standalone SoloCam operation is not included. Legacy behavior is unchanged.
- Automated discovery and protocol tests pass; S220 hardware validation of
  snapshots, live video/audio, recordings and real events is still pending.

Update the bridge to **0.6.2**, then the HACS integration to **0.6.2** and restart
Home Assistant. Keep the existing token, data and integration entry. This fix
applies to `backend: mega`; upgrading does not change your selected backend.
Report your backend, model, camera/HomeBase firmware and test results in issue
#10. Keep a backup and bridge/integration 0.6.1 available for rollback.

## 0.6.1 — 2026-09-10

- Fix silent recordings in Safari and the Home Assistant iOS/macOS apps. The MP4
  header now includes the AAC decoder configuration before playback starts.
- Preserve encoded audio and native video without extra transcoding. The fix
  applies to H.264, native H.265 and H.264 compatibility playback on both backends.
- Add regression checks for AAC profile, channel count and decoder configuration.

Update the bridge to **0.6.1**, then the HACS integration. Restart Home Assistant
and close and reopen any prepared recording. Existing HomeBase recordings need
no repair or camera setting change. Keep the existing data and bridge token.

## 0.5.1 — 2026-09-09

- Preserve native H.265 recordings as Apple-compatible hvc1 MP4 when requested
  by a compatible player. Copy AAC audio without re-encoding.
- Allow up to 45 seconds for H.264 compatibility conversion within the existing
  operation and media size limits.
- Write one complete MP4 fragment so native Apple players can play the full clip.

Update this bridge first, then the HACS integration to **0.5.1**. Restart Home
Assistant and refresh the dashboard in each app/browser. Keep existing app data
and credentials. The updated cards select the supported codec and handle one
H.264 fallback for native codec failures before or during playback.

## 0.4.1 — 2026-09-07

- Report session restoration as connecting from the start, so Home Assistant can
  wait for startup instead of requiring another login.
- Bound the Eufy country lookup to ten seconds and retry temporary initialization
  failures with backoff. Shutdown cancels pending retries; account verification
  and CAPTCHA challenges are not retried automatically.
- Verify automatic recovery after two complete HA OS VM reboots, with the same
  four cameras and HomeBase and no automatically started streams.

Update the HACS integration to **0.4.1** too, restart Home Assistant and reload the
dashboard. Keep the existing app data and token. The integration and bundled card
also fix the waiting state and stale unavailable messages.

## 0.3.0 — 2026-09-06

- New Eufy Events card: all-camera timeline, camera/date filters, HomeBase recording-day calendar and previous/next playback.
- Existing-event thumbnails, 12 visual results per page and bounded browser image caching; no live capture or cloud polling.
- Expand the SDK's 100-row day limit using the hardware-verified count field. Reject ambiguous/inconsistent histories rather than silently truncate them.
- Batch cameras by HomeBase; retain entity permissions, private file paths, expiring references and cancellation. Calendar markers require access to the full bridge inventory.
- Verified 95 camera recordings from a 105-row day and played an existing clip beyond the former first-100 cutoff in HA.
- Preserve WebRTC/audio, viewer leases and bounded stop recovery. Physical iPhone suspension/audio and other HomeBase firmware remain unverified.

Update the bridge app and HACS integration to 0.3.0, restart HA and change the existing dashboard resource to `?v=0.3.0`. Add **Eufy Events** through the card picker. HACS updates the integration/cards; the bridge updates separately through the HA App Store.

## 0.2.0 — 2026-09-06

- WebRTC video and listen-only audio through HA-managed go2rtc.
- On-demand listing and playback of existing HomeBase recordings by camera and date.
- Bounded recovery for live sessions that never emit a stop confirmation, without background polling or automatic stream restarts.
- Compatibility fix for successful Eufy profile responses that otherwise leave camera discovery empty after restart.

Update the HACS integration to 0.2.0 too, restart HA and refresh the bundled card resource. Existing app token and private data are retained. HomeBase 3 recording playback and four camera snapshots were validated; see the repository README for limits.

## 0.1.0 — 2026-09-05

Initial public release for HACS custom-repository installation.

- UI configuration, account verification/reauthentication, battery sensors and redacted diagnostics.
- Bundled visual-editor camera card: snapshots at rest, live video only after a tap.
- Shared viewers, immediate stop on close, independent bridge watchdog and a two-minute session cap.
- Home Assistant OS bridge app and standalone Docker build, with pinned Node dependencies.
- English/Dutch translations; Home Assistant 2026.9.0 baseline.
- Four cameras reported working in the first installation; instrumented start/close confirmation for one camera.

Live video is JPEG-based, up to 8 fps / 960 pixels wide, without audio. iOS suspension, power-loss behavior, long-term battery impact and broad model compatibility remain unverified. See the validation record.
