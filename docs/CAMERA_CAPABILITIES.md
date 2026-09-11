# Camera capabilities in Home Assistant

Camera story [#19](https://github.com/keesmod/ha-eufy-cam/issues/19) adds optional
`capabilities` to each camera in the existing bridge protocol 1. Snapshot, live and
recordings each contain `available`, `status` and `reason`. The HA camera exposes
the same validated fields as state attributes. Existing entity unique IDs,
configuration entries, card resources and automation names are preserved.

The Mega adapter uses the client's `getCameraCapabilities()` introduced in
[client PR #94](https://github.com/keesmod/eufy-mega-client/pull/94). That method
projects the existing camera media and actual owner guards without opening a
device connection. It does not derive media support from a camera model name.
An admitted operation is experimental software. It does not establish hardware
support, reachability, fresh imagery, decoded video, audible audio or successful
stop/cancel. Runtime operation guards remain authoritative.

The camera card displays useful reasons for unavailable operations. The generic
experimental software status remains in HA attributes. It is not a per-camera
hardware verdict and does not produce a warning on every card.
Unavailable live and recording buttons are disabled. Unsupported snapshots are
not requested. HA rejects direct viewer and recording requests before contacting
the bridge. The bridge also refuses unsupported live sessions, cached snapshot
routes, history/calendar and recording downloads/thumbnails. Cleanup remains
available for already owned streams. The event card omits unavailable recording
cameras and explains when none remain. Unknown optional fields are ignored and
older bridge messages without capabilities preserve existing behavior.

Standalone connection owners remain camera devices. Only actual station devices
produce HomeBase inventory. A failed station connection does not prevent camera
inventory setup. Camera credentials, sessions and lifecycle remain separate from
mowers. The camera bridge adds no mower routes or configuration and requires no
mower integration. Existing legacy selection is unchanged by this story and its
removal remains required by [#24](https://github.com/keesmod/ha-eufy-cam/issues/24).

## Validation and remaining acceptance

Software regressions cover unknown optional fields, unsupported controls without
upstream calls, standalone inventory, owner connection failure, unchanged entity
IDs and experimental card rendering. Existing software media/lifecycle tests
remain required. These fixtures establish no new physical model support.

[Client #95](https://github.com/keesmod/eufy-mega-client/issues/95) owns the verified
0.10.0 artifact used by the consumer pin. It is separate from client #63's
mower acceptance dependency, which remains open. Release run 34577433886 published client 0.10.0 from commit
`41690f73f1ed4397f378a6eb9ba6612fc41d998a`. The downloaded manifest and
package hashes match the validated workflow output, and the bridge lockfile
checks the downloaded package with SHA512. Camera #19 passed full software CI
against that published package in [PR #25](https://github.com/keesmod/ha-eufy-cam/pull/25),
with [merged-main validation](https://github.com/keesmod/ha-eufy-cam/actions/runs/34578769443).
Its acceptance includes 69 bridge tests, 85 HA tests at 96.21% coverage and 38
browser tests. Synthetic media decoding does not establish physical support.

Physical acceptance for the exact T8160/T8030 and T8213/T8030 tuples passed in
client #55/#58. Camera #20 passed the bounded upgrade/rollback and real T8160
event rehearsal. Read the [dated evidence](CAMERA_UPGRADE_ROLLBACK_2026_09_11.md)
for firmware, versions, feature outcomes and cleanup. These results do not extend
to every model or topology in either family.

SoloCam client #21/#22/#56 and [camera #10](https://github.com/keesmod/ha-eufy-cam/issues/10)
retain T8134 live/recovery obligations. Legacy retirement remains camera #24.
The [0.7.2 candidate](CAMERA_RELEASE_CANDIDATE_0_7_2.md) consolidates release
preparation in #21. E6 and the programme remain open for the remaining models
and validation. This documentation adds no runtime or hardware-support claim.
