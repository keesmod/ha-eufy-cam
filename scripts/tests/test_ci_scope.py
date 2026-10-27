"""Documentation-only detection for Validate. Byte-identical in both repos."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ci_scope  # noqa: E402


def git(root, *args):
    # The clone has no repository config, and CI runners have no global one.
    identity = ("-c", "user.name=CI", "-c", "user.email=ci@example.invalid")
    return subprocess.run(
        ["git", *identity, *args],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


class DocsOnlyTest(unittest.TestCase):
    def test_root_and_docs_markdown_are_documentation(self):
        self.assertTrue(
            ci_scope.docs_only(["README.md", "CHANGELOG.md", "docs/a/B.md"])
        )

    def test_anything_else_keeps_the_full_run(self):
        for path in (
            "src/index.ts",
            "docs/image.png",
            "app/README.md",
            ".github/PULL_REQUEST_TEMPLATE.md",
            "docs/DEVICE_PROFILES.md",
            "README.md.orig",
        ):
            with self.subTest(path=path):
                self.assertFalse(ci_scope.docs_only(["README.md", path]))

    def test_an_empty_change_keeps_the_full_run(self):
        self.assertFalse(ci_scope.docs_only([]))


class ScopeTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        git(self.root, "init", "-q", "-b", "main")
        (self.root / "docs").mkdir()
        (self.root / "docs" / "GUIDE.md").write_text("guide\n")
        (self.root / "code.py").write_text("code\n")
        git(self.root, "add", ".")
        git(self.root, "commit", "-q", "-m", "base")
        self.base = git(self.root, "rev-parse", "HEAD")
        # A clone so that origin/main exists, as in a full-depth checkout.
        self.clone = self.root / "clone"
        git(self.root, "clone", "-q", str(self.root), str(self.clone))
        git(self.clone, "switch", "-q", "-c", "topic")
        patcher = patch.object(ci_scope, "ROOT", self.clone)
        patcher.start()
        self.addCleanup(patcher.stop)

    def commit(self, *commands):
        for command in commands:
            git(self.clone, *command)
        git(self.clone, "commit", "-q", "-m", "change")

    def run_main(
        self, event, ref="refs/heads/topic", pull_base="", base_ref="main"
    ):
        output = self.root / "output"
        output.write_text("")
        environment = {
            "GITHUB_EVENT_NAME": event,
            "GITHUB_REF": ref,
            "BASE_SHA": pull_base,
            "BASE_REF": base_ref,
            "GITHUB_OUTPUT": str(output),
        }
        with patch.dict(os.environ, environment), patch("builtins.print"):
            ci_scope.main()
        return output.read_text()

    def edit_docs(self):
        (self.clone / "docs" / "GUIDE.md").write_text("better guide\n")
        self.commit(("add", "docs/GUIDE.md"))

    def test_a_documentation_pull_request_is_docs_only(self):
        self.edit_docs()
        self.assertEqual(
            self.run_main("pull_request", pull_base=self.base), "docs_only=true\n"
        )

    def test_a_documentation_branch_push_is_docs_only(self):
        self.edit_docs()
        self.assertEqual(self.run_main("push"), "docs_only=true\n")

    def test_main_release_and_other_events_run_everything(self):
        self.edit_docs()
        self.assertEqual(
            self.run_main("push", ref="refs/heads/main"), "docs_only=false\n"
        )
        for event in ("workflow_dispatch", "schedule"):
            with self.subTest(event=event):
                self.assertEqual(self.run_main(event), "docs_only=false\n")

    def test_a_pull_request_without_its_base_runs_everything(self):
        self.edit_docs()
        self.assertEqual(self.run_main("pull_request"), "docs_only=false\n")

    def test_a_pull_request_into_another_branch_runs_everything(self):
        self.edit_docs()
        self.assertEqual(
            self.run_main("pull_request", pull_base=self.base, base_ref="topic"),
            "docs_only=false\n",
        )

    def test_a_branch_without_history_shared_with_main_runs_everything(self):
        git(self.clone, "switch", "-q", "--orphan", "unrelated")
        (self.clone / "README.md").write_text("readme\n")
        self.commit(("add", "README.md"))
        self.assertEqual(self.run_main("push"), "docs_only=false\n")

    def test_a_code_change_runs_everything(self):
        self.edit_docs()
        (self.clone / "code.py").write_text("changed\n")
        self.commit(("add", "code.py"))
        self.assertEqual(
            self.run_main("pull_request", pull_base=self.base), "docs_only=false\n"
        )

    def test_moving_code_into_docs_runs_everything(self):
        self.commit(("mv", "code.py", "docs/CODE.md"))
        self.assertEqual(self.run_main("push"), "docs_only=false\n")

    def test_a_branch_without_changes_runs_everything(self):
        self.assertEqual(self.run_main("push"), "docs_only=false\n")


if __name__ == "__main__":
    unittest.main()
