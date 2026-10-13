"""Release safety regressions. All GitHub operations use an in-memory fake.

Every release_project hook is replaced, so this file stays byte-identical in
both repos. Project rules are tested in test_project.py.
"""

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import release

SHA = "a" * 40
ACCEPTANCE = "Synthetic protocol tests; hardware unchanged."


def listed(tag, draft=False):
    return {
        "id": 1,
        "tag_name": tag,
        "draft": draft,
        "prerelease": "-" in tag,
    }


class FakeGitHub(release.GitHub):
    def __init__(self, version="0.2.0"):
        super().__init__("owner/example")
        self.tag = "v" + version
        self.head = SHA
        self.tagged = None
        self.current = None
        self.created = None
        self.others = [listed("v0.1.0")]
        self.files = {}
        self.uploads = []
        self.patches = []
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
            "tag_name": self.tag,
            "target_commitish": SHA,
            **self.current,
            "assets": [{"name": n} for n in self.files],
        }

    def api(self, path, payload=None, missing=False, method=None, timeout=60):
        if path == "/git/ref/heads/main":
            return {"object": {"sha": self.head}}
        if path == "/git/refs":
            self.tagged = payload["sha"]
            return {}
        if path == "/releases" and payload:
            assert self.current is None
            assert self.tagged == payload["target_commitish"]
            self.creations += 1
            self.created = dict(payload)
            self.current = dict(payload)
            return self.snapshot()
        if path == "/releases/tags/" + self.tag:
            self.reads.append(path)
            return None if self.hide_index else self.snapshot()
        if path.startswith("/releases?per_page="):
            self.reads.append(path)
            hidden = self.hide_index or self.current is None
            return self.others + ([] if hidden else [self.snapshot()])
        if path == "/releases/42":
            if method == "PATCH":
                self.patches.append(payload)
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


