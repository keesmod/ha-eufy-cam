# Playback diagnostic report

After a playback problem, download diagnostics before restarting Home Assistant
or the bridge. Recent recording attempts remain available for fifteen minutes.
The last eight attempts are retained, so collect after the affected attempt.

An administrator can use **Download diagnostics** after a live-view error or in
the recording player after a preparation or playback error. The button downloads
the same Home Assistant report as **Settings → Devices & services → Integrations
→ Eufy Security Viewer → integration entry's menu → Download diagnostics**.
It does not start a camera, fetch another recording or renew a viewer.

Collection has a fifteen-second timeout and a 2 MiB browser download limit.
On failure, use the integration menu. Non-administrators can continue using the
player but cannot download integration-wide diagnostics. The normal HA endpoint
checks administrator permission independently of the button.

## Reading one report

Home Assistant wraps integration data in `data` and adds its standard diagnostic
information. Review that wrapper and the report before sharing the JSON.

| Field inside `data` | Meaning |
| --- | --- |
| `report_schema` | Integration report contract, currently `1` |
| `home_assistant`, `integration` | HA runtime and loaded integration manifest versions |
| `support.software` | Bridge package, installed client library and Node versions at collection |
| `support.last_discovery`, `support.recent_events` | Existing discovery and owner-connection observations |
| `support.live_audio`, `live_playback` | Existing source, late-audio, browser and ICE observations |
| `support.recording` | Bridge recording observations, optional schema `1` within support schema `2` |
| `recording_playback` | HA preparation, response and file-release observations, schema `1` |
| `assessment.findings` | Observed stages with the supporting report section and attempt reference |
| `assessment.missing_evidence` | Missing, expired, unmatched or potentially stale evidence |

`card_version` identifies the actual loaded card build. It is recorded in live
browser samples and recording preparation requests. Compare it with the
integration version before attributing missing fields to a camera. An older
card or bridge remains compatible. Missing versions and optional schema fields
stay unavailable. The download does not turn missing counters into zero.

A bridge recording `attempt` is a random integer below 2^48. It is unrelated to
a camera, user or stored recording ID. HA assigns its own `attempt` and records
`bridge_attempt` from the `X-Eufy-Recording-Attempt` response header when available.
The header is also present on observed bridge failures. Match those references
within one download. They do not identify the same clip across separate attempts.
The existing live `audio_attempt` correlation remains unchanged.

## Recording stages and limits

A bridge attempt records admission, download, conversion, transfer and cleanup.
`stage` stays at the last playback stage while cleanup is observed separately.
The final `outcome` is completed, failed or cancelled. An in-flight attempt is
active. Up to sixteen stage or conversion events include relative elapsed times.

The report contains requested format, compressed source size, produced output
size, actual remux/software/NVIDIA processing and software fallback when observed.
`progress` reports the latest converter frame count where supported, final output
bytes and process closure. A software conversion does not invent an encoder
frame counter. Failure events preserve fixed categories, timeout scope and the
applicable output, conversion, hardware-progress and cleanup limits. The operation
limit covers the source transfer, conversion and delivery together.

`source_cancel_confirmed` means the library's transfer cancellation/cleanup call
resolved. `files_removed` means the bridge removed its temporary workspace.
Neither observation proves physical camera behavior or GPU idle state.
A converter `process_closed: false` explicitly reports unconfirmed process cleanup.

HA records its shared storage budget, file count and playback expiry limits.
`prepared` means an MP4 is available to the authenticated player. `response_complete`
means one HTTP response finished. A byte-range response can cover only part of a
clip. Neither proves video presentation, audible sound or playback to the end.
`client_disconnect` can result from normal seeking or closing. `released` records
the player's explicit release, while `expired` and `unloaded` identify other
release paths. `file_closed` is recorded only when the final file owner exits.
An overlapping reader may delay it after the viewer closes.

## Interpretation and privacy

Assessments describe observed stages. An owner-connection error does not establish
a particular firewall or virtual-machine problem. Received packets without decoded
frames identify a browser decoding gap, not a proven codec defect. An output size
limit does not establish a GPU fault. Successful audio decoding does not prove
physical sound. Missing recording browser evidence remains explicit.

Age and expired/omitted counters distinguish recent data from evidence that has
left the retention window. A report cached after bridge disconnection includes
its cache age, and that age counts toward media retention. Discovery timestamps
remain separate from the download generation timestamp. A failed setup can still
supply its existing cached discovery report.

New recording reports contain no camera/user/recording identifiers, file paths,
URLs, addresses, tokens, SDP, footage, raw source bytes or FFmpeg text. The bridge
observes fixed scalar categories. HA independently projects allowed keys, values
and limits before exporting them. Optional verbose FFmpeg log excerpts never
enter this download.

## Engineering evidence

Track A is [story #76](https://github.com/keesmod/ha-eufy-cam/issues/76). Tests cover
bounded retention, old bridges, cached/expired/partial evidence, adversarial values,
recording success and fallback, cancellation, process/file cleanup, authenticated
HTTP correlation, normal reader disconnect and browser collection limits.

These are software observations and regressions. They do not close the exact
T8134 external-playback acceptance in #10 or expand hardware support. The batch
coordinator owns the combined version update, bridge/app synchronization, final
integration checks and installation.
