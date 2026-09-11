# Compatibility and community testing

You can install ordinary upgrades without a maintainer having tested your exact
hardware. Missing test evidence is not an incompatibility verdict. Actual missing
protocol support and [migration checks](MEGA_MIGRATION.md) still apply, including
the check that existing devices remain present. Reports are voluntary.

We record unconfirmed implementation, reported working, confirmed behavior,
known problems and not implemented per feature. A reproducible community report
can establish confirmed behavior without maintainer ownership of the device.
Keep versions, firmware, topology, date and source with every result. Partial
reports count, and historical evidence keeps its original date after upgrades.
See the [shared policy](https://github.com/keesmod/eufy-mega-client/blob/main/docs/COMMUNITY_VALIDATION.md)
and [model matrix](https://github.com/keesmod/eufy-mega-client/blob/main/docs/MODEL_MATRIX.md).

The historical results below come from one maintainer installation. The dated
0.7.1 acceptance now records exact models and firmware. These results do not
certify whole camera families or additional installations.

| Component or feature | Confirmed evidence | Still to confirm |
|---|---|---|
| Home Assistant | 2026.9.0 | Later releases and other installations |
| HomeBase | HomeBase 3, T8030, firmware 3.8.6.0 | Other firmware, HomeBase 2 and standalone storage |
| Cameras and snapshots | Four camera entities available; all four snapshots returned successfully | Exact camera models and wider combinations |
| Stored recordings | H.264/AAC and native H.265/AAC `hvc1` playback. T8213 doorbell 1600×2300 clips played to completion in the macOS app, including a 49-second clip and seeking. H.264 compatibility conversion also decoded successfully. | Other HEVC profiles, installations and large archives; audible output was not independently assessed |
| Events browsing | Date/camera filters, calendar presence, stored previews, previous/next playback; 95 known-camera files on a tested day | Other retention windows and firmware limits |
| Live WebRTC | Hardware video at 1920×1080; automated video/audio decoding tests | Audible output on each camera, physical iPhone background behavior and remote routes |
| Home Assistant macOS app | App 2026.9.0 build 2026.2874: native H.265 recording playback through both cards; JPEG live playback after client capability detection; 249 decoded frames and confirmed stream cleanup | JPEG has no audio; other macOS app versions |
| Home Assistant iOS app | Maintainer user report on 2026-09-09: live image starts in about 3 seconds | App/iOS versions and independent reproduction |
| Windows Chrome | Maintainer user report on 2026-09-09: live image starts in about 6 seconds; stored recordings in 3–5 seconds | Browser version, clip details and independent reproduction |
| Bridge app | amd64 tested on hardware | aarch64 hardware acceptance |
| Viewer cleanup | Normal close, cancellation and zero remaining active/quarantined streams in live validation | Long-term battery measurements and physical stop during a hard host/network failure |

Detailed evidence: [0.3.0 validation](VALIDATION_0.3.md). Model support in the underlying SDK alone does not count as a successful installation report.

## Independent Mega backend in 0.6.0

Tested on T8030 firmware 3.8.6.0, three T8160 cameras on 3.4.3.0 and a T8213
doorbell on 0.2.1.8. Test and production HA checks covered all four snapshots and
WebRTC video/audio, native H.264/H.265 and converted recordings, a complete
138-record day with camera filters, observed Guard Mode and stream cleanup.
Real rings/person/pet events and recognized names reached HA. The existing
fifteen entity identities were preserved.

An agreed overnight observation lasted about 11 hours 26 minutes, with no
unwanted stream starts. HA recorder independently covered gaps caused by an
expired token in the auxiliary observer. This is not a completed 24-hour or
battery-life test. See the library's [full results and limits](https://github.com/keesmod/eufy-mega-client/blob/main/docs/COMPATIBILITY.md).

## Dated 0.7.1 hardware acceptance

On 2026-09-11, camera #20 completed the 0.6.4 to 0.7.1 upgrade and actual rollback
on HA 2026.9.1, amd64 and Node 24.21.0. T8160 firmware 3.4.3.0 and T8213 firmware
0.2.1.8 used T8030 firmware 3.8.6.0. Stored snapshots, decoded live video/audio,
confirmed stop, complete recording queries, decoded recording audio/video and
seeking passed for both tuples. Fifteen HA identities and dashboard/automation
content were preserved. A real T8160 person event reached HA after a fresh
upgrade. Cleanup and recovery passed. See the [full record](CAMERA_UPGRADE_ROLLBACK_2026_09_11.md).

The historical 0.7.2 candidate used bridge 0.7.1 and client 0.10.0 without a new
physical claim. The later [0.8.0 acceptance](https://github.com/keesmod/ha-eufy-cam/issues/31)
covers the declared T8160/T8213/T8030 combinations, migration and retained-release
rollback, including a real doorbell event. Other combinations retain their own
evidence. See the [0.8.0 upgrade guide](MEGA_MIGRATION.md).

## Report your installation

You do not need to be a developer or complete every check. There is no required
number of reports before a release. Report both successes and failures on the
features you use, with the date and exact known versions.

1. Follow the [installation instructions](../README.md#installation). Record the integration and bridge versions separately.
2. Confirm your cameras appear and show their latest received snapshots. An older snapshot is expected when no new image has arrived.
3. Close live viewers. In **Eufy Events**, choose a date with a recording you already see in the Eufy app, preferably yesterday. Confirm the camera/time is listed and play that existing clip through to the end.
4. Check the camera filter and, if another clip exists, **Next recording** and **Previous recording**. Open the calendar and check a known recording day; calendar marks describe the whole HomeBase.
5. Close recordings. Open **Watch live**, optionally enable sound, then close it. Confirm you return to the snapshot. Report sound as untested if you could not hear it.
6. If practical, leave the dashboard or background your phone during viewing. Note any continuing playback or failure when returning. Visual closure alone does not prove the physical camera stopped; report bridge diagnostics if available.
   Also note any supported real event you observed and whether the same devices
   recovered after a normal restart. Do not provoke network or device failures.
7. [Submit a compatibility report](https://github.com/keesmod/ha-eufy-cam/issues/new?template=compatibility.yml) with model numbers, firmware, browser/phone and each outcome. No serial numbers, account details or footage are needed.

For an existing problem, add your results to its original issue. A new problem
that needs investigation can use the [bug form](https://github.com/keesmod/ha-eufy-cam/issues/new?template=bug_report.yml).
The compatibility form also accepts failed and partial results. See
[support guidance](../.github/SUPPORT.md) before optionally sharing diagnostics.
Review every excerpt before submitting it. A maintainer reviews the method and
results before recording the claim, including its limits and source.

## Community results

[Camera #10](https://github.com/keesmod/ha-eufy-cam/issues/10) contains partial
T8134 reporter evidence for discovery, stored snapshots, battery, person events
and recording video/audio. A [later iOS report](https://github.com/keesmod/ha-eufy-cam/issues/10#issuecomment-5631252411)
observed working live video with no audio. Its exact app/component versions and
route were not specified. Keep that result alongside the remote Cloudflare
failure. The requested 0.7.1 retest, audio diagnosis and session recovery remain
open. These scoped reports do not establish full T8134 acceptance.
