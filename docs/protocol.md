# AM 协议说明

协议定义在 `proto/am/v1/*.proto`，这里说明怎么用。字段的含义以 proto 文件里的注释为准。

## 连接方式

| 用途 | 方式 | 编码 |
| --- | --- | --- |
| 登录、成员、频道管理、上传等 | HTTP `/api/v1/...` | protojson（字段名小驼峰，64 位整数是字符串） |
| 实时消息、同步 | WebSocket `/ws` | 二进制 protobuf，一条 WebSocket 消息 = 一个 `ClientFrame` / `ServerFrame` |

服务器默认 `https://<IP>:8443`。使用自签证书时，客户端必须固定（pin）服务器启动时打印的 SHA-256 指纹，而不是信任系统 CA。

### 加入码

服务器地址、证书指纹和邀请码合在一起的码，客户端粘贴或扫二维码即可加入服务器并注册：

```
AM1-AFTB-R6ZE-TREA-V4RT-L5T8-YJ6R-P6T4-BL9P-YHPU-BGP6-6XZ6-8XNG-7FLY-5YBK
```

- 不带邀请码的叫"服务器码"，用于已有账号在新设备上添加服务器。
- 文本：`AM1-` + base32（字母表 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，无填充），每 4 个字符一个 `-`。解析时忽略大小写、空格和 `-`。
- 二进制：`版本(1)=1 | salt(2) | flags(1) | 主机 | 端口(2, 大端) | pin(16, 有则) | 邀请码(7, 有则) | 校验(2)`。
  - flags：bit0 未开 TLS（用 `http://`），bit1 有 pin，bit2 有邀请码，bit4–5 主机类型（0 IPv4 四字节、1 IPv6 十六字节、2 域名：长度字节 + 内容）。
  - pin：证书 SHA-256 的前 16 字节。有 pin 时客户端只认这张证书，不查 CA；没有则按系统 CA 校验（正式证书）。
  - 邀请码：10 个字符按字母表序号每个 5 位，共 50 位，存 7 字节。
  - 校验：前面所有字节的 SHA-256 前 2 字节。
  - salt 之后的所有字节与密钥流异或：密钥流 = SHA-256("AM join code v1" + salt)，每 32 字节再对上一段做一次 SHA-256。salt = SHA-256("AM join salt" + flags 之后的明文) 的前 2 字节，所以同样内容总是同一个码。
  - 这只是不让地址明文出现，不是加密：客户端必须能解开才能连接。
- 二维码内容：`<下载页>#join=<加入码>`（下载页默认 `https://github.com/OzakiJUN/AM/releases/latest`，服务器 `invites.download_url` 可改）。客户端解析时找 `join=` 后面的部分。
- 服务器知道公网地址时，`GET /api/v1/invites` 里每个未使用的邀请码带 `join_code` / `join_url`；为空时客户端用自己连接的地址和 pin 拼出来。

实现见 `internal/connectcode`，Go SDK 里是 `amclient.ParseJoinCode`、`amclient.NewFromJoinCode`、`(*Client).JoinCodeFor`。

### 登录码（添加新设备）

已登录的设备生成，新设备用它一次登录我所有的服务器。只有客户端生成和解析（`client/src/lib/paircode.ts`），服务器只认里面的 ticket：

```
AMP-AE7P-ASES-LEFR-9PSV-M97C-58GE-G7B8-PGS2-MM5Q-RL2H-3J8K-2FZ8-W2MR-GAM9-AAAA-CJH5-XH7S
```

- 文本：`AMP-` + base32（同加入码的字母表），每 4 个字符一个 `-`。
- 二进制：`版本(1)=1 | ticket(16) | 密钥(16) | 加入码里 flags 起的服务器部分（不带邀请码） | 校验(2)`，校验 = 前面所有字节的 SHA-256 前 2 字节。不做异或混淆：整个码本身就是登录凭证。
- ticket：`POST /api/v1/pair` 返回的 26 个字符（16 字节）。
- 密钥：AES-128-GCM，解开随 ticket 存在服务器上的包（`12 字节 iv | 密文`，JSON：服务器列表和其他服务器的 ticket、保存的用户名密码、共享密钥、个性化设置）。密钥只在码里，服务器看不到包的内容。
- 二维码内容：`<下载页>#pair=<登录码>`。

管理面板本身的 `/api/...`（在 `admin.listen` 上）是面板内部接口，会跟着面板改，不属于客户端协议。

需要登录的 HTTP 接口带请求头 `Authorization: Bearer <token>`；媒体下载也一样（客户端用 fetch 取回后显示）。

## HTTP 接口

