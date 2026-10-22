"""uv audit findings pass only as advisories of packages Home Assistant pins exactly."""

import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_uv_audit as audit

# Trimmed uv audit JSON report of uv.lock with certifi 2026.10.19, recorded with
# uv 0.12.24. uv 0.13.4, which CI pins, writes the same shape.
FIXTURE = Path(__file__).with_name("uv-audit-2026-10-22.json")
EXCEPTIONS = {("pillow", "12.3.0"): frozenset({"GHSA-a", "GHSA-b"})}
PINS = audit.exact_pins(["Pillow==12.3.0", "certifi>=2021.5.30"])
HOME_ASSISTANT = ["Pillow==12.3.0", "uv==0.12.23", "certifi>=2021.5.30"]


def finding(name, version, identifier):
    return {"dependency": {"name": name, "version": version}, "id": identifier}


def report(*vulnerabilities):
    return {"schema": {"version": "preview"}, "vulnerabilities": list(vulnerabilities), "adverse_statuses": []}


class UvAuditTests(unittest.TestCase):
    def check(self, data, pins=PINS):
        return audit.problems(data, "2026.10.2", pins, EXCEPTIONS)

    def run_main(self, data, requires_dist=HOME_ASSISTANT):
        """Run main() on data as report file text, with PyPI answering requires_dist."""
        pypi = json.dumps({"info": {"version": "2026.10.2", "requires_dist": requires_dist}}).encode()
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "uv-audit.json"
            path.write_text(data)
            with (
                patch.object(sys, "argv", ["check_uv_audit.py", str(path)]),
                patch.object(audit.urllib.request, "urlopen", return_value=io.BytesIO(pypi)) as urlopen,
                contextlib.redirect_stdout(output),
            ):
                audit.main()
        urlopen.assert_called_once_with(audit.PYPI, timeout=30)
        return output.getvalue()

    def test_pinned_advisories_pass(self):
        data = report(finding("pillow", "12.3.0", "GHSA-a"), finding("Pillow", "12.3.0", "GHSA-b"))
        self.assertEqual(self.check(data), [])

    def test_new_advisory_of_a_pinned_version_fails(self):
        data = report(*(finding("pillow", "12.3.0", i) for i in ("GHSA-a", "GHSA-b", "GHSA-c")))
        self.assertEqual(self.check(data), ["pillow 12.3.0: GHSA-c is not an accepted advisory"])

    def test_other_versions_and_packages_fail(self):
        data = report(
            finding("pillow", "12.3.0", "GHSA-a"),
            finding("pillow", "12.3.0", "GHSA-b"),
            finding("pillow", "12.2.0", "GHSA-a"),
            finding("certifi", "2026.7.22", "GHSA-x"),
        )
        self.assertEqual(
            self.check(data),
            [
                "pillow 12.2.0: GHSA-a is not an accepted advisory",
                "certifi 2026.7.22: GHSA-x is not an accepted advisory",
            ],
        )

    def test_moved_pin_fails(self):
        data = report(finding("pillow", "12.3.0", "GHSA-a"), finding("pillow", "12.3.0", "GHSA-b"))
        for pins in ({}, audit.exact_pins(["Pillow==13.0.0"]), audit.exact_pins(["Pillow>=12.3.0"])):
            with self.subTest(pins=pins):
                self.assertEqual(
                    self.check(data, pins),
                    [
                        "homeassistant 2026.10.2 no longer requires pillow==12.3.0. "
                        "Raise the homeassistant test pin, relock and remove this exception."
                    ],
                )

    def test_stale_exception_fails(self):
        self.assertEqual(
            self.check(report(finding("pillow", "12.3.0", "GHSA-a"))),
            ["pillow 12.3.0: remove the stale exception for GHSA-b"],
        )

    def test_only_unconditional_exact_requirements_are_pins(self):
        self.assertEqual(
            audit.exact_pins(
                [
                    "Pillow==12.3.0",
                    "uv == 0.12.23",
                    "Zope.Interface==7.0",
                    "certifi>=2021.5.30",
                    "foo==1.0; python_version < '3.13'",
                    "bar[extra]==2.0",
                    "baz==3.*",
                ]
            ),
            {"pillow": "12.3.0", "uv": "0.12.23", "zope-interface": "7.0"},
        )

    def test_recorded_report_passes_while_home_assistant_pins_both(self):
        output = self.run_main(FIXTURE.read_text())
        self.assertEqual(
            output,
            "30 advisories accepted while homeassistant 2026.10.2 pins them: pillow 12.3.0, uv 0.12.23\n",
        )

    def test_recorded_report_fails_once_home_assistant_moves_a_pin(self):
        with self.assertRaises(SystemExit) as raised:
            self.run_main(FIXTURE.read_text(), ["Pillow==13.0.0", "uv==0.12.23"])
        self.assertEqual(
            raised.exception.code,
            "homeassistant 2026.10.2 no longer requires pillow==12.3.0. "
            "Raise the homeassistant test pin, relock and remove this exception.",
        )

    def test_recorded_report_with_a_new_advisory_fails(self):
        data = json.loads(FIXTURE.read_text())
        data["vulnerabilities"].append(finding("certifi", "2026.10.19", "GHSA-new"))
        with self.assertRaises(SystemExit) as raised:
            self.run_main(json.dumps(data))
        self.assertEqual(raised.exception.code, "certifi 2026.10.19: GHSA-new is not an accepted advisory")

    def test_adverse_statuses_are_warnings(self):
        data = json.loads(FIXTURE.read_text())
        data["adverse_statuses"] = [{"name": "x", "status": "archived", "reason": "100% done"}]
        output = self.run_main(json.dumps(data))
        self.assertTrue(
            output.startswith(
                "::warning title=uv audit adverse package status::"
                '{"name": "x", "reason": "100%25 done", "status": "archived"}\n'
            )
        )
        self.assertIn("30 advisories accepted", output)

    def test_incomplete_report_fails_before_pypi(self):
        for text in ("", "{}", '{"schema": {"version": "1"}, "vulnerabilities": [], "adverse_statuses": []}', "[]"):
            with self.subTest(text=text):
                with (
                    tempfile.TemporaryDirectory() as temp,
                    patch.object(audit.urllib.request, "urlopen") as urlopen,
                ):
                    path = Path(temp) / "uv-audit.json"
                    path.write_text(text)
                    with patch.object(sys, "argv", ["check_uv_audit.py", str(path)]):
                        with self.assertRaises(SystemExit) as raised:
                            audit.main()
                urlopen.assert_not_called()
                self.assertEqual(
                    raised.exception.code,
                    f"{path} is not a complete uv audit report. Check the audit step's log.",
                )


if __name__ == "__main__":
    unittest.main()
