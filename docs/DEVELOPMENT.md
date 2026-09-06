# Development

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

Edit `frontend/eufy-viewer-card.ts`; `npm run build` emits the bundled JavaScript. Both the card and bridge compile with TypeScript strict mode.

## Real WebRTC acceptance tests

Set `GO2RTC_BINARY` to a local go2rtc 1.9.14 executable when running the frontend tests. Without it, the three real-media tests are skipped; CI installs and verifies the executable and always runs them. Install the bridge npm dependencies too, because this fixture exercises the actual bridge media relay. FFmpeg and Chromium are required.

The fixture generates synthetic 1280×720 H.264 and a 440 Hz AAC tone, runs the actual bridge and go2rtc, and checks decoded video and inbound audio energy in Chromium. Close, navigation and frozen playback must stop the fake camera and leave zero viewers. HA dispatch and Eufy hardware are simulated; separate HA tests cover signaling permissions and cleanup. The test go2rtc media listener uses the first non-loopback IPv4 interface because Chromium omits loopback ICE; its API and RTSP listeners are loopback-only. It never uses a microphone or real camera.