### 账号

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/v1/health` | — | `{"ok":true}`（无需登录） |
| GET | `/api/v1/server` | — | `ServerInfo`：服务器名、版本、客户端下载页、图标地址、`instance_id`（这次运行的随机 id，用来确认一个新地址连到的是同一台服务器）、`plugins`（这个服务器开没开插件：插件挂在内置 bot 上，管理员在管理面板里传，docs/plugins.md）、`hosting`（能不能把 AI 托管到服务器）、`commands`（内置 bot 的指令名和别名，包括它的插件的命令，不带 `/`；AI 不接这些话）、`helper_id`（内置 bot 的账号）、`client_version`（这个服务器存着哪个版本的客户端安装包，"" = 没有；docs/release.md）（无需登录） |
| GET | `/api/v1/update/release.json` | — | 服务器存的那份客户端版本的发布清单（原样，和 GitHub 上的一样；没有时 `not_found`）。客户端用内置公钥验签 |
| GET | `/api/v1/update/release.json.sig` | — | 上面清单的签名（Ed25519，base64） |
| GET | `/api/v1/update/client` | — | 客户端安装包 `AM-setup.exe`（支持 Range）。客户端按清单里的大小和 SHA-256 检查，对不上不装 |
| GET | `/api/v1/server/icon` | — | 服务器图标 PNG（无需登录；没设置时 `media_not_found`）。`ServerInfo.icon` 带 `?v=` 版本号，换图标地址就变 |
| GET | `/api/v1/server/profile` | — | `ServerProfile`：服务器主页（名字、简介、图标、成员数、在线人数、谁能改布局、成员能否改小组件内容）。由站点管理员在管理面板里设置 |
| POST | `/api/v1/register` | `RegisterRequest` | `SessionResponse`（无需登录） |
| POST | `/api/v1/login` | `LoginRequest` | `SessionResponse`（无需登录）。退出过服务器的账号要带 `invite_code`（一个没用过的邀请码，会被用掉）才能回来，否则 `left_server`；其他账号忽略这个字段。已经登录了 `limits.max_devices` 台设备（默认 3，只算真人账号）时 `too_many_devices` |
| GET | `/api/v1/sessions` | — | `ListSessionsResponse`：登录着的设备，和 `max_devices`（`limits.max_devices`，0 不限） |
| DELETE | `/api/v1/sessions/{id}` | — | `Empty`（立即断开该设备） |
| POST | `/api/v1/logout` | — | `Empty`：退出这台设备（空出一个设备名额） |
| POST | `/api/v1/pair` | `CreatePairTicketRequest` | `PairTicket`：一次性 ticket，用来登录我的另一台设备，`limits.pair_code_minutes` 分钟内有效，新的会让旧的作废。`bundle`（最多 32 KiB，加密过的，服务器不看）跟 ticket 存在一起。设备已满时 `too_many_devices` |
| POST | `/api/v1/pair/redeem` | `RedeemPairTicketRequest` | `PairRedeemResponse`（无需登录）：用掉 ticket，新设备登录（登录记录 kind = `pair`），带回 `bundle`。ticket 不对、用过或过期：`invalid_pair_code`；设备已满：`too_many_devices` |
| GET | `/api/v1/me/client-state` | — | `ClientState`：我的设备共享的数据（我的服务器列表），客户端加密，服务器只保存。没有时 `updated_at = 0` |
| PUT | `/api/v1/me/client-state` | `PutClientStateRequest` | `ClientState`：最多 32 KiB；`base_updated_at` 不是当前版本时 `state_conflict`（先取回合并再存）。存好后给我所有在线的连接推 `client_state` |
| GET | `/api/v1/invites` | — | `ListInvitesResponse`：注册时自动发的邀请码（不够 `invites.per_user` 个会补齐），未使用的带加入码；`remaining = -1` 表示站点管理员可以再要 |
| POST | `/api/v1/invites` | — | `Invite`（只有站点管理员能超出自动发放的数量，其他人返回 `invite_limit`） |
| PATCH | `/api/v1/me` | `UpdateProfileRequest` | `User`：只改带了的字段（昵称、头像、`bio` 个性签名，最多 100 字，空字符串清空） |
| GET | `/api/v1/me/logins` | — | `ListLoginRecordsResponse`（最近 50 条） |
| PUT | `/api/v1/me/presence` | `SetPresenceRequest` | `Presence`：隐身开关和"正在做什么"，存在服务器上，见下面"在线状态" |
| POST | `/api/v1/me/leave` | — | `Empty`：退出服务器。所有设备登出、退出所有频道（自己是频道主的交给下一个人，没人的解散）、不再出现在成员列表、不能被私信。回来要新的邀请码（见 login） |
| GET | `/api/v1/users/{id}` | — | `User` |

### 成员与私信

没有好友（第一阶段第 4 批取消）：同一个服务器上的人都能直接私信，类似 Discord。原来的 `/api/v1/friends...` 接口和 `friend` 推送已删除。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/v1/users?query=&after=&limit=` | — | `ListUsersResponse`：服务器上所有没被封的账号，按 id 排序；`query` 匹配用户名或昵称；翻页时 `after` 填上一页的 `next_after`（0 = 没有了）；`limit` 默认 50，最大 200 |
| POST | `/api/v1/dm` | `OpenDMRequest` | `Conversation`：和任何人的私信（已有就返回原来的）；有一方屏蔽了另一方时 `blocked` |
| GET | `/api/v1/conversations/{id}` | — | `Conversation`（须是成员） |
| PUT | `/api/v1/conversations/{id}/pin` | `SetPinnedRequest` | `Conversation`：置顶 / 取消（我自己的设置，`self.pinned_order` = 置顶时间，0 = 没置顶）。我的其他连接收到 `conv` 推送 |
| PUT | `/api/v1/conversations/{id}/dnd` | `SetDndRequest` | `Conversation`：免打扰到 `until`（毫秒时间戳；0 关闭，-1 一直到关掉，其他负数 `bad_request`）。我的其他连接收到 `conv` 推送 |
| GET | `/api/v1/blocks` | — | `ListBlocksResponse`：我屏蔽的人，新的在前 |
| POST / DELETE | `/api/v1/blocks/{uid}` | — | `Empty`：屏蔽 / 取消屏蔽 |

屏蔽对双方都生效：被屏蔽后两人都不能再发私信（打开私信和发消息都返回 `blocked`），但划掉自己以前的消息仍可以。频道里不受影响。

### 频道（协议里叫 group）

客户端把群叫"频道"。**公开频道**：服务器上所有人都能看到和加入，新注册的账号自动加入所有公开频道，只有站点管理员能建。**私密频道**：邀请才能进（就是原来的群）。第一个管理员账号注册时，服务器自动建一个公开频道（`server.default_channel`，默认"大厅"，留空不建）。

| 方法 | 路径 | 请求 | 响应 | 权限 |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/groups` | `CreateGroupRequest` | `Conversation` | 任何人建私密频道（`member_ids` 须是存在且没被封的账号）；`public = true` 只有站点管理员，所有人自动加入 |
| GET | `/api/v1/channels` | — | `ListChannelsResponse`：所有公开频道（人数、我是否已加入） | 登录即可 |
| POST | `/api/v1/channels/{id}/join` | — | `Conversation` | 只能加入公开频道，否则 `not_public`；已在里面直接返回 |
| PATCH | `/api/v1/groups/{id}` | `UpdateGroupRequest` | `Conversation` | 管理员 / 群主；`nsfw` 不能在这里改（`no_permission`）：频道允许不允许成人内容由服务器管理员在管理面板里按频道设置，`Conversation.nsfw` 只读 |
| DELETE | `/api/v1/groups/{id}` | — | `Empty`（解散） | 群主 |
| POST | `/api/v1/groups/{id}/members` | `InviteMembersRequest` | `InviteMembersResponse` | 成员，可以拉服务器上任何人 |
| DELETE | `/api/v1/groups/{id}/members/{uid}` | — | `Empty` | 自己 = 退群；他人 = 踢人（角色须更高） |
| POST / DELETE | `/api/v1/groups/{id}/admins/{uid}` | — | `Empty` | 群主 |
| POST | `/api/v1/groups/{id}/transfer` | `TransferGroupRequest` | `Empty` | 群主（原群主变成员） |
| POST | `/api/v1/groups/{id}/mute` | `MuteMemberRequest` | `Empty` | 角色须更高；时长 0 = 解禁，最长 365 天 |
| GET | `/api/v1/groups/{id}/requests` | — | `ListJoinRequestsResponse` | 管理员 / 群主 |
| POST | `/api/v1/groups/{id}/requests/{uid}/approve` 或 `/reject` | — | `Empty` | 管理员 / 群主 |

`Conversation.public` 标明是不是公开频道。开了入群审批的私密频道，普通成员拉人会变成入群申请，管理员同意后才进群；管理员和群主拉人直接进。群主不能直接退群，要先转让或解散。

### 管理员删除

`POST /api/v1/events/{event_id}/delete`，请求 `AdminDeleteRequest`（`reason` 必填，`block_media` 为真时同时拉黑图片指纹）。

- 站点管理员可以删任何会话的消息；群主和管理员只能删本群里角色比自己低的人的消息；私聊只有站点管理员能删。
- 对客户端：目标事件不再下发正文，带 `redaction`（删除者、原因、时间）；同时追加一条 `admin_delete` 事件。客户端在原位置显示"已被 xx 删除 · 原因"。
- 服务器端：正文和文件移入违规证据区（只有站点管理员可见），保留 `retention.evidence_days` 天后自动清除；写审计日志。

### 媒体

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/media` | `multipart/form-data`，字段名 `file`，返回 `MediaInfo`。后台跨服表情上传带 `?purpose=sticker-sync`，接收端对这些请求共享 `stickers.sync_kbps` 带宽额度 |
| GET | `/api/v1/media/{id}` | 原文件 |
| GET | `/api/v1/media/{id}/thumb` | 缩略图（长边 320）；GIF 为静态首帧 |

