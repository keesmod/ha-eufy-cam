# Changelog

## 0.8.48 - 2026-10-22

- **Download diagnostics** keeps a `recording_query` record in
  `support.recent_events` for recording operations, from bridge 0.8.39 with
  client 0.30.1 ([issue #152](https://github.com/keesmod/ha-eufy-cam/issues/152)).
  On 2026-10-15 "Show recordings" failed on a standalone T8410 on the
  experimental route while live view worked, and no download or log said why.
  The bridge answered `recording_unavailable` for almost every cause and
  recorded nothing.
- A HomeBase gets a record only for a failed operation, so its recordings and
  the events timeline do not fill the 100 recent events. The bridge also
  records its own refusal when its client is not connected, as
  `client_disconnected`, for any owner. Apart from that refusal, a camera on the
  experimental standalone route gets no record when its recordings are opened,
  see the issue #175 entry below. Only the opt-in probe of the issue #178 entry
  below records an operation on it, with `query=probe`.
- The record says how far the operation got (`query_stage`), why it failed
  (`reason`, `result_code`), what the device answered to the last query page
  (`ack_code`, `query_answered`, `query_result_code`, `query_rows`), how many
  database replies the session could not use (`unhandled_replies`,
  `unhandled_reason`, `unhandled_result_code`), and the HTTP status the bridge
  answered with (`returned`). An answered list also counts its rows by class,
  including rows with a cipher ID (`rows_cipher_id`). An operation that had to
  connect carries the connection `stage` and the lookup fields of that attempt.
  The record has no ID, path, name or address. Each value is checked against its
  bound, and any other value becomes `null`. The record's `elapsed_ms` allows
  up to one hour, other records keep two minutes. The assessment adds no finding
  for it yet.
- A recording attempt in `support.recording.attempts` keeps the client's code
  behind the bridge error as `cause`, with its numeric `result_code`, for
  example `recording_cipher_unavailable` behind `recording_unavailable`. A
  transfer that ended incomplete gives `transfer_` plus the client's reason,
  such as `transfer_connection_lost`. `null` means the bridge failed without a
  client error or transfer reason.
- The recordings dialog no longer names a HomeBase, because the camera can be a
  standalone camera. A failed list now shows "Recordings are unavailable for
  this camera right now. Try again shortly." instead of "The HomeBase connection
  is unavailable. Try again shortly.", and the dialog says "Loading
  recordings…", "Recording unavailable. Load the date again." and "Device time".
  The Dutch texts change the same way. The cause of a failure is in the new
  record, not in the text.
- The observation changes no recording operation. It keeps the queries, page
  sizes, timeouts and error codes, a failed or cancelled operation still closes
  the owner's session, and the bridge's HTTP answers for a HomeBase keep their
  status codes and bodies. The standalone refusal and the opt-in probe below
  are separate changes. On 2026-10-16 the
  [issue #152](https://github.com/keesmod/ha-eufy-cam/issues/152) reporter's
  records from integration 0.8.48-beta.1 and bridge 0.8.39-beta.1 showed two
  standalone T8410s on firmware 2.3.x acknowledging the list query
  (`ack_code=0`) without ever answering it, and a standalone T8410C on firmware
  3.3.4.4 without a microSD card rejecting it with `result_code=-1100`
  ([report](https://github.com/keesmod/ha-eufy-cam/issues/152#issuecomment-6208097780)). The same
  report had a snapshot and live video working on that T8410C
  ([issue #168](https://github.com/keesmod/ha-eufy-cam/issues/168)).
  Reported, not independently reproduced. Recording playback on a standalone
  T8410 therefore does not work with the list query 10006 that bridge 0.8.38
  sent. Why the T8410s do
  not answer is not proven.
- **Recordings on an experimental standalone camera** now show as not
  available instead of failing after a wait, from bridge 0.8.39 with client
  0.30.1 ([issue #175](https://github.com/keesmod/ha-eufy-cam/issues/175)).
  The client reports the recordings of a standalone T84A1, T8410 or T8410C on
  the experimental route as unavailable with reason
  `standalone_recordings_unverified`. The card disables its Recordings button
  and shows "Recordings: not available on the standalone camera connection",
  in Dutch "Opnames: niet beschikbaar via de standalone cameraverbinding". The
  list no longer waits about 15 seconds before it fails. Snapshot and live view
  stay available. The events card leaves such a camera out, so the events
  timeline of a setup that also has a HomeBase no longer fails after the
  standalone camera's timeout.
- No known request lists or plays the recordings of a standalone T8410. In the
  [report of 2026-10-16](https://github.com/keesmod/ha-eufy-cam/issues/152#issuecomment-6208097780)
  both T8410s acknowledged the list query without answering it, and the T8410C
  rejected it with `result_code=-1100`. The best next candidate, the database
  query 10017 in the shape the Eufy app sends, has public results on other
  standalone models but none on a T84xx camera. Only the opt-in probe of the
  issue #178 entry below sends it. The issue #175 change adds no device
  request, changes no payload and leaves HomeBase cameras, their requests and
  their recordings unchanged.
- For such a camera the bridge refuses each recording request with
  `capability_unavailable` before any client call, so **Download diagnostics**
  has no `recording_query` record of its operations. Its device row shows
  `media.recordings` with `available=false`, `status=unsupported` and
  `reason=standalone_recordings_unverified`.
- **Standalone recording probe** records in **Download diagnostics**, from
  bridge 0.8.39 with client 0.30.1
  ([issue #178](https://github.com/keesmod/ha-eufy-cam/issues/178)). With the
  new bridge app option `standalone_recording_probe` and `experimental_standalone`
  both on, the bridge sends one read-only database query 10017 in the shape the
  Eufy app sends it to each experimental standalone camera, right after the
  camera's connection in the login discovery. It asks for the newest 20 records
  of today. The answer becomes a `recording_query` record with `query=probe`,
  whose readings are in
  [discovery diagnostics](docs/DISCOVERY_DIAGNOSTICS.md#standalone-recording-probe).
  The download keeps `query=probe` and the `summary` field
  `standalone_recording_probe`, a strict boolean that is `true` when the option
  is on. Any other value becomes `null`. The assessment adds no finding for the probe
  record.
- The option is off by default and stays in stable releases as a documented
  diagnostic. The probe sends nothing to a HomeBase or to a camera behind one,
  and leaves every other request and payload unchanged. It only reads. It
  downloads and deletes nothing, and the standalone cards keep showing
  recordings as not available. With the option on, the bridge reports ready
  later. Each standalone camera adds up to about 15 seconds after its
  connection, and the HomeBase cameras of a mixed setup wait too. Turn the option off before you
  enter your Eufy credentials again in Home Assistant, because that login waits
  for the discovery and can exceed Home Assistant's one-minute bridge request
  limit. A camera that does not answer has its session closed after 15
  seconds. A `station_connection` record with `phase=observation` and
  `status=disconnected` then precedes the probe record, and the camera's device
  row in that report shows `owner_status=disconnected`. The assessment in
  **Download diagnostics** then reports that camera as `standalone_connection`
  with "The experimental standalone camera connected on the local route, and
  its session later closed." That finding comes from the probe's close, not
  from a connection fault. An answer, also one with `history_rejected`, adds no
  finding. The probe has software coverage only, and no probe result on
  hardware is recorded yet. See
  [standalone recording probe](docs/USAGE.md#standalone-recording-probe).
- **Refresh snapshot** button for each camera, from bridge 0.8.39
  ([issue #182](https://github.com/keesmod/ha-eufy-cam/issues/182)). Until now
  a snapshot was only the latest picture the bridge already held, an event
  cover or the last frame of a live view, and nothing could ask a camera
  for a new one. A press, also `button.press` from an automation, starts the
  camera like a live viewer, keeps a frame about one second after the first
  one and then stops the camera with the normal confirmed stop. The camera's
  `snapshot_received_at` changes and the card shows the new picture. A camera
  that sends no picture in time fails the press with a short message after at
  most about 30 seconds. The refresh has software coverage only, and no
  hardware result is recorded yet.
- Each press wakes the camera and costs battery like a short live view. It
  counts against the HomeBase live limit `live_max_streams_per_station` and is
  refused, not queued, while that limit is reached, while a recording is being
  prepared or while a previous live session is still stopping.
  A camera that is already live keeps its newest frame without a second start,
  and its live view continues. Nothing refreshes by itself. The integration
  never presses the button, and image requests, card loads and more-info still
  never wake a camera.
- The button needs bridge 0.8.39 and appears only when the bridge advertises
  the refresh with `snapshot_refresh: 1` in its state, for a camera whose
  snapshot and live capabilities are available. A bridge updated later or a
  capability that becomes available later adds the button without a restart.
  **Download diagnostics** keeps the pipeline event `snapshot_refresh` of a
  live session a refresh attached to. Bridge 0.8.39 also keeps the last frame
  of a finished live view as the snapshot until a newer image arrives. Until
  now the next unrelated bridge update could put the older event cover back.
- **Motion and person events for an experimental standalone T84A1**, from
  bridge 0.8.39 with client 0.30.1
  ([issue #185](https://github.com/keesmod/ha-eufy-cam/issues/185)). With
  `experimental_standalone` on, a standalone Wall Light Cam S100 `T84A1` now
  fires its existing event entity and the `eufy_viewer_event` automation event
  for motion and person, as a camera behind a HomeBase does. Until now the
  client dropped every push of a standalone camera. The client admits a push
  only when its device and station serial both name the camera, its type is the
  camera's type 151 and its event code is 3101 (motion) or 3102 (person).
  Every other push stays refused, including guard mode, alarm, microSD and
  every T8410 or T8410C push. A person event has `recognition=unidentified`
  and no name. No new option is needed. The events use the existing event
  entity and automation event of the integration.
- A standalone camera still gets no guard mode or alarm state. An event opens
  no camera connection and loads no image, so it brings no new event image and
  does not refresh the camera's snapshot. Standalone T8410 and T8410C cameras
  still have no events. This change leaves HomeBase cameras and their events
  unchanged. The events have synthetic test coverage only. No standalone T84A1 push has been
  captured yet, so the result on hardware is pending.
- **Download diagnostics** keeps `support.standalone_pushes`, the numbers-only
  push counts of the bridge's client, from bridge 0.8.39 with client 0.30.1.
  It has `arrived`, `admitted`, `refused` by reason (`events_not_enabled`,
  `owner_unavailable`, `serial_mismatch`, `type_mismatch`,
  `unsupported_event`), `sources` (`cloud`, `local`), and `event_codes` and
  `push_types` as rows of `{code, count}`. A code is a whole number from 0 to
  99999, `none` or `other`, with at most 18 rows per list. Each count is a whole
  number checked against its bound, and anything else is left out. The block is
  `null` when the bridge has no client or predates it. It has no serial,
  address, name or image. The assessment adds no finding for it. See
  [standalone push counts](docs/DISCOVERY_DIAGNOSTICS.md#standalone-push-counts).
- **Bridge dependencies** `protobufjs` 8.8.1 and `strtok3` 10.4.0, from
  bridge 0.8.39. They replace 8.8.0 and 10.3.5 and reach the bridge through
  client 0.30.1. `protobufjs` decodes the messages of the client's cloud push
  connection, and 8.8.1 rejects an overflowing length prefix inside a decoded
  message. `strtok3` is a dependency of `file-type`, which the client's
  vendored image download would use through `image-type`. The client refuses
  that download before any byte is read, so no image reaches `strtok3`. 10.4.0
  adds an optional buffer limit and fixes the cancellation of stream reads.
  These two updates leave live view, snapshots, recordings and events as they
  were. No published advisory
  covers `protobufjs` 8.8.0 or `strtok3` 10.3.5, so these are maintenance
  updates.
- **Bridge app startup** from bridge 0.8.39
  ([issue #197](https://github.com/keesmod/ha-eufy-cam/issues/197)). When
  `token` is missing or shorter than 32 characters, the app logs one line that
  says what it received, for example an empty token or a token of 20
  characters, and stops. The line never contains the token. It also says that
  Home Assistant replaces a `!secret` reference with its value from
  `secrets.yaml` before the app starts. It mentions this because from
  Supervisor 2026.09.3 the Configuration tab and the app info in the Supervisor
  API show the reference and not that value. An invalid `/data/options.json`
  gives only the error name, such as `SyntaxError`, and no longer prints the
  file line holding the token. The 32-character minimum is unchanged.
- A **Video Doorbell 2K** that arrives as `T8210` or `T8210C` with device
  type 7 behind a HomeBase 3 now appears as a camera, from bridge 0.8.39 with
  client 0.30.1 ([issue #198](https://github.com/keesmod/ha-eufy-cam/issues/198)).
  Until now the client rejected it as `unsupported_device`, so Home Assistant
  did not list it. It gets the camera, event and battery entities of the other
  battery doorbells. Snapshots, live view and recordings need the HomeBase 3 on
  firmware 2.0.9.7 or later, as for the C30 and C31. Under another parent,
  such as a HomeBase 2, it now also appears as a camera, but without
  snapshots, live view, recordings or events, with `unsupported_station`. An empty or
  self parent gives `invalid_device_relationship` in the same way. The client
  admits both model codes on public evidence, because issue #198 does not
  show the received model or type. Their coverage is synthetic, and the result on
  hardware is pending. `T8212`, other suffixes and other device types stay
  unsupported. See
  [discovery diagnostics](docs/DISCOVERY_DIAGNOSTICS.md#interpret-the-report).

Upgrade: update the HACS integration to 0.8.48 and the bridge app to 0.8.39,
then restart Home Assistant. Keep the same token and session. No configuration
migration is needed. The `standalone_recording_probe` option stays off until
you turn it on. Integration 0.8.47 still works with bridge 0.8.39, but its
download drops the `recording_query` records including the probe records, the
`standalone_recording_probe` summary field, `standalone_pushes` and the attempt
`cause` and `result_code`, a standalone camera's card shows the generic
"Recordings: unavailable for this camera connection", and it has no Refresh
snapshot button. Standalone T84A1 events and a `T8210` or `T8210C` doorbell
reach integration 0.8.47 as well, because they use the existing camera and
event path. The bridge's `Eufy discovery:` log
lines still carry the records. With bridge 0.8.38 the download has no such
records, a standalone camera's recordings are offered and fail as before, no
camera gets the Refresh snapshot button, a standalone T84A1 has no events and
a `T8210` or `T8210C` doorbell is still rejected as `unsupported_device`.
Rollback: restore the bridge 0.8.38 app backup and integration 0.8.47. A
standalone T84A1 then has no events again, and a `T8210` or `T8210C` doorbell
is rejected again.

## 0.8.47 - 2026-10-15

- **Download diagnostics** now shows beta versions such as integration
  `0.8.47-beta.1`, bridge `0.8.38-beta.1` or a client library beta as received.
  Integration 0.8.46 and bridge 0.8.37 accept only numeric versions and show a
  beta as `unavailable`. This applies to `integration`, the bridge and library
  in `support.software` and the loaded card's `card_version` in live and
  recording samples. Only a `-beta.N` suffix is accepted, with at most 24
  characters. Other suffixes and build strings still show as `unavailable`.
- Firmware, hardware, camera software, Node and Home Assistant versions stay
  numeric only.
- The assessment compares the loaded card with the integration exactly. A
  `0.8.47-beta.1` card under integration `0.8.47-beta.2` is reported as
  `loaded_card_version_missing_or_different`. So is every card when the
  integration version is `unavailable`, which previously matched an
  `unavailable` card version.
- Bridge 0.8.38 reports its own and the client library's beta versions the same
  way in its `Eufy discovery:` log lines. The report schema stays 2.
- **Download diagnostics** keeps what the local lookup of a station connection
  attempt saw, from bridge 0.8.38 with client 0.30.0
  ([issue #152](https://github.com/keesmod/ha-eufy-cam/issues/152)). The new
  `station_connection` fields are counts, booleans and one reply class, such as
  `lookup_rounds`, `lookup_datagrams`, `lookup_account_replies` and
  `lookup_inventory_reply`, never an ID or address. Each value is checked
  against its bound, and any other value becomes `null`.
- When a standalone camera or a HomeBase fails its connection at `lookup`, the
  assessment can add one fixed sentence on what the lookup saw. Examples are
  that no reply of any kind reached the bridge, that the device at the
  inventory LAN address answered with an ID outside this account, or that
  other devices in this account answered the broadcast but this camera did
  not. With a near reply it says that no reply was accepted instead of that
  the device did not answer, and for a HomeBase it no longer says the bridge
  host did not reach the HomeBase. When another device answered the lookup, in
  this account or outside it, the HomeBase finding says that this HomeBase did
  not answer instead of that no HomeBase answered. Without these fields, or when
  none of the listed observations applies, the text stays the same.
- Bridge 0.8.38 releases a camera at once when its live start fails before the
  start command was issued, for example a standalone camera on the
  experimental route that does not complete its connection
  ([issue #152](https://github.com/keesmod/ha-eufy-cam/issues/152)). Until now
  a camera that never connects stayed in `stopping` until a bridge restart,
  because its recovery attempt could not connect either. It could not be
  started again, recording requests on every camera were refused with
  `live_stopping`, and new live starts on other cameras were refused while its
  recovery attempt ran. A start that fails after the start command was issued
  keeps the existing quarantine until the device confirms its stop.
- Bridge 0.8.38 pins client 0.30.0, which also admits a standalone Indoor Cam
  Pan&Tilt 2K `T8410C`/type 31 to the opt-in `experimental_standalone` route
  ([issue #168](https://github.com/keesmod/ha-eufy-cam/issues/168)). The
  [issue #152](https://github.com/keesmod/ha-eufy-cam/issues/152) reporter has
  such a camera on firmware 3.3.4.4 without a HomeBase. With the option on, the
  bridge discovered it with a complete `descriptor` but left it at
  `standalone_transport_unverified` without a session attempt, because the
  client admitted only the Wall Light Cam S100 `T84A1` and the Indoor Cam 2K
  Pan & Tilt `T8410`.
- With the option on, the bridge now connects a standalone T8410C at every
  discovery, normally at startup, as it does for the T8410. Each standalone
  T8410C that does not answer adds up to 20 seconds to discovery. Its snapshot,
  live view and recordings are offered as experimental features and work only
  if that session works. No standalone T8410C result is recorded yet.
- **Download diagnostics** no longer reports such a camera as
  `standalone_admission`, and the bridge log no longer names it in an
  `Eufy experimental standalone:` line. A failed attempt appears as a
  `standalone_connection` finding, as for the T8410.
- Without the option nothing changes. A T8410C under a HomeBase keeps its
  HomeBase route, also with the option. No other model is admitted. For this
  change the bridge changes only the client pin and the startup log text, which
  now names all three models.
- Known problem: on 2026-10-15 the
  [issue #152](https://github.com/keesmod/ha-eufy-cam/issues/152) reporter
  reported that opening the recordings of a standalone T8410 on the
  experimental route, with bridge 0.8.38-beta.1, shows "The HomeBase connection
  is unavailable. Try again shortly." while live view works. Recording playback
  on the experimental standalone route is therefore not confirmed to work. The
  cause is not known yet.

Upgrade: update the HACS integration to 0.8.47 and the bridge app to 0.8.38,
then restart Home Assistant. Keep the same token and session. No configuration
migration is needed. Integration 0.8.46 still works with bridge 0.8.38, but its
download drops the lookup fields. With bridge 0.8.37 the download has no lookup fields and the
assessment keeps its previous text. Rollback: turn `experimental_standalone`
off, which stops the standalone T8410C attempt and also takes a standalone T84A1
and T8410 off the experimental route, or restore the bridge 0.8.37 app backup
and integration 0.8.46, which keeps them on that route with the option on.

## 0.8.46 - 2026-10-13

- Bridge 0.8.37 records the `experimental_standalone` option in the discovery
  `summary`. With the option on, a standalone camera that the bundled client
  0.29.2 keeps at `standalone_transport_unverified` because it does not admit
  its model to the experimental route, such as a standalone `T8410C`, is now
  named as such. On [issue #152][152] such rows
  looked like a failed attempt, because the report did not carry the option
  state ([issue #154][154]).
- The bridge log has one `Eufy experimental standalone:` info line per such
  camera with its model code only. **Download diagnostics** keeps the field and
  explains each such model as `standalone_admission`. Neither part uses a model
  list. With an older bridge that lacks the field, no finding appears. A camera
  whose model/type pair the client does not recognize, including a known model
  code reported with another type, gets neither part. It still appears as an
  `unsupported_device` issue row and log line. A camera whose model the
  client supports only behind a HomeBase, found without one, gets neither part
  either. It still appears as an `invalid_device_relationship` issue row.
- Nothing changes with the option off apart from
  `experimental_standalone: false` in the report. No model is admitted or
  removed, the client stays at 0.29.2 and the report schema stays 2.

Upgrade: update the bridge app to 0.8.37 and the HACS integration to 0.8.46,
then restart Home Assistant. Keep the same token and session. No configuration
migration is needed. Integration 0.8.45 still works with bridge 0.8.37, but its
download drops the new field and shows no finding, so use the bridge log line.
Rollback: restore the bridge 0.8.36 app backup and integration 0.8.45.

[152]: https://github.com/keesmod/ha-eufy-cam/issues/152
[154]: https://github.com/keesmod/ha-eufy-cam/issues/154

## 0.8.45 - 2026-10-12

- Bridge 0.8.36 pins client 0.29.2, which admits exactly two more pairs under a
  HomeBase 3. Bridge 0.8.35 and earlier reject both as `unsupported_device`.
  `T8160-C`/type 19 was reported on [issue #149][149], and the Eufy app shows
  that camera as a regular eufyCam 3. It uses the H3 media policy with the
  actual HomeBase 3 owner and firmware checks. It does not join the closed
  model-only policy of the original T8160.
- The second pair, `T8410C`/type 31, the Indoor Cam Pan&Tilt 2K in Eufy's
  HomeBase guide, is admitted on public evidence. Eufy's [HomeBase compatibility
  guide][149-eufy] lists `T8410C` as supported on HomeBase 3, and public reports
  show `T8410C` with type 31 under a T8030 on the 3.3.x firmware line. `T8410C`
  is the likely model of the two type 31 rows on issue #149, which showed
  `model=unavailable`, but that is not verified. Owners use Pan & Tilt names for
  both `T8410` and `T8410C`, so the received model code, not the product name,
  decides which route applies. Under a HomeBase 3, `T8410C` uses the `T8410`
  policy: the indoor camera route with H3 media and the same owner and firmware
  checks. Unlike `T8410`, it is not admitted to the experimental standalone
  route. A standalone `T8410C`, with an empty or self parent, is now reported as
  `relationship=standalone` with `standalone_transport_unverified` instead of
  `unsupported_device`. Home Assistant then creates it as a camera whose
  snapshot, live view and recordings are unsupported, also with
  `experimental_standalone` on. No type-only or prefix match is added.
- Diagnostics now show an unhyphenated catalogue code such as `T8410C`,
  `T8W11C` or `T8419N` as received, next to the hyphen form such as `T8113-Z`.
  This applies to the bridge's `Eufy discovery:` rows and `Eufy backend:` line,
  its live video and audio rows and the integration's **Download
  diagnostics**. The bound stays at eight characters, so serial numbers and
  free text still show as `unavailable`. Nothing is trimmed, truncated or taken
  from a serial number. If the reporter's type 31 string is another catalogue
  code, the next report shows it.
- Coverage of both new pairs is software only. Hardware results for `T8160-C`
  and `T8410C` remain pending in the client's model matrix. This is
  experimental software support. The standalone `T8410` route from 0.8.44 is
  unchanged.

Upgrade: update the bridge app to 0.8.36 and the HACS integration to 0.8.45,
then restart Home Assistant. Keep the same token and session. No configuration
migration is needed. Integration 0.8.44 still works with bridge 0.8.36, but its
download shows such model codes as `unavailable`. Rollback: restore the bridge
0.8.35 app backup and integration 0.8.44.

[149]: https://github.com/keesmod/ha-eufy-cam/issues/149
[149-eufy]: https://service.eufy.com/eu/article-description/eufy-Security-Complete-HomeBase-Compatibility-Guide

## 0.8.44 - 2026-10-12

- Bridge 0.8.35 pins client 0.29.1, which also admits a standalone Indoor Cam
  2K Pan & Tilt `T8410`/type 31 to the opt-in `experimental_standalone` route.
  The [issue #152][152] reporter has two such cameras without a HomeBase. With
  the option on, bridge 0.8.34 discovered them with a complete descriptor but
  left them at `standalone_transport_unverified` without a session attempt,
  because client 0.29.0 admitted only the Wall Light Cam S100 `T84A1`.
- With the option on, the bridge now connects each standalone T8410 at every
  discovery, normally at startup, as it does for the T84A1. Each standalone
  T8410 that does not answer adds up to 20 seconds to discovery. Its snapshot,
  live view and recordings are offered as experimental features and work only
  if that session works. No physical standalone camera has confirmed it yet,
  see [client #142][standalone].
- Without the option nothing changes. A T8410 under a HomeBase keeps its
  HomeBase route, also with the option. Any other standalone model stays at
  `standalone_transport_unverified`. In the bridge only the client pin and the
  startup log text change, and the log now names both models.
- The discovery diagnostics docs record the #152 report. They now say that
  `owner_status=connected` means the lookup, handshake and command key setup
  completed. The first answered snapshot, recording or live result shows
  whether the camera accepts that key.

Upgrade: update the integration to 0.8.44 in HACS and the bridge app to 0.8.35,
then restart Home Assistant. Keep the same token and session. Integration
0.8.43 is also compatible with bridge 0.8.35, and 0.8.44 packages the matching
release notes without a Python or card change. Rollback: turn the option off,
or restore the bridge 0.8.34 app backup and integration 0.8.43.

[152]: https://github.com/keesmod/ha-eufy-cam/issues/152
[standalone]: https://github.com/keesmod/eufy-mega-client/issues/142

## 0.8.43 - 2026-10-10

- Bridge 0.8.34 pins client 0.29.0 and adds the app option
  `experimental_standalone` (Docker: `EUFY_EXPERIMENTAL_STANDALONE`), off by
  default. With it, a standalone Wall Light Cam S100 `T84A1` tries its own local
  session with the same lookup and command key as a HomeBase. Its snapshot, live
  view and recordings are then offered as experimental features. They work only
  if that session works. This is a test build for the [issue #66][66-result] reporter's
  offer and [client #142][standalone]. No physical standalone camera has
  confirmed it, and its detection events are not included. No cloud key, cipher
  or legacy security-cloud call is added.
- The bridge connects an opted-in standalone camera at every discovery,
  normally at startup. A camera that does not answer adds up to 20 seconds to
  that discovery. It never becomes a HomeBase, so it gets no alarm entity and
  no idle reconnect.
- Discovery diagnostics show, for every standalone camera, which connection
  fields Eufy's inventory row has, as booleans only. An opted-in camera reports
  `relationship_transport=experimental` and the stage its own connection
  reached. The integration keeps these fields in **Download diagnostics** and
  names a failed standalone connection as `standalone_connection`, separately
  from the HomeBase.

Upgrade: update the bridge app to 0.8.34 and the integration to 0.8.43, then
restart Home Assistant. Keep the same token and session. Without the new option
nothing changes for HomeBase cameras. Update the integration before turning the
option on: integration 0.8.42 works with bridge 0.8.34, but its download drops
the new fields and names a failed standalone connection as a HomeBase failure.
Rollback: turn the option off, or restore the bridge 0.8.33 app backup and
integration 0.8.42.

[66-result]: https://github.com/keesmod/ha-eufy-cam/issues/66#issuecomment-6098838866
[standalone]: https://github.com/keesmod/eufy-mega-client/issues/142

## 0.8.42 - 2026-10-09

- Bridge 0.8.33 pins client 0.28.2, which admits exactly the reported
  `T8113-V`/type 8 eufyCam 2C under its actual HomeBase 3. Bridge 0.8.32 rejected
  the model as `unsupported_device`, so HA never created the camera. The new
  profile uses the same snapshot, live and recording route as T8113/T8113-Z.
- Synthetic client tests cover discovery, state/events, stored snapshots, live
  video/audio with confirmed stop, and recording download/cancellation. The
  reporter's V variant on firmware 3.0.7.8 behind T8030 firmware 3.8.7.4 still
  needs post-upgrade hardware validation. This is experimental software support.
- The [issue #66 update][66-update] reports snapshots, live and recordings now
  working on T8213 and T8161. The separate standalone T84A1 limitation remains
  blocked by [client #142][standalone]. T8920 and T87B0 are non-camera products
  and remain outside camera discovery. No standalone or legacy cloud route is
  added.

Upgrade: update the bridge app to 0.8.33. Integration 0.8.41 already understands
this camera descriptor, and 0.8.42 packages the matching release notes without a
Python or card behavior change. Keep the same bridge token and session. No
configuration migration is needed. Rollback: restore the bridge 0.8.32 app
backup and integration 0.8.41.

[66-update]: https://github.com/keesmod/ha-eufy-cam/issues/66#issuecomment-6083775017
[standalone]: https://github.com/keesmod/eufy-mega-client/issues/142

## 0.8.41 - 2026-10-08

This is the first release after 0.8.38. It also contains the unreleased 0.8.39
and 0.8.40, summarized below.

### Home Assistant version

- Home Assistant 2026.9.0 or newer is still required. 2026.10.0 is not
  required. The integration ships no Python packages, so PyJWT and
  cryptography come from Home Assistant itself. Home Assistant 2026.10.0
  brings PyJWT 2.15.1 and cryptography 50.0.1, which fix the PyJWT and
  cryptography advisories that apply to the versions in Home Assistant 2026.9.
  Updating Home Assistant is recommended for that reason.
- Since 0.8.40, tests and type checks run against Home Assistant 2026.10.0.
  The config flow, the card WebSocket commands and the live diagnostics command
  import `probatio`, which Home Assistant has used for schema validation since
  2026.9. Validation is the same.

### Bridge dependencies

- Bridge 0.8.32 updates `ws` from 8.21.3 to 8.22.0. The bridge uses it for the
  `/v1/events` stream to the integration and the `/v1/live` sessions. 8.22.0
  adds an optional `protocols` option that the bridge does not use, and a
  `close()` call with invalid arguments no longer moves a socket to closing.
- `uint8array-extras` moves from 1.5.0 to 1.6.0. It reaches the bridge
  through the client's image type detection and now also accepts an
  `ArrayBuffer`.
- The development types `@types/ws` 8.18.2 and `@types/node` 24.19.0 change
  nothing at runtime.

### Also in this release

- 0.8.40: the dependency security workflow also audits every package in
  `uv.lock`, on each PR, push and release run and daily.
- 0.8.39 with bridge 0.8.31: the startup log states the current live evidence.
  With `live_max_streams_per_station` above 1 it logs `(3 verified, 4
  reported)`, and with `live_max_seconds_mains` above 120 it logs `(verified
  for 1800 seconds on one mains powered camera)`. Only the log text changed.

Upgrade: update the bridge app to 0.8.32 and the integration to 0.8.41, then
refresh the dashboard. Either can be updated first. Rollback: integration
0.8.38 with bridge 0.8.31 from the app backup, or with bridge 0.8.30 from the
0.8.38 release.

## 0.8.40 - 2026-10-08

### Home Assistant 2026.10 schema types

- The config flow, the card WebSocket commands and the live diagnostics
  command import `probatio` instead of `voluptuous`. Home Assistant has
  validated schemas with probatio since 2026.9 and resolves `import
  voluptuous` to it at startup, so validation is the same. Home Assistant
  2026.10 declares these APIs with probatio schema types, and the direct import
  keeps the integration's type check passing.
- The minimum stays Home Assistant 2026.9.0, which already ships probatio.
- Tests and type checks now run against Home Assistant 2026.10.0. Its exact
  pins move the development lock to PyJWT 2.15.1, cryptography 50.0.1 and
  pyOpenSSL 26.4.0. multidict moves to 6.9.1. This resolves the open Dependabot
  alerts for PyJWT, cryptography and multidict. The integration ZIP carries no
  Python packages. A Home Assistant host uses the versions of its own Home
  Assistant release and gets these fixes with Home Assistant 2026.10.0.
- The dependency security workflow also audits every package in `uv.lock`, on
  each PR, push and release run and daily.

Upgrade: update the integration to 0.8.40. The bridge stays at 0.8.31.
Rollback: integration 0.8.39.

## 0.8.39 - 2026-10-06

### Live evidence in the bridge's startup log

- Bridge 0.8.31 corrects two lines it logs at startup, which still described
  the evidence before 2026-09-19. With `live_max_streams_per_station` above 1
  it logs `(3 verified, 4 reported)` instead of `(verified with 2)`. Three
  concurrent eufyCam 3 on one HomeBase 3 were verified on 2026-09-19, and on
  2026-10-06 a user reported four concurrent live streams on their HomeBase 3
  (#136). With `live_max_seconds_mains` above 120 it logs
  `(verified for 1800 seconds on one mains powered camera)` instead of
  `(candidate, unverified on mains powered hardware)`.
- Only the log text changes. The limits, the caps and live, snapshot and
  recording behaviour are the same.

Upgrade: update the bridge to 0.8.31 and the integration to 0.8.39. Rollback:
bridge 0.8.30 and integration 0.8.38.

## 0.8.38 - 2026-10-05

### Wired Cam C31 T817L

- Bridge 0.8.30 includes client
  [0.28.0](https://github.com/keesmod/eufy-mega-client/releases/tag/v0.28.0).
  Discovery admits the Wired Cam C31 that Eufy reports as `T817L` with device
  type 10031, under a HomeBase 3, with snapshots, live view, recordings and
  motion, person, pet, vehicle, sound and crying events. Earlier versions
  rejected it as `unsupported_device`, as reported on #136. Only this exact
  model and type are added.
- Live view uses the HomeBase start that the client already sends for the
  Indoor Cam S350 and the Indoor Cam 2K Pan & Tilt, with the camera's channel.
  A separate project reports live view and snapshots for this camera through a
  HomeBase 3 with the same fields. Nothing has been confirmed through this
  bridge yet. Whether the C31 acknowledges the HomeBase stop is also
  unverified. Without that acknowledgement the stop stays unconfirmed for 8
  seconds and the HomeBase session is closed. The camera stays in `stopping`
  until a later stop is acknowledged. The bridge tries that once, when no
  camera is live. A C31 that never acknowledges the stop stays in `stopping`
  until the bridge restarts, and recordings return `live_stopping` meanwhile.
  `stop_confirmed: false` in the live audio rows of the diagnostics download
  shows it. Pan and tilt, presets, the light and the siren are not offered.
- A C31 that is its own station, without a HomeBase, reports
  `relationship=standalone` with `standalone_transport_unverified` and has no
  media, because standalone cameras have no connection route yet
  ([eufy-mega-client#142](https://github.com/keesmod/eufy-mega-client/issues/142)).

### Dependencies

- The client and bridge lockfiles resolve `http-cache-semantics` 4.3.0 for the
  high advisory
  [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp). It
  reaches the bridge through the client's push service, which uses no response
  cache.
- Client 0.27.0, which this update also brings in, changes only the separate
  mower module and moves `date-and-time` from 4.5.2 to 4.6.0. The client uses it
  for the dates of HomeBase recording queries, and both versions return the
  same dates for its two patterns.
- The integration manifest requires `go2rtc-client>=0.4.0` instead of exactly
  0.4.0. Home Assistant itself depends on this package, and the current
  Hassfest rejects an exact pin of it so the integration can follow Home
  Assistant's own version. Home Assistant 2026.9.4 has 0.4.0 installed, so
  nothing changes on install there.

Upgrade: update the bridge to 0.8.30 and the integration to 0.8.38, then
refresh the dashboard. Rollback: bridge 0.8.29 and integration 0.8.37. Bridge
0.8.29 rejects the C31 again and brings back `http-cache-semantics` 4.2.0 with
the advisory above.

## 0.8.37 - 2026-09-28

### eufyCam 2C as T8113-Z and Floodlight Cam 2K T8424

- Bridge 0.8.29 includes client
  [0.26.0](https://github.com/keesmod/eufy-mega-client/releases/tag/v0.26.0).
  Discovery admits eufyCam 2C cameras that Eufy reports as `T8113-Z` with
  device type 8, with the same HomeBase 3 handling, snapshots, live view and
  recordings as `T8113`. The reporter on #129 saw exactly this working with a
  local patch, which is no longer needed. Other suffixes stay unsupported.
- The Floodlight Cam 2K `T8424` with type 39 is recognized. As its own
  station, as on #129, it reports `relationship=standalone` with
  `standalone_transport_unverified` instead of `unsupported_device`. Under a
  HomeBase 3 parent it reports `unsupported_station`, because the HomeBase
  only stores its video. It still has no media, because standalone
  cameras have no connection route yet
  ([eufy-mega-client#142](https://github.com/keesmod/eufy-mega-client/issues/142)).
- The discovery report, the live diagnostics and the HA download keep a model
  code with a short suffix, such as `T8113-Z`, instead of `unavailable`.

### HomeBase lookup on every interface

- The bridge still asks the HomeBase's LAN address from Eufy's inventory first.
  When that stays silent for a second, the retries also go to the broadcast
  address of every external IPv4 interface of the host, at most 16. Without an
  inventory address, or an address the HomeBase last completed a handshake
  from, the first lookup already broadcasts. Only the HomeBase's own answer
  ends the lookup. Earlier, a stale inventory address or a Docker host whose
  first interface is a container bridge could end every connection in
  `device_request_timeout`, the failure reported on #130. The cause on that
  installation is not confirmed.
- A failed HomeBase connection records how far it got in the
  `station_connection` record: `stage` is `none`, `lookup`, `station_found` or
  `session_open`, and `inventory_address` says whether the inventory had a LAN
  address. For the latest connection that ran out of time in the current
  report, the diagnostics assessment names the stage instead of "does not
  identify the network cause". See `docs/DISCOVERY_DIAGNOSTICS.md`.

### Evidence and limits

The bridge, integration and diagnostics tests cover the new profiles, the
suffixed model codes, the connection stages and the assessment texts. The
client's own tests cover the lookup targets, the DID check and the stage order.
The cameras from #129 and the installation from #130 are not available to the
maintainer. Hardware validation of the unchanged working path, a HomeBase 3 on
firmware 3.8.7.4 with its inventory LAN address, runs on the maintainer's bench
before publication and is recorded in the release notes.

### Upgrade and rollback

Update the bridge app to 0.8.29 (Docker: rebuild from the v0.8.37 tag as
`docs/DOCKER.md` describes) and the integration to 0.8.37, then restart Home
Assistant. No identifier, option or session change. To roll back, restore the
0.8.28 bridge and the 0.8.36 integration from your backups.

## 0.8.36 - 2026-09-28

### Inline live controls below the video at every card width

- An inline card now shows its live controls (pause, stop, sound and close) in
  the compact toolbar directly below the video at every card width, in
  portrait and landscape. The paused bar with resume and stop sits below the
  snapshot at every width as well. Until now only a card narrower than 500 px
  did this, and a wider card laid the controls over the top of the video.
- Why: on a desktop, a tablet in landscape and a phone in landscape the sound
  and close buttons covered the timestamp a T8425 draws in the top-right
  corner of its image. The reporter found that the toolbar below the video
  keeps the whole camera image visible. Refs #127, refs #95.
- Only the layout and focus scrolling change. The controls and their order,
  status messages, live playback, autostart, the popup dialog mode and the
  card editor are unchanged. There is no new card option. The card no longer
  needs to be a CSS size container, so the 500 px threshold is gone.
- The paused bar gets the same compact padding as the toolbar, so it is 12 px
  shorter and as tall as the toolbar, also below 500 px. Since 0.8.24 its
  compact padding had lost to the general bar style.
- Focus goes to the same controls as before, but the focus moves scroll the
  page less, at any card width, because Close below the video is often below
  the fold of a wide card. A start with a tap, a key or Resume scrolls the
  page by the least amount that shows Close. An autostart moves the focus
  without scrolling, so a card coming into view does not make the dashboard
  jump. Pause and Resume swap the paused bar and the toolbar in one layout
  and in the same row, so Resume takes the place of Pause, Close appears at
  the same height as Resume and the page stays where it is. The focus move
  after Stop in the paused bar no longer scrolls the page up to the snapshot.
  The page can still move when it gets shorter, for example when the paused
  bar goes away near the end of the page.

### Evidence and limits

Playwright covers a 360 px card with the four controls in one toolbar row
below the video, and a card resized between 320, 499, 500, 900 and 1200 px
while live with every control below the video and the same session and
focus, then the paused bar below the snapshot at 320, 499, 500 and 900 px.
An autostart card taller than the window starts with focus on Close below
the fold and the page still at the top, and a start with Enter or a tap
scrolls less than 100 px to show Close. On a 780 by 360 window with content
below the card, Pause and Resume keep the page and the height of the buttons
within 1 px, Resume activated below the fold scrolls by the least amount that
shows Close, and Stop in the paused bar leaves the page where it is. The
popup dialog keeps its bar above the video at 360 and 900 px. In Chromium the
inline live view below 500 px and the popup at every width are unchanged in
size and position from 0.8.35, and the paused bar below 500 px is 12 px
shorter. The reporter's dashboard has not confirmed this release yet.

### Upgrade and rollback

Integration-only release, the bridge stays at 0.8.28. Update the integration
to 0.8.36 in HACS, restart Home Assistant and refresh the dashboard. In the
companion app close and reopen the app if the card still shows the controls
on the video. To roll back, restore integration 0.8.35 from your backup and
reload the dashboard.

## 0.8.35 - 2026-09-25

### A live start without video says how far it got

- Bridge 0.8.28 includes client 0.21.0 and adds a `start` object to every
  live video row in the diagnostics download: when the camera's P2P session
  was ready, when START went out, when the station answered it and with which
  return code, when the P2P library gave the stream up without media, and when
  the stream's metadata arrived. The three T8425 starts on #94 that got no
  stream could not say whether the HomeBase refused START, accepted it and
  sent nothing, or never answered. Refs #94 and
  keesmod/eufy-mega-client#187.
- Integration 0.8.35 keeps these fields in the download, and its assessment
  gains a `live_start` finding for a finished session without P2P video that
  names the furthest stage.
- Client 0.21.0 also carries client 0.19.0 and 0.20.0, which change only the
  mower side. Live media, the fallback timing, the encoder and the card are
  unchanged apart from the card's version.

### Upgrade and rollback

Update the bridge add-on or Docker image to 0.8.28 and the integration to
0.8.35 in HACS, restart Home Assistant and refresh the dashboard. To roll
back, restore bridge 0.8.27 and integration 0.8.34 from your backups.
Integration 0.8.34 also works with bridge 0.8.28 but leaves the `start` fields
out of the download.

## 0.8.34 - 2026-09-24

### Live video keeps running when a camera changes its frame size mid-stream

- Bridge 0.8.27 stamps the live encoder's frames with the wall clock since the
  bridge started the encoder process instead of FFmpeg's `RTCSTART`. FFmpeg
  sets `RTCSTART` again whenever it rebuilds its filter graph, which it does
  when a decoded frame's size or pixel format changes mid-stream. The stamps
  then restarted near zero and the video sync dropped every frame until they
  caught up, which took as long as the stream had run before, so the card
  switched to the JPEG fallback after 6 s. The diagnostics download on #94
  showed this on a T8425 at 47 s: FFmpeg's frame count stood still while its
  drop count rose. Refs #94, #122.
- The encoder keeps one output size and pixel format across such a change.
  The other encoder arguments, the fallback timing, the JPEG path and the
  diagnostics fields are unchanged. The integration and the card only change
  their version.
- Tests feed a stream that changes its frame size mid-stream in real time
  through the live encoder, with the FFmpeg of the test runner and, in the
  container smoke test, with the Debian Bookworm FFmpeg 5.1 of the bridge
  images. The fix is not yet confirmed on the reporter's T8425.

### Upgrade and rollback

Update the bridge add-on or Docker image to 0.8.27 and the integration to
0.8.34 in HACS, restart Home Assistant and refresh the dashboard. To roll
back, restore bridge 0.8.26 and integration 0.8.33 from your backups.
Integration 0.8.33 also works with bridge 0.8.27.

## 0.8.33 - 2026-09-23

### A Video Doorbell C30 reported with device type 96 is discovered

- Bridge 0.8.26 includes client 0.18.1. Discovery now admits a C30 that Eufy
  reports as model `T8224` with device type `96`, the pair in the discovery
  report on #40. It gets the same battery doorbell handling, HomeBase 3
  topology and snapshot, live and recording policy as a C30 with type `95`.
  Earlier bridges rejected it with
  `Eufy backend: unsupported_device device_model=T8224 device_type=96`. Only
  this exact pair is added, and every other unsupported pair is still
  rejected. Refs #40, keesmod/eufy-mega-client#183.
- The pair is a reported inventory value, not independently reproduced, and
  no C30 was tested with this release. Discovery, state, events and media of
  the reported C30 still need the reporter's confirmation.
- Nothing else changes: client 0.15.0 to 0.18.0 only add mower modules, and
  the camera modules, camera identifiers and persisted sessions are the same.
  The integration and the card only change their version.

### Upgrade and rollback

Update the bridge add-on to 0.8.26 and the integration to 0.8.33 in HACS,
restart Home Assistant and refresh the dashboard. To roll back, restore bridge
0.8.25 and integration 0.8.32 from your backups. Integration 0.8.32 also works
with bridge 0.8.26.

## 0.8.32 - 2026-09-23

### The diagnostics download names the stage inside FFmpeg where the live encoder stopped

- Bridge 0.8.25 starts the live encoder with `-progress pipe:3 -stats_period 1`
  and reads FFmpeg's progress blocks from that fourth pipe, which it always
  drains. The `encoder` object of the `support.live_video` row gains the
  counters of the latest block: `frames` (with the FFmpeg 5.1 of the bridge
  images, the frames the video sync handed to the encoder), `dropped` and
  `duplicated` (the sync's drops and duplicates), and `out_time_ms` and
  `bytes` (the muxer's output time and bytes). `last_progress_ms` dates that
  block, `last_progress_age_ms` is frozen at the session's end like the ages
  of the three points, and `last_frame_ms` and `last_drop_ms` date the blocks
  in which `frames` and `dropped` last rose. `stderr_chunks` counts the
  encoder's stderr data events. Whole numbers of five FFmpeg keys only,
  capped, and no FFmpeg text, URLs or serials.
- The integration projects the new fields with the existing allowlist and
  bounds. When the encoder output stopped while the input flowed and FFmpeg
  kept reporting, the `video_stall` finding names the stage inside FFmpeg:
  `frames` still rising means the encoder or the muxer emitted nothing,
  `dropped` rising while `frames` stopped means the video sync dropped the
  frames, and neither rising means the decoder delivered no frames.
  Otherwise the finding is unchanged.
- Why: the first bridge video row of a fallback, from the tester of #94 on
  2026-09-23 with NVIDIA transcoding, placed the stall inside the live
  encoder process, which read its input for 21 s while it emitted nothing and
  stayed silent on stderr at error level. The next download says whether the
  decoder, the sync or the encoder stopped. Refs #116, #94.
- Nothing else changes: media flow, the fallback timing, every other encoder
  argument, the JPEG path, the card and every existing download field are the
  same.

### Upgrade and rollback

Update the integration to 0.8.32 in HACS and the bridge add-on to 0.8.25,
restart Home Assistant and refresh the dashboard. To roll back, restore
integration 0.8.31 and bridge 0.8.24 from your backups. A 0.8.32 integration
with a 0.8.24 bridge still works, and its `live_video` rows carry no progress
counters.

## 0.8.31 - 2026-09-22

### The diagnostics download locates where a stalled live video stopped

- Bridge 0.8.24 adds `support.live_video` to its support report: one row per
  live session with its own `attempt` and the audio row's attempt as
  `audio_attempt`, so a download shows the bridge's video row, its audio row
  and HA's `live_playback` row of the same attempt side by side. The row
  counts chunks and bytes with first and last data times, the last data age
  and the largest gap for the P2P video input, the live encoder's MPEG-TS
  output and the JPEG frames, records the encoder mode (`software` or
  `nvidia`) with its exits and the hardware to software transition, and
  counts the grant's video and audio readers as attached, destroyed for
  backpressure, closed by the client and revoked, with the time of the last
  destroy. At the session's end each point's last data age is frozen, so it
  says how long before the end that point stopped. Fixed categories and
  bounded scalars only, no URLs, serials or encoder text. The row is kept
  like the audio row, the bridge's configured cap plus fifteen minutes, and
  a bridge restart drops it.
- The integration projects that row with an allowlist and bounds like
  `live_audio`, and the download's `assessment` gains a `video_stall` finding
  when the P2P input, the encoder output or the JPEG frames stopped more
  than 6 s before the session's end, naming each point with its age so the
  earliest one places the stall.
- When the bridge's `fallback` message arrives, the integration samples the
  go2rtc counters of the video stream and the late audio stream before it
  switches the viewer to JPEG and stores the row with trigger `fallback`.
  Before this, that sample was skipped because the switch came first, so a
  bridge-initiated fallback had no go2rtc row. The sample keeps its one
  second timeouts and a failure never delays the switch.
- Why: the 2026-09-22 attempts on #94 reproduced `fallback_playback_timeout`
  with the browser's hardware decoding off and NVIDIA transcoding, and with
  hardware decoding on and software transcoding. In the attempt that fell
  back at 20.8 s the download proved that the video stopped before go2rtc's
  WebRTC sender, and could not say whether the P2P video, the bridge's
  encoder, the grant's HTTP reader or go2rtc's input stopped. The next
  download can. Refs #112, #94.
- Nothing else changes: the fallback timing, the encoder arguments, the
  go2rtc registration, the card and every existing download field are the
  same.

### Upgrade and rollback

Update the integration to 0.8.31 in HACS and the bridge add-on to 0.8.24,
restart Home Assistant and refresh the dashboard. To roll back, restore
integration 0.8.30 and bridge 0.8.23 from your backups. A 0.8.31 integration
with a 0.8.23 bridge still works and shows no `live_video` rows.

## 0.8.30 - 2026-09-22

### The card shows each camera's battery level

- The camera entity gains a `battery` attribute: the percentage the bridge
  inventory reports and the camera's battery sensor already shows. A camera
  without a battery value gets no attribute, as it gets no battery sensor.
- The viewer card shows that level next to the camera name: a battery icon
  whose fill width follows the percentage and whose colour follows the theme,
  green from 50 percent, amber from 20 to 49 and red below 20, with the
  percentage as text and an accessible label in English or Dutch. The card
  hides it for a camera without a value and while the camera is unavailable.
  The display reads the pushed state only, it starts no live session and
  fetches nothing.
- Why: the maintainer asked on 2026-09-22 to see the battery per camera on the
  card without opening the device page. Refs #110.
- Nothing else changes: the live view, the recordings, the events card and the
  bridge are the same.

### Upgrade and rollback

Update the integration to 0.8.30 in HACS, restart Home Assistant and refresh
the dashboard. The bridge stays at 0.8.23. To roll back, restore integration
0.8.29 from your backup.

## 0.8.29 - 2026-09-21

### Live playback samples name the browser's decoder and count its freezes

- The card's browser samples in the integration's diagnostics download add the
  browser's decoder name (`video_decoder`, a product string such as `FFmpeg`
  or `ExternalDecoder`, kept only within 64 characters of a fixed character
  set), whether the browser calls that decoder power efficient
  (`video_decoder_power_efficient`), and the inbound video counters
  `freezeCount`, `totalFreezesDuration`, `pauseCount`, `totalPausesDuration`,
  `totalDecodeTime`, `totalProcessingDelay`,
  `framesAssembledFromMultiplePackets` and `totalAssemblyTime` as
  `video_freezes`, `video_freeze_ms`, `video_pauses`, `video_pause_ms`,
  `video_decode_ms`, `video_processing_ms`, `video_assembled` and
  `video_assembly_ms`, durations in whole milliseconds. Missing values stay
  absent and the integration accepts only these bounded scalars, as for the
  existing fields. `video_decoder` and `video_decoder_power_efficient` stay
  absent on a dashboard page: the WebRTC statistics specification withholds
  both unless the page itself has captured a microphone or camera, verified
  on the maintainer's bench with Chromium 152. See
  [live diagnostics](docs/LIVE_DIAGNOSTICS.md).
- Why: the 2026-09-20 run on #94 (integration 0.8.28, bridge 0.8.23, NVIDIA
  T600, Google Chrome 153 on Windows) reached the 1800-second cap but dropped
  to the JPEG fallback at 54.6 s with zero packet loss, a jitter-buffer wait
  per frame growing from 54 ms to 914 ms, 68 dropped frames and eight PLI.
  The four samples could not tell an H.264 stream the browser's decoder
  rejects from decoding or timing on the PC. With these fields the next
  download can. Refs #94, #106.
- Nothing else changes: the five sample stages, the last eight attempts, the
  retention window, the bridge and the card's playback behaviour are the same.

### Upgrade and rollback

Update the integration to 0.8.29 in HACS, restart Home Assistant and refresh
the dashboard. The bridge stays at 0.8.23. To roll back, restore integration
0.8.28 from your backup.

## 0.8.28 - 2026-09-20

### Diagnostics keep a long live session, and the mains cap is verified

- Fix: the integration's diagnostics download dropped a live playback report
  fifteen minutes after its attempt started, and the bridge left a live audio
  row out of its support report after the same fifteen minutes. With
  `live_max_seconds_mains` at 1800 a session that ran to its cap was already
  gone from a download taken right after its end, which the reporter of #94
  found on 2026-09-19: `live_playback: []` and
  `recent_live_playback_not_recorded` after a 30-minute session. Bridge 0.8.23
  and integration 0.8.28 keep both for the bridge's configured cap plus
  fifteen minutes, so a session at any cap stays downloadable for fifteen
  minutes after its end. The last eight attempts, the 3600000 ms elapsed time
  bounds and everything else in the download are unchanged. A bridge before
  0.8.22 that reports no cap keeps 120 seconds plus fifteen minutes.
- The 0.8.26 candidate option `live_max_seconds_mains` is verified on mains
  powered hardware. On 2026-09-19 the reporter of #94 ran one mains powered
  T8425 (firmware 1.6.4.6, no battery value) behind a T8030 HomeBase 3
  (firmware 3.8.5.2) with an NVIDIA T600, bridge 0.8.22, integration 0.8.27
  and `live_max_seconds_mains: 1800` for one session: it ended at 1800.156 s
  with `camera_timeout`, `stream_failure` and `session_end`, the stop was
  device-confirmed 27 ms after the stop request without a retry, two guard
  mode changes from Home Assistant applied during the session without
  interrupting it, no recovery and nothing quarantined, and the GPU returned
  to idle. The session switched to the JPEG fallback at 18.4 s
  (`fallback_playback_timeout`), so a long WebRTC session on that hardware is
  not verified. See [compatibility](docs/COMPATIBILITY.md).
- Nothing else changes: the caps, the 10-second lease, the 20-second startup
  timeout, the card's no-restart rule and the per-HomeBase limit are the same.

### Upgrade and rollback

Update the bridge to 0.8.23 and the integration to 0.8.28, restart Home
Assistant and refresh the dashboard. The bridge's private data is compatible in
both directions. To roll back, restore bridge 0.8.22 and integration 0.8.27
from your backup.

## 0.8.27 - 2026-09-19

### The live relay follows the bridge's session cap

- Fix: the integration's live relay ended every session after 125 seconds, on
  the JPEG path and on the WebRTC path, whatever the bridge's cap for the
  camera. With `live_max_seconds_mains` set, a camera without a battery value
  lost its Home Assistant viewer at about 125 seconds, the bridge saw
  `no_viewers` and ended the session long before its own bound. Reported on
  #94 with bridge 0.8.22 and integration 0.8.26 on a mains powered T8425
  behind a HomeBase 3: two attempts ended at 125.0 seconds with `no_viewers`
  and `session_end`, without `camera_timeout`, while `/v1/state` reported
  `live_max_seconds_mains: 1800`.
- The relay now bounds itself by the bridge's cap for that camera plus five
  seconds: 125 seconds for a battery camera or a camera missing from the
  inventory, and `live_max_seconds_mains` plus five seconds for a camera the
  inventory reports without a battery value. The state's
  `live_max_seconds_mains` is validated at the boundary as a whole number from
  120 to 3600, and a bridge before 0.8.22 that does not report it keeps 120.
  The bridge still ends the session at its cap and closes the socket. HA's
  bound only catches a bridge socket that neither sends nor closes.
- Nothing else changes: the 10-second lease, the 20-second startup timeout,
  the card's no-restart rule and the per-HomeBase limit are unchanged. The
  bridge stays at 0.8.22.

### Upgrade and rollback

Update the integration to 0.8.27 and restart Home Assistant, then refresh the
dashboard. The bridge stays at 0.8.22. To roll back, restore integration
0.8.26 from your backup.

## 0.8.26 - 2026-09-19

### Longer live sessions for mains powered cameras, candidate

- Bridge 0.8.22 includes client 0.14.0. Its per-start live bound and its free
  primary session are the library side of
  [keesmod/eufy-mega-client#163](https://github.com/keesmod/eufy-mega-client/issues/163).
- Add the optional app option `live_max_seconds_mains` (Docker:
  `EUFY_LIVE_MAX_SECONDS_MAINS`, a whole number of seconds from 120 to 3600,
  default 120). It raises the absolute live session cap only for cameras the
  inventory reports without a battery value. Battery cameras keep the
  120-second cap in every case, and the default keeps 120 seconds for every
  camera. The bridge passes the bound per start to the client, the client
  sends the STOP at the bound, and the bridge's own watchdog uses the same
  value, so a session still ends without any help from the viewer.
- With `live_max_streams_per_station` above 1 the client now keeps the
  HomeBase's primary session free, so guard mode commands and snapshots work
  while cameras are live. Recording playback still waits until no camera on
  that HomeBase is live.
- The 10-second viewer lease, the 20-second startup timeout and the card's
  no-restart rule are unchanged. A session that reaches the cap still ends
  with `camera_timeout`, `stream_failure` and `session_end` and needs a new
  start. The bridge's state reports the configured value as
  `live_max_seconds_mains`.
- Diagnostics: the bridge's live audio report and the integration's filter
  keep elapsed times up to 3600000 ms, so long sessions keep their rows.

### Evidence and limits

The library evidence is one T8030 HomeBase 3 (firmware 3.8.7.4) with one
eufyCam 3 on the maintainer's bench: a ten-minute stream at a flat rate,
control on the idle primary session while a stream ran on its own session,
and a 180-second stream ended by the client's bound with a device-confirmed
STOP, see the
[library research note](https://github.com/keesmod/eufy-mega-client/blob/main/docs/research/LIVE_BOUND_2026-09-19.md).
The bridge's hub and backend tests cover the per-camera cap, the pass-through
of the bound and the battery rule. No mains powered camera has run through
this bridge with a raised cap yet. That observation belongs to the reporter
of #94 with three mains powered cameras: one camera for 30 to 60 minutes with
`diagnostics: true`, the `stream_metrics` from `/v1/state` before and after,
the integration's diagnostics download, GPU load and the final confirmed
stop. Until then the option is a candidate and installations that leave it
unset are unchanged.

### Upgrade and rollback

Update the bridge to 0.8.22 and the integration to 0.8.26, restart Home
Assistant and refresh the dashboard. Leave `live_max_seconds_mains` unset
unless you take part in the observation. To roll back, restore bridge 0.8.21
and integration 0.8.25 from your backup. The bridge's private data is
compatible in both directions.

## 0.8.25 - 2026-09-19

### Autostart cards stay live while scrolled out of view

- An inline card with `live_autostart: true` keeps its live session while it
  is scrolled out of view and keeps acknowledging frames, so scrolling a long
  dashboard no longer stops and restarts its cameras. A card that scrolls back
  into view is still the same session. Reported on #94 from a mobile
  dashboard with three autostart cards in one column, where every scroll cost
  a device-confirmed stop and a fresh start of several seconds.
- Autostart still starts when the card first comes into view after the view
  opens, so a card below the fold starts the first time you scroll to it, and
  again when the page becomes visible again. Scrolling back into view is no
  longer a trigger of its own. The two-minute cap still ends the session, and
  the session still stops on close, pause, stop, page hide, navigation, card
  removal and disconnection, each confirmed by the bridge. A session that
  ended never restarts by itself, scrolling included, and opening the view
  again applies autostart again. The focus return to the snapshot after a stop
  no longer scrolls the page, so a session that ends while its card is out of
  view leaves the page where it is.
- Inline cards without autostart and the popup keep stopping when the card
  scrolls out of view. No new card option, the editor is unchanged. The bridge
  stays at 0.8.21.

### Evidence and limits

Playwright covers an autostart card that keeps its session and its
acknowledgement counter while scrolled out of view on the JPEG path and on the
WebRTC tick path, no second session when it scrolls back, the cap ending an
out-of-view session without a restart on scroll, a manual inline card and the
popup still stopping on scroll out, an autostart card scrolled out of view
still stopping on hidden page, pagehide, disconnection and removal with the
next trigger waiting until it is in view, and three autostart cards in one
narrow column that stay live while the page scrolls between them and all stop
when the page hides or the cards are removed. In headless Chromium both
acknowledgement paths ran at the same rate for a video element 4000 pixels
below the viewport as in view. The reporter's mobile dashboard has not
confirmed this release yet.

### Upgrade and rollback

Integration-only release, the bridge stays at 0.8.21. Update the integration,
restart Home Assistant and refresh the dashboard. Coming from 0.8.23, this
update also brings the 0.8.24 toolbar below the video on narrow cards. To roll
back, restore the previous integration version from your backup and reload the
dashboard.

## 0.8.24 - 2026-09-19

### Inline live controls below the video on narrow cards

- On a card narrower than 500 px, about a phone in portrait, the inline live
  controls (pause, stop, sound and close) leave the overlay on the video for a
  compact toolbar directly below it, so the camera image stays fully visible.
  The paused bar with resume and stop sits below the snapshot in the same way.
  The card's own width decides through a CSS container query, not the screen,
  so a narrow card in a multi-column desktop view gets the toolbar as well and
  a wide card on a tablet keeps the overlay. Cards of 500 px and wider are
  unchanged.
- Layout only. The controls and their order, focus handling, status messages,
  the popup dialog mode and the card editor are unchanged. There is no new
  card option.

### Evidence and limits

Playwright covers a 360 px card with the four controls in one toolbar row
below the video, the paused bar below the snapshot after a pause, the toolbar
gone when the view closes, a 700 px card with the overlay on the video and
the paused bar on the snapshot, the threshold at 499 and 500 px while a
session stays open without a new lease, and the popup dialog at a narrow
width. The change answers a report from a phone dashboard, and confirmation
on that phone is still open.

### Upgrade and rollback

Integration-only release, the bridge stays at 0.8.21. Update the integration,
restart Home Assistant and refresh the dashboard. In the companion app close
and reopen the app if the card still shows the overlay on a narrow card. To
roll back, restore the previous integration version from your backup and
reload the dashboard.

## 0.8.23 - 2026-09-18

### Optional automatic live start for inline cards

- New card option `live_autostart: true`, default false and only valid with
  `live_mode: inline`. The card starts its live view without a tap when it is
  attached in view: when the view opens, when the card scrolls back into view
  or when the page becomes visible again. Each trigger starts at most one
  session per card, up to the bridge's `live_max_streams_per_station`. A card
  refused at the limit shows "Another camera on this HomeBase is live",
  returns to its snapshot and does not retry by itself. The visual card editor
  offers the switch for inline cards.
- Pause, resume and stop per card, next to the existing sound and close
  controls. Pause releases the lease and shows the snapshot with a resume
  control, which starts a new session with a fresh lease. Stop ends the session
  and disables autostart for that card until the view is opened again.
- Every rule holds: one lease per card with the frame acknowledgement loop,
  the two-minute cap, and a device-confirmed stop on close, page hide,
  navigation, card removal, disconnection or when the card scrolls out of
  view. When the bridge ends a session, at the cap or for any other reason,
  the card returns to its snapshot and does not restart by itself. Opening the
  view again applies autostart again. There is no retry loop and no
  keep-alive. The default stays the explicit start by tap.

### Evidence and limits

Playwright covers autostart on attach, on the page becoming visible again and
on the card scrolling back into view, no autostart in the dialog mode or
without the option, pause, resume, stop from the live bar and from the paused
bar, three autostart cards with the third refused at the limit and no retry,
an end at the cap without restart, cleanup on hidden page, pagehide,
disconnection and removal, the card editor, and real decoded WebRTC media that
starts inline without a tap. On 2026-09-18 four autostart cards on one
HomeBase 3 (T8030, firmware 3.8.7.4) with the bridge option at 3 started
without a tap in Chromium in two rounds: two cameras played through WebRTC
with late audio each time, the fourth card was refused at the limit and did
not retry, pause, resume and stop worked per card, a session that reached the
two-minute cap stayed on its snapshot, and leaving the view stopped the
remaining session with a device-confirmed stop, see
[the test record](docs/CONCURRENT_LIVE_2026-09-18.md#four-autostart-cards-in-a-browser-2026-09-18).
The third admitted camera timed out at startup in both rounds. A supervised
bridge-path test on 2026-09-19 then delivered three concurrent eufyCam 3 through
the bridge's own viewer path with device-confirmed stops and no startup timeout,
which locates that third-stream browser timeout on the WebRTC consumer path and
host CPU headroom rather than the HomeBase or the bridge, see
[the 2026-09-19 record](docs/CONCURRENT_LIVE_2026-09-19.md). Three concurrent
WebRTC streams in a browser on a software-transcoding host remain unverified.

### Upgrade and rollback

Integration-only release, the bridge stays at 0.8.21. Update the integration,
restart Home Assistant and refresh the dashboard. If you update from 0.8.20,
the 0.8.22 and 0.8.21 notes below apply as well. Existing cards keep their
behaviour until you set `live_autostart: true`. To roll back, restore the
previous integration version from your backup and reload the dashboard.

## 0.8.22 - 2026-09-18

### Inline live mode for several live cameras

- New card option `live_mode: inline` plays the live view inside the card
  instead of the modal dialog, so a dashboard can show several cameras live at
  the same time, up to the bridge's `live_max_streams_per_station` limit per
  HomeBase. The default `dialog` keeps today's popup. The visual card editor
  offers the choice.
- An inline card keeps every rule of the dialog: one tap starts one lease with
  the frame acknowledgement loop, the two-minute cap, WebRTC with the JPEG
  fallback, the sound toggle and late audio, the diagnostics download, and a
  stop on close, Escape, page hide, navigation, card removal, disconnection or
  when the card scrolls out of view. Its close and sound controls sit on the
  video and status messages appear below the camera name. A card refused by
  the HomeBase limit shows "Another camera on this HomeBase is live" there and
  returns to its snapshot.
- Nothing starts automatically. Each live camera still needs its own tap.

### Evidence and limits

Playwright covers the inline mode with simulated Home Assistant dispatch: start
on both transports, frame acknowledgements, stop on close, Escape, hidden page,
page hide, disconnection and removal, three inline cards on one page with two
live at once and the third refused at the limit, the card editor, and real
decoded WebRTC media plus the JPEG fallback inside the card. On 2026-09-18 two inline
cards played two eufyCam 3 (T8160) cameras of one HomeBase 3 (T8030, firmware
3.8.7.4) at the same time in Chromium through WebRTC with late audio, with
bridge 0.8.21 and the option at 4, and both closed with device-confirmed stops,
see [the test record](docs/CONCURRENT_LIVE_2026-09-18.md#two-inline-cards-in-a-browser-2026-09-18).
Three or four concurrent streams remain unverified.

### Upgrade and rollback

Integration-only release, the bridge stays at 0.8.21. Update the integration,
restart Home Assistant and refresh the dashboard. If you update from 0.8.20,
the 0.8.21 notes below apply as well. Existing cards keep the dialog until you
set `live_mode: inline`. To roll back, restore the previous integration version
from your backup and reload the dashboard.

## 0.8.21 - 2026-09-18

### Configurable live cameras per HomeBase

- The bridge includes client 0.13.0, whose `maxLiveStreamsPerStation` option
  lets further cameras on one HomeBase stream live at the same time, each on
  its own P2P session with its own confirmed STOP and 120-second cap. The new
  optional app option `live_max_streams_per_station` (Docker
  `EUFY_LIVE_MAX_STREAMS_PER_STATION`, a whole number from 1 to 4) sets that
  limit. The default 1 keeps today's one live camera per HomeBase.
- The bridge admits a camera while the number of live and starting cameras on
  its HomeBase is below the limit instead of refusing every second camera on
  the same HomeBase. The 8 camera slots, 4 viewers per camera, the recording
  interlock and stop recovery are unchanged. `/v1/state` reports the configured
  limit as `live_max_streams_per_station`.
- A viewer refused by that limit is closed with code 4013 instead of the
  generic 1013. Home Assistant forwards it as `reason: "station_limit"` on the
  `ended` event, and the card says that another camera on this HomeBase is live
  (English and Dutch) instead of "Live view ended".
- Client 0.13.0 also renews the cloud identity after Mega result code 4404 or
  4416, which the bridge hit once as HTTP 463 during the library research.

### Evidence and limits

Two concurrent streams are verified by the library on one HomeBase 3 (T8030,
firmware 3.8.7.4) with two eufyCam 3 (T8160) cameras at full rate with audio.
The bridge path was exercised on the maintainer's HomeBase 3 with two eufyCam 3
on 2026-09-18 (see [that record](docs/CONCURRENT_LIVE_2026-09-18.md)) and with
three eufyCam 3 on 2026-09-19, all reaching the first frame with device-confirmed
stops and no startup timeout (see
[the 2026-09-19 record](docs/CONCURRENT_LIVE_2026-09-19.md)). Software
transcoding of three streams saturated a 2-core host, so the sustainable value
depends on host CPU and transport. Four streams, and three concurrent WebRTC
streams in a browser on a software-transcoding host, remain unverified. The card still opens
one modal live view per card, so a grid of simultaneous live cards needs the
inline live mode that follows [issue #84](https://github.com/keesmod/ha-eufy-cam/issues/84).
Each concurrent camera adds an encoder pipeline on the bridge host (two FFmpeg
processes, one go2rtc stream per viewer, one NVENC session when accelerated).

### Upgrade and rollback

Update both the integration and bridge to 0.8.21, restart Home Assistant and
refresh the dashboard. The limit stays 1 unless you set the option. Back up
both components with their private data first and restore the previous versions
together to roll back. Bridge 0.8.21 with integration 0.8.20 keeps working; the
refused-camera message then stays generic.

## 0.8.20 - 2026-09-15

### Live audio whenever the camera starts sending it

The reporter's T8134 cameras behind a HomeBase 3 send their first AAC frame
four to five seconds after the first video frame on a cold start and 40 ms
after it on a warm start. The library's three-second startup deadline excluded
audio on every cold start, and admitted audio was muxed into the video encoder,
which emits nothing until its first audio frame and holds video for the length
of every audio gap.

- The bridge never muxes audio into the live video stream. Every session starts
  a video-only encoder and delivers AAC on the existing late-audio route as soon
  as its first complete frame arrives, whether that is 40 ms or 5 s after video.
  `ready` always reports `audio: false`; an audio transport error ends only the
  audio feed. The library's startup classification remains as observational
  `audio_supported`/`audio_absent` marks.
- Home Assistant never ends a live session for an `audio_ready` it cannot use
  (video setup failed or was downgraded, an older bridge reporting `audio: true`)
  or for a repeated announcement. Older bridges keep their joint audio source.
- Diagnostics record the late-audio stage and end reason per attempt, include
  the late-audio go2rtc stream's counters in relay rows, report the card's audio
  peer state, and assess the new states. `audio_expected` now only mirrors the
  bridge's initial classification.

### Bounded live encoder and arrival-time stamps

- The live WebRTC encoder is capped with a VBV window (default `4M`, add-on
  option `live_max_bitrate`, Docker `EUFY_LIVE_MAX_BITRATE`). The reporter's
  relay counters measured 9.8-12.4 Mbit/s unbounded output with 300-500 KB
  keyframe bursts alongside stalled decoding. Those counters alone do not
  establish the cause of the reporter's playback failure.
- Frames are stamped with their arrival time instead of being counted at the
  camera's announced rate. A HomeBase delivering 16-17.5 frames per second
  against a 15 fps header made the browser's jitter-buffer delay grow steadily.

### Upgrade and rollback

Update both the integration and bridge to 0.8.20, restart Home Assistant and
refresh the dashboard. Back up both components with their private data first
and restore the previous versions together to roll back. The bundled client
remains 0.12.3. The card makes one late-audio attempt per live view; close and
reopen the view to retry audio.

### Scope and known limits

References #10. Bridge tests cover the arrival-time stamping and the bounded
output with real FFmpeg; HA and card tests cover warm and cold audio ordering.
Exact T8134 hardware acceptance still needs the reporter's local retest. A
dashboard proxy does not carry the separate WebRTC media connection. When no
direct media route is available, use reachable TURN or routed LAN/VPN access.

## 0.8.19 - 2026-09-15

### More useful playback reports

One diagnostic download now connects the stages of a failed recording, reducing
the separate logs and repeat attempts needed to investigate an issue.

- Extend the existing diagnostic download with recent recording preparation,
  processing, limits, cancellation and cleanup. Anonymous attempt references
  connect bridge and Home Assistant observations. Reports retain at most eight
  attempts for fifteen minutes and exclude identifiers, addresses and media.
- Add a bounded diagnostic download action at relevant player errors, using
  Home Assistant's existing administrator permissions. Report loaded card and
  component versions, observed failure stages and missing or stale evidence.

### Stronger regression checks

- Cover concurrent recording readers, close/expiry/unload, interrupted reads
  and reopening after fallback or closure before late audio. The new scenarios
  preserve existing playback behavior and improve the synthetic test fixture.

### Simpler device maintenance

- Include client 0.12.3 with one registry for all 51 existing device profiles
  and separate snapshot, live and recording policies. Existing model/type,
  owner and firmware admission remains unchanged. Preserve the released
  late-audio and Home Assistant STUN/TURN behavior.
- Give maintainers one place to add and review profiles within supported device
  families, backed by automatic admission checks. A new protocol or an untested
  model still needs its own implementation and hardware evidence.

### Upgrade and rollback

Update both the integration and bridge to 0.8.19, restart Home Assistant and
refresh the dashboard. Back up the integration and bridge with its private
data first. Restore their previous files or versions together to roll back,
preserving credentials and entity identities. Older bridges remain usable but
cannot provide the added recording evidence. Download diagnostics before a
restart or the fifteen-minute retention window expires.

### Scope and known limits

References #76, #77 and #78, with
[client #139](https://github.com/keesmod/eufy-mega-client/issues/139).
This batch adds no model or hardware support claim. Exact external T8134
acceptance remains in #10. The known Home Assistant cryptography dependency
limitation remains open in #30. No security finding is suppressed or fixed by
this update.

## 0.8.18 - 2026-09-15

- Use Home Assistant's configured and provider-supplied STUN/TURN servers for
  both live video and optional late audio, on the browser and managed go2rtc.
  Resolve fresh credentials for each peer without changing HA network settings.
- Send ICE candidates as they arrive so an unreachable STUN server does not
  prevent direct local playback. Existing startup, fallback and cleanup limits
  still apply. If HA cannot supply ICE configuration, try direct connectivity.
- Add bounded candidate-type, pair-state and ICE-error counters for failed
  connection attempts. Diagnostics exclude addresses, candidate strings, SDP,
  server URLs and relay credentials.

Back up Home Assistant, update the HACS integration, restart Home Assistant and
refresh the dashboard. Bridge 0.8.17 and client 0.12.2 remain unchanged. Restore
the backed-up integration to roll back.
References #10. The reporter's external T8134 route still needs acceptance.
A dashboard proxy alone does not provide a WebRTC media relay.
See the [validation method and acceptance boundary](docs/WEBRTC_ICE.md).

## 0.8.17 - 2026-09-15

- Add AAC audio that arrives after a live session started without an audio track.
  Video keeps its existing encoder and connection. The same camera owner supplies
  complete AAC frames to an optional audio-only WebRTC connection. Failed audio
  setup does not interrupt video or extend the camera's viewing deadline.
- Keep initial A/V, video-only cameras, JPEG fallback, recordings, GPU settings,
  credentials and entity identities unchanged. Audio readers use the existing
  per-viewer grant and close with their owner. Older cards and integrations do
  not receive the new audio control events unless they opt in.
- Record `audio_late` when actual AAC becomes available, with browser audio
  negotiation and decoding counters covering the added track. No audio payload
  is retained in diagnostics.

Update both the bridge and HACS integration to 0.8.17, reload the integration or
restart Home Assistant, and refresh the dashboard. The published client remains
0.12.2. Back up both components before installation. Restore their previous files
or versions together to roll back, preserving app data and login state.

References #10. Tests confirm late-audio delivery and continued video. Exact
T8134 reporter acceptance remains pending. This release makes the change
available for testing. An external WebRTC connection that cannot establish ICE
still uses video-only JPEG fallback and needs reachable media connectivity.

## 0.8.16 - 2026-09-15

- Handle recording playback client disconnects without logging a traceback when
  the player closes or seeks. Header, chunk and final writes release their reader
  ownership, preserving later range requests and the existing session lifetime.
  Other I/O errors, timeouts and task cancellation still propagate. Addresses #69.

- Preserve `device_request_timeout` and future machine error codes in normal
  startup logs and Home Assistant diagnostic downloads without maintaining a
  separate list of accepted codes in each component. Both validate the complete
  code format and length. Raw error messages and unknown report fields remain
  excluded.
- Correct the HAOS app setup URL to `http://127.0.0.1:8063` in its README.

Update both the HACS integration and HAOS bridge app to 0.8.16. The bundled
client remains 0.12.2. Older integrations may omit newly preserved codes in the
download, so use the updated bridge's startup logs until both are updated.
Back up both components before installation. Restore their previous versions
and preserve app data, credentials and identities to roll back.

This improves diagnosis of issue #66. It does not fix the reported HomeBase
connection timeout or add T84A1 standalone media support. Software tests exercise
the diagnostic failure/download paths and real HTTP playback disconnects, with
reader and storage cleanup. Device commands and encoding remain unchanged.
Reporter verification of closing playback on their installation remains pending.

## 0.8.15 - 2026-09-14

- Replace whole-recording RAM buffers with private temporary files and bounded
  file transfer. Valid H.264 output above 32 MiB can reach both recording cards.
  Native H.264 and HEVC remuxing preserves AAC, duration and byte-range seeking.
- Remove the recording-wide NVIDIA failure latch. One failed conversion may use
  software once, after confirmed process cleanup. The next request tries its
  configured encoder again. Storage limits and storage errors are not GPU faults.
- Apply an aggregate HA recording storage allowance, including unfinished
  preparation and readers closing after session expiry. Interrupted preparation,
  transfer and playback release their owned resources. Both cards explain when
  recording storage is unavailable.
- Keep issue #57 open in Validation. Synthetic FFmpeg and browser checks do not
  replace repeat testing of the failing recording on the reporter's T600.

Includes bridge 0.8.14, with unchanged client 0.12.2. Back up both components
before installing. Restore the previous integration and bridge together to roll
back, preserving credentials and identities.

## 0.8.14 - 2026-09-14

- Fix premature NVIDIA recording fallback by tracking encoded-frame progress.
  Healthy conversion can pass ten seconds while staying within the existing
  45-second total deadline. A ten-second stall still triggers bounded cleanup
  and one software attempt on the already downloaded recording.
- Always report bounded hardware failure categories, frame count, timeout scope
  and exit status. With `EUFY_DIAGNOSTICS=true`, an unclassified failure also
  includes a short scrubbed excerpt of the original FFmpeg error. Common secret,
  address and path patterns are removed. Review excerpts before sharing them.
- Preserve Auto / Native / H.264, media status, AAC audio, cancellation and
  the circuit breaker. Native remux, audio and seeking have reporter confirmation.
  The intermittent T600 failure still needs a repeat test with this correction.

Includes bridge 0.8.13. Back up both components before updating. Restore their
previous files to roll back, preserving data, credentials and entity identities.

## 0.8.13 - Internal candidate

- Fix premature NVIDIA recording fallback. Track encoded-frame progress instead
  of requiring the complete MP4 within ten seconds. Keep the 45-second total
  conversion deadline, ten-second stall timeout, single software fallback and
  confirmed process cleanup.
- Always log a bounded hardware failure warning with timeout scope, frame count,
  exit status and fixed FFmpeg error categories. Successful processing and
  circuit-breaker observations remain opt-in. Never emit raw FFmpeg output.
- Issue #57 remains in Validation for the reporter's intermittent T600 failure.
  A paced CPU FFmpeg regression reproduces the cutoff and verifies this fix.
  It does not establish the cause of every T600 failure.

Includes bridge 0.8.12. Back up both components before updating. Restore their
previous files to roll back, preserving bridge data and Home Assistant identities.

## 0.8.12 - 2026-09-14

- Add bounded live audio format, continuity and processing observations, linked
  to a later browser measurement in Home Assistant diagnostics. Include ADTS
  header facts, buffered audio, stream cleanup and negotiated audio details
  without storing audio payloads. Issue #10 awaits T8134 hardware validation.
- Add Auto / Native / H.264 to recording playback in both camera and events
  cards. Remember the choice in this browser and retain position and pause
  when changing it. Auto requests HEVC conversion when NVIDIA recording
  acceleration is configured or the browser lacks HEVC support.
- Display the actual per-recording remux, software or NVIDIA processing result,
  including software fallback. Older bridges retain browser-based selection
  and show processing as unknown. Explicit Native never silently transcodes.
- Includes bridge 0.8.11. After release, the reporter confirmed the Auto/UI
  NVIDIA route, playback and GPU cleanup on T600/T8030/T8425, plus a Live
  regression check. The reporter later confirmed Native, audio and seeking, but also reported
  intermittent NVIDIA fallback. An H.264 source remains untested by the reporter.
  See the [hardware validation record](docs/NVIDIA.md#auto-playback-validation-on-2026-09-14).
  Back up both components before installation and restore their previous files
  to roll back, preserving credentials and entity identities.

## 0.8.11 - 2026-09-14

- Restore the software live encoder defaults by removing the 4 Mbit/s target,
  maximum rate and 1 Mbit VBV limit introduced in the previous candidate.
  Bitrate was not established as the cause of issue #10 and the image-quality
  cost was not measured. Retain the added playback and audio diagnostics.
- Keep the existing NVIDIA settings, video dimensions, frame rate and audio
  conversion unchanged. Integration/card 0.8.11 accompanies bridge 0.8.10.

Issue #10 remains open. No T8134 fix or hardware acceptance is claimed. Back up
both components before updating and restore their previous files to roll back.

## 0.8.10 - Withdrawn candidate

- Bound software live H.264 output to a 4 Mbit/s target and maximum rate with
  a 1 Mbit VBV buffer. Retain H.265 decoding, the existing scale limit, AAC audio,
  encoder ownership and playback deadlines. High-complexity scenes may lose
  detail to keep the output within this budget.
- Include RTP loss, complete frames, NACK/PLI/FIR, jitter-buffer counters and
  negotiated audio presence in bounded playback diagnostics. Preserve absent
  values as unavailable, including absent audio counters.

Integration/card 0.8.10 and bridge 0.8.9 are unpublished candidates for issue #10.
The software cap was withdrawn in 0.8.11. Synthetic overload results did not
establish the reporter's root cause or justify the unmeasured quality cost. Late audio discovery and consumer track admission remain
separate from this video change. Back up both components before an update and
restore their previous files to roll back, preserving the existing data/token.

## 0.8.9 - 2026-09-14

- Add bounded live playback evidence to the integration diagnostic download.
  Record signaling, go2rtc codec packet counters, browser reception and decoding,
  presented frames and acknowledgements. Retain only fixed statuses and numbers,
  with no SDP, addresses, device identifiers or media.
- Compare successful playback with blocked ICE, a missing answer and stalled
  painting or ticks using real FFmpeg, go2rtc and Chromium. Cover video-only,
  silent, delayed and batched AAC input.

This is a diagnostic update for the unresolved T8134 live playback report #10.
It does not claim to fix or validate that camera's audio. The integration and
card change, while bridge 0.8.8 remains unchanged. When published, update the HACS
integration and restart HA, preserving the existing account and bridge data.
Back up the integration first and restore it to roll back.

## 0.8.8 - 2026-09-13

- Add separate Docker opt-in `EUFY_RECORDING_ACCELERATION=nvidia` for required
  HEVC-to-H.264 recording conversion. Keep native HEVC and H.264 remuxing and
  copied AAC audio. Software remains the default, including HAOS.
- Bound GPU conversion and retry once with software on the same downloaded
  bytes after confirmed process cleanup. Preserve cancellation, output limits
  and the overall deadline. Block conversion after unconfirmed cleanup.
- Add anonymous recording-route diagnostics and document the reported T600 live
  validation separately from pending NVIDIA recording validation.

Update integration and bridge when this version is published. Back up the
previous installation and preserve its token/data. Disable the new option and
recreate the container to return to software. Actual NVIDIA recording operation
requires a compatible GPU test before claiming hardware support.

## 0.8.7 - 2026-09-13

- Add experimental Docker opt-in NVIDIA live transcoding with
  `EUFY_LIVE_ACCELERATION=nvidia`. Software remains the default, including HAOS.
- Bound hardware startup to five seconds and 8 MiB of initial A/V. On a startup
  error, retry once with software inside the same camera session. Disable GPU
  attempts until bridge restart after a hardware failure. A later encoder failure
  ends the view safely, and the next view uses software.
- Add anonymous active-encoder and fallback events to opt-in live diagnostics.
  Document GPU exposure, driver capabilities and recovery in the
  [NVIDIA guide](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/NVIDIA.md).

Update both integration and bridge when this version is published. Preserve the
existing token and bridge data. Back up the previous matching installation for
rollback. Omit the acceleration setting to retain software operation.

No NVIDIA GPU was available for validation. T600 support, NVDEC/NVENC operation,
A/V synchronisation, image quality and performance remain unvalidated in issue
#49. This feature does not establish a startup-latency fix for issue #48. The
existing Python dependency limitation in issue #30 remains unchanged.

## 0.8.6 - 2026-09-13

### Live startup

- Start WebRTC signaling when the live encoder has actual audio metadata,
  without waiting for the JPEG fallback decoder's first frame.
- Bound FFmpeg analysis for both video and AAC inputs and the JPEG decoder.
  Keep analyzed packets so the initial keyframe remains available.
- Retain at most 1 MB of initial encoded output for at most two seconds so
  signaling can attach readers without losing the first video keyframe.
  Viewer revocation, slow-reader limits, fallback and camera stop ownership
  remain enforced.

### Upgrade and recovery

Update the integration and bridge together to 0.8.6 when available. This is a
software startup fix. The exact T8425/T8030 Docker startup time in issue #48
still needs an observation on that installation. No networking change is
required. Back up the previous integration, bridge and private bridge data
before updating. Restore that matching backup to roll back.

## 0.8.5 - 2026-09-11

### Logging improvements for diagnostics

This release includes all diagnostic changes since 0.8.1. Versions 0.8.2 through
0.8.4 were not published as GitHub releases.

- Include discovery rejection reasons and bounded received model/type pairs in
  normal bridge logs so missing devices can be investigated without debug mode.
- Collect one complete startup report with actual bridge/library/Node versions,
  authentication and inventory results, model/firmware details, anonymous device
  and HomeBase references, migration counts and push startup. Preserve available
  evidence when setup fails and distinguish missing observations from failures.
- Show explicit HomeBase/owner connection states, distinguish connection from
  state-refresh failures and record timestamped connection loss and recovery.
  Suppress unchanged repeated logs.
- Add an authenticated support download containing the complete latest discovery
  and up to 100 recent diagnostic events. Include it in Home Assistant's standard
  diagnostic download with actual HA/integration versions, also for failed setup.
- Bundle the verified eufy-mega-client 0.12.2 release for bounded received firmware
  and parent context on rejected devices. Independently filter shared reports in
  the bridge and HA integration to exclude credentials and device identities.
- Document collection steps, required versions, privacy checks and report field
  meanings. Link the guide from support pages and both issue forms.

### Upgrade and recovery

Update the Eufy Viewer integration to 0.8.5 through HACS and restart Home
Assistant. Separately update the bridge app or Docker installation to 0.8.5.
The bridge includes library 0.12.2, which needs no manual installation.

Download diagnostics from the integration's menu after the bridge has completed
one startup discovery. Alternatively, collect the complete `Eufy discovery:`
and `Eufy backend:` lines from the bridge's normal Logs tab. Debug is not needed
and bridge logs remain usable with an older integration. Review the file before
sharing it. See the [diagnostic collection guide](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/DISCOVERY_DIAGNOSTICS.md).

Existing Mega installations need no new login or migration because of this
update. Installations older than 0.8.0 must still follow the
[Mega migration guide](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/MEGA_MIGRATION.md).
Keep a backup of the previous integration, bridge and private bridge data.
For rollback, restore that matching backup through the normal installation or
Supervisor restore path.

### Scope and known limitations

Device admission, camera commands and media behavior are unchanged. This release
adds evidence for [issue #40](https://github.com/keesmod/ha-eufy-cam/issues/40),
not a confirmed fix for the reporter's missing C30 or floodlight camera.
The C30 model is already recognized by the library. The reporter's actual
model/type, topology and discovery result are still needed to locate the failure.
No additional hardware or media support is claimed.

The existing Home Assistant Python dependency limitation tracked in
[issue #30](https://github.com/keesmod/ha-eufy-cam/issues/30) remains unresolved.
The affected cryptography dependency and its alert are unchanged. This release
does not fix that vulnerability or claim a clean Python dependency audit.

## 0.8.1 - 2026-09-11

- Upgrade the camera bridge to the verified eufy-mega-client 0.12.0 release.
- Include its additional exact camera profiles and explicit unsupported-connection
  reasons. See the [library release scope](https://github.com/keesmod/eufy-mega-client/blob/v0.12.0/docs/RELEASE_0_12_0.md).
- Preserve camera identities, sessions and existing media capability checks.
  New profiles have software coverage, not a whole-family hardware guarantee.
- Retain bridge 0.8.0 and its private data backup for rollback. Existing 0.8.0
  installations need no new login or session migration. Older installations
  still follow the documented Mega migration steps.

## 0.8.0 - Candidate, not published

**BREAKING CHANGE: Mega is now the only camera backend.** Existing users must
update the HA integration before the bridge. The integration automatically saves
and transfers the device list. Legacy users sign in to Mega again. Old sessions,
credentials, entity IDs and backups are preserved. Missing devices pause migration.

- Remove the deprecated backend and direct eufy-security-client dependency.
- Handle old HA app backend settings automatically. Standalone Docker users
  remove EUFY_BACKEND=legacy when updating the container.
- Keep the previous bridge release and data backup for rollback.

Follow the [four upgrade steps](docs/MEGA_MIGRATION.md). New-build hardware acceptance and the
Python security gate remain open in camera #31 and #30. Do not treat this
unpublished candidate as an accepted production release.

## 0.7.3 - Unpublished

- Remove the repeated experimental/hardware warning from camera cards. The
  capability status describes software availability, not hardware verification.
- Keep unavailable-operation explanations, disabled controls and capability
  attributes. No camera transport or hardware-support claim changes.
- Integration-only update with bridge 0.7.1 retained. Publication and deployment
  remain separate actions. Refresh the card resource after upgrading.

## 0.7.2 - Candidate, not published

- Consolidate the completed camera capability and upgrade/rollback evidence,
  including exact model, firmware, topology and feature limits.
- Keep bridge 0.7.1 and the pinned Mega client 0.10.0. Only integration version
  metadata and documentation change. No media, authentication or device-command
  behavior changes and no additional hardware support is claimed.
- Preserve the legacy selection until camera #24 completes its separate gate.
  T8134 live/recovery and other family obligations remain open.

See [candidate notes](docs/CAMERA_RELEASE_CANDIDATE_0_7_2.md) for reproducible
packaging, software validation and publication boundaries. After separately
authorized publication, update the integration while keeping bridge 0.7.1.
Retain the integration 0.7.1 archive, existing entry and private backup for
rollback. A backend/version migration still follows the [migration guide](docs/MEGA_MIGRATION.md).
No publication or deployment is authorized by preparation story #21. The
existing Python dependency alert is recorded in the candidate notes and remains
an explicit gate for later publication/deployment acceptance.

## 0.7.1 - 2026-09-11

- Automatically switch failed WebRTC playback to live JPEG over the existing
  authenticated Home Assistant connection. The player displays "Live video
  without sound" and hides the audio control after switching.
- Reuse the exact bridge socket and camera owner. Revoke only that viewer's
  WebRTC media grant. Do not issue another camera start, reconnect, extend the
  original lease or reset the absolute viewing limit. Ignore late WebRTC ACKs.
- Log fixed fallback reasons in HA and opt-in bridge diagnostics, without
  exposing upstream errors, media URLs or device identifiers.

Update the bridge and HACS integration together and restart HA. Keep the
existing account, token and data. WebRTC still provides audio when it works.
JPEG fallback has no audio and requires a working HA connection. It cannot fix
an unavailable camera. T8134 live-audio validation remains pending. Preserve a
backup and version 0.6.4 for rollback.

## 0.7.0 - Included in 0.7.1

- Carry camera snapshot, live and recording software capabilities into HA and
  both cards. Mark available operations experimental and show unsupported reasons.
- Reject unsupported media before bridge or HA requests can start a stream or
  recording operation. Preserve optional-field compatibility and existing IDs.
- Keep standalone cameras separate from HomeBase alarm entities. A failed owner
  does not prevent independent camera inventory setup.
- Pin the verified published client 0.10.0 package with SHA512 integrity. No new hardware
  support is claimed. Camera migration, release and legacy retirement remain open.
- No session or entity migration is required. Keep the previous integration,
  bridge package and private data for rollback. There was no separate 0.7.0 publication.

## 0.6.4 - 2026-09-10

- Add opt-in live-stream diagnostics with per-attempt timing, incoming media,
  encoder output, playback acknowledgements and timeout categories.
- Keep diagnostics off by default. Emit fixed categories rather than raw
  encoder output, credentials, camera identifiers or media URLs. Limit repeated
  events to one per category per attempt.

Enable `diagnostics: true` in the bridge app configuration and restart the app.
For Docker, set `EUFY_DIAGNOSTICS=true` and recreate the container. Reproduce
one failed live view, save the diagnostic lines, then disable the option and
restart. This is a diagnostic aid. T8134 live playback remains unconfirmed.
Keep the existing account, token and data. Keep a backup and version 0.6.3 for
rollback. No camera timeout or ownership policy is changed.

## 0.6.3 - 2026-09-10

- Keep video-only live streams usable by forwarding the actual audio capability
  to Home Assistant and omitting go2rtc audio conversion when no supported audio
  track is present. Preserve audio conversion for audio-capable streams and
  compatibility with older bridges.
- Allow a corrected account login to replace automatic session-restore retries.
  Wait for any in-flight initialization to finish before creating another SDK
  owner. No session deletion or integration recreation is required.
- Add regression coverage for video-only and audio-capable negotiation, invalid
  metadata, recovery during backoff and serialized in-flight recovery.

Update the bridge and HACS integration together to 0.6.3, then
restart Home Assistant. Preserve the existing token, account and data. Keep the
previous version and a private backup for rollback. These fixes address code
paths implicated by issue #10. T8134 live playback still needs reporter
validation. Person event entities retain the last event, not a motion/idle state.

## 0.6.2 — 2026-09-10

- Update the independent Mega client to 0.1.1. Include T8142 eufyCam S220 / 2C
  Pro and T8134 SoloCam S220 paired with T8030 HomeBase 3 in camera discovery.
  Previously the model filter silently skipped these cameras, as reported in #10.
- Preserve existing camera protocol commands and the HomeBase 3 parent check.
  Standalone SoloCam operation is not included. Legacy behavior is unchanged.
- Automated discovery and protocol tests pass; S220 hardware validation of
  snapshots, live video/audio, recordings and real events is still pending.

Update the bridge to **0.6.2**, then the HACS integration to **0.6.2** and restart
Home Assistant. Keep the existing token, data and integration entry. This fix
applies to `backend: mega`; upgrading does not change your selected backend.
Report your backend, model, camera/HomeBase firmware and test results in issue
#10. Keep a backup and bridge/integration 0.6.1 available for rollback.

## 0.6.1 — 2026-09-10

- Fix silent recordings in Safari and the Home Assistant iOS/macOS apps. The MP4
  header now includes the AAC decoder configuration before playback starts.
- Preserve encoded audio and native video without extra transcoding. The fix
  applies to H.264, native H.265 and H.264 compatibility playback on both backends.
- Add regression checks for AAC profile, channel count and decoder configuration.

Update the bridge to **0.6.1**, then the HACS integration. Restart Home Assistant
and close and reopen any prepared recording. Existing HomeBase recordings need
no repair or camera setting change. Keep the existing data and bridge token.

## 0.6.0 — 2026-09-10

- Add the independent Eufy Mega client for T8030 HomeBase 3, T8160 cameras and
  the T8213 doorbell. Select one backend at startup; retain separate sessions
  and never retry a command through the legacy backend.
- Preserve camera/entity identities, notifications, snapshots, live video and
  audio, recording formats and Guard Mode with observed device confirmation.
- Recover cancelled starts, downloads and network loss with device STOP
  acknowledgements. Close UDP sockets and restore idle station connectivity.
- Wait for delayed first audio packets before deciding a live stream has no
  audio. Normal streams start as soon as their media is identified.
- Use host networking and the loopback endpoint `http://127.0.0.1:8063` for the
  HAOS app. Reconfigure the existing integration entry when upgrading.

Update bridge and integration together. The HAOS app endpoint changes to
`http://127.0.0.1:8063`; select `mega` explicitly and reconfigure the existing HA
entry with its existing token. Keep the previous image and private session backup.
See [Mega migration and rollback](docs/MEGA_MIGRATION.md). The agreed overnight
observation lasted about 11 hours 26 minutes; it is not a completed 24-hour
reliability or battery-life test.

## 0.5.1 — 2026-09-09

- Preserve H.265 recordings in an Apple-compatible `hvc1` MP4 when the player
  reports HEVC support. Copy AAC audio without re-encoding. Both Events and
  camera recording dialogs use the same capability check.
- Fall back once to H.264 on a native decoding/codec error, including errors
  during playback. Preserve position and pause state, show recovery progress,
  and cancel recovery when the viewer closes or changes recordings. Unsupported clients
  request H.264 immediately; network errors and cancellation do not retry.
- Allow up to 45 seconds for the H.264 compatibility conversion of H.265 clips,
  within the existing 60-second operation and 32 MiB media limits.
- Emit one complete MP4 fragment so the macOS native player sees the whole
  recording instead of ending after the first fragment.
- Keep authenticated HTTP playback, byte ranges, expiry and close cleanup.

Update the bridge and integration together to **0.5.1**, bridge first. Restart
Home Assistant and refresh the dashboard in every app/browser. For manually
configured resources, change the existing URL to
`/eufy_viewer/eufy-viewer-card.js?v=0.5.1`. No camera settings need to change.

## 0.5.0 — 2026-09-09

- Add camera event entities and the `eufy_viewer_event` automation event for
  doorbell rings, motion, people, vehicles, pets, sound and package detections.
- Include Eufy-recognized person names and distinguish known, explicitly unknown
  and unidentified people. Merge parallel push formats and derived SDK callbacks
  into one actionable event per detection. Unclassified device alerts remain
  available as `notification`; account data and raw message bodies are excluded.
- Add an Eufy push connection diagnostic binary sensor. Login connectivity and
  push connectivity are separate states.
- Subscribe without starting camera streams; ignore detector reset events,
  suppress duplicate push deliveries, and never replay alerts on HA reconnect.

Requires integration and bridge **0.5.0**. Update the bridge first, then the
integration, restart Home Assistant and verify the push connection sensor.
Existing bridge clients continue receiving state-only messages until they opt
in. See [events and notifications](docs/NOTIFICATIONS.md) for automation examples,
account/phone filtering and delivery limitations.

## 0.4.4 — 2026-09-08

- Fix recording playback in the Home Assistant macOS app in both Events and
  the per-camera Recordings dialog. Use a native HTTP video source instead of
  a browser blob, which stalls in this app.
- Prepare each clip once, support byte-range seeking and keep camera permissions
  enforced. Playback URLs use Home Assistant authentication, expire after five
  minutes and are scoped to the requesting user and one recording. Media stays
  in bounded memory and is released on close, expiry or integration unload.
- Show a retry message and release media when native playback fails or stalls.

Update **Eufy Security Viewer** to **0.4.4** in HACS, restart Home Assistant,
then refresh the dashboard in the macOS app. Open **Events**, load the date and
select a recording. For YAML-managed resources, update the existing module URL
to `/eufy_viewer/eufy-viewer-card.js?v=0.4.4`. The bridge remains at **0.4.1**;
no bridge update or camera reconfiguration is needed from that version.

## 0.4.3 — 2026-09-08

- Fix live viewing in the Home Assistant macOS app. Check client WebRTC and
  video-frame callback support before opening a stream, and use the existing
  JPEG transport when either is unavailable. JPEG live view has no audio.
- Keep WebRTC with audio on supported clients and preserve explicit-start,
  frame acknowledgement and stream cleanup behavior.
- Reproduce the missing WebRTC API in the macOS app and verify actual JPEG
  live playback and zero remaining active or quarantined streams.

Update **Eufy Security Viewer** to **0.4.3** in HACS, restart Home Assistant,
then refresh the dashboard in the macOS app. For YAML-managed resources, update
the existing module URL to `/eufy_viewer/eufy-viewer-card.js?v=0.4.3`.
The bridge stays at **0.4.1**; no bridge update or camera reconfiguration is
needed when it is already on that version. Use Safari for live audio.

## 0.4.2 — 2026-09-07

- Register the bundled dashboard cards automatically when the integration loads.
  Update the existing resource URL to the installed integration version and
  remove duplicate entries for the bundled card. Keep unrelated resources.
- Leave YAML-managed resources unchanged and log the required module URL when
  manual configuration is needed. Registration errors do not block the cameras.

Update the HACS integration to **0.4.2**, restart Home Assistant and reload the
dashboard. The integration adds or updates its card resource automatically.
For YAML-managed resources, update the existing module URL to
`/eufy_viewer/eufy-viewer-card.js?v=0.4.2`. The bridge remains at **0.4.1**;
no bridge update is required when it is already on that version.

## 0.4.1 — 2026-09-07

- Restore the saved Eufy session automatically after a Home Assistant or bridge
  restart. Home Assistant now waits for a connecting bridge instead of asking
  users to sign in again.
- Cancel the SDK's country lookup after ten seconds and retry temporary
  initialization failures with backoff. Keep genuine account verification and
  CAPTCHA requests visible, and cancel pending retries during shutdown.
- Clear stale "Camera unavailable" messages when the camera reconnects. Live
  viewing still requires a tap and never resumes automatically after recovery.
- Verify two complete HA OS VM reboots, all ten retained entity identities,
  1920×1080 live playback and device-confirmed stream shutdown. See
  [startup recovery validation](docs/STARTUP_RECOVERY_2026-09-07.md).

Update **both the bridge and integration to 0.4.1**, restart Home Assistant, then
reload the dashboard. Update the existing card resource to
`/eufy_viewer/eufy-viewer-card.js?v=0.4.1` if needed. Keep the bridge data and token;
no new Eufy account setup is required. Actual expired credentials or verification
challenges still require the normal reauthentication flow.

## 0.4.0 — 2026-09-07

- Add HomeBase alarm and Guard Mode entities to the existing camera integration
  and bridge, including Home/Away, Disarmed, custom profiles, Schedule and Geofencing.
- Report actual station state, entry delay, exit delay and triggered alarms. Wait
  for matching device acknowledgements before completing mode commands; reject
  unavailable stations, unsupported modes, concurrent commands and uncertain retries.
- Document migration from another Eufy integration while retaining entity-based
  automation and dashboard references.
- Validate both HA command routes on HomeBase 3 with the previous bridge stopped;
  four camera snapshots remain available. 61 HA tests and 37 bridge tests passed.

Update **both the bridge and integration to 0.4.0**, then restart HA. Existing
Viewer configuration and camera IDs are retained. Manual siren triggering is not
exposed. See [migration and validation](docs/ALARM_MIGRATION_2026-09-06.md).

## 0.3.1 — 2026-09-06

- Remove the snapshot receive date/time and “Capture time unknown” line from camera cards in English and Dutch.
- Keep snapshot receive timestamps in entity attributes and use them to refresh newly received images.
- Update the README to describe the simplified card.

Update the HACS integration to 0.3.1, restart HA and reload the dashboard. If the old card remains cached, edit the existing resource to `?v=0.3.1`. The bridge remains at 0.3.0; no bridge update is required.

## 0.3.0 — 2026-09-06

- New Eufy Events card: all-camera timeline, camera/date filters, HomeBase recording-day calendar and previous/next playback.
- Existing-event thumbnails, 12 visual results per page and bounded browser image caching; no live capture or cloud polling.
- Expand the SDK's 100-row day limit using the hardware-verified count field. Reject ambiguous/inconsistent histories rather than silently truncate them.
- Batch cameras by HomeBase; retain entity permissions, private file paths, expiring references and cancellation. Calendar markers require access to the full bridge inventory.
- Verified 95 camera recordings from a 105-row day and played an existing clip beyond the former first-100 cutoff in HA.
- Preserve WebRTC/audio, viewer leases and bounded stop recovery. Physical iPhone suspension/audio and other HomeBase firmware remain unverified.

Update the bridge app and HACS integration to 0.3.0, restart HA and change the existing dashboard resource to `?v=0.3.0`. Add **Eufy Events** through the card picker. HACS updates the integration/cards; the bridge updates separately through the HA App Store.

## 0.2.0 — 2026-09-06

- Browse existing HomeBase recordings by date from each camera card and play a selected clip in HA.
- Use verified calendar query 10006; camera-scoped, expiring references prevent arbitrary path downloads.
- Authenticated HA proxy with entity permissions, bounded in-memory MP4 preparation and cancellation on navigation.
- Preserve the unpublished WebRTC/audio functionality and idle battery safeguards.
- Recover idle sessions stranded by a missing live-stop event through bounded HomeBase transport closure; distinguish active viewers, pending stops and recording failures in the UI.

- On-demand WebRTC H.264 video and listen-only Opus audio through HA-managed go2rtc.
- Muted autoplay with an explicit sound toggle; native camera dialogs remain snapshot-only.
- Ephemeral media grants cannot start or renew a camera; browser-painted frames renew the existing local viewer lease.
- Real Chromium, FFmpeg and go2rtc tests cover audio/video, close, navigation and frozen playback.
- Live validation confirmed four camera entities/snapshots, 1920×1080 WebRTC video and existing HomeBase 3 recording playback in HA.
- Requires HA go2rtc and browser-to-HA media connectivity. Wider model coverage, physical audio output, iOS suspension, remote routes and complete history pagination remain unverified.

Upgrade both the bridge and HACS integration, restart HA, update the existing card resource to `?v=0.2.0` and reload the dashboard. See the README for the upgrade steps.

## 0.1.0 — 2026-09-05

Initial public release for HACS custom-repository installation.

- UI configuration, account verification/reauthentication, battery sensors and redacted diagnostics.
- Bundled visual-editor camera card: snapshots at rest, live video only after a tap.
- Shared viewers, immediate stop on close, independent bridge watchdog and a two-minute session cap.
- Home Assistant OS bridge app and standalone Docker build, with pinned Node dependencies.
- English/Dutch translations; Home Assistant 2026.9.0 baseline.
- Four cameras reported working in the first installation; instrumented start/close confirmation for one camera.

Live video is JPEG-based, up to 8 fps / 960 pixels wide, without audio. iOS suspension, power-loss behavior, long-term battery impact and broad model compatibility remain unverified. See the validation record.
