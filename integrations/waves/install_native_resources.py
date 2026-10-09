"""Fetch native Windows resources from the plugin author's declared HTTPS source."""

import concurrent.futures
import json
import shutil
import urllib.request
import uuid
from html.parser import HTMLParser
from urllib.parse import unquote, urljoin, urlsplit

from adapter.paths import runtime_root

ROOT = runtime_root()
BASE = "https://ww1.loping151.top/XutheringWavesUID/"
DATA = ROOT / "core/data/XutheringWavesUID"
MAPPING = {
    "resource/build/win-x86_64-py3.11/waves_build/": DATA / "build/waves_build",
    "resource/build/win-x86_64-py3.11/map/waves_build/": DATA / "build/map/waves_build",
    "resource/map/": DATA / "resource/map",
    "resource/avatar/": DATA / "resource/waves_avatar",
    "resource/weapon/": DATA / "resource/waves_weapon",
    "resource/role_pile/": DATA / "resource/role_pile",
    "resource/role_bg/": DATA / "resource/role_bg",
    "resource/role_detail/skill/": DATA / "resource/role_detail/skill",
    "resource/role_detail/chains/": DATA / "resource/role_detail/chains",
    "resource/share/": DATA / "resource/share",
    "resource/title_bg/": DATA / "resource/title_bg",
    "resource/card_polygon/": DATA / "resource/card_polygon",
    "resource/phantom/": DATA / "resource/phantom",
    "resource/material/": DATA / "resource/material",
    "resource/calendar/": DATA / "other/calendar",
    **{
        f"resource/guide/{name}/": DATA / "guide_new" / name
        for name in (
            "XMu",
            "Moealkyne",
            "JinLingZi",
            "VanZi",
            "XiaoYang",
            "WuHen",
            "XFM",
            "KuroBBS",
            "Chrysoberyl",
            "Lagvar",
        )
    },
}


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.links.extend(
                value for name, value in attrs if name == "href" and value
            )


def fetch(url):
    response = urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": "Qodex-Waves-install"}),
        timeout=40,
    )
    final = urlsplit(response.geturl())
    declared = urlsplit(BASE)
    if final.scheme != "https" or final.netloc != declared.netloc or not final.path.startswith(declared.path):
        response.close()
        raise ValueError("native resource redirect outside author's declared source")
    return response


def listing(url, local):
    with fetch(url) as response:
        parser = Links()
        parser.feed(response.read().decode("utf-8"))
    result, directories = [], []
    for href in parser.links:
        child = urljoin(url, href)
        parsed = urlsplit(child)
        if (
            parsed.scheme != "https"
            or parsed.netloc != urlsplit(BASE).netloc
            or parsed.query or parsed.fragment
            or not child.startswith(url)
            or child == url
        ):
            continue
        relative = unquote(child[len(url) :]).strip("/")
        if (
            not relative
            or "/" in relative
            or "\\" in relative
            or relative in (".", "..")
        ):
            continue
        target = local / relative
        target.resolve().relative_to(DATA.resolve())
        if child.endswith("/"):
            directories.append((child, target))
        else:
            result.append((child, target))
    return result, directories


def inventory(url, local):
    result, scanned = [], 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
        pending = {workers.submit(listing, url, local)}
        while pending:
            done, pending = concurrent.futures.wait(
                pending, return_when=concurrent.futures.FIRST_COMPLETED
            )
            for future in done:
                files, directories = future.result()
                result.extend(files)
                pending.update(
                    workers.submit(listing, *directory) for directory in directories
                )
                scanned += 1
                if scanned % 50 == 0:
                    print(
                        f"Listed {scanned} directories, {len(result)} files", flush=True
                    )
    return result


def download(item):
    url, target = item
    if target.is_file() and target.stat().st_size > 0:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".partial-" + uuid.uuid4().hex)
    try:
        with fetch(url) as response, temporary.open("xb") as output:
            shutil.copyfileobj(response, output)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    files = []
    for endpoint, local in MAPPING.items():
        print(f"Listing {endpoint}", flush=True)
        group = inventory(BASE + endpoint, local)
        if not group:
            raise RuntimeError(f"declared resource endpoint has no files: {endpoint}")
        print(f"Downloading {endpoint}: {len(group)} files", flush=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
            for count, _ in enumerate(workers.map(download, group), 1):
                if count % 200 == 0:
                    print(
                        f"Downloaded or verified existing {count}/{len(group)} files",
                        flush=True,
                    )
        files.extend(group)
    (ROOT / "work").mkdir(parents=True, exist_ok=True)
    (ROOT / "work/native-resources.json").write_text(
        json.dumps(
            {"source": BASE, "files": len(files), "platform": "win-x86_64-py3.11", "inventory": [{"path": str(target.relative_to(ROOT)), "size": target.stat().st_size} for _, target in files]},
            indent=2,
        ),
        encoding="utf-8",
    )
    print(
        f"Native and map resource installation complete: {len(files)} files", flush=True
    )


if __name__ == "__main__":
    main()
