# Dependency security

The **Dependency security** workflow audits all locked npm packages in `bridge`, `ha_app` and `frontend`,
including direct, transitive, development, optional and peer dependencies.
It runs daily at 05:17 UTC and can be started manually from Actions.
Validate calls the same workflow for each PR, push and release run.
The required `ci` check and release packaging depend on its success.

The audit reads the lockfile without installing packages or executing their
lifecycle scripts. Any reported vulnerability or audit error fails the check.
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

Dependabot checks all three npm package roots every Monday at 09:00
`Europe/Amsterdam`. It proposes patch and minor updates that have been published
for at least seven days, with at most five open version-update PRs. Regular major
upgrades require separate manual review and are not proposed by this flow.

The version group uses `group-by: dependency-name` to update the same dependency
across the bridge, app and frontend together when their constraints allow it.
Security fixes keep their existing group. The `allow.update-types` restriction
and cooldown apply only to ordinary version updates; they do not suppress a
security fix that requires a major upgrade. See [GitHub's Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).

PR creation and CI are automatic. Merging, release publication and installation
on Home Assistant remain controlled steps. Neither the daily security audit nor
the required CI and release gates are relaxed for Dependabot.

For any dependency PR, review the changes and applicable advisories, preserve exact
lockfile integrity, and complete [the normal release requirements](RELEASING.md).
Production dependency changes require the bridge and integration version bumps,
changelog and appropriate acceptance tests. Keep `bridge` canonical and
regenerate the app with `python3 scripts/prepare_ha_app.py`; generated-file
checks remain mandatory even for bot PRs. Regenerate the frontend build when its
dependencies change. A bot PR may need these generated files, version bumps and
release notes before its checks pass.

The GitHub-hosted Mega tarball stays pinned to an exact release and checksum.
It has no npm registry entry, so Dependabot's version resolver gets a 404 if it
tries to update `@keesmod/eufy-mega-client` as an npm package. That package is
excluded from ordinary Dependabot version proposals. A change to Mega itself
must be released in its own repository first, then pinned and tested here.
The full lockfile security audit, library repository scans, and required release
URL/integrity checks still apply. No advisory is dismissed by this configuration.

## Local verification and limits

Run the same command from each package root with Node.js 24:

```sh
npm audit --package-lock-only --ignore-scripts --include=dev --include=optional --include=peer
```

For scanner or registry failures, fix the failure and rerun the check. Do not
ignore its exit status, remove development packages or run `npm audit fix --force`
to make CI pass. Investigate reported vulnerabilities and review the update.

Lockfile hashes verify the selected bytes, and audits detect known advisories.
Neither proves that package code is safe. Copied protocol code requires source
review too; an npm advisory scan does not audit its logic. Keep install scripts
blocked, build jobs without release credentials, required PR checks and reviewed
updates.
