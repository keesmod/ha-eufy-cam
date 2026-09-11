# Development

The app's `src`, package manifests and `tsconfig.json` are generated from `bridge` by `scripts/prepare_ha_app.py`. Edit the files in `bridge`, then run that script to update the app build files.

Baseline: Python 3.14.2+, Home Assistant 2026.9.0, Node 24+, FFmpeg. Dependencies are locked in `uv.lock`, `bridge/package-lock.json` and `frontend/package-lock.json`.

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

For a change that users need to receive through an update, include the version
bump, changelog entry and installation or upgrade instructions in the PR. Name
the affected components and their target versions. Documentation-only changes
can state that no release is needed.

For integration or bundled-card changes, keep the version in
`custom_components/eufy_viewer/manifest.json`, `pyproject.toml` and the project's
`uv.lock` entry aligned. Update the card resource examples to that version.
Only bump the bridge when it changes; keep its package files, generated app
files, `ha_app/config.json` and app changelog aligned. For an integration-only
release, state which existing bridge version to use.

The required `ci` check covers release metadata, workflow validation, HA tests,
HACS, hassfest, app packaging, bridge tests, the card and verified release ZIPs.
After merging, verify it on `main`. Use **Actions → Release** for a rehearsal and
then explicit publication. See [the release flow](RELEASING.md) for the complete
procedure, checksums, acceptance evidence and failed-run recovery.

Merging a PR does not publish a release. HACS users receive a version after the
Release workflow publishes and verifies it. Pure CI/documentation changes do not
need a new product version or a Home Assistant deployment.

## Real WebRTC acceptance tests

Set `GO2RTC_BINARY` to a local go2rtc 1.9.14 executable when running the frontend tests. Without it, the three real-media tests are skipped; CI installs and verifies the executable and always runs them. Install the bridge npm dependencies too, because this fixture exercises the actual bridge media relay. FFmpeg and Chromium are required.

The fixture generates synthetic 1280×720 H.264 and a 440 Hz AAC tone, runs the actual bridge and go2rtc, and checks decoded video and inbound audio energy in Chromium. Close, navigation and frozen playback must stop the fake camera and leave zero viewers. HA dispatch and Eufy hardware are simulated; separate HA tests cover signaling permissions and cleanup. The test go2rtc media listener uses the first non-loopback IPv4 interface because Chromium omits loopback ICE; its API and RTSP listeners are loopback-only. It never uses a microphone or real camera.

## CI timing and cleanup

Home Assistant's cold component setup loads all registered config entries itself. Tests must use that setup once, or initialize the component before concurrently setting up new entries. The two-bridge test covers both paths, checks one initial state request per bridge and verifies that reloading one bridge preserves the other and the shared registration.

The SDK adapter's live-media fixture produces paced H.264 until the viewer closes. A finite file is unsuitable here: the A/V relay can reach EOF and stop the session before the JPEG decoder returns its first frame. The former fixture was reproduced hanging with a one-second JPEG-decoder delay; the continuous fixture passes that same delay. Producer failure and early viewer closure reject the frame wait, and the fixture has a 15-second deadline with producer cleanup in `finally`.

CI separates bridge build, tests and dependency audit. Bridge tests have a 30-second per-test limit and a three-minute step limit; jobs have a ten-minute limit. Timeouts fail the run. No automatic retries or skipped assertions mask failures.

## Diagnostic report contract

The [collection guide](DISCOVERY_DIAGNOSTICS.md) is the user-facing reference.
This contract covers discovery, authentication and connection diagnostics. It
is not a general recorder of camera commands, event payloads or media activity.

