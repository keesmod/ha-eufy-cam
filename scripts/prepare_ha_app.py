"""Stage the canonical bridge as a local Supervisor app build context."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
target = root / "artifacts" / "ha_app" / "eufy_viewer_bridge"
target.mkdir(parents=True, exist_ok=True)
for destination in (root / "ha_app", target):
    for name in ("package.json", "package-lock.json", "tsconfig.json"):
        shutil.copy2(root / "bridge" / name, destination / name)
    if (destination / "src").exists():
        shutil.rmtree(destination / "src")
    shutil.copytree(root / "bridge" / "src", destination / "src")
for name in ("config.json", "Dockerfile", "bootstrap.mjs"):
    shutil.copy2(root / "ha_app" / name, target / name)
print(target)
