"""Isolated Home Assistant fixtures; no live instance or Eufy cloud access."""

from unittest.mock import AsyncMock, patch

import pytest

from custom_components.eufy_viewer.api import BridgeState

STATE = {
    "protocol": 1,
    "bridge_id": "bridge-123",
    "auth": "connected",
    "cameras": [
        {
            "serial": "CAM123",
            "name": "Front door",
            "model": "TTEST",
            "hardware": "1",
            "software": "2",
            "battery": 72,
            "snapshot_received_at": "2026-09-05T10:00:00Z",
        }
    ],
}


@pytest.fixture(autouse=True)
def custom_integrations(enable_custom_integrations):
    """Enable only our custom integration in the test harness."""
    yield


@pytest.fixture
def bridge():
    """Default push bridge client, patched at its network boundary."""
    with (
        patch(
            "custom_components.eufy_viewer.api.BridgeClient.state",
            AsyncMock(return_value=BridgeState.parse(STATE)),
        ) as state,
        patch(
            "custom_components.eufy_viewer.api.BridgeClient.login",
            AsyncMock(return_value={"state": "connected"}),
        ) as login,
    ):
        yield state, login
