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


class FakeGitHub(release.GitHub):
    def __init__(self):
        super().__init__("owner/example")
        self.head = SHA
        self.tagged = None
        self.current = None
        self.latest = {"tag_name": "v0.1.0"}
        self.files = {}
        self.uploads = []
        self.publications = 0
        self.creations = 0
        self.hide_index = False
        self.missing_id_reads = 0
        self.reads = []
        self.corrupt = False
        self.advance = False

    def snapshot(self):
        if self.current is None:
            return None
        return {
            "id": 42,
            "tag_name": "v0.2.0",
            "target_commitish": SHA,
            **self.current,
            "assets": [{"name": n} for n in self.files],
        }

    def api(self, path, payload=None, missing=False, method=None, timeout=60):
        if path == "/git/ref/heads/main":
            return {"object": {"sha": self.head}}
        if path == "/releases/latest":
            return self.latest
        if path == "/git/refs":
            self.tagged = payload["sha"]
            return {}
        if path == "/releases" and payload:
            assert self.current is None
            assert self.tagged == payload["target_commitish"]
            self.creations += 1
            self.current = dict(payload)
            return self.snapshot()
        if path == "/releases/tags/v0.2.0":
            self.reads.append(path)
            return None if self.hide_index else self.snapshot()
        if path.startswith("/releases?per_page="):
            self.reads.append(path)
            return [] if self.hide_index or self.current is None else [self.snapshot()]
        if path == "/releases/42":
            if method == "PATCH":
                assert payload == {"draft": False, "make_latest": "true"}
                self.current["draft"] = False
                self.publications += 1
            else:
                self.reads.append(path)
                if self.missing_id_reads:
                    self.missing_id_reads -= 1
                    return None
            return self.snapshot()
        raise AssertionError(path)

    def tag_commit(self, tag):
        return self.tagged

    def upload(self, tag, path):
        assert self.release_ids[tag] == 42
        assert path.name not in self.files
        self.files[path.name] = path.read_bytes()
        self.uploads.append(path.name)

    def download(self, tag, folder):
        assert self.release_ids[tag] == 42
        for name, body in self.files.items():
            (folder / name).write_bytes(
                body + (b"broken" if self.corrupt and name == "fixture.tgz" else b"")
            )
        if self.advance:
            self.head = "b" * 40


