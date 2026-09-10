"""Release checks and immutable GitHub publication. Uses only Python's stdlib.

The common driver is also kept in ha-eufy-cam; repository details live in
release_project.py. Keep driver fixes and their tests in sync in both repos.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

import release_project as project

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)")
COMMIT = re.compile(r"[0-9a-f]{40}")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def command(*args, cwd=ROOT, input=None):
    return subprocess.run(
        args,
        cwd=cwd,
        input=input,
        text=True,
        check=True,
        capture_output=True,
        timeout=180,
    ).stdout.strip()


def version_tuple(version):
    require(
        isinstance(version, str) and VERSION.fullmatch(version),
        "Use a stable X.Y.Z version",
    )
    return tuple(map(int, version.split(".")))


def metadata(root=ROOT, requested=None, base=None):
    result = project.metadata(root)
    version_tuple(result["version"])
    if requested is not None:
        version_tuple(requested)
        require(
            result["version"] == requested,
            "Requested version differs from repository metadata",
        )
    project.changelog(root, result["version"])
    if base:
        require(COMMIT.fullmatch(base), "Invalid base commit")
        project.check_changes(root, base, result)
    return result


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_bundle(folder, meta, commit, expected_manifest=None):
    require(COMMIT.fullmatch(commit), "Invalid source commit")
    manifest_path = folder / "release-manifest.json"
    if expected_manifest is not None:
        require(
            re.fullmatch(r"[0-9a-f]{64}", expected_manifest),
            "Missing build manifest digest",
        )
        require(
            digest(manifest_path) == expected_manifest,
            "Manifest differs from the validated build",
        )
    manifest = json.loads(manifest_path.read_text())
    require(manifest["source_commit"] == commit, "Artifacts belong to another commit")
    require(
        manifest["components"] == meta, "Artifact versions or repository do not match"
    )
    names = project.asset_names(meta)
    require(
        set(manifest["files"]) == set(names), "Unexpected or missing release archive"
    )
    checksums = []
    for name in sorted(names):
        require(Path(name).name == name, "Unsafe asset name")
        path = folder / name
        expected = manifest["files"][name]
        require(
            path.is_file() and not path.is_symlink(), "Missing or unsafe asset: " + name
        )
        require(
            path.stat().st_size == expected["size"]
            and digest(path) == expected["sha256"],
            "Corrupted asset: " + name,
        )
        checksums.append(f"{expected['sha256']}  {name}\n")
    checksums.append(f"{digest(manifest_path)}  release-manifest.json\n")
    require(
        (folder / "SHA256SUMS").read_text() == "".join(checksums),
        "Checksum manifest mismatch",
    )
    require(
        {p.name for p in folder.iterdir()}
        == {*names, "release-manifest.json", "SHA256SUMS"},
        "Unexpected files in release directory",
    )
    project.verify_archives(folder, meta)
    return manifest


def build(folder, requested=None):
    meta = metadata(requested=requested)
    require(
        command("git", "status", "--porcelain", "--untracked-files=no") == "",
        "Build from a clean committed checkout",
    )
    require(
        not folder.exists() or not any(folder.iterdir()),
        "Build into an empty release directory",
    )
    folder.mkdir(parents=True, exist_ok=True)
    project.build(ROOT, folder)
    commit = command("git", "rev-parse", "HEAD")
    files = {
        name: {"sha256": digest(folder / name), "size": (folder / name).stat().st_size}
        for name in sorted(project.asset_names(meta))
    }
    manifest = {"source_commit": commit, "components": meta, "files": files}
    path = folder / "release-manifest.json"
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    lines = [f"{info['sha256']}  {name}\n" for name, info in files.items()]
    (folder / "SHA256SUMS").write_text(
        "".join(lines) + f"{digest(path)}  release-manifest.json\n"
    )
    verify_bundle(folder, meta, commit)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"manifest_sha256={digest(path)}\n")
    print(
        json.dumps(
            {
                "version": meta["version"],
                "source_commit": commit,
                "manifest_sha256": digest(path),
            }
        )
    )


class GitHub:
    def __init__(self, repo):
        self.repo = repo

    def api(self, suffix, payload=None, missing=False):
        args = ["gh", "api", "repos/" + self.repo + suffix]
        if payload is not None:
            args.extend(["--method", "POST", "--input", "-"])
        result = subprocess.run(
            args,
            input=None if payload is None else json.dumps(payload),
            text=True,
            capture_output=True,
            timeout=60,
        )
        if missing and result.returncode and "HTTP 404" in result.stderr:
            return None
        require(result.returncode == 0, "GitHub API request failed: " + suffix)
        return json.loads(result.stdout)

    def tag_commit(self, tag):
        ref = self.api("/git/ref/tags/" + tag, missing=True)
        if ref is None:
            return None
        obj = ref["object"]
        for _ in range(5):
            if obj["type"] == "commit":
                return obj["sha"]
            require(obj["type"] == "tag", "Unsupported tag target")
            obj = self.api("/git/tags/" + obj["sha"])["object"]
        raise ValueError("Too many nested tags")

    def release(self, tag):
        return self.api("/releases/tags/" + tag, missing=True)

    def download(self, tag, folder):
        command(
            "gh", "release", "download", tag, "--repo", self.repo, "--dir", str(folder)
        )

    def create(self, tag, commit, notes):
        command(
            "gh",
            "release",
            "create",
            tag,
            "--repo",
            self.repo,
            "--verify-tag",
            "--target",
            commit,
            "--draft",
            "--title",
            tag,
            "--notes-file",
            str(notes),
        )

    def upload(self, tag, path):
        command("gh", "release", "upload", tag, str(path), "--repo", self.repo)

    def publish(self, tag):
        command(
            "gh",
            "release",
            "edit",
            tag,
            "--repo",
            self.repo,
            "--draft=false",
            "--latest",
        )


def check_remote(github, meta, commit):
    require(
        github.api("/git/ref/heads/main")["object"]["sha"] == commit,
        "main advanced; rerun the release from current main",
    )
    tag = "v" + meta["version"]
    tagged = github.tag_commit(tag)
    require(
        tagged in (None, commit),
        "Existing tag points at another commit; it will not be moved",
    )
    release = github.release(tag)
    if release:
        require(
            tagged == commit and not release["prerelease"],
            "Existing release does not match this stable candidate",
        )
    latest = github.api("/releases/latest", missing=True)
    if latest and latest["tag_name"] != tag:
        require(
            version_tuple(meta["version"])
            > version_tuple(latest["tag_name"].removeprefix("v")),
            "New stable releases must advance the latest version",
        )
    return tag, release


def verify_remote(github, tag, release, folder, meta, commit, manifest_digest):
    names = {p.name for p in folder.iterdir()}
    require(
        {a["name"] for a in release["assets"]} == names,
        "Remote asset list differs from validated build",
    )
    with tempfile.TemporaryDirectory() as temp:
        target = Path(temp)
        github.download(tag, target)
        verify_bundle(target, meta, commit, manifest_digest)
        require(
            all((target / n).read_bytes() == (folder / n).read_bytes() for n in names),
            "Downloaded assets differ from the validated files",
        )


def release_notes(meta, commit, acceptance):
    body = project.changelog(ROOT, meta["version"])
    body = re.sub(
        r"\]\((docs/[^)]+)\)",
        lambda match: (
            "]("
            + "https://github.com/"
            + meta["repository"]
            + "/blob/"
            + commit
            + "/"
            + match[1]
            + ")"
        ),
        body,
    )
    return (
        body + f"\n\nSource commit: `{commit}`\n\nValidation: {acceptance.strip()}\n\n"
        "Download checksums and exact component versions are included in the release assets.\n"
    )


def publish(folder, requested, manifest_digest, acceptance, github=None):
    require(
        os.environ.get("GITHUB_REF") == "refs/heads/main",
        "Release publication is only allowed from main",
    )
    meta = metadata(requested=requested)
    commit = os.environ.get("GITHUB_SHA", "")
    require(
        command("git", "rev-parse", "HEAD") == commit,
        "Checkout is not the workflow commit",
    )
    require(
        os.environ.get("GITHUB_REPOSITORY") == meta["repository"],
        "Wrong release repository",
    )
    require(
        len(acceptance.strip()) >= 20 and "\x00" not in acceptance,
        "Provide a sanitized acceptance summary or evidence link",
    )
    verify_bundle(folder, meta, commit, manifest_digest)
    github = github or GitHub(meta["repository"])
    tag, release = check_remote(github, meta, commit)
    expected = {p.name for p in folder.iterdir()}
    if release and not release["draft"]:
        verify_remote(github, tag, release, folder, meta, commit, manifest_digest)
        print(json.dumps({"already_published_and_verified": tag}))
        return
    if github.tag_commit(tag) is None:
        github.api("/git/refs", {"ref": "refs/tags/" + tag, "sha": commit})
    notes_text = release_notes(meta, commit, acceptance)
    if release is None:
        with tempfile.TemporaryDirectory() as temp:
            notes = Path(temp) / "notes.md"
            notes.write_text(notes_text)
            github.create(tag, commit, notes)
        release = github.release(tag)
    require(
        (release.get("body") or "").replace("\r\n", "\n").strip() == notes_text.strip(),
        "Draft release notes differ; reuse the original acceptance summary or inspect the draft",
    )
    present = {a["name"] for a in release["assets"]}
    require(present <= expected, "Draft contains unrelated assets; inspect it manually")
    # Resume only missing uploads. Never replace an existing tag or asset.
    for name in sorted(expected - present):
        github.upload(tag, folder / name)
    release = github.release(tag)
    verify_remote(github, tag, release, folder, meta, commit, manifest_digest)
    check_remote(github, meta, commit)
    github.publish(tag)
    release = github.release(tag)
    require(release and not release["draft"], "Release did not become public")
    require(github.tag_commit(tag) == commit, "Published tag changed")
    verify_remote(github, tag, release, folder, meta, commit, manifest_digest)
    print(
        json.dumps(
            {
                "published_and_verified": "https://github.com/"
                + meta["repository"]
                + "/releases/tag/"
                + tag
            }
        )
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["check", "build", "verify", "publish"])
    parser.add_argument("--version")
    parser.add_argument("--base")
    parser.add_argument("--directory", type=Path, default=ROOT / "artifacts/release")
    parser.add_argument(
        "--manifest-sha", default=os.environ.get("RELEASE_MANIFEST_SHA")
    )
    args = parser.parse_args()
    if args.action == "check":
        print(
            json.dumps(
                metadata(
                    requested=args.version, base=args.base or os.environ.get("BASE_SHA")
                )
            )
        )
    elif args.action == "build":
        build(args.directory.resolve(), args.version)
    elif args.action == "verify":
        verify_bundle(
            args.directory,
            metadata(requested=args.version),
            command("git", "rev-parse", "HEAD"),
            args.manifest_sha,
        )
        print("Release artifacts verified")
    else:
        require(
            args.version and args.manifest_sha,
            "Publication needs version and validated build digest",
        )
        publish(
            args.directory,
            args.version,
            args.manifest_sha,
            os.environ.get("RELEASE_ACCEPTANCE", ""),
        )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit("Release check failed: " + str(error))
