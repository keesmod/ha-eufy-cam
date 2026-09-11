# Independent Mega backend migration

Upgrade bridge and integration to **0.7.1** together. This release pins
`@keesmod/eufy-mega-client` **0.10.0** through its exact GitHub release tarball and
committed lockfile. No npm registry publication or additional service is required.

The hardware evidence covers T8160 firmware 3.4.3.0 and T8213 firmware 0.2.1.8,
each paired with T8030 firmware 3.8.6.0. These results do not establish support
for every camera or doorbell in the same family. T8134 live and recovery
obligations remain open in [camera #10](https://github.com/keesmod/ha-eufy-cam/issues/10)
and the linked client stories.

The bridge can select `legacy` or `mega` once at startup. Mega uses the independent
`@keesmod/eufy-mega-client` library and a separate `mega-session.json`; legacy keeps
its existing `session.json`. Commands never switch backends or retry through the
other implementation. Legacy remains the app's default until explicitly selected.

See the library's
[model evidence matrix](https://github.com/keesmod/eufy-mega-client/blob/main/docs/MODEL_MATRIX.md)
for feature-specific hardware claims and remaining obligations. Historical
observation windows do not establish battery life or a reliability guarantee.

The dated [upgrade and rollback rehearsal](CAMERA_UPGRADE_ROLLBACK_2026_09_11.md)
records the tested versions and completed acceptance for that installation.
Integration candidate 0.7.2 changes metadata and documentation only and retains
bridge 0.7.1. See its [candidate notes](CAMERA_RELEASE_CANDIDATE_0_7_2.md).

## Prepare and migrate

1. Close all live viewers and recording dialogs. Check that no bridge streams or
   recording operations remain active.
2. Keep the previous bridge image/release and a private backup of its data:
   `bridge-id`, credentials, both session files if present, and the bridge token.
   Back up the HA integration entry and entity/device registries as well.
3. Install the validated bridge release with its exact GitHub library tarball URL
   and committed lockfile. `npm ci` checks the package's lockfile integrity. Do
   not substitute an unpinned Git branch or import legacy session/device data.
4. For the HAOS app, set `backend` to `mega` and keep the existing token. This app
   version uses host networking for HomeBase discovery and binds its API only to
   `127.0.0.1:8063`. Its former Docker hostname/port is no longer the endpoint.
5. Start one bridge. In **Settings → Devices & services → Eufy Security Viewer →
   Reconfigure**, use `http://127.0.0.1:8063` and the existing bridge token. Keep
   the same integration entry. Complete a fresh Mega login challenge if required.
6. Confirm all expected devices and existing entity IDs, snapshots, live audio/
   video, recordings and events. Check the observed Guard Mode. Validate HA
   configuration and runtime recovery. Keep the old release and private backup
   throughout the observation window.

For standalone Docker, use `EUFY_BACKEND=mega`, host networking and an explicit
`BIND_ADDRESS` that HA can reach. Bind to loopback when HA shares the host network;
otherwise choose the intended private LAN interface and restrict access to HA.
Do not publish a bridge API to the internet. Keep FFmpeg, viewer leases and HA
playback in this bridge; the library adds no service.

The same bridge ID, camera/station serials and HA unique IDs preserve dashboards,
notifications and automations. Recreating the HA integration or starting with an
empty data volume would change that behavior.

## Roll back

1. Close viewers, stop the Mega bridge and confirm it has exited before starting
   another controller. An unconfirmed device STOP requires recovery, not a
   second concurrent bridge.
2. For a version rollback, restore the exact previous bridge image and its
   original data/configuration backup. Restore the matching integration release.
   Keep the same integration entry, bridge token and bridge identity. A Mega
   version rollback stays on Mega and does not enable the legacy controller.
3. Restore the original endpoint only if that release used a different endpoint.
   Both 0.6.4 and 0.7.1 use `http://127.0.0.1:8063`. Earlier releases may use the
   Docker hostname on port 8080. Use Reconfigure rather than recreating the entry.
4. Validate HA configuration, reload or restart as required, then verify the
   saved login, original entity identities, camera inventory and Guard Mode.
   Repeat snapshots, live video/audio, recordings and events. Confirm a live stop
   event with zero active/quarantined streams and no transport recovery attempt.
5. Remove temporary instrumentation and stop the test controller before restoring
   the normal owner. Supervisor may remove a stopped app container. Start the app
   through Supervisor and verify its actual image, rather than assuming a stopped
   Docker container still exists.

A deliberately selected backend rollback to legacy is a separate operation. It
requires its untouched legacy session and exclusive ownership. It is never an
automatic response to a failed camera command.

Never copy Mega session data over the legacy session or enable automatic
fallback after a command. Stop and clean up a failed candidate before starting
another controller. Retain the original configuration, session and startup
settings for rollback.