class GitHubLookupTests(unittest.TestCase):
    def test_create_retains_returned_id_without_tag_or_list_rediscovery(self):
        github = release.GitHub("owner/example")
        draft = {
            "id": 42,
            "tag_name": "v0.2.0",
            "draft": True,
            "prerelease": False,
            "target_commitish": SHA,
            "assets": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            notes = Path(directory) / "notes.md"
            notes.write_text("Exact release notes.")
            with (
                patch.object(github, "api", return_value=draft) as api,
                patch("release.command"),
            ):
                self.assertEqual(github.create("v0.2.0", SHA, notes), draft)
                self.assertEqual(github.release("v0.2.0"), draft)
                self.assertEqual(api.call_args_list[-1].args, ("/releases/42",))
                self.assertFalse(
                    any(
                        "/tags/" in call.args[0] or "?per_page" in call.args[0]
                        for call in api.call_args_list
                    )
                )

    def test_draft_omitted_by_tag_endpoint_is_found_on_later_page(self):
        github = release.GitHub("owner/example")
        draft = {
            "id": 42,
            "tag_name": "v0.2.0",
            "draft": True,
            "prerelease": False,
            "target_commitish": SHA,
            "assets": [],
        }
        with patch.object(
            github,
            "api",
            side_effect=[None, [{"tag_name": "v0.1.0", "id": 1}] * 100, [draft], draft],
        ) as api:
            self.assertEqual(github.release("v0.2.0"), draft)
            self.assertEqual(api.call_args_list[-1].args, ("/releases/42",))

    def test_missing_release_does_not_select_unrelated_draft(self):
        github = release.GitHub("owner/example")
        with patch.object(
            github,
            "api",
            side_effect=[None, [{"tag_name": "v0.1.0", "id": 1, "draft": True}]],
        ):
            self.assertIsNone(github.release("v0.2.0"))

    def test_public_release_uses_tag_endpoint(self):
        github = release.GitHub("owner/example")
        public = {"id": 42, "tag_name": "v0.2.0", "draft": False}
        with patch.object(github, "api", return_value=public) as api:
            self.assertEqual(github.release("v0.2.0"), public)
            api.assert_called_once()

    def test_id_reads_retry_only_temporary_absence(self):
        github = release.GitHub("owner/example")
        github.release_ids["v0.2.0"] = 42
        result = {"id": 42, "tag_name": "v0.2.0", "draft": True}
        with (
            patch.object(github, "api", side_effect=[None, None, result]) as api,
            patch("release.time.sleep") as sleep,
        ):
            self.assertEqual(github.release("v0.2.0"), result)
            self.assertEqual(api.call_count, 3)
            self.assertTrue(
                all(
                    c.args == ("/releases/42",)
                    and c.kwargs == {"missing": True, "timeout": 10}
                    for c in api.call_args_list
                )
            )
            self.assertEqual([c.args[0] for c in sleep.call_args_list], [1, 2])

    def test_id_read_exhaustion_and_api_errors_fail_closed(self):
        github = release.GitHub("owner/example")
        github.release_ids["v0.2.0"] = 42
        with (
            patch.object(github, "api", return_value=None) as api,
            patch("release.time.sleep") as sleep,
        ):
            with self.assertRaisesRegex(ValueError, "bounded reads"):
                github.release("v0.2.0")
            self.assertEqual(api.call_count, 4)
            self.assertEqual([c.args[0] for c in sleep.call_args_list], [1, 2, 4])
        with (
            patch.object(
                github, "api", side_effect=ValueError("authentication failed")
            ) as api,
            patch("release.time.sleep") as sleep,
        ):
            with self.assertRaisesRegex(ValueError, "authentication failed"):
                github.release("v0.2.0")
            api.assert_called_once()
            sleep.assert_not_called()

    def test_mismatched_or_invalid_release_identity_is_rejected(self):
        for result in [
            {"id": 43, "tag_name": "v0.2.0"},
            {"id": 42, "tag_name": "v9.9.9"},
            {"id": True, "tag_name": "v0.2.0"},
        ]:
            github = release.GitHub("owner/example")
            github.release_ids["v0.2.0"] = 42
            with (
                self.subTest(result=result),
                patch.object(github, "api", return_value=result),
                self.assertRaises(ValueError),
            ):
                github.release("v0.2.0")

    def test_upload_and_publication_use_confirmed_id(self):
        github = release.GitHub("owner/example")
        github.release_ids["v0.2.0"] = 42
        with patch("release.command") as command:
            github.upload("v0.2.0", Path("/tmp/file name.zip"))
            self.assertIn(
                "https://uploads.github.com/repos/owner/example/releases/42/assets?name=file%20name.zip",
                command.call_args.args,
            )
            self.assertNotIn("--clobber", command.call_args.args)
        result = {"id": 42, "tag_name": "v0.2.0", "draft": False}
        with patch.object(github, "api", return_value=result) as api:
            self.assertEqual(github.publish("v0.2.0"), result)
            api.assert_called_once_with(
                "/releases/42", {"draft": False, "make_latest": "true"}, method="PATCH"
            )

    def test_uncertain_writes_are_not_retried(self):
        github = release.GitHub("owner/example")
        github.release_ids["v0.2.0"] = 42
        with tempfile.TemporaryDirectory() as directory:
            notes = Path(directory) / "notes.md"
            notes.write_text("Exact release notes.")
            for operation in [
                lambda: github.create("v0.2.0", SHA, notes),
                lambda: github.publish("v0.2.0"),
            ]:
                with (
                    self.subTest(operation=operation),
                    patch.object(
                        github, "api", side_effect=TimeoutError("uncertain write")
                    ) as api,
                ):
                    with self.assertRaises(TimeoutError):
                        operation()
                    api.assert_called_once()
            with patch(
                "release.command", side_effect=TimeoutError("uncertain upload")
            ) as command:
                with self.assertRaises(TimeoutError):
                    github.upload("v0.2.0", notes)
                command.assert_called_once()

    def test_binary_download_uses_asset_id_and_preserves_bytes(self):
        github = release.GitHub("owner/example")
        github.release_ids["v0.2.0"] = 42
        payload = bytes([0, 255, 128, 13, 10])

        def run(args, **kwargs):
            self.assertIn("repos/owner/example/releases/assets/73", args)
            self.assertIn("Accept: application/octet-stream", args)
            kwargs["stdout"].write(payload)
            import subprocess

            return subprocess.CompletedProcess(args, 0)

        result = {
            "id": 42,
            "tag_name": "v0.2.0",
            "assets": [{"id": 73, "name": "package.zip"}],
        }
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(github, "api", return_value=result),
            patch("release.subprocess.run", side_effect=run),
        ):
            github.download("v0.2.0", Path(directory))
            self.assertEqual((Path(directory) / "package.zip").read_bytes(), payload)


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

    def test_publication_succeeds_while_tag_and_list_remain_invisible(self):
        github = FakeGitHub()
        github.hide_index = True
        self.publish(github)
        self.assertEqual(github.creations, 1)
        self.assertEqual(github.publications, 1)
        self.assertEqual(
            github.reads[:2], ["/releases/tags/v0.2.0", "/releases?per_page=100&page=1"]
        )
        self.assertTrue(all(path == "/releases/42" for path in github.reads[2:]))

    def test_delayed_id_lookup_does_not_repeat_creation_or_upload(self):
        github = FakeGitHub()
        github.missing_id_reads = 2
        with patch("release.time.sleep"):
            self.publish(github)
        self.assertEqual(github.creations, 1)
        self.assertEqual(github.publications, 1)
        self.assertEqual(len(github.uploads), len(set(github.uploads)))

    def test_exhausted_id_lookup_leaves_one_unpublished_draft(self):
        github = FakeGitHub()
        github.missing_id_reads = 4
        with (
            patch("release.time.sleep"),
            self.assertRaisesRegex(ValueError, "bounded reads"),
        ):
            self.publish(github)
        self.assertEqual(github.creations, 1)
        self.assertEqual(github.publications, 0)
        self.assertTrue(github.current["draft"])

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
