# Mega-only upgrade rehearsal

Camera [#31](https://github.com/keesmod/ha-eufy-cam/issues/31) supplies hardware evidence for [#24](https://github.com/keesmod/ha-eufy-cam/issues/24). Software [#32](https://github.com/keesmod/ha-eufy-cam/issues/32) was accepted separately. This record is not release approval.

## Exact build and preparation

The tested integration and bridge are 0.8.0 from commit `cc09b8e1907fa3e5769dbd9c1299aafefde02830`, with Mega 0.10.0. Merged-main [CI 34600960470](https://github.com/keesmod/ha-eufy-cam/actions/runs/34600960470) passed. Its downloaded archives passed verification in a checkout of that exact commit.

| Archive | SHA-256 |
| --- | --- |
| Integration | `15b9728f4541ff02b474259b3a5c354966c698c56a50cbd5235e2201f3071c29` |
| Bridge | `0a2d30701daf537cf991938a3ca3f51a4759327c5092004f9152363b04cb60a8` |
| Source | `a209a3fbaf0928b075bce0c0614b8cce3fa83040e7a48d62dd5ab570644d9cd7` |

The isolated amd64 test installation runs HA 2026.9.1 and Node 24.21.0. Its private test image is `sha256:4346c4d87b5baca988c099fc095cec9e959328777e8286b0f1c882435dd5fcc8`. This is not a published image digest.

The retained full VM backup passed a fresh compression-integrity check. Separate integration, configuration, registry and bridge-data backups were retained. Production was confirmed idle and stopped before the test controller started. A bounded recovery guard confirms test shutdown before restoring production.

An initial media-helper import failed because aiortc was absent from the rebuilt test container. Production was restored before repairing the helper. The driver now has its own private dependency directory. Readback verified that HA itself still uses av 17.0.1 and cryptography 48.0.1. Only the separate test process uses aiortc 1.14.0, av 16.1.0 and cryptography 50.0.1. This does not remediate the HA security dependency.

## Automatic upgrade evidence

The previous 0.7.1 test bridge restored its saved Mega login and discovered four cameras. Installing the 0.8.0 HA integration first automatically saved all four camera IDs, one HomeBase ID and the same bridge identity. The saved baseline contained no credential or session fields.

After the old bridge was stopped and backed up, the 0.8.0 bridge started alone. HA automatically transferred the saved baseline. The new bridge restored its Mega login and accepted the complete expected inventory. No baseline file was manually written and no new login was required for this existing Mega installation. The old credentials and bridge identity remained byte-identical.

All fifteen entity IDs, unique IDs and device associations were preserved. Dashboard and automation content remained unchanged, excluding the expected frontend resource cache version. Legacy fresh-login refusal and missing-device rejection have software regression coverage. This hardware run uses an existing Mega installation and does not claim a physical legacy-account migration.

## Feature observations on 0.8.0

Fresh discovery confirmed T8160 firmware 3.4.3.0 and T8213 firmware 0.2.1.8 through T8030 firmware 3.8.6.0.

| Feature | T8160 | T8213 |
| --- | --- | --- |
| Stored snapshot, without live start | 640 x 360 | 800 x 1200 |
| Live decoded video/audio frames | 40 / 197 | 41 / 153 |
| Distinct live video frames | 30 | 30 |
| Live audio | Nonzero | Nonzero |
| Confirmed live stop | Passed | Passed |
| Active or quarantined streams after stop | 0 / 0 | 0 / 0 |
| Transport recovery attempts during live test | 0 | 0 |
| Complete recording query, 6 September | 55 records | 6 records |
| Recording decoded video/audio frames | 910 / 930 | 484 / 488 |
| Recording audio and seeking | Passed | Passed |

The HA alarm state matched current HomeBase mode 0, armed away. No security mode was changed. After one controlled bridge restart, connected discovery returned within 2.01 seconds after restart, with all expected cameras, identities and idle state preserved. This proves restart/session recovery, not every possible network-failure condition.

Earlier bounded observations received no matching event. The user confirmed that no physical action was performed during the first requested doorbell attempt, so that attempt does not demonstrate a notification defect.

On 11 September, a fresh observation on the same verified 0.8.0 image received a real HA `eufy_viewer_event` of kind `ring` after the user was prompted to act. The event matched the inventoried T8213, firmware 0.2.1.8, at 216.63 seconds after subscription. The observer reported one matching event, closed its subscriptions and exited successfully. No event was injected. This accepts actual doorbell delivery on this tuple, without claiming every event type or model was physically tested. The fresh bridge restart also preserved four cameras, fifteen identities and idle state, reconnecting in 3.02 seconds.

## Rollback

The old 0.7.1 image, matching integration and exact private data backup were restored. An offline recursive byte comparison passed before the old bridge started. HA configuration validation passed. Saved login, four cameras and all fifteen identities returned.

Both camera tuples passed stored snapshots, changing live video with nonzero audio, confirmed stop and complete recording playback with seeking again. T8160 decoded 41 live video and 197 audio frames. T8213 decoded 45 live video and 166 audio frames. Both had zero active or quarantined streams and zero transport recovery attempts. The same 55-record and six-record queries were complete, with recording decode counts of 910/930 and 484/488 video/audio frames.

## Final recovery and remaining obligations

The test controller was confirmed stopped before production restarted. Production recovered on its original bridge and integration 0.7.1 with four cameras, fifteen entities, connected authentication and zero active or quarantined streams. Boot, watchdog and automatic-update settings exactly matched their private backup. Production HA configuration validation passed.

The test installation returned to its original integration 0.5.1 and fifteen entities. Its temporary controller was removed and its helpers and migration baseline were archived outside the active HA configuration. Test HA configuration validation passed. The recovery guard exited normally. All backups and release images were retained.

The final doorbell run also stopped its test controller before restoring production and the original test integration. Recovery, settings readback and HA configuration checks passed again.

Hardware #31 now has evidence for its final real-notification criterion. Python security [#30](https://github.com/keesmod/ha-eufy-cam/issues/30#issuecomment-5635391239) remains open because supported HA pins the affected cryptography version. The user accepted this substantiated limitation for #24 after the separate security assessment proved that the supported dependency constraints cannot resolve with the fixed version. The Python audit still fails. No advisory was dismissed and no audit was suppressed. Neither software CI nor the isolated test-driver version remediates that vulnerability.

T8134 live/recovery work in camera #10 and client #21, #22 and #56 remains open. These two tested tuples do not establish support for other models or topologies. No product release, production retirement, mower change or backup deletion is included.
