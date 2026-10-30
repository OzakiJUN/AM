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

管理面板本身的 `/api/...`（在 `admin.listen` 上）是面板内部接口，会跟着面板改，不属于客户端协议。

需要登录的 HTTP 接口带请求头 `Authorization: Bearer <token>`；媒体下载也一样（客户端用 fetch 取回后显示）。

## HTTP 接口

### 账号

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/v1/health` | — | `{"ok":true}`（无需登录） |
| GET | `/api/v1/server` | — | `ServerInfo`：服务器名、版本、客户端下载页、图标地址（无需登录） |
| GET | `/api/v1/server/icon` | — | 服务器图标 PNG（无需登录；没设置时 `media_not_found`）。`ServerInfo.icon` 带 `?v=` 版本号，换图标地址就变 |
| GET | `/api/v1/server/profile` | — | `ServerProfile`：服务器主页（名字、简介、图标、成员数、在线人数、谁能改布局、成员能否改小组件内容）。由站点管理员在管理面板里设置 |
| POST | `/api/v1/register` | `RegisterRequest` | `SessionResponse`（无需登录） |
| POST | `/api/v1/login` | `LoginRequest` | `SessionResponse`（无需登录）。退出过服务器的账号要带 `invite_code`（一个没用过的邀请码，会被用掉）才能回来，否则 `left_server`；其他账号忽略这个字段 |
| GET | `/api/v1/sessions` | — | `ListSessionsResponse` |
| DELETE | `/api/v1/sessions/{id}` | — | `Empty`（立即断开该设备） |
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
| PATCH | `/api/v1/groups/{id}` | `UpdateGroupRequest` | `Conversation` | 管理员 / 群主 |
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
| POST | `/api/v1/media` | `multipart/form-data`，字段名 `file`，返回 `MediaInfo` |
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
  | `music` | 2×2 | `provider`（`netease`）、`playlist_id`（数字）、`title`（≤40） |
  | `status` | 2×1 | 只能放在个人主页 |
  | `online` | 2×2 | 只能放在服务器主页 |

- 工坊组件（`source = WORKSHOP`）要有 `workshop_id`、`workshop_version`、`package_sha256`，可带截图 `snapshot_media_id`（第五阶段运行）。
- 权限：个人主页只有本人能存。服务器主页：站点管理员都行；加删、挪动、改大小、改背景要"谁能改布局"；改某个组件的 `config` 要"成员能改小组件内容"打开且这个组件不是 `WIDGET_EDITORS_ADMINS`；改 `content_editors` 只有站点管理员。新放上去的图片必须是保存的人自己上传的。
- 每次保存是一个新版本，旧版本保留 `retention.evidence_days` 天。

## WebSocket 流程

1. 连接 `/ws`，**第一帧**必须是 `ClientFrame{auth}`，10 秒内不发就断开。
2. 服务器回 `ServerFrame{auth}`：自己的资料 + 所有会话（带 `last_seq`、成员和角色、自己的 `self` 状态）+ `is_site_admin`（能不能建公开频道）+ `presences`（在线的人）。token 无效时先回 `error`（`unauthorized`）再断开。
3. 客户端对比本地每个会话已有的最大 seq 和 `last_seq`，用 `sync` 补齐缺的事件；`has_more` 里的会话还要继续拉下一页。
4. 之后服务器推送（`req_id = 0`）：
   - `event`：会话里有新事件（含系统事件）。
   - `conv`：你加入了新会话（新会话会先于它的事件推送）。
   - `conv_removed`：你离开了某个会话（退群、被踢、群解散），客户端保留只读历史。
   - `join_request`：有人被邀请进需要审批的群（发给群主和管理员）。
   - `presence`：某人上线 / 下线 / 改了隐身或状态（发给服务器上所有在线的人，每人看到的是自己该看到的样子，见"在线状态"）。
5. 请求带客户端自定的 `req_id`，响应带同一个 `req_id`。

服务器每 30 秒发一次 WebSocket ping；客户端也可以发 `ping` 帧。客户端读得太慢会被断开，重连后 sync 即可。

### 发消息

`SendRequest` 必须带 `client_msg_id`（客户端随机生成，≤ 64 字符）。同一个账号重复发送同一个 `client_msg_id`，服务器返回第一次存下的事件。

- 文字：`text`，可带 `reply_to` 和 `mentions`。
- 图片：先上传，再发 `image{media_id}`，宽高由服务器填。
- 文件：先上传，再发 `file{media_id, name}`，`name` 为空时用上传时的文件名。
- 划掉：`strike{target_event_id}`，只能划自己的文字 / 图片 / 文件消息，每条只能划一次。

发送成功后：发送请求的连接收到 `send` 响应；发送者的其他设备收到带 `client_msg_id` 的 `event`；其他成员收到不带 `client_msg_id` 的 `event`。

### 系统事件

成员和群信息的变化也是事件，占 seq，客户端据此更新成员列表和显示提示：

| 事件 | 含义 |
| --- | --- |
| `sys_conv{created}` | 建群 |
| `sys_conv{name / avatar / notice / join_approval}` | 群信息变化（只带变了的字段） |
| `sys_conv{dissolved}` | 群解散 |
| `sys_member{JOIN}` | 入群（`operator_id` 是拉人或批准的人） |
| `sys_member{LEAVE / KICK}` | 退群 / 被踢 |
| `sys_member{MUTE / UNMUTE}` | 禁言（`until`）/ 解禁 |
| `sys_member{ROLE_CHANGE}` | 角色变化（`new_role`），转让群主是两条 |
| `admin_delete` | 管理员删除了某条消息 |

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
| `too_large` | 413 | 文件超过 `limits.max_upload_mb` |
| `blocked_media` | 403 | 图片在黑名单里 |
| `not_image` | 400 | 不是支持的图片 |
| `bad_image` | 400 | 图片读不出来或像素过大 |
| `media_not_found` | 404 | 媒体不存在或无权查看 |
| `bio_too_long` | 400 | 个性签名最多 100 字 |
| `invalid_activity` | 400 | 状态类型不认识、说明超过 32 字，或自定义状态没写内容 |
| `left_server` | 403 | 这个账号退出了服务器，登录时要带新的邀请码 |
| `invalid_widget` | 400 | 小组件类型不认识、大小或位置不对（出界、重叠、第 4 页）、或设置内容不对 |
| `layout_conflict` | 409 | 主页在你编辑期间被别人存过了，刷新后再改 |
| `rate_limited` | 429 | 尝试太频繁 |
| `already_authenticated` | 400 | 已登录的连接又发了 auth |
| `internal_error` | 500 | 服务器内部错误（看服务器日志） |

已停用的错误码（随好友一起取消，不再返回，也不会挪作他用）：`already_friends`、`no_request`、`not_friends`。

## 兼容性规则

- 只新增字段和类型，不改、不复用已有字段编号。
- 客户端遇到不认识的事件类型要能显示占位（例如"不支持的消息类型"），不能崩。
