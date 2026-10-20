# Waves source and patches

This optional integration, including adapter source, installer, patches and fixture
tests, is distributed under GNU GPL version 3. See the unmodified `LICENSE` in
this directory. This notice applies to `integrations/waves` only and does not
change the authorization or license of the Qodex repository root.

The adapter and recorded patches derive from the reviewed Qbot Waves adapter.
Qodex modifications (2026-10-09): portable state paths and listener ports,
fixed-commit installation, isolated Windows Python 3.11 environment, resource
verification, public login URL revocation, subscription revocation after policy
denial, and isolated regression test setup. All corresponding source is
present in this directory. Qodex modifications (2026-10-19): current-user DPAPI
storage for independent/shared upstream author permissions, safe per-service
observations and revision checks, own-account B-AT acquisition and supplementation,
explicit original-QQ confirmation after public SMS verification, idempotent
confirmation and cancellation, and native image output/runtime path handling.
No proprietary native binaries are redistributed.

Pinned upstream source is downloaded unchanged from the official repositories
listed in `install.py`, at the commits in `versions.json`. Each upstream LICENSE
is retained inside the installation; the installer then applies the explicit,
idempotent source edits in `apply_upstream_patches.py`. The patches encrypt
cookie/bat/did columns, correct RoverSign imports, prioritize exact native
commands, restrict local image input to the adapter's validated input area,
and propagate verified own-credential status into full character-list refreshes.

Native Windows assets are downloaded only from the plugin author's declared
HTTPS resource host in `install_native_resources.py`. Playwright downloads its
own Chromium build through its pinned installed package. Upstream license and
asset terms continue to apply. Neither credentials nor runtime data are shipped.
