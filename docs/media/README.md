# Public demonstration media

## Real Home Assistant dashboard

`ha-dashboard-demo.gif` and `ha-dashboard-demo.mp4` are a silent screen recording of the actual Home Assistant dashboard, captured on 6 September 2026. `ha-dashboard-events.png` is a frame from that video.

The walkthrough shows four camera cards, Events date/camera selection, 42 front-camera records for 5 September, and playback of the existing **22:57:13–22:57:17** HomeBase recording. The actual browser player decoded **1920×1080**, reached **4.464063 seconds**, and reported `ended: true`. Closing removed the player source and left it paused. The clip was already stored on HomeBase; it was not newly recorded from a live camera.

The published video combines captured interface segments and omits time spent between actions. It does not replace media or simulate API responses. The sidebar, front-camera/doorbell snapshots, event thumbnails, car area and view into the house are obscured for privacy. Visible garden snapshots and the remaining playback area are from the real installation. Audio is omitted from the screen recording; this demo does not establish audible camera output.

After capture, the bridge was connected with four cameras, no active recording operation and zero active or quarantined live streams. All four cached snapshots returned HTTP 200/image/jpeg. No live configuration or bridge code was changed for this recording. See [full feature validation and remaining limits](../VALIDATION_0.3.md).

Unredacted capture frames and editing intermediates stay in the ignored local artifacts directory and are not published. Only reviewed, redacted exports belong in this directory.

## Earlier illustrative walkthrough

`events-demo.gif`, `events-demo.mp4` and `events-timeline.png` show the released Events card with generated example artwork and simulated API responses. These files contain no private camera footage, account, serial number or live host connection. They demonstrate the UI, not a new hardware acceptance test. Actual HomeBase playback evidence is in [validation](../VALIDATION_0.3.md).

To reproduce with the repository's installed frontend dependencies, Playwright Chromium and FFmpeg:

```sh
cd frontend
node create-demo.mjs
```

The generator uses the checked-in card bundle, checks that example video playback advances, verifies the source is cleared on close and closes its browser in a `finally` block. Source media and intermediate recordings stay in ignored `artifacts/public-demo`. Its three illustrative outputs are retained so the original pending forum submission remains accurate until it can be updated. The README now leads with the real dashboard demo above.
