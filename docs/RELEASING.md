# Releases

Releases use **Actions → Release → Run workflow** on `main`. The default is a
full rehearsal. Publishing is a separate, explicit selection on the same form.
Stable `X.Y.Z` versions are supported; this flow does not create npm releases.

Every release also runs [the complete dependency security checks](DEPENDENCY_SECURITY.md),
including development dependencies. The same checks run daily between releases.

## Prepare a pull request

The repository release version is the HA integration version. Keep
`custom_components/eufy_viewer/manifest.json`, `pyproject.toml` and the project
entry in `uv.lock` aligned. Update the README card-resource examples. An
integration-only release can retain the bridge version.

For bridge changes, bump the bridge **and** the integration/repository version.
Keep both npm package/lock versions, `ha_app/config.json` and the app changelog
aligned. Run `python3 scripts/prepare_ha_app.py` after editing canonical bridge
files. Frontend builds must match the committed bundled dashboard JavaScript.

For a Mega library update, publish and verify that library first. Update the
exact GitHub tarball URL in `bridge/package.json`, refresh its lockfile with npm,
and regenerate the HA app. CI checks the versioned URL, embedded version and
SHA512 integrity, installs it through `npm ci`, and tests the consuming bridge.
Never reference a mutable Git branch or silently select a newer library.

Update the release's `CHANGELOG.md` section with the user-visible behavior,
upgrade steps, compatibility limits and rollback instructions. Runtime changes
must advance the affected versions. CI/documentation-only changes can retain the
current versions and state that no product release is needed.

All Validate checks must pass on the current PR commit. The final **ci** check
fails if any prerequisite failed, timed out, was cancelled or skipped. Protect
`main` by requiring a pull request, up-to-date branches, resolved conversations
and the GitHub Actions `ci` check; disallow force pushes and branch deletion.
No second maintainer approval is required for this single-maintainer project.

After merge, check `ci` on the resulting `main` commit. Branch CI alone is not
release evidence. Each Release run calls the same complete Validate workflow
from its own commit, so the release cannot use an older green run.

## Rehearse and publish

1. Merge the version/notes PR and wait for `main` CI.
2. Open **Actions → Release → Run workflow**, select `main`, enter the version
   without `v`, and leave **publish** unchecked.
3. Inspect the successful run and download its `release-package` artifact. It
   contains integration, bridge and source ZIPs, `SHA256SUMS` and
   `release-manifest.json` with source commit, component versions and file hashes.
4. Name the changed features and affected transport paths. Protocol, device
   commands and media changes need bounded tests on representative affected
   hardware and HA routes, with one controlling bridge, preserved private state
   and verified cleanup. Reviewed community results can supply this evidence.
   Record the exact versions, observation duration, method and anything unproven.
   CI cannot prove physical sound, battery life or a live migration. Changes that
   do not affect hardware need no new physical tests. Record that rationale.
5. Run **Release** again on the same `main` commit and version, tick **publish**,
   and supply a sanitized acceptance summary or evidence link. The summary is
   included in the public release notes. Never include credentials, serials,
   recognized names, private footage or raw diagnostic logs.
6. The pipeline repeats validation, checks the requested version and current
   `main`, creates the exact tag and a draft, uploads the tested files, downloads
   and verifies them, then publishes. It downloads and verifies the public assets
   once more. Only the publish job has repository write access.

The main branch must still point at the candidate when publication begins and
immediately before the draft becomes public. If it advanced, rerun from current
main. New stable versions must be newer than the latest stable release. Reusing
an existing tag at another commit is rejected. A merge or a pushed tag alone
does not publish a release. Releases do not deploy to a Home Assistant instance.

## Hardware coverage and release scope

