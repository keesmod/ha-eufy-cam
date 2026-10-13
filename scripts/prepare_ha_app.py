"""Generate Supervisor app folders from the canonical bridge/ and app/ sources.

The Supervisor store follows main and builds ha_app/ (stable) and ha_app_beta/
(beta) on the user's machine, so changing either folder updates that app for
its users. They are generated outputs: write them only in a stable release PR
(--release) or a beta cut (--beta). The default stages a local build context.
"""

import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
FOLDERS = {"stable": "ha_app", "beta": "ha_app_beta"}
STAGE = ROOT / "artifacts" / "ha_app" / "eufy_viewer_bridge"
BRIDGE_FILES = ("package.json", "package-lock.json", "tsconfig.json")
# The Supervisor reads every config.* file, so the canonical one has another name.
APP_CONFIG = "app_config.json"
BETA_DESCRIPTION = (
    "Beta channel of the Eufy Security Viewer Bridge for opt-in testing. "
    "Run only one of the two bridge apps."
)
BETA_NOTICE = """\
> **Beta channel for opt-in testing.** Run only one of the two bridge apps. Both
> listen on `127.0.0.1:8063` with host networking, so turn off **Start on boot**
> on the other app and stop it first. The beta app has its own `/data` and bridge
> identity. Follow the [beta steps](https://github.com/keesmod/ha-eufy-cam/blob/main/docs/INSTALLATION.md#beta-testing)
> to switch and to return.

"""


def tracked(root, directory):
    """Tracked files below directory, relative to it."""
    output = subprocess.check_output(
        ["git", "ls-files", "-z", "--", directory], cwd=root
    ).decode()
    return [p[len(directory) + 1 :] for p in output.split("\0") if p]


def store_changelog(text, version, stable):
    """Give the folder version's section the exact heading HA Core looks for.

    HA shows the update notes from the line "## <latest>" up to the first line
    that starts with "## <installed>". The old date or Unreleased suffix moves
    to the next line. No other heading changes.
    """
    pattern = re.compile(
        r"^## " + re.escape(stable) + r" - (Unreleased|\d{4}-\d{2}-\d{2})$", re.M
    )
    if len(pattern.findall(text)) != 1:
        raise ValueError("app/CHANGELOG.md needs exactly one " + stable + " section")
    return pattern.sub(lambda match: f"## {version}\n{match[1]}", text)


def render(root, channel, version):
    """Return {relative path: bytes} of the app folder for channel at version."""
    import release  # release imports release_project, which imports this module

    release.parse_version(version)
    if channel not in FOLDERS:
        raise ValueError("Unknown app channel: " + channel)
    root = Path(root)
    files = {name: (root / "bridge" / name).read_bytes() for name in BRIDGE_FILES}
    for name in tracked(root, "bridge/src"):
        files["src/" + name] = (root / "bridge/src" / name).read_bytes()
    for name in tracked(root, "app"):
        if name in files or name == "config.json":
            raise ValueError("app/" + name + " collides with a generated app file")
        if name != APP_CONFIG:
            files[name] = (root / "app" / name).read_bytes()
    source = json.loads((root / "app" / APP_CONFIG).read_text())
    if "version" in source or "name" not in source:
        raise ValueError("app/app_config.json needs a name and no version")
    config = {}
    for key, value in source.items():
        config[key] = value
        if key == "name":
            config["version"] = version
    if channel == "beta":
        config.update(
            slug="eufy_viewer_bridge_beta",
            name=config["name"] + " (beta)",
            description=BETA_DESCRIPTION,
            stage="experimental",
        )
        files["README.md"] = BETA_NOTICE.encode() + files["README.md"]
    files["config.json"] = (
        json.dumps(config, indent=2, ensure_ascii=False) + "\n"
    ).encode()
    files["CHANGELOG.md"] = store_changelog(
        files["CHANGELOG.md"].decode(), version, release.stable_part(version)
    ).encode()
    return files


def write(target, files):
    """Replace target with exactly the rendered files."""
    if target.exists():
        shutil.rmtree(target)
    for name, data in sorted(files.items()):
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def main():
    import release

    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--stage",
        type=Path,
        nargs="?",
        const=STAGE,
        metavar="DIR",
        help="write the candidate build context at the bridge version (default)",
    )
    mode.add_argument(
        "--release",
        action="store_true",
        help="stable release PR: write ha_app/ and an existing ha_app_beta/",
    )
    mode.add_argument(
        "--beta", action="store_true", help="beta cut: write ha_app_beta/"
    )
    args = parser.parse_args()
    version = json.loads((ROOT / "bridge/package.json").read_text())["version"]
    if args.release:
        release.require(
            not release.is_prerelease(version),
            "--release needs a plain X.Y.Z bridge version",
        )
        targets = {"stable": ROOT / "ha_app"}
        if (ROOT / "ha_app_beta").exists():
            targets["beta"] = ROOT / "ha_app_beta"
    elif args.beta:
        targets = {"beta": ROOT / "ha_app_beta"}
    else:
        target = (args.stage or STAGE).resolve()
        release.require(
            target == STAGE or not target.exists() or not any(target.iterdir()),
            "Stage into a new or empty directory",
        )
        targets = {"stable": target}
    for channel, target in targets.items():
        write(target, render(ROOT, channel, version))
        print(target)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit("App generation failed: " + str(error))