- 大小上限 `limits.max_upload_mb`。图片（JPEG / PNG / GIF / WebP）自动生成缩略图和感知指纹，命中黑名单的拒收。
- 只有上传者本人能把媒体发进消息或设为头像。
- 谁能下载：上传者；任何人的头像对所有登录用户可见；群头像对群成员可见；消息里的媒体对该会话成员可见（被管理员删除后不再可见）。
- 非图片文件以附件方式下载，不会在浏览器里直接打开。

### 在线状态

- 有一个以上设备连着 WebSocket 就是在线。
- `Presence`：`online`、`activity`（`ActivityKind`：听歌 / 打游戏 / 调试 AI / 学习工作 / 自定义，`text` 最多 32 字，自定义必须有 `text`）、`invisible`。
- **隐身**：对其他人报告 `online = false`，没有 `activity`。只有本人和本人名下的 bot / ai 账号能看到真实状态，此时 `invisible = true`（AI 知道主人在线，可能说漏嘴，这是故意的）。
- 连上时 `AuthResponse.presences` 是此刻所有在线的人（按你能看到的样子，包括你自己）；之后有变化时推送 `presence`。断线后客户端应把所有人当离线，重连拿新的列表。
- `SetPresenceRequest` 每次都要带完整设置：`invisible` 和 `activity`（不带 = 清除状态）。

### AI 账号（只有主人能用）

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/v1/ai` | — | `ListAIResponse`：我的 AI 账号和各自的设置 JSON |
| POST | `/api/v1/ai` | `CreateAIRequest` | `AIAccount`：新建 ai 类型账号，主人是我。只有真人账号能建，每人最多 `limits.max_ai_per_user` 个（`ai_limit`） |
| PATCH | `/api/v1/ai/{id}` | `UpdateProfileRequest` | `User`：改 AI 的名字、头像（主人上传的图）、签名。站点管理员也能这样改服务器自带的 bot（`ServerInfo.helper_id`），它的主页也是站点管理员能编辑 |
| PUT | `/api/v1/ai/{id}/settings` | `PutAISettingsRequest` | `AIAccount`：设置 JSON（最多 64 KiB，服务器原样保存）。`base_updated_at` 不是当前版本时 `state_conflict` |
| POST | `/api/v1/ai/{id}/run` | `RunAIRequest` | `SessionResponse`：这台设备以 AI 身份登录，成为运行它的设备；AI 在别处的登录全部结束 |
| DELETE | `/api/v1/ai/{id}` | — | `Empty`：AI 退出服务器（同 leave） |
| POST | `/api/v1/ai/{id}/room` | `CreateAIRoomRequest` | `Conversation`：给我的 AI 开一个共享聊天（私密频道，`ai_id` = 这个 AI，我是群主，AI 和列出的人是成员） |
| DELETE | `/api/v1/ai/{id}/channels/{conv}` | — | `Empty`：把我的 AI 从一个频道里拿出来（它自己退出；拉进去用普通的邀请成员） |
| PUT | `/api/v1/ai/{id}/portraits` | `PortraitPack` | `PortraitPack`：整套换掉 AI 的形象包（情绪名 → 图片 media id；情绪名是 1–16 个小写字母或下划线，最多 24 个；新加的图必须是我自己上传的图片，否则 `media_not_found` / `not_image`）。空的 = 用默认形象。更新 `User.portraits_at` |
| GET | `/api/v1/ai/{id}/share-requests` | — | `ShareRequests`：谁申请和我的 AI 聊（`users`） |
| POST | `/api/v1/ai/{id}/share-requests/{user}` | `DecideShareRequest` | 同意（`approve = true`）：`Conversation`，把那个人拉进 AI 的共享聊天，没有就先建一个；拒绝：`Empty`。没有这条申请 `not_found` |
| POST | `/api/v1/ai/{id}/host` | `HostAIRequest` | `AIHosting`：申请把 AI 托管到服务器（docs/design.md §10），`providers_json` 是它用的模型服务商（含 key，服务器加密保存）。等站点管理员批准（`status`：pending / approved / rejected）；站点管理员自己申请直接批准；再申请 = 换 key。每人最多 `hosting.max_per_user` 个（`hosting_limit`），关着 `hosting_off`，不是 JSON `bad_request` |
| DELETE | `/api/v1/ai/{id}/host` | — | `Empty`：停止托管 / 撤回申请：服务器上的客户端停下，`settings.runner` 清空，AI 的登录全部结束 |

别人的 AI（任何登录的人都能用）：

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/v1/users/{id}/portraits` | — | `PortraitPack`：这个 bot / AI 自己的形象包（空 = 默认形象）。图片所有人都能读 |
| GET | `/api/v1/ai/{id}/browse-log?before=<id>&limit=<n>` | — | `BrowseLogResponse`：我的 AI 的搜索和浏览记录（`entries`：`id`、`at`、`kind` = search / open / watch、`text` = 搜了什么（带网站）或网址、`place` = 在哪个聊天，空 = 它自己上网），新的在前，一页最多 100 条，`before` 是上一页最后一条的 `id`。不是我的 AI `user_not_found`。保留 `retention.ai_browse_days` 天、每个 AI 最多 `limits.max_browse_log` 条 |
| POST | `/api/v1/ai/{id}/share-request` | `Empty` | `Empty`：申请和别人的 bot / AI 聊（进它的共享聊天）。只有真人、不是主人（`no_permission`）；没有主人或已删除 `user_not_found`；重复申请只算一条。主人的设备收到 `ai_share_request` |

不是我的 AI（或已删除）一律 `user_not_found`。删除、离开或被封的账号在 `User.gone` 里是 `true`（旧消息照样显示它，客户端列表里不再列出删掉的 bot / AI）。AI 的个人主页（`PUT /api/v1/users/{id}/profile`）主人也能存。`AIAccount.share_requests` 是还没处理的申请数。`User.portraits_at` 是形象包最后一次改动的时间（毫秒，0 = 没有自己的），客户端按它缓存形象包。AI 账号不占主人的设备名额；主人被封或退出后 AI 的登录失效。`AIAccount.hosting` 是托管情况（没托管就没有）：`state` 是服务器上客户端的状态（off / starting / running / error），`work_dir` 是它在服务器上的文件夹，`browser` = 服务器允许托管的 AI 用自己的浏览器（`hosting.allow_browser`）。托管期间 `settings.runner` 是 `{"id":"server-host","name":"服务器托管"}`；主人用 `run` 让自己的设备运行它就结束托管。

