"""Constants for Eufy Security Viewer."""

DOMAIN = "eufy_viewer"
CONF_URL = "url"
CONF_TOKEN = "token"
CARD_URL = "/eufy_viewer/eufy-viewer-card.js"
MAX_FRAME_BYTES = 256_000
# The bridge closes a refused viewer with this code when the camera's HomeBase
# already carries its configured number of live cameras. Other codes stay generic.
STATION_LIMIT_CLOSE_CODE = 4013
# The bridge ends every live session at its own cap: 120 seconds, or its
# configured live_max_seconds_mains for a camera without a battery value. HA's
# relay follows that cap for the camera plus a short slack, so a stalled bridge
# socket still ends here and HA never ends a session the bridge still permits.
LIVE_BOUND_DEFAULT_SECONDS = 120
LIVE_BOUND_MAX_SECONDS = 3600
LIVE_RELAY_SLACK_SECONDS = 5
