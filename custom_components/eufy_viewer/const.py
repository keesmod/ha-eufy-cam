"""Constants for Eufy Security Viewer."""

DOMAIN = "eufy_viewer"
CONF_URL = "url"
CONF_TOKEN = "token"
CARD_URL = "/eufy_viewer/eufy-viewer-card.js"
MAX_FRAME_BYTES = 256_000
# The bridge closes a refused viewer with this code when the camera's HomeBase
# already carries its configured number of live cameras. Other codes stay generic.
STATION_LIMIT_CLOSE_CODE = 4013
