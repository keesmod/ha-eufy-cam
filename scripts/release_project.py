"""HA integration/bridge versions, dependency pin and archive checks."""

import base64
import json
from pathlib import Path
import re
import subprocess
import tomllib
import zipfile

import package as packaging

REPOSITORY = "keesmod/ha-eufy-cam"


def run(root, *args):
    return subprocess.check_output(args, cwd=root, text=True).strip()


def read_json(root, path):
    return json.loads((root / path).read_text())


def changelog(root, version, path="CHANGELOG.md"):
    match = re.search(
        r"^## " + re.escape(version) + r"(?:\s[^\n]*)?\n(.+?)(?=^## |\Z)",
        (root / path).read_text(),
        re.M | re.S,
    )
    if not match or len(match[1].strip()) < 20:
        raise ValueError("Missing substantive changelog entry in " + path)
    return match[1].strip()


def metadata(root):
    version = read_json(root, "custom_components/eufy_viewer/manifest.json")["version"]
    project = tomllib.loads((root / "pyproject.toml").read_text())["project"]
    lock = tomllib.loads((root / "uv.lock").read_text())
    uv_project = [p for p in lock["package"] if p["name"] == project["name"]]
    if (
        project["version"] != version
        or len(uv_project) != 1
        or uv_project[0]["version"] != version
    ):
        raise ValueError("Integration, pyproject and uv.lock versions must match")
    bridge = read_json(root, "bridge/package.json")
    bridge_version = bridge["version"]
    if not re.fullmatch(
        r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", bridge_version
    ):
        raise ValueError("Invalid bridge version")
    for directory in ("bridge", "ha_app"):
        package = read_json(root, directory + "/package.json")
        package_lock = read_json(root, directory + "/package-lock.json")
        if any(
            p["version"] != bridge_version
            for p in (package, package_lock, package_lock["packages"][""])
        ):
            raise ValueError("Bridge and app package/lock versions must match")
    if read_json(root, "ha_app/config.json")["version"] != bridge_version:
        raise ValueError("App configuration version must match bridge")
    for name in ("package.json", "package-lock.json", "tsconfig.json"):
        if (root / "bridge" / name).read_bytes() != (
            root / "ha_app" / name
        ).read_bytes():
            raise ValueError("Regenerate the HA app files with prepare_ha_app.py")
    for directory in ("bridge/src", "ha_app/src"):
        paths = {
            p.relative_to(root / directory)
            for p in (root / directory).rglob("*")
            if p.is_file()
        }
        if directory == "bridge/src":
            canonical = paths
        elif paths != canonical or any(
            (root / "bridge/src" / p).read_bytes()
            != (root / directory / p).read_bytes()
            for p in paths
        ):
            raise ValueError("Generated HA app source differs from canonical bridge")
    package_lock = read_json(root, "bridge/package-lock.json")
    url = bridge["dependencies"]["@keesmod/eufy-mega-client"]
    match = re.fullmatch(
        r"https://github.com/keesmod/eufy-mega-client/releases/download/v(\d+\.\d+\.\d+)/keesmod-eufy-mega-client-\1\.tgz",
        url,
    )
    dependency = package_lock["packages"]["node_modules/@keesmod/eufy-mega-client"]
    if not match or dependency["resolved"] != url or dependency["version"] != match[1]:
        raise ValueError("Mega dependency must pin the exact versioned GitHub release")
    integrity = dependency["integrity"]
    if (
        not integrity.startswith("sha512-")
        or len(base64.b64decode(integrity[7:], validate=True)) != 64
    ):
        raise ValueError("Mega dependency requires SHA512 lockfile integrity")
    resource_versions = re.findall(
        r"eufy-viewer-card\.js\?v=([\d.]+)", (root / "README.md").read_text()
    )
    if not resource_versions or any(v != version for v in resource_versions):
        raise ValueError("README card resource examples need the integration version")
    changelog(root, bridge_version, "ha_app/CHANGELOG.md")
    return {
        "repository": REPOSITORY,
        "version": version,
        "bridge": bridge_version,
        "mega_client": match[1],
        "mega_url": url,
        "mega_integrity": integrity,
    }


def production_lock(lock):
    keys = (
        "version",
        "resolved",
        "integrity",
        "dependencies",
        "optionalDependencies",
        "engines",
        "link",
    )
    return {
        name: {key: value[key] for key in keys if key in value}
        for name, value in lock["packages"].items()
        if name and not value.get("dev")
    }


def check_changes(root, base, meta):
    paths = run(root, "git", "diff", "--name-only", base, "HEAD").splitlines()

    def previous(path):
        return json.loads(run(root, "git", "show", base + ":" + path))

    old_integration = previous("custom_components/eufy_viewer/manifest.json")["version"]
    old_bridge = previous("bridge/package.json")
    current_bridge = read_json(root, "bridge/package.json")
    bridge_changed = any(
        p.startswith("bridge/src/")
        or p in {"bridge/Dockerfile", "ha_app/Dockerfile", "ha_app/bootstrap.mjs"}
        for p in paths
    )
    bridge_changed |= any(
        current_bridge.get(k) != old_bridge.get(k)
        for k in ("dependencies", "optionalDependencies", "engines")
    )
    bridge_changed |= production_lock(
        previous("bridge/package-lock.json")
    ) != production_lock(read_json(root, "bridge/package-lock.json"))
    old_app = previous("ha_app/config.json")
    new_app = read_json(root, "ha_app/config.json")
    old_app.pop("version")
    new_app.pop("version")
    bridge_changed |= old_app != new_app
    integration_changed = bridge_changed or any(
        p.startswith("custom_components/eufy_viewer/") for p in paths
    )
    newer = lambda a, b: tuple(map(int, a.split("."))) > tuple(map(int, b.split(".")))
    if bridge_changed and not newer(meta["bridge"], old_bridge["version"]):
        raise ValueError("Bridge runtime changes require a bridge version bump")
    if integration_changed and not newer(meta["version"], old_integration):
        raise ValueError(
            "Runtime changes require a new integration/repository release version"
        )


def asset_names(meta):
    return [
        f"eufy-viewer-integration-{meta['version']}.zip",
        f"eufy-viewer-bridge-{meta['bridge']}.zip",
        f"ha-eufy-cam-source-{meta['version']}.zip",
    ]


def verify_archives(folder, meta):
    root = Path(__file__).resolve().parents[1]
    for name, expected in packaging.members(root).items():
        with zipfile.ZipFile(folder / name) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or set(names) != expected:
                raise ValueError("Unexpected or missing files in " + name)
            for path in names:
                if archive.read(path) != (root / path).read_bytes():
                    raise ValueError("Archive differs from checked source: " + path)


def build(root, folder):
    packaging.build(folder, root)
    verify_archives(folder, metadata(root))
