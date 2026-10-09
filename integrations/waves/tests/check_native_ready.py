"""Offline initialization smoke test for a disposable, fully installed state root.

Not part of installation: no listeners, QQ transport, SMS or game command runs.
Requires QBOT_WAVES_ROOT/PYTHONPATH and the installation's Python interpreter.
"""

import asyncio
import importlib
import json
import os
import socket
import sys

from adapter.native import PLUGIN, NativeRuntime
from adapter.paths import runtime_root


def blocked(*_args, **_kwargs):
    raise AssertionError("Outbound network forbidden in native readiness smoke test")


async def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    root = runtime_root()
    marker = json.loads((root / "installation.json").read_text(encoding="utf-8"))
    if not marker.get("complete"):
        raise RuntimeError("Use a disposable fully installed state root")
    socket.socket.connect = blocked
    socket.socket.connect_ex = blocked
    socket.getaddrinfo = blocked
    os.chdir(root / "core")
    runtime = NativeRuntime(root)
    try:
        await runtime.initialize()
        importlib.import_module(f"{PLUGIN}.utils.waves_build.damage")
        importlib.import_module(f"{PLUGIN}.utils.map.waves_build.damage")
        print(json.dumps({"ready": runtime.ready, "loginProviderReady": runtime.login_ready,
                          "nativeAbiReady": True, "handlerErrors": runtime.errors}))
        if not runtime.ready or not runtime.login_ready:
            raise RuntimeError("Native adapter is not ready")
    finally:
        await runtime.close()


if __name__ == "__main__":
    asyncio.run(main())
