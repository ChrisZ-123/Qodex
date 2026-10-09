"""Native GsCore plugin invocations, without core HTTP, AI or schedulers."""

from __future__ import annotations

import base64
import importlib
import inspect
import json
import logging
import re
import sys
from copy import deepcopy
from pathlib import Path

import httpx

from .paths import runtime_root
from .security import InvalidInput, check_scope, sanitize_text

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
        self.root = root if root is not None else runtime_root()
        self.ready = False
        self.login_ready = False
        self.loaded = set()
        self.errors = {}
        self.sign_module = self.reminder_module = None
        self.triggers = []
        self.permitted = lambda key: True
        self.sign_time = (8, 0)
        self.score_help = False

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
            importlib.import_module(f"{SCORE}.scoreecho_help")
            self.score_help = True
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
        self.triggers.sort(key=lambda item: item[0])
        self.api = importlib.import_module(f"{PLUGIN}.utils.waves_api").waves_api
        self.login_ready = True
        self.ready = "help" in self.loaded
        # Upstream error diagnostics can include credential-bearing API objects.
        # RPC task states retain safe error types; raw native diagnostics stay off.
        logging.getLogger("GsCore").disabled = True
        # Registered upstream cron jobs remain inert: start_scheduler is never called.

    def status(self):
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
                    "status": "pending",
                    "reason": "尚未配置上游排行授权 token，上传已停用",
                },
                {
                    "id": "scoreecho",
                    "label": "声骸截图评分与分析",
                    "status": "pending",
                    "reason": "ScoreEcho 已安装；尚未配置上游 xwtoken，截图上传和评分接口已停用"
                    if self.score_help
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
            "commands": self.command_catalog() if self.ready else [],
            "error": None if self.ready else "鸣潮原生插件初始化未完成",
        }

    def command_catalog(self):
        from .catalog import DESCRIPTIONS, EXAMPLES

        catalog = {}
        for _priority, trigger in self.triggers:
            name = trigger.func.__name__
            examples = (
                EXAMPLES.get(name, [])
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
                    "description": DESCRIPTIONS.get(category, name),
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

    async def run(self, record, sink):
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
        for trigger in self.matching(record.command, event):
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
            bot.ev = handler_event
            # @SV wraps handler exceptions. Unwrap to preserve true completion.
            function = inspect.unwrap(trigger.func)
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
        async with httpx.AsyncClient(
            timeout=20, follow_redirects=False, trust_env=False
        ) as client:
            response = await client.post(
                "https://api.kurobbs.com" + path, data=data, headers=headers
            )
            response.raise_for_status()
            result = response.json()
        if not isinstance(result, dict) or result.get("code") not in (0, 200):
            raise InvalidInput("official Kuro request rejected")
        return result.get("data"), did

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
            raise InvalidInput("official login returned no account")
        token = login["token"]
        roles, _did = await self._official(
            "/gamer/role/list", {"gameId": 3}, token, did
        )
        if not isinstance(roles, list):
            raise InvalidInput("official login returned no roles")
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
            raise InvalidInput("Chinese Waves role required")
        credentials = {
            "token": token,
            "did": did,
            "serverId": role.get("serverId", "76402e5b20be2c39f095a152090afddc"),
        }
        return (
            str(role["roleId"]),
            sanitize_text(role.get("roleName", "鸣潮玩家"))[:100],
            json.dumps(credentials),
        )

    async def bind_account(self, login, credential, store, validate):
        from gsuid_core.utils.database import base_models as database
        from sqlmodel import select

        models = importlib.import_module(f"{PLUGIN}.utils.database.models")
        values = json.loads(credential)
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

        if isinstance(message, (list, tuple)):
            for item in message:
                await self.send(item)
        elif isinstance(message, Message):
            if message.type in ("text", "markdown"):
                self.sink.text(message.data)
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
                    path.relative_to(Path(__file__).resolve().parents[1])
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
            self.sink.text(message)

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
