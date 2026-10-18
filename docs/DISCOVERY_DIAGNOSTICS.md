# Discovery support diagnostics

Use this guide when cameras or a HomeBase are missing, or when setup fails.
Collect one complete report from the affected installation so support can compare
accepted devices, rejected rows, firmware and HomeBase relationships together.
No live stream or optional debug logging is needed to generate discovery evidence.

## Required versions and update channels

| Collection method | Bridge | Bundled library | HA integration |
|---|---|---|---|
| [Standalone push counts](#standalone-push-counts) in `support.standalone_pushes` | 0.8.39 | 0.30.1 | 0.8.48 for the download |
| [Standalone recording probe](#standalone-recording-probe) records with `query=probe` and the `standalone_recording_probe` summary field | 0.8.39 | 0.30.1 | 0.8.48 for the download |
| [Recording query records](#failed-recordings) that say how a recording list, calendar, thumbnail or download ended | 0.8.39 | 0.30.1 | 0.8.48 for the download |
| [Lookup fields](#lookup-fields-of-a-connection-attempt) that say what the local lookup of a station connection attempt saw | 0.8.38 | 0.30.0 | 0.8.47 for the download and assessment |
| Beta bridge, library and integration versions such as `0.8.38-beta.1` as received instead of `unavailable` | 0.8.38 | 0.30.0 | 0.8.47 for the download |
| Experimental standalone option state, and a log line for each standalone camera the library keeps at `standalone_transport_unverified` with the option on | 0.8.37 | 0.29.2 | 0.8.46 for the download and assessment, none for the log line |
| Machine error codes without a fixed code list, in logs and download | 0.8.16 | 0.12.2 | 0.8.16 for the download |
| Current startup logs, including rejected-device firmware and parent context | 0.8.5 | 0.12.2 | No integration update needed to read bridge logs |
| One file through HA **Download diagnostics** | 0.8.5 | 0.12.2 | 0.8.5 |
| Earlier structured startup reports, without rejected-device parent/firmware context | 0.8.4 | 0.12.1 | No integration update needed to read bridge logs |
| Earlier unsupported-model/type error lines only | 0.8.3 | 0.12.1 | No integration update needed to read bridge logs |

These are the introduction versions. Later compatible releases retain the
corresponding collection method. The bridge includes its library, so users do
not install the library separately. Check the actual `software` values in the
report rather than inferring them from a release title or the HACS version.

Update the bridge through the HA app store or the documented Docker update path.
The integration updates separately through HACS. A version on `main` does not
mean that its [public integration release](https://github.com/keesmod/ha-eufy-cam/releases)
is available. If integration 0.8.5 is not offered, use the bridge logs. Follow the
[upgrade and recovery guide](MEGA_MIGRATION.md) when upgrading an older setup.

## Collect the startup logs

1. Update the **Eufy Security Viewer Bridge** to 0.8.5 or a later compatible
   release. Leave the optional live-video diagnostics setting disabled.
2. Restart the bridge once. A Home Assistant restart is not needed for this log
   collection. Wait until startup completes or an error appears, and complete
   login verification if prompted.
3. Open the app's **Logs** tab. For Docker, read the bridge container's logs.
4. Copy all lines beginning with `Eufy discovery:`, `Eufy backend:` and
   `Eufy experimental standalone:` from that startup attempt. Include `summary`,
   every `device` and `issue` row, the matching `end` row, and connection/error
   records. If authentication fails before a summary is produced, include the
   available diagnostic lines.
5. Review the excerpt using the privacy guidance below, then attach it as a text
   file or paste it in a code block on the existing issue.

Keep the complete bounded report, including accepted devices. A final error line
alone cannot explain whether the parent HomeBase was returned or connected.
A fresh restart produces full rows even if repeated reports had been suppressed.

## Download one file from Home Assistant

With both bridge and integration 0.8.5 or later compatible versions installed:

1. Restart the bridge to obtain fresh startup evidence, then wait for startup or
   the reported failure. Follow the integration's normal restart instructions if
   you have just updated its files.
2. Open **Settings > Devices & services > Eufy Security Viewer**.
3. Open the integration entry's menu and select **Download diagnostics**.
4. Review the file, then attach it to the existing issue.

The file includes HA/integration versions, the complete latest discovery and up
to 100 recent diagnostic events, alongside HA's standard system information.
The integration can request the report even when its setup failed. An unreachable
or older bridge returns an explicit unavailable result. Use its startup logs in
that case. No automatic upload or issue submission takes place.

Bridge-only consumers can use the existing Bearer authentication to request
`GET /v1/diagnostics`. The response reads cached evidence and triggers no cloud
or device requests. Never put the token in a shared command or URL.

## Interpret the report

The report covers the public library discovery result. A cloud request failure
with `inventory_available=false` does not prove that the account has no devices.
Ignored non-security rows and data omitted by Eufy are outside this report.

The client maps the C30 as `T8224` with device type `95`, following the pinned
catalogue, and since client 0.18.1 also admits the reported type `96`.
Discovery requires one of those exact model/type pairs, the values Eufy
actually returns and the received owner relationship. The report helps
distinguish discovery rejection, parent problems and setup failure.

On 2026-09-23 the reporter of
[issue #40](https://github.com/keesmod/ha-eufy-cam/issues/40#issuecomment-5801839459)
shared the report from bridge 0.8.25 with client 0.14.0. Their C30 arrives as
`model=T8224` with `device_type=96`, firmware 3.4.9.2, `parent_status=present`
and a T8030 owner on firmware 3.8.5.2. Discovery rejects it with
`unsupported_device` because type 96 belongs to `T8223` (C31) in the catalogue.
The summary reports `outcome=accepted`, six cameras, one station and three issues.
This is reported, not independently reproduced. Client 0.18.1, included in
bridge 0.8.26, admits exactly this pair with the C30 policy
([eufy-mega-client#183](https://github.com/keesmod/eufy-mega-client/issues/183)).
The reporter has not yet confirmed the C30 on that bridge. The other two issue
rows were not shared.

On 2026-09-25 and 2026-09-27 the reporter of
[issue #129](https://github.com/keesmod/ha-eufy-cam/issues/129) described three
eufyCam 2C cameras that arrive as `T8113-Z` with device type 8 under a T8030 on
firmware 3.8.7.4, and a Floodlight Cam 2K that arrives as `T8424` with type 39 as
its own station. With a local `T8113-Z` profile the cameras were accepted and
snapshots, live view and HomeBase recordings worked for the reporter. Client
0.26.0, included in bridge 0.8.29, admits exactly `T8113-Z` with type 8 and
reports `T8424` as `relationship=standalone` with
`relationship_reason=standalone_transport_unverified` instead of
`unsupported_device`. Standalone cameras have no connection route yet
([eufy-mega-client#142](https://github.com/keesmod/eufy-mega-client/issues/142)).
This is reported, not independently reproduced. Since bridge 0.8.29 and
integration 0.8.37 the report keeps a model code with a short suffix, such as
`T8113-Z`, instead of `unavailable`. Since bridge 0.8.36 and integration 0.8.45
it also keeps an unhyphenated catalogue code such as `T8410C`.

On 2026-10-04 the reporter of
[issue #136](https://github.com/keesmod/ha-eufy-cam/issues/136) shared that a
Wired Cam C31 arrives as `model=T817L` with `device_type=10031`, firmware
2.1.0.3, `parent_status=present` and a T8030 owner on firmware 3.8.5.2, and that
bridge 0.8.29 rejects it with `unsupported_device`, because the client did not
know this pair. This is reported, not independently reproduced. Client 0.28.0,
included in bridge 0.8.30, adds type 10031 and admits exactly this pair in the
indoor family with HomeBase 3 media. A C31 that is its own station reports
`relationship=standalone` with
`relationship_reason=standalone_transport_unverified`.

On 2026-10-05 the same reporter
[ran bridge 0.8.30](https://github.com/keesmod/ha-eufy-cam/issues/136#issuecomment-5993196872)
with integration 0.8.38 on that camera and HomeBase. They saw the C31
discovered under the HomeBase 3, and a snapshot, live video and audio with
NVIDIA live acceleration, recording lists, recording playback and a person event
worked. The live audio row recorded `stop_confirmed: true`. Other event types
were not reported. Recording playback showed a native remux, because this C31's
recordings arrived as H.264 and the bridge only converts H.265 recordings. This
is reported, not independently reproduced.

On 2026-10-09 the [issue #66 reporter][66-update] ran integration 0.8.41 and
bridge 0.8.32 with a T8030 on firmware 3.8.7.4. Snapshots, live and recordings
worked on T8213 firmware 0.2.1.8 and T8161 firmware 3.4.3.0. A T8113-V with
type 8 and firmware 3.0.7.8 under that HomeBase was still rejected as
`unsupported_device`. Client 0.28.2, included in bridge 0.8.33, admits exactly
this pair with the T8113/T8113-Z H3 policy.

On 2026-10-10 the same reporter [ran integration 0.8.42][66-result] and bridge
0.8.33 with client 0.28.2 on that T8113-V and HomeBase. The bridge discovered
the camera, Home Assistant created it as its own camera, and a snapshot, live
view, recording playback and motion events worked. Audio, the live stop,
cancellation and other event types were not reported separately. This is
reported, not independently reproduced.

The 2026-10-09 update describes standalone T84A1 firmware 1.1.0.4 with no
media and `standalone_transport_unverified`. That is the existing missing standalone
route in [client #142](https://github.com/keesmod/eufy-mega-client/issues/142),
not the T8113-V recognition bug. The reporter's model/type/firmware/topology
and feature results are recorded in the client's [model matrix][66-matrix]. The
same reporter's result on the experimental route of 2026-10-17 is below.
T8920/type 20 and T87B0/type 157 are non-camera sensor/tracker products and
remain outside camera discovery.

On 2026-10-10 the [issue #152][152] reporter ran integration 0.8.43 and bridge
0.8.34 with client 0.29.0 as the Home Assistant OS app on amd64, with Home
Assistant 2026.9.4. `experimental_standalone` was on, and the cameras and the
bridge were on the same Wi-Fi subnet. Two standalone Indoor Cam 2K Pan & Tilt
`T8410`/type 31 cameras on firmware 2.3.2.4 and 2.3.1.6, without a HomeBase,
were discovered with a complete `descriptor`. `did`, `license`, `admin_user` and
`lan_address` were all true. `relationship_transport` stayed `null`, the media
rows stayed unsupported with `standalone_transport_unverified`, and the bridge
made no session attempt. The cause is that client 0.29.0 admitted only the
`T84A1` to the experimental route. Client 0.29.1, included in bridge 0.8.35,
also admits a standalone T8410. Reported, not independently reproduced. On
2026-10-13 the same reporter had live video working on the camera with firmware
2.3.2.4. Live video failed on the one with 2.3.1.6, and its event log had
`device_request_timeout`. A [later download][152-lookup] from bridge 0.8.37
with client 0.29.2 and integration 0.8.46 showed its connection ending at
`stage=lookup` with `inventory_address=true`, while the other camera connected.
Bridge 0.8.38 records what that lookup saw, see
[lookup fields](#lookup-fields-of-a-connection-attempt). A report on
2026-10-15, with bridge 0.8.38-beta.1, client 0.30.0-beta.1 and integration
0.8.47-beta.1, gave a failed run of that camera with 38 lookup replies, all from
other devices in the account, and none from the camera or its inventory
address. A later run connected, and both cameras streamed live video. See the
[model matrix](https://github.com/keesmod/eufy-mega-client/blob/main/docs/MODEL_MATRIX.md#reported-standalone-t8410-result-2026-10-13).
A report on 2026-10-16, with bridge 0.8.39-beta.1, client 0.30.1-beta.1 and
integration 0.8.48-beta.1, gave two more failed runs of that camera while it
was unpowered, at startup on 2026-10-15 and at its first recordings attempt.
Each had 20 lookup rounds, 37 or 38 replies from other devices in the account,
no own reply and `lookup_inventory_reply=none` ([report][152-records]). After
power was restored it streamed live video. Whether it was unpowered in the
earlier failed runs is not known. Reported, not independently reproduced.

On 2026-10-09 the reporter of [issue #149][149] ran integration 0.8.42 and
bridge 0.8.33 with client 0.28.2 on Home Assistant 2026.10.0, with a T8030 on
firmware 3.8.7.4. Three T8160 cameras on firmware 3.4.3.0 and a T8213 on
firmware 0.2.1.8 were discovered with state, battery and stored snapshots, and
live video worked on one T8160 through the card on the local network. Three
other rows under that HomeBase were rejected as `unsupported_device` with
`parent_status=present`. One arrives as `T8160-C` with type 19, firmware
1.5.8.6 and hardware 0.0.3.7, and the Eufy app shows it as a regular eufyCam 3.
The other two have type 31 and firmware 3.3.4.4 and show `model=unavailable`,
because the received string did not fit the diagnostic bound. The reporter
calls them Indoor Cam Pan&Tilt 2K T8410, but `T8410` with type 31 was already
admitted, so the received string is not exactly `T8410`. This is reported, not
independently reproduced.

Client 0.29.2, included in bridge 0.8.36, admits exactly `T8160-C` with type 19
under the H3 media policy, which checks the actual HomeBase 3 owner and its
firmware. It does not join the closed model-only policy of the original T8160.
The client also admits exactly `T8410C` with type 31 under the HomeBase 3 policy
of `T8410`: the indoor camera route with H3 media and the same owner and
firmware checks. Unlike `T8410`, client 0.29.2 does not admit it to the opt-in
[experimental standalone route](#experimental-standalone-cameras). That admission rests on
public evidence, not on these rows. Eufy's [HomeBase compatibility
guide][149-eufy] lists the Indoor Cam Pan&Tilt 2K as `T8410C`, supported on
HomeBase 3. A [public inventory log][149-mega] shows `T8410C` with type 31 under
a T8030, and an [upstream report][149-upstream] shows `T8410C` with type 31 on
firmware 3.3.3.2 under a T8030. The reporter's 3.3.4.4 fits that firmware line.
Whether their type 31 rows carry exactly `T8410C` was not verified at that
release. The result below points to it. No other type 31 string and no
type-only or prefix match is added. Owners use Pan & Tilt names for both
`T8410` and `T8410C`, so the received model code, not the product name, decides
which route applies. A standalone `T8410C`, with an empty or self parent, is now
reported as `relationship=standalone` with
`relationship_reason=standalone_transport_unverified` instead of
`unsupported_device`, on bridge 0.8.36 and 0.8.37 also with the opt-in. Home Assistant then creates it as a
camera whose snapshot, live view and recordings are unsupported.

On 2026-10-16 the reporter [reported][149-result] that after updating to
integration 0.8.45 and bridge 0.8.36 all devices appeared right away and work
with snapshots, live view, recordings and events. This includes the `T8160-C`
and the two type 31 cameras, although the comment names no device, firmware or
event type separately. Audio, the live stop and cancellation were not reported.
Client 0.29.2 admits type 31 only as exactly `T8410` or `T8410C`, and `T8410`
was already admitted when these rows were rejected, so their appearance points
to exactly `T8410C`. No download shows that code. The reporter also sees
snapshots that are often out of date and live start times that vary a lot on all
devices, and finds the Eufy app similar but a bit more stable. An idle view
shows the latest received snapshot, as described in
[snapshot and streaming limits](USAGE.md#honest-snapshot-and-streaming-limits).
This is reported, not independently reproduced, and is recorded in the client's
[model matrix][149-matrix]. A reported standalone `T8410C` result follows below.

On 2026-10-15 the [issue #152][152] reporter shared the [`device` row][168-row]
of a standalone Indoor Cam Pan&Tilt 2K `T8410C` on firmware 3.3.4.4 without a
HomeBase, from bridge 0.8.38-beta.1 with client 0.30.0-beta.1 and integration
0.8.47-beta.1, with `experimental_standalone` on. It had
`relationship=standalone`,
`relationship_reason=standalone_transport_unverified`, no
`relationship_transport` and a complete `descriptor`, and the bridge made no
session attempt. Client 0.30.0 also admits exactly a standalone `T8410C`/type
31 to the experimental route ([issue #168][168]). The first betas, bridge
0.8.38-beta.1 with client 0.30.0-beta.1, do not include it. That report has
no session result. Reported, not independently reproduced.

In a [report on 2026-10-16][152-records] the same reporter ran integration
0.8.48-beta.1
and bridge 0.8.39-beta.1 with client 0.30.1-beta.1 on that camera, with
`experimental_standalone` on. Its `device` row had
`relationship_transport=experimental`, no `relationship_reason`,
`owner_status=connected` and its snapshot, live and recordings rows available
as experimental. Its startup `station_connection` record was connected after
one lookup round with the camera's own reply (`lookup_rounds=1`,
`lookup_own_replies=1`, `lookup_inventory_reply=own`). Live video worked, and
Home Assistant's camera image returned a current frame. Its recording list was
rejected with `history_rejected` and `result_code=-1100`, see
[failed recordings](#failed-recordings). The camera has no microSD card.
Reported, not independently reproduced.

On 2026-10-17 the issue #66 reporter [reported][84A1-result] a standalone Wall
Light Cam S100 `T84A1` on firmware 1.1.0.4, with integration 0.8.47 and bridge
0.8.38 with client 0.30.0 and `experimental_standalone` on. Its `device` row had
`relationship=standalone`, `relationship_transport=experimental` and a complete
`descriptor`. Its `station_connection` record with `phase=connect` was
connected, with `lookup_own_replies=1`, `lookup_inventory_reply=own` and
`inventory_address_on_subnet=true`. A snapshot and live video with audio worked
over several sessions. Recordings were not tested. The comment has no
diagnostics download attached. Reported, not independently reproduced, and
recorded in the client's [model matrix][84A1-matrix].

[152]: https://github.com/keesmod/ha-eufy-cam/issues/152
[152-records]: https://github.com/keesmod/ha-eufy-cam/issues/152#issuecomment-6208097780
[168]: https://github.com/keesmod/ha-eufy-cam/issues/168
[168-row]: https://github.com/keesmod/ha-eufy-cam/issues/168#issuecomment-6189829101
[152-lookup]: https://github.com/keesmod/ha-eufy-cam/issues/152#issuecomment-6152282566
[66-update]: https://github.com/keesmod/ha-eufy-cam/issues/66#issuecomment-6083775017
[66-result]: https://github.com/keesmod/ha-eufy-cam/issues/66#issuecomment-6098838866
[66-matrix]: https://github.com/keesmod/eufy-mega-client/blob/main/docs/MODEL_MATRIX.md#reported-issue-66-update-0282
[84A1-result]: https://github.com/keesmod/eufy-mega-client/issues/142#issuecomment-6236984885
[84A1-matrix]: https://github.com/keesmod/eufy-mega-client/blob/main/docs/MODEL_MATRIX.md#reported-standalone-t84a1-result-2026-10-17
[149]: https://github.com/keesmod/ha-eufy-cam/issues/149
[149-result]: https://github.com/keesmod/ha-eufy-cam/issues/149#issuecomment-6214980737
[149-eufy]: https://service.eufy.com/eu/article-description/eufy-Security-Complete-HomeBase-Compatibility-Guide
[149-mega]: https://github.com/mscodemonkey/eufy-mega-security/issues/7
[149-upstream]: https://github.com/bropat/eufy-security-client/issues/722
[149-matrix]: https://github.com/keesmod/eufy-mega-client/blob/main/docs/MODEL_MATRIX.md#reported-issue-149-0292

`ref`, `owner_ref` and `device_ref` are anonymous references within a report.
`inventory_row` is a separate zero-based source position. Use the `report` number
and timestamps together, and do not compare references across restarts.

Camera rows use `owner_connected` and `owner_status` for the HomeBase connection.
Their own `station_status` is `not_applicable`, so `station_connected=null` does
not indicate a failed camera connection. Statuses distinguish `not_checked`,
`connected`, `disconnected`, `error` and `not_applicable`. Camera availability is
an observation, and media capabilities describe software admission. Neither is a
fresh playback or reachability test.

Rejected-device firmware and parent fields are included when available and valid.
`parent_status=present` means a unique matching security row, not proof that it
is a supported or connected HomeBase. Other values distinguish `none`, `self`,
`missing`, `ambiguous` and `invalid`. Unknown or invalid output values remain
`null` or `unavailable`. No model or type is inferred from a serial number.
A model appears exactly as received when it is `T` followed by four uppercase
letters or digits, optionally followed by one to three more (`T8410C`) or by a
hyphen and one or two (`T8113-Z`), at most eight characters in total. Anything
else, including a serial number, a lowercase letter or a space, shows as
`unavailable` and is never trimmed or shortened to fit. Bridges before 0.8.36
and integrations before 0.8.45 also show an unhyphenated code such as `T8410C`
as `unavailable`.

### HomeBase connection timeouts

With bridge and integration 0.8.16, `station_connection.reason` preserves codes
such as `device_request_timeout` instead of replacing them with
`unclassified_error`. The `phase` identifies `connect` or `refresh_state`.
The timeout alone does not establish whether networking, connection negotiation
or a device response is responsible. Include the complete report and firmware.

Since bridge 0.8.29 and integration 0.8.37 a failed `connect` record also says
how far the attempt got:

| `stage` | Meaning |
|---|---|
| `none` | The attempt failed before the bridge looked for the HomeBase |
| `lookup` | No HomeBase answered the local lookup. `inventory_address` says whether Eufy's inventory supplied a LAN address for it |
| `station_found` | The HomeBase answered the lookup but did not complete the P2P handshake |
| `session_open` | The P2P session opened but the command key was not established |

The assessment names the `lookup`, `station_found` and `session_open` stages.
For each HomeBase that failed in the current report it takes the latest failed
`connect` that ran out of time (`device_request_timeout` or
`device_disconnected`) after that HomeBase's last connection in the report, and
names the latest such attempt that reached one of those three stages. Otherwise
it keeps the generic text. A failure that repeats the previous record of the
same HomeBase is not recorded again, so its latest record has the stage and
reason of its latest attempt.

The same client version changes the lookup itself. The first lookup still goes
to the LAN address from the inventory. When that stays silent for a second, the
retries also go to the broadcast address of every external IPv4 interface of
the bridge host, at most 16. Without an inventory address, or an address the
HomeBase last completed a handshake from, the first lookup already broadcasts.
A stale address or a Docker host whose first interface is a container bridge
therefore still finds the HomeBase. Only the HomeBase's own answer ends the
lookup. `lookup` after all of that points at a HomeBase the bridge host cannot
reach on its LAN, for example from a different subnet or on a network that
blocks UDP broadcasts on port 32108. This follows
[issue #130](https://github.com/keesmod/ha-eufy-cam/issues/130), where a
HomeBase 3 on firmware 3.8.7.4 behind a Docker host ended every connection in
`device_request_timeout`. The maintainer's HomeBase 3 on the same firmware
connects, so the firmware alone does not explain that report.

No optional live-video debug setting is needed for these codes. After updating
both components, restart the bridge once, wait for the startup result, then
use **Download diagnostics**. An older integration may replace new codes with
`null`. In that case use the updated bridge's complete startup report until the
integration is updated too. The HAOS app URL is `http://127.0.0.1:8063`.

### Experimental standalone cameras

Since bridge 0.8.34 with client 0.29.0 and integration 0.8.43, every standalone
camera row has `descriptor`. It says whether Eufy's inventory row for that
camera has a P2P device ID (`did`), a P2P license (`license`), an administrator
user (`admin_user`) and a private LAN address (`lan_address`). These are
booleans only. The values themselves are never reported, and a present field
does not prove that it works.

With the [opt-in](USAGE.md#experimental-standalone-cameras), a standalone
`T84A1` row, from bridge 0.8.35 with client 0.29.1 a standalone `T8410` row,
and from bridge 0.8.38 with client 0.30.0 a standalone `T8410C` row, has
`relationship_transport=experimental` and no `relationship_reason`. Any other
standalone model, a T8410 on bridge 0.8.34 or a T8410C on bridge 0.8.36 or
0.8.37 keeps `relationship_transport=null` and
`standalone_transport_unverified` without a connection attempt, even with the
option on.

Since bridge 0.8.37 the `summary` record has `experimental_standalone`, `true`
when the option is on and `false` when it is off. With `true`, such a standalone
row is a camera whose model the bundled library does not admit, not a failed
attempt. The bridge log then has one line per such row, with the model code
only:

```
Eufy experimental standalone: model=T8400 is not admitted to the experimental route. The option is on, but the bundled library allows that route only for specific standalone models, so this camera stays standalone_transport_unverified without a connection attempt.
```

Integration 0.8.46 keeps the field in **Download diagnostics** and reports each
such model as `standalone_admission`. Bridge 0.8.36 or older has neither the
field nor the per-camera log line, so its report and **Download diagnostics**
look the same as with the option off. On bridge 0.8.34 to 0.8.36 only the
startup line beginning with `Eufy experimental standalone cameras enabled:`
shows that the option is on. Update the bridge to 0.8.37 in that case. With
bridge 0.8.37, integration 0.8.45 or older drops the field and shows no
finding. Use the bridge log line in that case. With the option off the field is
`false` and nothing else changes.

The bridge connects each admitted camera at every discovery, normally at
startup. Its `owner_status` and `owner_connected` then describe the camera's
own session, and `recent_events` has its `station_connection` records with the
same `stage` values as a HomeBase. The assessment reports such a camera as
`standalone_connection`, separately from any HomeBase:

| Result | Meaning |
|---|---|
| `owner_status=connected` | The lookup, handshake and command key setup completed. The client sets the key locally once the session answers, so this does not yet show that the camera accepts it |
| `stage=none` | The attempt stopped before the lookup. The `reason` says why, for example `invalid_connection_credentials` when `descriptor` lacks `did` or `admin_user` |
| `stage=lookup` | The camera did not answer the local lookup |
| `stage=station_found` | The camera answered the lookup but did not complete the P2P handshake |
| `stage=session_open` | The P2P session opened but the command key was not established |

After a connected result, the media rows and a snapshot, live view and
recording attempt show whether the camera answers those commands on its own
storage. The first answered snapshot, recording or live result shows whether
the camera accepts the command key. A live view or snapshot shows that in the
viewer. From bridge 0.8.39 with client 0.30.1 the camera's `media.recordings`
has `reason=standalone_recordings_unverified` and no recording request is
sent, see [failed recordings](#failed-recordings). The only exception is the
opt-in [standalone recording probe](#standalone-recording-probe) at login.
Include the complete download in
[client #142](https://github.com/keesmod/eufy-mega-client/issues/142).

### Lookup fields of a connection attempt

Since bridge 0.8.38 with client 0.30.0 and integration 0.8.47, a camera or
HomeBase stuck at `stage=lookup` also shows what its lookup saw. The fields are
on the failed `connect` record in `recent_events` and in the bridge's
`Eufy discovery:` log lines. They are counts, booleans and one reply class,
never an ID or address. The assessment names the first row that applies, in
this order:

| Fields | What they show |
|---|---|
| `lookup_rounds=0` | No lookup request left the bridge |
| `lookup_broadcast_enabled=false` or `lookup_send_errors` above 0 | Some lookup requests could not be sent from the bridge host |
| `lookup_inventory_reply=near` or `lookup_near_replies` above 0 | A reply carried the camera's ID in a different format, and the lookup did not accept it |
| `lookup_inventory_reply=foreign` | The device at the inventory LAN address answered with an ID outside the account |
| `lookup_inventory_reply=account` | The inventory LAN address belongs to another device in the account |
| `inventory_address_shared=true` | The inventory lists the same LAN address for another device in the account |
| `lookup_account_replies` above 0 | Other devices in the account answered the broadcast, but the camera did not |
| `lookup_datagrams=0` | No reply of any kind reached the bridge during the `lookup_rounds` rounds |
| Only `lookup_foreign_replies` above 0 | Only devices outside the account answered |

With a near reply the assessment says that the camera or HomeBase gave no
accepted reply, not that it did not answer, also when a send error comes first.
When another device answered, in the account or outside it, the HomeBase
assessment says that this HomeBase did not answer instead of that no HomeBase
answered.
`inventory_address_on_subnet=false` says the inventory address lies outside
every local subnet of the bridge host. None of these values proves a cause on
its own. A connected attempt carries the same fields, on the `connect` record of
a standalone camera and on the `refresh_state` record that follows a HomeBase's
connect. Within one report, a later failed attempt of the same HomeBase with the
same stage, reason and coarse lookup outcome adds no record. The coarse outcome
is whether each count is above 0, plus each boolean and the reply class. The
counts, including the round count the assessment quotes, can then come from the
first such attempt. A standalone camera connects once per report, so its record
is always its latest attempt. Without the fields the bridge, its client or the
integration is older, or the attempt ended before its lookup. Integration 0.8.46
drops them from **Download diagnostics**, so use the bridge log lines in that
case.

### Failed recordings

Since bridge 0.8.39 with client 0.30.1 and integration 0.8.48, a recording
operation leaves a `recording_query` record in `recent_events` and in the
bridge's `Eufy discovery:` log lines
([issue #152](https://github.com/keesmod/ha-eufy-cam/issues/152)). A HomeBase
gets one only for a failed operation. The dialog's text, such as "Recordings
are unavailable for this camera right now. Try again shortly.", does not say
why. The record does.

A camera on the experimental standalone route gets no such record when its
recordings are opened. The opt-in probe at login is described in
[standalone recording probe](#standalone-recording-probe). From bridge
0.8.39 with client 0.30.1 its recordings show as not available with reason
`standalone_recordings_unverified`
([issue #175](https://github.com/keesmod/ha-eufy-cam/issues/175)). The
integration and the bridge refuse each of its recording requests with
`capability_unavailable` before any query, so opening its recordings leaves no
`recording_query` record and sends the camera nothing. Its camera row on the
`Eufy discovery:` log line and in **Download diagnostics** has
`media.recordings` with `available=false`, `status=unsupported` and
`reason=standalone_recordings_unverified`. Bridge 0.8.39-beta.1 with client
0.30.1-beta.1 still sent such a camera's queries and recorded each list,
calendar and download and each failed thumbnail, as in the worked example
below.

When "Show recordings" fails:

1. Check the versions in the app log. The `Eufy discovery:` line with
   `"event":"connection"` shows them in its `software` field.
2. Open the recordings for the day once and wait for the result without
   pressing the button again. Note how many seconds it took. A second press
   while the first load runs cancels it, which closes the camera's session and
   makes the next load connect again.
3. Within 15 minutes, use **Download diagnostics**. Paste `data.integration`,
   `data.support.software`, `data.cameras`, every `data.support.recent_events`
   object whose `event` is `recording_query`, `station_connection` or `fault`
   from those minutes, and `data.assessment`. Without integration 0.8.48, paste
   the app log lines beginning with `Eufy discovery:` that contain
   `"event":"recording_query"`.
4. Say whether the Eufy app shows event clips or only a continuous timeline for
   that day.
5. If a list appears, play one recording and also paste
   `data.support.recording.attempts` and `data.recording_playback.attempts`.
   An attempt's `cause` is the client's code behind its `error`, or `transfer_`
   plus the client's reason when a download's transfer ended incomplete.

The fields that tell the cases apart:

| Fields | What they show |
|---|---|
| `query_stage=admission` with `reason=station_busy` or `client_disconnected` | The bridge or client refused before connecting. Another operation held the camera, or the bridge's client was not connected |
| `query_stage=connect` with `stage` and lookup fields | The camera's connection failed at that `stage`, read as in [lookup fields](#lookup-fields-of-a-connection-attempt). `connection_busy` means another connection was in flight |
| `reason=device_request_timeout` at `query`, `query_answered=false`, `ack_code=null`, `unhandled_replies=0` | The camera stayed silent to the query for 15 seconds |
| The same with a non-zero `ack_code` | The camera refused the query command with that code |
| The same with `ack_code=0` | The camera accepted the query command but sent no database answer within 15 seconds |
| The same with `unhandled_reason=unknown_cmd` | The camera answered without a usable inner command, its code is `unhandled_result_code`, for example -6006 |
| The same with `unhandled_reason=parse_error` | The camera answered with something the session could not parse |
| `reason=history_rejected` at `validate` | The camera answered and rejected the query with the database result in `result_code` |
| `reason=device_disconnected` at `query` | The session closed while the query waited |
| `reason=cancelled` | The request was cancelled, by a second press or after the bridge's 60-second bound |
| `status=completed` with `rows_cipher_id` above 0 | The list worked, but downloads from a standalone camera will be refused with `recording_cipher_unavailable` |

`session_open=false` means the operation had to connect the camera first. A
repeat of the same outcome for the same camera and operation in one report adds
no record. None of these values proves a cause on its own. The field reference
is in the [report contract](DEVELOPMENT.md#recording-query-records).

The [issue #152 report of 2026-10-16][152-records], with bridge 0.8.39-beta.1,
client 0.30.1-beta.1 and integration 0.8.48-beta.1, is a worked example. On two standalone T8410s with firmware 2.3.2.4 and 2.3.1.6, each list on a
powered camera ended at
`query_stage=query` with `reason=device_request_timeout` after about 16
seconds, `ack_code=0`, `query_answered=false` and `unhandled_replies=0`. The
camera acknowledged the query command with result 0, but no answer arrived
within the 15-second page bound. On a standalone T8410C with firmware 3.3.4.4
and no microSD card, each list ended after about a second at
`query_stage=validate` with `reason=history_rejected`, `ack_code=0`,
`query_answered=true`, `result_code=-1100` and `query_rows=0`. The camera
answered and rejected the query. The reporter reads -1100 as missing storage,
which is not proven. The first attempt on the 2.3.1.6 camera, made while it was unpowered, ended at `query_stage=connect` with `stage=lookup` and `lookup_own_replies=0`.
Reported, not independently reproduced.

### Standalone recording probe

With the app option `standalone_recording_probe` on, bridge 0.8.39 with client
0.30.1 sends one read-only database query 10017 to each
experimental standalone camera right after its connection in the login
discovery, see [standalone recording probe](USAGE.md#standalone-recording-probe)
([issue #178](https://github.com/keesmod/ha-eufy-cam/issues/178)). Each probe
leaves one `recording_query` record with `query=probe` in the
`Eufy discovery:` log lines and in `recent_events`. A probe that sent its
request has `pages=1` and `query_limit=20`. Its `returned` is always `null`,
because no HTTP request is answered. The `summary` record has
`standalone_recording_probe`, `true` when the option is on. Recordings on the
standalone cards stay "not available" either way.

To collect the result:

1. Update the integration to 0.8.48 and the bridge app to 0.8.39, or to their
   betas with the probe, see [beta testing](INSTALLATION.md#beta-testing).
   Run only one bridge app.
2. In the app's **Configuration**, keep `experimental_standalone` on, turn on
   **Show unused optional configuration options**, turn on
   `standalone_recording_probe` and save. For Docker, add
   `-e EUFY_EXPERIMENTAL_STANDALONE=true -e EUFY_STANDALONE_RECORDING_PROBE=true`.
3. Restart the app. Wait until the `Eufy discovery:` line with
   `"event":"summary"` appears before you open live view or recordings. Each
   standalone camera can add up to about 15 seconds plus its connection.
4. From the app log, paste verbatim the `Eufy discovery:` line with
   `"event":"connection"`, the line with `"event":"summary"` and the one line
   with `"query":"probe"` for each standalone camera. A camera without a probe
   line was not probed. Also paste its `"event":"station_connection"` line in
   that case.
5. Turn `standalone_recording_probe` off again and restart. Turn it off before
   you enter your Eufy credentials again in Home Assistant.

How to read a probe record:

| Fields | What they show |
|---|---|
| `status=completed` with `query_rows=0` | The camera answered with an empty page for today. It answers the query, but that does not show that it has no footage. Clips from earlier days are not requested, and continuous footage may not be listed by this query at all |
| `status=completed` with `rows_own` above 0 | The camera listed records of its own for today. `rows_other_day`, `rows_invalid_time` and `rows_cipher_id` count those properties over every row of the page, not only the camera's own. Whether to open recordings for that model is a separate later decision |
| `status=completed` with `rows_other_device` or `rows_station_mismatch` above 0 | The answer has records of another device, or records of the camera with another station serial or without a valid storage path, such as a record with only a picture |
| `reason=history_rejected` at `validate` | The camera answered and rejected the query with the database result in `result_code` and `query_result_code`. Unlike a list, this keeps the camera's session open |
| `reason=device_request_timeout` at `query` with `ack_code=0` and `unhandled_replies=0` | The camera accepted the command but sent no answer within 15 seconds. The session is closed |
| The same with a non-zero `ack_code` | The camera refused the command with that code |
| The same with `ack_code=null` | The camera sent neither a command result nor an answer |
| The same with `unhandled_reason=parse_error` | The camera sent a reply the client cannot read, most likely its answer to the probe. `unhandled_result_code` is that reply's database result. A reply that names the latest-info query 10013, which every connection sends, is not counted, also when it cannot be read. A reply without a readable inner command counts |
| The same with `unhandled_reason=unknown_cmd` | The camera replied with an inner command the client does not handle, or without one, its code is `unhandled_result_code` |
| `query_stage=connect` with `stage` and lookup fields | The session was gone before the probe and its new connection failed, read as in [lookup fields](#lookup-fields-of-a-connection-attempt) |
| `query_stage=admission` | The client refused before sending, with the reason in `reason`, for example `station_busy`. The bridge itself never refuses a probe |
| `reason=device_request_failed` at `query` with `pages=0` | The request could not be sent, for example because the library does not list the command for this camera type |
| `reason=device_disconnected` at `query` | The session closed while the probe waited |
| `reason=cancelled` | The bridge stopped during the probe, or the probe reached its 60-second bound |

`session_open=true` says that the camera's session was connected when the
probe started, which is normal right after its discovery connection. A probe
that fails after that connection closes the session, for example after the
15-second timeout. A `station_connection` record with `phase=observation` and
`status=disconnected` then comes just before the probe record, and the
camera's device row in that report shows `owner_status=disconnected` and
`owner_connected=false`. The assessment then reports the camera as
`standalone_connection`, connected on the local route with its session later
closed. With the probe option on, that finding comes from the probe's close and
does not show a connection fault. An answer, also one with `history_rejected`,
keeps the session open and the row at `owner_status=connected`. None of these values
proves a cause on its own. Each model's result, a failure included, goes into the
[model matrix](https://github.com/keesmod/eufy-mega-client/blob/main/docs/MODEL_MATRIX.md).

When the summary has `"standalone_recording_probe":true` but a camera has no
probe line, its connection in the login discovery failed or it is not on the
experimental route. The field says that the option is on, not that this
discovery probed. A discovery after a cloud reconnect sends no probe, so in a
download taken after one, `last_discovery` is a newer report than the probe
records. Match a probe record to its discovery by `report`. A camera that was
offline at login and connected in a later discovery shows `status=connected` in
that later report and still has no probe line. The download keeps only the
latest 100 events, so the probe record can be gone from it while the app log
still has it. With `false` or no field the option is off, or the bridge
predates the probe of 0.8.39. Integration 0.8.48 betas from before the probe
show `query=null` for a probe record and drop the summary field, and integration
0.8.47 drops the record. The app log lines carry both in full.

### Standalone push counts

From bridge 0.8.39 with client 0.30.1, an experimental standalone `T84A1`
delivers motion and person events, see
[standalone T84A1 events](USAGE.md#standalone-t84a1-events)
([issue #185](https://github.com/keesmod/ha-eufy-cam/issues/185)). The download
then has `support.standalone_pushes`, the client's count of every push that
names an experimental standalone camera as its device or station, summed over
all such cameras. It holds numbers only, with no serial, DID, address, name,
time or image. It is `null` when the bridge has no client, for example before
the first login, and with an older bridge. Integration 0.8.47 and 0.8.48 betas
from before the push counts drop the key. HomeBase pushes are never counted.

| Field | Meaning |
|---|---|
| `arrived` | Push deliveries that named a standalone camera |
| `admitted` | Of those, passed on as a motion or person event |
| `refused.events_not_enabled` | The camera's model has no standalone events. Every T8410 and T8410C push counts here |
| `refused.owner_unavailable` | The camera was not set up, or it or its session had failed |
| `refused.serial_mismatch` | The device or station serial of the push was not the camera's own, an empty value included |
| `refused.type_mismatch` | The push type was not the camera's inventory device type, 151 for the T84A1. A cloud alarm push of type 10900 or 11000 counts here |
| `refused.unsupported_event` | The push type was the camera's type, but the event code was not 3101 (motion) or 3102 (person), or the camera lacks that detection. A guard mode, alarm or microSD push counts here only when its type is 151 |
| `sources.cloud`, `sources.local` | Deliveries from the Eufy push service, and camera push notifications over an already open session |
| `event_codes` | Rows of `{code, count}` by the push's event code |
| `push_types` | Rows of `{code, count}` by the push's type field. For a local push that is its message type |

A refused push counts once, under the first rule of the table that it failed,
in this order. `arrived` equals `admitted` plus every refusal, the sum of
`sources`, the sum of the `event_codes` counts and the sum of the `push_types`
counts. A `code` is the whole number from 0 to 99999, `none` when the push had
no such field, or `other` for any other value and once 16 numeric codes exist.
Each list has at most 18 rows. Both the bridge and the integration check every
value again, so a count outside 0 to 2147483647 or an unknown row is left out.

How to read the counts:

- `arrived=0`: no push named the camera while events ran. Either Eufy sent the
  account no push for the camera, or the client could not read the serials of
  its payload. Such a push is neither counted nor admitted, so 0 alone does not
  show that Eufy sends nothing. The counts start only when events run, and a
  push over an open session during live view without running events is not
  counted either.
- `admitted` above 0: motion or person pushes reached the event path. Each
  should appear as an event on that camera in Home Assistant.
- `serial_mismatch`: the push names other serials than the camera's own.
- `type_mismatch`: the push type differs from the inventory device type.
  `push_types` shows the value. 10900 or 11000 is an alarm push, not a motion
  or person push. With `sources.local` above 0 it may be the message type of
  local pushes rather than a cloud push shape.
- `unsupported_event`: `event_codes` shows which codes arrived instead of
  3101 or 3102.
- `event_codes` with `none`: a push without a decoded event code.
- `arrived` counts deliveries, not detections. A detection that arrives both
  from the cloud and over an open session counts twice, and it can become one
  event or two.

The counts are kept for the bridge's running client. They survive an event
stream reconnect but start again at 0 when the bridge restarts or when you
enter your Eufy credentials again. Paste `support.standalone_pushes` with `support.software` and the
standalone camera's device row into
[issue #185](https://github.com/keesmod/ha-eufy-cam/issues/185), together with
what the Eufy app and Home Assistant showed. The result goes into the
[model matrix](https://github.com/keesmod/eufy-mega-client/blob/main/docs/MODEL_MATRIX.md).

## Privacy and scope

The dedicated report excludes device names, serial numbers, account identifiers,
tokens, private addresses, raw errors, payloads, images and alarm state. Review
both the excerpt and HA's standard diagnostic envelope before sharing them.
Never attach `/data`, HA `.storage`, credentials, session stores, raw captures,
full debug logs, recording paths or identifiable footage. See [safe diagnostics](../.github/SUPPORT.md#safe-diagnostics).

The report is bounded to 99 device rows and 99 issue rows plus summary/end, with
up to 100 recent events in the download. It reduces follow-up questions but cannot
guarantee a diagnosis if Eufy omits the necessary data. Keep unrelated media,
physical-device and hardware acceptance claims separate.

Maintainers should follow the [report contract and change checklist](DEVELOPMENT.md#diagnostic-report-contract)
and [diagnostic release checks](RELEASING.md#diagnostic-release-checks).
