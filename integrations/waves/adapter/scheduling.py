"""Explicit opt-in work; no upstream cron scheduler or email transport."""

from __future__ import annotations

import asyncio
import time
import uuid
from datetime import datetime, timedelta, timezone

from .security import sanitize_text
from .tasks import TaskRecord, TaskSink

CHINA = timezone(timedelta(hours=8))


class Schedules:
    def __init__(self, service):
        self.service = service
        self.jobs = {}
        self.stop = asyncio.Event()

    def enabled(self, sender, key, kind):
        if not self.service.tasks.permitted(key):
            return False
        subscription = self.service.store.get_subscription(sender, key)
        return subscription["signEnabled" if kind == "sign" else "reminderEnabled"]

    def apply_policy(self):
        for (sender, key, kind), job in list(self.jobs.items()):
            if not self.enabled(sender, key, kind):
                job.cancel()

    async def tick(self, now=None):
        await self.service.expire_policy()
        now = now if now is not None else time.time()
        stamp = datetime.fromtimestamp(now, CHINA)
        for subscription in self.service.store.list_subscriptions():
            sender, key = subscription["senderQQ"], subscription["key"]
            if not self.service.tasks.permitted(key):
                continue
            for kind in ("sign", "reminder"):
                identity = (sender, key, kind)
                if not self.enabled(*identity) or identity in self.jobs:
                    continue
                old = self.service.store.schedule_state(sender, key, kind)
                if kind == "sign":
                    # Fixed minute only; restart/unpause cannot catch up earlier work.
                    if (
                        (stamp.hour, stamp.minute) != self.service.runtime.sign_time
                        or old == stamp.date().isoformat()
                    ):
                        continue
                    self.service.store.set_schedule_state(
                        sender, key, kind, stamp.date().isoformat()
                    )
                elif (
                    old is not None
                    and now - float(old)
                    < max(1, subscription["threshold"] // 10 - 1) * 3600
                ):
                    continue
                job = asyncio.create_task(self._one(subscription, kind, now))
                self.jobs[identity] = job
                job.add_done_callback(
                    lambda finished, identity=identity: self.jobs.pop(identity, None)
                )

    async def _one(self, subscription, kind, now):
        sender, key = subscription["senderQQ"], subscription["key"]
        record = TaskRecord(
            "schedule-" + uuid.uuid4().hex,
            key,
            sender,
            "__sign",
            "scheduled-opt-in",
            [],
        )
        sink = TaskSink(record, self.service.root / "results" / record.request_id)
        try:
            if kind == "sign":
                await self.service.runtime.run(record, sink)
                text = (
                    "\n".join(
                        output["text"]
                        for output in record.outputs
                        if output["type"] == "text"
                    )
                    or "鸣潮签到已执行。"
                )
            else:
                text = await self.service.runtime.reminder(subscription, now)
                if not text:
                    return
                self.service.store.set_schedule_state(sender, key, kind, str(now))
            if not self.enabled(sender, key, kind):
                return
            self.service.store.queue_notice(
                record.request_id, sender, key, sanitize_text(text)
            )
            self.service.store.mark_notified(
                sender, key, datetime.fromtimestamp(now, CHINA).isoformat()
            )
        except asyncio.CancelledError:
            record.status = "cancelled"
            record.outputs.clear()
        except Exception:
            # Expose failure once. Reminder has no retry until a full cooldown.
            self.service.store.set_schedule_state(
                sender,
                key,
                kind,
                datetime.fromtimestamp(now, CHINA).date().isoformat()
                if kind == "sign"
                else str(now),
            )
            if self.enabled(sender, key, kind):
                self.service.store.queue_notice(
                    record.request_id,
                    sender,
                    key,
                    "鸣潮"
                    + ("自动签到" if kind == "sign" else "体力提醒")
                    + "本次失败，请检查登录或服务状态。此次失败不会自动重试。",
                )
        finally:
            for path in record.assets:
                path.unlink(missing_ok=True)

    async def run_forever(self):
        next_tick = 0.0
        while not self.stop.is_set():
            await self.service.expire_policy()
            if time.monotonic() >= next_tick:
                await self.tick()
                next_tick = time.monotonic() + 30
            try:
                await asyncio.wait_for(self.stop.wait(), 1)
            except asyncio.TimeoutError:
                pass

    async def close(self):
        self.stop.set()
        jobs = list(self.jobs.values())
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
