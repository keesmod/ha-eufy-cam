# HomeBase alarm support and migration — 0.4.0

The same Eufy Viewer bridge now provides camera viewing and HomeBase security
profiles. Home/Away, Disarmed and Custom 1/2/3 map to Home Assistant alarm services.
The Guard Mode selector also supports Eufy Schedule and Geofencing. Available
profiles come from the station metadata. Manual siren triggering is not exposed.

Alarm state follows actual station telemetry: current mode, triggered, pending
and arming. Offline or removed stations become unavailable. Mode requests wait up
to 20 seconds for a matching station/property/value acknowledgement. Failures
propagate to HA without optimistic mode changes or automatic retries. A timeout
blocks ambiguous retries until a new station connection is established.

## Upgrade

1. Update the **Eufy Security Viewer Bridge** app to **0.4.0** and start it.
2. Update the **Eufy Security Viewer** integration to **0.4.0** in HACS and restart HA.
3. Verify the HomeBase alarm panel and Guard Mode selector are available and match
   the Eufy app. Existing Viewer camera identities are retained.

An older Viewer bridge remains compatible with camera viewing, but cannot provide
alarm entities. Both components must be updated for alarm support.

## Moving from another Eufy integration

Back up the current configuration and record the existing alarm mode. Check all
references to the old alarm and guard-mode entities in dashboards, automations and
scripts, including entity-based and device-based actions.

Verify the new station entities before disabling the previous integration. To keep
existing entity-based references, use HA's entity settings to give the old entities
unused names, then assign their original IDs to the new entities. Alternatively,
update every reference to the new IDs. Device-based actions need their new device
selected explicitly. Do not edit raw registry files while HA is running.

Once commands and actual station state are verified through Viewer, stop the
previous bridge and disable its automatic startup. Keep the previous configuration
available for rollback. Existing camera automations and custom services from the
old integration must be reviewed separately; Viewer does not implement every
service from other integrations.

## Validation

- Home Assistant 2026.9.0, HomeBase 3 T8030, firmware 3.8.6.0.
- 61 HA tests, 37 bridge tests, TypeScript build, Ruff and mypy passed.
- Python coverage 96.06%, exceeding the existing 95% release threshold.
- Live bridge test confirmed the existing Away profile without changing it.
- After migration, with the previous bridge stopped, HA alarm and selector commands
  for the existing Home profile both received successful station acknowledgements.
- Original alarm/selector IDs were retained; the Security dashboard and three
  existing entity-based automations resolved to Viewer and remained enabled.
- Four camera snapshots loaded; no new live stream was started by the alarm tests.
- HA configuration check passed; no Viewer errors after the migration restart.

Actual transitions between security profiles, a triggered physical alarm and the
next scheduled automation were not exercised during this validation. Tests cover
mode mapping and pending/arming/triggered state handling with simulated telemetry.
Existing WebRTC and recording playback were covered by the regression suite;
their prior physical validation remains documented separately.
