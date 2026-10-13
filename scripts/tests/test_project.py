"""Camera release rules: versions, store folders, candidates and the client pin.

Every test builds a small git repository in a temporary directory. GitHub is
never contacted: published() and the client verification are replaced.
"""

import base64
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bump_client
import package as packaging
import prepare_ha_app as app
import release
import release_project as project

ROOT = Path(__file__).resolve().parents[2]
NOTES = "- Synthetic release notes that are long enough to count.\n"
INTEGRITY = "sha512-" + base64.b64encode(bytes(64)).decode()


def changelog(version, date):
    return f"# Changelog\n\n## {version} - {date}\n\n{NOTES}"


class ProjectTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for name in (
            "custom_components/eufy_viewer/manifest.json",
            "repository.yaml",
            "bridge/package.json",
            "bridge/package-lock.json",
            "bridge/tsconfig.json",
            "bridge/Dockerfile",
            "app/app_config.json",
            "app/Dockerfile",
            "app/bootstrap.mjs",
        ):
            self.write(name, (ROOT / name).read_bytes())
        self.write("custom_components/eufy_viewer/const.py", "VALUE = 1\n")
        self.write("bridge/src/index.ts", "export {};\n")
        self.write("app/README.md", "# Eufy Security Viewer Bridge\n")
        self.write("app/CHANGELOG.md", changelog("0.8.37", "2026-10-13"))
        self.write(
            "CHANGELOG.md",
            changelog("0.8.46", "2026-10-13") + "\n## 0.8.45 - 2026-10-12\n\n" + NOTES,
        )
        self.write("docs/USAGE.md", "# Usage\n")
        self.set_integration("0.8.46")
        self.set_readme("0.8.46")
        self.set_bridge("0.8.37")
        self.git("init", "-q")
        self.regenerate("ha_app")
        self.base = self.commit()
        published = patch.object(project, "published", return_value=False)
        self.published = published.start()
        self.addCleanup(published.stop)

    # Fixture helpers

    def git(self, *args):
        return subprocess.run(
            [
                "git",
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
                *args,
            ],
            cwd=self.root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "fixture")
        return self.git("rev-parse", "HEAD")

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, str):
            path.write_text(data)
        else:
            path.write_bytes(data)

    def read(self, name):
        return (self.root / name).read_text()

    def edit_json(self, name, change):
        data = json.loads(self.read(name))
        change(data)
        self.write(name, json.dumps(data, indent=2) + "\n")

    def set_integration(self, version):
        self.edit_json(
            "custom_components/eufy_viewer/manifest.json",
            lambda data: data.update(version=version),
        )
        self.write(
            "pyproject.toml",
            f'[project]\nname = "eufy-security-viewer"\nversion = "{version}"\n',
        )
        self.write(
            "uv.lock",
            "version = 1\n\n[[package]]\n"
            'name = "eufy-security-viewer"\n'
            f'version = "{project.pep440(version)}"\n'
            'source = { virtual = "." }\n',
        )

    def set_readme(self, version):
        self.write(
            "README.md",
            f"Card resource `/eufy_viewer/eufy-viewer-card.js?v={version}`.\n",
        )

    def set_bridge(self, version):
        self.edit_json("bridge/package.json", lambda data: data.update(version=version))

        def lock(data):
            data["version"] = version
            data["packages"][""]["version"] = version

        self.edit_json("bridge/package-lock.json", lock)

    def set_pin(self, version, integrity=INTEGRITY):
        url = bump_client.url(version)

        def package(data):
            data["dependencies"]["@keesmod/eufy-mega-client"] = url

        def lock(data):
            data["packages"][""]["dependencies"]["@keesmod/eufy-mega-client"] = url
            entry = data["packages"]["node_modules/@keesmod/eufy-mega-client"]
            entry.update(resolved=url, version=version, integrity=integrity)

        self.edit_json("bridge/package.json", package)
        self.edit_json("bridge/package-lock.json", lock)
        return url

    def add_notes(self, name, version, suffix="Unreleased"):
        head, rest = self.read(name).split("\n\n", 1)
        self.write(name, f"{head}\n\n## {version} - {suffix}\n\n{NOTES}\n{rest}")

    def extend_notes(self, name, version):
        heading = f"## {version} - Unreleased\n\n"
        self.write(
            name, self.read(name).replace(heading, heading + "- One more change.\n")
        )

    def date_notes(self, name, version):
        self.write(
            name,
            self.read(name).replace(
                f"## {version} - Unreleased", f"## {version} - 2026-10-20"
            ),
        )

    def restore(self, *names):
        self.git("checkout", "HEAD", "--", *names)

    def bridge_version(self):
        return json.loads(self.read("bridge/package.json"))["version"]

    def regenerate(self, folder):
        self.git("add", "-A")
        app.write(
            self.root / folder,
            app.render(self.root, project.STORE[folder], self.bridge_version()),
        )

    def check(self, requested=None, base=True):
        self.git("add", "-A")
        return release.metadata(self.root, requested, self.base if base else None)

    def rejected(self, pattern, requested=None):
        with self.assertRaisesRegex(ValueError, pattern):
            self.check(requested)

    def open_candidate(self, bridge=True):
        """Merge a runtime PR that opens integration 0.8.47-beta.1.

        With bridge, it also changes the bridge and opens bridge 0.8.38-beta.1.
        """
        self.write("custom_components/eufy_viewer/const.py", "VALUE = 2\n")
        self.set_integration("0.8.47-beta.1")
        self.add_notes("CHANGELOG.md", "0.8.47")
        if bridge:
            self.write("bridge/src/index.ts", "export const changed = true;\n")
            self.set_bridge("0.8.38-beta.1")
            self.add_notes("app/CHANGELOG.md", "0.8.38")
        self.check()
        self.base = self.commit()

    def prepare_release(self, bridge="0.8.38"):
        self.set_integration("0.8.47")
        self.set_readme("0.8.47")
        self.date_notes("CHANGELOG.md", "0.8.47")
        if bridge:
            self.set_bridge(bridge)
            self.date_notes("app/CHANGELOG.md", "0.8.38")
            self.regenerate("ha_app")
            if (self.root / "ha_app_beta").exists():
                self.regenerate("ha_app_beta")

    # Every-push metadata

    def test_current_metadata_is_coherent(self):
        meta = self.check(base=False)
        self.assertEqual(
            (meta["repository"], meta["version"], meta["bridge"], meta["mega_client"]),
            (project.REPOSITORY, "0.8.46", "0.8.37", "0.29.2"),
        )

    def test_discovered_config_guard(self):
        for name in ("docs/x/config.yaml", "app/config.base.json", "ha_app/config.yml"):
            with self.subTest(name=name):
                self.write(name, "{}\n")
                self.rejected("may discover only")
                (self.root / name).unlink()
        for name in (".github/x/config.yml", "ha_app/rootfs/config.json"):
            with self.subTest(name=name):
                self.write(name, "{}\n")
                self.check(base=False)
                (self.root / name).unlink()
        self.edit_json("app/app_config.json", lambda data: data.update(version="1.0.0"))
        self.rejected("Remove version from app/app_config.json")

    def test_store_folder_identity(self):
        self.edit_json("ha_app/config.json", lambda data: data.update(slug="other"))
        self.rejected("needs slug eufy_viewer_bridge")
        self.restore("ha_app")
        self.write("ha_app_beta/config.json", self.read("ha_app/config.json"))
        self.rejected("ha_app_beta/config.json needs slug eufy_viewer_bridge_beta")

    def test_version_relations(self):
        self.set_bridge("0.8.38")
        self.rejected("must equal the ha_app version")
        self.set_bridge("0.8.37-beta.1")
        self.rejected("ha_app <= ha_app_beta <= bridge")
        self.set_bridge("0.8.37")
        self.set_readme("0.8.47")
        self.rejected("README card resource")
        self.set_integration("0.8.47-beta.1")
        self.set_readme("0.8.47-beta.1")
        self.rejected("README card resource")

    def test_beta_versions_use_the_pep440_form_in_uv_lock(self):
        self.set_integration("0.8.47-beta.1")
        self.add_notes("CHANGELOG.md", "0.8.47")
        self.assertIn('version = "0.8.47b1"', self.read("uv.lock"))
        self.check(base=False)
        self.write("uv.lock", self.read("uv.lock").replace("0.8.47b1", "0.8.47-beta.1"))
        self.rejected("uv.lock versions must match")

    def test_beta_pin_relations(self):
        self.set_pin("0.29.3-beta.1")
        self.rejected("beta client pin needs beta bridge and integration")
        self.set_bridge("0.8.38-beta.1")
        self.rejected("beta client pin needs beta bridge and integration")
        self.set_integration("0.8.47-beta.1")
        self.add_notes("CHANGELOG.md", "0.8.47")
        self.add_notes("app/CHANGELOG.md", "0.8.38")
        self.assertEqual(self.check(base=False)["mega_client"], "0.29.3-beta.1")

    def test_legacy_dependency_cannot_return_in_release(self):
        self.edit_json(
            "bridge/package-lock.json",
            lambda data: data["packages"].update(
                {"node_modules/eufy-security-client": {"version": "4.1.1-1"}}
            ),
        )
        self.rejected("Retired legacy dependency")

    def test_legacy_source_cannot_return_in_release(self):
        for name in ("bridge/src/legacy-backend.ts", "ha_app/src/legacy-backend.ts"):
            with self.subTest(name=name):
                self.write(name, "export {};\n")
                self.rejected("Retired legacy runtime")
                (self.root / name).unlink()

    def test_mutable_library_pin_rejected(self):
        self.edit_json(
            "bridge/package.json",
            lambda data: data["dependencies"].update(
                {"@keesmod/eufy-mega-client": "github:keesmod/eufy-mega-client#main"}
            ),
        )
        self.rejected("exact versioned GitHub release")

    def test_missing_integrity_rejected(self):
        self.set_pin("0.29.2", "sha512-invalid")
        with self.assertRaises(ValueError):
            self.check(base=False)

    # Candidate rule, closed batch and monotonic versions

    def test_candidate_rule(self):
        self.write("custom_components/eufy_viewer/const.py", "VALUE = 2\n")
        self.set_integration("0.8.47-beta.1")
        self.rejected("Missing substantive changelog entry in CHANGELOG.md")
        self.add_notes("CHANGELOG.md", "0.8.47")
        self.check()
        self.published.assert_not_called()
        self.base = self.commit()
        # Several PRs accumulate in one unpublished candidate.
        self.write("custom_components/eufy_viewer/const.py", "VALUE = 3\n")
        self.rejected("release notes in the CHANGELOG.md 0.8.47 section")
        self.published.assert_not_called()
        self.extend_notes("CHANGELOG.md", "0.8.47")
        self.check()
        self.published.assert_called_once_with("0.8.47-beta.1")
        self.published.return_value = True
        self.rejected(
            r"0\.8\.47-beta\.1 is published\. Raise the version to 0\.8\.47-beta\.2"
        )

    def test_closed_batch(self):
        self.write("custom_components/eufy_viewer/const.py", "VALUE = 2\n")
        self.rejected(
            r"The 0\.8\.46 batch is closed by its release PR\. "
            r"Raise the version to 0\.8\.47-beta\.1"
        )
        self.published.assert_not_called()

    def test_runtime_pr_needs_a_beta_version(self):
        self.write(
            "CHANGELOG.md",
            self.read("CHANGELOG.md").replace("2026-10-13", "Unreleased"),
        )
        self.base = self.commit()
        self.write("custom_components/eufy_viewer/const.py", "VALUE = 2\n")
        self.extend_notes("CHANGELOG.md", "0.8.46")
        self.rejected(
            r"X\.Y\.Z-beta\.N version\. Raise the version to 0\.8\.47-beta\.1"
        )

    def test_versions_are_monotonic(self):
        self.open_candidate()
        self.set_bridge("0.8.38-beta.2")
        self.check()
        self.base = self.commit()
        for change, pattern in (
            (lambda: self.set_integration("0.8.46"), "Integration version"),
            (lambda: self.set_bridge("0.8.38-beta.1"), "Bridge version"),
        ):
            with self.subTest(pattern=pattern):
                self.git("reset", "-q", "--hard", self.base)
                change()
                self.rejected(pattern + " cannot go below base version")

    def test_decrease_names_the_next_candidate(self):
        def plain_integration():
            self.set_integration("0.8.45")
            self.set_readme("0.8.45")

        def stable_app():
            self.edit_json(
                "ha_app/config.json", lambda data: data.update(version="0.8.36")
            )

        def decreases(*cases):
            for change, message in cases:
                with self.subTest(message=message):
                    self.git("reset", "-q", "--hard", self.base)
                    change()
                    self.rejected(f"^{re.escape(message)}$")

        decreases(
            (
                plain_integration,
                "Integration version cannot go below base version 0.8.46. "
                "Raise the version, for example to 0.8.47-beta.1",
            ),
            (
                lambda: self.set_pin("0.29.1"),
                "Client pin version cannot go below base version 0.29.2. Keep 0.29.2",
            ),
        )
        self.git("reset", "-q", "--hard", self.base)
        self.open_candidate()
        self.set_bridge("0.8.38-beta.2")
        self.check()
        self.base = self.commit()
        decreases(
            (
                lambda: self.set_integration("0.8.46"),
                "Integration version cannot go below base version 0.8.47-beta.1. "
                "Keep 0.8.47-beta.1, or 0.8.47-beta.2 if it is published",
            ),
            (
                lambda: self.set_bridge("0.8.38-beta.1"),
                "Bridge version cannot go below base version 0.8.38-beta.2. "
                "Keep 0.8.38-beta.2, or 0.8.38-beta.3 if it is published",
            ),
            (
                stable_app,
                "ha_app version cannot go below base version 0.8.37. Keep 0.8.37",
            ),
        )

    def test_plain_version_only_in_a_release_pr(self):
        self.open_candidate(bridge=False)
        self.set_integration("0.8.47")
        self.set_readme("0.8.46")
        self.rejected("Date the 0.8.47 heading in CHANGELOG.md")
        self.date_notes("CHANGELOG.md", "0.8.47")
        self.rejected("README card resource examples need the release version")
        self.set_readme("0.8.47")
        self.check()

    def test_new_changelog_headings_use_the_two_forms(self):
        self.write("custom_components/eufy_viewer/const.py", "VALUE = 2\n")
        self.set_integration("0.8.47-beta.1")
        for heading in ("## 0.8.47-beta.1 - Unreleased", "## 0.8.47 (unreleased)"):
            with self.subTest(heading=heading):
                self.write(
                    "CHANGELOG.md",
                    f"# Changelog\n\n## 0.8.47 - Unreleased\n\n{NOTES}\n"
                    f"{heading}\n\n{NOTES}",
                )
                self.rejected("headings use")

    # Bridge runtime set

    def test_bridge_runtime_changes_need_a_bridge_candidate(self):
        changes = {
            "bridge/src": lambda: self.write(
                "bridge/src/index.ts", "export const a = 1;\n"
            ),
            "bridge/tsconfig.json": lambda: self.write(
                "bridge/tsconfig.json", self.read("bridge/tsconfig.json") + "\n"
            ),
            "bridge/Dockerfile": lambda: self.write(
                "bridge/Dockerfile", self.read("bridge/Dockerfile") + "\n"
            ),
            "scripts.build": lambda: self.edit_json(
                "bridge/package.json",
                lambda data: data["scripts"].update(build="tsc -p ."),
            ),
            "production lock": lambda: self.edit_json(
                "bridge/package-lock.json",
                lambda data: data["packages"]["node_modules/ws"].update(
                    integrity=INTEGRITY
                ),
            ),
            "app/app_config.json": lambda: self.edit_json(
                "app/app_config.json", lambda data: data.update(timeout=30)
            ),
            "app/Dockerfile": lambda: self.write(
                "app/Dockerfile", self.read("app/Dockerfile") + "\n"
            ),
            "app/bootstrap.mjs": lambda: self.write(
                "app/bootstrap.mjs", self.read("app/bootstrap.mjs") + "\n"
            ),
            "new app file": lambda: self.write("app/helper.mjs", "export {};\n"),
        }
        for name, change in changes.items():
            with self.subTest(change=name):
                self.git("reset", "-q", "--hard", self.base)
                self.git("clean", "-qfd")
                change()
                self.set_integration("0.8.47-beta.1")
                self.add_notes("CHANGELOG.md", "0.8.47")
                self.rejected(
                    r"above the store version 0\.8\.37\. "
                    r"Raise the bridge to 0\.8\.38-beta\.1"
                )
                self.set_bridge("0.8.38-beta.1")
                self.rejected("Missing substantive changelog entry in app/CHANGELOG.md")
                self.add_notes("app/CHANGELOG.md", "0.8.38")
                self.check()

    def test_bridge_candidate_accumulates_with_its_notes(self):
        self.open_candidate()
        self.write("bridge/src/index.ts", "export const again = true;\n")
        self.extend_notes("CHANGELOG.md", "0.8.47")
        self.rejected("release notes in the app/CHANGELOG.md 0.8.38 section")
        self.extend_notes("app/CHANGELOG.md", "0.8.38")
        self.check()

    def test_bridge_runtime_change_needs_an_integration_candidate(self):
        self.write("bridge/src/index.ts", "export const a = 1;\n")
        self.set_bridge("0.8.38-beta.1")
        self.add_notes("app/CHANGELOG.md", "0.8.38")
        self.rejected("batch is closed")

    def test_dev_and_presentation_changes_need_no_candidate(self):
        def dev(data):
            entry = next(v for v in data["packages"].values() if v.get("dev"))
            entry["integrity"] = INTEGRITY

        self.edit_json("bridge/package-lock.json", dev)
        self.edit_json(
            "bridge/package.json",
            lambda data: data.update(
                description="Bridge", devDependencies={"typescript": "^6.0.0"}
            ),
        )
        self.write("app/README.md", "# Eufy Security Viewer Bridge\n\nBetter words.\n")
        self.write("app/CHANGELOG.md", self.read("app/CHANGELOG.md") + "- Typo fix.\n")
        self.write("docs/USAGE.md", "# Usage\n\nMore.\n")
        self.check()
        self.assertFalse(project.runtime_changed(self.root, self.base))

    def test_runtime_changed_for_the_push_backstop(self):
        for name, runtime in (
            ("docs/USAGE.md", False),
            ("app/README.md", False),
            ("custom_components/eufy_viewer/const.py", True),
            ("app/Dockerfile", True),
            ("bridge/src/index.ts", True),
        ):
            with self.subTest(name=name):
                self.git("reset", "-q", "--hard", self.base)
                self.write(name, self.read(name) + "\n")
                self.git("add", "-A")
                self.assertIs(project.runtime_changed(self.root, self.base), runtime)

    # Store folder freeze

    def test_store_folders_are_frozen(self):
        self.write("repository.yaml", self.read("repository.yaml") + "# note\n")
        self.rejected("repository.yaml")
        self.restore("repository.yaml")
        self.write("ha_app/README.md", "# Edited by hand\n")
        self.rejected("ha_app is frozen")
        self.restore("ha_app")
        self.write("app/README.md", "# New words\n")
        self.regenerate("ha_app")
        self.rejected("ha_app is frozen")

    def test_beta_folder_cannot_be_removed(self):
        self.regenerate("ha_app_beta")
        self.base = self.commit()
        shutil.rmtree(self.root / "ha_app_beta")
        self.rejected("Store folder ha_app_beta cannot be removed")

    def test_store_folder_must_equal_the_generator_output(self):
        self.open_candidate()
        self.regenerate("ha_app_beta")
        self.write("ha_app_beta/README.md", "# Edited by hand\n")
        self.rejected("ha_app_beta differs from the prepare_ha_app.py output")

    # Release PR

    def test_release_pr_accepted(self):
        self.open_candidate()
        self.prepare_release()
        self.set_readme("0.8.46")
        self.rejected("README card resource examples need the release version")
        self.set_readme("0.8.47")
        self.check()
        self.published.assert_not_called()
        self.base = self.commit()
        self.check("0.8.47", base=False)

    def test_release_pr_resets_the_beta_folder(self):
        self.open_candidate()
        self.regenerate("ha_app_beta")
        self.check()
        self.base = self.commit()
        self.prepare_release()
        config = json.loads(self.read("ha_app_beta/config.json"))
        self.assertEqual(
            (config["version"], config["slug"]), ("0.8.38", "eufy_viewer_bridge_beta")
        )
        self.check()

    def test_release_pr_rejected_with_a_stale_beta_folder(self):
        self.open_candidate()
        self.regenerate("ha_app_beta")
        self.base = self.commit()
        self.prepare_release()
        self.restore("ha_app_beta")
        self.rejected("ha_app_beta <= bridge|every store folder at bridge 0.8.38")

    def test_release_pr_rejected_with_a_published_integration(self):
        self.set_bridge("0.8.38")
        self.add_notes("app/CHANGELOG.md", "0.8.38", "2026-10-20")
        self.regenerate("ha_app")
        self.check()
        self.published.return_value = True
        self.rejected(r"Version 0\.8\.46 is published\. .*release PR at 0\.8\.47$")
        self.published.assert_called_with("0.8.46")
        self.set_integration("0.8.47")
        self.add_notes("CHANGELOG.md", "0.8.47", "2026-10-20")
        self.set_readme("0.8.47")
        self.check()

    def test_release_pr_rejected_with_a_beta_bridge(self):
        self.open_candidate()
        self.prepare_release(bridge=None)
        self.rejected("A stable release needs a plain bridge version")
        self.regenerate("ha_app")
        self.rejected("ha_app is the stable app and needs a plain version")

    def test_stable_app_update_needs_a_plain_integration(self):
        self.open_candidate()
        self.set_bridge("0.8.38")
        self.date_notes("app/CHANGELOG.md", "0.8.38")
        self.regenerate("ha_app")
        self.rejected("ha_app changes only in a stable release PR")

    def test_integration_only_stable_release_after_a_dev_only_lock_change(self):
        def dev(data):
            entry = next(v for v in data["packages"].values() if v.get("dev"))
            entry["integrity"] = INTEGRITY

        self.edit_json("bridge/package-lock.json", dev)
        self.check()
        self.base = self.commit()
        self.open_candidate(bridge=False)
        self.prepare_release(bridge=None)
        self.check()
        self.base = self.commit()
        self.assertNotEqual(
            self.read("bridge/package-lock.json"), self.read("ha_app/package-lock.json")
        )
        self.check("0.8.47", base=False)

    # Beta cut and prerelease runs

    def test_beta_cut(self):
        self.open_candidate()
        self.rejected("Cut ha_app_beta at 0.8.38-beta.1", requested="0.8.47-beta.1")
        self.regenerate("ha_app_beta")
        self.check()
        self.published.assert_called_once_with("0.8.47-beta.1")
        self.base = self.commit()
        self.check("0.8.47-beta.1", base=False)
        config = json.loads(self.read("ha_app_beta/config.json"))
        self.assertEqual(
            (config["name"], config["stage"]),
            ("Eufy Security Viewer Bridge (beta)", "experimental"),
        )

    def test_beta_cut_rejected_with_a_plain_integration(self):
        self.open_candidate()
        self.regenerate("ha_app_beta")
        self.set_integration("0.8.47")
        self.date_notes("CHANGELOG.md", "0.8.47")
        self.rejected("A stable release needs a plain bridge version")

    def test_beta_cut_rejected_with_a_published_integration(self):
        self.open_candidate()
        self.regenerate("ha_app_beta")
        self.published.return_value = True
        self.rejected(r"0\.8\.47-beta\.1 is published")

    def test_integration_only_beta_with_and_without_the_beta_folder(self):
        self.open_candidate(bridge=False)
        self.check("0.8.47-beta.1", base=False)
        self.regenerate("ha_app_beta")
        self.check()
        self.base = self.commit()
        self.check("0.8.47-beta.1", base=False)

    # Transition and generator

    def test_transition_from_a_base_without_app(self):
        rendered = app.render(self.root, "stable", "0.8.37")
        sources = {
            name: (self.root / "app" / name).read_bytes()
            for name in app.tracked(self.root, "app")
        }
        # The old layout: hand-edited files next to the generated copies.
        shutil.rmtree(self.root / "app")
        app.write(
            self.root / "ha_app", {**rendered, "CHANGELOG.md": sources["CHANGELOG.md"]}
        )
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "old layout")
        self.base = self.git("rev-parse", "HEAD")
        for name, data in sources.items():
            self.write("app/" + name, data)
        self.check()
        self.assertFalse(project.runtime_changed(self.root, self.base))
        self.write("app/bootstrap.mjs", self.read("app/bootstrap.mjs") + "// changed\n")
        self.rejected("batch is closed")
        self.assertTrue(project.runtime_changed(self.root, self.base))

    def test_generator_output(self):
        stable = app.render(self.root, "stable", "0.8.37")
        self.assertEqual(
            {n for n in stable if not n.startswith("src/")},
            {
                "config.json",
                "package.json",
                "package-lock.json",
                "tsconfig.json",
                "Dockerfile",
                "bootstrap.mjs",
                "README.md",
                "CHANGELOG.md",
            },
        )
        source = json.loads(self.read("app/app_config.json"))
        config = json.loads(stable["config.json"])
        self.assertEqual(list(config)[:2], ["name", "version"])
        self.assertEqual({k: v for k, v in config.items() if k != "version"}, source)
        self.assertEqual(
            stable["config.json"].decode(),
            json.dumps(config, indent=2, ensure_ascii=False) + "\n",
        )
        beta = app.render(self.root, "beta", "0.8.37")
        self.assertTrue(beta["README.md"].decode().startswith("> **Beta channel"))
        self.assertIn("127.0.0.1:8063", beta["README.md"].decode())
        self.assertEqual(
            json.loads(beta["config.json"])["description"], app.BETA_DESCRIPTION
        )

    def test_store_changelog_substitutes_one_heading(self):
        self.add_notes("app/CHANGELOG.md", "0.8.38")
        source = self.read("app/CHANGELOG.md")
        text = app.render(self.root, "beta", "0.8.38-beta.1")["CHANGELOG.md"].decode()
        self.assertEqual(
            text.replace("## 0.8.38-beta.1\nUnreleased\n", "## 0.8.38 - Unreleased\n"),
            source,
        )
        self.assertIn("## 0.8.37 - 2026-10-13\n", text)
        # Home Assistant Core's add-on update notes extraction.
        notes = re.search(
            r"^#* 0\.8\.38-beta\.1\n(?:^(?!#* 0\.8\.37).*\n)*", text, re.M
        )[0]
        self.assertIn(NOTES.strip(), notes)
        self.assertNotIn("0.8.37", notes)
        with self.assertRaisesRegex(ValueError, "exactly one 0.8.39 section"):
            app.render(self.root, "stable", "0.8.39")

    # Client pin

    def test_client_pin_cannot_decrease(self):
        self.set_pin("0.29.1")
        self.rejected("Client pin version cannot go below base version 0.29.2")

    def test_changed_client_pin_is_verified(self):
        self.open_candidate()
        url = self.set_pin("0.29.3-beta.1")
        self.extend_notes("CHANGELOG.md", "0.8.47")
        self.extend_notes("app/CHANGELOG.md", "0.8.38")
        verified = {"url": url, "integrity": INTEGRITY}
        with patch.object(bump_client, "verify", return_value=verified) as verify:
            self.check()
        verify.assert_called_once_with("0.29.3-beta.1")
        verified = {"url": url, "integrity": "sha512-other"}
        with patch.object(bump_client, "verify", return_value=verified):
            self.rejected("differs from the verified client release")

    # Archives

    def test_archive_cannot_include_untracked_local_files(self):
        self.regenerate("ha_app_beta")
        self.git("add", "ha_app_beta")
        self.write("bridge/credentials.json", "synthetic secret fixture")
        archives = packaging.members(self.root)
        self.assertTrue(
            all(
                "bridge/credentials.json" not in entries
                for entries in archives.values()
            )
        )
        source = archives["ha-eufy-cam-source-0.8.46.zip"]
        self.assertTrue({"app/app_config.json", "ha_app_beta/config.json"} <= source)

    def test_duplicate_or_unexpected_archive_entries_rejected(self):
        meta = self.check(base=False)
        with zipfile.ZipFile(self.root / "fixture.zip", "w") as archive:
            archive.writestr("credentials.json", "synthetic")
        with patch.object(
            packaging, "members", return_value={"fixture.zip": {"README.md"}}
        ):
            with self.assertRaisesRegex(ValueError, "Unexpected or missing"):
                project.verify_archives(self.root, meta)

    def test_production_lock_detects_runtime_but_ignores_dev_changes(self):
        before = {
            "packages": {
                "": {"version": "1.0.0"},
                "node_modules/runtime": {"version": "1.0.0", "integrity": "first"},
                "node_modules/test": {"version": "1.0.0", "dev": True},
            }
        }
        changed = json.loads(json.dumps(before))
        changed["packages"]["node_modules/test"]["version"] = "2.0.0"
        self.assertEqual(
            project.production_lock(before), project.production_lock(changed)
        )
        changed["packages"]["node_modules/runtime"]["integrity"] = "second"
        self.assertNotEqual(
            project.production_lock(before), project.production_lock(changed)
        )


