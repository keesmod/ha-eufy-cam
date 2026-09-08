# Compatibility and community testing

The initial evidence comes from one maintainer installation, not a broad device certification. Camera model numbers were not captured in the public validation record; camera names are not model identifiers. Reports from additional installations will be linked here as they are reviewed.

| Component or feature | Confirmed evidence | Still to confirm |
|---|---|---|
| Home Assistant | 2026.9.0 | Later releases and other installations |
| HomeBase | HomeBase 3, T8030, firmware 3.8.6.0 | Other firmware, HomeBase 2 and standalone storage |
| Cameras and snapshots | Four camera entities available; all four snapshots returned successfully | Exact camera models and wider combinations |
| Stored recordings | Existing H.264/AAC files played in HA, including 1920×1080 and 1600×2300 portrait clips | H.265 hardware playback, long clips and large archives |
| Events browsing | Date/camera filters, calendar presence, stored previews, previous/next playback; 95 known-camera files on a tested day | Other retention windows and firmware limits |
| Live WebRTC | Hardware video at 1920×1080; automated video/audio decoding tests | Audible output on each camera, physical iPhone background behavior and remote routes |
| Home Assistant macOS app | App 2026.9.0: JPEG live playback after client capability detection; 249 decoded frames and confirmed stream cleanup | JPEG has no audio; other macOS app versions |
| Bridge app | amd64 tested on hardware | aarch64 hardware acceptance |
| Viewer cleanup | Normal close, cancellation and zero remaining active/quarantined streams in live validation | Long-term battery measurements and physical stop during a hard host/network failure |

Detailed evidence: [0.3.0 validation](VALIDATION_0.3.md). Model support in the underlying SDK alone does not count as a successful installation report.

## Report your installation

Our first target is **10 independent HomeBase 3 installations**. You do not need to be a developer. A partial result is useful too.

1. Follow the [installation instructions](../README.md#installation). Record the integration and bridge versions separately.
2. Confirm your cameras appear and show their latest received snapshots. An older snapshot is expected when no new image has arrived.
3. Close live viewers. In **Eufy Events**, choose a date with a recording you already see in the Eufy app, preferably yesterday. Confirm the camera/time is listed and play that existing clip through to the end.
4. Check the camera filter and, if another clip exists, **Next recording** and **Previous recording**. Open the calendar and check a known recording day; calendar marks describe the whole HomeBase.
5. Close recordings. Open **Watch live**, optionally enable sound, then close it. Confirm you return to the snapshot. Report sound as untested if you could not hear it.
6. If practical, leave the dashboard or background your phone during viewing. Note any continuing playback or failure when returning. Visual closure alone does not prove the physical camera stopped; report bridge diagnostics if available.
7. [Submit a compatibility report](https://github.com/keesmod/ha-eufy-cam/issues/new?template=compatibility.yml) with model numbers, firmware, browser/phone and each outcome. No serial numbers, account details or footage are needed.

For failures, use the [bug form](https://github.com/keesmod/ha-eufy-cam/issues/new?template=bug_report.yml). See [support guidance](../.github/SUPPORT.md) before attaching logs. Maintainers will distinguish a reported result from an independently reproduced one.

## Community results

No independent installation reports have been reviewed yet. This table will grow from linked reports; untested models will not be marked supported.
