Describe the problem and resulting behavior.

## Validation

List checks run, applicable hardware/HA evidence and behavior still unverified.

## Release impact

- [ ] Name affected components and target versions, or state why this is CI/docs only.
- [ ] Update matching manifests/lockfiles, changelog and upgrade/rollback guidance.
- [ ] Preserve exact dependency pins and attribution; update compatibility evidence when needed.
- [ ] The required `ci` check passes on the current PR commit.

After a release-impacting merge:

- [ ] Confirm `ci` on the merged main commit.
- [ ] Run the Release workflow rehearsal and inspect its verified package artifact.
- [ ] Supply sanitized acceptance evidence and explicitly run publication.
- [ ] Confirm public tag, assets, checksums and any separately authorized deployment.

See [the release flow](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/RELEASING.md).
