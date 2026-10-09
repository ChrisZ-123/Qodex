"""Run fixture-only regressions against fresh pinned sources in a temp directory.

Invoke with the installed state/waves/venv/Scripts/python.exe. The installed root
is read only and used solely as a cache of the five exact public source archives.
"""

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

from install import SOURCE, acquire, environment, fixed_versions, host_check


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path, help="Installed fixture dependency root")
    args = parser.parse_args()
    host_check()
    if not args.root.is_absolute():
        raise ValueError("--root must be absolute")
    archives = args.root / "source-archives"
    for name, commit in fixed_versions().items():
        if not (archives / f"{name}-{commit}.zip").is_file():
            raise RuntimeError("Install pinned sources before running fixture tests")
    with tempfile.TemporaryDirectory(prefix="qodex-waves-fixtures-") as directory:
        root = Path(directory)
        acquire(root, fixed_versions(), archives)
        env = environment(root)
        subprocess.run([sys.executable, str(SOURCE / "apply_upstream_patches.py")],
                       cwd=root, env=env, check=True)
        return subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
             "--basetemp", str(root / "pytest"), str(SOURCE / "tests")],
            cwd=root / "core", env=env, check=False,
        ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
