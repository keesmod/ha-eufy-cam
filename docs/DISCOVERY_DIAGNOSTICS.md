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
