"""The standalone helper retains only the pre-upgrade inventory."""

import ast
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import migrate_camera as helper

STATE = {
    "protocol": 1,
    "bridge_id": "bridge-test",
    "backend": "legacy",
    "auth": "connected",
    "cameras": [{"serial": "CAM", "name": "Private name"}],
    "stations": [{"serial": "BASE"}],
    "credentials": "must not copy",
}


class MigrationHelperTests(unittest.TestCase):
    def test_helper_supports_documented_python_311(self):
        ast.parse(Path(helper.__file__).read_text(), feature_version=(3, 11))

    def test_only_allowlisted_inventory_is_retained(self):
        data = helper.inventory(STATE)
        self.assertEqual(
            data,
            {
                "version": 1,
                "bridge_id": "bridge-test",
                "backend": "legacy",
                "cameras": ["CAM"],
                "stations": ["BASE"],
            },
        )
        for changes in [
            {"auth": "error"},
            {"cameras": []},
            {"backend": "unknown"},
            {"cameras": [{"serial": "../private"}]},
            {"cameras": [{"serial": "CAM"}, {"serial": "CAM"}]},
        ]:
            with self.assertRaises(ValueError):
                helper.inventory({**STATE, **changes})

    def test_prepare_and_transfer_without_overwriting_private_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "inventory.json"
            args = ["helper", "http://127.0.0.1:8063", "--inventory", str(output)]
            new = {"bridge_id": "bridge-test", "migration": {"version": 1}}
            with (
                patch.object(sys, "argv", args),
                patch.object(helper.getpass, "getpass", return_value="synthetic-token"),
                patch("builtins.input", return_value=""),
                patch("builtins.print"),
                patch.object(
                    helper, "request", side_effect=[STATE, new, {"accepted": True}]
                ) as request,
            ):
                helper.main()
                self.assertEqual(request.call_args.args[-1], helper.inventory(STATE))
            saved = output.read_bytes()
            self.assertEqual(os.stat(output).st_mode & 0o777, 0o600)
            self.assertNotIn(b"synthetic-token", saved)
            with (
                patch.object(sys, "argv", args),
                patch.object(helper.getpass, "getpass", return_value="synthetic-token"),
                patch("builtins.input", return_value=""),
                patch("builtins.print"),
                patch.object(helper, "request", side_effect=[new, {"accepted": True}]),
            ):
                helper.main()
            self.assertEqual(output.read_bytes(), saved)

    def test_mismatched_identity_cannot_receive_the_saved_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "inventory.json"
            output.write_text(json.dumps(helper.inventory(STATE)))
            with (
                patch.object(
                    sys,
                    "argv",
                    ["helper", "http://localhost", "--inventory", str(output)],
                ),
                patch.object(helper.getpass, "getpass", return_value="synthetic-token"),
                patch("builtins.input", return_value=""),
                patch("builtins.print"),
                patch.object(
                    helper,
                    "request",
                    return_value={"bridge_id": "other", "migration": {"version": 1}},
                ) as request,
            ):
                with self.assertRaises(ValueError):
                    helper.main()
                self.assertEqual(request.call_count, 1)

    def test_redirects_do_not_forward_the_token(self):
        with self.assertRaises(ValueError):
            helper.NoRedirect().redirect_request(
                None, None, 302, "", {}, "https://other.invalid"
            )
