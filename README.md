# Eufy Security Viewer

An independent Home Assistant integration, companion dashboard card and local Eufy bridge. Snapshots while idle; tap to watch live; close to stop. Not affiliated with or endorsed by Eufy or Anker.

**Status: initial 0.1.0 release. All four cameras in the first installation were reported working by the owner; one tap-and-close session also has instrumented stop evidence.** Home Assistant 2026.9.0 is the tested baseline. Passing hassfest and automated tests is not an assurance of acceptance into Home Assistant core. See [validation](docs/VALIDATION.md) and the [local installation test](docs/LIVE_VALIDATION_2026-09-05.md) for evidence and remaining acceptance checks.

## What it does

- UI-only integration setup, reauthentication, endpoint reconfiguration, verification-code and captcha flows.
- Camera entities show Eufy's latest received snapshot; image requests never start a camera.
- A visual-editor Lovelace card starts live video only after a click or keyboard activation.
- Closing the dialog, leaving the dashboard, hiding the tab, disconnecting or failing to process frames releases the viewer.
- Multiple viewers of a camera share one upstream stream. Closing one viewer does not interrupt the others.
- The bridge independently expires silent viewers and stops the camera after the last viewer leaves.
- Push discovery and battery sensors, stable registry IDs, clean unload, English/Dutch UI and allowlisted diagnostics.
- No cloud polling timer: the pinned Eufy client is configured with `pollingIntervalMinutes: 0`. Login, push-triggered refreshes, token renewal and the library's local station communication still occur.

### Honest snapshot and streaming limits

A sleeping battery camera cannot provide a newly captured photo on every dashboard visit without waking. Idle views show the **latest received snapshot**. Its receive time is visible; it is not presented as capture time. If none exists, the card says so. New Eufy image events replace it. The last decoded live frame becomes the snapshot when viewing ends.

Live viewing is a video-only JPEG transport at up to **8 fps and 960 pixels wide**. The bridge decodes H.264/H.265 with FFmpeg; the HA connection carries one acknowledged image at a time. It does not provide audio, talkback, recording, WebRTC, HLS, PTZ or permanent RTSP. A normal HA camera card/more-info dialog shows snapshots only. Use the companion card for live video.

Sessions have a **two-minute absolute limit**; continuing requires another tap. Normal close immediately issues stop. After a network partition or frozen page the bridge expires a viewer within **10 seconds**, plus its 250 ms watchdog tick. Startup without frames expires after 20 seconds. A bridge or host hard failure cannot deliver a stop command; camera firmware/P2P behavior in that case must be verified on the intended hardware. No software can promise instantaneous physical stop across a dead network.

## Install the bridge

Requirements: Docker on a machine that can reach the cameras/HomeBase, a dedicated Eufy account with shared camera access, and sufficient CPU for video decoding. The container includes Node 24 and FFmpeg. One bridge manages one Eufy account. Do not share it with another system that starts or stops streams.

From the repository root:

```sh
docker build -t eufy-viewer-bridge:0.1.0 ./bridge
```

Create a private environment file with a randomly generated token of at least 32 characters:

```sh
umask 077
printf 'EUFY_BRIDGE_TOKEN=%s\n' "$(openssl rand -hex 32)" > bridge.env
```

Keep this file out of version control. Run the bridge, replacing `YOUR_LAN_IP` with the host's LAN address:

```sh
docker run -d --name eufy-viewer-bridge \
  --restart unless-stopped \
  --env-file bridge.env \
  -p YOUR_LAN_IP:8080:8080 \
  -v eufy-viewer-data:/data \
  eufy-viewer-bridge:0.1.0
```

Use a trusted LAN or a TLS reverse proxy; HTTP on an untrusted network exposes the bridge token and login credentials. Do not publish port 8080 to the internet. The browser never connects to the bridge directly. Outbound Eufy cloud/push and local P2P connectivity are required; depending on the device/network, Docker host networking may be needed for P2P.

The bridge stores its ID, Eufy credentials and session in `/data`, with private file permissions and asynchronous atomic writes. Back up that private volume. Loss of the volume creates a different bridge identity. Never attach it to bug reports. The bridge token is also stored by HA as a config-entry credential.

## Install in Home Assistant with HACS

### 1. Bridge app (Home Assistant OS)

