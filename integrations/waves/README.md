# Optional Windows Waves integration

Install with a host Windows x64 Python 3.11 interpreter:

```powershell
python integrations/waves/install.py --root "$PWD/state/waves"
```

Installation downloads only the five commits in `versions.json`, installs the
portable exact Python dependency lock into an isolated venv, retains upstream
LICENSE files, applies the recorded source patches, and installs Chromium and
the author's declared Windows resources. It never starts a game, tunnel,
account login or core admin server. Repeating a completed install verifies its
manifest and preserves runtime data. Unknown pre-existing source is rejected.
`--verify` checks the completion manifest and prerequisites without writing.

The executable is `state/waves/venv/Scripts/python.exe`. Adapter source remains
in `integrations/waves/adapter`. Set `PYTHONPATH` to `integrations/waves`,
`QBOT_WAVES_ROOT` to an absolute state directory, and supply a strong
`QBOT_WAVES_TOKEN` through the environment to launch `python -m adapter.service`.
For Windows piped output set `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` (the
supervisor and installer apply this automatically).
Both HTTP listeners bind exclusively to `127.0.0.1`; environment overrides are
`QBOT_WAVES_RPC_PORT` (8788) and `QBOT_WAVES_LOGIN_PORT` (8789). Remote login is
unavailable until the owner explicitly registers the public HTTPS URL through
authenticated `POST /v1/public-url` with JSON `{"url":"https://…trycloudflare.com"}`.
Posting `{"url":null}` revokes that URL and all outstanding login tickets when
the owned tunnel stops or exits.

For Windows CI fixture regressions, install the pinned dependencies without
browser/native assets, then run the installed interpreter against fresh
temporary source and databases:

```powershell
python integrations/waves/install.py --root "$PWD/state/waves" --skip-resources
& ./state/waves/venv/Scripts/python.exe integrations/waves/run_tests.py --root "$PWD/state/waves"
```

`--skip-resources` cannot create a complete `installation.json`, so supervisors
cannot enable the game module from this fixture setup. An existing completed
installation is verified and preserved. Tests block outbound network and
exercise simulated SMS, account binding, cancellation, DPAPI and actual SQLite
transactions without real account/game requests. `--source-cache` can reuse
only correctly named archives at the fixed commits, never installed runtime
data. All test runtime files and databases are created in a temporary directory.

The completion marker has `schemaVersion: 1`, `version: 1`, `complete`,
`versions`, `pythonVersion`, `platform`, `resourcesReady` and `browserReady`.
Only a fully verified browser, native inventory, source provenance and dependency
environment yields `complete: true`. See `NOTICE.md` and the exact GPLv3 `LICENSE`.


SMS verification is a preparation step: public `POST /l/{ticket}/verify` returns
`awaiting_confirmation`, the original `targetQQ` and `{uid,nickname}` account
summary. It never writes an account binding. The original QQ must confirm via
authenticated `POST /v1/login/confirm` with `{senderQQ,requestId,accept:true}`.
The adapter rechecks the original conversation policy, ticket validity and expiry
at commit. Repeated accepted confirmations are idempotent until the ticket expires.
`POST /v1/login/cancel` takes `{requestId,key,senderQQ}` and validates the exact
origin. Cancellation, pause, whitelist removal or public URL replacement/revocation
before commit discards the pending credential. Failed commits preserve the prior
native account and adapter projection in one SQLite transaction.

Upstream author permissions are independent from the QQ RPC bearer and game login.
Authenticated `GET /v1/authorization` returns only revision, shared mode and safe
rank/score status metadata. `POST /v1/authorization` takes `{revision,shared}` and
optional nonempty `WavesToken` (rank) / `xwtoken` (score); omit unchanged credentials.
A stale revision returns HTTP 409. Shared mode uses `WavesToken` for both services;
independent mode supports separate credentials. Values are encrypted with Windows
current-user DPAPI in runtime `data/upstream-authorization.dpapi`, never returned
by the API or written into native JSON configuration. Configuration alone produces
`configured_unverified`; only a successful real service response can mark that
service `verified`. Authorization failures and service failures remain distinct.
Neither author credentials nor account databases, login tickets or subscriptions
belong in the application JSON backup.
