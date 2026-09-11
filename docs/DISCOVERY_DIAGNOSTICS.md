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
The bridge refreshes discovery periodically, so a later pass can repeat a line.
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
Library 0.12.1 does not expose rejected-device firmware, rejected-device parent
relationships or ignored non-security rows. The report cannot reconstruct
those details and does not infer model/type from a serial number. A cloud request
failure yields `inventory_available=false`, not proof that the account is empty.
Logs reduce follow-up questions, but cannot guarantee a diagnosis when the
vendor omits data or a new protocol observation is needed.

The report does not include names, serials, tokens, account identifiers, addresses,
raw errors, payloads, images or alarm state. Each row is bounded and the report
contains at most 99 device and 99 issue rows, plus its summary/end markers.
Review the short excerpt before sharing it. No automatic upload is performed.
