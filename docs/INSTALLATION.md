# Detailed installation and troubleshooting

Return to the [quick start](../README.md). Existing installations should follow
the [upgrade and recovery guide](MEGA_MIGRATION.md) before changing the bridge.


Choose **one** bridge installation method, then install the integration and cards.
The HAOS app provides amd64 and aarch64 builds, with no 32-bit ARM build.
Raspberry Pi hardware validation is still pending. See [compatibility](COMPATIBILITY.md).

| Your setup | Where to install the bridge |
|---|---|
| Home Assistant OS, including a 64-bit Raspberry Pi | Use the HAOS app below to run it on your HA machine. See the hardware limits above. |
| Home Assistant Container | Follow the [Docker instructions](DOCKER.md). |
| Home Assistant OS with the bridge on another machine | Follow the [Docker instructions](DOCKER.md) on that machine, then return to step 2. |

### 1. Install the bridge on Home Assistant OS

The bridge comes from the Home Assistant **app store**, separate from HACS. Older HA versions call apps "add-ons".

1. Open **Settings → Apps → Install app** to open the app store.
2. Open the three-dot menu, select **Repositories**, paste this URL and select **Add**:

   ```text
   https://github.com/keesmod/ha-eufy-cam
   ```

3. Find **Eufy Security Viewer Bridge** in the new repository and select **Install**. The first installation builds the container and can take several minutes.
4. Open the app's **Configuration** tab. Set `token` to a unique, randomly generated secret of at least 32 characters, then save. A password manager can generate one. This token connects Home Assistant to the bridge, it is separate from your Eufy password. Keep it for step 2.
5. Start the app and enable **Start on boot**. Check its **Logs** tab if it fails to start.
6. The current HAOS app uses the bridge URL `http://127.0.0.1:8063`. It shares the HA host network and listens only on loopback. Older apps used `http://HOSTNAME:8080`, reconfigure the existing integration entry when upgrading.

