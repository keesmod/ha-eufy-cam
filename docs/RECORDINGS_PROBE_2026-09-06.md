# HomeBase recordings feasibility probe — 2026-09-06

**The initial blocked assessment below was superseded by the successful calendar query and existing-file download described in the follow-up.**

Scope: read up to one day of local events, then retrieve at most one existing recording. No recording deletion, live camera start or cloud polling loop was used. The viewer bridge was paused for each isolated probe and restarted in a finally block. Credentials and session stayed on the HA host; neither media nor credentials were copied to the workstation.

Results with the installed eufy-security-client 4.1.1-1 and application-success compatibility correction:

- Four cameras discovered. The SDK advertised date-query and local-query support.
- The date-query callback did not arrive within 20 seconds.
- A second probe explicitly established the HomeBase P2P connection, then issued the alternative local database query. That callback also did not arrive within 20 seconds.
- No event record was returned, so no clip download was attempted. SDK method presence alone does not establish firmware compatibility. The timeout does not prove that the HomeBase has no recordings.
- Final restoration check: viewer bridge started, boot auto, account connected, four cameras, four snapshots, zero start requests and zero active/quarantined streams.

An Events/Recordings UI has not been implemented. Reliable event enumeration and at least one successful playback/download must be established before offering that feature. Existing snapshot and live-view functionality remains available.

## Follow-up: protocol-level evidence

Further isolated, bounded probes established:

- The HomeBase P2P connection succeeds. Latest-info command `10013` returns five index entries and a summed device-supplied event counter of 88,663. This counter is not an inventory of available or playable recordings.
- The local history command `10017` receives `{mIntRet: -6006, msg: "ERROR_NO_SUPPORT", version: "1.2.0.1"}`. The response omits `cmd`; the SDK dispatches by `cmd` and therefore never emits the awaited database callback. The original timeout concealed an explicit protocol rejection.
- Supplying the reported version and limiting the query to one record still produces the same rejection. Known combination query codes `10009` and `10011` yielded no matching response within the bounded wait; these are unverified alternatives, not implemented fixes.
- Cloud video and history queries returned zero records for 24 hours. Explicit local-storage/HomeBase filters over seven days also returned zero records (limit ten each). Both latter endpoints returned HTTP 200/application success after the existing success-code normalization. This does not establish that the HomeBase contains no clips.
- The public successor `@mega-yfue/eufy-sdk` has only versions 0.0.1/0.0.3/0.0.4/0.0.5 at inspection. The downloaded 0.0.5 client entrypoint is `export {};`: there is no usable replacement implementation. The referenced GitHub repository returns 404 anonymously. The public Homebridge V5 migration specification names this SDK, but a specification is not an available working transport.
- The user has an iPhone only. No app protocol trace was captured; no phone security settings were changed.

No recording filename was returned; no stored recording was downloaded or played. Events support remains blocked on a verified current HomeBase enumeration/playback protocol or an accessible implementation of it. Repeating the rejected legacy requests is not a route to completion.

References inspected:
- https://github.com/homebridge-plugins/homebridge-eufy/issues/981
- https://www.npmjs.com/package/@mega-yfue/eufy-sdk

All probe containers were removed and the original viewer container restarted by the wrapper's finally block. No persistent integration or bridge changes were made for these recording probes; no cloud polling or camera live session was started.


## Follow-up: calendar query and existing-file download succeeded

