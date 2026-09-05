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

Tests use mock Eufy data and local loopback servers. They must never use production credentials, discover local Eufy devices or connect to a live Home Assistant instance. Bridge media tests generate synthetic H.264 and run the real FFmpeg decoding path.

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
