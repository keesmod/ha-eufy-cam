Describe the problem and what changes for users.

## Validation

List the checks run and any behavior that remains unverified.

## Release checklist

- [ ] Name the affected components and target versions, or explain why no release is needed.
- [ ] Include the version bump, matching package metadata and changelog entry.
- [ ] Update installation and upgrade instructions, including card resource URLs and the required bridge version.
- [ ] All six Validate jobs pass on the PR's latest commit before merging.

For a release, complete these steps after merging:

- [ ] The full Validate pipeline passes on the merged `main` commit.
- [ ] Build and inspect archives from that commit, then publish its version tag and GitHub release with upgrade notes and checksums.
- [ ] Verify the published tag and the versions inside the release archives.

See [the release process](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/DEVELOPMENT.md#pull-requests-and-releases).
