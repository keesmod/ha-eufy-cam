# Discovery support diagnostics

Use this guide when cameras or a HomeBase are missing, or when setup fails.
Collect one complete report from the affected installation so support can compare
accepted devices, rejected rows, firmware and HomeBase relationships together.
No live stream or optional debug logging is needed to generate discovery evidence.

## Required versions and update channels

| Collection method | Bridge | Bundled library | HA integration |
|---|---|---|---|
| Current startup logs, including rejected-device firmware and parent context | 0.8.5 | 0.12.2 | No integration update needed to read bridge logs |
| One file through HA **Download diagnostics** | 0.8.5 | 0.12.2 | 0.8.5 |
| Earlier structured startup reports, without rejected-device parent/firmware context | 0.8.4 | 0.12.1 | No integration update needed to read bridge logs |
| Earlier unsupported-model/type error lines only | 0.8.3 | 0.12.1 | No integration update needed to read bridge logs |

These are the introduction versions. Later compatible releases retain the
corresponding collection method. The bridge includes its library, so users do
not install the library separately. Check the actual `software` values in the
report rather than inferring them from a release title or the HACS version.

Update the bridge through the HA app store or the documented Docker update path.
The integration updates separately through HACS. A version on `main` does not
mean that its [public integration release](https://github.com/keesmod/ha-eufy-cam/releases)
is available. If integration 0.8.5 is not offered, use the bridge logs. Follow the
[upgrade and recovery guide](MEGA_MIGRATION.md) when upgrading an older setup.

## Collect the startup logs

1. Update the **Eufy Security Viewer Bridge** to 0.8.5 or a later compatible
   release. Leave the optional live-video diagnostics setting disabled.
2. Restart the bridge once. A Home Assistant restart is not needed for this log
   collection. Wait until startup completes or an error appears, and complete
   login verification if prompted.
3. Open the app's **Logs** tab. For Docker, read the bridge container's logs.
4. Copy all lines beginning with `Eufy discovery:` and `Eufy backend:` from that
   startup attempt. Include `summary`, every `device` and `issue` row, the matching
   `end` row, and connection/error records. If authentication fails before a
   summary is produced, include the available diagnostic lines.
5. Review the excerpt using the privacy guidance below, then attach it as a text
   file or paste it in a code block on the existing issue.

Keep the complete bounded report, including accepted devices. A final error line
alone cannot explain whether the parent HomeBase was returned or connected.
A fresh restart produces full rows even if repeated reports had been suppressed.

## Download one file from Home Assistant

With both bridge and integration 0.8.5 or later compatible versions installed:

1. Restart the bridge to obtain fresh startup evidence, then wait for startup or
   the reported failure. Follow the integration's normal restart instructions if
   you have just updated its files.
2. Open **Settings > Devices & services > Eufy Security Viewer**.
3. Open the integration entry's menu and select **Download diagnostics**.
4. Review the file, then attach it to the existing issue.

The file includes HA/integration versions, the complete latest discovery and up
to 100 recent diagnostic events, alongside HA's standard system information.
The integration can request the report even when its setup failed. An unreachable
or older bridge returns an explicit unavailable result. Use its startup logs in
that case. No automatic upload or issue submission takes place.

Bridge-only consumers can use the existing Bearer authentication to request
`GET /v1/diagnostics`. The response reads cached evidence and triggers no cloud
or device requests. Never put the token in a shared command or URL.

## Interpret the report

The report covers the public library discovery result. A cloud request failure
with `inventory_available=false` does not prove that the account has no devices.
Ignored non-security rows and data omitted by Eufy are outside this report.

The C30 mapping is already `T8224` with device type `95`. Discovery also depends
on the values Eufy actually returns and the received owner relationship. The
report helps distinguish discovery rejection, parent problems and setup failure.
An unexpected model/type pair does not by itself identify the missing physical
camera. [Issue #40](https://github.com/keesmod/ha-eufy-cam/issues/40) needs the
reporter's evidence before its cause or a C30 fix can be established.

`ref`, `owner_ref` and `device_ref` are anonymous references within a report.
`inventory_row` is a separate zero-based source position. Use the `report` number
and timestamps together, and do not compare references across restarts.

Camera rows use `owner_connected` and `owner_status` for the HomeBase connection.
Their own `station_status` is `not_applicable`, so `station_connected=null` does
not indicate a failed camera connection. Statuses distinguish `not_checked`,
`connected`, `disconnected`, `error` and `not_applicable`. Camera availability is
an observation, and media capabilities describe software admission. Neither is a
fresh playback or reachability test.

Rejected-device firmware and parent fields are included when available and valid.
`parent_status=present` means a unique matching security row, not proof that it
is a supported or connected HomeBase. Other values distinguish `none`, `self`,
`missing`, `ambiguous` and `invalid`. Unknown or invalid output values remain
`null` or `unavailable`. No model or type is inferred from a serial number.

## Privacy and scope

The dedicated report excludes device names, serial numbers, account identifiers,
tokens, private addresses, raw errors, payloads, images and alarm state. Review
both the excerpt and HA's standard diagnostic envelope before sharing them.
Never attach `/data`, HA `.storage`, credentials, session stores, raw captures,
full debug logs, recording paths or identifiable footage. See [safe diagnostics](../.github/SUPPORT.md#safe-diagnostics).

The report is bounded to 99 device rows and 99 issue rows plus summary/end, with
up to 100 recent events in the download. It reduces follow-up questions but cannot
guarantee a diagnosis if Eufy omits the necessary data. Keep unrelated media,
physical-device and hardware acceptance claims separate.

Maintainers should follow the [report contract and change checklist](DEVELOPMENT.md#diagnostic-report-contract)
and [diagnostic release checks](RELEASING.md#diagnostic-release-checks).
