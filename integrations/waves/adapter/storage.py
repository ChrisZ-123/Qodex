"""Small private SQLite store. Credential bytes are always DPAPI protected."""

from __future__ import annotations

import ctypes
import os
import sqlite3
import threading
import time
from ctypes import wintypes
from pathlib import Path
from typing import Any


class CredentialError(RuntimeError):
    pass


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


class Dpapi:
    def __init__(self) -> None:
        if os.name != "nt":
            raise CredentialError("Windows DPAPI is required")
        self._crypt = ctypes.WinDLL("crypt32", use_last_error=True)
        self._kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self._crypt.CryptProtectData.argtypes = [
            ctypes.POINTER(_Blob),
            wintypes.LPCWSTR,
            ctypes.POINTER(_Blob),
            ctypes.c_void_p,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(_Blob),
        ]
        self._crypt.CryptProtectData.restype = wintypes.BOOL
        self._crypt.CryptUnprotectData.argtypes = [
            ctypes.POINTER(_Blob),
            ctypes.c_void_p,
            ctypes.POINTER(_Blob),
            ctypes.c_void_p,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(_Blob),
        ]
        self._crypt.CryptUnprotectData.restype = wintypes.BOOL
        self._kernel.LocalFree.argtypes = [ctypes.c_void_p]
        self._kernel.LocalFree.restype = ctypes.c_void_p

    def _run(self, value: bytes, decrypt: bool) -> bytes:
        if not value:
            raise CredentialError("empty credential")
        buffer = (ctypes.c_ubyte * len(value)).from_buffer_copy(value)
        input_blob = _Blob(
            len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte))
        )
        output_blob = _Blob()
        action = (
            self._crypt.CryptUnprotectData if decrypt else self._crypt.CryptProtectData
        )
        if decrypt:
            ok = action(
                ctypes.byref(input_blob),
                None,
                None,
                None,
                None,
                1,
                ctypes.byref(output_blob),
            )
        else:
            ok = action(
                ctypes.byref(input_blob),
                None,
                None,
                None,
                None,
                1,
                ctypes.byref(output_blob),
            )
        if not ok:
            raise CredentialError("DPAPI operation failed")
        try:
            return ctypes.string_at(output_blob.pbData, output_blob.cbData)
        finally:
            self._kernel.LocalFree(output_blob.pbData)

    def encrypt(self, value: str) -> bytes:
        return self._run(value.encode("utf-8"), False)

    def decrypt(self, value: bytes) -> str:
        return self._run(value, True).decode("utf-8")


