"""Small, recorded credential-column patches; preserve all unrelated source."""

from adapter.paths import runtime_root

ROOT = runtime_root()
FILES = [
    ROOT
    / "core/gsuid_core/plugins/XutheringWavesUID/XutheringWavesUID/utils/database/models.py",
    ROOT / "core/gsuid_core/plugins/RoverSign/RoverSign/utils/database/models.py",
    ROOT
    / "core/gsuid_core/plugins/RoverReminder/RoverReminder/utils/database/models.py",
]
for path in FILES:
    source = path.read_text(encoding="utf-8")
    if "from adapter.encrypted_column import EncryptedToken" in source:
        continue
    source = (
        "from adapter.encrypted_column import EncryptedToken\nfrom sqlalchemy import Column\n"
        + source
    )
    for name, title in (("cookie", "Cookie"), ("bat", "bat"), ("did", "did")):
        original = f'    {name}: str = Field(default="", title="{title}")'
        replacement = f'    {name}: str = Field(default="", title="{title}", sa_column=Column(EncryptedToken(), nullable=False, default=""))'
        if source.count(original) != 1:
            raise RuntimeError(
                f"unexpected upstream credential field: {path.name}/{name}"
            )
        source = source.replace(original, replacement)
    path.write_text(source, encoding="utf-8")
print("Applied encrypted cookie/bat/did fields to three upstream models")
path = (
    ROOT / "core/gsuid_core/plugins/RoverSign/RoverSign/roversign_config/set_config.py"
)
source = path.read_text(encoding="utf-8")
source = source.replace(
    "from plugins.RoverSign.RoverSign.utils.constant import BoardcastTypeEnum",
    "from ..utils.constant import BoardcastTypeEnum",
)
path.write_text(source, encoding="utf-8")
print("Applied RoverSign package-relative configuration import")


def patch_text(path, original, replacement):
    source = path.read_text(encoding="utf-8")
    if replacement in source:
        return
    if source.count(original) != 1:
        raise RuntimeError(f"unexpected upstream patch target: {path.name}")
    path.write_text(source.replace(original, replacement), encoding="utf-8")


wiki = (
    ROOT
    / "core/gsuid_core/plugins/XutheringWavesUID/XutheringWavesUID/wutheringwaves_wiki/__init__.py"
)
patch_text(
    wiki,
    'sv_waves_guide = SV("鸣潮攻略", priority=10)',
    'sv_waves_guide = SV("鸣潮攻略", priority=10)\nsv_waves_exact_guide = SV("鸣潮矩阵攻略及列表", priority=9)',
)
source = wiki.read_text(encoding="utf-8")
# Specific matrix/list patterns must precede broad <character>攻略/武器 patterns.
for function in ("send_matrix_guide_pic", "send_weapon_list", "send_sonata_list"):
    end = source.index("async def " + function)
    start = source.rfind("@sv_waves_guide.on_regex", 0, end)
    if start >= 0 and "async def " not in source[start:end]:
        source = (
            source[:start]
            + source[start:end].replace(
                "@sv_waves_guide.on_regex", "@sv_waves_exact_guide.on_regex", 1
            )
            + source[end:]
        )
wiki.write_text(source, encoding="utf-8")
abyss = (
    ROOT
    / "core/gsuid_core/plugins/XutheringWavesUID/XutheringWavesUID/wutheringwaves_abyss/__init__.py"
)
for name, label in (
    ("sv_waves_rank_slash_list", "waves无尽排行"),
    ("sv_waves_rank_matrix_list", "waves矩阵排行"),
):
    patch_text(
        abyss,
        f'{name} = SV("{label}", priority=0)',
        f'{name} = SV("{label}", priority=-1)',
    )
cards = (
    ROOT
    / "core/gsuid_core/plugins/XutheringWavesUID/XutheringWavesUID/wutheringwaves_charinfo/card_utils.py"
)
patch_text(
    cards,
    "async def _fetch_image_bytes(url: str) -> Optional[bytes]:\n    try:",
    'async def _fetch_image_bytes(url: str) -> Optional[bytes]:\n    if Path(url).is_absolute():\n        from adapter.security import local_image\n        from adapter.paths import runtime_root\n        inputs = runtime_root() / "inputs"\n        path, _mime = local_image(url, inputs)\n        return path.read_bytes()\n    try:',
)
print(
    "Applied native command-specific priorities and validated local image input bridge"
)
