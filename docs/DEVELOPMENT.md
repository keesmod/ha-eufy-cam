# Development

Edit the bridge in `bridge/` and the other app files in `app/`: `app_config.json` (the app configuration without a version), `Dockerfile`, `bootstrap.mjs`, `README.md` and `CHANGELOG.md`. `scripts/prepare_ha_app.py` generates the store folders `ha_app/` and `ha_app_beta/` from both. They stay frozen between releases, see [store folders](RELEASING.md#store-folders-and-what-a-merge-publishes).

The generator inserts the bridge version into `config.json`. The beta channel gets its own slug, name, stage and description and a notice at the top of `README.md`. In the store `CHANGELOG.md`, the folder version's section starts with the exact `## <version>` line that Home Assistant uses for update notes. To build the candidate app locally, stage it into the ignored `artifacts/` folder:

```sh
python3 scripts/prepare_ha_app.py --stage
docker build -t eufy-viewer-app:test artifacts/ha_app/eufy_viewer_bridge
```

Baseline: Python 3.14.2+, Node 24+, FFmpeg. Tests run against Home Assistant 2026.10.0. The minimum supported release stays 2026.9.0. Dependencies are locked in `uv.lock`, `bridge/package-lock.json` and `frontend/package-lock.json`.

```sh
uv sync --frozen
uv run ruff check custom_components tests
uv run ruff format --check custom_components tests
uv run mypy custom_components
uv run pytest --cov=custom_components.eufy_viewer --cov-report=term-missing
npm --prefix bridge ci --ignore-scripts
npm --prefix bridge run build
npm --prefix bridge test
npm --prefix frontend ci --ignore-scripts
cd frontend
npx playwright install chromium
npm run build
npm test
```

Tests use mock Eufy data and local servers. They must never use production credentials, discover local Eufy devices or connect to a live Home Assistant instance. Bridge media tests generate synthetic H.264 and run the real FFmpeg decoding path.

The official HA hassfest validator is run separately by CI and can also run from a checkout of Home Assistant core:

```sh
PYTHONPATH=/path/to/core uv run python -m script.hassfest \
  --integration-path custom_components/eufy_viewer \
  --core-path /path/to/core
```

Create local installation archives after validation:

```sh
uv run python scripts/package.py
```

Publishing, tagging, deploying and physical camera tests are separate explicit actions. Before a release, update the manifest/package versions, refresh lockfiles if dependencies changed, run all checks and complete the hardware acceptance matrix. A HACS installation uses the repository's `custom_components/eufy_viewer` folder, including its bundled card.

Edit `frontend/eufy-viewer-card.ts`, `frontend/eufy-events-card.ts` or their shared `frontend/recording-playback.ts` helper; `npm run build` compiles these and combines them in the existing single bundled resource. `frontend/build.mjs` performs this dependency-free packaging step. Both the card and bridge compile with TypeScript strict mode.

## Pull requests and releases

For a change that users need to receive through an update, set the candidate
versions and add the changelog entry and installation or upgrade instructions in
the PR, following the [candidate rules](RELEASING.md#versions-and-candidates).
Name the affected components and their target versions. Only change the bridge
version when the bridge changes. For an integration-only change, state which
existing bridge version to use. Documentation-only changes can state that no
release is needed.

The required `ci` check covers release metadata, workflow validation, HA tests,
HACS, hassfest, app packaging, bridge tests, the card and verified release ZIPs.
After merging, verify it on `main`. Use **Actions → Release** for a rehearsal and
then explicit publication. See [the release flow](RELEASING.md) for the complete
procedure, checksums, acceptance evidence and failed-run recovery.

Merging a runtime PR publishes nothing. HACS users receive a version after the
Release workflow publishes and verifies it. Only a stable release PR or a beta
cut changes a store folder and so updates an app. Pure CI/documentation changes
do not need a new product version or a Home Assistant deployment.

## Maintainer bench

The maintainer checks each stable release on a Home Assistant OS bench running
the stable app with slug `e35bd336_eufy_viewer_bridge`. After the release PR
merges, back up the app, then reload the store and update it:

```sh
ha backups new --app e35bd336_eufy_viewer_bridge --name "eufy-viewer-bridge before X.Y.Z"
ha store reload
ha apps update e35bd336_eufy_viewer_bridge
ha apps logs e35bd336_eufy_viewer_bridge
```

The log's `Eufy discovery:` summary should list the expected cameras and
stations. Once the GitHub release is public, select **Update information** for
the repository in HACS, update the integration and restart Home Assistant.

To test the beta app against the existing integration entry, the bench copies
only the stable app's bridge identity into the beta app. This is for the
maintainer bench only. Users follow [beta testing](INSTALLATION.md#beta-testing)
with a separate entry. Never copy credentials or sessions. The beta app signs in
to Eufy on its own.

Supervisor 2026.07.4 and later names app containers `app_<slug>`, previously
`addon_<slug>`. Confirm the names with
`docker ps --format '{{.Names}}' | grep eufy_viewer_bridge`.

1. Back up Home Assistant and both apps. Read the identity from the running
   stable app. Stop here if the check reports no identity:

   ```sh
   ID=$(docker exec app_e35bd336_eufy_viewer_bridge cat /data/eufy/bridge-id)
   test -n "$ID" || echo "No bridge identity was read. Stop here."
   ```

2. Turn off **Start on boot** on the stable app and stop it. Start the beta app
   once with the same configuration and token, so that it creates `/data/eufy`.
3. Replace the beta app's identity, owned by uid 1000 with mode 600, and
   restart it. The copy runs only with a non-empty `ID`:

   ```sh
   test -n "$ID" &&
     printf %s "$ID" | docker exec -i app_e35bd336_eufy_viewer_bridge_beta sh -c \
       'umask 077 && cat > /data/eufy/bridge-id.new && chown 1000:1000 /data/eufy/bridge-id.new && mv /data/eufy/bridge-id.new /data/eufy/bridge-id'
   ha apps restart e35bd336_eufy_viewer_bridge_beta
   ```

4. The existing entry now reaches the beta app. It asks to reauthenticate,
   because the beta app has no Eufy session yet.

To return, turn off **Start on boot** on the beta app and stop it, then start
the stable app with **Start on boot** on. The entry reconnects with the same
identity. Reauthenticate if Home Assistant asks.

## Real WebRTC acceptance tests

Set `GO2RTC_BINARY` to a local go2rtc 1.9.14 executable when running the frontend tests. Without it, the three real-media tests are skipped; CI installs and verifies the executable and always runs them. Install the bridge npm dependencies too, because this fixture exercises the actual bridge media relay. FFmpeg and Chromium are required.

The fixture generates synthetic 1280×720 H.264 and a 440 Hz AAC tone, runs the actual bridge and go2rtc, and checks decoded video and inbound audio energy in Chromium. Close, navigation and frozen playback must stop the fake camera and leave zero viewers. HA dispatch and Eufy hardware are simulated; separate HA tests cover signaling permissions and cleanup. The test go2rtc media listener uses the first non-loopback IPv4 interface because Chromium omits loopback ICE; its API and RTSP listeners are loopback-only. It never uses a microphone or real camera.

## CI timing and cleanup

Home Assistant's cold component setup loads all registered config entries itself. Tests must use that setup once, or initialize the component before concurrently setting up new entries. The two-bridge test covers both paths, checks one initial state request per bridge and verifies that reloading one bridge preserves the other and the shared registration.

The SDK adapter's live-media fixture produces paced H.264 until the viewer closes. A finite file is unsuitable here: the A/V relay can reach EOF and stop the session before the JPEG decoder returns its first frame. The former fixture was reproduced hanging with a one-second JPEG-decoder delay; the continuous fixture passes that same delay. Producer failure and early viewer closure reject the frame wait, and the fixture has a 15-second deadline with producer cleanup in `finally`.

CI separates bridge build, tests and dependency audit. Bridge tests have a 30-second per-test limit and a three-minute step limit; jobs have a ten-minute limit. Timeouts fail the run. No automatic retries or skipped assertions mask failures.

## Diagnostic report contract

The [collection guide](DISCOVERY_DIAGNOSTICS.md) is the user-facing reference.
This contract covers discovery, authentication and connection diagnostics.
The additive [playback report contract](PLAYBACK_REPORT.md) covers bounded live
and recording observations, anonymous correlation, versions and assessments.
Neither contract records camera commands, event payloads or media bytes.

The [library diagnostic API](https://github.com/keesmod/eufy-mega-client/blob/main/docs/DIAGNOSTICS.md)
owns bounded received cloud/discovery context. `DiscoveryIssue.deviceId` and
`context.parentId` are private correlation values and must never be serialized
into a shared report. The camera bridge owns anonymous references, lifecycle
logging, retention and the authenticated download. The HA integration owns its
version/setup context and independently validates the bridge output. Other
consumers retain their own endpoints and sessions.

`bridge/src/discovery-diagnostics.ts` constructs allowlisted records. The normal
logger prefixes their JSON with `Eufy discovery:`. Existing `Eufy backend:` error
lines remain available. Since bridge 0.8.37, with `experimental_standalone` on, an
`Eufy experimental standalone:` info line names the bounded model code of each
standalone row the library does not admit, never an ID or name. `MegaBackend`
supplies library and connection observations, and `Eufy` retains setup-failure
evidence when its backend is cleaned up.

The bridge's Bearer-authenticated `GET /v1/diagnostics` returns:

| Field | Meaning |
|---|---|
| `schema` | Report format version, currently integer `2` |
| `generated_at` | Download generation time in UTC ISO format with milliseconds |
| `last_discovery` | Complete latest summary, device/issue rows and end record |
| `recent_events` | At most 100 recent cloud, connection, station-connection, recording query and fault records |

Records carry `diagnostic=discovery`, `schema=2` and a UTC `timestamp`. An `event`
selects the record shape:

| Event | Contents |
|---|---|
| `summary` | Actual bridge/library/Node/platform versions, outcome, discovery counts, inventory availability, migration-baseline/missing counts, truncation and report number, since bridge 0.8.37 the `experimental_standalone` opt-in, and since bridge 0.8.39 the `standalone_recording_probe` opt-in |
| `device` | Anonymous reference, model/firmware/hardware, observed availability, owner relationship/status and per-feature software capabilities |
| `issue` | Source inventory row, validated reason code, bounded model/type/firmware and parent context, anonymous links where known |
| `end` | Report number and number of device/issue rows emitted |
| `cloud` | Named allowlisted operation, HTTP status, numeric result and elapsed milliseconds |
| `connection` | Authentication or push-event phase, outcome, push status and software versions |
| `station_connection` | Report number, anonymous device reference, model, connect/refresh/observation phase, status and validated reason code, a failed connect's `stage`, and since bridge 0.8.38 the bounded lookup fields of the connect attempt behind the record |
| `recording_query` | Since bridge 0.8.39 with client 0.30.1, one recording operation on its owner: report number, the owner's anonymous reference and model, operation, owner type, status, reason and result code, how far it got, the device's answer to its last query page, database replies the session could not use, row counts of an answered list and the HTTP status the bridge answered with |
| `fault` | Validated error code and report number when available |

`report` groups discovery rows within a backend lifetime. `ref` is one-based in
that report, while `inventory_row` is the separate zero-based source position.
Neither references nor report counters are persistent identities. Recent events
can precede the latest discovery, so keep their timestamps and report numbers.
`last_discovery` describes its collection time, and later transitions belong in
`recent_events`. `generated_at` does not make old observations current.

A HomeBase status can be `not_checked`, `connected`, `disconnected` or `error`.
A camera's own station status is `not_applicable`, with `owner_status` describing
its actual owner instead. Since bridge 0.8.34 a standalone camera row carries
`descriptor`, four nullable booleans `did`, `license`, `admin_user` and
`lan_address` for the presence of its inventory connection fields, never their
values. An opted-in standalone row has `relationship_transport=experimental`.
Its owner is the camera itself, so its `owner_status` describes that camera's
own session. Since bridge 0.8.37 the `summary` carries `experimental_standalone`,
a boolean that is `true` exactly when the bridge passes the opt-in to the
library. It is a configuration flag without identity. Older bridges, and a setup
report without a discovery summary, leave it out. With `true`, a standalone row
with `relationship_reason=standalone_transport_unverified` and no
`relationship_transport` is a camera whose model the library does not admit to
the experimental route. With `false` or no field, such a row says nothing about
the option. The bridge and integration decide this from the library's
relationship, never from a model list. The HA download keeps only a strict
boolean, so any other value becomes `null`. Integration 0.8.46 reports such rows
as `standalone_admission`, and older integrations drop the field. The schema
stays `2` because no existing field changes shape or meaning. Nullable booleans
must not turn unknown/error states
into a successful or failed connection. A present parent row does not prove
support, connectivity or playback. Preserve observed availability and software
capabilities as separate evidence.

Since bridge 0.8.38 with client 0.30.0, a `station_connection` record can say
what the local lookup of its connect attempt saw
([issue #152](https://github.com/keesmod/ha-eufy-cam/issues/152)). The source is
the client's `connectStation` `onLookup` observation, see the
[library API](https://github.com/keesmod/eufy-mega-client/blob/main/docs/API.md#station-lookup-observation-0300).
The purpose is to tell a lookup that received nothing from one whose replies
arrived and were not accepted. The fields are flat on the record:

| Field | Bound | Meaning |
|---|---|---|
| `lookup_rounds` | 0 to 99 | Lookup rounds sent |
| `lookup_broadcast_targets` | 0 to 16 | Directed broadcast targets of the latest round |
| `lookup_broadcast_enabled` | boolean | Whether the session socket accepted broadcasts |
| `lookup_send_errors` | 0 to 999 | Lookup sends that failed |
| `lookup_datagrams` | 0 to 999 | Datagrams received while the lookup ran |
| `lookup_other_headers` | 0 to 999 | Of those, datagrams that are no lookup reply |
| `lookup_own_replies` | 0 to 999 | Replies with the station's own ID |
| `lookup_own_round` | 0 to 99 | Only with an own reply: the latest round sent when the first one arrived, counted from 0, so 0 is the first round |
| `lookup_account_replies` | 0 to 999 | Replies with the ID of another device or station in the inventory |
| `lookup_foreign_replies` | 0 to 999 | Replies with an ID outside the inventory |
| `lookup_near_replies` | 0 to 999 | Replies whose ID matches the own ID only after the client's normalization |
| `lookup_inventory_reply` | `none`, `own`, `account`, `foreign`, `near` | Class of the first reply from the inventory LAN address, `none` without one |
| `inventory_address_on_subnet` | boolean | Only with an inventory address: whether it lies in a subnet of the bridge host |
| `inventory_address_shared` | boolean | Only with an inventory address: whether another inventory row has the same LAN address |

A failed `connect` record carries them next to its `stage`. A successful attempt
is reported by the record that follows its connect. That is the `connect` record
of an experimental standalone camera and the `refresh_state` record of a
HomeBase, whatever its status. On a `refresh_state` record the fields describe
the local lookup of the connect attempt behind the record, not the refresh. The
idle reconnect of a disconnected HomeBase writes the same records and records
its lookup the same way. `observation` records never carry them.

The values are counts, booleans and one enum. They contain no DID, address,
port, serial or interface name. The client compares each reply's DID with the
inventory's DIDs inside its process and keeps only counts. The bridge revalidates
every value at its logging boundary, leaves out an integer outside its bound, a
value that is not a real boolean and a reply class outside the fixed set, and
never serializes the observation object. The `Eufy discovery:` log lines and the
bridge download carry the same records. The HA download applies the same bounds
and replaces any other value with `null`.

A missing field means no observation, for example from an older bridge or
client, an attempt that ended before `lookup`, such as one refused with
`connection_busy`, or a station that was already connected. `lookup_own_round`
is absent without an own reply. The two `inventory_address_` fields are absent
without an inventory address, and `inventory_address_on_subnet` also when the
host's interfaces cannot be read. None of the values proves a cause on its own.
Integration 0.8.47 adds at most one fixed sentence to the `owner_connection` or
`standalone_connection` finding of an attempt that failed at `lookup`, and keeps
the previous text without the fields. When the lookup fields show a near reply,
the finding says that the device gave no accepted reply instead of that it did
not answer, and the `owner_connection` finding leaves out "The bridge host did
not reach the HomeBase on its LAN", because a reply with the device's ID did
reach the bridge. This holds also when a send error names the added sentence.
Without a near reply, when `lookup_inventory_reply` is `account` or `foreign`,
or `lookup_account_replies` or `lookup_foreign_replies` is above 0, the
`owner_connection` finding says that this HomeBase did not answer instead of
that no HomeBase answered, because the device that answered can be another
HomeBase.
Integration 0.8.46 or older drops the fields, and bridge 0.8.37 or older sends
none. The schema stays `2` because the fields are additive.

### Recording query records

Since bridge 0.8.39 with client 0.30.1, `recent_events` and the `Eufy
discovery:` log lines carry a `recording_query` record for recording operations
([issue #152](https://github.com/keesmod/ha-eufy-cam/issues/152)). Integration
0.8.48 keeps it in **Download diagnostics**. The purpose is to tell apart why
a list, calendar, thumbnail or download failed, because the bridge answers
`recording_unavailable` for almost every cause. The source is the client's
`onObservation` report of each operation, see the
[library API](https://github.com/keesmod/eufy-mega-client/blob/main/docs/API.md#recording-operation-observation-0301),
plus the `onProgress` and `onLookup` callbacks of the owner's connection when
the operation has to connect.

The bridge records an operation on an experimental standalone owner except a
successful thumbnail, and a failed operation on any owner. Since
[issue #175](https://github.com/keesmod/ha-eufy-cam/issues/175) the only
operation on a standalone owner is the opt-in probe, because the bridge refuses
its other recording requests with `capability_unavailable` before any client
call. A HomeBase success
is not recorded, so its recordings and the events timeline do not fill the
ring. A request can run one operation per owner, so a timeline over several
HomeBases can add one record per failed owner. Two bridge cases have no client
report. When the bridge's client is not connected, each owner of the request
gets a record with reason `client_disconnected`. When a request ends with the
generic `recording_unavailable` and no client report explains it, for example
`client_closed` before the client's recording access or an error of the bridge
before the first operation, the owner of the latest operation, or else each
owner of the request, gets a record with that error's code or
`unclassified_error`. Such records have `query_stage=admission`,
`session_open=null` and the values of an operation that sent no page. Bridge
refusals with their own answer, such as `live_busy`, `recording_busy`,
`capability_unavailable` or a 400 input error, and a failure after a completed
operation, such as a video conversion, add no record. The
[playback attempt](PLAYBACK_REPORT.md#recording-stages-and-limits) keeps the
latter.

| Field | Source | Bound | Meaning |
|---|---|---|---|
| `report`, `device_ref`, `model` | Bridge | As `station_connection` | The discovery report and the anonymous reference and model of the operation's owner. That is the camera itself on the experimental standalone route and else its HomeBase. An owner outside the latest inventory gets no record |
| `query` | Bridge | `list`, `calendar`, `thumbnail`, `download`, `probe` | The client operation. The events timeline uses `list`. `probe` is the opt-in standalone recording probe at login |
| `owner` | Client `owner`, else the bridge's inventory | `standalone`, `station` | `standalone` for an experimental standalone owner. The client reports `station` for an unknown or expired recording ID |
| `status` | Client `code` | `completed`, `error` | `error` for every failure, including a bridge case without a client report |
| `reason` | Client `code`, else the bridge | Machine code | `null` on success. The client's `unexpected_error`, an error that is no `EufyError`, becomes `unclassified_error` |
| `result_code` | Client `remoteCode`, else the error's | -999999 to 999999 | The error's numeric result, such as the database result of `history_rejected`. `null` without one |
| `session_open` | Client `sessionOpen` | Boolean | Whether the owner's session was connected when the operation started. `null` without a client report |
| `query_stage` | Client `stage` | `admission`, `connect`, `query`, `validate`, `transfer` | The last stage reached, see the library API. `admission` without a client report |
| `stage`, `inventory_address`, `lookup_*`, `inventory_address_*` | Connection callbacks | As `station_connection` | Only when the operation connected the owner: the last connection stage and the lookup of that attempt |
| `elapsed_ms` | Client `elapsedMs`, else the bridge's own timing | 0 to 3600000 | Milliseconds of the operation. A download ends when its transfer starts |
| `pages` | Client `pages` | 0 to 4 | Query pages sent. A calendar sends one, a thumbnail or download none |
| `query_limit` | Last page `limit` | 0 to 10000 | Rows requested by the last page. 20 for a probe, 0 for a calendar and without a page |
| `query_answered` | Last page `answered` | Boolean | Whether the last page was answered. `false` without a page |
| `ack_code` | Last page `ackCode` | -999999 to 999999 | The session's command result for the last page's query command. `null` without one |
| `query_result_code` | Last page `resultCode` | -999999 to 999999 | The answer's database result (mIntRet). `null` without an answer |
| `query_rows` | Last page `rows` | 0 to 10000 | Rows in the last page's answer. `null` without an answer |
| `unhandled_replies` | Client `unhandledReplies` | 0 to 99 | Database replies the owner's session could not dispatch during the operation. A probe does not count replies with inner command 10013, the latest-info query every connection sends |
| `unhandled_reason` | Client `unhandledReason` | `unknown_cmd`, `parse_error` | Why the latest of those was not dispatched. `null` without one |
| `unhandled_result_code` | Client `unhandledResultCode` | -999999 to 999999 | The database result of the latest of those. `null` without one |
| `rows_own`, `rows_other_device`, `rows_station_mismatch` | Client `rowClasses` | 0 to 10000 | A list's or probe's latest answered page divided into rows of the owner's cameras, of other devices, and of the owner's cameras with another station or no valid path. 0 without an answered list or probe page |
| `rows_invalid_time`, `rows_other_day`, `rows_cipher_id` | Client `rowClasses` | 0 to 10000 | Rows of that page with an invalid time, with a start on another day, and with a cipher ID of any value. 0 without an answered list or probe page |
| `returned` | Bridge | 100 to 599 | The HTTP status of the bridge's answer to the request, 200 on success. When a video fails after its 200 headers were sent, the bridge closes the response and the record says 503. `null` for a probe, which answers no HTTP request |

A record carries every field except `stage`, `inventory_address` and the lookup
fields, which appear only when the operation connected. `null` means that the
value was not observed or failed its bound. A missing record means an older
bridge, client or integration, a case the bridge does not record, or a repeat.
Some readings of a list that failed with `device_request_timeout` at `query`:
`ack_code=null` and no unhandled reply is a silent device, a non-zero
`ack_code` a refusal in the device's command result, `unhandled_reason=unknown_cmd`
with `unhandled_result_code=-6006` an answer without an inner command, and
`parse_error` an answer the session could not parse. `history_rejected` at
`validate` carries the database result in `result_code` and
`query_result_code`. `rows_cipher_id` above 0 says that a download from a
standalone owner will be refused with `recording_cipher_unavailable`. None of
these values proves a cause on its own.

Since bridge 0.8.39 with client 0.30.1, the app option
`standalone_recording_probe` (Docker `EUFY_STANDALONE_RECORDING_PROBE`) makes
the login discovery call the client's `probeStandaloneRecordings` once for
each experimental standalone camera right after its successful connection
([issue #178](https://github.com/keesmod/ha-eufy-cam/issues/178)). The client
sends one read-only 10017 request for the newest 20 records of today and
reports the outcome as its observation. The bridge records every probe outcome
as a `recording_query` record with `query=probe` and `returned=null`, and the
`summary` carries `standalone_recording_probe`, a boolean that is `true`
exactly when the option is on. A discovery after a cloud reconnect sends no
probe. The HA download keeps `query=probe` from integration 0.8.48 and only a
strict boolean for the summary field. Integration 0.8.48 betas from before the
probe set `query` to `null` and drop the summary field, and integration
0.8.47 drops the record. The collection steps and readings are in
[standalone recording probe](DISCOVERY_DIAGNOSTICS.md#standalone-recording-probe).

Apart from the standalone refusal of
[issue #175](https://github.com/keesmod/ha-eufy-cam/issues/175) and the opt-in
probe, the client observes only. Its queries, page sizes, timeouts, error codes
and the session close after a failed or cancelled operation are unchanged. For
a HomeBase, the bridge's HTTP status codes and bodies are unchanged too. For an
experimental standalone camera, the bridge refuses each recording request with
`capability_unavailable` (503) before any client call. The values are bounded scalars
and fixed enums without an ID, serial, DID, path, name or address. The bridge
revalidates each value at its logging boundary, sets an integer outside its
bound, a value that is not a real boolean and an enum outside its set to
`null`, and never serializes the observation object. The HA download applies
the same bounds and replaces any other value with `null`. Only this record's
`elapsed_ms` allows one hour, other records keep two minutes. The shared cases
are in `tests/fixtures/recording-query.json`. Integration 0.8.47 or older drops
the record, and bridge 0.8.38 or older sends none. The assessment adds no
finding for it yet. The schema stays `2` because the record is additive.

### Bounds and compatibility

- Retain at most 99 device rows and 99 issue rows plus summary/end, and at most
  100 recent events. The download is cached in memory, without extra cloud or
  device calls. Restarting loses earlier retained events and collects new startup
  evidence. Do not introduce unbounded retention or polling for logging.
- Models match `T[A-Z0-9]{4}(?:[A-Z0-9]{1,3}|-[A-Z0-9]{1,2})?` and are at most
  eight characters long. That allows an unhyphenated catalogue code such as
  `T8410C` (since bridge 0.8.36 and integration 0.8.45) and a short hyphen
  suffix such as `T8113-Z` (since bridge 0.8.29 and integration 0.8.37). Both
  validators check the length explicitly. The bridge's discovery rows,
  `Eufy backend:` line and live video and audio rows share `diagnosticModel`,
  and the HA download applies the same pattern with `re.fullmatch`. A serial
  number longer than eight characters never matches. Any other value becomes
  `unavailable`. Device types are integers from 0 through 65535. Numeric dotted
  versions contain one to four
  components of one to four digits, with a maximum length of 19. Firmware,
  hardware, parent and owner firmware, camera software, Node and Home Assistant
  versions use only this form. Release versions may add a `-beta.N` suffix with
  N from 1 through 9999, with a maximum length of 24. They are the bridge and
  library versions in `software`, which the bridge checks with
  `diagnosticReleaseVersion` and the HA download rechecks with `release_version`,
  and the download's `integration` and `card_version` values, which the
  integration checks with `release_version`. The live
  diagnostics websocket accepts a `card_version` of at most 24 characters. Since
  bridge 0.8.38 and integration 0.8.47 a beta such as `0.8.38-beta.1` appears as
  received. Older versions show it as `unavailable`. In the assessment an
  `unavailable` integration version matches no loaded card. Both validators
  share the cases in `tests/fixtures/diagnostic-versions.json`. Do not coerce,
  trim, truncate or infer rejected values. Use fixed enum allowlists for structural values.
- `code`, `reason`, `relationship_reason` and `outcome` accept complete machine
  identifiers matching `[a-z][a-z0-9]*(?:_[a-z0-9]+)*`, at most 64 characters.
  Both bridge and integration validate this format without enumerating individual
  codes. Invalid bridge codes become `unclassified_error`. Invalid values at the
  HA download boundary become `null`, preserving its existing rejection behavior.
  Code producers must use static identifiers, never interpolate private data or
  forward raw error messages. Format validation cannot identify a secret that
  happens to look like a code. Structural enums and unknown-field filtering stay
  unchanged. Bridge/integration 0.8.16 introduce this behavior with schema 2.
  Older integrations can replace new codes with `null`. Updated bridge startup
  logs remain the fallback until the integration is updated.
- Unchanged discovery logs emit only summary/end with `unchanged=true` and zero
  emitted rows. The download still contains complete rows. Repeated identical
  connection states and consecutive identical generic faults are suppressed.
  Error phases and changes of state remain distinguishable. Since bridge 0.8.38
  a `station_connection` record with lookup fields repeats the previous record
  only when its coarse lookup class is the same as well. The class is whether
  each count is zero, plus each boolean and the reply class, so changed counts
  alone add no record and a changed outcome does. A record without lookup
  fields does not end a repeat. Since bridge 0.8.39 a `recording_query`
  record repeats the previous record of the same owner and `query` in the same
  report when every value except `elapsed_ms` is the same, with `query_rows`,
  `unhandled_replies`, each `rows_` count and each lookup count reduced to
  whether it is zero. A changed outcome, such as another `ack_code` or reason,
  adds a record.
- `custom_components/eufy_viewer/diagnostics.py` revalidates keys and values before
  exporting them. Unknown fields are omitted and invalid values become safe
  sentinels. Its bridge request has a 1 MiB response bound and a ten-second outer
  deadline. Unsupported schemas, malformed reports and unavailable bridges have
  explicit outcomes. HA's standard envelope may add system information.
- The report schema is distinct from bridge protocol `1`. Document additive
  fields and update both bridge construction and HA validation together. Plan a
  new schema for incompatible shape or meaning changes, including how older
  integrations refuse or handle it. Never assume an unknown field survives an
  older integration's allowlist.

### Changing diagnostics

For a new field, record its source, purpose, sensitivity, validation bounds,
missing-value meaning and required component versions. Update the appropriate
library API docs, this contract and the collection guide. Change canonical bridge
source in `bridge/`. The store folders follow at the next release or beta cut.

Test the public-library to bridge/logger/download path and the independent HA
filter. Cover hostile values, missing context, anonymous correlation, accepted
and rejected mixed inventories, failed/empty setup, authentication on the endpoint,
bounded retention, deduplication and preservation of complete downloads. Include
connection loss/recovery when that path changes. Synthetic diagnostics tests must
not open live camera streams or access production accounts.

Existing coverage lives in `bridge/test/discovery-diagnostics.test.ts`,
`bridge/test/live-video-diagnostics.test.ts`, `bridge/test/mega-backend.test.ts`,
`bridge/test/server.test.ts`, `tests/test_diagnostics.py`,
`tests/test_recording_diagnostics.py` for the assessment and
`tests/test_live_diagnostics.py`. Follow [diagnostic release checks](RELEASING.md#diagnostic-release-checks)
when shipping a change. Markdown and issue-form wording changes alone need no
runtime version bump, deployment or live-device test.
