"""Build deterministic local install archives without publishing."""
from pathlib import Path
import hashlib
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "artifacts"
OUTPUT.mkdir(exist_ok=True)


def archive(name: str, paths: list[Path]) -> None:
    """Package only source artifacts, never secrets, caches or dependencies."""
    target = OUTPUT / name
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as output:
        for path in sorted(paths):
            if path.is_file() and "__pycache__" not in path.parts:
                info = zipfile.ZipInfo(path.relative_to(ROOT).as_posix(), (2026, 9, 5, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                output.writestr(info, path.read_bytes())
    print(f"{hashlib.sha256(target.read_bytes()).hexdigest()}  {target.name}")


archive("eufy-viewer-integration-0.1.0.zip", list((ROOT / "custom_components").rglob("*")) + [ROOT / "README.md", ROOT / "LICENSE"] + list((ROOT / "docs").rglob("*.md")))
archive("eufy-viewer-bridge-0.1.0.zip", list((ROOT / "bridge/src").rglob("*")) + [ROOT / "bridge" / name for name in ("package.json", "package-lock.json", "tsconfig.json", "Dockerfile", ".dockerignore")] + [ROOT / "README.md", ROOT / "LICENSE"] + list((ROOT / "docs").rglob("*.md")))

source = [ROOT / name for name in ("README.md", "LICENSE", "hacs.json", "pyproject.toml", "uv.lock", ".gitignore", "repository.yaml", "CHANGELOG.md")]
for directory in ("custom_components", "bridge/src", "bridge/test", "docs", "scripts", "tests", ".github", "ha_app"):
    source.extend((ROOT / directory).rglob("*"))
source.extend(path for path in (ROOT / "frontend").iterdir() if path.is_file())
source.extend(path for path in (ROOT / "bridge").iterdir() if path.is_file())
archive("ha-eufy-cam-source-0.1.0.zip", source)