class VersionTests(unittest.TestCase):
    def test_stable_and_beta_grammar(self):
        for value, parsed in [
            ("0.0.0", (0, 0, 0, None)),
            ("1.22.333", (1, 22, 333, None)),
            ("0.29.3-beta.1", (0, 29, 3, 1)),
            ("10.0.0-beta.12", (10, 0, 0, 12)),
        ]:
            with self.subTest(value=value):
                self.assertEqual(release.parse_version(value), parsed)

    def test_unsafe_and_ambiguous_versions_rejected(self):
        for value in [
            "v1.0.0",
            "1.0.0;echo bad",
            "1.2",
            "01.2.3",
            "1.0.0-rc1",
            "1.0.0\n",
            "1.0.0-beta",
            "1.0.0-beta.0",
            "1.0.0-beta.01",
            "1.0.0-beta.1\n",
            "1.0.0-beta.1.2",
            "1.0.0-BETA.1",
            "1.0.0-alpha.1",
            "1.0.0b1",
            "1.0.0-beta.1+build",
            "１.0.0",
            "",
            None,
            100,
        ]:
            for function in (
                release.parse_version,
                release.version_key,
                release.is_prerelease,
                release.stable_part,
            ):
                with (
                    self.subTest(value=value, function=function.__name__),
                    self.assertRaises(ValueError),
                ):
                    function(value)

    def test_semver_precedence(self):
        ordered = [
            "0.8.46",
            "0.8.47-beta.1",
            "0.8.47-beta.2",
            "0.8.47-beta.10",
            "0.8.47",
            "0.8.48-beta.1",
            "0.9.0-beta.1",
            "0.9.0",
            "0.10.0",
            "1.0.0",
        ]
        for shuffled in (list(reversed(ordered)), ordered[1::2] + ordered[::2]):
            self.assertEqual(sorted(shuffled, key=release.version_key), ordered)

    def test_prerelease_flag_and_stable_part(self):
        self.assertFalse(release.is_prerelease("0.29.3"))
        self.assertTrue(release.is_prerelease("0.29.3-beta.1"))
        self.assertEqual(release.stable_part("0.29.3-beta.4"), "0.29.3")
        self.assertEqual(release.stable_part("0.29.3"), "0.29.3")


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

    def test_release_inventory_is_paginated_and_validated(self):
        github = release.GitHub("owner/example")
        first = [{"tag_name": f"v0.1.{n}", "id": n + 1} for n in range(100)]
        with patch.object(
            github, "api", side_effect=[first, [{"tag_name": "v0.2.0", "id": 101}]]
        ) as api:
            self.assertEqual(len(list(github.releases())), 101)
            self.assertEqual(
                [c.args[0] for c in api.call_args_list],
                ["/releases?per_page=100&page=1", "/releases?per_page=100&page=2"],
            )
        for page in ({}, [None], [{}], [{"tag_name": 1}]):
            with (
                self.subTest(page=page),
                patch.object(github, "api", return_value=page),
                self.assertRaisesRegex(ValueError, "Invalid release inventory"),
            ):
                list(github.releases())

    def test_only_not_found_is_treated_as_absence(self):
        github = release.GitHub("owner/example")
        for code, missing, absent in [
            ("HTTP 404", True, True),
            ("HTTP 404", False, False),
            ("HTTP 401", True, False),
            ("HTTP 502", True, False),
        ]:
            failure = subprocess.CompletedProcess(
                [], 1, stdout="", stderr="gh: request failed (" + code + ")"
            )
            with (
                self.subTest(code=code, missing=missing),
                patch("release.subprocess.run", return_value=failure),
            ):
                if absent:
                    self.assertIsNone(github.api("/releases/tags/v0.2.0", missing=True))
                else:
                    with self.assertRaisesRegex(ValueError, "request failed"):
                        github.api("/releases/tags/v0.2.0", missing=missing)

    def test_published_means_a_tag_or_any_release_with_that_tag(self):
        draft = {"id": 42, "tag_name": "v0.2.0-beta.1", "draft": True}
        others = [{"tag_name": "v0.1.0", "id": 1}] * 100
        for responses, expected in [
            ([{"object": {"type": "commit", "sha": SHA}}], True),
            ([None, None, others, [draft], draft], True),
            ([None, None, others, []], False),
        ]:
            github = release.GitHub("owner/example")
            with (
                self.subTest(expected=expected, calls=len(responses)),
                patch.object(github, "api", side_effect=responses) as api,
            ):
                self.assertIs(release.published(github, "0.2.0-beta.1"), expected)
                self.assertEqual(api.call_count, len(responses))
                self.assertEqual(
                    api.call_args_list[0].args, ("/git/ref/tags/v0.2.0-beta.1",)
                )
        github = release.GitHub("owner/example")
        with (
            patch.object(github, "api", side_effect=ValueError("authentication")),
            self.assertRaisesRegex(ValueError, "authentication"),
        ):
            release.published(github, "0.2.0")
        with patch.object(github, "api") as api, self.assertRaises(ValueError):
            release.published(github, "v0.2.0")
        api.assert_not_called()

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
        result = {"id": 42, "tag_name": "v0.2.0", "draft": False, "prerelease": False}
        with patch.object(github, "api", return_value=result) as api:
            self.assertEqual(github.publish("v0.2.0"), result)
            api.assert_called_once_with(
                "/releases/42", {"draft": False, "make_latest": "true"}, method="PATCH"
            )

    def test_prerelease_flag_and_latest_follow_the_version(self):
        with tempfile.TemporaryDirectory() as directory:
            notes = Path(directory) / "notes.md"
            notes.write_text("Exact release notes.")
            for tag, prerelease, latest in [
                ("v0.2.0", False, "true"),
                ("v0.2.0-beta.1", True, "false"),
            ]:
                github = release.GitHub("owner/example")
                draft = {
                    "id": 42,
                    "tag_name": tag,
                    "draft": True,
                    "prerelease": prerelease,
                    "target_commitish": SHA,
                    "assets": [],
                }
                with (
                    self.subTest(tag=tag),
                    patch.object(github, "api", return_value=draft) as api,
                ):
                    github.create(tag, SHA, notes)
                    self.assertIs(api.call_args.args[1]["prerelease"], prerelease)
                    self.assertIs(api.call_args.args[1]["draft"], True)
                with patch.object(
                    github, "api", return_value={**draft, "draft": False}
                ) as api:
                    github.publish(tag)
                    api.assert_called_once_with(
                        "/releases/42",
                        {"draft": False, "make_latest": latest},
                        method="PATCH",
                    )

    def test_responses_with_the_wrong_prerelease_flag_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            notes = Path(directory) / "notes.md"
            notes.write_text("Exact release notes.")
            for tag, prerelease in [("v0.2.0", False), ("v0.2.0-beta.1", True)]:
                github = release.GitHub("owner/example")
                wrong = {
                    "id": 42,
                    "tag_name": tag,
                    "draft": True,
                    "prerelease": not prerelease,
                    "target_commitish": SHA,
                }
                with self.subTest(tag=tag):
                    with (
                        patch.object(github, "api", return_value=wrong),
                        self.assertRaisesRegex(ValueError, "draft candidate"),
                    ):
                        github.create(tag, SHA, notes)
                    with (
                        patch.object(
                            github, "api", return_value={**wrong, "draft": False}
                        ),
                        self.assertRaisesRegex(ValueError, "prerelease flag"),
                    ):
                        github.publish(tag)

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


