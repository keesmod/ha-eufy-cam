# Missing-device diagnostics

Bridge 0.8.3 requires eufy-mega-client 0.12.1 for the received model/type details.
The library is included in the bridge, so users do not install it separately.

When the Eufy Security Viewer Bridge app offers version 0.8.3 or later, update
it and restart it. Open the app's **Logs** tab in Home Assistant and look for
`Eufy backend: unsupported_device`. Discovery diagnostics work with the optional
live-video diagnostics setting disabled.

A synthetic example is:

```text
Eufy backend: unsupported_device device_model=T9999 device_type=95
```

Each distinct code/model/type combination appears once per discovery pass.
A later discovery pass can repeat a line.
Only exact five-character model codes and integer types from 0 through 65535
are shown. A missing, malformed or out-of-bounds value appears as `unavailable`.
Values are never shortened, trimmed, coerced or inferred from a serial number.
The two fields are the received values, not the expected supported mapping.

Share only these short diagnostic lines after reviewing them. Do not share
serial numbers, account details, tokens, addresses or a raw inventory/debug log.
Other discovery codes keep their existing form. Usable cameras remain available
in a mixed inventory, and zero recognized cameras still blocks setup with
`camera_inventory_empty` after the rejection reasons have been logged.

The C30 mapping remains T8224/type 95. A logged mismatch provides evidence for
further investigation, but does not itself identify the missing physical device
or prove a C30 fix. [Issue #40](https://github.com/keesmod/ha-eufy-cam/issues/40)
remains open until the reporter's actual data and results establish the cause.


## One startup excerpt for support, bridge 0.8.4

Restart bridge 0.8.4 or later and wait until login completes or the error
appears. Copy the lines starting with `Eufy discovery:` and `Eufy backend:`
from the app's normal Logs tab. Include the `summary`, every `device` and
`issue` row, the matching `end` row and the following `connection` result.
Live-video diagnostics need not be enabled. The library is bundled with the
bridge and does not need a separate user installation.

The report includes:

- The actual bridge, library and Node versions, operating system and architecture.
- Named cloud steps with HTTP status, numeric result and elapsed time. Hostnames,
  URLs, request bodies and account/session values are excluded.
- Authentication/challenge outcome and push connection state after event startup.
- Recognized camera/station counts and all discovery rejections, including
  bounded received model/type values for unsupported devices.
- Recognized models, numeric firmware/hardware versions, observed availability,
  anonymous owner references and the result of HomeBase connection attempts.
- Per-feature software admission and fixed reasons for unavailable snapshot,
  live and recording operations. These are software guards, not a playback test.
- Migration-baseline presence, expected/missing counts and any setup rejection.

`ref` and `owner_ref` are temporary positions within that report. They are not
serials or stable identifiers. `inventory_row` is the library rejection's
zero-based source position and is a separate numbering scheme. `device_ref`
links an issue to a recognized device only when the public library result does
so. The same report number groups its rows. Unknown values are `null` or
`unavailable`. A later unchanged report keeps its summary and end marker while
omitting duplicate rows. Restarting the bridge produces a full new report.

This is a report of the public discovery result, not the full cloud response.
A cloud request failure yields `inventory_available=false`, not proof that the
account is empty. Logs cannot establish why data omitted by the vendor is absent.

The report does not include names, serials, tokens, account identifiers, addresses,
raw errors, payloads, images or alarm state. Each row is bounded and the report
contains at most 99 device and 99 issue rows, plus its summary/end markers.
Review the short excerpt before sharing it. No automatic upload is performed.

## Single support download, bridge and integration 0.8.5

In Home Assistant open Settings > Devices & services > Eufy Security Viewer.
Use the integration entry's menu and select **Download diagnostics**. The standard
HA download includes HA/integration versions, the complete latest discovery and
up to 100 recent diagnostic events. Restart the updated bridge once to collect
fresh startup evidence, then download the report after the problem occurs.
The integration can request the report even when its setup failed. A bridge that
is unreachable or predates the endpoint yields an explicit unavailable result.
Bridge-only operators can retrieve the same cached report through the existing
Bearer-authenticated `GET /v1/diagnostics` route. No device or cloud requests are
triggered by a download. No automatic upload or issue submission is performed.
Review the file before attaching it to a support issue.

Schema 2 retains `station_connected` for compatibility and adds `station_status`
and `owner_status`. Status values distinguish `not_checked`, `connected`,
`disconnected`, `error` and `not_applicable`. Camera rows use `owner_connected`
for their HomeBase connection. Camera availability remains the last cloud/device
observation and does not prove current media reachability. A failed connection or
state refresh has an anonymous `device_ref`, model, phase and fixed reason.
Timestamped station and push connection transitions record loss and recovery.
Repeated identical states are suppressed. Recent events name their report number
because anonymous references are valid only within that discovery report.
The download preserves full rows even when repeated log reports omit them.

Library 0.12.2 adds rejected-device firmware/hardware and received parent context.
`parent_status=present` means one matching security inventory row, not proof that
it is a supported or connected HomeBase. Other states distinguish absent, self,
missing, ambiguous or invalid parents. `owner_ref` links only to a recognized
parent in the same report. Parent model/firmware can describe an unrecognized
parent without exposing its identity. Invalid values stay unavailable, and raw
identifiers never enter the logger or download. This does not infer a C30 mapping
or establish the cause of issue #40. Ignored non-security rows remain outside
this report.
