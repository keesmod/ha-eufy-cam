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

The camera card displays experimental status and useful unsupported reasons.
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
checks the downloaded package with SHA512. Camera #19 still requires full
software CI with this actual released package before acceptance.

Physical eufyCam/doorbell acceptance remains in client #55/#58. SoloCam #56 and
camera #10 retain T8134 live/recovery evidence. Migration is camera #20, camera
release is #21, and complete legacy retirement is #24. No unavailable hardware
is declared supported and the programme remains open.

Local validation passed 84 HA tests with 96.21% coverage and 38 browser tests,
including synthetic local WebRTC video/audio decoding and confirmed cleanup.
Ruff, types, workflow checks and release-tool tests passed. A clean consumer
imports the published compiled camera client without mower configuration.

The prepared bridge and integration version is 0.7.0. No private session or entity
migration is required. Retain the prior integration, bridge release and private
data for rollback. This story does not establish live deployment acceptance.
