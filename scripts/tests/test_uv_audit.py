"""uv audit findings pass only as advisories of packages Home Assistant pins exactly."""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_uv_audit as audit

EXCEPTIONS = {("pillow", "12.3.0"): frozenset({"GHSA-a", "GHSA-b"})}
PINS = audit.exact_pins(["Pillow==12.3.0", "certifi>=2021.5.30"])


def finding(name, version, identifier):
    return {"dependency": {"name": name, "version": version}, "id": identifier}


def report(*vulnerabilities, adverse=()):
    return {"vulnerabilities": list(vulnerabilities), "adverse_statuses": list(adverse)}


class UvAuditTests(unittest.TestCase):
    def check(self, data, pins=PINS):
        return audit.problems(data, "2026.10.2", pins, EXCEPTIONS)

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

    def test_adverse_status_fails(self):
        data = report(
            finding("pillow", "12.3.0", "GHSA-a"),
            finding("pillow", "12.3.0", "GHSA-b"),
            adverse=[{"dependency": {"name": "x", "version": "1"}}],
        )
        self.assertEqual(self.check(data), ["uv audit reported 1 adverse package statuses"])

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

    def test_current_report_shape_is_accepted(self):
        data = report(
            *(finding(name, version, i) for (name, version), ids in audit.EXCEPTIONS.items() for i in ids)
        )
        pins = {name: version for name, version in audit.EXCEPTIONS}
        self.assertEqual(audit.problems(data, "2026.10.2", pins), [])


if __name__ == "__main__":
    unittest.main()