Follow the [community evidence policy](https://github.com/keesmod/eufy-mega-client/blob/main/docs/COMMUNITY_VALIDATION.md).
A missing test for an otherwise implemented model is not a release or upgrade
veto. Keep previously tested combinations with their original versions and dates.
Do not demand every camera model or a fixed number of installations for each
release. Maintainer ownership of the hardware is not required.

State confirmed behavior, reported results, unconfirmed implementation, known
problems and missing support separately. Required software/security checks and
actual protocol, migration and safety gates remain. For a new protocol path or
major migration, arrange voluntary testing of a recoverable candidate before a
stable claim. The current workflow does not publish prerelease versions.

Dependencies must match the release slice. Unchanged mower-map work cannot block
a camera-focused library or camera release. Changed shared behavior still needs
appropriate checks for affected consumers, and map or mower migrations retain
their actual acceptance requirements. Missing expected devices remain a migration
failure. A qualified release does not wait for completion of the whole programme.

For a known regression, identify affected versions, feature, model/topology and
recovery advice. Verify the fix on the affected path before claiming it resolved.
Keep unresolved validation in its existing issue without silently widening a
support claim. Documentation and report-form changes take effect on GitHub after
merge and do not need a product version bump, HA deployment or live-device test.

## Diagnostic release checks

When a release changes diagnostic behavior, include these checks in its existing
validation. The [collection guide](DISCOVERY_DIAGNOSTICS.md) owns user steps and
the [report contract](DEVELOPMENT.md#diagnostic-report-contract) owns field meaning,
privacy bounds and schema compatibility.

- Verify the exact published library URL/integrity and actual installed library
  version, then test the consuming bridge and HA filter with the same report.
  Check supported schema versions and the older-integration fallback explicitly.
- Verify the complete download and normal startup logs with debug disabled,
  including failed setup and rejected devices. Confirm bounded retention, private
  value exclusion and authenticated access. Exercise failure paths synthetically
  without forcing production outages or waking cameras for log collection.
- State separately which bridge, library and integration versions each collection
  method needs. Confirm that the bridge update is available through its documented
  channel and the integration version is publicly released before telling HACS
  users to install it. Until then, document the available bridge-log alternative.
- Update collection instructions, support links and issue-form wording together
  when the process changes. Users should be asked for one complete bounded
  discovery report for missing devices, including accepted rows and context.
- For an authorized deployment, retain backups and verify installed versions and
  the actual log/download route. Record what was observed and what remains
  synthetic or untested. Diagnostics success is not proof of camera hardware or
  media support. Documentation-only changes need no deployment or live check.

## Failure and recovery

A failed or cancelled build cannot publish. A download, checksum or package
mismatch leaves the candidate as a draft. Rerunning the same commit can resume
missing uploads; reuse the original acceptance summary. Draft notes must match
the candidate before publication. Existing assets are verified and never overwritten. A mismatched
existing asset or an unrelated manual draft requires inspection, not automatic
deletion. Preserve valid published releases and tags.

If a failure occurs after the release became public, inspect the published
assets and run the verification again. The pipeline reports failure; it does not
silently remove a version users may already have installed. An identical already
published candidate is only verified, without uploading or publishing it again.

For a faulty product release, publish a corrected newer version and document
rollback. Do not move its old tag or replace a released file. The consuming
bridge's lockfile must continue to identify the exact library bytes it tested.

## Local checks

Use Python 3.11+ and Node.js 24. GitHub uses bounded Ubuntu jobs.

```sh
python3 scripts/check_workflows.py
python3 -m unittest discover -s scripts/tests -v
python3 scripts/release.py check
```

From a clean committed checkout, build the complete local bundle into a new
empty directory, then verify it:

```sh
python3 scripts/release.py build --directory /tmp/eufy-release-candidate
python3 scripts/release.py verify --directory /tmp/eufy-release-candidate
```

Packaging selects tracked files from explicit source directories. Untracked
credentials, caches and local scratch files are excluded. ZIP members and bytes
are checked against the source checkout. Releases keep integration and bridge
versions distinct when only the integration changed.

HACS offers the integration update. The bridge updates separately through the
Home Assistant app store or Docker; the library is included with that bridge.
For 0.8.0, prominently publish the breaking-change notice and [short migration guide](MEGA_MIGRATION.md). Users update the integration first so it can automatically prepare and transfer the inventory. Confirm #24, #30 and #31 acceptance before publication.

Actionlint and GitHub Actions are pinned to verified versions/checksums. Update
the pins deliberately and run the workflow validator. The common `release.py`,
`check_workflows.py` and `scripts/tests/test_release.py` are maintained in both
repositories; apply common fixes to both. Project-specific metadata and package
checks live in `release_project.py`.
