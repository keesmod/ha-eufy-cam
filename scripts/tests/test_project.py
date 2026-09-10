"""Release checks reject metadata drift, unsafe packaging and missed version bumps."""

import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import release_project as project
import package as packaging

ROOT = Path(__file__).resolve().parents[2]


class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        names = [
            "custom_components/eufy_viewer/manifest.json",
            "pyproject.toml",
            "uv.lock",
            "README.md",
            "CHANGELOG.md",
            "ha_app/config.json",
            "ha_app/CHANGELOG.md",
        ]
        for directory in ("bridge", "ha_app"):
            names.extend(
                directory + "/" + name
                for name in ("package.json", "package-lock.json", "tsconfig.json")
            )
            (self.root / directory / "src").mkdir(parents=True)
            (self.root / directory / "src/index.ts").write_text("export {};\n")
        for name in names:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)

    def test_current_metadata_is_coherent(self):
        self.assertEqual(project.metadata(self.root)["repository"], project.REPOSITORY)

    def test_stale_app_version_rejected(self):
        path = self.root / "ha_app/config.json"
        data = json.loads(path.read_text())
        data["version"] = "0.0.1"
        path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "configuration version"):
            project.metadata(self.root)

    def test_generated_source_drift_rejected(self):
        (self.root / "ha_app/src/index.ts").write_text("stale build")
        with self.assertRaisesRegex(ValueError, "Generated HA app source"):
            project.metadata(self.root)

    def test_mutable_library_pin_rejected(self):
        for directory in ("bridge", "ha_app"):
            path = self.root / directory / "package.json"
            data = json.loads(path.read_text())
            data["dependencies"]["@keesmod/eufy-mega-client"] = (
                "github:keesmod/eufy-mega-client#main"
            )
            path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "exact versioned GitHub release"):
            project.metadata(self.root)

    def test_missing_integrity_rejected(self):
        for directory in ("bridge", "ha_app"):
            path = self.root / directory / "package-lock.json"
            data = json.loads(path.read_text())
            data["packages"]["node_modules/@keesmod/eufy-mega-client"]["integrity"] = (
                "sha512-invalid"
            )
            path.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            project.metadata(self.root)

    def test_archive_cannot_include_untracked_local_files(self):
        (self.root / "bridge/credentials.json").write_text("synthetic secret fixture")
        paths = b"README.md\0LICENSE\0bridge/package.json\0"
        with patch.object(packaging.subprocess, "check_output", return_value=paths):
            archives = packaging.members(self.root)
        self.assertTrue(
            all(
                "bridge/credentials.json" not in entries
                for entries in archives.values()
            )
        )

    def test_duplicate_or_unexpected_archive_entries_rejected(self):
        meta = project.metadata(self.root)
        with zipfile.ZipFile(self.root / "fixture.zip", "w") as archive:
            archive.writestr("credentials.json", "synthetic")
        with patch.object(
            packaging, "members", return_value={"fixture.zip": {"README.md"}}
        ):
            with self.assertRaisesRegex(ValueError, "Unexpected or missing"):
                project.verify_archives(self.root, meta)

    def test_runtime_change_without_version_bump_rejected(self):
        meta = project.metadata(self.root)

        def fake_run(root, *args):
            if args[1] == "diff":
                return "bridge/src/media.ts\n"
            return (self.root / args[-1].split(":", 1)[1]).read_text()

        with (
            patch.object(project, "run", fake_run),
            self.assertRaisesRegex(ValueError, "bridge version bump"),
        ):
            project.check_changes(self.root, "a" * 40, meta)

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


if __name__ == "__main__":
    unittest.main()
