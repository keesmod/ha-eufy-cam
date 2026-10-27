"""Tell Validate whether a pull request or branch changes only documentation.

A documentation-only change lets Validate skip its build, test and packaging
work. Pushes to main, pull requests into another branch, release runs and every
other event keep the complete workflow. This script and
scripts/tests/test_ci_scope.py are byte-identical in eufy-mega-client and
ha-eufy-cam. Uses only Python's stdlib.
"""

import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
# Markdown at the repository root or under docs/. Other folders, such as
# app/ or .github/, ship or configure something and keep the full run.
DOCUMENTATION = re.compile(r"(?:docs/.+|[^/]+)\.md")
# Generated from source, so a test compares it with the code.
GENERATED = frozenset({"docs/DEVICE_PROFILES.md"})


def git(*args):
    return subprocess.run(
        ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout


def base(event, ref, pull_base, pull_base_ref):
    """The commit to compare with, or None when the full workflow must run."""
    # A pull request stacked on another branch runs everything, so its green
    # check stays valid when it is later retargeted to main.
    if event == "pull_request":
        return (pull_base or None) if pull_base_ref == "main" else None
    if event == "push" and ref != "refs/heads/main":
        try:
            return git("merge-base", "origin/main", "HEAD").strip()
        except subprocess.CalledProcessError:
            return None  # No history shared with main.
    return None


def docs_only(paths):
    return bool(paths) and all(
        DOCUMENTATION.fullmatch(p) and p not in GENERATED for p in paths
    )


def changed(start):
    # Without renames, a file moved into docs/ also lists its old path.
    return git("diff", "--no-renames", "--name-only", "-z", start, "HEAD").split(
        "\0"
    )[:-1]


def main():
    start = base(
        os.environ.get("GITHUB_EVENT_NAME", ""),
        os.environ.get("GITHUB_REF", ""),
        os.environ.get("BASE_SHA", ""),
        os.environ.get("BASE_REF", ""),
    )
    result = "true" if start and docs_only(changed(start)) else "false"
    print(f"Documentation-only change: {result}")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"docs_only={result}\n")


if __name__ == "__main__":
    main()
