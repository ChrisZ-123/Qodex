"""Install the optional Waves adapter from reviewed, fixed upstream commits.

No core application, game, tunnel, login, or account operation is started here.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import venv
import zipfile
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
REPOS = {
    "core": "Genshin-bots/gsuid_core",
    "XutheringWavesUID": "Loping151/XutheringWavesUID",
    "RoverSign": "Loping151/RoverSign",
    "RoverReminder": "Loping151/RoverReminder",
    "ScoreEcho": "Loping151/ScoreEcho",
}


def fixed_versions() -> dict[str, str]:
    data = json.loads((SOURCE / "versions.json").read_text(encoding="utf-8-sig"))
    versions = {name: data[name] for name in REPOS}
    if any(not re.fullmatch(r"[0-9a-f]{40}", value) for value in versions.values()):
        raise ValueError("versions.json must contain fixed 40-character commits")
    return versions


def host_check() -> None:
    if os.name != "nt" or sys.version_info[:2] != (3, 11) or platform.architecture()[0] != "64bit":
        raise RuntimeError("Waves requires Windows x64 host Python 3.11")


def target_for(root: Path, name: str) -> Path:
    return root / "core" if name == "core" else root / "core" / "gsuid_core" / "plugins" / name


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_text(json.dumps(data, indent=2), encoding="utf-8")
    temporary.replace(path)


def acquire(root: Path, versions: dict, cache: Path | None) -> None:
    for name, repo in REPOS.items():
        commit = versions[name]
        target = target_for(root, name)
        stamp = {"repository": repo, "commit": commit}
        marker = target / ".qodex-source.json"
        if target.exists():
            if not marker.is_file() or json.loads(marker.read_text(encoding="utf-8")) != stamp:
                raise RuntimeError(f"Refusing to overwrite unverified source: {name}")
            if not (target / "LICENSE").is_file():
                raise RuntimeError(f"Upstream LICENSE missing: {name}")
            continue
        archives = root / "source-archives"
        archives.mkdir(parents=True, exist_ok=True)
        archive = archives / f"{name}-{commit}.zip"
        cached = cache / archive.name if cache else None
        if not archive.exists():
            temporary = archive.with_suffix(".zip.partial")
            try:
                if cached and cached.is_file():
                    shutil.copyfile(cached, temporary)
                else:
                    request = urllib.request.Request(
                        f"https://codeload.github.com/{repo}/zip/{commit}",
                        headers={"User-Agent": "Qodex-Waves-install"},
                    )
                    with urllib.request.urlopen(request, timeout=60) as reply, temporary.open("xb") as output:
                        if not reply.geturl().startswith("https://codeload.github.com/"):
                            raise RuntimeError("Unexpected source archive redirect")
                        shutil.copyfileobj(reply, output)
                temporary.replace(archive)
            finally:
                temporary.unlink(missing_ok=True)
        with tempfile.TemporaryDirectory(prefix="source-", dir=archives) as work:
            staging = Path(work) / "source"
            staging.mkdir()
            with zipfile.ZipFile(archive) as bundle:
                prefix = bundle.namelist()[0].split("/")[0]
                if not prefix.endswith("-" + commit):
                    raise RuntimeError(f"Archive does not match fixed commit: {name}")
                for item in bundle.infolist():
                    parts = item.filename.split("/")
                    if parts[0] != prefix or "\\" in item.filename or any(p in ("..", ".git") for p in parts):
                        raise ValueError("Unsafe source archive entry")
                    relative = Path(*parts[1:])
                    if not relative.parts or item.is_dir():
                        continue
                    destination = staging / relative
                    destination.resolve().relative_to(staging.resolve())
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.open(item) as incoming, destination.open("xb") as output:
                        shutil.copyfileobj(incoming, output)
            if not (staging / "LICENSE").is_file():
                raise RuntimeError(f"Archive missing upstream LICENSE: {name}")
            write_json(staging / ".qodex-source.json", stamp)
            target.parent.mkdir(parents=True, exist_ok=True)
            staging.rename(target)


def environment(root: Path) -> dict[str, str]:
    env = os.environ.copy()
    env.update(QBOT_WAVES_ROOT=str(root), PLAYWRIGHT_BROWSERS_PATH=str(root / "browsers"),
               PYTHONPATH=str(SOURCE), PYTHONDONTWRITEBYTECODE="1",
               PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    return env


def run(python: Path, args: list[str], root: Path, capture=False):
    return subprocess.run([str(python), *args], cwd=root, env=environment(root),
                          check=True, text=True, capture_output=capture)


def check_venv(root: Path) -> Path:
    directory = root / "venv"
    config = (directory / "pyvenv.cfg").read_text(encoding="utf-8").lower()
    values = dict(line.split("=", 1) for line in config.splitlines() if "=" in line)
    values = {key.strip(): value.strip() for key, value in values.items()}
    if values.get("include-system-site-packages") != "false":
        raise RuntimeError("Waves venv must not inherit host Python packages")
    python = directory / "Scripts/python.exe"
    run(python, ["-c", "import sys,struct;from pathlib import Path; "
                 "assert sys.version_info[:2]==(3,11) and struct.calcsize('P')==8; "
                 "assert sys.prefix!=sys.base_prefix and Path(sys.prefix).resolve()==Path(sys.argv[1]).resolve()",
                 str(directory)], root, capture=True)
    return python


def locked_dependencies() -> dict[str, str]:
    lines = (SOURCE / "requirements.lock.txt").read_text(encoding="utf-8").splitlines()
    pins = {}
    for line in lines:
        if not line.strip() or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([^\s]+)", line)
        if not match:
            raise ValueError("Lock must contain only exact portable package pins")
        pins[match[1]] = match[2]
    return pins


def verify(root: Path, *, full: bool) -> dict:
    versions = fixed_versions()
    for name, repo in REPOS.items():
        target = target_for(root, name)
        marker = json.loads((target / ".qodex-source.json").read_text(encoding="utf-8"))
        if marker != {"repository": repo, "commit": versions[name]} or not (target / "LICENSE").is_file():
            raise RuntimeError(f"Source provenance mismatch: {name}")
    python = check_venv(root)
    script = (
        "import sys,struct,importlib.metadata as m,json; "
        "assert sys.version_info[:2]==(3,11) and struct.calcsize('P')==8; "
        "assert sys.prefix!=sys.base_prefix; "
        "from adapter.storage import Dpapi; Dpapi(); "
        "from adapter.service import WavesService; "
        "print(json.dumps({d.metadata['Name'].lower().replace('_','-'):d.version for d in m.distributions()}))"
    )
    installed = json.loads(run(python, ["-c", script], root, capture=True).stdout)
    for name, version in {**locked_dependencies(), "gsuid-core": "0.11.1"}.items():
        if installed.get(name.lower().replace("_", "-")) != version:
            raise RuntimeError(f"Locked package mismatch: {name}")
    run(python, ["-m", "pip", "check"], root)
    models = "utils/database/models.py"
    for name in ("XutheringWavesUID", "RoverSign", "RoverReminder"):
        source = (target_for(root, name) / name / models).read_text(encoding="utf-8")
        if source.count("sa_column=Column(EncryptedToken()") != 3:
            raise RuntimeError(f"Credential encryption patch missing: {name}")
    resources_ready = browser_ready = False
    if full:
        from install_native_resources import BASE
        inventory = json.loads((root / "work/native-resources.json").read_text(encoding="utf-8"))
        entries = inventory.get("inventory", [])
        if inventory.get("source") != BASE or not entries:
            raise RuntimeError("Native resource inventory is missing")
        for entry in entries:
            path = root / entry["path"]
            path.resolve().relative_to((root / "core/data/XutheringWavesUID").resolve())
            if not path.is_file() or entry["size"] <= 0 or path.stat().st_size != entry["size"]:
                raise RuntimeError("Native resource inventory is incomplete")
        native = root / "core/data/XutheringWavesUID/build"
        extensions = []
        for relative in ("waves_build/damage.cp311-win_amd64.pyd", "map/waves_build/damage.cp311-win_amd64.pyd"):
            if not (native / relative).is_file():
                raise RuntimeError("Windows Python 3.11 native extensions are missing")
            extensions.append(str(native / relative))
        # Validate Windows loader dependencies and CPython exports without running
        # upstream plugin initialization, handlers or account logic.
        run(python, ["-c", "import ctypes,sys; "
                     "[getattr(ctypes.WinDLL(path), 'PyInit_damage') for path in sys.argv[1:]]",
                     *extensions], root)
        resources_ready = True
        run(python, ["-c", "from playwright.sync_api import sync_playwright; p=sync_playwright().start(); b=p.chromium.launch(headless=True); b.close(); p.stop()"], root)
        browser_ready = True
    return {"schemaVersion": 1, "version": 1, "complete": bool(full),
            "versions": versions, "pythonVersion": platform.python_version(),
            "platform": "win-x86_64-py3.11", "resourcesReady": resources_ready,
            "browserReady": browser_ready}


@contextlib.contextmanager
def install_lock(root: Path):
    import msvcrt
    (root / "work").mkdir(parents=True, exist_ok=True)
    with (root / "work/install.lock").open("a+b") as handle:
        handle.seek(0)
        handle.write(b"0")
        handle.flush()
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise RuntimeError("Another Waves installation is running") from None
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--source-cache", type=Path, help="Read only exact pinned public source archives")
    parser.add_argument("--skip-resources", action="store_true", help="Fixture setup only; installation remains incomplete")
    parser.add_argument("--verify", action="store_true", help="Verify prerequisites without changing files")
    args = parser.parse_args()
    host_check()
    if not args.root.is_absolute():
        raise ValueError("--root must be absolute")
    root = args.root.resolve()
    if root == SOURCE or root in SOURCE.parents or SOURCE in root.parents:
        raise ValueError("Runtime root must be separate from integration source")
    if args.verify:
        expected = verify(root, full=not args.skip_resources)
        marker = json.loads((root / "installation.json").read_text(encoding="utf-8"))
        if any(marker.get(key) != value for key, value in expected.items() if key != "pythonVersion"):
            raise RuntimeError("Installation completion manifest does not match prerequisites")
        print(json.dumps(expected))
        return 0
    root.mkdir(parents=True, exist_ok=True)
    with install_lock(root):
        marker_path = root / "installation.json"
        if marker_path.exists():
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            if marker.get("versions") != fixed_versions():
                raise RuntimeError("Installed source versions differ; refusing to replace runtime data")
            if marker.get("complete"):
                try:
                    result = verify(root, full=True)
                except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError):
                    # A failed readiness check must not leave a stale complete marker.
                    marker.update(complete=False, resourcesReady=False, browserReady=False)
                    write_json(marker_path, marker)
                    raise
                print(json.dumps(result))
                return 0
        write_json(marker_path, {"schemaVersion": 1, "version": 1, "complete": False,
                                 "versions": fixed_versions(), "platform": "win-x86_64-py3.11"})
        acquire(root, fixed_versions(), args.source_cache)
        python = root / "venv/Scripts/python.exe"
        if not python.exists():
            venv.EnvBuilder(with_pip=True, clear=False).create(root / "venv")
        check_venv(root)
        run(python, [str(SOURCE / "apply_upstream_patches.py")], root)
        run(python, ["-m", "pip", "install", "-r", str(SOURCE / "requirements.lock.txt")], root)
        # Install from the exact source instead of the inherited absolute editable path.
        run(python, ["-m", "pip", "install", "--no-deps", str(root / "core")], root)
        write_json(root / "versions.json", fixed_versions())
        if not args.skip_resources:
            run(python, ["-m", "playwright", "install", "chromium"], root)
            run(python, [str(SOURCE / "install_native_resources.py")], root)
        result = verify(root, full=not args.skip_resources)
        write_json(marker_path, result)
        print(json.dumps(result))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Waves installation failed: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
