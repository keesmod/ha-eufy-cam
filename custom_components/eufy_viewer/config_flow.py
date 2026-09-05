"""UI-only onboarding, authentication challenges and endpoint reconfiguration."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .api import BridgeAuthError, BridgeClient, BridgeError, normalize_url
from .const import CONF_TOKEN, CONF_URL, DOMAIN

PASSWORD = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))


class EufyViewerConfigFlow(ConfigFlow, domain=DOMAIN):
    """Configure a uniquely identified, dedicated Viewer bridge."""

    VERSION = 1
    _data: dict[str, Any]
    _api: BridgeClient
    _challenge: dict[str, Any]

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Validate the local endpoint without issuing camera commands."""
        errors: dict[str, str] = {}
        defaults = getattr(self, "_data", {})
        if user_input is not None:
            try:
                self._data = {
                    CONF_URL: normalize_url(user_input[CONF_URL]),
                    CONF_TOKEN: user_input[CONF_TOKEN],
                }
                self._api = BridgeClient(
                    async_get_clientsession(self.hass), **self._data
                )
                state = await self._api.state()
                if self.source in {"reauth", "reconfigure"}:
                    entry = (
                        self._get_reauth_entry()
                        if self.source == "reauth"
                        else self._get_reconfigure_entry()
                    )
                    if state.bridge_id != entry.unique_id:
                        return self.async_abort(reason="wrong_bridge")
                else:
                    await self.async_set_unique_id(state.bridge_id)
                    self._abort_if_unique_id_configured()
                if state.auth == "connected":
                    return self._finish()
                return await self.async_step_account()
            except BridgeAuthError:
                errors["base"] = "invalid_auth"
            except BridgeError:
                errors["base"] = "cannot_connect"
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_URL, default=defaults.get(CONF_URL, "http://")
                    ): str,
                    vol.Required(CONF_TOKEN): PASSWORD,
                }
            ),
            errors=errors,
        )

    async def async_step_account(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Authenticate the Eufy account through the bridge."""
        errors: dict[str, str] = {}
        if user_input is not None:
            return await self._login(user_input, "account")
        return self.async_show_form(
            step_id="account",
            data_schema=vol.Schema(
                {
                    vol.Required("username"): str,
                    vol.Required("password"): PASSWORD,
                    vol.Required("country", default="NL"): vol.All(
                        str, vol.Length(min=2, max=2)
                    ),
                }
            ),
            errors=errors,
        )

    async def _login(self, data: dict[str, Any], step: str) -> ConfigFlowResult:
        """Route only known authentication states, without retaining credentials."""
        try:
            result = self._challenge = await self._api.login(data)
        except BridgeAuthError:
            return self.async_abort(reason="invalid_bridge_auth")
        except BridgeError:
            return self.async_show_form(
                step_id=step,
                data_schema=self._schema(step),
                errors={"base": "cannot_connect"},
                description_placeholders=self._placeholders(step),
            )
        if result["state"] == "connected":
            return self._finish()
        if result["state"] == "verify":
            return await self.async_step_verify()
        if result["state"] == "captcha":
            return await self.async_step_captcha()
        return self.async_show_form(
            step_id=step,
            data_schema=self._schema(step),
            errors={"base": "invalid_auth"},
            description_placeholders=self._placeholders(step),
        )

    def _schema(self, step: str) -> vol.Schema:
        if step == "verify":
            return vol.Schema({vol.Required("code"): str})
        if step == "captcha":
            return vol.Schema({vol.Required("captcha"): str})
        return vol.Schema(
            {
                vol.Required("username"): str,
                vol.Required("password"): PASSWORD,
                vol.Required("country", default="NL"): str,
            }
        )

    def _placeholders(self, step: str) -> dict[str, str]:
        # Only data-URI images are rendered. Never trust a remote captcha URL.
        image = getattr(self, "_challenge", {}).get("captcha", "")
        if step == "captcha":
            if (
                not isinstance(image, str)
                or not image.startswith(
                    ("data:image/png;base64,", "data:image/jpeg;base64,")
                )
                or len(image) > 500_000
            ):
                image = ""
            return {"captcha_image": image}
        return {}

    async def async_step_verify(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Submit an Eufy verification code."""
        if user_input is not None:
            return await self._login({"verifyCode": user_input["code"]}, "verify")
        return self.async_show_form(
            step_id="verify", data_schema=self._schema("verify")
        )

    async def async_step_captcha(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Present and submit a captcha challenge."""
        if user_input is not None:
            return await self._login(
                {
                    "captchaId": self._challenge.get("captchaId"),
                    "captcha": user_input["captcha"],
                },
                "captcha",
            )
        return self.async_show_form(
            step_id="captcha",
            data_schema=self._schema("captcha"),
            description_placeholders=self._placeholders("captcha"),
        )

    def _finish(self) -> ConfigFlowResult:
        if self.source in {"reauth", "reconfigure"}:
            entry = (
                self._get_reauth_entry()
                if self.source == "reauth"
                else self._get_reconfigure_entry()
            )
            return self.async_update_reload_and_abort(entry, data_updates=self._data)
        return self.async_create_entry(title="Eufy Security Viewer", data=self._data)

    async def async_step_reauth(self, entry_data: dict[str, Any]) -> ConfigFlowResult:
        """Allow token replacement before account authentication."""
        self._data = entry_data
        return await self.async_step_user()

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Change endpoint/token while keeping the same bridge identity."""
        self._data = dict(self._get_reconfigure_entry().data)
        return await self.async_step_user()