Optional shortcut: [add the bridge app repository](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fkeesmod%2Fha-eufy-cam). This opens My Home Assistant, which forwards you to your own HA instance. If it opens the wrong instance or fails, use the manual steps above. Home Assistant also documents [adding an app repository](https://www.home-assistant.io/common-tasks/os/#installing-a-third-party-app-repository).

Continue to step 2. Enter your Eufy email and password during integration setup, not in the bridge app configuration.

### 2. Install and connect the HACS integration

1. Open **HACS** in Home Assistant. In the three-dot menu, select **Custom repositories**.
2. Add `https://github.com/keesmod/ha-eufy-cam`, select type **Integration**, then select **Add**. See [HACS custom repository help](https://hacs.xyz/docs/faq/custom_repositories/) if needed.
3. Find **Eufy Security Viewer**, download it and restart Home Assistant.
4. Open **Settings → Devices & services → Add integration** and search for **Eufy Security Viewer**.
5. Enter the bridge URL and token from your bridge installation:

   | Bridge installation | URL to enter |
   |---|---|
   | Current HAOS app on this HA machine | `http://127.0.0.1:8063` |
   | Older HAOS app through 0.5.1 | `http://HOSTNAME:8080`, using the app's hostname |
   | Docker | `http://DOCKER_HOST_LAN_IP:8080`, using the Docker host's LAN address |

   For Docker, use an address Home Assistant can reach. `localhost` would point at Home Assistant itself.

6. Enter the dedicated Eufy account's email, password and two-letter country code, such as `NL`, `GB` or `US`. Complete verification or captcha if prompted.
7. Check that your cameras appear under the integration. They show the latest received snapshot, which may be old or absent until a new image arrives.

Optional shortcut: [open this integration in HACS](https://my.home-assistant.io/redirect/hacs_repository/?owner=keesmod&repository=ha-eufy-cam&category=integration). The manual custom-repository steps above work without waiting for inclusion in the HACS default catalogue.

If you install integrations manually, copy `custom_components/eufy_viewer` from this repository into your HA configuration's `custom_components` folder and restart. You still need the bridge.

### 3. Add the dashboard cards

The cards are included with the integration. You do not need another HACS download.

From version 0.4.2, the integration registers the shared JavaScript resource automatically when it loads. It updates the cache version on upgrades and removes duplicate entries for this card. Other card resources are preserved.

1. Reload the browser after installing or updating the integration.
2. Edit a dashboard and select **Add card → Eufy Security Viewer**. Pick a camera and save.
3. To browse recordings across cameras, add an **Eufy Events** card too. It uses the same resource and selects all accessible Viewer cameras by default.
4. Open a live view, then close it. To check recordings, choose a date with a clip you can already see in the Eufy app and play that clip.

If automatic registration fails, enable **Advanced mode** in your HA profile and open **Settings → Dashboards → three-dot menu → Resources**. Add `/eufy_viewer/eufy-viewer-card.js?v=0.8.0` as a **JavaScript module** before adding the cards. Edit an existing entry instead of adding a duplicate. Releases up to 0.4.1 also need this manual step. Use your installed integration version after `?v=`. This value refreshes the browser cache, it does not select an older copy of the card.

If you manage resources in YAML, the integration leaves that configuration untouched. Add the module to your existing `lovelace.resources` list and update the version after upgrades:

```yaml
lovelace:
  resource_mode: yaml
  resources:
    - url: /eufy_viewer/eufy-viewer-card.js?v=0.8.0
      type: module
```

Keep any other resources already in the list. Reload YAML resources through Home Assistant, then reload the browser. A YAML dashboard can still use automatically managed resources when `resource_mode` is `storage`.

A standard Home Assistant camera card shows snapshots only. Use the included Eufy cards for live video and recording playback. No YAML, automation or stream preload setting is needed.

Live WebRTC video uses Home Assistant's [go2rtc integration](https://www.home-assistant.io/integrations/go2rtc/). HAOS and HA Container set it up automatically when using `default_config`. Your browser must also be able to reach HA's media service on TCP port **18555**. An HTTPS dashboard connection alone may not provide that route. Check [streaming requirements](USAGE.md#honest-snapshot-and-streaming-limits) if snapshots work but live video does not.

## Troubleshooting

| Problem | What to check |
|---|---|
| The bridge repository shortcut fails | Use the URL and manual app-store steps in step 1. Check that My Home Assistant points to your HA instance. |
| There is no Apps menu | The app instructions require Home Assistant OS. Use Docker for a Home Assistant Container installation. |
| The bridge app does not appear | Confirm you added the repository to the HA app store. Refresh the page and check your machine's architecture against the supported builds above. |
| The bridge will not start | Check its logs. The token must contain at least 32 characters. |
| Integration setup cannot connect | Start the bridge first. The current HAOS app uses `http://127.0.0.1:8063`, older apps use their hostname on port 8080. For Docker, use the configured address reachable from HA. |
| Integration setup rejects the bridge token | Copy the same token configured in the app or in Docker's `bridge.env`. Do not enter the Eufy password in this field. |
| Eufy login succeeds but cameras are missing | Check device-sharing access in the Eufy app with the dedicated account, then collect a [complete discovery report](DISCOVERY_DIAGNOSTICS.md). |
| Live view fails immediately in the macOS app | Update the integration, restart Home Assistant and refresh the dashboard in the app. Live video uses JPEG without audio. Use Safari for live audio. |
| Recordings stay black in the macOS app | Update the integration, restart Home Assistant and refresh the app. Open Events, load the date and select a recording. Follow the upgrade guide when updating the bridge. |
| The cards do not appear | Check the resource URL and module type, then reload the browser. |

For missing devices or failed setup, follow the [diagnostic collection guide](DISCOVERY_DIAGNOSTICS.md) for required versions, a complete startup excerpt or one HA download, and privacy checks.

If the problem remains, [report a bug](https://github.com/keesmod/ha-eufy-cam/issues/new?template=bug_report.yml) with your HA installation type, both component versions and the error. Follow the [support guidance](../.github/SUPPORT.md) before sharing logs.

