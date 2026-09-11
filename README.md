# Eufy Security Viewer

View Eufy camera snapshots, watch live video with optional sound, and browse
existing HomeBase recordings in Home Assistant. This is an independent project,
not affiliated with Eufy or Anker.

[Install](#installation) · [Upgrade](#upgrading) · [Compatibility and help](#compatibility-and-help)

![Home Assistant dashboard with Eufy recordings, private areas obscured](docs/media/ha-dashboard-demo.gif)

## Before you start

You need Home Assistant **2026.9.0 or newer**, [HACS](https://hacs.xyz/docs/use/download/download/),
and a Eufy account that can see your cameras in the Eufy app.

Install both parts:

- **Eufy Security Viewer Bridge** connects to your cameras. Run it as a Home
  Assistant OS app or in Docker on your local network.
- **Eufy Security Viewer** adds the integration and dashboard cards through HACS.
  HACS does not install or update the bridge.

Bridge builds are available for 64-bit Intel/AMD and ARM machines. Raspberry Pi hardware
validation is still pending. A Eufy cloud recording subscription is not needed
for the tested HomeBase recordings. [Check compatibility](docs/COMPATIBILITY.md).

## Installation

Already installed? Follow the [upgrade guide](#upgrading) instead.

### 1. Install the bridge on Home Assistant OS

1. Open **Settings → Apps → Install app → ⋮ → Repositories** and add:

   ```text
   https://github.com/keesmod/ha-eufy-cam
   ```

2. Install **Eufy Security Viewer Bridge**.
3. In its configuration, set `token` to a unique random secret of at least
   32 characters. Keep it for the next step. This is not your Eufy password.
4. Start the app and enable **Start on boot**.

Using Home Assistant Container or a separate bridge machine? Follow the
[Docker instructions](docs/DOCKER.md), then continue below.

### 2. Install and connect the HACS integration

1. In **HACS → ⋮ → Custom repositories**, add the same repository URL as an
   **Integration**.
2. Download **Eufy Security Viewer** and restart Home Assistant.
3. Open **Settings → Devices & services → Add integration → Eufy Security Viewer**.
4. Enter `http://127.0.0.1:8063` for the HAOS app on this HA machine, or the bridge
   address from your Docker setup. Enter the token you saved above.
5. Sign in with your Eufy email, password and two-letter country code, such as
   `NL`. Complete any verification step and check that your cameras appear.

[Detailed installation and troubleshooting](docs/INSTALLATION.md)

### 3. Add the dashboard cards

Reload your browser, edit a dashboard and select **Add card → Eufy Security
Viewer**. Pick a camera. Add **Eufy Events** to browse recordings across cameras.
The cards are included with the integration.

Tap a camera to watch live video and enable sound if wanted. Close the viewer
when finished. Idle images are the latest received snapshots and may be old.

<details>
<summary>Cards missing or resources managed in YAML?</summary>

The current card resource is `/eufy_viewer/eufy-viewer-card.js?v=0.8.5`.
See [manual card setup](docs/INSTALLATION.md#3-add-the-dashboard-cards).

</details>

## Upgrading

**For 0.8.0, update the HACS integration before the bridge.** The old backend was
removed, so follow the [four upgrade steps and recovery instructions](docs/MEGA_MIGRATION.md).
Keep your existing integration, token, bridge data and backup. Do not run two
bridges for the same installation at once.

HACS updates the integration. The HA app store or Docker updates the bridge.
See the [release notes](https://github.com/keesmod/ha-eufy-cam/releases) for changes.

## Compatibility and help

You can upgrade without us having tested your exact camera. Available functions
still depend on the model and connection. See [known results and limitations](docs/COMPATIBILITY.md).

- **Missing devices or failed setup?** Collect a [complete diagnostic report](docs/DISCOVERY_DIAGNOSTICS.md).
- **Something does not work?** Check [troubleshooting](docs/INSTALLATION.md#troubleshooting).
  For live video or sound, see [playback and connection requirements](docs/USAGE.md#honest-snapshot-and-streaming-limits).
- **Share your experience:** [report working or failing features](https://github.com/keesmod/ha-eufy-cam/issues/new?template=compatibility.yml).
  Partial results help. Reporting is voluntary.
- **An existing issue matches your problem?** Add your results there. Otherwise,
  [report a bug](https://github.com/keesmod/ha-eufy-cam/issues/new?template=bug_report.yml).
  [Remove private information](.github/SUPPORT.md#safe-diagnostics) before sharing logs.

For more detail: [events and notifications](docs/NOTIFICATIONS.md),
[playback and recovery](docs/USAGE.md), [development](docs/DEVELOPMENT.md),
and [release process](docs/RELEASING.md).