class FakeClientGitHub:
    """Serves one client release from memory, like release.GitHub."""

    def __init__(self, version, commit="c" * 40):
        self.version, self.commit = version, commit
        self.prerelease = release.is_prerelease(version)
        self.draft = False
        name = bump_client.tarball(version)
        package = json.dumps({"name": bump_client.PACKAGE, "version": version})
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            info = tarfile.TarInfo("package/package.json")
            info.size = len(package)
            archive.addfile(info, io.BytesIO(package.encode()))
        tgz = buffer.getvalue()
        manifest = self.manifest(
            {
                "components": {"repository": bump_client.CLIENT, "version": version},
                "files": {
                    name: {"sha256": hashlib.sha256(tgz).hexdigest(), "size": len(tgz)}
                },
                "source_commit": commit,
            }
        )
        self.files = {name: tgz, "release-manifest.json": manifest}
        self.files["SHA256SUMS"] = self.sums()

    @staticmethod
    def manifest(data):
        return (json.dumps(data, indent=2, sort_keys=True) + "\n").encode()

    def sums(self):
        name = bump_client.tarball(self.version)
        return (
            f"{hashlib.sha256(self.files[name]).hexdigest()}  {name}\n"
            f"{hashlib.sha256(self.files['release-manifest.json']).hexdigest()}"
            "  release-manifest.json\n"
        ).encode()

    def release(self, tag):
        assert tag == "v" + self.version
        return {
            "tag_name": tag,
            "draft": self.draft,
            "prerelease": self.prerelease,
            "assets": [{"name": n, "id": i + 1} for i, n in enumerate(self.files)],
        }

    def download(self, tag, folder):
        for name, data in self.files.items():
            (folder / name).write_bytes(data)

    def tag_commit(self, tag):
        return self.commit


