# Camera release candidate 0.7.2

Prepared for [camera #21](https://github.com/keesmod/ha-eufy-cam/issues/21).
This is an unpublished candidate. Preparation covers software validation and a
checked merge, not a tag, release or deployment.

## Versions and scope

| Component | Candidate | Change from published 0.7.1 |
| --- | --- | --- |
| HA integration and source bundle | 0.7.2 | Version metadata and evidence documentation |
| Camera bridge and HA app | 0.7.1 | Documentation only, runtime and locks unchanged |
| Mega client | 0.10.0 | Same exact release URL and SHA512 lockfile integrity |

Published camera 0.7.1 came from
`4641da9ea2e02cda2d2165b9526ab8c4d01de051`. Its capability controls, experimental
labels and same-owner live JPEG fallback remain unchanged. JPEG has no audio.
This candidate does not fix a camera that supplies no usable stream.

Integration metadata, Python project/lock version and README resource examples
use 0.7.2. Bridge package/lock and HA app versions remain 0.7.1. Bridge archives
also contain current documentation, so identify these bytes by source commit
and manifest hashes. Never replace an existing release asset with this bundle.

## Claims and remaining obligations

| Evidence class | Exact scope and limit |
| --- | --- |
| Confirmed hardware | T8160 firmware 3.4.3.0 and T8213 firmware 0.2.1.8 through T8030 firmware 3.8.6.0. The 0.6.4 to 0.7.1 upgrade and actual rollback passed snapshots, decoded live video/audio, confirmed stop, complete recording queries and recording playback with audio/video and seeking. HA 2026.9.1, amd64, Node 24.21.0. |
| Confirmed event and recovery | A real T8160 person event reached HA after the upgraded test subscription started. Fifteen identities and dashboard/automation content were preserved. Test-controller cleanup and original-owner recovery passed. |
| Experimental software | Optional capabilities, unsupported-operation guards, standalone inventory without a fake HomeBase and media/lifecycle fixtures passed software acceptance in #19. Availability does not prove physical support, audible output or every firmware/topology combination. |
| Partial reporter evidence | T8134 discovery, snapshots, battery, person events and recording video/audio were reported working. Live playback and session recovery remain open in camera #10 and client #21/#22/#56. |
| Remaining hardware | Other eufyCam and battery-doorbell tuples, SoloCam, Indoor, wired doorbells, floodlight, wall-light, garage and the wider model matrix retain feature-specific obligations. No aarch64 hardware, battery-life or whole-catalogue claim is added. |

The [dated rehearsal](CAMERA_UPGRADE_ROLLBACK_2026_09_11.md) records actual versions,
feature outcomes, the initial event timeout and the subsequent passing event.
[Client #55](https://github.com/keesmod/eufy-mega-client/issues/55) and
[#58](https://github.com/keesmod/eufy-mega-client/issues/58) hold the bounded family
acceptance and remaining model links. The [model matrix](https://github.com/keesmod/eufy-mega-client/blob/main/docs/MODEL_MATRIX.md)
retains wider implementation and hardware obligations. T8134 remains in
[camera #10](https://github.com/keesmod/ha-eufy-cam/issues/10), client
[#21](https://github.com/keesmod/eufy-mega-client/issues/21),
[#22](https://github.com/keesmod/eufy-mega-client/issues/22) and
[#56](https://github.com/keesmod/eufy-mega-client/issues/56).

The legacy backend and direct dependency remain present and selectable.
There is no automatic fallback between backends. Removal belongs to
[camera #24](https://github.com/keesmod/ha-eufy-cam/issues/24), after its Ready
inventory and any necessary split. Parent [E6](https://github.com/keesmod/eufy-mega-client/issues/13)
and the [programme](https://github.com/keesmod/eufy-mega-client/issues/7) remain open
for those obligations, native maps and other pending validation.

## Upgrade and rollback notes

After separately authorized publication, an existing 0.7.1 installation can
update only the integration to 0.7.2 and retain bridge 0.7.1/client 0.10.0. Keep
its integration entry, credentials, token, sessions and entity registries. The
resource cache version advances to 0.7.2. No session or entity migration is needed.
To undo this metadata/documentation update, restore the saved integration 0.7.1
archive using the same entry and private backup, then reload/restart HA as needed.

Older installations and backend changes follow [Mega migration](MEGA_MIGRATION.md).
Retain the previous bridge image, matching integration and private data/config
backup. Stop and confirm the current owner before starting a restored one. Keep
Mega and legacy sessions separate. The demonstrated 0.7.1 to 0.6.4 rollback is
a dated test result, not a deployment performed by this story.

## Reproduce and validate

Use a clean checkout of the exact candidate commit recorded in the bundle manifest.
Python 3.11+ runs the packaging tools. The full workflow uses Python 3.14 and
Node 24. No Eufy account, hardware, private files or mower installation is needed.

```sh
python3 scripts/check_workflows.py
python3 -m unittest discover -s scripts/tests -v
python3 scripts/release.py check --version 0.7.2
python3 scripts/release.py build --version 0.7.2 --directory /tmp/camera-072-a
python3 scripts/release.py verify --version 0.7.2 --directory /tmp/camera-072-a
python3 scripts/release.py build --version 0.7.2 --directory /tmp/camera-072-b
python3 scripts/release.py verify --version 0.7.2 --directory /tmp/camera-072-b
diff -r /tmp/camera-072-a /tmp/camera-072-b
```

Both output directories must be empty or absent before building. The bundle has
integration 0.7.2, bridge 0.7.1 and source 0.7.2 ZIPs, `SHA256SUMS` and
`release-manifest.json`. The manifest records the source commit, component
versions, exact client dependency pin, sizes and SHA256 hashes. Verification
checks every ZIP member and byte against the tracked allowlist. Identical local
builds establish reproducibility under that Python/zlib environment. Verify the
Linux Actions bundle separately because compression versions can differ.

Required CI remains the full Validate workflow: npm dependency audits,
release-tool checks, HA lint/format/types/tests and coverage, HACS, Hassfest, app
and bridge builds, bridge tests and clean container startup, browser/media tests,
and verified release-package creation. The final `ci` gate requires every job.
Acceptance requires the checked PR, merged-main run, unpublished Release rehearsal
with `publish=false`, downloaded manifest and reproducibility receipt. Keep the
results in #21's acceptance record. CI artifacts expire after 14 days, so retain
a verified local copy and its source commit. No new physical test is needed for
this metadata/documentation-only diff.

## Publication, deployment and licensing gate

No release, tag, npm publication, production update or hardware action is part
of #21. Publishing later requires explicit authorization for the exact source
commit and version, green checks on that source and verified assets. Deployment
needs its own authorization, named target, backups, single-owner migration and
live acceptance. A passing preparation story grants neither.

Retain the repository MIT license and the Mega package's permitted protocol
attribution. No unlicensed mower source, schemas, constants, fixtures or tests
are copied. Mower relicensing and HACS publication remain outside this camera
candidate. Public artifacts must contain no sessions, credentials, captures,
footage or private geometry.

## Open dependency alert

On 2026-09-11, GitHub reports [Dependabot alert #1](https://github.com/keesmod/ha-eufy-cam/security/dependabot/1)
for `cryptography` 48.0.1 in `uv.lock`, advisory `GHSA-g6cj-pr64-35w5`, severity high.
The advisory identifies PKCS#7 EnvelopedData decryption error/timing differences
and lists 50.0.0 as the first patched version. The lock is unchanged by this
candidate apart from the project version. It belongs to the HA development/test
environment. The integration ZIP does not vendor this Python package, and an
installed HA environment supplies its own dependencies. This does not establish
that the host installation is unaffected.

The existing CI security workflow audits npm package locks. Green CI does not
clear this Python alert. Resolve or explicitly assess the advisory and record
the affected environment before any later publication/deployment acceptance.
The alert remains open. No exception, dismissal or dependency override is added.