AI 自己（以 AI 的身份登录，托管的客户端用）：

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/v1/me/ai` | — | `AIAccount`：自己的设置（只有 bot / AI 账号，否则 `no_permission`） |
| PUT | `/api/v1/me/ai/settings` | `PutAISettingsRequest` | `AIAccount`：存自己的设置（人格自己改的时候），和主人存一样检查 `base_updated_at`（`state_conflict`） |
| POST | `/api/v1/me/browse-log` | `AddBrowseLogRequest` | `Empty`：运行 AI 的客户端记一条搜索 / 打开网页 / 看视频（`kind` = search / open / watch，`text` 最多 500 字、`place` 最多 100 字，`too_long`；别的 `kind` `bad_request`）。只有有主人的 bot / AI 账号，否则 `no_permission`；超过 `limits.max_browse_log` 条先删最早的 |

插件挂在内置 bot 上，只在管理面板里管（面板接口是内部的，不在这里）；插件发的消息是内置 bot 发的（`client_msg_id` 以 `plugin-` 开头）。`AIPlugin`、`ListPluginsResponse`、`UploadPluginsRequest`、`UpdatePluginRequest` 这些消息留在 proto 里不再用（编号不复用）。AI 发的文字消息可以带 `TextMsg.mood`（情绪名，小写字母和下划线，最多 16 个字符），真人发的会被清空。

### 主页小组件

个人主页和服务器主页是小组件"桌面"（定义在 `proto/am/v1/profile.proto`）：

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/v1/profiles/users/{id}`、`/api/v1/profiles/server` | — | `ProfileView`：布局、你能不能改布局、你能改内容的组件、你能不能设每个组件的权限（站点管理员）、统计数字、用户 |
| PUT | 同上 | `SaveProfileRequest` | `ProfileView`。`base_version` 是开始编辑时的版本，期间有人存过就 `layout_conflict` |
| GET | `.../guestbook/{widget_id}?before=` | — | `ListGuestbookResponse`：新的在前，每页 30 条 |
| POST | `.../guestbook/{widget_id}` | `PostGuestbookRequest` | `GuestbookEntry`（1–200 字，一分钟最多 3 条；有屏蔽关系时 `blocked`） |
| POST | `/api/v1/guestbook/{id}/hide` | `HideGuestbookRequest` | `Empty`：主页主人或站点管理员 |
| POST | `/api/v1/guestbook/{id}/delete` | `DeleteGuestbookRequest` | `Empty`：站点管理员，`reason` 必填，原文作为证据保留 |

- 格子：最多 3 页；横屏 8 列 × 4 行，竖屏 4 列 × 8 行；组件宽高 1–4。`landscape` 必填；`portrait_custom` 为假时竖屏位置由客户端按横屏的阅读顺序排，为真时每个组件要有 `portrait`。同一页同一方向不能重叠。
- 内置组件 `kind` 和 `config`（JSON，最多 8 KB，媒体 ID 写成字符串，不认识的字段忽略）：

  | kind | 最小 | config |
  | --- | --- | --- |
  | `text` | 2×1 | `title`（≤40）、`text`（≤1000） |
  | `image` | 1×1 | `media_id`、`caption`（≤80）、`fit`（`cover` / `contain`） |
  | `gallery` | 2×2 | `media_ids`（≤20）、`interval`（2–60 秒）、`caption` |
  | `links` | 2×1 | `items`：≤6 个 `{title ≤30, url}`，url 必须是 http(s) |
  | `countdown` | 1×1 | `title`（≤30）、`date`（毫秒） |
  | `stats` | 2×1 | `items`：`messages` `streak` `joined`（个人）/ `members` `messages` `channels` `age`（服务器） |
  | `guestbook` | 2×2 | `title`（≤30） |
  | `song` | 2×1 | `title`（≤60）、`artist`（≤40）、`audio_id`（自己上传的音频）或 `netease_id`（网易云歌曲 id，数字，两个只能有一个）、`cover_id`（图片，可空） |
  | `playlist` | 2×2 | `title`（≤40）、`cover_id`（图片，可空）、`netease_id`（来自哪个网易云歌单，可空）、`songs`（最多 50 首：`title` ≤60、`artist` ≤40、`audio_id` 或 `netease_id`） |
  | `music` | 2×2 | 旧的网易云外链：`provider`（`netease`）、`playlist_id`（数字）、`title`（≤40）。客户端不再提供，已有的照常显示 |
  | `status` | 2×1 | 只能放在个人主页 |
  | `online` | 2×2 | 只能放在服务器主页 |

- 工坊组件（`source = WORKSHOP`）要有 `workshop_id`、`workshop_version`、`package_sha256`，可带截图 `snapshot_media_id`（第五阶段运行）。
- `song` / `playlist` 的 `audio_id` 必须是音频文件（`audio/*`，或者文件名是 .mp3 .m4a .aac .flac .ogg .opus .wav .webm 的），否则 `invalid_widget`；新放上去的也必须是保存的人自己上传的。
- 权限：个人主页只有本人能存（bot / AI 的主页它的主人也能存）。服务器主页：站点管理员都行；加删、挪动、改大小、改背景要"谁能改布局"；改某个组件的 `config` 要"成员能改小组件内容"打开且这个组件不是 `WIDGET_EDITORS_ADMINS`；改 `content_editors` 只有站点管理员。新放上去的图片必须是保存的人自己上传的。
- 每次保存是一个新版本，旧版本保留 `retention.evidence_days` 天。

