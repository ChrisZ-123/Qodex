"""Native GsCore plugin invocations, without core HTTP, AI or schedulers."""

from __future__ import annotations

import base64
import asyncio
import importlib
import inspect
import json
import logging
import re
import sys
import time
import warnings
from copy import deepcopy
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from io import BytesIO

import httpx

from .security import InvalidInput, SafeOperationError, check_scope, sanitize_text
from .authorization import UpstreamAuthorization
from .paths import runtime_root
from .paths import runtime_root


def _score_result_image(encoded):
    """Validate upstream image bytes before any success observation or output."""
    from PIL import Image
    from .security import image_signature

    maximum = 20 * 1024 * 1024
    if not isinstance(encoded, str) or not encoded or len(encoded) > ((maximum + 2) // 3) * 4:
        raise InvalidInput("invalid upstream score image")
    try:
        data = base64.b64decode(encoded, validate=True)
        if len(data) > maximum or not any(image_signature(data, mime) for mime in ("image/png", "image/jpeg", "image/webp")):
            raise ValueError("unsupported image")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                if image.format not in {"PNG", "JPEG", "WEBP"}:
                    raise ValueError("unsupported image")
                image.verify()
            with Image.open(BytesIO(data)) as image:
                image.load()
    except Exception:
        raise InvalidInput("invalid upstream score image") from None
    return data

_REQUEST = ContextVar("waves_native_request", default=None)
_HTTP_SEND = httpx.AsyncClient.send
_HTTP_INSTALLED = False
UPLOADS = {
    "waves_score_rank": "upload_score",
    "waves_abyss_record": "upload_abyss",
    "waves_slash_record": "upload_slash",
    "waves_matrix_record": "upload_matrix",
}
SCORE_HANDLERS = {"score_phantom_handler", "analyze_phantom_handler", "score_role_panel", "score_phantom_rank"}


@dataclass
class RequestContext:
    runtime: object
    record: object
    uid: str | None = None
    pending: list = field(default_factory=list)
    children: set = field(default_factory=set)
    operation: dict | None = None
    revision: int = 0
    active: bool = True

    def check(self):
        if not self.active or self.record.status != "running" or not self.runtime.permitted(self.record.key):
            raise InvalidInput("conversation paused or operation cancelled")


class RequestTasks(set):
    def add(self, task):
        super().add(task)
        context = _REQUEST.get()
        if context is not None:
            context.children.add(task)


async def _upstream_send(client, request, *args, **kwargs):
    """Observe actual upstream responses, retaining the task's policy boundary."""
    host, path = request.url.host, request.url.path
    service = (
        "rank" if host == "wh.loping151.site" and path in {
            "/top/waves/upload", "/top/waves/abyss/upload", "/top/waves/slash/upload", "/top/waves/matrix/upload"
        } else "score" if host == "scoreecho.loping151.site" and path in {"/score", "/score_zh", "/score_en"} else None
    )
    if service is None:
        return await _HTTP_SEND(client, request, *args, **kwargs)
    context = _REQUEST.get()
    if context is None:
        raise InvalidInput("upstream operation requires a current user task")
    context.check()
    if request.url.scheme != "https" or request.url.port not in (None, 443):
        raise InvalidInput("invalid upstream endpoint")
    if not context.runtime.authorization.token(service):
        raise InvalidInput("upstream authorization is not configured")
    operation = context.operation
    if operation is None or operation["service"] != service:
        raise InvalidInput("upstream operation is outside the current task")

    def check_current():
        try:
            context.check()
        except InvalidInput:
            operation.update(state="cancelled", reason="当前任务已取消或会话已暂停")
            raise
        if context.revision != context.runtime.authorization.revision:
            operation.update(state="cancelled", reason="上游授权已变更，旧请求结果已作废")
            raise InvalidInput("upstream authorization changed during this task")
        if not context.runtime.authorization.token(service):
            operation.update(state="cancelled", reason="上游授权已清除，当前请求已取消")
            raise InvalidInput("upstream authorization is not configured")

    check_current()
    if service == "score":
        if operation.get("attempted"):
            raise InvalidInput("score task may make only one upstream request")
        operation["attempted"] = True
        try:
            await context.runtime._score_rate(context)
        except InvalidInput:
            check_current()
            raise
        except asyncio.CancelledError:
            operation.update(state="cancelled", reason="当前任务已取消")
            raise
    try:
        # Rate limiting yields to configuration/policy changes; the same check also
        # protects the rank gateway immediately before its transport call.
        check_current()
        response = await _HTTP_SEND(client, request, *args, **kwargs)
        await response.aread()
        check_current()
        state = "authorization_failed" if response.status_code in (401, 403) else "service_error"
        data = None
        if 200 <= response.status_code < 300:
            try:
                data = response.json()
            except (ValueError, UnicodeDecodeError):
                pass
            if isinstance(data, dict):
                if data.get("code") in (401, 403):
                    state = "authorization_failed"
                explicit_ok = data.get("code") in (0, 200) or data.get("success") is True or data.get("status") == "success"
                if service == "score":
                    try:
                        _score_result_image(data.get("result_image_base64"))
                        explicit_ok = True
                    except InvalidInput:
                        explicit_ok = False
                    character = data.get("matched_character")
                    if character is not None and (not isinstance(character, str) or not re.fullmatch(r"[\w\u4e00-\u9fff -]{1,80}", character)):
                        explicit_ok = False
                if explicit_ok and data.get("success") is not False and data.get("code", 0) in (0, 200):
                    state = "verified"
        check_current()
        if not context.runtime.authorization.observe(service, state, revision=context.revision):
            operation.update(state="cancelled", reason="上游授权已变更，旧请求结果已作废")
            raise InvalidInput("upstream authorization changed during this task")
        operation["state"] = state
        operation["reason"] = context.runtime.authorization.metadata()[service]["reason"]
        if state != "verified":
            # Upstream error bodies may echo credentials; handlers only see fixed text.
            raise InvalidInput("upstream authorization rejected" if state == "authorization_failed" else "upstream service failed")
        return response
    except (httpx.RequestError, httpx.HTTPStatusError):
        check_current()
        if not context.runtime.authorization.observe(service, "service_error", revision=context.revision):
            operation.update(state="cancelled", reason="上游授权已变更，旧请求结果已作废")
            raise InvalidInput("upstream authorization changed during this task") from None
        operation.update(state="service_error", reason="上游服务请求失败")
        raise InvalidInput("upstream service failed") from None
    except asyncio.CancelledError:
        operation.update(state="cancelled", reason="当前任务已取消")
        raise

PLUGIN = "gsuid_core.plugins.XutheringWavesUID.XutheringWavesUID"
SIGN = "gsuid_core.plugins.RoverSign.RoverSign"
REMINDER = "gsuid_core.plugins.RoverReminder.RoverReminder"
SCORE = "gsuid_core.plugins.ScoreEcho.ScoreEcho"

# Only reviewed, own-account queries. Privileged and mutation handlers never enter.
HANDLERS = {
    "help": {"send_help_img", "send_change_help_img"},
    "stamina": {"send_daily_info_pic"},
    "charinfo": {
        "get_char_card_list",
        "get_char_card_single",
        "get_char_card_shortcut",
        "send_card_info",
        "send_one_char_detail_msg",
        "send_char_detail_msg",
        "send_char_detail_msg2",
        "send_char_detail_msg2_typo",
        "send_char_detail_msg2_weight",
        "send_char_optimize_msg",
        "send_score_explain_msg",
    },
    "charlist": {"send_char_list_msg_new"},
    "query": {
        "handle_char_hold_rate",
        "handle_tower_appear_rate",
        "handle_slash_appear_rate",
        "handle_matrix_appear_rate",
    },
    "roleinfo": {"send_role_info", "send_skin_info", "send_score_info"},
    "explore": {"send_card_info"},
    "abyss": {
        "send_waves_abyss_info",
        "send_waves_challenge_info",
        "send_waves_slash_info",
        "send_waves_matrix_info",
        "send_waves_rank_slash_info",
        "send_waves_rank_slash_list_info",
        "send_waves_rank_matrix_info",
        "send_waves_rank_matrix_list_info",
    },
    "calendar": {"send_waves_calendar_pic"},
    "period": {"send_period"},
    "more": {"send_poker"},
    "echo": {"send_echo_list_msg"},
    "develop": {"calc_develop"},
    "wiki": {
        "send_waves_wiki",
        "send_role_guide_pic",
        "send_matrix_guide_pic",
        "send_weapon_list",
        "send_sonata_list",
        "send_tower_challenge_info",
        "send_slash_challenge_info",
        "send_matrix_challenge_info",
    },
    "ann": {"ann_"},
    "gachalog": {
        "send_gacha_log_card_info",
        "send_gacha_log_help",
        "send_gacha_rank_info",
    },
    "sign": {"send_sign_calendar"},
    "alias": {"handle_list_char_alias", "handle_all_char_alias"},
    "bbs": {"kuro_coin_"},
    "code": {"get_sign_func"},
    "up": {"get_pool_countdown"},
    "update": {"send_waves_update_log_msg"},
    "rank": {
        "send_rank_card",
        "send_phantom_rank_card",
        "send_all_rank_card",
        "send_total_rank_card",
        "send_phantom_total_rank_card",
        "send_rank_list_card",
    },
}
COMMANDS = [
    {"command": "ww帮助", "description": "鸣潮原生帮助图"},
    {"command": "ww体力", "description": "本人实时便笺，需要本人登录"},
    {"command": "ww查询", "description": "本人账户卡片，需要本人登录"},
    {"command": "ww练度统计", "description": "本人角色练度"},
    {"command": "ww角色面板 <角色名>", "description": "本人角色面板"},
    {"command": "ww刷新面板", "description": "刷新本人游戏面板缓存"},
    {"command": "ww探索度", "description": "本人地图探索进度"},
    {"command": "ww深塔", "description": "本人逆境深塔成绩"},
    {"command": "ww冥海", "description": "本人冥歌海墟成绩"},
    {"command": "ww矩阵", "description": "本人终焉矩阵成绩"},
    {"command": "ww日历", "description": "游戏活动日历"},
    {"command": "ww星声", "description": "本人星声资源简报"},
    {"command": "ww公告", "description": "官方公告"},
    {"command": "ww签到日历", "description": "本人签到记录"},
    {"command": "ww抽卡记录", "description": "已存在的本人抽卡记录"},
    {"command": "ww<角色名>攻略", "description": "角色攻略图"},
]


class NativeRuntime:
    def __init__(self, root: Path | None = None):
        root = root if root is not None else runtime_root()
        self.root = root
        self.ready = False
        self.login_ready = False
        self.loaded = set()
        self.errors = {}
        self.sign_module = self.reminder_module = None
        self.triggers = []
        self.permitted = lambda key: True
        self.sign_time = (8, 0)
        self.score_help = False
        self.score_module = None
        self._score_lock = asyncio.Lock()
        self._score_last = 0.0
        self._bat_lock = asyncio.Lock()
        self.authorization = UpstreamAuthorization(root / "data" / "upstream-authorization.dpapi")

    async def initialize(self):
        sys.path.insert(0, str(self.root / "core"))
        from gsuid_core.config import core_config

        core_config.set_config("masters", [])
        core_config.set_config("superusers", [])
        core_config.set_config("ENABLE_HTTP", False)
        from gsuid_core.ai_core.configs.ai_config import ai_config

        ai_config.set_config("enable", False)
        from gsuid_core.utils.plugins_config.gs_config import core_plugins_config

        core_plugins_config.set_config("AutoInstallDep", False)
        core_plugins_config.set_config("AutoUpdateDep", False)
        # Import configs before the native package; imports then honor these values.
        config = importlib.import_module(f"{PLUGIN}.wutheringwaves_config")
        for key, value in {
            "WavesOnlySelfCk": True,
            "AtCheck": False,
            "KuroUrlProxyUrl": "",
            "WavesAnnOpen": False,
            "DelInvalidCookie": False,
            "WavesToken": "",
            "ResourceUseCNB": False,
        }.items():
            config.WutheringWavesConfig.set_config(key, value)
        self.authorization.install_provider(config.WutheringWavesConfig, "WavesToken", "rank")
        from gsuid_core.utils.database import base_models as database

        await database.init_database()
        importlib.import_module(PLUGIN)
        for name in HANDLERS:
            try:
                importlib.import_module(f"{PLUGIN}.wutheringwaves_{name}")
                self.loaded.add(name)
            except Exception as error:
                self.errors[name] = type(error).__name__
        try:
            sign_config = importlib.import_module(
                f"{SIGN}.roversign_config.roversign_config"
            ).RoverSignConfig
            for key, value in {
                "UserWavesSignin": True,
                "UserPGRSignin": False,
                "UserBBSSchedSignin": False,
                "BBSLink": [],
                "SchedSignin": False,
                "BBSSchedSignin": False,
                "SigninMaster": False,
            }.items():
                sign_config.set_config(key, value)
            self.sign_module = importlib.import_module(
                f"{SIGN}.roversign_sign.new_sign"
            )
            self.sign_time = tuple(
                int(value) for value in sign_config.get_config("SignTime").data
            )
        except Exception as error:
            self.errors["RoverSign"] = type(error).__name__
        try:
            self.reminder_module = importlib.import_module(
                f"{REMINDER}.roverreminder_push"
            )
        except Exception as error:
            self.errors["RoverReminder"] = type(error).__name__
        try:
            score_config = importlib.import_module(
                f"{SCORE}.scoreecho_config.config"
            ).seconfig
            score_config.set_config("xwtoken", "")
            self.authorization.install_provider(score_config, "xwtoken", "score")
            importlib.import_module(f"{SCORE}.scoreecho_help")
            self.score_help = True
            self.score_module = importlib.import_module(f"{SCORE}.scoreecho_score")
            self.score_module.get_image = self._score_images
            self.score_module._encode_images = self._score_encode
            self.score_module._resolve_score_uid = self._score_uid
            self.score_module._get_bound_uid = self._score_uid
            self.score_module._MAX_IMAGE_BYTES = 1024 * 1024
        except Exception as error:
            self.errors["ScoreEcho"] = type(error).__name__
        from sqlmodel import SQLModel

        async with database.engine.begin() as connection:
            await connection.run_sync(SQLModel.metadata.create_all)
        from gsuid_core.sv import SL

        for sv in SL.lst.values():
            if sv.name in ("waves无尽排行", "waves矩阵排行"):
                # Migrate the defaults already cached by the first native boot.
                sv.set(priority=-1)
            if not sv.enabled or sv.pm < 6 or sv.plugins.pm < 6:
                continue
            for triggers in sv.TL.values():
                for trigger in triggers.values():
                    module = trigger.func.__module__
                    for name, names in HANDLERS.items():
                        if (
                            module == f"{PLUGIN}.wutheringwaves_{name}"
                            and trigger.func.__name__ in names
                            and trigger.type not in ("file", "message", "meta")
                        ):
                            self.triggers.append((sv.priority, trigger))
                    if (
                        module == f"{SCORE}.scoreecho_help"
                        and trigger.func.__name__ == "send_score_help"
                    ):
                        self.triggers.append((sv.priority, trigger))
                    if module == f"{SCORE}.scoreecho_score" and trigger.func.__name__ in SCORE_HANDLERS:
                        self.triggers.append((sv.priority, trigger))
        self.triggers.sort(key=lambda item: item[0])
        self.api = importlib.import_module(f"{PLUGIN}.utils.waves_api").waves_api
        self._install_upload_capture()
        global _HTTP_INSTALLED
        if not _HTTP_INSTALLED:
            httpx.AsyncClient.send = _upstream_send
            _HTTP_INSTALLED = True
        self.login_ready = True
        self.ready = "help" in self.loaded
        # Upstream error diagnostics can include credential-bearing API objects.
        # RPC task states retain safe error types; raw native diagnostics stay off.
        logging.getLogger("GsCore").disabled = True
        # Registered upstream cron jobs remain inert: start_scheduler is never called.

    def status(self):
        authorization = self.authorization.metadata()
        versions_path = self.root / "versions.json"
        versions = (
            json.loads(versions_path.read_text(encoding="utf-8-sig"))
            if versions_path.exists()
            else {}
        )
        labels = {
            "help": "帮助图片",
            "stamina": "实时便笺",
            "charinfo": "角色面板",
            "charlist": "练度统计",
            "roleinfo": "账户资料",
            "abyss": "深塔与冥海",
            "wiki": "攻略与图鉴",
            "calendar": "活动日历",
            "gachalog": "抽卡记录",
        }
        capabilities = [
            {
                "id": key,
                "label": label,
                "status": "ready" if key in self.loaded else "pending",
                "reason": ""
                if key in self.loaded
                else self.errors.get(key, "初始化或资源待就绪"),
            }
            for key, label in labels.items()
        ]
        capabilities.extend(
            [
                {
                    "id": "sign",
                    "label": "本人签到",
                    "status": "ready" if self.sign_module else "pending",
                    "reason": ""
                    if self.sign_module
                    else self.errors.get("RoverSign", "插件待就绪"),
                },
                {
                    "id": "reminder",
                    "label": "体力提醒",
                    "status": "ready" if self.reminder_module else "pending",
                    "reason": ""
                    if self.reminder_module
                    else self.errors.get("RoverReminder", "插件待就绪"),
                },
                {
                    "id": "rank_upload",
                    "label": "总排行上传",
                    "status": "ready" if authorization["rank"]["state"] == "verified" else "pending",
                    "state": authorization["rank"]["state"],
                    "reason": authorization["rank"]["reason"],
                },
                {
                    "id": "scoreecho",
                    "label": "声骸截图评分与分析",
                    "status": "ready" if self.score_module and authorization["score"]["state"] == "verified" else "pending",
                    "state": authorization["score"]["state"],
                    "reason": authorization["score"]["reason"]
                    if self.score_module
                    else self.errors.get("ScoreEcho", "原生扩展待就绪"),
                },
                {
                    "id": "scoreecho_help",
                    "label": "声骸分析帮助",
                    "status": "ready" if self.score_help else "pending",
                    "reason": ""
                    if self.score_help
                    else self.errors.get("ScoreEcho", "原生扩展待就绪"),
                },
            ]
        )
        return {
            "ready": self.ready,
            "versions": versions,
            "capabilities": capabilities,
            "authorization": authorization,
            "commands": self.command_catalog() if self.ready else [],
            "error": None if self.ready else "鸣潮原生插件初始化未完成",
        }

    def command_catalog(self):
        from .catalog import DESCRIPTIONS, EXAMPLES

        catalog = {}
        for _priority, trigger in self.triggers:
            name = trigger.func.__name__
            examples = (
                ({"score_phantom_handler": ["ww椿4c", "ww椿评分"], "score_role_panel": ["ww分析椿面板"]}.get(name, EXAMPLES.get(name, [])))
                if trigger.type == "regex"
                else [
                    trigger.prefix
                    + trigger.keyword
                    + (
                        "椿"
                        if trigger.type == "prefix" and name == "send_char_detail_msg"
                        else ""
                    )
                ]
            )
            for command in examples:
                try:
                    actual = self.matching(command)
                except InvalidInput:
                    continue
                if not any(
                    candidate.func.__name__ == name
                    and candidate.func.__module__ == trigger.func.__module__
                    for candidate in actual
                ):
                    continue
                module = trigger.func.__module__.split(".")[-1]
                category = module.removeprefix("wutheringwaves_")
                catalog[command] = {
                    "command": command,
                    "description": "本人声骸截图评分与分析" if module == "scoreecho_score" else DESCRIPTIONS.get(category, name),
                    "handler": name,
                    "module": module,
                    "arguments": trigger.type not in ("fullmatch", "regex"),
                }
        return list(catalog.values())

    def event(self, command, sender, key, message_id, images=()):
        from gsuid_core.models import Event

        kind, target = check_scope(key, sender)
        paths = [str(path) for path in images]
        if command[:2].lower() == "ww":
            command = "ww" + command[2:]
        return Event(
            bot_id="onebot",
            real_bot_id="onebot",
            bot_self_id="qbot-waves",
            user_id=sender,
            group_id=target if kind == "group" else None,
            user_type="group" if kind == "group" else "direct",
            user_pm=6,
            msg_id=message_id,
            raw_text=command,
            text=command,
            is_tome=True,
            image=paths[0] if paths else None,
            image_list=paths,
        )

    def matching(self, command, event=None):
        if (
            not isinstance(command, str)
            or len(command) > 500
            or not re.match(r"^ww\s*\S", command, re.I)
        ):
            raise InvalidInput("only catalogued ww commands are allowed")
        if (
            "\n" in command
            or "\r" in command
            or re.search(
                r"(?:https?://|file://|token|cookie|添加.?ck|获取.?ck|导出|登录|解绑|删除|签到$|开启|关闭|订阅|安装|下载|主人|配置)",
                command,
                re.I,
            )
        ):
            raise InvalidInput(
                "command needs the explicit consent endpoint or is unavailable"
            )
        if not self.ready:
            raise InvalidInput("native Waves plugin is unavailable")
        command = "ww" + command[2:]
        event = event or self.event(command, "12345", "private:12345", "catalog")
        from gsuid_core.trigger_index import get_trigger_index

        index = get_trigger_index()
        allowed = {trigger for _priority, trigger in self.triggers}
        matched = [
            trigger
            for trigger in index.candidates(event)
            if trigger in allowed and trigger.check_command(event)
        ]
        matched.sort(
            key=lambda trigger: (not trigger.prefix, index.owner_of(trigger).priority)
        )
        dispatched = []
        for trigger in matched:
            dispatched.append(trigger)
            if trigger.block:
                break
        if not dispatched:
            raise InvalidInput("command is outside the safe catalog")
        return dispatched

    def match(self, command, event=None):
        return self.matching(command, event)[0]

    def validate_command(self, command):
        self.match(command)

    def validate_sign(self):
        if not self.sign_module:
            raise InvalidInput("RoverSign is unavailable")

    def _install_upload_capture(self):
        queues = importlib.import_module(f"{PLUGIN}.utils.queues.queues")
        # Preserve the original queue handlers and compiled gateway signing checks.
        # Only the dispatcher boundary changes: no source-less background upload.
        queues.dispatcher.emit = self._capture_upload
        refresh = importlib.import_module(f"{PLUGIN}.utils.refresh_char_detail")
        refresh._BG_TASKS = RequestTasks(refresh._BG_TASKS)

    def _capture_upload(self, queue, item):
        context = _REQUEST.get()
        if context is None or context.runtime is not self or queue not in UPLOADS:
            return
        context.check()
        uid_field = "wavesId" if queue in ("waves_slash_record", "waves_matrix_record") else "waves_id"
        if not isinstance(item, dict) or not context.uid or str(item.get(uid_field, "")) != context.uid:
            raise InvalidInput("upload must belong to the sender's own bound UID")
        if "user_id" in item and str(item["user_id"]) != context.record.sender_qq:
            raise InvalidInput("upload must belong to the current sender")
        context.pending.append((queue, deepcopy(item)))

    async def _score_uid(self, event):
        context = _REQUEST.get()
        if context is None or event.user_id != context.record.sender_qq:
            raise InvalidInput("score data requires the current sender")
        context.check()
        return context.uid

    async def _score_images(self, event):
        context = _REQUEST.get()
        if context is None:
            raise InvalidInput("score image requires the current user task")
        context.check()
        if not context.record.images:
            raise InvalidInput("请随命令提供当前或引用的声骸截图")
        values = []
        from .security import local_image
        for image in context.record.images:
            path, _mime = local_image(str(image), self.root / "inputs")
            data = path.read_bytes()
            if len(data) > 1024 * 1024:
                if self.score_module is None:
                    raise InvalidInput("声骸图片压缩模块尚未就绪")
                data = await asyncio.to_thread(self.score_module._compress_image, data)
                context.check()
            if len(data) > 1024 * 1024:
                raise InvalidInput("压缩后每张声骸截图不得超过 1 MiB")
            values.append("base64://" + base64.b64encode(data).decode("ascii"))
        return values

    async def _score_encode(self, images):
        result = []
        for source in images:
            if not isinstance(source, str) or not source.startswith("base64://"):
                raise InvalidInput("score accepts only current cached images")
            if len(base64.b64decode(source[9:], validate=True)) > 1024 * 1024:
                raise InvalidInput("score image exceeds 1 MiB")
            result.append(source[9:])
        return result

    async def _score_rate(self, context):
        # The upstream README limits requests to 10 per second.
        async with self._score_lock:
            context.check()
            delay = 0.1 - (time.monotonic() - self._score_last)
            if delay > 0:
                await asyncio.sleep(delay)
            context.check()
            self._score_last = time.monotonic()

    def _operation(self, context, service, kind):
        operation = {"service": service, "kind": kind, "state": "running", "reason": ""}
        if not hasattr(context.record, "operations"):
            context.record.operations = []
        context.record.operations.append(operation)
        context.operation = operation
        context.revision = self.authorization.revision
        return operation

    async def _flush_uploads(self, context):
        while context.pending:
            context.check()
            queue, item = context.pending.pop(0)
            operation = self._operation(context, "rank", queue)
            if not self.authorization.token("rank"):
                operation.update(state="unconfigured", reason="尚未配置上游排行授权，本次上传未执行")
                continue
            try:
                gateway = importlib.import_module(f"{PLUGIN}.utils.waves_build.upload_gateway")
                await getattr(gateway, UPLOADS[queue])(item)
                context.check()
                if operation["state"] == "running":
                    # Gateway can swallow errors or reject its signing preflight.
                    operation.update(state="service_error", reason="原版上传入口未返回可验证的上游结果")
                    self.authorization.observe("rank", "service_error", revision=context.revision)
            except asyncio.CancelledError:
                operation.update(state="cancelled", reason="当前任务已取消")
                raise
            except Exception:
                context.check()
                if operation["state"] == "running":
                    operation.update(state="service_error", reason="原版排行上传失败")
                    self.authorization.observe("rank", "service_error", revision=context.revision)
            finally:
                context.operation = None

    async def run(self, record, sink):
        context = RequestContext(self, record)
        marker = _REQUEST.set(context)
        try:
            context.check()
            models = importlib.import_module(f"{PLUGIN}.utils.database.models")
            context.uid = await models.WavesBind.get_uid_by_game(record.sender_qq, "onebot")
            await self._run_handlers(record, sink, context)
            while context.children:
                children = tuple(context.children)
                context.children.clear()
                await asyncio.gather(*children)
            await self._flush_uploads(context)
        finally:
            context.active = False
            for child in context.children:
                child.cancel()
            _REQUEST.reset(marker)

    async def _run_handlers(self, record, sink, context):
        event = self.event(
            record.command,
            record.sender_qq,
            record.key,
            record.message_id,
            record.images,
        )
        bot = CapturedBot(sink, event)
        if record.command == "__sign":
            self.validate_sign()
            result = await self.sign_module.rover_sign_up_handler(bot, event)
            await bot.send(result)
            return
        account_prepared = False
        bat_queries = {
            f"{PLUGIN}.wutheringwaves_charlist": {"send_char_list_msg_new"},
            f"{PLUGIN}.wutheringwaves_charinfo": {"send_card_info", "send_one_char_detail_msg"},
            f"{PLUGIN}.wutheringwaves_abyss": {
                "send_waves_abyss_info", "send_waves_challenge_info",
                "send_waves_slash_info", "send_waves_matrix_info",
            },
            f"{PLUGIN}.wutheringwaves_stamina": {"send_daily_info_pic"},
            f"{PLUGIN}.wutheringwaves_roleinfo": {"send_role_info", "send_skin_info", "send_score_info"},
            f"{PLUGIN}.wutheringwaves_explore": {"send_card_info"},
        }
        for trigger in self.matching(record.command, event):
            context.check()
            handler_event = await trigger.get_command(deepcopy(event))
            requested_uid = handler_event.regex_dict.get("waves_id")
            if trigger.func.__module__ == f"{PLUGIN}.wutheringwaves_charlist":
                match = re.search(
                    r"(\d+)?(?:刷新练度统计|刷新角色列表|刷新练度|练度统计|角色列表|练度|updld|ld)",
                    handler_event.raw_text,
                )
                requested_uid = match.group(1) if match else None
            if requested_uid:
                models = importlib.import_module(f"{PLUGIN}.utils.database.models")
                own_uid = await models.WavesBind.get_uid_by_game(
                    record.sender_qq, "onebot"
                )
                if requested_uid != own_uid:
                    raise InvalidInput("only the sender's own bound UID may be queried")
            if not account_prepared and trigger.func.__name__ in bat_queries.get(trigger.func.__module__, set()):
                await self._ensure_account_bat(context)
                account_prepared = True
            bot.ev = handler_event
            # @SV wraps handler exceptions. Unwrap to preserve true completion.
            function = inspect.unwrap(trigger.func)
            if trigger.func.__module__ == f"{SCORE}.scoreecho_score":
                if not context.uid:
                    raise InvalidInput("请先绑定本人的鸣潮 UID")
                if function.__name__ in {"score_phantom_handler", "analyze_phantom_handler"}:
                    endpoint = self.score_module.seconfig.get_config("endpoint").data
                    if endpoint not in {"https://scoreecho.loping151.site/score", "https://scoreecho.loping151.site/score_zh", "https://scoreecho.loping151.site/score_en"}:
                        raise InvalidInput("评分服务地址不在允许列表")
                    if not self.authorization.token("score"):
                        raise InvalidInput("声骸评分服务尚未配置上游授权")
                    await self._score_images(handler_event)
                    operation = self._operation(context, "score", function.__name__)
                    output_start = len(record.outputs)
                    await function(bot, handler_event)
                    if operation["state"] == "running":
                        operation.update(state="service_error", reason="评分请求未返回可验证的上游结果")
                        self.authorization.observe("score", "service_error", revision=context.revision)
                    context.operation = None
                    if operation["state"] != "verified":
                        raise InvalidInput("声骸评分服务请求未成功")
                    if not any(output.get("type") == "image" for output in record.outputs[output_start:]):
                        operation.update(state="service_error", reason="评分处理器未输出有效结果图片")
                        self.authorization.observe("score", "service_error", revision=context.revision)
                        raise InvalidInput("声骸评分未生成有效结果图片")
                    continue
            await function(bot, handler_event)

    async def _official(self, path, data, token="", did=None):
        util = importlib.import_module(f"{PLUGIN}.utils.api.request_util")
        import uuid

        did = did or str(uuid.uuid4()).upper()
        if path == "/user/sdkLogin":
            data = dict(data, devCode=did)
        headers = {
            "source": "h5" if path == "/user/getSmsCodeForH5" else "ios",
            "devCode": did,
            "User-Agent": util.IOS_USER_AGENT,
            "Content-Type": util.CONTENT_TYPE,
        }
        if token:
            headers["token"] = token
        if path == "/aki/roleBox/requestToken":
            headers.update({"did": did, "b-at": ""})
        stage = {
            "/user/getSmsCodeForH5": "sms", "/user/sdkLogin": "login",
            "/gamer/role/list": "roles", "/aki/roleBox/requestToken": "bat",
        }.get(path, "official")
        try:
            async with httpx.AsyncClient(
                timeout=20, follow_redirects=False, trust_env=False
            ) as client:
                response = await client.post(
                    "https://api.kurobbs.com" + path, data=data, headers=headers
                )
                response.raise_for_status()
                result = response.json()
        except httpx.TimeoutException:
            raise SafeOperationError(stage, "timeout") from None
        except httpx.HTTPStatusError as error:
            status = error.response.status_code
            reason = f"http_{status}" if status in (400, 401, 403, 429) else "http_server" if status >= 500 else "http_error"
            raise SafeOperationError(stage, reason) from None
        except httpx.RequestError:
            raise SafeOperationError(stage, "network") from None
        except (ValueError, UnicodeDecodeError):
            raise SafeOperationError(stage, "invalid_response") from None
        if not isinstance(result, dict):
            raise SafeOperationError(stage, "invalid_response")
        business_code = result.get("code")
        if type(business_code) is not int:
            raise SafeOperationError(stage, "invalid_response")
        if business_code not in (0, 200):
            reason = f"code_{business_code}" if business_code in (102, 130, 132, 220, 270, 999, 1000, 10903) else "business_rejected"
            raise SafeOperationError(stage, reason)
        value = result.get("data")
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except (ValueError, UnicodeDecodeError):
                pass
        return value, did

    async def _request_bat(self, uid, token, did, server_id):
        try:
            data, _did = await self._official(
                "/aki/roleBox/requestToken",
                {"roleId": uid, "serverId": server_id}, token, did,
            )
            if not isinstance(data, dict) or not isinstance(data.get("accessToken"), str) or not data["accessToken"]:
                raise SafeOperationError("bat", "missing_credential")
            return data["accessToken"]
        except asyncio.CancelledError:
            raise
        except SafeOperationError:
            raise
        except Exception:
            raise SafeOperationError("bat", "request_failed") from None

    async def _ensure_account_bat(self, context):
        """Prepare missing own-account data tokens before querying, once per account."""
        if not context.uid or not re.fullmatch(r"1\d{8}", context.uid):
            return
        from gsuid_core.utils.database import base_models as database
        from sqlmodel import select, update

        models = importlib.import_module(f"{PLUGIN}.utils.database.models")
        async with self._bat_lock:
            context.check()
            async with database.async_maker() as session:
                account = (await session.execute(select(models.WavesUser).where(
                    models.WavesUser.user_id == context.record.sender_qq,
                    models.WavesUser.bot_id == "onebot",
                    models.WavesUser.uid == context.uid,
                    models.WavesUser.game_id == 3,
                ))).scalar_one_or_none()
                if account is None or account.bat:
                    return
                if not account.cookie or not account.did or account.status == "无效":
                    raise SafeOperationError("bat", "credential_incomplete")
                cookie, did = account.cookie, account.did
            context.check()
            bat = await self._request_bat(
                context.uid, cookie, did, "76402e5b20be2c39f095a152090afddc"
            )
            context.check()
            async with database.async_maker() as session:
                result = await session.execute(update(models.WavesUser).where(
                    models.WavesUser.user_id == context.record.sender_qq,
                    models.WavesUser.bot_id == "onebot",
                    models.WavesUser.uid == context.uid,
                    models.WavesUser.game_id == 3,
                    models.WavesUser.cookie == cookie,
                    models.WavesUser.did == did,
                    models.WavesUser.bat == "",
                    models.WavesUser.status == account.status,
                    select(models.WavesBind).where(
                        models.WavesBind.user_id == context.record.sender_qq,
                        models.WavesBind.bot_id == "onebot",
                        models.WavesBind.uid == context.uid,
                    ).exists(),
                ).values(bat=bat, platform="ios"))
                if result.rowcount != 1:
                    raise SafeOperationError("bat", "account_changed")
                context.check()
                await session.commit()

    async def request_sms(self, phone, captcha):
        allowed = {
            "lot_number",
            "captcha_output",
            "pass_token",
            "gen_time",
            "captcha_id",
        }
        if (
            not isinstance(captcha, dict)
            or set(captcha) != allowed
            or any(
                not isinstance(value, str) or not value or len(value) > 4096
                for value in captcha.values()
            )
        ):
            raise InvalidInput("official captcha required")
        if captcha["captcha_id"] != "ec4aa4174277d822d73f2442a165a2cd":
            raise InvalidInput("invalid captcha provider")
        await self._official(
            "/user/getSmsCodeForH5",
            {"mobile": phone, "geeTestData": json.dumps(captcha)},
        )

    async def verify_sms(self, phone, code):
        login, did = await self._official(
            "/user/sdkLogin", {"mobile": phone, "code": code}
        )
        if (
            not isinstance(login, dict)
            or not isinstance(login.get("token"), str)
            or not login["token"]
        ):
            raise SafeOperationError("login", "missing_credential")
        token = login["token"]
        roles, _did = await self._official(
            "/gamer/role/list", {"gameId": 3}, token, did
        )
        if not isinstance(roles, list):
            raise SafeOperationError("roles", "invalid_response")
        role = next(
            (
                item
                for item in roles
                if isinstance(item, dict)
                and item.get("gameId") in (3, "3")
                and re.fullmatch(r"1\d{8}", str(item.get("roleId", "")))
            ),
            None,
        )
        if not role:
            raise SafeOperationError("roles", "missing_role")
        uid = str(role["roleId"])
        server_id = role.get("serverId", "76402e5b20be2c39f095a152090afddc")
        bat = await self._request_bat(uid, token, did, server_id)
        credentials = {
            "token": token,
            "did": did,
            "bat": bat,
            "serverId": server_id,
        }
        return (
            uid,
            sanitize_text(role.get("roleName", "鸣潮玩家"))[:100],
            json.dumps(credentials),
        )

    async def bind_account(self, login, credential, store, validate):
        from gsuid_core.utils.database import base_models as database
        from sqlmodel import select

        models = importlib.import_module(f"{PLUGIN}.utils.database.models")
        values = json.loads(credential)
        if not isinstance(values.get("bat"), str) or not values["bat"]:
            raise SafeOperationError("bat", "missing_credential")
        async with database.async_maker() as session:
            account = (
                await session.execute(
                    select(models.WavesUser).where(
                        models.WavesUser.user_id == login.sender_qq,
                        models.WavesUser.bot_id == "onebot",
                        models.WavesUser.uid == login.uid,
                    )
                )
            ).scalar_one_or_none()
            if account is None:
                account = models.WavesUser(
                    user_id=login.sender_qq, bot_id="onebot", uid=login.uid
                )
            account.cookie, account.did = values["token"], values["did"]
            account.bat, account.platform = values["bat"], "ios"
            account.game_id, account.is_login, account.status = 3, True, ""
            account.bbs_sign_switch = "off"
            session.add(account)
            binding = (
                await session.execute(
                    select(models.WavesBind).where(
                        models.WavesBind.user_id == login.sender_qq,
                        models.WavesBind.bot_id == "onebot",
                    )
                )
            ).scalar_one_or_none()
            if binding is None:
                binding = models.WavesBind(user_id=login.sender_qq, bot_id="onebot")
            binding.uid = login.uid
            binding.group_id = (
                login.source_key.split(":", 1)[1]
                if login.source_key.startswith("group:")
                else ""
            )
            session.add(binding)
            await store.bind_in_transaction(
                session, login.sender_qq, login.uid, login.nickname, credential
            )
            validate()
            if not self.permitted(login.source_key):
                await session.rollback()
                raise InvalidInput("conversation paused during confirmation")
            await session.commit()

    async def unbind(self, sender, store):
        from gsuid_core.utils.database import base_models as database
        from sqlmodel import delete

        models = importlib.import_module(f"{PLUGIN}.utils.database.models")
        async with database.async_maker() as session:
            for model in (
                models.WavesUser,
                models.WavesBind,
                models.WavesStaminaRecord,
            ):
                await session.execute(
                    delete(model).where(
                        model.user_id == sender, model.bot_id == "onebot"
                    )
                )
            await store.unbind_in_transaction(session, sender)
            await session.commit()

    async def reminder(self, subscription, now):
        if not self.reminder_module:
            raise InvalidInput("RoverReminder is unavailable")
        models = importlib.import_module(f"{REMINDER}.utils.database.models")
        uid = await models.WavesBind.get_uid_by_game(subscription["senderQQ"], "onebot")
        if not uid:
            raise InvalidInput("own binding missing")
        records = await models.WavesStaminaRecord.select_data_list(
            user_id=subscription["senderQQ"], bot_id="onebot"
        )
        record = next((record for record in records if record.uid == uid), None)
        if record:
            estimate = self.reminder_module._calc_current_stamina(record, int(now))
            if estimate is not None and estimate < subscription["threshold"]:
                return None
        event = self.event(
            "ww体力", subscription["senderQQ"], subscription["key"], "opt-in-reminder"
        )
        data = await self.reminder_module.process_uid(uid, event)
        if not data:
            raise InvalidInput("RoverReminder query failed")
        energy = data["daily_info"].energyData
        if not energy or energy.cur < subscription["threshold"]:
            return None
        status = importlib.import_module(f"{REMINDER}.utils.status_store")
        status.record_success()
        return f"鸣潮体力提醒：结晶波片 {energy.cur}/240，已达到提醒阈值 {subscription['threshold']}。"

    async def close(self):
        from gsuid_core.utils.database import base_models as database

        if database.engine and not isinstance(database.engine, str):
            await database.engine.dispose()


class CapturedLogger:
    async def info(self, *_args, **_kwargs):
        pass

    async def debug(self, *_args, **_kwargs):
        pass

    async def warning(self, *_args, **_kwargs):
        pass

    async def error(self, *_args, **_kwargs):
        pass

    async def success(self, *_args, **_kwargs):
        pass


class CapturedBot:
    """Output collector passed to genuine plugin functions; no QQ transport."""

    def __init__(self, sink, event):
        self.sink, self.ev = sink, event
        self.bot_id, self.bot_self_id = event.bot_id, event.bot_self_id
        self.uid, self.temp_gid, self.bid = (
            event.user_id,
            event.group_id or event.user_id,
            event.bot_id,
        )
        self.session_id = f"{self.bid}%%%{self.temp_gid}%%%{self.uid}"
        self.logger = CapturedLogger()

    async def send(self, message=None, *args, **kwargs):
        from gsuid_core.models import Message

        def safe_text(value):
            value = str(value)
            context = _REQUEST.get()
            if context is not None:
                for service in ("rank", "score"):
                    secret = context.runtime.authorization.token(service)
                    if secret:
                        value = value.replace(secret, "[credential redacted]")
            return value

        if isinstance(message, (list, tuple)):
            for item in message:
                await self.send(item)
        elif isinstance(message, Message):
            if message.type in ("text", "markdown"):
                self.sink.text(safe_text(message.data))
            elif message.type == "node":
                await self.send(message.data)
            elif message.type == "image":
                value = message.data
                if isinstance(value, bytes):
                    await self.send(value)
                elif isinstance(value, str) and value.startswith("base64://"):
                    if len(value) > 9 + ((20 * 1024 * 1024 + 2) // 3) * 4:
                        raise InvalidInput("plugin image too large")
                    await self.send(base64.b64decode(value[9:], validate=True))
                elif isinstance(value, str) and value.startswith("file://"):
                    path = Path(value[7:]).resolve(strict=True)
                    context = _REQUEST.get()
                    image_root = context.runtime.root if context is not None else runtime_root()
                    path.relative_to(image_root.resolve())
                    self.sink.image(path)
                elif isinstance(value, str) and value.startswith("link://https://"):
                    from urllib.parse import urlsplit

                    url = value[7:]
                    parsed = urlsplit(url)
                    if (
                        parsed.username
                        or parsed.password
                        or parsed.port not in (None, 443)
                    ):
                        raise InvalidInput("invalid plugin image URL")
                    async with httpx.AsyncClient(
                        timeout=20, follow_redirects=False, trust_env=False
                    ) as client:
                        async with client.stream("GET", url) as response:
                            response.raise_for_status()
                            data = bytearray()
                            async for chunk in response.aiter_bytes():
                                data.extend(chunk)
                                if len(data) > 20 * 1024 * 1024:
                                    raise InvalidInput("plugin image too large")
                    await self.send(bytes(data))
                else:
                    raise InvalidInput("plugin emitted unsupported remote image")
        elif isinstance(message, str) and message.startswith(
            ("base64://", "file://", "link://https://")
        ):
            # Native Bot.send also accepts bare encoded image strings, including
            # the list returned by community guide handlers.
            await self.send(Message(type="image", data=message))
        elif isinstance(message, bytes):
            mime = (
                "image/png"
                if message.startswith(b"\x89PNG")
                else "image/jpeg"
                if message.startswith(b"\xff\xd8")
                else "image/webp"
            )
            self.sink.image(message, mime)
        elif isinstance(message, Path):
            self.sink.image(message)
        elif hasattr(message, "save"):
            self.sink.image(message)
        elif message is not None:
            self.sink.text(safe_text(message))

    async def send_option(self, reply=None, *args, **kwargs):
        await self.send(reply)

    async def target_send(self, message, *args, **kwargs):
        raise InvalidInput("native output routing is forbidden")

    async def receive_resp(self, *args, **kwargs):
        raise InvalidInput(
            "native interactive commands require an adapter consent endpoint"
        )

    async def get_lang(self):
        return "zh-cn"

    async def t(self, key, **params):
        from gsuid_core.i18n import t

        return t(key, lang="zh-cn", **params)
