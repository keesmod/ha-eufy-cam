# Local bridge protocol, version 1

Control routes require `Authorization: Bearer <bridge token>`. The media-only route uses an ephemeral, unguessable grant issued to an authenticated viewer, revoked when its lease ends. Tokens are never accepted in query strings. Bridge WebSockets reject browser Origin headers. Put TLS in front of the bridge if the LAN is not trusted.

| Endpoint | Meaning | Camera side effect |
|---|---|---|
| `GET /v1/state` | Protocol version, stable bridge ID, account state, cached camera inventory, configured live limit per HomeBase | None |
| `POST /v1/login` | Account credentials or verification/captcha response | Login/discovery only |
| `GET /v1/snapshot/{serial}` | Cached JPEG/PNG; 404 if absent | None |
| `WS /v1/events` | Initial state followed by push updates | None |
| `GET /v1/media/{grant}` | Existing MPEG-TS feed, 256-bit grant | Cannot start or renew; closes when owning viewer ends |
| `GET /v1/media/{grant}/audio` | Complete late AAC ADTS frames under the same viewer grant | Cannot start or renew; closes when owning viewer ends |
| `WS /v1/live/{serial}?transport=webrtc` | `ready` with grant path, then one pending `tick`; client text `ack` | Same lease and start/stop rules |
| `WS /v1/live/{serial}` | Viewer lease, binary JPEG frames; text `ack` after each processed frame | First viewer starts; last close/expiry stops |

The HA-side `eufy_viewer/watch` subscription accepts `entity_id` and optional `transport` (`jpeg`, the compatibility default, or `webrtc`). Frames carry the subscription ID, sequence and base64 JPEG. `eufy_viewer/ack` accepts the subscription and sequence, bound to the requesting HA connection. HA's normal `unsubscribe_events` releases the viewer.

Limits: 5 MB cached snapshot, 1 MB state message, 256 KB live JPEG, 4 viewers per camera, `live_max_streams_per_station` live cameras per HomeBase (default 1, up to 4, one client P2P session per concurrent camera), 8 camera slots at the bridge (including quarantined stops), 40 bridge sockets, 4 watches per HA connection and 16 per HA config entry. No media auto-reconnect. Watchdog tick 250 ms; first-frame timeout 20 s; processed-frame lease 10 s; absolute cap 120 s.

Upstream references used independently:

