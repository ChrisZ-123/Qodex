"""One lifecycle per native handler invocation, independent of output timing."""

from __future__ import annotations

import asyncio
import io
import mimetypes
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from .security import InvalidInput, sanitize_text


@dataclass
class TaskRecord:
    request_id: str
    key: str
    sender_qq: str
    command: str
    message_id: str
    images: list[Path]
    started: float = field(default_factory=time.monotonic)
    status: str = "running"
    outputs: list[dict[str, str]] = field(default_factory=list)
    error: str | None = None
    job: asyncio.Task[None] | None = None
    finished: float | None = None
    assets: list[Path] = field(default_factory=list)

    def response(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "requestId": self.request_id,
            "status": self.status,
            "outputs": list(self.outputs),
            "elapsedMs": int(
                ((self.finished or time.monotonic()) - self.started) * 1000
            ),
        }
        if self.error:
            value["error"] = self.error
        return value


class TaskSink:
    def __init__(self, record: TaskRecord, root: Path):
        self.record = record
        self.root = root

    def text(self, value: object) -> None:
        if self.record.status == "running":
            rendered = sanitize_text(value)
            if rendered:
                self.record.outputs.append({"type": "text", "text": rendered})

    def image(self, value: bytes | Path | object, mime: str | None = None) -> None:
        if self.record.status != "running":
            return
        if isinstance(value, Path):
            data = value.read_bytes()
            mime = mime or mimetypes.guess_type(value.name)[0]
        elif isinstance(value, bytes):
            data = value
        elif hasattr(value, "save"):
            stream = io.BytesIO()
            value.save(stream, format="PNG")
            data, mime = stream.getvalue(), "image/png"
        else:
            raise InvalidInput("unsupported plugin image")
        if len(data) > 20 * 1024 * 1024:
            raise InvalidInput("plugin image too large")
        signatures = {
            "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg": data.startswith(b"\xff\xd8\xff"),
            "image/webp": data.startswith(b"RIFF") and data[8:12] == b"WEBP",
        }
        if not signatures.get(mime or "", False):
            raise InvalidInput("unsupported plugin image")
        suffix = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[
            mime
        ]
        self.root.mkdir(parents=True, exist_ok=True)
        asset_id = uuid.uuid4().hex
        path = self.root / f"{asset_id}{suffix}"
        with path.open("xb") as file:
            file.write(data)
        self.record.assets.append(path)
        if self.record.status == "running":
            self.record.outputs.append(
                {"type": "image", "id": asset_id, "path": str(path), "mime": mime}
            )
        else:
            path.unlink(missing_ok=True)


Runner = Callable[[TaskRecord, TaskSink], Awaitable[None]]


class TaskManager:
    def __init__(self, results: Path, runner: Runner):
        self.results = results
        self.runner = runner
        self.tasks: dict[str, TaskRecord] = {}
        self.allowed_keys: set[str] = set()
        self.paused_keys: set[str] = set()
        self.global_paused = True
        self.policy_received = False
        self.policy_expires = 0.0

    def permitted(self, key: str) -> bool:
        return (
            self.policy_received
            and time.monotonic() < self.policy_expires
            and not self.global_paused
            and key in self.allowed_keys
            and key not in self.paused_keys
        )

    def submit(self, record: TaskRecord) -> None:
        if not self.permitted(record.key):
            raise InvalidInput("conversation is paused or not allowed")
        if record.request_id in self.tasks:
            raise InvalidInput("duplicate request ID")
        self.tasks[record.request_id] = record
        record.job = asyncio.create_task(self._run(record))

    async def _run(self, record: TaskRecord) -> None:
        sink = TaskSink(record, self.results / record.request_id)
        try:
            await self.runner(record, sink)
            if record.status == "running":
                record.status = (
                    "completed" if self.permitted(record.key) else "cancelled"
                )
                if record.status == "cancelled":
                    record.outputs.clear()
        except asyncio.CancelledError:
            record.status = "cancelled"
            record.outputs.clear()
        except Exception:
            if record.status == "running":
                record.status = "failed"
                record.outputs.clear()
                record.error = "Waves operation failed"
        finally:
            record.finished = time.monotonic()
            if record.status in ("cancelled", "failed"):
                for path in record.assets:
                    path.unlink(missing_ok=True)

    def get(self, request_id: str) -> TaskRecord | None:
        return self.tasks.get(request_id)

    def cancel(self, request_id: str) -> TaskRecord | None:
        record = self.tasks.get(request_id)
        if record and record.status == "running":
            record.status = "cancelled"
            record.outputs.clear()
            record.finished = time.monotonic()
            for path in record.assets:
                path.unlink(missing_ok=True)
            if record.job:
                record.job.cancel()
        return record

    def set_policy(
        self, allowed: set[str], paused: set[str], global_paused: bool
    ) -> None:
        self.allowed_keys = allowed
        self.paused_keys = paused
        self.global_paused = global_paused
        self.policy_received = True
        self.policy_expires = time.monotonic() + 30
        for record in self.tasks.values():
            if record.status == "running" and not self.permitted(record.key):
                self.cancel(record.request_id)

    def expire_policy(self) -> bool:
        if self.policy_received and time.monotonic() >= self.policy_expires:
            self.policy_received = False
            self.global_paused = True
            for record in self.tasks.values():
                if record.status == "running":
                    self.cancel(record.request_id)
            return True
        return False
