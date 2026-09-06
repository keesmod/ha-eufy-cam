# 0.3.0 Events timeline validation — 2026-09-06

Validated against Home Assistant 2026.9.0, four cameras and a HomeBase 3 T8030 running firmware 3.8.6.0. The pinned SDK is eufy-security-client 4.1.1-1. The Events implementation extends the independently developed 0.2.0 WebRTC/audio and stored-recording code.

## Complete-day evidence and limits

Primary source: [eufy-security-client PR 768](https://github.com/bropat/eufy-security-client/pull/768) and the pinned installed SDK. Its calendar command 10006 hardcodes `count:100`; its callback discards raw count/start/end metadata. That first response alone cannot establish completeness.

Bounded live probes on 5 September found:

- The default count returned exactly 100 database rows, newest first, ending at 11:12:39.
- Counts 200, 500 and 1000 returned the same 105 record IDs, down to 00:37:01. Counts 200 and 500 produced the same ordered-ID SHA-256: `14a25a28dca482c20e75c1f1bf15feaa52e64eebe2cfe9205f7f6280b3a2f1b3`.
- Changing `start_time` to an observed boundary or one second later with flag 0 was ignored. An existing-field flag-1 hypothesis returned an empty array. Neither is used as a continuation cursor.
- Of the 105 rows, **95 were existing files belonging to the four current cameras**. The other 10 were outside the camera inventory and each had zero bytes, no thumbnail and equal start/end times. Known-camera counts were 42, 22, 4 and 27. These extra database rows are not presented as playable camera files.
- Command 10008 (`databaseCountByDate`) marked six dates, 1–6 September, with `count:1` for each. These are recording-day presence flags, not an independent total-record counter.

The implementation expands the existing count through 100, 500, 2000 and 10000, preserving distinct numeric IDs for events sharing a timestamp. Duplicates, inconsistent IDs, an unchanged full prefix (including an ambiguous exact boundary), malformed known-camera records, or the final full safety ceiling produce an explicit completeness error. References are committed only after the complete request validates. No protocol fields or file paths are invented.

This verifies expanded day enumeration on the tested hardware. It does **not** prove universal Eufy cursor pagination or exclude undocumented firmware caps on other devices. Bulk export, huge multi-station archives and older retention periods remain unverified.

## Stored thumbnails and playback

The exact stored `thumb_path` passed to `station.downloadImage` yielded a 15,950-byte JPEG. The authenticated HA endpoint returned a valid JPEG too. The handler ignores unrelated latest-image events: the SDK file reference must match the selected event. No live camera stream is started to produce a preview.

Actual existing recordings played through the HA Events player:

| Recording | Decoded size | Playback evidence |
|---|---|---|
| Front camera, 5 September 22:57:13 | 1920×1080 | Reached the end at 4.464 seconds |
| Doorbell, 5 September 20:45:26 | 1600×2300 | Selected with Next; reached the end at 9.667 seconds; Previous returned to the front-camera clip |
| Doorbell, 5 September 09:18:54 | 1600×2300 | Beyond the former first-100 cutoff; reached the end at 23.8 seconds |

The last result demonstrates that a file recovered by expanded enumeration is also playable, not merely listed. All footage already existed on HomeBase before testing.

The live UI showed 95 results across eight visual pages, a 22-result camera filter across two pages, and a 27-result filter across three pages. Its calendar marked the six returned dates. Twelve stored previews appeared on the first page; wide and portrait images used consistent 16:9 containers without stretching. The original four camera cards remained available in a separate view.

## Permissions and battery safeguards

- All requests use HA authentication. Every requested camera is checked for entity read permission before a bridge request is issued. Calendar markers require access to the full bridge camera inventory because the firmware does not filter calendar presence by camera.
- Paths and account fields stay inside the bridge. Video and thumbnails use expiring, camera-bound opaque references. Thumbnail replies are bounded to 2 MiB, video preparation to 60 seconds and 32 MiB, and event JSON to 4 MiB/10,000 results.
- The card sends no recording request at idle setup. User actions load one day/month or one page of at most 12 stored previews. Browser preview memory is bounded to 24 images. There is no cloud polling loop, background live capture or automatic media retry.
- Closing, hiding, removing or disconnecting the card cancels pending work and clears the video source. Aborted bridge operations remove listeners and close their unused station transport so late history replies cannot feed a subsequent operation.

## Automated checks

- **53 HA tests passed**, **96.19% coverage**. Ruff, formatting and mypy passed. Official hassfest: one integration, zero invalid integrations.
- **34 bridge tests** cover history expansion and uncertain boundaries, same-second events, exact thumbnail matching, cancellation, shared-HomeBase queries, authenticated HTTP routes, malformed records, leases and real FFmpeg decoding.
- **18 browser tests passed**, including real WebRTC audio/video through go2rtc. Events tests cover 105 fixture records, filters, pagination, calendar marks, adjacent real MP4 playback, cancellation, completeness errors and a 390-pixel mobile layout.
- Both TypeScript projects compile in strict mode. The generated card bundles both custom elements into one existing HACS resource. App source and package manifests are generated from the canonical bridge.

## Live installation and recovery

The manually installed local bridge was migrated to the GitHub repository app while retaining private state, token, bridge identity and camera entities. Private data stayed on the HA host. The integration was reconfigured through its supported config flow. The previous app was retained inactive with automatic boot/watchdog/updates disabled. Only the repository app runs, with those preferences enabled.

The development candidate was deployed with timestamped file/image backups and automatic rollback. One Core restart registered the new authenticated routes; dashboard changes used the supported Lovelace API. Local image overlays were used for validation; installing the published 0.3.0 app replaces them. The unrelated alarm bridge was not modified.

After the final playback test:

- All four HA cameras were `idle`; bridge account state was `connected`.
- All four cached snapshots returned HTTP 200/image/jpeg.
- Zero active recordings, zero active or quarantined live streams, and zero live starts during the final recording tests.
- The closed player had no video source and was paused.
- Hashes for 19 component/frontend files and 10 bridge build files matched the tested local candidate. Final `ha core check` passed. No probe or retired viewer container remained running.

Physical iPhone suspension, audible speaker output, remote WebRTC routes, H.265 hardware playback and wider firmware/model coverage are **not** independently accepted by these tests. Browser audio decoding has automated coverage; a small viewport is not equivalent to testing an iPhone.
