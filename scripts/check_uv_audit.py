"""Fail on uv audit findings except advisories that Home Assistant pins on us.

pyproject.toml declares no runtime Python dependencies. uv.lock is the test
environment, and its homeassistant test pin brings packages that Home Assistant
requires at one exact version. A fix for those arrives only with the Home
Assistant release that moves the pin. Each exception names one locked version
and its advisory IDs. It holds only while the newest homeassistant release on
PyPI still requires exactly that version. Any other advisory, an adverse package
status, a moved pin or a stale exception fails the check.
"""

import json
from pathlib import Path
import re
import sys
import urllib.request

PYPI = "https://pypi.org/pypi/homeassistant/json"
EXCEPTIONS = {
    # homeassistant 2026.10.0 to 2026.10.2 require Pillow==12.3.0. Fixed in 13.0.0.
    ("pillow", "12.3.0"): frozenset(
        {
            "GHSA-22hg-r758-rrw9",
            "GHSA-254f-3936-288h",
            "GHSA-27h8-gf7j-v5hc",
            "GHSA-332p-7hrc-92wf",
            "GHSA-4558-3h8r-v8xp",
            "GHSA-462x-pgg6-55fp",
            "GHSA-4rr5-89j8-mwwm",
            "GHSA-58r4-6rv3-gfh8",
            "GHSA-5xm2-6676-qcp9",
            "GHSA-65qm-jvmh-6pqg",
            "GHSA-74r2-7ff9-mjj2",
            "GHSA-7mwm-ghpf-9vrm",
            "GHSA-8g5g-8vmr-9782",
            "GHSA-c6hw-5grf-ff96",
            "GHSA-cp9v-662q-vvx9",
            "GHSA-f2g6-542v-9j58",
            "GHSA-fc9g-5qg7-mf45",
            "GHSA-gg2r-wvfm-q9rx",
            "GHSA-j4m9-6w36-pw47",
            "GHSA-jg86-v3jv-hrpm",
            "GHSA-p4wg-p73j-c528",
            "GHSA-pchr-8j38-3x4p",
            "GHSA-q45j-58j2-45rg",
            "GHSA-rfgq-q3w2-pmv2",
            "GHSA-vx6w-vv9f-6gvg",
            "GHSA-w889-685w-c8fh",
            "GHSA-xgh8-jp6q-p5x8",
            "GHSA-xvh5-g6gv-559v",
        }
    ),
    # homeassistant 2026.10.0 to 2026.10.2 require uv==0.12.23. Fixed in 0.13.4.
    ("uv", "0.12.23"): frozenset({"GHSA-hq85-5cpj-mr62", "PYSEC-2026-4321"}),
}


def normalize(name):
    """PEP 503 normalized package name."""
    return re.sub(r"[-_.]+", "-", name).lower()


def exact_pins(requires_dist):
    """{name: version} of requirements without extras or markers that use ==."""
    pins = {}
    for requirement in requires_dist or ():
        match = re.fullmatch(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([^\s,;*]+)\s*", requirement)
        if match:
            pins[normalize(match[1])] = match[2]
    return pins


def problems(report, release, pins, exceptions=EXCEPTIONS):
    """Messages for every finding the exceptions do not cover, and every invalid exception."""
    messages = []
    accepted = {}
    if report["adverse_statuses"]:
        messages.append(f"uv audit reported {len(report['adverse_statuses'])} adverse package statuses")
    for vulnerability in report["vulnerabilities"]:
        dependency = vulnerability["dependency"]
        key = (normalize(dependency["name"]), dependency["version"])
        if vulnerability["id"] in exceptions.get(key, ()):
            accepted.setdefault(key, set()).add(vulnerability["id"])
        else:
            messages.append(f"{key[0]} {key[1]}: {vulnerability['id']} is not an accepted advisory")
    for (name, version), ids in sorted(exceptions.items()):
        if pins.get(name) != version:
            messages.append(
                f"homeassistant {release} no longer requires {name}=={version}. "
                "Raise the homeassistant test pin, relock and remove this exception."
            )
        stale = sorted(ids - accepted.get((name, version), set()))
        if stale:
            messages.append(f"{name} {version}: remove the stale exception for {', '.join(stale)}")
    return messages


def main():
    report = json.loads(Path(sys.argv[1]).read_text())
    with urllib.request.urlopen(PYPI, timeout=30) as response:
        info = json.load(response)["info"]
    messages = problems(report, info["version"], exact_pins(info["requires_dist"]))
    if messages:
        raise SystemExit("\n".join(messages))
    print(
        f"{len(report['vulnerabilities'])} advisories accepted while homeassistant "
        f"{info['version']} pins them: "
        + ", ".join(f"{name} {version}" for name, version in sorted(EXCEPTIONS))
    )


if __name__ == "__main__":
    main()
