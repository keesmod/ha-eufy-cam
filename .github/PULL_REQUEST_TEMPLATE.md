Describe the problem and resulting behavior.

## Validation

List checks run, applicable hardware/HA evidence and behavior still unverified.

## Release impact

- [ ] Name affected components and candidate versions, or state why this is CI/docs only.
- [ ] Runtime changes use unpublished `X.Y.Z-beta.N` candidates and update the changelog sections of their stable parts, with upgrade/rollback guidance.
- [ ] `ha_app/` and `ha_app_beta/` are unchanged, or this is a release PR or beta cut written by `scripts/prepare_ha_app.py`.
- [ ] Preserve exact dependency pins and attribution. Pin the client with `scripts/bump_client.py`. Update compatibility evidence when needed.
- [ ] The required `ci` check passes on the current PR commit.

For a release PR or beta cut, whose merge updates an app in the store:

- [ ] A stable release has its run approval. Acceptance evidence is collected before the merge.
- [ ] After the merge, confirm `ci` on main and run the Release workflow right away. Rehearse a stable release first. A beta may publish on its first run.
- [ ] Confirm public tag, assets, checksums, the app store version and any separately authorized deployment.
- [ ] After a stable release, follow up on the issues referenced since the previous stable tag.

See [the release flow](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/RELEASING.md).
