"""Pin the bridge to a verified eufy-mega-client release.

Usage: python3 scripts/bump_client.py X.Y.Z or X.Y.Z-beta.N

The release must be public, flagged as a prerelease exactly for a beta, and
contain only the tarball, SHA256SUMS and release-manifest.json written by the
client's release driver. Assets are downloaded by asset ID and checked against
each other and against the tag's commit. npm then writes the exact pin, and the
lock entry must carry the verified URL, version and SHA512 integrity.
"""

import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

import release

ROOT = Path(__file__).resolve().parents[1]
CLIENT = "keesmod/eufy-mega-client"
PACKAGE = "@keesmod/eufy-mega-client"


def tarball(version):
    return f"keesmod-eufy-mega-client-{version}.tgz"


def url(version):
    return (
        f"https://github.com/{CLIENT}/releases/download/v{version}/{tarball(version)}"
    )


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def verify(version, github=None):
    """Check the client release. Return its canonical URL and lock integrity."""
    github = github or release.GitHub(CLIENT)
    beta = release.is_prerelease(version)
    tag, name = "v" + version, tarball(version)
    expected = {name, "SHA256SUMS", "release-manifest.json"}
    info = github.release(tag)
    release.require(
        info is not None and info.get("draft") is False,
        f"Client {tag} is not a published release",
    )
    release.require(
        info.get("prerelease") is beta,
        f"Client {tag} must {'' if beta else 'not '}be a prerelease",
    )
    release.require(
        sorted(a["name"] for a in info["assets"]) == sorted(expected),
        f"Client {tag} assets must be exactly " + ", ".join(sorted(expected)),
    )
    with tempfile.TemporaryDirectory() as temp:
        folder = Path(temp)
        github.download(tag, folder)
        release.require(
            {p.name for p in folder.iterdir()} == expected,
            f"Client {tag} assets changed during download",
        )
        data = (folder / name).read_bytes()
        manifest_bytes = (folder / "release-manifest.json").read_bytes()
        sums = (folder / "SHA256SUMS").read_bytes()
    release.require(
        sums
        == (
            f"{sha256(data)}  {name}\n{sha256(manifest_bytes)}  release-manifest.json\n"
        ).encode(),
        f"Client {tag} SHA256SUMS does not match the downloaded assets",
    )
    manifest = json.loads(manifest_bytes)
    release.require(
        manifest.get("components") == {"repository": CLIENT, "version": version},
        f"Client {tag} manifest names another repository or version",
    )
    release.require(
        manifest.get("files") == {name: {"sha256": sha256(data), "size": len(data)}},
        f"Client {tag} manifest does not describe the tarball",
    )
    release.require(
        manifest.get("source_commit") == github.tag_commit(tag),
        f"Client {tag} manifest commit differs from the tag commit",
    )
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        member = archive.extractfile("package/package.json")
        release.require(member is not None, "Client tarball lacks package.json")
        package = json.load(member)
    release.require(
        package.get("name") == PACKAGE and package.get("version") == version,
        f"Client tarball is not {PACKAGE} {version}",
    )
    digest = base64.b64encode(hashlib.sha512(data).digest()).decode()
    return {"url": url(version), "integrity": "sha512-" + digest}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("version", help="client release version, without v")
    version = parser.parse_args().version
    release.parse_version(version)
    missing = [tool for tool in ("node", "npm") if shutil.which(tool) is None]
    release.require(
        not missing,
        "Install Node 24 with npm first. Missing: " + ", ".join(missing),
    )
    verified = verify(version)
    release.command(
        "npm",
        "install",
        "--save-exact",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        verified["url"],
        cwd=ROOT / "bridge",
    )
    package = json.loads((ROOT / "bridge/package.json").read_text())
    entry = json.loads((ROOT / "bridge/package-lock.json").read_text())["packages"][
        "node_modules/" + PACKAGE
    ]
    release.require(
        package["dependencies"][PACKAGE] == verified["url"]
        and entry.get("resolved") == verified["url"]
        and entry.get("version") == version
        and entry.get("integrity") == verified["integrity"],
        "npm wrote a pin or lock entry that differs from the verified release",
    )
    print(
        f"Pinned {PACKAGE} {version} with integrity {verified['integrity']}.\n"
        "Next: raise the bridge version above the store app versions with "
        "npm version X --no-git-tag-version in bridge/, keep or open an unpublished "
        "integration candidate, and describe the client change in the "
        "app/CHANGELOG.md and CHANGELOG.md sections. A beta client pin needs beta "
        "bridge and integration versions. A stable release needs a stable pin. "
        "In a release PR the bridge version is plain, with a dated app/CHANGELOG.md "
        "section and prepare_ha_app.py --release."
    )


if __name__ == "__main__":
    try:
        main()
    except (
        ValueError,
        KeyError,
        OSError,
        subprocess.SubprocessError,
        tarfile.TarError,
    ) as error:
        raise SystemExit("Client pin failed: " + str(error))
