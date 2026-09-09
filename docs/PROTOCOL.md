# Local bridge protocol, version 1

Control routes require `Authorization: Bearer <bridge token>`. The media-only route uses an ephemeral, unguessable grant issued to an authenticated viewer, revoked when its lease ends. Tokens are never accepted in query strings. Bridge WebSockets reject browser Origin headers. Put TLS in front of the bridge if the LAN is not trusted.

| Endpoint | Meaning | Camera side effect |
|---|---|---|
| `GET /v1/state` | Protocol version, stable bridge ID, account state, cached camera inventory | None |
| `POST /v1/login` | Account credentials or verification/captcha response | Login/discovery only |
| `GET /v1/snapshot/{serial}` | Cached JPEG/PNG; 404 if absent | None |
| `WS /v1/events` | Initial state followed by push updates | None |
| `GET /v1/media/{grant}` | Existing MPEG-TS feed, 256-bit grant | Cannot start or renew; closes when owning viewer ends |
| `WS /v1/live/{serial}?transport=webrtc` | `ready` with grant path, then one pending `tick`; client text `ack` | Same lease and start/stop rules |
| `WS /v1/live/{serial}` | Viewer lease, binary JPEG frames; text `ack` after each processed frame | First viewer starts; last close/expiry stops |

The HA-side `eufy_viewer/watch` subscription accepts `entity_id` and optional `transport` (`jpeg`, the compatibility default, or `webrtc`). Frames carry the subscription ID, sequence and base64 JPEG. `eufy_viewer/ack` accepts the subscription and sequence, bound to the requesting HA connection. HA's normal `unsubscribe_events` releases the viewer.

Limits: 5 MB cached snapshot, 1 MB state message, 256 KB live JPEG, 4 viewers per camera, 8 camera slots at the bridge (including quarantined stops), 40 bridge sockets, 4 watches per HA connection and 16 per HA config entry. No media auto-reconnect. Watchdog tick 250 ms; first-frame timeout 20 s; processed-frame lease 10 s; absolute cap 120 s.

Upstream references used independently:

- [Eufy Security Client](https://github.com/bropat/eufy-security-client), package release `4.1.1-1`, pinned in `bridge/package-lock.json`.
- [Eufy WebSocket protocol](https://github.com/bropat/eufy-security-ws/tree/master/docs), inspected during architecture selection; this project does not require that server.
- [Home Assistant camera entity](https://developers.home-assistant.io/docs/core/entity/camera/).
- [Home Assistant WebSocket extension API](https://developers.home-assistant.io/docs/frontend/extending/websocket-api/).
- [HA frontend WebSocket client](https://github.com/home-assistant/home-assistant-js-websocket/blob/master/lib/connection.ts), including `resubscribe: false`.

`/v1/state` advertises `transports: ["jpeg", "webrtc"]`. WebRTC watch events contain `ready`, `answer`, `candidate`, `tick` or `ended`. The browser sends `eufy_viewer/signal` with its subscription and `offer` or `candidate`, bound to the original connection and current entity permission. Only one offer is accepted; SDP is bounded at 65,536 characters and ICE candidates at 2,048. The card gathers local ICE before offering, queues early remote candidates, and never reconnects media automatically. Each fresh painted video frame can acknowledge at most one pending tick through `eufy_viewer/ack`. Merely receiving control messages does not renew the camera lease.


## Existing recordings

- `GET /v1/recordings/{serial}?date=YYYY-MM-DD`: authenticated on-demand P2P calendar query. Returns `{recordings: [{id,start,end,bytes}], returned}`. Dates/times retain the HomeBase calendar values. `returned` is the station response count before camera filtering, not a verified total. No raw device paths or account fields cross the bridge boundary.
- `GET /v1/recordings/{serial}/{id}/video`: downloads one previously enumerated existing file and prepares finite `video/mp4`. Optional `?format=native` preserves H.265 as `hvc1`; the default `h264` converts H.265 for compatibility. H.264 video and AAC audio are copied. Unknown formats are rejected. Output contains one complete MP4 fragment, so native Apple players can play and seek across the entire clip. IDs expire after 15 minutes, are bound to the camera and vanish on restart/reauthentication. The request socket owns cancellation.
- HA exposes authenticated `GET /api/eufy_viewer/recordings/{entity_id}?date=…` and `GET /api/eufy_viewer/recordings/{entity_id}/{id}`. Both enforce entity read permission before reaching the bridge. A browser disconnect cancels the upstream request. These legacy binary routes remain available.
- Preparation is globally serialized against other recording operations and live streams. Deadline: 60 seconds; input and output cap: 32 MiB. Closing the card, changing date, hiding the page or navigating cancels pending work and releases prepared playback. The bridge sends download cancellation on interrupted transfers. No camera livestream is used to produce a recording.
- Native playback uses authenticated `POST /api/eufy_viewer/recordings/{entity_id}/{id}/playback`. Optional `?format=native` is forwarded to the bridge after the same access checks. Both cards request it only when the native video element reports HEVC support, with one H.264 retry for a codec/decode error before or during playback. Recovery preserves the playback position and paused state; both cards show preparation progress or a terminal error. Closing or changing recordings cancels recovery and releases late responses. Network errors, a stalled load and cancellation do not trigger a compatibility retry. It prepares one MP4 and returns a playback path plus a five-minute HA-signed URL. The signature is tied to the requesting refresh token and exact path; it is not a long-lived access token.
- `GET`/`HEAD /api/eufy_viewer/playback/{id}` require HA authentication, the original user and current camera read permission. Full and single-range responses use `Cache-Control: no-store`. Seeking never repeats the HomeBase download. The cache is memory-only, capped at 64 MiB and eight recordings, and expires automatically. Authenticated `DELETE` on that path releases media on close; integration unload/shutdown also releases its entries. Do not share or log signed playback URLs.
- `/v1/state` adds `recording_metrics` (`queries`, `downloads`, `completed`, `remuxed`, `transcoded`, `cancelled`, `active`), separate from the existing live stream counters.

Recording failures use allowlisted JSON error codes: HTTP 409 `live_busy`, `live_stopping` or `recording_busy`; HTTP 410 `recording_expired`; HTTP 503 `recording_unavailable`. HA forwards only these known codes and the card translates them. Other upstream details remain redacted. Stream metrics additionally count bounded recovery attempts, completions and failures.

## Events timeline (0.3.0)

- `GET /v1/recordings?cameras=SERIAL,SERIAL&date=YYYY-MM-DD` queries each distinct HomeBase once per expansion and returns `{recordings, returned, complete:true}`. A recording includes `id`, `serial`, `start`, `end`, `bytes`, and `thumbnail`. Camera serials must belong to the current inventory. Paths remain private. Failure to establish the bounded complete day is HTTP 503 `history_incomplete`, never a successful partial page.
- `GET /v1/recording-days?cameras=SERIAL,SERIAL&month=YYYY-MM` uses SDK `databaseCountByDate`/10008 and returns `{days:[YYYY-MM-DD]}`. The firmware's count flags mark presence, not the number of recordings.
- `GET /v1/recordings/{serial}/{id}/thumbnail` uses only that reference's stored `thumb_path`. It accepts only the matching SDK `image download` event, checks JPEG bytes, caps the response at 2 MiB and waits at most 8 seconds. Missing/malformed previews use HTTP 503 `thumbnail_unavailable`. No frame is captured from a live camera.
- HA exposes `/api/eufy_viewer/events?entities=camera.one,camera.two&date=…` or `&month=…`, mapping bridge serials to entity IDs and dropping non-public fields. Every requested entity is authorized before any bridge call. HomeBase calendar markers additionally require read access to every current bridge camera, since the firmware does not support camera-filtered day presence. Restricted users can still browse their own cameras' dated events.
- HA thumbnail URL: `/api/eufy_viewer/recordings/{entity_id}/{id}/thumbnail`, with the same authenticated entity permission checks as video. All replies have `Cache-Control: no-store`.
- Event JSON is limited to 4 MiB and 10,000 records across a request; preview memory in the card is capped at 24 images. The list uses 12 visual tiles per page. SDK query limits expand 100 → 500 → 2,000 → 10,000; the final full limit is rejected. This is verified prefix expansion on the pinned HB3 firmware, not a claimed universal Eufy continuation cursor. The SDK's `start_time` did not act as a cursor on the tested device.