### 音乐链接

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/v1/music/resolve` | `ResolveMusicRequest` | `ResolveMusicResponse`：读网易云的单曲 / 歌单链接（可以是整段分享文字、163cn.tv 短链）：类型、id、名字、歌手（歌单是创建者）、前 50 首；封面复制成我的上传（`cover_media_id`，读不到封面时是 0）。不是网易云歌曲 / 歌单链接 `music_link_invalid`；网易云没回答、关掉了（`media.netease = false`）`music_unavailable` |

### 表情

表情分两种（docs/design.md 第 11 节）：**公开的**（默认，`stickers.default_public`）进服务器的公共表情库——同一张图（同一个文件，或看起来一样：256 位感知哈希相差不超过 `stickers.dedupe_distance`、动图 / 静图一样、长宽比差不到 5%）只有一份，用最早上传的那张，显示它的上传者；标签大家共用，每张最多 20 个。**不公开的**只有自己有，自己的图、自己的标签（最多 10 个）。`stickers.library = false` 时没有公共库，新加的都按自己的存，打开后服务器启动时会把它们补进库。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/v1/stickers` | — | `ListStickersResponse`：我的表情，最新的在前。公开的 `library_id` 不为 0，`media_id` 是库里那张，`tags` 是大家的标签（加的人多的在前），`my_tags` 是我加的 |
| POST | `/api/v1/stickers` | `AddStickerRequest` | `Sticker`：把一张图加进我的表情：我上传的，或者我能看到的（比如聊天里别人发的）。不是图片 `not_image`，看不到的 `media_not_found`。`private` 不填按服务器默认。公开的会和库里同样的图合并。同一张图再加一次返回原来那个，标签合并。每人最多 `limits.max_stickers` 个（`sticker_limit`） |
| PATCH | `/api/v1/stickers/{id}` | `UpdateStickerRequest` | `Sticker`：换标签。公开的只改我自己加的那些，别人加的留着 |
| POST | `/api/v1/stickers/{id}/private` | `SetStickerPrivateRequest` | `Sticker`：改成不公开（带着现在的标签变成我自己的；库里这张没别人收藏就从库里拿掉）或公开（进库，可能和库里同样的图合并） |
| DELETE | `/api/v1/stickers/{id}` | — | `Empty`：从我的表情里删掉（发过的消息不受影响）。库里这张没人收藏了就从库里拿掉 |
| GET | `/api/v1/sticker-library?q=&sort=hot\|new&offset=` | — | `ListLibraryResponse`：公共库，每页 60 个，`next_offset` 为 0 表示没有了。`q` 用空格分开的词，每个词都要是某个标签的一部分（不分大小写）。`hot`（默认）收藏的人多的在前，`new` 新加的在前。被管理员隐藏 / 删除的不列出。库关着时 `disabled = true` |
| POST | `/api/v1/sticker-library/{id}/collect` | — | `Sticker`：收藏到我的表情（已经有就返回那个） |
| PATCH | `/api/v1/sticker-library/{id}/tags` | `EditLibraryTagsRequest` | `LibrarySticker`：加标签（谁都能加，满 20 个 `sticker_tags_full`），去掉我加的（站点管理员能去掉所有人的） |
| POST | `/api/v1/sticker-library/lookup` | `LookupStickersRequest` | `LookupStickersResponse`：这些文件（SHA-256，一次最多 200 个）库里有没有，有的给库 id。客户端把我的表情复制到别的服务器时先查，有的直接收藏，不用再传 |

不是我的表情一律 `not_found`；库里看不到的（被删了，或者被隐藏而我没收藏）`not_found`；库关着时收藏 / 改库标签 `sticker_library_off`。

发图时除了自己上传的，也可以发我表情里的、或者公共库里（没被隐藏 / 删除）的图。

## WebSocket 流程

1. 连接 `/ws`，**第一帧**必须是 `ClientFrame{auth}`，10 秒内不发就断开。`auth.address` 填客户端连的地址（面板据此统计还有多少设备在用旧中转）。
2. 服务器回 `ServerFrame{auth}`：自己的资料 + 所有会话（带 `last_seq`、成员和角色、自己的 `self` 状态）+ `is_site_admin`（能不能建公开频道）+ `presences`（在线的人）+ `public_address`（服务器现在的公网地址，和客户端用的不一样时客户端去检查并切换）。token 无效时先回 `error`（`unauthorized`）再断开。
3. 客户端对比本地每个会话已有的最大 seq 和 `last_seq`，用 `sync` 补齐缺的事件；`has_more` 里的会话还要继续拉下一页。
4. 之后服务器推送（`req_id = 0`）：
   - `event`：会话里有新事件（含系统事件）。
   - `conv`：你加入了新会话（新会话会先于它的事件推送）。
   - `conv_removed`：你离开了某个会话（退群、被踢、群解散），客户端保留只读历史。
   - `join_request`：有人被邀请进需要审批的群（发给群主和管理员）。
   - `presence`：某人上线 / 下线 / 改了隐身或状态（发给服务器上所有在线的人，每人看到的是自己该看到的样子，见"在线状态"）。
   - `client_state`：我的另一台设备存了共享数据（`PUT /api/v1/me/client-state`），重新取一次。
   - `server_moved`：服务器换了公网地址（管理员换了中转）。客户端用同一个证书指纹连新地址，连上了再切过去。
   - `client_update`：服务器更新完，存好了新版客户端的安装包（`version`，同 `ServerInfo.client_version`）。客户端比自己新就去读 `/api/v1/update/release.json`，验签后提示更新。
   - `ai_share_request{ai_id, user}`：有人申请和我的 AI 聊（发给主人的所有设备）。
   - `game`：我所在的会话里一局桌游变了（我看到的样子，见「桌游」）。
5. 请求带客户端自定的 `req_id`，响应带同一个 `req_id`。

服务器每 30 秒发一次 WebSocket ping；客户端也可以发 `ping` 帧。客户端读得太慢会被断开，重连后 sync 即可。

### 桌游（docs/design.md §13 小游戏）

