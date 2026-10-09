"""Portable root, pinned archive and completion manifest contract checks."""

import json
import sys
import zipfile

import pytest

from adapter.paths import listener_ports, runtime_root
import install
from install import REPOS, acquire, check_venv, fixed_versions, locked_dependencies, target_for


def test_ports_and_absolute_state_root(monkeypatch, tmp_path):
    monkeypatch.setenv("QBOT_WAVES_ROOT", str(tmp_path))
    monkeypatch.setenv("QBOT_WAVES_RPC_PORT", "18888")
    monkeypatch.setenv("QBOT_WAVES_LOGIN_PORT", "18889")
    assert runtime_root() == tmp_path.resolve()
    assert listener_ports() == (18888, 18889)
    monkeypatch.setenv("QBOT_WAVES_LOGIN_PORT", "18888")
    with pytest.raises(ValueError):
        listener_ports()
    monkeypatch.setenv("QBOT_WAVES_ROOT", "relative")
    with pytest.raises(ValueError):
        runtime_root()


def test_pins_are_exact_and_lock_has_no_machine_paths():
    assert set(fixed_versions()) == set(REPOS)
    assert len(locked_dependencies()) > 100


def test_repeated_source_acquisition_preserves_user_data(tmp_path):
    cache = tmp_path / "archives"
    cache.mkdir()
    versions = fixed_versions()
    for name, commit in versions.items():
        with zipfile.ZipFile(cache / f"{name}-{commit}.zip", "w") as archive:
            archive.writestr(f"{name}-{commit}/LICENSE", "fixture public source license")
    root = tmp_path / "runtime"
    acquire(root, versions, cache)
    private = root / "data" / "adapter.db"
    private.parent.mkdir()
    private.write_bytes(b"fixture-preserved-data")
    acquire(root, versions, cache)
    assert private.read_bytes() == b"fixture-preserved-data"
    for name in REPOS:
        assert json.loads((target_for(root, name) / ".qodex-source.json").read_text())["commit"] == versions[name]


def test_unverified_source_is_not_overwritten(tmp_path):
    (tmp_path / "core").mkdir()
    sentinel = tmp_path / "core" / "user-file"
    sentinel.write_text("preserve")
    with pytest.raises(RuntimeError, match="overwrite unverified"):
        acquire(tmp_path, fixed_versions(), None)
    assert sentinel.read_text() == "preserve"


def test_venv_rejects_host_package_inheritance(tmp_path):
    (tmp_path / "venv").mkdir()
    (tmp_path / "venv/pyvenv.cfg").write_text("include-system-site-packages = true\n")
    with pytest.raises(RuntimeError, match="inherit host"):
        check_venv(tmp_path)


def test_failed_completed_install_verification_revokes_marker(tmp_path, monkeypatch):
    marker = tmp_path / "installation.json"
    marker.write_text(json.dumps({"version": 1, "complete": True, "versions": fixed_versions()}))
    monkeypatch.setattr(sys, "argv", ["install.py", "--root", str(tmp_path)])
    monkeypatch.setattr(install, "host_check", lambda: None)

    def failed(*_args, **_kwargs):
        raise RuntimeError("fixture incomplete native inventory")

    monkeypatch.setattr(install, "verify", failed)
    with pytest.raises(RuntimeError, match="fixture incomplete"):
        install.main()
    assert json.loads(marker.read_text())["complete"] is False