[Add bridge app repository](https://my.home-assistant.io/redirect/supervisor_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fkeesmod%2Fha-eufy-cam)

1. Add this repository in **Settings → Apps → App store → Repositories** (called Add-ons on older HA versions).
2. Install **Eufy Security Viewer Bridge**. The first installation builds the container and can take several minutes. amd64 and aarch64 are supported; amd64 has been tested on hardware.
3. In its Configuration tab, set `token` to a unique randomly generated secret of at least 32 characters. Start the app and enable Start on boot.
4. Copy the app's **Hostname** from its Info tab. Use `http://HOSTNAME:8080` as the bridge URL in the integration below. Leave the network port disabled: Home Assistant reaches the app internally.

For HA Container installations, use the Docker instructions above instead. HACS installs the integration and bundled card; the bridge is a separate required app/container.

### 2. Integration and bundled card (HACS)

[Open in HACS](https://my.home-assistant.io/redirect/hacs_repository/?owner=keesmod&repository=ha-eufy-cam&category=integration)

This is a **HACS custom repository**, not yet a default HACS listing.

1. In HACS, add `keesmod/ha-eufy-cam` as a custom repository, category **Integration**.
2. Download **Eufy Security Viewer** and restart Home Assistant.
3. Open **Settings → Devices & services → Add integration → Eufy Security Viewer**.
4. Enter the bridge URL (for example `http://192.168.1.10:8080`) and its access token.
5. Enter the dedicated Eufy account's email, password and two-letter country code. Complete verification/captcha if requested.

For a local manual install, copy `custom_components/eufy_viewer` into your HA configuration's `custom_components` folder and restart. The downloadable integration archive preserves this directory structure.

## Add the card without YAML

The card is bundled with the integration, so it updates through the same HACS installation.

1. Enable **Advanced mode** in your HA profile if Resources is hidden.
2. In dashboard **Resources**, add URL `/eufy_viewer/eufy-viewer-card.js?v=0.1.0`, type **JavaScript module**.
3. Edit a dashboard, **Add card → Eufy Security Viewer**, and select a camera using the visual picker.
4. Save. The card stays on the snapshot until you tap it. Escape, the close button and clicking outside the dialog close live viewing.

After updates, reload browser resources. No YAML configuration, stream preload option, automation or scheduled service is needed. The integration deliberately does not advertise a generic stream source: another card cannot accidentally wake a camera through HA preload.

## Recovery and maintenance

- Use the integration's **Reconfigure** action when the bridge address or token changes. Its stable bridge ID must match.
- Complete the HA **Reauthenticate** flow if the Eufy account or bridge token requires attention.
- On bridge connection loss, entities become unavailable and all live viewers end. The local push socket reconnects with bounded backoff; media never automatically restarts.
- If a camera does not confirm stopping, the bridge refuses a new start for that camera. It makes at most three stop attempts. Inspect camera/bridge state before restarting the bridge; a command acknowledgement is not physical-stop evidence.
- A camera removed from Eufy becomes unavailable in HA; its registry entry is preserved so reappearance keeps IDs. Remove obsolete devices through HA's normal UI.
- Snapshot age is normal when there has been no new event. This integration does not wake a camera to make an old snapshot look fresh.

## Dependencies

| Component | Runtime requirements |
|---|---|
| Integration | Home Assistant ≥ 2026.9.0; built-in `camera`, `http`, `websocket_api`; no additional Python packages |
| Card | Bundled JavaScript, Home Assistant frontend and a modern browser; no separate frontend runtime package |
| Bridge | Node.js 24, FFmpeg and tini; all included in the app/container |
| Bridge libraries | `eufy-security-client` 4.1.1-1 (MIT), `ws` 8.21.3 (MIT); transitive dependencies pinned by `bridge/package-lock.json` |
| External services | Eufy account with camera access, Eufy cloud/push connectivity and local connectivity to camera/HomeBase |

No MQTT, go2rtc, RTSP server, existing Eufy integration or `eufy-security-ws` app is required. A dedicated shared Eufy account is recommended for ongoing use. Simultaneous operation with another Eufy client using the same account has only been briefly observed, not long-term validated. TypeScript, Playwright and Python test tools are development-only dependencies.

See [architecture and safety](docs/ARCHITECTURE.md), [bridge protocol](docs/PROTOCOL.md), [development](docs/DEVELOPMENT.md) and [validation](docs/VALIDATION.md).
