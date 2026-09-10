# Independent Mega backend migration

Upgrade to bridge and integration 0.6.0 together. The bridge pins the compiled
`@keesmod/eufy-mega-client` 0.1.0 GitHub release and verifies its lockfile integrity.
No npm registry publication or additional service is required.

The bridge can select `legacy` or `mega` once at startup. Mega uses the independent
`@keesmod/eufy-mega-client` library and a separate `mega-session.json`; legacy keeps
its existing `session.json`. Commands never switch backends or retry through the
other implementation. Legacy remains the app's default until explicitly selected.

The initial Mega target is T8030 HomeBase 3, T8160 cameras and T8213 doorbell.
Other models have not passed Mega acceptance. See the library's
[compatibility results](https://github.com/keesmod/eufy-mega-client/blob/main/docs/COMPATIBILITY.md),
including the agreed 11-hour-26-minute overnight observation and its measurement
limits. This is not a completed 24-hour reliability or battery-life test.

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
2. For a backend-only rollback, select `legacy` and restart using the untouched
   legacy session. The new app version still uses `127.0.0.1:8063`.
3. For a full version rollback, restore the previous bridge image and original
   data/configuration backup. Restore the previous HA URL (the old app used its
   Docker hostname on port 8080) through Reconfigure. Keep the original token and
   bridge ID. Restore the integration release too if the release notes require it.
4. Verify the original entity identities, connected station, original Guard Mode,
   camera inventory and zero active/quarantined streams. Report any physical
   outcome that could not be checked.

Never copy Mega session data over the legacy session or enable automatic
fallback after a command. Stop and clean up a failed candidate before starting
another controller. Retain the original configuration, session and startup
settings for rollback.