- [Eufy Mega client](https://github.com/keesmod/eufy-mega-client), release `0.10.0`, pinned by exact tarball URL and SHA512 in `bridge/package-lock.json`. Its permitted protocol adaptation retains MIT and Apache-2.0 attribution. No eufy-security-client runtime package is shipped.
- [Eufy WebSocket protocol](https://github.com/bropat/eufy-security-ws/tree/master/docs), inspected during architecture selection; this project does not require that server.
- [Home Assistant camera entity](https://developers.home-assistant.io/docs/core/entity/camera/).
- [Home Assistant WebSocket extension API](https://developers.home-assistant.io/docs/frontend/extending/websocket-api/).
- [HA frontend WebSocket client](https://github.com/home-assistant/home-assistant-js-websocket/blob/master/lib/connection.ts), including `resubscribe: false`.

`/v1/state` advertises `transports: ["jpeg", "webrtc"]`. WebRTC watch events contain `ready`, `answer`, `candidate`, `tick` or `ended` (optionally with `reason`). The browser sends `eufy_viewer/signal` with its subscription and `offer` or `candidate`, bound to the original connection and current entity permission. Only one offer is accepted; SDP is bounded at 65,536 characters and ICE candidates at 2,048. The card gathers local ICE before offering, queues early remote candidates, and never reconnects media automatically. Each fresh painted video frame can acknowledge at most one pending tick through `eufy_viewer/ack`. Merely receiving control messages does not renew the camera lease.


## Late live audio, 0.8.17

The card requests `late_audio: true` only when the camera advertises
`viewer_late_audio`. HA forwards this as `late_audio=1` on the existing WebRTC
lease. Older cards retain the original control messages and playback behavior.

If startup metadata excluded audio, the bridge observes its existing audio drain.
The first complete valid ADTS frame makes the same grant's `/audio` route available
and emits `audio_ready`. It retains at most one incomplete frame of 8191 bytes,
with no replay cache. Readers join at complete frame boundaries. Unknown data or
an ended source closes only the audio feed. Video and audio share the eight-reader
limit per camera and the audio response has a 256,000-byte backpressure limit.

HA validates the route against this viewer's original grant, then prepares a
separate managed go2rtc AAC-to-Opus stream. The browser attaches its audio-only
peer's track to the existing video element, retaining mute and volume settings.
Normal audio present at startup keeps the existing A/V route. Video, its encoder,
camera ownership and processed-frame acknowledgements do not change.

Audio signaling uses the existing connection-owned `eufy_viewer/signal` command
with `audio: true` and one offer, candidates or `stop: true`. Events are
`audio_ready`, `audio_answer`, `audio_candidate` and `audio_ended`. HA bounds stream
setup at five seconds and signaling sends at ten seconds. The browser abandons
audio after fifteen seconds without arriving media. Audio setup or connection
failure closes only audio. Navigation, viewer close, JPEG fallback and session
expiry release both peers and both go2rtc streams. Audio never renews the camera
lease. External ICE reachability and JPEG's video-only behavior remain unchanged.

## Audio always on its own route, 0.8.20

The 0.8.17 late-audio route is now the only live audio route. The bridge never
muxes AAC into the MPEG-TS at `/v1/media/{grant}`: a joint encoder emits nothing
until its first audio frame exists and holds video for the length of every audio
gap, which a HomeBase 3 relaying a sleeping SoloCam produces (first AAC 4-5 s
after the first video frame on a cold start, 40 ms on a warm start). `ready`
therefore always carries `audio: false`, and the integration must not add an
audio source to the main go2rtc stream. Whenever the first complete ADTS frame
arrives, before or after the browser peer plays, the bridge emits `audio_ready`
for the same grant once per lease, still only when HA opened the lease with
`late_audio=1`. The library's startup classification survives only as the
observational `audio_supported`/`audio_absent` diagnostic marks; `audio_input`
now records any arriving audio data and `audio_late` the first forwarded frame.

HA opens the audio stream only for a ready, opted-in viewer that owns the route.
An `audio_ready` it cannot use (video setup failed or was downgraded to JPEG, or
an older bridge that reported `audio: true`) and a repeated `audio_ready` are
ignored and recorded, never fatal; a missing opt-in or a foreign path still ends
the lease. Older bridges reporting `audio: true` keep their joint go2rtc audio
source. An audio transport error on the bridge closes only the audio feed. The
browser makes one audio attempt per live view; a failed or timed-out attempt
gets audio again only after closing and reopening the view.

The video encoder stamps each frame with its arrival time rather than counting
frames at the camera's announced rate, so WebRTC playback no longer accumulates
delay when a HomeBase delivers more frames than the header announces. Its
output is bounded by a VBV cap, `EUFY_LIVE_MAX_BITRATE` (default `4M`; add-on
option `live_max_bitrate`), which limits keyframe bursts on WiFi viewers.


## Live cameras per HomeBase, 0.8.21

The bridge admits a first viewer for a camera while the number of live and
starting cameras on its HomeBase is below `EUFY_LIVE_MAX_STREAMS_PER_STATION`
(app option `live_max_streams_per_station`, a whole number from 1 to 4, default
1), mirroring the bundled client's `maxLiveStreamsPerStation` before a start is
issued. The same camera is never admitted twice, and recording preparation still
requires that no camera on the HomeBase is live. A viewer refused by the limit
is closed with WebSocket code `4013` and reason `HomeBase live limit reached`;
every other refusal keeps `1013 Camera busy or stopping`. The integration
forwards `4013` as `reason: "station_limit"` on its `ended` event and omits
`reason` otherwise, so older cards and integrations keep their generic
behaviour. `/v1/state` reports the configured limit as
`live_max_streams_per_station`.

Three concurrent cameras were verified on hardware through the bridge's own
viewer path on 2026-09-19 (one HomeBase 3, three eufyCam 3, device-confirmed
stops, no startup timeout), see the [test record](CONCURRENT_LIVE_2026-09-19.md).
Software transcoding of three streams saturated a 2-core host, so the option
value that a given host and transport can sustain is a capacity question, not a
protocol limit. Three concurrent WebRTC streams in a browser on a
software-transcoding host remain unverified.

## Existing recordings

- `GET /v1/recordings/{serial}?date=YYYY-MM-DD`: authenticated on-demand P2P calendar query. Returns `{recordings: [{id,start,end,bytes}], returned}`. Dates/times retain the HomeBase calendar values. `returned` is the station response count before camera filtering, not a verified total. No raw device paths or account fields cross the bridge boundary.
- `GET /v1/recordings/{serial}/{id}/video`: downloads one previously enumerated existing file and prepares finite `video/mp4`. Optional `?format=native` preserves H.265 as `hvc1`; the default `h264` converts H.265 for compatibility. H.264 video and AAC audio are copied. Unknown formats are rejected. Output is a seekable MP4 with its metadata moved to the front, preserving complete duration, AAC discovery and native Apple seeking. IDs expire after 15 minutes, are bound to the camera and vanish on restart/reauthentication. The request socket owns cancellation.
- HA exposes authenticated `GET /api/eufy_viewer/recordings/{entity_id}?date=…` and `GET /api/eufy_viewer/recordings/{entity_id}/{id}`. Both enforce entity read permission before reaching the bridge. A browser disconnect cancels the upstream request. These legacy binary routes remain available.
- Preparation is globally serialized against other recording operations and live streams. The operation has a 60-second deadline including response transfer. The client retains its 32 MiB compressed-source limit. The bridge uses a separate 256 MiB temporary output allowance and rejects incomplete output at that limit. Closing the card, changing date, hiding the page or navigating cancels pending work and releases prepared playback. The bridge sends download cancellation on interrupted transfers. No camera livestream is used to produce a recording.
- Native playback uses authenticated `POST /api/eufy_viewer/recordings/{entity_id}/{id}/playback`. Optional `?format=native` is forwarded to the bridge after the same access checks. Both cards request it only when the native video element reports HEVC support, with one H.264 retry for a codec/decode error before or during playback. Recovery preserves the playback position and paused state; both cards show preparation progress or a terminal error. Closing or changing recordings cancels recovery and releases late responses. Network errors, a stalled load and cancellation do not trigger a compatibility retry. It prepares one MP4 and returns a playback path plus a five-minute HA-signed URL. The signature is tied to the requesting refresh token and exact path; it is not a long-lived access token.
- `GET`/`HEAD /api/eufy_viewer/playback/{id}` require HA authentication, the original user and current camera read permission. Full and single-range responses use `Cache-Control: no-store`. Seeking never repeats the HomeBase download. HA uses anonymous files in its configuration volume with one shared 256 MiB allowance, at most eight prepared or pending files and at most eight response readers. In-flight writes and files held by readers after expiry still count toward the allowance. Files expire automatically. See [recording resource ownership](RECORDING_STORAGE.md). Authenticated `DELETE` on that path releases media on close; integration unload/shutdown also releases its entries. Do not share or log signed playback URLs.
- `/v1/state` adds `recording_metrics` (`queries`, `downloads`, `completed`, `remuxed`, `transcoded`, `cancelled`, `active`), separate from the existing live stream counters.

Recording failures use allowlisted JSON error codes: HTTP 409 `live_busy`, `live_stopping` or `recording_busy`; HTTP 410 `recording_expired`; HTTP 503 `recording_unavailable` or `recording_storage_unavailable`. HA forwards only these known codes and the card translates them. Other upstream details remain redacted. Stream metrics additionally count bounded recovery attempts, completions and failures.

## Events timeline (0.3.0)

- `GET /v1/recordings?cameras=SERIAL,SERIAL&date=YYYY-MM-DD` queries each distinct HomeBase once per expansion and returns `{recordings, returned, complete:true}`. A recording includes `id`, `serial`, `start`, `end`, `bytes`, and `thumbnail`. Camera serials must belong to the current inventory. Paths remain private. Failure to establish the bounded complete day is HTTP 503 `history_incomplete`, never a successful partial page.
- `GET /v1/recording-days?cameras=SERIAL,SERIAL&month=YYYY-MM` uses SDK `databaseCountByDate`/10008 and returns `{days:[YYYY-MM-DD]}`. The firmware's count flags mark presence, not the number of recordings.
- `GET /v1/recordings/{serial}/{id}/thumbnail` uses only that reference's stored `thumb_path`. It accepts only the matching SDK `image download` event, checks JPEG bytes, caps the response at 2 MiB and waits at most 8 seconds. Missing/malformed previews use HTTP 503 `thumbnail_unavailable`. No frame is captured from a live camera.
- HA exposes `/api/eufy_viewer/events?entities=camera.one,camera.two&date=…` or `&month=…`, mapping bridge serials to entity IDs and dropping non-public fields. Every requested entity is authorized before any bridge call. HomeBase calendar markers additionally require read access to every current bridge camera, since the firmware does not support camera-filtered day presence. Restricted users can still browse their own cameras' dated events.
- HA thumbnail URL: `/api/eufy_viewer/recordings/{entity_id}/{id}/thumbnail`, with the same authenticated entity permission checks as video. All replies have `Cache-Control: no-store`.
- Event JSON is limited to 4 MiB and 10,000 records across a request; preview memory in the card is capped at 24 images. The list uses 12 visual tiles per page. SDK query limits expand 100 → 500 → 2,000 → 10,000; the final full limit is rejected. This is verified prefix expansion on the pinned HB3 firmware, not a claimed universal Eufy continuation cursor. The SDK's `start_time` did not act as a cursor on the tested device.

## Migration admission

0.8.0 advertises `migration.version: 1` in authenticated state. The integration prepares its expected camera/station IDs against the previous connected bridge and sends that private baseline to `POST /v1/migration`. The endpoint requires the existing bridge token and matching bridge identity. It writes an immutable allowlisted inventory, accepts identical retries, and rejects replacement or busy-owner writes. No sessions or credentials belong in the request.

The bridge validates the expected inventory before accepting Mega discovery. Existing shared credentials require a prepared baseline. A legacy baseline requires new user-entered Mega credentials. Old credentials and sessions are retained for rollback. Authenticated state exposes fixed migration error codes, never raw errors or private paths.
