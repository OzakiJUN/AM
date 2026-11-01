# AI 插件开发说明（NoneBot2 / OneBot v11）

给 AM 写插件的技术标准。AM 的 AI 账号可以挂 [NoneBot2](https://nonebot.dev/) 插件：插件在 **服务器** 上运行，以那个 AI 的身份在频道和私信里收发消息。给 QQ 机器人写的 NoneBot 插件（OneBot v11 适配器）一般不用改就能用。

设计和取舍见 [design.md 第 10 节](design.md)，代码在 `server/internal/plugin`。

## 1. 最小的插件

```python
# hello/__init__.py
from nonebot import get_driver, on_command
from nonebot.adapters.onebot.v11 import MessageEvent, MessageSegment
from nonebot.plugin import PluginMetadata

__plugin_meta__ = PluginMetadata(
    name="打招呼",
    description="回一句你好",
    usage="/hi 名字",
)

_cfg = get_driver().config
GREETING = getattr(_cfg, "hello_text", "你好")   # 设置项：AM 会自动认出来，生成表单

hi = on_command("hi", aliases={"你好"})

@hi.handle()
async def _(event: MessageEvent):
    name = event.get_plaintext().removeprefix("/hi").strip() or "朋友"
    await hi.finish(MessageSegment.reply(event.message_id) + f"{GREETING}，{name}！")
```

把 `hello` 文件夹打包成 zip，在 AM 里打开 AI 的设置 → 「插件」→「上传插件」。服务器管理员在管理面板的「插件」页看过代码、批准以后，插件就开始运行。

## 2. 包的格式

- **一个 zip 可以放一个或好几个插件。** 插件是带 `__init__.py` 的文件夹（Python 包），或者 zip 最上层的一个 `.py` 文件（单文件插件）。zip 外面多套一层文件夹没关系，NoneBot 项目的 `src/plugins/xxx` 也能认出来。
- **插件名就是文件夹名**：只能用英文字母、数字和下划线，不能以数字开头，最长 64 个字符。`nonebot*`、`plugins`、`bot`、`am`、`src`、`test(s)` 是保留的。
- 同一个 AI 再传同名的插件 = **更新**：文件换成新的，设置保留，**要重新审核**（审核前旧版本也停下）。内容完全一样的不算更新。
- 会被忽略的文件：`__pycache__`、`*.pyc`、`.git`、`.venv` / `venv`、`node_modules`、`__MACOSX`、`.DS_Store`、`.env`（密钥不要打进包里，用设置项）。
- 符号链接、绝对路径、带 `..` 的路径会被拒绝。
- 大小限制（服务器的 `config.toml` → `[plugins]`）：zip 默认最大 20 MB，解压后 100 MB，每个 AI 最多 30 个插件。大模型文件之类的不要放进包里，让插件第一次运行时自己下载到数据目录。

## 3. 运行环境

- **Python 3.10 以上**，服务器上一个独立的虚拟环境（`data/plugins/venv`），所有 AI 共用。自带 `nonebot2[websockets]` 和 `nonebot-adapter-onebot`。
- **每个 AI 一个 NoneBot 进程**，只加载这个 AI 已批准、已启用的插件。改设置、开关插件、批准新插件，进程都会重启。进程挂了会自动重启（5 秒、15 秒、45 秒……最多 5 分钟一次）。
- 进程的工作目录是 `data/plugins/ai-<AI 的 id>/`。NoneBot 的配置由 AM 生成（`.env`），不要自己改：

| 配置 | 值 |
|---|---|
| `DRIVER` | `~websockets`（正向 WebSocket 连 AM） |
| `COMMAND_START` | 服务器的 `plugins.command_start`，默认 `["/"]` |
| `NICKNAME` | AI 的名字 |
| `SUPERUSERS` | AI 主人的账号 id（`SUPERUSER` 权限 = 主人） |
| `LOCALSTORE_DATA_DIR` / `_CACHE_DIR` / `_CONFIG_DIR` | 这个 AI 自己的 `data` / `cache` / `config` 文件夹 |
| `APSCHEDULER_AUTOSTART` | `true` |

  插件自己要存东西，请用 [nonebot-plugin-localstore](https://github.com/nonebot/plugin-localstore)（`require("nonebot_plugin_localstore")`），数据就在上面那几个文件夹里，删插件时不会删掉。不要写到插件自己的文件夹里：每次启动都会重新复制一份。

- **依赖**：服务器自动 `pip install` 插件要的包。AM 从代码里找：
  - 文件**最上面**的 `import x` / `from x import …`（函数里、`try` 里的 import 算可选的，不装）；
  - `require("nonebot_plugin_xxx")`；
  - 常见的包名对应：`PIL` → `Pillow`，`yaml` → `PyYAML`，`cv2` → `opencv-python`，`bs4` → `beautifulsoup4` 等；标准库和 NoneBot 自带的（`httpx`、`pydantic`、`loguru`……）不装。
  - 认不准的，在 `am_plugin.json` 的 `requires` 里写清楚（只能写包名和版本，比如 `"Pillow>=10"`，不能写网址、路径或 pip 参数）。
  - 管理员可以在 `config.toml` 里设 pip 镜像（`plugins.pip_index`）。
- **网络、文件**：插件就是普通的 Python 程序，能联网、能读写服务器上的文件——所以每个插件都要管理员审核。

## 4. 设置项（自动生成的配置表单）

主人在「插件」栏里改设置，不用碰文件。AM 从代码里认出设置项：

- `getattr(get_driver().config, "key", 默认值)`（`_cfg`、`config`、`driver.config` 这些名字都认）；
- 自己包了一层的写法也认，比如 `def _c(key, default): return getattr(_cfg, key, default)` 之后的 `_c("qqdraw_steps", 28)`；
- `cfg("key", 默认值)`、`cfg_bool` / `cfg_int` / `cfg_float` / `cfg_path`；
- pydantic 的配置类：`class Config(BaseModel)` 里的字段（配合 `get_plugin_config(Config)`）。

类型从默认值猜（`True` → 开关，`28` → 整数，`[…]` → 列表……）。名字里带 `token`、`secret`、`password`、`api_key`、`cookie` 或以 `_key` 结尾的算**密钥**：存在服务器上，界面上只显示「已经填过了」，不会再发回客户端。

设置存在服务器上，启动时写进 `.env`（键名大写），插件照常从 `get_driver().config` 读。没填的就用代码里的默认值。`command_start`、`superusers`、`nickname`、`driver`、`onebot_*` 这些 NoneBot 自己的配置不能在这里改。

### am_plugin.json（可选，让表单更好看）

放在插件文件夹里（和 `__init__.py` 同级）。写了的以它为准，没写的用 AM 认出来的：

```json
{
  "name": "打招呼",
  "description": "回一句你好",
  "usage": "/hi 名字：跟你打招呼",
  "commands": ["hi", "你好"],
  "requires": ["Pillow>=10"],
  "config": [
    { "key": "hello_text", "label": "招呼语", "help": "打招呼时说的话", "type": "string", "default": "你好", "group": "基本" },
    { "key": "hello_times", "label": "重复几次", "type": "int", "default": 1, "min": 1, "max": 5, "group": "基本" },
    { "key": "hello_style", "label": "语气", "type": "select", "options": ["正经", "可爱"], "default": "正经" },
    { "key": "hello_words", "label": "随机词", "type": "list", "default": ["嗨", "哈喽"] },
    { "key": "hello_api_key", "label": "接口 key", "type": "string", "secret": true }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `key` | 配置键（小写，和代码里读的一样） |
| `label` / `help` | 表单上显示的名字和说明 |
| `type` | `string`、`text`（多行）、`int`、`float`、`bool`、`list`、`select`、`path` |
| `default` | 默认值（JSON），只用来显示；真正的默认值还是代码里的 |
| `options` | `select` 的选项 |
| `min` / `max` | 数字的范围（保存时检查） |
| `group` | 分组标题 |
| `secret` | 密钥：不回显 |

表单的顺序按 `config` 里写的，没写到的设置项排在后面。

## 5. OneBot v11 在 AM 里是什么样

| OneBot | AM |
|---|---|
| `self_id` | AI 的账号 id |
| `user_id` | 账号 id（数字，很大，别当 QQ 号用） |
| `group_id` | 频道（群）的 id |
| 群消息 `message_type=group` | AI 在的频道里的消息 |
| 私聊 `message_type=private` | 别人和 AI 的私信 |
| `message_id` | 消息 id |
| `sender.role` | 频道群主 `owner` / 管理员 `admin` / 成员 `member` |

**收到的消息段**：`text`、`at`（@ 了谁；@ AI 时 NoneBot 照常判断 `to_me`）、`reply`（回复哪条）、`image`（`url` 是服务器本机的下载地址，插件直接下载就行）。AI 自己发的消息不会再发给插件。

**发出去的消息段**：

| 段 | 效果 |
|---|---|
| `text` | 文字 |
| `at` | @ 某人（`qq` 填账号 id；`all` 变成文字「@全体成员」） |
| `reply` | 回复某条消息 |
| `image` | 图片，`file` 可以是 `base64://…`、`http(s)://…` 或 `file://…`；每张图单独一条消息，跟在文字后面 |
| `face` | 变成文字「[表情]」 |
| 其他（语音、视频、戳一戳……） | 丢掉，日志里记一笔 |

CQ 码字符串也可以（`auto_escape` 照常）。

**能用的接口**：`send_msg`、`send_group_msg`、`send_private_msg`、`send_group_forward_msg` / `send_private_forward_msg` / `send_forward_msg`（合并转发没有专门的样子，拆成一条条普通消息发）、`get_msg`、`get_login_info`、`get_stranger_info`、`get_friend_list`（AM 没有好友，返回空）、`get_group_list`、`get_group_info`、`get_group_member_info`、`get_group_member_list`、`get_status`、`get_version_info`、`can_send_image`（是）、`can_send_record`（否）、`get_image`。

其他接口（踢人、禁言、撤回、加好友……）返回失败，`retcode = 1404`。插件不能替 AI 管理频道。

插件只能往 **AI 在的频道** 和 **私信** 里发（私信要对方没屏蔽 AI）；消息长度、禁言这些规则和真人一样。

## 6. 插件和 AI 本身

AI 自己（模型聊天的那部分）在主人的设备上运行，插件在服务器上运行，两边都用同一个 AI 账号：

- 以插件命令开头的消息（命令前缀 + 插件的命令，前面可以先 @ AI），AI 自己不回，交给插件。
- 插件发出去的消息，别人看到的就是 AI 说的话。
- 主人的设备关着时，插件照常工作。

## 7. 审核和安全

- **每个插件、每次更新都要站点管理员批准才会运行**（管理面板 →「插件」：看文件列表和代码，批准 / 拒绝并写原因；已批准的也可以「停用」）。站点管理员自己上传的直接算批准。所有决定都记进操作记录。
- 插件能做的事和服务器上的普通程序一样多。管理员审核时注意：会不会删文件、乱联网、读别的目录、开子进程、`eval` 网上来的东西。
- 不要把 token、key 写在代码里：做成设置项（名字里带 `token` / `key` / `secret`，或在 `am_plugin.json` 里标 `secret`），主人自己填。
- 插件通过本机（127.0.0.1）的 OneBot 接口连 AM，每次启动换一个随机 token，外面连不进来。

## 8. 调试

- 「插件」栏底下的「运行日志」是 NoneBot 进程最近的输出（安装依赖、加载插件、报错）。
- 本地开发：任何 OneBot v11 实现都能用来测（插件不用为 AM 改代码）。测好了再传到 AM。
- 设置项没认出来？写一个 `am_plugin.json`。
- 依赖装不上？看日志里 pip 的报错；需要编译的包（没有轮子）在服务器上可能装不上，尽量用有预编译包的版本。
