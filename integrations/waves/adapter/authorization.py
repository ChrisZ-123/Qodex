"""Current-user DPAPI storage and metadata for the two upstream permissions."""

from __future__ import annotations

import json
import os
import threading
import time
from copy import deepcopy
from pathlib import Path

from .security import InvalidInput
from .storage import Dpapi, CredentialError

STATES = {"unconfigured", "configured_unverified", "verified", "authorization_failed", "service_error"}
REASONS = {
    "unconfigured": "尚未配置上游授权",
    "configured_unverified": "已加密配置；权限等待真实请求验证",
    "verified": "上游已接受此服务的请求",
    "authorization_failed": "上游拒绝此服务的授权，请检查权限或更新 token",
    "service_error": "上游服务请求失败；不代表 token 已失效",
}


class UpstreamAuthorization:
    def __init__(self, path: Path, dpapi=None):
        self.path = Path(path)
        self.dpapi = dpapi or Dpapi()
        self._lock = threading.RLock()
        self._value = {"revision": 0, "shared": False, "tokens": {"rank": "", "score": ""}, "services": {}}
        if self.path.exists():
            try:
                value = json.loads(self.dpapi.decrypt(self.path.read_bytes()))
                if (not isinstance(value, dict) or type(value.get("revision")) is not int
                    or type(value.get("shared")) is not bool
                    or set(value.get("tokens", {})) != {"rank", "score"}
                    or any(not isinstance(v, str) for v in value["tokens"].values())):
                    raise ValueError("invalid authorization data")
                self._value = value
            except Exception:
                raise CredentialError("encrypted upstream authorization could not be loaded") from None
        for service in ("rank", "score"):
            state = self._value.get("services", {}).get(service, {})
            if state.get("state") not in STATES:
                state = {"state": "configured_unverified" if self.token(service) else "unconfigured", "checkedAt": None}
            self._value["services"][service] = state

    @property
    def revision(self):
        with self._lock:
            return self._value["revision"]

    def token(self, service):
        if service not in ("rank", "score"):
            raise InvalidInput("unknown upstream service")
        with self._lock:
            key = "rank" if service == "score" and self._value["shared"] else service
            return self._value["tokens"][key]

    def metadata(self):
        with self._lock:
            result = {"revision": self.revision, "shared": self._value["shared"]}
            for service in ("rank", "score"):
                configured = bool(self.token(service))
                state = self._value["services"][service]
                name = state["state"] if configured else "unconfigured"
                result[service] = {"configured": configured, "state": name,
                                   "reason": REASONS[name], "checkedAt": state.get("checkedAt")}
            return result

    def _save(self, value):
        encrypted = self.dpapi.encrypt(json.dumps(value, separators=(",", ":")))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".pending")
        try:
            with temporary.open("wb") as handle:
                handle.write(encrypted)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)

    def update(self, *, WavesToken=None, xwtoken=None, shared=None, expected_revision=None):
        """None preserves a value; an empty string removes it. Shared uses WavesToken."""
        for token in (WavesToken, xwtoken):
            if token is not None and (not isinstance(token, str) or len(token) > 8192
                                      or any(c.isspace() or ord(c) < 32 for c in token)
                                      or not token.isascii()):
                raise InvalidInput("invalid upstream token")
        if shared is not None and type(shared) is not bool:
            raise InvalidInput("shared must be boolean")
        if expected_revision is not None and type(expected_revision) is not int:
            raise InvalidInput("invalid authorization revision")
        with self._lock:
            if expected_revision is not None and expected_revision != self.revision:
                raise InvalidInput("authorization revision changed")
            value = deepcopy(self._value)
            if WavesToken is not None:
                value["tokens"]["rank"] = WavesToken
            if xwtoken is not None:
                value["tokens"]["score"] = xwtoken
            if shared is not None:
                value["shared"] = shared
            if value["shared"] and xwtoken:
                raise InvalidInput("shared authorization takes only WavesToken")
            if value["shared"]:
                value["tokens"]["score"] = ""
            value["revision"] += 1
            for service in ("rank", "score"):
                key = "rank" if service == "score" and value["shared"] else service
                value["services"][service] = {"state": "configured_unverified" if value["tokens"][key] else "unconfigured", "checkedAt": None}
            self._save(value)
            self._value = value
            return self.metadata()

    def observe(self, service, state, *, revision=None):
        if service not in ("rank", "score") or state not in STATES:
            raise InvalidInput("invalid upstream authorization observation")
        with self._lock:
            if revision is not None and revision != self.revision:
                return False
            if not self.token(service):
                return False
            value = deepcopy(self._value)
            value["services"][service] = {"state": state, "checkedAt": int(time.time())}
            self._save(value)
            self._value = value
            return True

    def install_provider(self, config, field, service):
        """Only return a copied secret-bearing Config; persistent Config stays empty."""
        original = config.get_config
        config.set_config(field, "")

        def get_config(key, default_value=None):
            item = original(key, default_value)
            if key == field:
                item = deepcopy(item)
                item.data = self.token(service)
            return item

        config.get_config = get_config