The [library diagnostic API](https://github.com/keesmod/eufy-mega-client/blob/main/docs/DIAGNOSTICS.md)
owns bounded received cloud/discovery context. `DiscoveryIssue.deviceId` and
`context.parentId` are private correlation values and must never be serialized
into a shared report. The camera bridge owns anonymous references, lifecycle
logging, retention and the authenticated download. The HA integration owns its
version/setup context and independently validates the bridge output. Other
consumers retain their own endpoints and sessions.

`bridge/src/discovery-diagnostics.ts` constructs allowlisted records. The normal
logger prefixes their JSON with `Eufy discovery:`. Existing `Eufy backend:` error
lines remain available. `MegaBackend` supplies library and connection observations,
and `Eufy` retains setup-failure evidence when its backend is cleaned up.

The bridge's Bearer-authenticated `GET /v1/diagnostics` returns:

| Field | Meaning |
|---|---|
| `schema` | Report format version, currently integer `2` |
| `generated_at` | Download generation time in UTC ISO format with milliseconds |
| `last_discovery` | Complete latest summary, device/issue rows and end record |
| `recent_events` | At most 100 recent cloud, connection, station-connection and fault records |

Records carry `diagnostic=discovery`, `schema=2` and a UTC `timestamp`. An `event`
selects the record shape:

| Event | Contents |
|---|---|
| `summary` | Actual bridge/library/Node/platform versions, outcome, discovery counts, inventory availability, migration-baseline/missing counts, truncation and report number |
| `device` | Anonymous reference, model/firmware/hardware, observed availability, owner relationship/status and per-feature software capabilities |
| `issue` | Source inventory row, fixed reason, bounded model/type/firmware and parent context, anonymous links where known |
| `end` | Report number and number of device/issue rows emitted |
| `cloud` | Named allowlisted operation, HTTP status, numeric result and elapsed milliseconds |
| `connection` | Authentication or push-event phase, outcome, push status and software versions |
| `station_connection` | Report number, anonymous device reference, model, connect/refresh/observation phase, status and fixed reason |
| `fault` | Fixed error code and report number when available |

`report` groups discovery rows within a backend lifetime. `ref` is one-based in
that report, while `inventory_row` is the separate zero-based source position.
Neither references nor report counters are persistent identities. Recent events
can precede the latest discovery, so keep their timestamps and report numbers.
`last_discovery` describes its collection time, and later transitions belong in
`recent_events`. `generated_at` does not make old observations current.

A HomeBase status can be `not_checked`, `connected`, `disconnected` or `error`.
A camera's own station status is `not_applicable`, with `owner_status` describing
its actual owner instead. Nullable booleans must not turn unknown/error states
into a successful or failed connection. A present parent row does not prove
support, connectivity or playback. Preserve observed availability and software
capabilities as separate evidence.

### Bounds and compatibility

- Retain at most 99 device rows and 99 issue rows plus summary/end, and at most
  100 recent events. The download is cached in memory, without extra cloud or
  device calls. Restarting loses earlier retained events and collects new startup
  evidence. Do not introduce unbounded retention or polling for logging.
- Models are exactly five characters matching `T[A-Z0-9]{4}`. Device types are
  integers from 0 through 65535. Numeric dotted versions contain one to four
  components of one to four digits, with a maximum length of 19. Do not coerce,
  trim, truncate or infer rejected values. Use fixed enum/error-code allowlists.
- Unchanged discovery logs emit only summary/end with `unchanged=true` and zero
  emitted rows. The download still contains complete rows. Repeated identical
  connection states and consecutive identical generic faults are suppressed.
  Error phases and changes of state remain distinguishable.
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
source first and regenerate `ha_app` with `scripts/prepare_ha_app.py`.

Test the public-library to bridge/logger/download path and the independent HA
filter. Cover hostile values, missing context, anonymous correlation, accepted
and rejected mixed inventories, failed/empty setup, authentication on the endpoint,
bounded retention, deduplication and preservation of complete downloads. Include
connection loss/recovery when that path changes. Synthetic diagnostics tests must
not open live camera streams or access production accounts.

Existing coverage lives in `bridge/test/discovery-diagnostics.test.ts`,
`bridge/test/mega-backend.test.ts`, `bridge/test/server.test.ts`, and
`tests/test_diagnostics.py`. Follow [diagnostic release checks](RELEASING.md#diagnostic-release-checks)
when shipping a change. Markdown and issue-form wording changes alone need no
runtime version bump, deployment or live-device test.