class Store:
    def __init__(self, path: Path, dpapi: Dpapi | None = None) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.dpapi = dpapi or Dpapi()
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS accounts (
                sender_qq TEXT PRIMARY KEY, uid TEXT NOT NULL,
                nickname TEXT NOT NULL, credential BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS subscriptions (
                sender_qq TEXT NOT NULL, scope_key TEXT NOT NULL,
                sign_enabled INTEGER NOT NULL DEFAULT 0,
                reminder_enabled INTEGER NOT NULL DEFAULT 0,
                threshold INTEGER NOT NULL DEFAULT 180,
                last_notified TEXT,
                PRIMARY KEY(sender_qq, scope_key)
            );
            CREATE TABLE IF NOT EXISTS notices (
                id TEXT PRIMARY KEY, sender_qq TEXT NOT NULL,
                scope_key TEXT NOT NULL, text TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS schedule_state (
                sender_qq TEXT NOT NULL, scope_key TEXT NOT NULL,
                kind TEXT NOT NULL, value TEXT NOT NULL,
                PRIMARY KEY(sender_qq, scope_key, kind)
            );
        """)
        self._conn.commit()
        self._accounts_conn = self._conn
        self.accounts_path = path.resolve()
        self.account_table = "accounts"

    def use_native_accounts(self, path: Path) -> None:
        """Keep the account projection in the native credential transaction.

        Old adapter account ciphertext is copied unchanged, then removed only
        after the native copy commits. An interrupted move is safe to resume.
        Subscriptions and notices retain their original database.
        """
        path = path.resolve()
        if self.account_table == "qbot_accounts":
            if self.accounts_path != path:
                raise CredentialError("account database changed during service run")
            return
        conn = sqlite3.connect(path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            with self._lock, conn:
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS qbot_accounts (sender_qq TEXT PRIMARY KEY, uid TEXT NOT NULL, nickname TEXT NOT NULL, credential BLOB NOT NULL)"
                )
                rows = self._conn.execute("SELECT * FROM accounts").fetchall()
                for row in rows:
                    old = conn.execute(
                        "SELECT * FROM qbot_accounts WHERE sender_qq=?",
                        (row["sender_qq"],),
                    ).fetchone()
                    if old and tuple(old) != tuple(row):
                        raise CredentialError("account migration conflict")
                    conn.execute(
                        "INSERT OR IGNORE INTO qbot_accounts VALUES(?,?,?,?)",
                        tuple(row),
                    )
            with self._lock, self._conn:
                for row in rows:
                    self._conn.execute(
                        "DELETE FROM accounts WHERE sender_qq=? AND uid=? AND credential=?",
                        (row["sender_qq"], row["uid"], row["credential"]),
                    )
            self._accounts_conn = conn
            self.accounts_path = path
            self.account_table = "qbot_accounts"
        except BaseException:
            conn.close()
            raise

    async def bind_in_transaction(self, session, sender_qq, uid, nickname, credential):
        from sqlalchemy import text

        if (
            self.account_table != "qbot_accounts"
            or Path(session.bind.url.database).resolve() != self.accounts_path
        ):
            raise CredentialError("native account transaction is required")
        await session.execute(
            text(
                "INSERT INTO qbot_accounts VALUES(:sender,:uid,:nickname,:credential) ON CONFLICT(sender_qq) DO UPDATE SET uid=excluded.uid,nickname=excluded.nickname,credential=excluded.credential"
            ),
            {
                "sender": sender_qq,
                "uid": uid,
                "nickname": nickname,
                "credential": self.dpapi.encrypt(credential),
            },
        )

    async def unbind_in_transaction(self, session, sender_qq):
        from sqlalchemy import text

        if (
            self.account_table != "qbot_accounts"
            or Path(session.bind.url.database).resolve() != self.accounts_path
        ):
            raise CredentialError("native account transaction is required")
        await session.execute(
            text("DELETE FROM qbot_accounts WHERE sender_qq=:sender"),
            {"sender": sender_qq},
        )

    def list_accounts(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._accounts_conn.execute(
                f"SELECT sender_qq, uid, nickname FROM {self.account_table} ORDER BY sender_qq"
            ).fetchall()
        return [
            {"senderQQ": r[0], "uid": r[1], "nickname": r[2], "hasCredential": True}
            for r in rows
        ]

    def get_account(self, sender_qq: str) -> dict[str, str] | None:
        with self._lock:
            row = self._accounts_conn.execute(
                f"SELECT uid, nickname, credential FROM {self.account_table} WHERE sender_qq=?",
                (sender_qq,),
            ).fetchone()
        if row is None:
            return None
        return {
            "uid": row[0],
            "nickname": row[1],
            "credential": self.dpapi.decrypt(row[2]),
        }

    def bind(self, sender_qq: str, uid: str, nickname: str, credential: str) -> None:
        encrypted = self.dpapi.encrypt(credential)
        with self._lock, self._accounts_conn:
            self._accounts_conn.execute(
                f"INSERT INTO {self.account_table} VALUES(?,?,?,?) ON CONFLICT(sender_qq) DO UPDATE SET uid=excluded.uid,nickname=excluded.nickname,credential=excluded.credential",
                (sender_qq, uid, nickname, encrypted),
            )

    def unbind(self, sender_qq: str) -> bool:
        with self._lock, self._accounts_conn:
            deleted = (
                self._accounts_conn.execute(
                    f"DELETE FROM {self.account_table} WHERE sender_qq=?", (sender_qq,)
                ).rowcount
                > 0
            )
        self.clear_account_activity(sender_qq)
        return deleted

    def clear_account_activity(self, sender_qq: str) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "DELETE FROM subscriptions WHERE sender_qq=?", (sender_qq,)
            )
            self._conn.execute(
                "UPDATE notices SET status='dropped' WHERE sender_qq=? AND status='pending'",
                (sender_qq,),
            )

    def close(self) -> None:
        if self._accounts_conn is not self._conn:
            self._accounts_conn.close()
        self._conn.close()

    def list_subscriptions(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM subscriptions ORDER BY scope_key,sender_qq"
            ).fetchall()
        return [self._subscription(r) for r in rows]

    @staticmethod
    def _subscription(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "senderQQ": row["sender_qq"],
            "key": row["scope_key"],
            "signEnabled": bool(row["sign_enabled"]),
            "reminderEnabled": bool(row["reminder_enabled"]),
            "threshold": row["threshold"],
            "lastNotified": row["last_notified"],
        }

    def set_subscription(
        self, sender_qq: str, key: str, sign: bool, reminder: bool, threshold: int
    ) -> dict[str, Any]:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO subscriptions(sender_qq,scope_key,sign_enabled,reminder_enabled,threshold) VALUES(?,?,?,?,?) ON CONFLICT(sender_qq,scope_key) DO UPDATE SET sign_enabled=excluded.sign_enabled,reminder_enabled=excluded.reminder_enabled,threshold=excluded.threshold",
                (sender_qq, key, int(sign), int(reminder), threshold),
            )
            row = self._conn.execute(
                "SELECT * FROM subscriptions WHERE sender_qq=? AND scope_key=?",
                (sender_qq, key),
            ).fetchone()
        return self._subscription(row)

    def get_subscription(self, sender_qq: str, key: str) -> dict[str, Any]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM subscriptions WHERE sender_qq=? AND scope_key=?",
                (sender_qq, key),
            ).fetchone()
        if row is None:
            return {
                "senderQQ": sender_qq,
                "key": key,
                "signEnabled": False,
                "reminderEnabled": False,
                "threshold": 180,
                "lastNotified": None,
            }
        return self._subscription(row)

    def has_subscription(self, sender_qq: str, key: str) -> bool:
        with self._lock:
            return self._conn.execute(
                "SELECT 1 FROM subscriptions WHERE sender_qq=? AND scope_key=?",
                (sender_qq, key),
            ).fetchone() is not None

    def schedule_state(self, sender_qq: str, key: str, kind: str) -> str | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM schedule_state WHERE sender_qq=? AND scope_key=? AND kind=?",
                (sender_qq, key, kind),
            ).fetchone()
        return row[0] if row else None

    def set_schedule_state(
        self, sender_qq: str, key: str, kind: str, value: str
    ) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO schedule_state VALUES(?,?,?,?) ON CONFLICT(sender_qq,scope_key,kind) DO UPDATE SET value=excluded.value",
                (sender_qq, key, kind, value),
            )

    def mark_notified(self, sender_qq: str, key: str, when: str) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE subscriptions SET last_notified=? WHERE sender_qq=? AND scope_key=?",
                (when, sender_qq, key),
            )

    def pending_notices(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id,scope_key,sender_qq,text FROM notices WHERE status='pending' ORDER BY created_at"
            ).fetchall()
        return [{"id": r[0], "key": r[1], "senderQQ": r[2], "text": r[3]} for r in rows]

    def queue_notice(self, notice_id: str, sender_qq: str, key: str, text: str) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT OR IGNORE INTO notices VALUES(?,?,?,?,?,?)",
                (notice_id, sender_qq, key, text, "pending", time.time()),
            )

    def ack_notice(self, notice_id: str, sent: bool) -> bool:
        with self._lock, self._conn:
            return (
                self._conn.execute(
                    "UPDATE notices SET status=? WHERE id=? AND status='pending'",
                    ("sent" if sent else "failed", notice_id),
                ).rowcount
                > 0
            )

    def drop_notices_for_policy(
        self, allowed: set[str], paused: set[str], globally_paused: bool
    ) -> None:
        with self._lock, self._conn:
            rows = self._conn.execute(
                "SELECT id,scope_key FROM notices WHERE status='pending'"
            ).fetchall()
            for row in rows:
                if globally_paused or row[1] not in allowed or row[1] in paused:
                    self._conn.execute(
                        "UPDATE notices SET status='dropped' WHERE id=?", (row[0],)
                    )