New primary evidence was found in [upstream PR 768](https://github.com/bropat/eufy-security-client/pull/768#issuecomment-3842726611). Its author and another tester reported success with `serialNumbers: []`, `10006`, and calendar boundaries from today to tomorrow. This is a concrete change from the previous probe, not a repetition of rejected `10017` requests. The same old `-6006 / 1.2.0.1` response was already reported in [issue 508 in 2024](https://github.com/bropat/eufy-security-client/issues/508); attributing that response to a recent encryption migration was not justified.

On this host, T8030 firmware **3.8.6.0**:

- `10006`, empty device list, 2026-09-06 to 2026-09-07 returned `mIntRet: 0`, `msg: SUCCESSFUL`, `version: 1.2.0.1`, and **20 records** with real `storage_path`, camera, timestamps and cipher metadata. The protocol response uses a page count; full-day completeness/pagination is not established.
- Selected the existing Voordeur record at **2026-09-06 12:06:33–12:06:40** (HomeBase time), folder size 641,513 bytes. The exact returned path was used, without deriving a filename from the thumbnail.
- SDK download command `1024` returned `0`; download-start and download-finish events arrived. Received **586,450 video bytes and 16,615 audio bytes**, H.264/AAC, 1920×1080 at 15 fps.
- Muxed the existing source to MP4 on the HA host: **607,077 bytes**, duration **6.667 seconds**. FFmpeg decoded the complete MP4 with exit 0 and no error output. No live camera start was involved.
- [Upstream PR 763](https://github.com/bropat/eufy-security-client/pull/763) already supplies the download wrapper/channel fixes in the installed SDK. Its remaining TODO comment claiming no HB3 support is stale for this tested firmware and path.
- Current npm registry still has `@mega-yfue/eufy-sdk` latest **0.0.5**, published 2026-08-05. A fresh tarball inspection again found the client entrypoint `export {};`. The repository API returned 404 anonymously. No replacement SDK was needed.

The isolated probe mounted production data read-only, did not persist a second session, retained private evidence only on the HA host, removed its container, and restarted the viewer in a finally block. All four cameras and snapshots recovered with zero live-stream starts.

## Implementation and local checks

The unpublished `codex/webrtc-audio` branch now includes a bounded recording manager, authenticated HA HTTP proxy and a separate recordings dialog in the existing card. Existing WebRTC/audio code remains; no earlier alternative implementation was imported. Canonical bridge sources are mirrored to the Supervisor app.

Tests: 20 bridge tests including real H.264/AAC-to-MP4 decoding and interrupted download cleanup; 46 HA tests with 95.92% coverage including entity permissions, redacted failures and browser-disconnect cancellation; 13 browser tests including real stored-file playback and the three existing actual WebRTC/audio checks. TypeScript, mypy, Ruff and official hassfest passed. No publish, push, commit, tag or release was performed.

Live deployment backup: `/homeassistant/backups/eufy-recordings-20260906T131530` (integration, app source and Lovelace resource reference). The previous image is retained as `local/eufy-viewer-recordings-rollback:20260906T131530`. `ha core check` passed; the local viewer app was rebuilt and Core restarted to register the new authenticated HTTP endpoints. The separate alarm bridge was not modified.

## Actual HA dashboard playback and cleanup

The live dashboard `/eufy-viewer/0` now has a Recordings/Opnames button on each of the four existing camera cards. Its resource URL was updated through the HA Resources UI to `/eufy_viewer/eufy-viewer-card.js?v=0.2.0-recordings1` to invalidate the previously cached card.

Verified in the actual HA dashboard browser, using its normal authenticated requests:

| Selection | Returned camera records | Actual playback evidence |
|---|---:|---|
| Voordeur, 2026-09-06 | 8 | 12:06:33–12:06:40: video dimensions 1920×1080, `readyState: 4`, `currentTime = duration = 6.730729`, `ended: true`. The visible video overlay showed Sep 06 2026 12:06:38. |
| Voordeur, 2026-09-05 | 39 | 22:57:13–22:57:17: 1920×1080, `readyState: 4`, `currentTime = duration = 4.464063`, `ended: true`. |

This is stored-file playback from two dates, including a recording from before this investigation, not a live view or a synthetic media fixture. Two downloads completed. Audible output and physical iPhone background behavior were not independently tested.

A third existing recording (2026-09-05 20:00:34–20:01:34) was selected and the dialog closed during preparation. The bridge recorded **3 downloads, 2 completions, 1 cancellation, active false**. The MP4 source was removed from the browser player on close. Final live counters remained **0 starts, 0 stops, 0 active cameras, 0 quarantined cameras**; no new live camera stream was used in any recording test.

Final bridge account was connected, all four HA camera entities were idle, and all four snapshot endpoints returned HTTP 200 / image/jpeg: Tuinhuis 29,092 bytes; Voordeur 22,590 bytes; Achtertuin 18,554 bytes; Deurbel 72,801 bytes. Temporary probe containers and raw test media were cleaned up; timestamped deployment backups remain on the HA host.

Remaining limits: no claim that large multi-page days have been exhaustively enumerated, no bulk export, and clips exceeding the explicit 32 MiB / 60-second preparation limits fail closed. H.265 recording conversion has code support but no physical-camera acceptance evidence in this run. The implemented and demonstrated H.264/AAC HomeBase route has no external protocol blocker.