class ClientVerificationTests(unittest.TestCase):
    def test_valid_releases_pass_and_return_the_lock_values(self):
        for version in ("0.29.2", "0.29.3-beta.1"):
            with self.subTest(version=version):
                github = FakeClientGitHub(version)
                tgz = github.files[bump_client.tarball(version)]
                integrity = (
                    "sha512-" + base64.b64encode(hashlib.sha512(tgz).digest()).decode()
                )
                self.assertEqual(
                    bump_client.verify(version, github),
                    {"url": bump_client.url(version), "integrity": integrity},
                )
                self.assertRegex(bump_client.url(version), project.CLIENT_PIN)

    def test_unsafe_releases_are_rejected(self):
        def manifest(github, change):
            data = json.loads(github.files["release-manifest.json"])
            change(data)
            github.files["release-manifest.json"] = github.manifest(data)
            github.files["SHA256SUMS"] = github.sums()

        def package(github, version):
            buffer = io.BytesIO()
            body = json.dumps(
                {"name": bump_client.PACKAGE, "version": version}
            ).encode()
            with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
                info = tarfile.TarInfo("package/package.json")
                info.size = len(body)
                archive.addfile(info, io.BytesIO(body))
            tgz = buffer.getvalue()
            github.files[bump_client.tarball("0.29.2")] = tgz
            manifest(
                github,
                lambda data: data["files"].update(
                    {
                        bump_client.tarball("0.29.2"): {
                            "sha256": hashlib.sha256(tgz).hexdigest(),
                            "size": len(tgz),
                        }
                    }
                ),
            )

        cases = {
            "draft": (lambda g: setattr(g, "draft", True), "not a published release"),
            "flag": (
                lambda g: setattr(g, "prerelease", True),
                "must not be a prerelease",
            ),
            "extra asset": (
                lambda g: g.files.update({"notes.txt": b"x"}),
                "assets must be exactly",
            ),
            "checksums": (
                lambda g: g.files.update(SHA256SUMS=g.files["SHA256SUMS"].rstrip()),
                "SHA256SUMS does not match",
            ),
            "components": (
                lambda g: manifest(
                    g, lambda d: d["components"].update(version="0.29.1")
                ),
                "another repository or version",
            ),
            "size": (
                lambda g: manifest(
                    g,
                    lambda d: d["files"][bump_client.tarball("0.29.2")].update(size=1),
                ),
                "does not describe the tarball",
            ),
            "commit": (
                lambda g: setattr(g, "commit", "d" * 40),
                "commit differs from the tag commit",
            ),
            "package": (
                lambda g: package(g, "0.29.1"),
                "is not @keesmod/eufy-mega-client",
            ),
        }
        for name, (change, pattern) in cases.items():
            with self.subTest(case=name):
                github = FakeClientGitHub("0.29.2")
                change(github)
                with self.assertRaisesRegex(ValueError, pattern):
                    bump_client.verify("0.29.2", github)


if __name__ == "__main__":
    unittest.main()
