> **Beta channel for opt-in testing.** Run only one of the two bridge apps. Both
> listen on `127.0.0.1:8063` with host networking, so turn off **Start on boot**
> on the other app and stop it first. The beta app has its own `/data` and bridge
> identity. Follow the [beta steps](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/INSTALLATION.md#beta-testing)
> to switch and to return.

# Eufy Security Viewer Bridge

This Home Assistant OS app connects to Eufy and handles video for the [Eufy Security Viewer integration](https://github.com/keesmod/ha-eufy-cam). You need both this app and the integration. HACS installs the integration and dashboard cards; it does not install or update this app.

Home Assistant manages the app's container on your HA machine. You do not need to install Docker, Node.js or FFmpeg yourself. If you want the bridge on another machine, follow the [Docker guide](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/DOCKER.md) instead.

## Install and connect

1. Add `https://github.com/keesmod/ha-eufy-cam` in **Settings → Apps → Install app → three-dot menu → Repositories**. Older HA versions call apps "add-ons".
2. Install **Eufy Security Viewer Bridge**. The first install builds the container and can take several minutes.
3. In **Configuration**, set `token` to a unique random secret of at least 32 characters and save. A password manager can generate one. Keep this token for the integration setup. It is separate from your Eufy password. A `!secret` reference also works. Home Assistant replaces it with the value from `secrets.yaml` before the app starts, so that value needs at least 32 characters. From Supervisor 2026.09.3 the Configuration tab and the app info in the Supervisor API show the reference, not that value. Saving the Configuration tab with Supervisor 2025.09.2 to 2026.09.2 replaced a `!secret` reference with its value. If the token field, revealed with its eye icon or in **Edit in YAML**, shows the token itself instead of `!secret name`, enter the reference again and save.
   Optional: `live_max_bitrate` caps the live video encoder (default `4M`, for example `2500k` for a weak WiFi viewer), `live_max_streams_per_station` lets that many cameras on one HomeBase stream live at the same time (a whole number from `1` to `4`, default `1`, three verified, four reported), `live_max_seconds_mains` raises the live session cap only for cameras without a battery value (a whole number of seconds from `120` to `3600`, default `120`, verified with one mains powered camera for a full 1800-second session), `live_smoothing` plays live video on the camera's clock, which removes the short freeze at each camera key frame and adds about 0.7 s latency (on by default from bridge 0.8.41, `false` turns it off, see [#231](https://github.com/keesmod/ha-eufy-cam/issues/231)), `experimental_standalone: true` lets a standalone Wall Light Cam S100 `T84A1`, Indoor Cam 2K Pan & Tilt `T8410`, Indoor Cam Pan&Tilt 2K `T8410C` or Floodlight Cam 2K `T8424` try its own local session (off by default, the T8410 from bridge 0.8.35, the T8410C from bridge 0.8.38 and the T8424 from bridge 0.8.40, reported working for live view on all four, not independently reproduced, see [experimental standalone cameras](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/USAGE.md#experimental-standalone-cameras)), `standalone_recording_probe: true` sends one read-only recording query to each experimental standalone camera at login and logs how it answered (off by default, needs `experimental_standalone: true`, delays startup by up to about 15 seconds per standalone camera after its connection, see [standalone recording probe](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/USAGE.md#standalone-recording-probe)), and `diagnostics: true` adds bounded live diagnostics to the log while troubleshooting.
4. Start the app and enable **Start on boot**. Check **Logs** if it fails to start.
5. Use `http://127.0.0.1:8063` as the bridge URL. The app shares the HA host network and listens on loopback.
6. Follow the [HACS integration and card setup](https://github.com/keesmod/ha-eufy-cam#2-install-and-connect-the-hacs-integration). Enter the bridge URL and token first, then your dedicated Eufy account's email and password when prompted.

The app provides `amd64` and `aarch64` builds. Only `amd64` has been tested on hardware. Testing on a 64-bit Raspberry Pi is still pending; no 32-bit ARM build is provided. The app needs internet access to Eufy and local network access to your cameras/HomeBase. Live video conversion also uses the host's CPU.

## Updates and private data

Update this app through Home Assistant and the integration through HACS. Home Assistant offers an app update only when a release brings a new bridge version: the stable app at a stable release, the beta app at such a beta and at a stable release. Update both components to the versions listed in the release notes. See the [upgrade steps](https://github.com/keesmod/ha-eufy-cam#upgrading) and, for opt-in testing, [beta testing](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/INSTALLATION.md#beta-testing).

The app stores its bridge identity, Eufy credentials and session in `/data/eufy`. Back up the app and keep the same token when updating. Do not attach its data or token to support reports.

Live viewing starts when you open a viewer. Closing the last viewer stops the camera stream, and a watchdog ends sessions when viewers disappear. A power or network failure can prevent a stop command from reaching the camera. See the [streaming limits](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/USAGE.md#honest-snapshot-and-streaming-limits).
