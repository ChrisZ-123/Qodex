"""DPAPI text columns with plaintext SQL comparisons and encrypted writes.

SQLite decrypts only inside the current Windows user's process. Comparisons
use the SQL function so randomized DPAPI ciphertext never changes equality.
"""

from __future__ import annotations

import base64

from sqlalchemy import String, event, func
from sqlalchemy.engine import Engine
from sqlalchemy.types import Text, TypeDecorator

from .storage import CredentialError, Dpapi

_dpapi = None
PREFIX = "dpapi:"


def protector():
    global _dpapi
    if _dpapi is None:
        _dpapi = Dpapi()
    return _dpapi


def decrypt_column(value):
    if value is None or value == "":
        return value
    if not isinstance(value, str) or not value.startswith(PREFIX):
        raise CredentialError("plaintext credential column rejected")
    return protector().decrypt(base64.b64decode(value[len(PREFIX) :], validate=True))


@event.listens_for(Engine, "connect")
def register_decryption(connection, _record):
    if hasattr(connection, "create_function"):
        connection.create_function("qbot_decrypt", 1, decrypt_column)


class EncryptedToken(TypeDecorator):
    impl = Text
    cache_ok = True

    class comparator_factory(Text.Comparator):
        def operate(self, op, *other, **kwargs):
            return op(func.qbot_decrypt(self.expr, type_=String()), *other, **kwargs)

    def process_bind_param(self, value, _dialect):
        if value is None or value == "":
            return value
        return PREFIX + base64.b64encode(protector().encrypt(value)).decode("ascii")

    def process_result_value(self, value, _dialect):
        return decrypt_column(value)
