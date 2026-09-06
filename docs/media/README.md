# Public demonstration media

`events-demo.gif`, `events-demo.mp4` and `events-timeline.png` show the released Events card with generated example artwork and simulated API responses. These files contain no private camera footage, account, serial number or live host connection. They demonstrate the UI, not a new hardware acceptance test. Actual HomeBase playback evidence is in [validation](../VALIDATION_0.3.md).

To reproduce with the repository's installed frontend dependencies, Playwright Chromium and FFmpeg:

```sh
cd frontend
node create-demo.mjs
```

The generator uses the checked-in card bundle, checks that example video playback advances, verifies the source is cleared on close and closes its browser in a `finally` block. Source media and intermediate recordings stay in ignored `artifacts/public-demo`. Only the three intended public outputs live here.
