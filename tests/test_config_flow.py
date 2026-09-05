"""UI setup and reauthentication must not wake devices or retain passwords."""

from unittest.mock import patch

import pytest
from homeassistant.config_entries import SOURCE_USER
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.eufy_viewer.api import BridgeAuthError, BridgeError, BridgeState
from custom_components.eufy_viewer.const import DOMAIN

from .conftest import STATE

DATA = {"url": "http://bridge:8080", "token": "x" * 32}


async def test_ui_success_and_duplicate(hass, bridge):
    with patch("custom_components.eufy_viewer.async_setup_entry", return_value=True):
        result = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": SOURCE_USER}
        )
        assert result["type"] is FlowResultType.FORM
        result = await hass.config_entries.flow.async_configure(result["flow_id"], DATA)
        assert result["type"] is FlowResultType.CREATE_ENTRY
        assert result["data"] == DATA
        assert result["result"].unique_id == "bridge-123"
        duplicate = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": SOURCE_USER}, data=DATA
        )
        assert duplicate["reason"] == "already_configured"


@pytest.mark.parametrize(
    ("error", "expected"),
    [(BridgeError(), "cannot_connect"), (BridgeAuthError(), "invalid_auth")],
)
async def test_bridge_errors(hass, bridge, error, expected):
    bridge[0].side_effect = error
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_USER}, data=DATA
    )
    assert result["errors"] == {"base": expected}


async def test_account_verify_captcha(hass, bridge):
    bridge[0].return_value = BridgeState.parse({**STATE, "auth": "unconfigured"})
    bridge[1].side_effect = [
        {"state": "verify"},
        {
            "state": "captcha",
            "captchaId": "challenge",
            "captcha": "data:image/png;base64,AA==",
        },
        {"state": "connected"},
    ]
    with patch("custom_components.eufy_viewer.async_setup_entry", return_value=True):
        result = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": SOURCE_USER}, data=DATA
        )
        assert result["step_id"] == "account"
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"],
            {"username": "test@example.com", "password": "secret", "country": "NL"},
        )
        assert result["step_id"] == "verify"
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {"code": "123456"}
        )
        assert result["step_id"] == "captcha"
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {"captcha": "abc"}
        )
        assert result["type"] is FlowResultType.CREATE_ENTRY
        assert result["data"] == DATA
        bridge[1].assert_called_with({"captchaId": "challenge", "captcha": "abc"})


async def test_reconfigure_identity(hass, bridge):
    entry = MockConfigEntry(domain=DOMAIN, unique_id="other-bridge", data=DATA)
    entry.add_to_hass(hass)
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": "reconfigure", "entry_id": entry.entry_id}
    )
    result = await hass.config_entries.flow.async_configure(result["flow_id"], DATA)
    assert result["reason"] == "wrong_bridge"


async def test_reauth_success(hass, bridge):
    entry = MockConfigEntry(domain=DOMAIN, unique_id="bridge-123", data=DATA)
    entry.add_to_hass(hass)
    with patch(
        "homeassistant.config_entries.ConfigEntries.async_reload", return_value=True
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": "reauth", "entry_id": entry.entry_id}, data=DATA
        )
        result = await hass.config_entries.flow.async_configure(result["flow_id"], DATA)
        assert result["reason"] == "reauth_successful"
