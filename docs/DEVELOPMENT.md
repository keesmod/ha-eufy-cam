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

Before merging, all six Validate jobs must pass for the PR's latest commit:
`home-assistant`, `hacs`, `hassfest`, `app-package`, `bridge` and `card`.
After merging, wait for the full Validate pipeline to pass on the merged `main`
commit. Build and inspect the release archives from that exact commit, then tag
it as `v<integration-version>` and publish the GitHub release with upgrade
instructions and checksums. Verify the published tag and archive versions.
Do not publish a release from a failed or still-running pipeline.

Merging a PR does not publish a release. The release checklist is complete only
after the version is available as a GitHub release for HACS users.

## Real WebRTC acceptance tests

Set `GO2RTC_BINARY` to a local go2rtc 1.9.14 executable when running the frontend tests. Without it, the three real-media tests are skipped; CI installs and verifies the executable and always runs them. Install the bridge npm dependencies too, because this fixture exercises the actual bridge media relay. FFmpeg and Chromium are required.

The fixture generates synthetic 1280×720 H.264 and a 440 Hz AAC tone, runs the actual bridge and go2rtc, and checks decoded video and inbound audio energy in Chromium. Close, navigation and frozen playback must stop the fake camera and leave zero viewers. HA dispatch and Eufy hardware are simulated; separate HA tests cover signaling permissions and cleanup. The test go2rtc media listener uses the first non-loopback IPv4 interface because Chromium omits loopback ICE; its API and RTSP listeners are loopback-only. It never uses a microphone or real camera.

## CI timing and cleanup

Home Assistant's cold component setup loads all registered config entries itself. Tests must use that setup once, or initialize the component before concurrently setting up new entries. The two-bridge test covers both paths, checks one initial state request per bridge and verifies that reloading one bridge preserves the other and the shared registration.

The SDK adapter's live-media fixture produces paced H.264 until the viewer closes. A finite file is unsuitable here: the A/V relay can reach EOF and stop the session before the JPEG decoder returns its first frame. The former fixture was reproduced hanging with a one-second JPEG-decoder delay; the continuous fixture passes that same delay. Producer failure and early viewer closure reject the frame wait, and the fixture has a 15-second deadline with producer cleanup in `finally`.

CI separates bridge build, tests and dependency audit. Bridge tests have a 30-second per-test limit and a three-minute step limit; jobs have a ten-minute limit. Timeouts fail the run. No automatic retries or skipped assertions mask failures.
