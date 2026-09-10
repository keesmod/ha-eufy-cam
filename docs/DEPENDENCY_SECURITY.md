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

The configuration groups npm security fixes into PRs.
`open-pull-requests-limit: 0` disables routine version-update PRs and does
not disable security-update PRs. Updates are not automatically merged or deployed.

For a security PR, review the advisory and changed packages, preserve exact
lockfile integrity, and complete [the normal release requirements](RELEASING.md).
Production dependency changes require the bridge and integration version bumps,
changelog and appropriate acceptance tests. Keep `bridge` canonical and
regenerate the app with `python3 scripts/prepare_ha_app.py`; generated-file
checks remain mandatory even for bot PRs.

The GitHub-hosted Mega tarball stays pinned to an exact release and checksum.
Dependabot is not a cross-repository release updater: a fix to Mega itself must
be released there first, then pinned and tested in this bridge.

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
