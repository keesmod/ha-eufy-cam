# Eufy Security Viewer — HomeBase recordings and live video in Home Assistant

I wanted to browse recordings already stored on my Eufy HomeBase from a Home Assistant dashboard. That led to **Eufy Security Viewer**, an independent open-source integration with bundled cards and a local bridge.

Version **0.3.0** provides an **Events timeline**: choose a date, filter by camera, see stored previews and play an existing recording with previous/next navigation. The camera card also offers snapshots while idle and on-demand WebRTC live video with optional listen-only audio. Closing or leaving the viewer releases its session; the bridge expires silent viewers. There is no scheduled cloud polling loop or permanent live stream.

![Actual Home Assistant dashboard playing an existing HomeBase recording; private areas obscured](https://raw.githubusercontent.com/keesmod/ha-eufy-cam/main/docs/media/ha-dashboard-demo.gif)

*Recorded in a real Home Assistant dashboard: four cameras, date/camera selection, playback of an existing HomeBase clip from the previous day, and closing the player. Private areas and thumbnails are obscured. This silent walkthrough is edited between actions; the interface, event list and playback are real. The README links to the MP4, playback evidence and remaining limits.*

**Currently tested:** Home Assistant 2026.9.0, HomeBase 3 T8030 with firmware 3.8.6.0, four cameras, landscape and portrait recordings. Other camera models/firmware, physical iPhone background behavior and remote WebRTC routes still need wider testing.

**Installation has two parts:**

1. Install **Eufy Security Viewer Bridge** through its HA App Store repository, or use Docker.
2. Install **Eufy Security Viewer** through **HACS as a custom repository**, then add the bundled cards. The README has both installation buttons and the full setup instructions.

You need HA **2026.9.0 or newer** and a Eufy account with camera access; a dedicated shared account is recommended. Eufy cloud/login and push connectivity are still required. No cloud recording subscription is required for the tested HomeBase files. The bridge and integration update separately. Close live viewers before browsing recordings; very large clips and archives have documented limits.

I'm looking for the first **10 independent HomeBase 3 installations** to help establish a useful compatibility table. A partial result is welcome: does an existing clip play all the way through, do previews appear, and does viewing stop cleanly when you leave?

The repository includes a short test checklist, a compatibility report form and a bug report form. Please include model numbers, firmware, browser and both component versions; no serial numbers, credentials or camera footage are needed.

**Source, installation, demo and reports:** https://github.com/keesmod/ha-eufy-cam

Thanks to **bropat and the contributors to eufy-security-client**, which supplies the underlying Eufy communication. This project is not affiliated with or endorsed by Eufy/Anker and is a custom integration, not part of Home Assistant core.
