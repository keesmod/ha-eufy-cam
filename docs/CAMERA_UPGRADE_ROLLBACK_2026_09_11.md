# Camera upgrade and rollback rehearsal

Story: [camera #20](https://github.com/keesmod/ha-eufy-cam/issues/20).
Hardware prerequisites: [client #55](https://github.com/keesmod/eufy-mega-client/issues/55)
and [client #58](https://github.com/keesmod/eufy-mega-client/issues/58).

## Scope and recovery preparation

The rehearsal uses the separate test installation on Home Assistant 2026.9.1,
amd64 and Node 24.21.0. A full compressed VM backup completed and passed its
compression-integrity check. A direct VM snapshot was unavailable for its storage.
The touched integration, entity/device registries, configuration entry, session
data and options have separate private backups. Private data remains on its host.

The test installation initially had integration 0.5.1, fifteen Eufy entities and
no running camera bridge. The 0.6.4 baseline preserved all fifteen entity IDs,
unique IDs and device associations. It reused its existing private Mega test
session and restored authentication without a new Eufy login.

Production remains on 0.7.1. Its camera bridge was confirmed idle and paused before
the first test controller started. A bounded recovery guard stops the test
controller and confirms its absence before restarting production. Production is
not downgraded. No mower installation, configuration or credentials are changed.

## Versions and exact test images

Both test images were built from the published release sources and committed
dependency locks. These are test-build image identities, not production digests.

| Stage | Bridge and integration | Client | Camera release commit | Test image SHA-256 |
| --- | --- | --- | --- | --- |
| Baseline | 0.6.4 | 0.1.1 | 17457d8b24006bb8f3aacd8695376d3dc85b62e2 | 9829fcc961ddcf47e177015bea71c120288dd3430721f01539dd8582026416f7 |
| Upgrade | 0.7.1 | 0.10.0 | 4641da9ea2e02cda2d2165b9526ab8c4d01de051 | f6a15313edbd9c10db0ca0826029165d0f4d33f1c9e5d31eaa001c59bf718dca |

## Hardware evidence

The checked tuples are T8160 firmware 3.4.3.0 and T8213 firmware 0.2.1.8 through
their actual T8030 HomeBase, firmware 3.8.6.0. Battery telemetry was 75 and 50
respectively. This is not a battery-consumption measurement or a family claim.

Media tests use the authenticated HA integration. Snapshot decoding must not
start a live stream. Live acceptance requires decoded changing video and nonzero
audio samples, followed by a confirmed stop event, zero active/quarantined streams
and zero transport recovery attempts. Recording acceptance requires a complete
query, decoded video/audio and successful seeking in an actual stored recording.

| Check | 0.6.4 baseline | 0.7.1 upgrade |
| --- | --- | --- |
| Fifteen entity identities and device associations | Preserved | Preserved |
| Dashboard and automation content | Preserved | Four files unchanged |
| T8160 stored snapshot | 640 x 360, no live start | 640 x 360, no live start |
| T8160 live decoded video/audio frames | 42 / 193 | 43 / 222 |
| T8213 stored snapshot | 800 x 1200, no live start | 800 x 1200, no live start |
| T8213 live decoded video/audio frames | 42 / 157 | 43 / 160 |
| Confirmed live stop, no quarantine or transport recovery | Both tuples passed | Both tuples passed |
| T8160 complete recording query | 55 records | 55 records |
| T8160 recording video/audio frames and seeking | 910 / 930, passed | 910 / 930, passed |
| T8213 complete recording query | 6 records | 6 records |
| T8213 recording video/audio frames and seeking | 484 / 488, passed | 484 / 488, passed |

Recording queries cover 6 September 2026. The decoded durations were 60.67 seconds
for T8160 and 32.27 seconds for T8213. Playback audio was nonzero in both stages.
HA's resource cache version is expected to change on upgrade and is excluded from
the dashboard-content equality check.

## Acceptance status

Actual event acceptance, rollback readback and final cleanup are pending. This
document does not close the story or claim those checks passed.

Software recognition or these two tuples do not resolve T8134 live playback and
session recovery. Those remain in [camera #10](https://github.com/keesmod/ha-eufy-cam/issues/10)
and client #21, #22 and #56. The family obligations linked from client #55 and #58
and the parent programme remain open.
