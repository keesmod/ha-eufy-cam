# Camera backend retirement inventory

Prepared on 2026-09-11 for [camera #24](https://github.com/keesmod/ha-eufy-cam/issues/24).
This inventory precedes Ready and implementation. No runtime removal has occurred.

## Verified starting point

Remote camera main is `b99e6c5822f4d7194c6ae0c60d0dd1093ea8887c`.
Integration candidate 0.7.2 retains bridge/app 0.7.1 and the exact Mega 0.10.0
release URL and lock integrity. Both bridge and generated app also depend directly
on eufy-security-client 4.1.1-1. Camera #24's original main/client references are
obsolete. Camera #20 is closed with all acceptance criteria checked. Parent E6
remains open.

Read-only production inspection found one camera app container on bridge 0.7.1,
configured for Mega 0.10.0, and HA 2026.9.1. Its data contains bridge-id,
credentials.json, mega-session.json and session.json. File contents were not
exported. The presence of both session files does not mean two controllers run.
Production HA reports cryptography 48.0.1. No service was stopped or started.

## Runtime and artifact ownership

| Component | Present implementation | Retirement obligation |
| --- | --- | --- |
| Backend selection | backend.ts accepts legacy/mega and defaults to legacy. eufy.ts defaults to legacy and dynamically imports either adapter. | Sole Mega adapter. Explicitly reject a legacy selector before initialization. No fallback. |
| App and Docker configuration | App config defaults to legacy, schema offers both. bootstrap.mjs supplies legacy when omitted. Docker guidance explicitly selects either. | Define tested fresh, existing-Mega, missing-selector and legacy-selector behavior. Keep actionable upgrade errors. |
| Credentials and sessions | Eufy restores shared credentials.json automatically. Legacy reads session.json. Mega reads mega-session.json. | Never interpret old credentials as migration consent. Preserve existing Mega restore and bridge-id. Do not copy sessions or credentials across backends. |
| Legacy-only modules | legacy-backend.ts, sdk-compat.ts, stations.ts, notifications.ts implementation, recordings.ts, history.ts. | Preserve the shared Notification type imported by server.ts. Remove adapter code only after retained behavior has replacement coverage. sdk-compat patches the deprecated runtime SDK. |
| Mega modules | mega-backend.ts, mega-recordings.ts, library-owned backend types and shared errors. | Retain station acknowledgement, notifications, capability checks, media and lifecycle semantics. |
| Shared bridge | eufy.ts, server, media, stream hub, storage and diagnostics. | Preserve API, leases, authentication, identity, last frame, cancellation and confirmed recovery. Legacy JPEG terminology describes a viewer protocol, not the deprecated backend. |
| Package mirrors | bridge package/lock and generated ha_app package/lock/src. prepare_ha_app.py owns synchronization. | Remove the direct SDK and exclusively required transitive dependencies with npm, regenerate app and check synchronization. |
| Distribution | package.py includes tracked bridge sources and docs in bridge ZIP, tests/locks in source ZIP. Containers install locked dependencies. | Inspect ZIP members, lock graph and clean container dependency tree. No legacy runtime files, imports or compatibility patch. |
| Attribution | Repository MIT license and permitted protocol attribution inside the Mega package. | Preserve attribution. Adapted protocol code is distinct from a selectable deprecated backend. No mower source. |

## Tests and documentation

Legacy-only tests cover sdk-compat, legacy station commands, legacy notifications,
legacy history and recordings. The shared eufy.test.ts currently mocks the legacy
SDK for real FFmpeg media conversion, restore retries, verification challenges,
shutdown and exclusive-owner login recovery. These shared guarantees must be
ported to a backend-owned fixture or Mega path before removing the dependency.
streams.test.ts also contains a legacy adapter recovery case. Keep shared stream
hub quarantine, stop acknowledgement and recovery coverage.

Retain and extend mega-backend.test.ts for authentication/session separation,
station state and command confirmation, capabilities, recordings, notification
mapping, refresh and lifecycle behavior. Retain HA identity/configuration tests,
server authorization tests and actual browser/media tests. Add regression tests
for rejected legacy configuration, missing Mega session, valid existing Mega
restore, explicit fresh login, and unchanged old data on refusal.

Current installation guidance in README.md, DOCKER.md, MEGA_MIGRATION.md,
RELEASING.md and current protocol/package descriptions needs revision. Historical
validation, release-candidate and probe documents retain their dated evidence.
Do not rewrite previous tests as tests of a new release. Explicitly distinguish
historical selectable-backend releases from the new runtime. Bump the changed
bridge/app component and publish no existing asset under replacement bytes.

## Feature and hardware boundary

The declared retirement acceptance baseline is T8160 firmware 3.4.3.0 and T8213
firmware 0.2.1.8 through T8030 firmware 3.8.6.0, HA 2026.9.1 on amd64 with Node 24.
Firmware and topology require fresh readback for the new test. Existing #20
evidence establishes the old 0.6.4 to 0.7.1 upgrade and rollback. It does not
accept the future Mega-only build.

| Retained behavior | Available evidence | New-build acceptance |
| --- | --- | --- |
| Camera inventory, state and battery | #20 baseline and upgrade inventory, model-specific telemetry. | Compare complete expected inventory and all fifteen HA identities. Missing devices prevent migration acceptance. |
| Stored snapshots | Both baseline tuples decoded without live start. | Repeat for each tuple and confirm no live start. |
| Actual live video/audio | Both tuples decoded changing video and nonzero audio. | Repeat on exact new build, confirm stop and no quarantine. JPEG fallback alone cannot pass audio. |
| Recordings | Complete dated queries, video/audio decoding and seeking for both tuples. | Repeat complete query, decoding and seeking. Retain cancellation and opaque authorization handles. |
| Notifications | Real upgraded T8160 person event in #20. | Actual event reaching HA on new build. Connected push or injected events cannot pass. |
| Alarm modes | Mega station adapter supports acknowledged modes and visible state. | Preserve modes, error mapping, observed state and automations. Any controlled mode change must restore the original mode. |
| Reconnect and stop/cancel | Existing shared stream tests, Mega lifecycle tests and prior recovery evidence. | Bounded reconnect, confirmed media stop/cancel and exclusive-owner cleanup on the new build. |
| Identities and rollback | #20 preserved fifteen identities, dashboards and automations, restored exact backup and previous image. | New build must repeat upgrade and retained-release rollback, retaining private backups. |

T8134 live playback and recovery remain open in camera #10 and client #21/#22/#56.
T8142 and all other models/topologies retain the individual recognition, software
and hardware status in the [model matrix](https://github.com/keesmod/eufy-mega-client/blob/main/docs/MODEL_MATRIX.md).
This includes remaining eufyCam, SoloCam, Indoor, battery and wired doorbells,
floodlight, wall-light, garage, integrated cameras, 4G and PoE/NVR obligations.
No wider retirement support claim is inferred from an enum or SDK method.

## Safe upgrade design to resolve before Ready

Existing legacy installations must first remain on their retained previous
release. Back up configuration, sessions, bridge identity, token, HA entry and
registries. Inventory every expected device and feature. Stop the previous owner
before a separately selected Mega login and compare the complete inventory.
Unsupported or missing devices prevent acceptance and require the retained old
release. Never make an empty inventory count as successful migration.

The new build must reject an explicit legacy selector before any network login.
An omitted selector must not silently consume shared legacy credentials. An
existing valid Mega session may retain its established restore path, including
installations that retain an untouched legacy backup file alongside it. Fresh
Mega authentication must be explicit when no Mega session exists. No migration
routine should read legacy session content or overwrite the old credentials.
Implementation must settle the exact enforcement and user-visible failure before
Ready. Merely changing the default backend is insufficient.

Rollback restores the saved earlier release/image and its exact configuration
and data, after confirming the candidate owner has stopped. A second backend
inside the new release is unnecessary. Preserve backups and original workspaces.

## Required split and current status

The original two-day estimate excludes unresolved security work and new hardware
acceptance. Keep runtime retirement and its migration guard as a two-day software
story, with two concrete linked obligations:

1. One-day Python dependency security assessment/remediation. Alert 1 remains
   open for GHSA-g6cj-pr64-35w5. Verify compatibility constraints and affected
   camera call paths, add appropriate audit evidence and avoid dependency
   overrides or unsupported claims about the installed HA host.
2. One-day new-build hardware upgrade/rollback rehearsal after software checks,
   with physical availability tracked separately. Cover the exact baseline and
   feature gates above. Feed the results back into #24 acceptance.

The split is registered as [security #30](https://github.com/keesmod/ha-eufy-cam/issues/30),
[hardware #31](https://github.com/keesmod/ha-eufy-cam/issues/31), and
[software #32](https://github.com/keesmod/ha-eufy-cam/issues/32). Camera #24 retains
all original delivery criteria. Software #32 can enter Ready with #20 complete
and the enforced migration contract below. Security and hardware are final
acceptance gates, not claims made by the software merge.

The resolved contract requires a private inventory manifest captured through the
old bridge's authenticated local state API before upgrade. It contains the old
backend, bridge ID and expected camera/station IDs, never credentials or sessions.
Every existing shared-credential or legacy-session installation requires that
manifest. A Mega-origin manifest and existing Mega session permit the previous
saved-login path. A legacy-origin manifest requires fresh user-entered credentials,
saved as mega-credentials.json without modifying credentials.json or session.json.
The new backend verifies every expected device before reporting connected or
starting events. Missing devices, wrong bridge identity, corrupt or absent required
manifest refuse migration. Explicit legacy selection refuses startup.

The standalone preparation helper must work before updating the app. Document
both the HA app and Docker paths, including recovery after an accidental update.
Root and app changelogs and release notes must prominently label 0.8.0 BREAKING
CHANGE. Keep user-facing instructions independent of this household's setup.

No runtime code has been removed at inventory acceptance. Required software,
security, hardware and successor evidence remains open under #24.

## User-directed automation refinement

Before implementation completion, the user required automatic upgrade preparation and short instructions. The HA integration now captures and transfers the baseline through the authenticated local API. The standalone helper is only for installations without this HA path. Old Supervisor backend configuration is accepted as historical migration input and normalized to the sole Mega service, with the same mandatory inventory and fresh-authentication gates. It never starts a legacy controller. A standalone explicit legacy selector is rejected. Current instructions are the four-step MEGA_MIGRATION.md guide and both 0.8.0 BREAKING CHANGE entries.
