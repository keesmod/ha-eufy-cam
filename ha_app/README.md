# Eufy Security Viewer Bridge

Required local bridge for the [Eufy Security Viewer integration](https://github.com/keesmod/ha-eufy-cam).

Install this app, set a unique random `token` of at least 32 characters in Configuration, start it and enable Start on boot. Copy the hostname from Info and use `http://HOSTNAME:8080` plus the same token in the integration setup. Enter Eufy credentials only in the Home Assistant integration flow. No YAML or host port mapping is required.

This app includes Node.js 24 and FFmpeg. Initial installation builds the container. It needs access to Eufy cloud/push services and your cameras/HomeBase. Private credentials and session data persist in `/data/eufy` and must not be attached to support reports.

Live streams start only for requested viewers. Closing the last viewer stops the upstream camera; an independent local watchdog expires missing viewers. A host/power/network failure can prevent delivery of stop commands. Details and limits are in the repository README.

`src`, package manifests and tsconfig are generated from the canonical `bridge` directory by `scripts/prepare_ha_app.py`. Do not edit those generated files directly.
