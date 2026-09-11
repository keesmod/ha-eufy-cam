# Upgrade to 0.8.0

**Breaking change: the old legacy backend is removed.** Update the integration
before the bridge. Keep your existing integration, token and bridge data.

## Home Assistant

1. Update **Eufy Security Viewer** in HACS and restart Home Assistant. Wait for
   **Eufy: ready for the bridge update**. Your device list is saved automatically.
2. Make a Home Assistant backup, then update the **Eufy Security Viewer Bridge** app.
3. If Home Assistant asks you to sign in to Eufy again, complete the login and
   verification code. Your old login files stay untouched.
4. Check a snapshot, live video with sound, a recording and a real notification.
   Check your alarm mode. Keep the backup until everything works.

The integration transfers your device list automatically. Missing devices stop
migration instead of disappearing silently. Existing Mega users normally keep
their saved login. Legacy users need a fresh Mega login. The old app backend
setting is handled automatically. No terminal commands or file copying are needed.

## Recovery

- **Updated the bridge first?** Stop it and restore your previous bridge version
  and its data backup. Leave the HA integration installed, then follow step 1.
- **A device is missing or does not work?** Stop the new bridge. Restore the previous
  bridge version and its data backup. Keep the same HA integration and token.
  Report the camera model, firmware and failing feature in a GitHub issue.
- **No preparation notification?** Using a bridge older than 0.6.4? Back up its
  data and install bridge 0.7.1 first. Once connected, reload the integration.
  For newer bridges, check the connection and reload. Wait for the notification
  before installing bridge 0.8.0.

Never run the old and new bridges together. Do not delete or recreate the HA
integration to fix migration. Your backup is the rollback path, not a second
backend in the new release.

## Other installations

Docker users with this HA integration follow the same preparation steps. Keep
the existing volume and token. Remove `EUFY_BACKEND=legacy` from the container
settings when installing the new image. Mega is the only backend.

Without the HA integration, use the [migration helper](../scripts/migrate_camera.py)
from the 0.8.0 source bundle. Python 3.11+ is sufficient.

```sh
python3 scripts/migrate_camera.py http://127.0.0.1:8063
```

Enter the bridge token at the hidden prompt. The helper saves the device list,
waits while you back up and update the bridge, then transfers the list automatically.
Use your actual bridge address. Do not share the generated private inventory file.

## Older or other integrations

A bridge under **Local apps** is a separate installation and is not updated by
the repository app. Keep its existing private data and token when moving it.
See [support](../.github/SUPPORT.md) for older installations. Migration from a
different Eufy integration follows the [alarm migration checklist](ALARM_MIGRATION_2026-09-06.md#moving-from-another-eufy-integration).

## Support limits

The 0.8.0 hardware rehearsal covers T8160 firmware 3.4.3.0 and T8213 firmware
0.2.1.8 through T8030 firmware 3.8.6.0. Its completed acceptance is recorded in
[#31](https://github.com/keesmod/ha-eufy-cam/issues/31).
T8134 live playback and recovery remain open in [#10](https://github.com/keesmod/ha-eufy-cam/issues/10).
Check the [model matrix](https://github.com/keesmod/eufy-mega-client/blob/main/docs/MODEL_MATRIX.md)
before migrating other models. Recognition alone does not prove support.

Technical evidence and the accepted security limitation are recorded in [#24](https://github.com/keesmod/ha-eufy-cam/issues/24).
An unpublished candidate or green software CI is not hardware acceptance.
