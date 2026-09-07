# Eufy Security Viewer Bridge

This Home Assistant OS app connects to Eufy and handles video for the [Eufy Security Viewer integration](https://github.com/keesmod/ha-eufy-cam). You need both this app and the integration. HACS installs the integration and dashboard cards; it does not install or update this app.

Home Assistant manages the app's container on your HA machine. You do not need to install Docker, Node.js or FFmpeg yourself. If you want the bridge on another machine, follow the [Docker guide](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/DOCKER.md) instead.

## Install and connect

1. Add `https://github.com/keesmod/ha-eufy-cam` in **Settings → Apps → Install app → three-dot menu → Repositories**. Older HA versions call apps "add-ons".
2. Install **Eufy Security Viewer Bridge**. The first install builds the container and can take several minutes.
3. In **Configuration**, set `token` to a unique random secret of at least 32 characters and save. A password manager can generate one. Keep this token for the integration setup; it is separate from your Eufy password.
4. Start the app and enable **Start on boot**. Check **Logs** if it fails to start.
5. Copy **Hostname** from **Info**. Use `http://HOSTNAME:8080`, replacing `HOSTNAME` with that value. Leave the app's network port disabled; HA reaches it internally.
6. Follow the [HACS integration and card setup](https://github.com/keesmod/ha-eufy-cam#2-install-and-connect-the-hacs-integration). Enter the bridge URL and token first, then your dedicated Eufy account's email and password when prompted.

The app provides `amd64` and `aarch64` builds. Only `amd64` has been tested on hardware. Testing on a 64-bit Raspberry Pi is still pending; no 32-bit ARM build is provided. The app needs internet access to Eufy and local network access to your cameras/HomeBase. Live video conversion also uses the host's CPU.

## Updates and private data

Update this app through Home Assistant and the integration through HACS. Update both to 0.4.1 for automatic recovery after a Home Assistant or bridge restart. See the [upgrade steps](https://github.com/keesmod/ha-eufy-cam#upgrading).

The app stores its bridge identity, Eufy credentials and session in `/data/eufy`. Back up the app and keep the same token when updating. Do not attach its data or token to support reports.

Live viewing starts when you open a viewer. Closing the last viewer stops the camera stream, and a watchdog ends sessions when viewers disappear. A power or network failure can prevent a stop command from reaching the camera. See the [streaming limits](https://github.com/keesmod/ha-eufy-cam#honest-snapshot-and-streaming-limits).
