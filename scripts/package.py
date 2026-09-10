"""Build deterministic install archives from tracked, allowlisted files only."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def members(root=ROOT):
    version = json.loads(
        (root / "custom_components/eufy_viewer/manifest.json").read_text()
    )["version"]
    bridge = json.loads((root / "bridge/package.json").read_text())["version"]
    tracked = (
        subprocess.check_output(["git", "ls-files", "-z"], cwd=root)
        .decode()
        .rstrip("\0")
        .split("\0")
    )
    shared = {"README.md", "LICENSE"}
    shared.update(p for p in tracked if p.startswith("docs/") and p.endswith(".md"))
    integration = shared | {p for p in tracked if p.startswith("custom_components/")}
    bridge_files = shared | {p for p in tracked if p.startswith("bridge/src/")}
    bridge_files.update(
        "bridge/" + n
        for n in (
            "package.json",
            "package-lock.json",
            "tsconfig.json",
            "Dockerfile",
            ".dockerignore",
        )
    )
    source_roots = (
        "custom_components/",
        "bridge/src/",
        "bridge/test/",
        "docs/",
        "scripts/",
        "tests/",
        ".github/",
        "ha_app/",
    )
    source = {p for p in tracked if p.startswith(source_roots)}
    source.update(
        p
        for p in tracked
        if p.startswith(("frontend/", "bridge/")) and p.count("/") == 1
    )
    source.update(
        shared
        | {
            "hacs.json",
            "pyproject.toml",
            "uv.lock",
            ".gitignore",
            "repository.yaml",
            "CHANGELOG.md",
        }
    )
    return {
        f"eufy-viewer-integration-{version}.zip": integration,
        f"eufy-viewer-bridge-{bridge}.zip": bridge_files,
        f"ha-eufy-cam-source-{version}.zip": source,
    }


def build(output, root=ROOT):
    output.mkdir(parents=True, exist_ok=True)
    for name, paths in members(root).items():
        target = output / name
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in sorted(paths):
                path = root / name
                if not path.is_file() or path.is_symlink():
                    raise ValueError("Missing file or unsupported symlink: " + name)
                info = zipfile.ZipInfo(name, (2026, 9, 5, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, path.read_bytes())
        print(f"{hashlib.sha256(target.read_bytes()).hexdigest()}  {target.name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts")
    build(parser.parse_args().output)
