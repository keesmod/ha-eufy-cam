"""Fail on uv audit findings except advisories that Home Assistant pins on us.

pyproject.toml declares no runtime Python dependencies. uv.lock is the test
environment, and its homeassistant test pin brings packages that Home Assistant
requires at one exact version. A fix for those arrives only with the Home
Assistant release that moves the pin. Each exception names one locked version
and its advisory IDs. It holds only while the newest homeassistant release on
PyPI still requires exactly that version. Any other advisory, a moved pin, a
stale exception, an incomplete report or another report schema version fails
the check. Adverse package statuses become warnings, because uv audit itself
does not fail on them.
"""

import json
from pathlib import Path
import re
import sys
import urllib.request

PYPI = "https://pypi.org/pypi/homeassistant/json"
# Each exception maps ("name", "version") to a frozenset of advisory IDs, for example
# ("pillow", "12.3.0"): frozenset({"GHSA-..."}). None is needed now. The Pillow 12.3.0
# exception ended on 2026-11-06, when the test pin moved to homeassistant 2026.11.0,
# which requires Pillow==13.0.0.
EXCEPTIONS = {}


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


def read_report(path):
    """The uv audit JSON report, or SystemExit for an incomplete report or another schema version."""
    incomplete = f"{path} is not a complete uv audit report. Check the audit step's log."
    try:
        report = json.loads(Path(path).read_text())
        version = report["schema"]["version"]
    except (OSError, ValueError, KeyError, TypeError):
        raise SystemExit(incomplete) from None
    if version != "preview":
        raise SystemExit(
            f"{path} has uv audit schema version {version!r}, and this script reads only 'preview'. "
            "Update it for the pinned uv version."
        )
    if not (isinstance(report.get("vulnerabilities"), list) and isinstance(report.get("adverse_statuses"), list)):
        raise SystemExit(incomplete)
    return report


def problems(report, release, pins, exceptions=EXCEPTIONS):
    """Messages for every finding the exceptions do not cover, and every invalid exception."""
    messages = []
    accepted = {}
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
    report = read_report(sys.argv[1])
    for status in report["adverse_statuses"]:
        print("::warning title=uv audit adverse package status::" + json.dumps(status, sort_keys=True).replace("%", "%25"))
    with urllib.request.urlopen(PYPI, timeout=30) as response:
        info = json.load(response)["info"]
    messages = problems(report, info["version"], exact_pins(info["requires_dist"]))
    if messages:
        raise SystemExit("\n".join(messages))
    if not report["vulnerabilities"]:
        print(f"No advisories in uv.lock. The newest homeassistant release is {info['version']}.")
        return
    print(
        f"{len(report['vulnerabilities'])} advisories accepted while homeassistant "
        f"{info['version']} pins them: "
        + ", ".join(f"{name} {version}" for name, version in sorted(EXCEPTIONS))
    )


if __name__ == "__main__":
    main()
