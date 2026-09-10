"""Release safety regressions. All GitHub operations use an in-memory fake."""

import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import release

SHA = "a" * 40
META = {"repository": "owner/example", "version": "0.2.0"}


class FakeGitHub:
    def __init__(self):
        self.head = SHA
        self.tagged = None
        self.current = None
        self.latest = {"tag_name": "v0.1.0"}
        self.files = {}
        self.uploads = []
        self.publications = 0
        self.corrupt = False
        self.advance = False

    def api(self, path, payload=None, missing=False):
        if path == "/git/ref/heads/main":
            return {"object": {"sha": self.head}}
        if path == "/releases/latest":
            return self.latest
        if path == "/git/refs":
            self.tagged = payload["sha"]
            return {}
        raise AssertionError(path)

    def tag_commit(self, tag):
        return self.tagged

    def release(self, tag):
        if self.current is None:
            return None
        return {**self.current, "assets": [{"name": n} for n in self.files]}

    def create(self, tag, commit, notes):
        assert self.tagged == commit
        assert "Validation:" in notes.read_text()
        self.current = {"draft": True, "prerelease": False, "body": notes.read_text()}

    def upload(self, tag, path):
        assert path.name not in self.files
        self.files[path.name] = path.read_bytes()
        self.uploads.append(path.name)

    def download(self, tag, folder):
        for name, body in self.files.items():
            (folder / name).write_bytes(
                body + (b"broken" if self.corrupt and name == "fixture.tgz" else b"")
            )
        if self.advance:
            self.head = "b" * 40

    def publish(self, tag):
        self.current["draft"] = False
        self.publications += 1


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        body = b"synthetic package contents"
        (self.folder / "fixture.tgz").write_bytes(body)
        manifest = {
            "source_commit": SHA,
            "components": META,
            "files": {
                "fixture.tgz": {
                    "sha256": hashlib.sha256(body).hexdigest(),
                    "size": len(body),
                }
            },
        }
        (self.folder / "release-manifest.json").write_text(json.dumps(manifest))
        self.manifest_digest = release.digest(self.folder / "release-manifest.json")
        (self.folder / "SHA256SUMS").write_text(
            f"{hashlib.sha256(body).hexdigest()}  fixture.tgz\n{self.manifest_digest}  release-manifest.json\n"
        )
        for target, value in [
            ("release.project.asset_names", lambda meta: ["fixture.tgz"]),
            ("release.project.verify_archives", lambda folder, meta: None),
            (
                "release.project.changelog",
                lambda root, version: "Tested release notes.",
            ),
            ("release.metadata", lambda **kwargs: copy.deepcopy(META)),
            ("release.command", lambda *args, **kwargs: SHA),
        ]:
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.dict(
            os.environ,
            {
                "GITHUB_REF": "refs/heads/main",
                "GITHUB_SHA": SHA,
                "GITHUB_REPOSITORY": META["repository"],
            },
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def publish(self, github):
        release.publish(
            self.folder,
            META["version"],
            self.manifest_digest,
            "Synthetic protocol tests; hardware unchanged.",
            github,
        )

    def test_valid_bundle_and_publication(self):
        github = FakeGitHub()
        self.publish(github)
        self.assertEqual(github.publications, 1)
        self.assertFalse(github.current["draft"])
        self.assertEqual(len(github.uploads), 3)

    def test_identical_published_release_is_verified_without_writes(self):
        github = FakeGitHub()
        self.publish(github)
        uploads = list(github.uploads)
        self.publish(github)
        self.assertEqual(github.publications, 1)
        self.assertEqual(github.uploads, uploads)

    def test_partial_draft_resumes_only_missing_uploads(self):
        github = FakeGitHub()
        github.tagged = SHA
        github.current = {
            "draft": True,
            "prerelease": False,
            "body": release.release_notes(
                META, SHA, "Synthetic protocol tests; hardware unchanged."
            ),
        }
        github.files["fixture.tgz"] = (self.folder / "fixture.tgz").read_bytes()
        self.publish(github)
        self.assertNotIn("fixture.tgz", github.uploads)
        self.assertEqual(github.publications, 1)

    def test_corrupt_download_never_becomes_public(self):
        github = FakeGitHub()
        github.corrupt = True
        with self.assertRaisesRegex(ValueError, "Corrupted asset"):
            self.publish(github)
        self.assertTrue(github.current["draft"])
        self.assertEqual(github.publications, 0)

    def test_main_advancing_during_upload_blocks_publication(self):
        github = FakeGitHub()
        github.advance = True
        with self.assertRaisesRegex(ValueError, "main advanced"):
            self.publish(github)
        self.assertEqual(github.publications, 0)

    def test_wrong_tag_is_never_moved(self):
        github = FakeGitHub()
        github.tagged = "b" * 40
        with self.assertRaisesRegex(ValueError, "will not be moved"):
            self.publish(github)
        self.assertEqual(github.tagged, "b" * 40)
        self.assertFalse(github.uploads)

    def test_older_version_cannot_replace_latest(self):
        github = FakeGitHub()
        github.latest = {"tag_name": "v0.3.0"}
        with self.assertRaisesRegex(ValueError, "advance the latest"):
            self.publish(github)
        self.assertIsNone(github.tagged)

    def test_unrelated_draft_asset_requires_inspection(self):
        github = FakeGitHub()
        github.tagged = SHA
        github.current = {
            "draft": True,
            "prerelease": False,
            "body": release.release_notes(
                META, SHA, "Synthetic protocol tests; hardware unchanged."
            ),
        }
        github.files["manual.txt"] = b"do not delete"
        with self.assertRaisesRegex(ValueError, "unrelated assets"):
            self.publish(github)
        self.assertEqual(github.files["manual.txt"], b"do not delete")

    def test_existing_manual_draft_notes_are_not_published(self):
        github = FakeGitHub()
        github.tagged = SHA
        github.current = {
            "draft": True,
            "prerelease": False,
            "body": "Unrelated manual draft",
        }
        with self.assertRaisesRegex(ValueError, "Draft release notes differ"):
            self.publish(github)
        self.assertFalse(github.uploads)
        self.assertEqual(github.publications, 0)

    def test_no_branch_publication(self):
        with patch.dict(os.environ, {"GITHUB_REF": "refs/heads/feature"}):
            with self.assertRaisesRegex(ValueError, "only allowed from main"):
                self.publish(FakeGitHub())

    def test_changed_manifest_cannot_redefine_trusted_build(self):
        (self.folder / "release-manifest.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "validated build"):
            self.publish(FakeGitHub())

    def test_no_acceptance_summary_no_publication(self):
        with self.assertRaisesRegex(ValueError, "acceptance summary"):
            release.publish(
                self.folder, META["version"], self.manifest_digest, "", FakeGitHub()
            )

    def test_assets_from_another_commit_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "another commit"):
            release.verify_bundle(self.folder, META, "b" * 40, self.manifest_digest)

    def test_unexpected_local_file_is_rejected(self):
        (self.folder / "credentials.json").write_text("synthetic")
        with self.assertRaisesRegex(ValueError, "Unexpected files"):
            self.publish(FakeGitHub())

    def test_unsafe_and_ambiguous_versions_rejected(self):
        for value in [
            "v1.0.0",
            "1.0.0;echo bad",
            "1.2",
            "01.2.3",
            "1.0.0-rc1",
            "1.0.0\n",
        ]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                release.version_tuple(value)


if __name__ == "__main__":
    unittest.main()
