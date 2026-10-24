# Dependency security

The **Dependency security** workflow audits all locked npm packages in `bridge` and `frontend`,
including direct, transitive, development, optional and peer dependencies.
It also audits every package in the Python `uv.lock`, including all platform
entries, against the OSV database.
It runs daily at 05:17 UTC and can be started manually from Actions.
Validate calls the same workflow for each PR, push and release run.
The required `ci` check and release packaging depend on its success.

The store folders `ha_app` and, when present, `ha_app_beta` are audited only in
the workflow's own daily and manual runs. They change only in a release PR or
beta cut, so an advisory there must not block other PRs. A called workflow
sees its caller's name, so Validate and Release runs skip these steps and the
job still succeeds. Renaming the workflow disables this audit. Fix a reported
advisory in `bridge`. The store folders follow at the next release or beta cut
that changes the bridge version. For a development-only fix, the release PR
raises the bridge as described in [the release guide](RELEASING.md#batch-release-run).

The audit reads the lockfile without installing packages or executing their
lifecycle scripts. Any reported vulnerability or audit error fails the check.
The only exception is a listed Python advisory of a version that Home Assistant
pins exactly, as described under
[Python development lock](#python-development-lock).
JSON reports are kept in the run artifacts for 14 days, including failed audits.
A failed audit does not cancel checks of other package roots.

## Alerts and security updates

Keep the dependency graph, Dependabot alerts and Dependabot security updates
enabled in the repository's Advanced Security settings. These settings are
separate from `.github/dependabot.yml`; the file alone does not enable alerts.
Dependabot checks for newly disclosed vulnerabilities even without new commits.
Alerts appear under **Security → Dependabot**; delivery follows the maintainer's
GitHub notification preferences. Failed daily audits appear in Actions.

GitHub can disable scheduled workflows in public repositories after 60 days
without repository activity. Check the workflow's enabled state after a long
pause and re-enable it when needed. Dependabot alerts operate independently of
the Actions schedule. See [GitHub's schedule policy](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows).

The configuration groups npm security fixes into PRs. Security updates remain
independent of the weekly version-update schedule, its cooldown and PR limit.

## Weekly version updates

Dependabot checks the `bridge` and `frontend` npm package roots every Monday at 09:00
`Europe/Amsterdam`. It proposes patch and minor updates that have been published
for at least seven days, with at most five open version-update PRs. Regular major
upgrades require separate manual review and are not proposed by this flow.

The version group uses `group-by: dependency-name` to update the same dependency
across the bridge and frontend together when their constraints allow it.
Security fixes keep their existing group. The `allow.update-types` restriction
and cooldown apply only to ordinary version updates; they do not suppress a
security fix that requires a major upgrade. See [GitHub's Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).

PR creation and CI are automatic. Merging, release publication and installation
on Home Assistant remain controlled steps. Neither the daily security audit nor
the required CI and release gates are relaxed for Dependabot.

For any dependency PR, review the changes and applicable advisories, preserve exact
lockfile integrity, and follow [the Dependabot rules](RELEASING.md#dependabot).
Development-only updates merge as they are once CI passes. Production dependency
changes need bridge and integration candidates, changelog lines and appropriate
acceptance tests, so an agent PR supersedes the bot PR. Keep `bridge` canonical.
Dependency PRs never regenerate the store folders, and security PRs against
them are closed. A frontend update that changes the rebuilt card bundle is
handled like a production update.

The GitHub-hosted Mega tarball stays pinned to an exact release and checksum.
It has no npm registry entry, so Dependabot's version resolver gets a 404 if it
tries to update `@keesmod/eufy-mega-client` as an npm package. That package is
excluded from ordinary Dependabot version proposals. A change to Mega itself
must be released in its own repository first, then pinned with
`scripts/bump_client.py` and tested here.
The full lockfile security audit, library repository scans, and required release
URL/integrity checks still apply. No advisory is dismissed by this configuration.

## Python development lock

`pyproject.toml` declares no runtime Python dependencies. `uv.lock` describes
only the development and test environment, and the integration ZIP carries no
Python packages. A Home Assistant host uses the packages of its own Home
Assistant release.

Home Assistant pins many packages exactly, for example PyJWT, cryptography and
orjson. A fix for such a package arrives with the Home Assistant release that
moves the pin. Then update the `homeassistant` test pin in `pyproject.toml` and
relock. pytest-homeassistant-custom-component follows, because each release
pins one exact Home Assistant version. Packages that Home Assistant does not
pin exactly can move on their own with `uv lock --upgrade-package <name>`. Do
not add uv overrides or constraints to force a version that Home Assistant does
not ship.

Until that Home Assistant release exists, `scripts/check_uv_audit.py` accepts
an advisory of an exactly pinned package. It accepts only advisory IDs that it
lists for that exact locked version, and only while the newest `homeassistant`
release on PyPI still requires exactly that version. Any other advisory, a pin
that moved, a listed advisory that no longer appears and an incomplete report
all fail the check. Adverse package statuses such as archived or deprecated
appear as warnings, because `uv audit` itself does not fail on them. When the
newest Home Assistant release moves the pin, the Python audit fails in the
daily run and in every PR, push and release run, so the required `ci` check
blocks all merges. Then raise the `homeassistant` test pin, relock and remove
the exception in one PR. That needs the pytest-homeassistant-custom-component
release for the new Home Assistant version, and merges wait until it exists.
Add an exception only in a reviewed PR, for a version that Home Assistant pins
exactly, with each advisory ID. The exception for Pillow 12.3.0 was accepted
on 2026-10-22 and extended the same day with eleven advisories published
later. Two more, published on 2026-10-23, were added on 2026-10-24 under the
same condition. homeassistant 2026.10.0 to 2026.10.3 pin Pillow 12.3.0, and
the fix is Pillow 13.0.0. The exception for uv 0.12.23, accepted on
2026-10-22, was removed on 2026-10-24. That day the test pin moved to
homeassistant 2026.10.3, which pins uv 0.13.5, and the lock no longer holds
uv 0.12.23. CI runs the audit with uv 0.13.4.

## Local verification and limits

Run the same command from each package root with Node.js 24:

```sh
npm audit --package-lock-only --ignore-scripts --include=dev --include=optional --include=peer
```

Audit the Python lock from the repository root with uv 0.13.4. `uv audit` is a
preview feature, so CI pins that exact uv version. Write the report outside the
checkout:

```sh
uv audit --frozen --preview-features audit-command,json-output --output-format json > /tmp/uv-audit.json
python3 scripts/check_uv_audit.py /tmp/uv-audit.json
```

`uv audit` exits with status 1 when it finds advisories, and also for user
errors such as a missing lockfile. CI then lets `scripts/check_uv_audit.py`
decide, and that script rejects a report that is empty or incomplete or has a
schema version other than `preview`. For scanner or registry failures, fix the
failure and rerun the check. Do not ignore any other exit status, remove
development packages or run `npm audit fix --force` to make CI pass.
Investigate reported vulnerabilities and review the update.

Lockfile hashes verify the selected bytes, and audits detect known advisories.
Neither proves that package code is safe. Copied protocol code requires source
review too; an npm advisory scan does not audit its logic. Keep install scripts
blocked, build jobs without release credentials, required PR checks and reviewed
updates.