class MetadataTests(unittest.TestCase):
    """Hook invocation and the main push backstop in a scratch repository."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.meta = {"repository": "owner/example", "version": "0.2.0"}
        self.hooks = {}
        for name in (
            "metadata",
            "changelog",
            "check_changes",
            "check_release",
            "runtime_changed",
        ):
            # create=True keeps this file independent of a project's progress.
            patcher = patch.object(release.project, name, create=True)
            self.hooks[name] = patcher.start()
            self.addCleanup(patcher.stop)
        self.hooks["metadata"].side_effect = lambda root: copy.deepcopy(self.meta)
        self.hooks["changelog"].return_value = "Tested release notes."
        self.hooks["runtime_changed"].return_value = True
        patcher = patch.dict(
            os.environ,
            {"GITHUB_EVENT_NAME": "pull_request", "GITHUB_REF": "refs/pull/1/merge"},
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.git("init", "-q")

    def git(self, *args):
        return subprocess.run(
            [
                "git",
                "-c",
                "user.name=Release test",
                "-c",
                "user.email=release-test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "tag.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
                *args,
            ],
            cwd=self.root,
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout.strip()

    def commit(self, message):
        self.git("commit", "--allow-empty", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def tag(self, name, annotated):
        self.git("tag", "-f", *(["-a", "-m", name] if annotated else []), name)

    def push(self, event="push", ref="refs/heads/main"):
        return patch.dict(os.environ, {"GITHUB_EVENT_NAME": event, "GITHUB_REF": ref})

    def test_requested_release_runs_release_rules(self):
        self.assertEqual(release.metadata(self.root, requested="0.2.0"), self.meta)
        self.hooks["changelog"].assert_called_once_with(self.root, "0.2.0")
        self.hooks["check_release"].assert_called_once_with(self.root, self.meta)
        self.hooks["check_changes"].assert_not_called()

    def test_beta_metadata_passes_its_full_version_to_the_hooks(self):
        self.meta["version"] = "0.2.0-beta.3"
        release.metadata(self.root, requested="0.2.0-beta.3")
        self.hooks["changelog"].assert_called_once_with(self.root, "0.2.0-beta.3")
        self.hooks["check_release"].assert_called_once_with(self.root, self.meta)

    def test_requested_version_must_match_metadata(self):
        for requested, message in [
            ("0.2.0-beta.1", "differs from repository metadata"),
            ("v0.2.0", "X.Y.Z or X.Y.Z-beta.N"),
        ]:
            with (
                self.subTest(requested=requested),
                self.assertRaisesRegex(ValueError, message),
            ):
                release.metadata(self.root, requested=requested)
        self.hooks["check_release"].assert_not_called()

    def test_invalid_metadata_version_is_rejected_before_other_hooks(self):
        self.meta["version"] = "0.2.0-rc.1"
        with self.assertRaisesRegex(ValueError, "X.Y.Z or X.Y.Z-beta.N"):
            release.metadata(self.root, requested="0.2.0-rc.1")
        self.hooks["changelog"].assert_not_called()
        self.hooks["check_release"].assert_not_called()

    def test_pull_request_check_runs_change_rules_only(self):
        release.metadata(self.root, base=SHA)
        self.hooks["check_changes"].assert_called_once_with(self.root, SHA, self.meta)
        self.hooks["check_release"].assert_not_called()
        with self.assertRaisesRegex(ValueError, "Invalid base commit"):
            release.metadata(self.root, base="HEAD~1")

    def test_push_backstop_accepts_a_tag_at_head(self):
        self.commit("release")
        for annotated in (False, True):
            self.tag("v0.2.0", annotated)
            with self.subTest(annotated=annotated), self.push():
                self.assertEqual(release.metadata(self.root), self.meta)
        self.hooks["runtime_changed"].assert_not_called()

    def test_push_backstop_rejects_runtime_changes_after_the_tag(self):
        for version in ("0.2.0", "0.2.0-beta.1"):
            for annotated in (False, True):
                self.meta["version"] = version
                tagged = self.commit("release")
                self.tag("v" + version, annotated)
                self.commit("merged runtime change")
                with (
                    self.subTest(version=version, annotated=annotated),
                    self.push(),
                    self.assertRaisesRegex(
                        ValueError,
                        f"published version {version}; open a PR that raises",
                    ),
                ):
                    release.metadata(self.root)
                self.hooks["runtime_changed"].assert_called_with(self.root, tagged)

    def test_push_backstop_accepts_other_changes_after_the_tag(self):
        self.hooks["runtime_changed"].return_value = False
        tagged = self.commit("release")
        self.tag("v0.2.0", False)
        self.commit("documentation")
        with self.push():
            release.metadata(self.root)
        self.hooks["runtime_changed"].assert_called_once_with(self.root, tagged)

    def test_push_backstop_ignores_other_tags_and_events(self):
        self.commit("release")
        self.tag("v0.1.0", False)
        self.tag("v0.2.0-beta.1", False)
        self.commit("candidate")
        with self.push():
            release.metadata(self.root)
        self.tag("v0.2.0", False)
        self.commit("merged runtime change")
        for event, ref in [
            ("push", "refs/heads/feature"),
            ("pull_request", "refs/heads/main"),
            ("workflow_dispatch", "refs/heads/main"),
        ]:
            with self.subTest(event=event, ref=ref), self.push(event, ref):
                release.metadata(self.root)
        with self.push():
            release.metadata(self.root, base=SHA)
        self.hooks["runtime_changed"].assert_not_called()


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.use("0.2.0")
        for target, value in [
            ("release.project.asset_names", lambda meta: ["fixture.tgz"]),
            ("release.project.verify_archives", lambda folder, meta: None),
            (
                "release.project.changelog",
                lambda root, version: "Tested release notes.",
            ),
            ("release.metadata", lambda **kwargs: copy.deepcopy(self.meta)),
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
                "GITHUB_REPOSITORY": self.meta["repository"],
            },
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def use(self, version):
        """Write the synthetic validated build for version."""
        self.meta = {"repository": "owner/example", "version": version}
        body = b"synthetic package contents"
        (self.folder / "fixture.tgz").write_bytes(body)
        manifest = {
            "source_commit": SHA,
            "components": self.meta,
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

    def publish(self, github):
        release.publish(
            self.folder,
            self.meta["version"],
            self.manifest_digest,
            ACCEPTANCE,
            github,
        )

    def draft(self, github, prerelease):
        github.tagged = SHA
        github.current = {
            "draft": True,
            "prerelease": prerelease,
            "body": release.release_notes(self.meta, SHA, ACCEPTANCE),
        }

    def test_valid_bundle_and_publication(self):
        github = FakeGitHub()
        self.publish(github)
        self.assertEqual(github.publications, 1)
        self.assertFalse(github.current["draft"])
        self.assertEqual(len(github.uploads), 3)
        self.assertIs(github.created["prerelease"], False)
        self.assertEqual(github.patches, [{"draft": False, "make_latest": "true"}])

    def test_beta_is_published_as_prerelease_that_is_never_latest(self):
        self.use("0.2.0-beta.1")
        github = FakeGitHub("0.2.0-beta.1")
        self.publish(github)
        self.assertEqual(github.created["tag_name"], "v0.2.0-beta.1")
        self.assertIs(github.created["prerelease"], True)
        self.assertEqual(github.patches, [{"draft": False, "make_latest": "false"}])
        self.assertFalse(github.current["draft"])

    def test_publication_succeeds_while_tag_and_list_remain_invisible(self):
        github = FakeGitHub()
        github.hide_index = True
        self.publish(github)
        self.assertEqual(github.creations, 1)
        self.assertEqual(github.publications, 1)
        self.assertEqual(
            github.reads[:2], ["/releases/tags/v0.2.0", "/releases?per_page=100&page=1"]
        )
        # Later reads are ID lookups or the version-order inventory.
        self.assertEqual(
            set(github.reads[2:]), {"/releases/42", "/releases?per_page=100&page=1"}
        )

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
        for version in ("0.2.0", "0.2.0-beta.1"):
            with self.subTest(version=version):
                self.use(version)
                github = FakeGitHub(version)
                self.publish(github)
                uploads = list(github.uploads)
                self.publish(github)
                self.assertEqual(github.publications, 1)
                self.assertEqual(github.uploads, uploads)

    def test_partial_draft_resumes_only_missing_uploads(self):
        for version, prerelease, latest in [
            ("0.2.0", False, "true"),
            ("0.2.0-beta.1", True, "false"),
        ]:
            with self.subTest(version=version):
                self.use(version)
                github = FakeGitHub(version)
                self.draft(github, prerelease)
                github.files["fixture.tgz"] = (self.folder / "fixture.tgz").read_bytes()
                self.publish(github)
                self.assertNotIn("fixture.tgz", github.uploads)
                self.assertEqual(github.creations, 0)
                self.assertEqual(
                    github.patches, [{"draft": False, "make_latest": latest}]
                )

    def test_existing_release_with_the_other_prerelease_flag_is_rejected(self):
        for version, flag in [("0.2.0", True), ("0.2.0-beta.1", False)]:
            for public in (False, True):
                with self.subTest(version=version, public=public):
                    self.use(version)
                    github = FakeGitHub(version)
                    self.draft(github, flag)
                    github.current["draft"] = not public
                    with self.assertRaisesRegex(ValueError, "prerelease flag"):
                        self.publish(github)
                    self.assertFalse(github.uploads)
                    self.assertEqual(github.publications, 0)

    def test_new_version_must_advance_every_public_release(self):
        for version, tags, accepted in [
            ("0.2.0", ["v0.2.0-beta.3"], True),
            ("0.2.0-beta.2", ["v0.2.0-beta.1", "v0.1.9"], True),
            ("0.2.1-beta.1", ["v0.2.0"], True),
            ("0.2.0-beta.1", ["v0.2.0-beta.2"], False),
            ("0.2.0-beta.1", ["v0.2.0"], False),
            ("0.2.0", ["v0.2.1-beta.1"], False),
            ("0.2.0", ["v0.3.0", "v0.1.0"], False),
        ]:
            with self.subTest(version=version, tags=tags):
                self.use(version)
                github = FakeGitHub(version)
                github.others = [listed(tag) for tag in tags]
                if accepted:
                    self.publish(github)
                    self.assertEqual(github.publications, 1)
                else:
                    with self.assertRaisesRegex(ValueError, "advance the highest"):
                        self.publish(github)
                    self.assertIsNone(github.tagged)

    def test_drafts_and_foreign_tags_do_not_count_as_published(self):
        github = FakeGitHub()
        github.others = [
            listed("v9.9.9", draft=True),
            listed("nightly"),
            listed("v1.0"),
            listed("v1.0.0-rc.1"),
            listed("0.9.0"),
        ]
        self.publish(github)
        self.assertEqual(github.publications, 1)

    def test_older_version_cannot_replace_latest(self):
        github = FakeGitHub()
        github.others = [listed("v0.3.0")]
        with self.assertRaisesRegex(ValueError, "advance the highest"):
            self.publish(github)
        self.assertIsNone(github.tagged)

    def test_beta_release_notes_introduce_the_stable_section(self):
        versions = []

        def changelog(root, version):
            versions.append(version)
            return "Tested release notes."

        with patch("release.project.changelog", changelog):
            beta = release.release_notes(
                {"repository": "owner/example", "version": "0.2.0-beta.3"},
                SHA,
                ACCEPTANCE,
            )
            stable = release.release_notes(self.meta, SHA, ACCEPTANCE)
        self.assertTrue(
            beta.startswith(
                "This is a prerelease of 0.2.0 for opt-in testing.\n\n"
                "Tested release notes.\n\nSource commit: "
            )
        )
        self.assertTrue(stable.startswith("Tested release notes.\n\nSource commit: "))
        self.assertEqual(versions, ["0.2.0-beta.3", "0.2.0"])

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

    def test_unrelated_draft_asset_requires_inspection(self):
        github = FakeGitHub()
        self.draft(github, False)
        github.files["manual.txt"] = b"do not delete"
        with self.assertRaisesRegex(ValueError, "unrelated assets"):
            self.publish(github)
        self.assertEqual(github.files["manual.txt"], b"do not delete")

    def test_existing_manual_draft_notes_are_not_published(self):
        github = FakeGitHub()
        self.draft(github, False)
        github.current["body"] = "Unrelated manual draft"
        with self.assertRaisesRegex(ValueError, "Draft release notes differ"):
            self.publish(github)
        self.assertFalse(github.uploads)
        self.assertEqual(github.publications, 0)

    def test_no_branch_publication(self):
        for version in ("0.2.0", "0.2.0-beta.1"):
            self.use(version)
            with (
                self.subTest(version=version),
                patch.dict(os.environ, {"GITHUB_REF": "refs/heads/feature"}),
                self.assertRaisesRegex(ValueError, "only allowed from main"),
            ):
                self.publish(FakeGitHub(version))

    def test_changed_manifest_cannot_redefine_trusted_build(self):
        (self.folder / "release-manifest.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "validated build"):
            self.publish(FakeGitHub())

    def test_no_acceptance_summary_no_publication(self):
        with self.assertRaisesRegex(ValueError, "acceptance summary"):
            release.publish(
                self.folder,
                self.meta["version"],
                self.manifest_digest,
                "",
                FakeGitHub(),
            )

    def test_assets_from_another_commit_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "another commit"):
            release.verify_bundle(
                self.folder, self.meta, "b" * 40, self.manifest_digest
            )

    def test_unexpected_local_file_is_rejected(self):
        (self.folder / "credentials.json").write_text("synthetic")
        with self.assertRaisesRegex(ValueError, "Unexpected files"):
            self.publish(FakeGitHub())


if __name__ == "__main__":
    unittest.main()
