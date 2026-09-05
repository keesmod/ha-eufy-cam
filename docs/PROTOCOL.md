# Local bridge protocol, version 1

Every route requires `Authorization: Bearer <bridge token>`. Tokens are never accepted in query strings. Bridge WebSockets reject browser Origin headers. Put TLS in front of the bridge if the LAN is not trusted.

| Endpoint | Meaning | Camera side effect |
|---|---|---|
| `GET /v1/state` | Protocol version, stable bridge ID, account state, cached camera inventory | None |
| `POST /v1/login` | Account credentials or verification/captcha response | Login/discovery only |
| `GET /v1/snapshot/{serial}` | Cached JPEG/PNG; 404 if absent | None |
| `WS /v1/events` | Initial state followed by push updates | None |
| `WS /v1/live/{serial}` | Viewer lease, binary JPEG frames; text `ack` after each processed frame | First viewer starts; last close/expiry stops |

The HA-side `eufy_viewer/watch` subscription accepts only `entity_id`. Frames carry the subscription ID, sequence and base64 JPEG. `eufy_viewer/ack` accepts the subscription and sequence, bound to the requesting HA connection. HA's normal `unsubscribe_events` releases the viewer.

Limits: 5 MB cached snapshot, 1 MB state message, 256 KB live JPEG, 4 viewers per camera, 8 camera slots at the bridge (including quarantined stops), 40 bridge sockets, 4 watches per HA connection and 16 per HA config entry. No media auto-reconnect. Watchdog tick 250 ms; first-frame timeout 20 s; processed-frame lease 10 s; absolute cap 120 s.

Upstream references used independently:

- [Eufy Security Client](https://github.com/bropat/eufy-security-client), package release `4.1.1-1`, pinned in `bridge/package-lock.json`.
- [Eufy WebSocket protocol](https://github.com/bropat/eufy-security-ws/tree/master/docs), inspected during architecture selection; this project does not require that server.
- [Home Assistant camera entity](https://developers.home-assistant.io/docs/core/entity/camera/).
- [Home Assistant WebSocket extension API](https://developers.home-assistant.io/docs/frontend/extending/websocket-api/).
- [HA frontend WebSocket client](https://github.com/home-assistant/home-assistant-js-websocket/blob/master/lib/connection.ts), including `resubscribe: false`.