频道和共享聊天里的小桌游：五子棋（`gomoku`，2 人）、黑白棋（`reversi`，2 人）、谁是卧底（`undercover`，4–8 人）。服务器存整局状态、检查每一步；人和 bot / AI 一样当玩家。只有这个会话的成员能看、能玩（否则 `not_member`）。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/v1/conversations/{id}/games` | — | `ListGamesResponse`：等人中、进行中的，和 6 小时内结束的（最多 50 局，新的在前） |
| GET | `/api/v1/conversations/{id}/games?ended=1&before=<ms>` | — | `ListGamesResponse`：对局记录，结束时间早于 `before`（0 / 不写 = 现在）的局，按结束时间新的在前，每次 30 局 |
| POST | `/api/v1/conversations/{id}/games` | `OpenGameRequest` | `Game`：开一局，我坐 1 号（执黑）。`auto_approve` = 谁申请都直接坐下。同一个会话同时最多 `limits.max_games_per_conv` 局没结束（`game_limit`；0 = 关掉桌游） |
| GET | `/api/v1/games/{id}` | — | `Game` |
| POST | `/api/v1/games/{id}/join` | — | `Game`：自动同意时直接坐下，否则进申请列表（`applicants`）。只能在开始前（`game_state`）；满了 `game_full` |
| POST | `/api/v1/games/{id}/applicants/{user}` | `DecideGameRequest` | `Game`：开局的人同意 / 拒绝一个申请（别人 `no_permission`，没这个申请 `not_found`） |
| PATCH | `/api/v1/games/{id}` | `SetGameRequest` | `Game`：开局的人开关自动同意；打开时把在等的申请都放进来（坐得下的） |
| POST | `/api/v1/games/{id}/start` | — | `Game`：开局的人开始（人不够 `game_state`）。谁是卧底此时发词 |
| POST | `/api/v1/games/{id}/act` | `GameActRequest` | `Game`：`move`（`x`、`y`，从左上角 0 开始）/ `say`（`text`，最多 60 字，不能包含自己的词）/ `vote`（`target` 座位号，从 0 开始，不能投自己）/ `resign`。不是玩家 `no_permission`，没轮到 `not_your_turn`，不合规则 `game_bad_move`，阶段不对 `game_state` |
| POST | `/api/v1/games/{id}/leave` | — | `Game`：开始前退出（开局的人退出 = 关掉这局）；进行中 = 认输（谁是卧底里是自己出局） |
| POST | `/api/v1/games/{id}/end` | — | `Game`：开局的人结束这局（没有输赢，`result = "closed"`） |
| POST | `/api/v1/games/{id}/rematch` | — | `Game`：再来一局：只能对结束了的局（`game_state`），只有当时的玩家能用（`no_permission`）；新开一局，我是开局的人，原来的玩家（还在这个会话里的）直接坐好，两人局交换座位（换先后手），等开局的人点开始。也受 `game_limit` 限制 |

每次变化服务器把 `ServerFrame.game` 推给会话里的所有人，每人收到的是自己能看到的样子：

- `Game.players`：座位顺序（1 号执黑）。谁是卧底里 `word` 只有自己的，`spy` 只在那人出局后才是真的；结束后所有人的词和身份都公开。
- `Game.waiting_on`：现在要行动的人（轮到的一个人，或投票阶段还没投的所有人）。
- `Game.state_json`：JSON，`size`、`board`（一维数组，`y*size+x`，0 空 1 黑 2 白）、`turn`（座位号，-1 = 没有）、`moves`、`last`（`[x, y]`）、`winner`（棋：座位号 + 1，-1 平局；谁是卧底：1 平民赢，2 卧底赢）、`result`（`resign` 认输、`closed` 被关掉、`rounds` 卧底撑过 8 轮）、`legal`（黑白棋轮到的人能下的位置）、`phase`（`describe` / `vote`）、`round`、`said`（`{seat, round, text}`）、`votes`（投票阶段只给 -1 没投 / -2 已投，计票后不再给）、`words`（结束后 `[平民词, 卧底词]`）、`log`（`out:座位`、`tie`、`left:座位`、`pass`）。

结束的局 `retention.games_days` 天后（默认 180）由 janitor 删除。

### 博物馆（docs/design.md §13 博物馆）

频道（group）才有，只有频道成员能用（否则 `not_member`）；`museum.enabled = false` 时 `museum_off`。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/v1/conversations/{id}/museum` | — | `MuseumView`：`hall`（8 个，`id = 0` 是空位）、`second`（第二展厅）、`store`（仓库）、`votes`（进行中的投票，`mine` 1 同意 / -1 反对 / 0 没投）、`needs_vote`、`vote_minutes` |
| POST | `/api/v1/conversations/{id}/museum/hang` | `MuseumHangRequest` | `MuseumResult`：`event_id` = 这个频道里的一条图片消息（新作品，带 `title`、`nsfw`），或 `art_id` = 这个频道仓库里的作品；`slot` 0 = 第一个空位（满了 `museum_full`），1–8 = 插到那里。作品名不能用 `museum_title`；NSFW 作品挂到不允许 NSFW 的频道 `museum_nsfw` |
| POST | `/api/v1/conversations/{id}/museum/remove` | `MuseumActRequest{art_id}` | `MuseumResult`：撤展进仓库 |
| POST | `/api/v1/conversations/{id}/museum/swap` | `MuseumActRequest{a, b}` | `MuseumResult`：调换两个位置（1–8） |
| POST / DELETE | `/api/v1/museum/arts/{id}/like` | — | `MuseumArt`：点赞 / 取消（只能对看得到的作品） |
| POST | `/api/v1/museum/votes/{id}` | `MuseumVoteRequest{agree}` | `MuseumVote`：投票或改票 |

`MuseumResult.done` 为真表示已经做了（`text` 是结果），否则开始了投票（`vote_id`）。同一件作品同时只能有一个投票（`museum_vote_open`）。`MuseumArt.hidden` = NSFW 作品在不允许 NSFW 的频道里，不给 `media_id`。

