"""Run checksum-pinned actionlint on the repository's GitHub workflows."""

import hashlib
import io
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile

VERSION = "1.7.12"
CHECKSUMS = {
    ("Linux", "x86_64"): (
        "linux_amd64",
        "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    ),
    ("Darwin", "arm64"): (
        "darwin_arm64",
        "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
    ),
    ("Darwin", "x86_64"): (
        "darwin_amd64",
        "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
    ),
}


def main():
    target, checksum = CHECKSUMS[(platform.system(), platform.machine())]
    url = f"https://github.com/rhysd/actionlint/releases/download/v{VERSION}/actionlint_{VERSION}_{target}.tar.gz"
    data = subprocess.check_output(
        [
            "curl",
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--max-time",
            "60",
            url,
        ]
    )
    if hashlib.sha256(data).hexdigest() != checksum:
        raise SystemExit("actionlint checksum mismatch")
    with tempfile.TemporaryDirectory() as temp:
        executable = Path(temp) / "actionlint"
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            executable.write_bytes(archive.extractfile("actionlint").read())
        executable.chmod(0o700)
        subprocess.run(
            [str(executable), "-color"],
            cwd=Path(__file__).resolve().parents[1],
            check=True,
            timeout=60,
        )


if __name__ == "__main__":
    main()
