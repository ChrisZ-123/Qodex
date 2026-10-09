"""Portable state location; adapter source never holds runtime data."""

import os
from pathlib import Path


def runtime_root() -> Path:
    configured = os.environ.get("QBOT_WAVES_ROOT")
    root = Path(configured) if configured else Path(__file__).resolve().parents[3] / "state" / "waves"
    if not root.is_absolute():
        raise ValueError("QBOT_WAVES_ROOT must be absolute")
    return root.resolve()


def listener_ports() -> tuple[int, int]:
    ports = tuple(int(os.environ.get(name, default)) for name, default in (
        ("QBOT_WAVES_RPC_PORT", "8788"), ("QBOT_WAVES_LOGIN_PORT", "8789")
    ))
    if any(not 1 <= port <= 65535 for port in ports) or ports[0] == ports[1]:
        raise ValueError("Waves ports must be distinct integers from 1 to 65535")
    return ports