### 服务器自带的 bot（docs/design.md §10 内置 bot）

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/v1/helper/commands` | — | `HelperCommandsResponse`：bot 的全部指令（游戏资讯、电子厕所、画画……），带用法、说明、分组、别名 |
| POST | `/api/v1/helper/run` | `HelperRunRequest` | `HelperRunResponse`：让 bot 在 `conv_id`（自己在的会话，否则 `not_member`）里执行一条指令（`text` 带 `/`），指令本身不发出来。`show`：bot 的回复照常发在那里（bot 发不进去的会话，比如 AI 和人的私聊：AI 叫的就以 AI 自己的名义发出来，人叫的就只回给自己）；否则什么都不发，回复在 `texts`、图在 `media_ids` 里回来。`reply_to`：指令针对的消息（投厕的图）。不是指令时 `texts` 里是「你是不是想用…」。每人同一时间只跑一条 |

在聊天里发 `/` 开头的消息也一样会让 bot 执行（它在每个频道里，也可以私聊它）。

### 发消息

`SendRequest` 必须带 `client_msg_id`（客户端随机生成，≤ 64 字符）。同一个账号重复发送同一个 `client_msg_id`，服务器返回第一次存下的事件。

- 文字：`text`，可带 `reply_to` 和 `mentions`（文字里「@名字」对应的用户 id；客户端高亮这些名字，AI 被 @ 时会回）。
  - 回复时 `reply_to` 是同会话里的一条文字、图片或文件消息的 event id，服务器校验目标存在、在当前会话且尚未被管理员删除。
  - `GET /api/v1/conversations/{id}/messages/{event}` 返回一条 `Event`，仅当前会话成员可读。客户端用它读取较早的引用，已删原文只返回删除记录，不返回内容。
- 图片：先上传，再发 `image{media_id}`，宽高由服务器填（也可以直接发我表情里的或公共表情库里的图，不用自己上传）。从表情面板发的带 `sticker_tags`（表情的标签，最多 10 个、每个 20 字，服务器会去空格、去重）。bot / AI 发的图可以带 `made_with`（怎么做的，比如「NovelAI V5」，最多 30 字）、`nsfw`、`made_for`（谁让它画的，要是这个会话的成员，否则去掉；电子厕所认它当罪犯）和 `made_from`（让它画的那句话，最多 200 字；用来给图起名）；人发的图这几项都会被去掉。
- 文件：先上传，再发 `file{media_id, name}`，`name` 为空时用上传时的文件名。
- 转发记录请求是 `SendRequest.forward{source_conv_id,event_ids}`，服务器校验原会话访问权，去重后按 seq 排序，把内容写成 `Event.forward.entries`。本服原生记录里的 `source_conv_id/source_name/source_event_id/sender_id/sender_name/sent_at/struck` 都由服务器填写。每条 entry 的正文是文字、图片或文件，原会话的通知 mentions 不会转成当前会话的提醒。被删除或无权访问的原消息不能转发。
- `POST /api/v1/conversations/{id}/forward-export` 接受 `ForwardRequest{event_ids}`，返回 `ForwardMsg`。要求源会话成员权限，按原消息 seq 排序、去重、检查删除和条数限制，只读、不产生新消息。拒绝携带 `imported_entries/source_server` 的导出请求。
- 跨服客户端先复制所有附件到目标，再向目标 `POST /api/v1/conversations/{id}/forward-import` 提交 `SendRequest{client_msg_id,forward:{source_server,imported_entries}}`，返回已保存的 `Event` 并照常广播。导入不能混带 `source_conv_id/event_ids`。单独的 HTTP 导入端点支持批量文字，体积上限为 `max_forward_messages * (max_text_length * 6 + 8192) + 8192` 字节，不改变其他 HTTP 请求和 WebSocket 的限制。重试使用相同 `client_msg_id`，复用已有消息。
- 导入条目必须带有效的来源 ID、作者、会话名称和时间，最多 `max_forward_messages` 条，文本遵守目标的长度限制。每条 `ForwardEntry` 保存 `source_server` 和服务端强制的 `imported=true`。这些外服来源、作者和时间由转发者提供，不能视为目标服务器认证的本服身份。本服再次转发时也保留该标记。导入清除外服文字的 `reply_to/mentions`，图片和文件只接受当前发送者自己的本服上传，尺寸和大小以本服媒体记录为准。目标不会抓取外服 URL，下载继续经过目标会话权限检查。
- emoji 操作是 `SendRequest.emoji_pin`，新增时给 `target_event_id/emoji/x/y/on_bubble`。`on_bubble=true` 时 x、y 都在 0–1 之间，否则 x 是横向比例、y 是相对消息行顶部的像素偏移（-4000 到 4000）。`target_event_id=0` 表示会话起点，只能用于空白区域。
- 移除贴纸发送 `emoji_pin.remove_pin_id`，仅贴的人、会话管理员或站点管理员可用。新增和移除都以 `Event.emoji_pin` 广播，不产生新的聊天气泡。
- `GET /api/v1/conversations/{id}/emoji-pins` 返回 `ListEmojiPinsResponse`，仅当前会话成员可读。快照含移除记录和 `revision`（最后一次操作的 event id），客户端只采纳更新的版本。
- 划掉：`strike{target_event_id}`，只能划自己的文字 / 图片 / 文件消息，每条只能划一次。

发送成功后：发送请求的连接收到 `send` 响应；发送者的其他设备收到带 `client_msg_id` 的 `event`；其他成员收到不带 `client_msg_id` 的 `event`。

### 系统事件

成员和群信息的变化也是事件，占 seq，客户端据此更新成员列表和显示提示：

| 事件 | 含义 |
| --- | --- |
| `sys_conv{created}` | 建群 |
| `sys_conv{name / avatar / notice / join_approval / nsfw}` | 群信息变化（只带变了的字段）；`nsfw` 只来自管理面板，发送者记为服务器的内置 bot |
| `sys_conv{dissolved}` | 群解散 |
| `sys_member{JOIN}` | 入群（`operator_id` 是拉人或批准的人） |
| `sys_member{LEAVE / KICK}` | 退群 / 被踢 |
| `sys_member{MUTE / UNMUTE}` | 禁言（`until`）/ 解禁 |
| `sys_member{ROLE_CHANGE}` | 角色变化（`new_role`），转让群主是两条 |
| `sys_museum` | 博物馆：`kind` = `proposed`（发起投票，`vote_id`、`ends_at`）、`passed` / `failed`（投票结果）、`done`（人少直接生效）；`text` 是做了什么，`media_id` 是那件作品 |
| `admin_delete` | 管理员删除了某条消息 |

### 星屿鱼塘

kind `fishing` 复用游戏开局、加入、离座、结束和推送接口，进入立即 playing。`Game.state_json` 的 `pond` 含 12 个座位和服务器时间，操作 sit / steal；所有玩家的收获由服务端按 `bite_at` 立即自动结算（新竿 expires_at = bite_at），旧 reel 请求仅兼容读取、不提前收获。规则 JSON 新增五档概率 `double_fish_percent`（缺省 10/20/30/40/50），手套 `glove`（多鱼）/ `glove_haste`（减冷却）/ `glove_value`（加售价）共用账号 steal_at，从本塘玩家鱼篓原子转移现有鱼，保留原鱼 ID/钓者/归属、不生成副本。规则新增 steal_base_cd_seconds / steal_fish_count / steal_cd_reduction_percent / steal_value_percent；pond 新增 settled_at，座位新增 joined_at，鱼新增 acquired_at / base_value / steal_bonus_percent，跨服保存七类工具和新字段。原工具 ID auto 改为双鱼竿，旧 auto_at / auto_cd_seconds 不再影响收益。新增 FishingData、FishingActionRequest、FishingSyncRequest 和 `/fishing/rules`、`/fishing/me`、`/fishing/sync`、`/users/{id}/fishing-showcase`。账号存档、幂等请求、JSON 字段和错误沿用规则见 [fishing.md](fishing.md#接口和数据)。用户主页新增 fishing_fish / fishing_cards / fishing_badges，容量和配置见同文档。公开展示不返回私有钱包和鱼篓。

### 别人的 AI 操作我的电脑（转发）

- AI 账号的连接发 `remote_tool{request_id, to_user_id, tool, args_json}`：服务器回 `ack`，把 `remote_tool{request_id, from_ai, tool, args_json}` 推给那个人的所有在线设备。只能发给真人；双方（AI 或它的主人）有一方屏蔽了对方 `blocked`；真人发 `no_permission`；每个 AI 每分钟最多 30 个 `rate_limited`；`args_json` 最多 16 KiB。
- 那个人的某台设备（打开了允许的那台）回 `remote_tool_result{request_id, to_ai_id, ok, text, images}`：服务器回 `ack`，把 `remote_tool_result{request_id, from_user_id, ...}` 推给那个 AI。只有真人能回；`text` 最多 64 KiB，`images` 最多 2 张，合计 900 KiB 以内（`too_long`）。
- 服务器什么都不记，也不判断能不能做：允不允许、问不问人都在对方设备上决定（docs/design.md §9）。

### 正在输入

- 发 `typing{conv_id}`：服务器回 `ack`，把 `typing{conv_id, user_id}` 推给会话里的其他成员（什么都不存）。不是成员 `not_member`。同一个人在同一个会话 2 秒内多发的、隐身的人发的、私信里有一方屏蔽了另一方的，都悄悄丢掉（照样回 `ack`）。
- 客户端写的时候每 3 秒发一次；收到后显示 6 秒，那个人的消息到了就不再显示。

### 主人让运行 AI 的那个客户端做事（转发）

- 主人的连接发 `ai_control{request_id, ai_id, action, args_json}`：服务器回 `ack`，把 `ai_control{request_id, from_user_id, action, args_json}` 推给那个 AI 的连接（运行它的那台设备，或者服务器上托管它的客户端）。只有它的主人（别人 `no_permission`，AI 不在或已删除 `user_not_found`）；每个主人每分钟最多 90 个 `rate_limited`；`args_json` 最多 16 KiB。
- 运行它的客户端回 `ai_control_result{request_id, ok, text}`（ok 时 `text` 是回答的 JSON，不 ok 是原因，最多 64 KiB）：服务器回 `ack`，把 `ai_control_result{request_id, ai_id, ok, text}` 推给主人的设备。只有有主人的 bot / AI 账号能回。
- 现在只有一个 `action`：`bili`，`args_json` = `{"action":"status" | "start" | "poll" | "logout", "key": "…"}`，就是那台的「AI 浏览器登录 B 站」（回答和本机的一样：`{login, name}`、`{url, key}`、`{code, message, …}`）。服务器只转发，什么都不记。

## 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `bad_request` | 400 | 请求格式不对 |
| `unauthorized` | 401 | 没带 token 或 token 无效 |
| `banned` | 403 | 账号被封 |
| `wrong_credentials` | 401 | 用户名或密码错误 |
| `invalid_invite` | 400 | 邀请码无效或已用过 |
| `username_taken` | 409 | 用户名已被占用（不区分大小写） |
| `invalid_username` | 400 | 用户名须为 3–20 位字母、数字或下划线 |
| `weak_password` | 400 | 密码至少 8 位 |
| `invalid_display_name` | 400 | 昵称须为 1–32 个字符 |
| `invite_limit` | 403 | 邀请码已用完 |
| `user_not_found` | 404 | 用户不存在 |
| `self` | 400 | 不能对自己操作 |
| `blocked` | 403 | 有一方屏蔽了另一方，不能私信 |
| `not_public` | 403 | 不是公开频道，不能自己加入 |
| `not_found` | 404 | 目标不存在 |
| `not_member` | 403 | 不在这个会话里 |
| `muted` | 403 | 在这个会话里被禁言 |
| `empty_message` | 400 | 消息为空 |
| `too_long` | 400 | 消息超过 `limits.max_text_length` |
| `missing_client_msg_id` | 400 | 没带 client_msg_id |
| `cannot_strike` | 403 | 只能划掉自己的消息 |
| `already_struck` | 409 | 已经划掉过 |
| `no_permission` | 403 | 权限不够 |
| `not_group` | 400 | 这个会话不是群 |
| `invalid_group_name` | 400 | 群名须为 1–32 个字符 |
| `notice_too_long` | 400 | 群公告最多 1000 字 |
| `owner_cannot_leave` | 400 | 群主须先转让或解散 |
| `group_full` | 403 | 群已满（`limits.max_group_members`） |
| `no_join_request` | 404 | 没有这个人的入群申请 |
| `not_in_group` | 404 | 对方不在群里 |
| `reason_required` | 400 | 管理员删除 / 封禁必须写原因 |
| `no_password` | 400 | 这个账号不用密码登录（bot / AI），不能重置密码 |
| `already_deleted` | 409 | 已被删除 |
| `too_large` | 413 | 文件超过 `limits.max_upload_mb`，或登录码的包 / 共享数据超过 32 KiB |
| `blocked_media` | 403 | 图片在黑名单里 |
| `not_image` | 400 | 不是支持的图片 |
| `bad_image` | 400 | 图片读不出来或像素过大 |
| `media_not_found` | 404 | 媒体不存在或无权查看 |
| `bio_too_long` | 400 | 个性签名最多 100 字 |
| `invalid_activity` | 400 | 状态类型不认识、说明超过 32 字，或自定义状态没写内容 |
| `left_server` | 403 | 这个账号退出了服务器，登录时要带新的邀请码 |
| `invalid_widget` | 400 | 小组件类型不认识、大小或位置不对（出界、重叠、第 4 页）、或设置内容不对 |
| `layout_conflict` | 409 | 主页在你编辑期间被别人存过了，刷新后再改 |
| `ai_limit` | 403 | AI 账号已经建到 `limits.max_ai_per_user` 个 |
| `hosting_off` | 403 | 这个服务器关掉了 AI 托管（`hosting.enabled = false` 或 `max_per_user = 0`） |
| `hosting_limit` | 403 | 你托管（或申请托管）的 AI 已经有 `hosting.max_per_user` 个 |
| `sticker_limit` | 403 | 表情已经存到 `limits.max_stickers` 个 |
| `sticker_tags_full` | 409 | 这张表情的标签已经有 20 个了 |
| `sticker_library_off` | 403 | 这个服务器关掉了公共表情库（`stickers.library = false`） |
| `game_limit` | 403 | 这个会话里没结束的桌游已经有 `limits.max_games_per_conv` 局（0 = 桌游关着） |
| `game_full` | 409 | 这局没有空座位了 |
| `game_state` | 409 | 这局现在不在那个阶段（还没开始、已经开始或已经结束、人不够） |
| `not_your_turn` | 409 | 还没轮到你（或这轮已经投过票） |
| `game_bad_move` | 400 | 不合规则：位置被占、黑白棋没夹住子、描述里有自己的词或太长、投给自己 / 出局的人 |
| `museum_off` | 403 | 这个服务器关掉了博物馆（`museum.enabled = false`） |
| `museum_full` | 409 | 第一展厅满了，选一个位置插进去 |
| `museum_nsfw` | 403 | 这件作品是 NSFW 的，这个频道不允许 NSFW |
| `museum_title` | 400 | 作品名不能用 |
| `museum_vote_open` | 409 | 这件作品还有一个投票没结束 |
| `music_link_invalid` | 400 | 不是网易云的歌曲 / 歌单链接 |
| `music_unavailable` | 502 | 没能从网易云读到（链接对不上、网易云没回答，或者服务器关掉了这个功能） |
| `too_many_devices` | 403 | 这个账号登录的设备已经到 `limits.max_devices` 台，先退出一台（登录、生成登录码、用登录码时） |
| `invalid_pair_code` | 400 | 登录码的 ticket 不对、用过了或过期了 |
| `state_conflict` | 409 | 共享数据在你合并期间被另一台设备存过了，取回重新合并 |
| `rate_limited` | 429 | 尝试太频繁 |
| `already_authenticated` | 400 | 已登录的连接又发了 auth |
| `internal_error` | 500 | 服务器内部错误（看服务器日志） |

已停用的错误码（随好友一起取消，不再返回，也不会挪作他用）：`already_friends`、`no_request`、`not_friends`。

## 兼容性规则

- 只新增字段和类型，不改、不复用已有字段编号。
- 客户端遇到不认识的事件类型要能显示占位（例如"不支持的消息类型"），不能崩。
