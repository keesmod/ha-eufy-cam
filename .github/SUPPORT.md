# Getting help

Start with the [installation and upgrade instructions](../README.md) and [tested compatibility](../docs/COMPATIBILITY.md). Install/update the **bridge** through the HA App Store or Docker and the **integration/cards** through HACS; these are separate components.

- [Report a bug](https://github.com/keesmod/ha-eufy-cam/issues/new?template=bug_report.yml): include both versions, exact model/firmware, expected behavior, actual behavior and reproduction steps.
- [Share a compatibility result](https://github.com/keesmod/ha-eufy-cam/issues/new?template=compatibility.yml): successful and partial installations are welcome.
- Search existing issues before opening a new one. Keep one reproducible problem per report. Support is community-based; response times are not guaranteed.

Check whether a matching existing clip plays in the Eufy app. For a recording failure, include the selected date, approximate time and the visible error. For live video, say whether the browser is on the LAN, VPN or an HTTPS reverse proxy; the WebRTC media route also needs to be reachable.

## Safe diagnostics

For missing devices or failed setup, follow the [diagnostic collection guide](../docs/DISCOVERY_DIAGNOSTICS.md). It is the maintained reference for component versions and collection steps. Share one complete discovery report so accepted devices, rejected rows and their HomeBase relationships can be assessed together.

Bridge 0.8.5 bundles library 0.12.2 and produces the full startup logs without enabling live-video diagnostics. Read the app's Logs tab even if the HA integration cannot load. The single-file HA download additionally requires integration 0.8.5. If that integration update is not available through HACS, use the bridge logs.

For other failures, include the relevant reviewed excerpt around the problem. Review any diagnostic file before sharing it. Do not upload full raw debug logs or private bridge storage.

Remove passwords, access/session tokens, email addresses, verification codes, cookies, serial numbers, recording paths, identifiable camera footage and private network addresses. Never attach `/data`, HA `.storage`, `secrets.yaml` or bridge environment files. A screenshot of a text error is usually sufficient; camera footage is not required.
