# AM 协议说明

协议定义在 `proto/am/v1/*.proto`，这里说明怎么用。字段的含义以 proto 文件里的注释为准。

## 连接方式

| 用途 | 方式 | 编码 |
| --- | --- | --- |
| 登录、好友、群管理、上传等 | HTTP `/api/v1/...` | protojson（字段名小驼峰，64 位整数是字符串） |
| 实时消息、同步 | WebSocket `/ws` | 二进制 protobuf，一条 WebSocket 消息 = 一个 `ClientFrame` / `ServerFrame` |

服务器默认 `https://<IP>:8443`。使用自签证书时，客户端必须固定（pin）服务器启动时打印的 SHA-256 指纹，而不是信任系统 CA。

### 连接码

服务器管理面板生成的连接码，客户端粘贴或扫二维码即可添加服务器：

```
am://connect?v=1&addr=47.1.2.3:7000&fp=<证书 SHA-256，base64url 无填充>&name=<服务器名>
```

| 参数 | 含义 |
| --- | --- |
| `v` | 格式版本，目前是 `1`；客户端遇到更大的版本要提示更新 |
| `addr` | `主机:端口`，客户端从外面能连到的地址（IPv6 用 `[::1]:8443`） |
| `fp` | 自签证书的 SHA-256。有它就固定指纹、不查 CA；没有则按系统 CA 正常校验（正式证书）。也接受带冒号的十六进制 |
| `tls=off` | 服务器没开 TLS（只用于本机调试），用 `http://` |
| `name` | 服务器显示名，可选 |

解析和生成见 `internal/connectcode`，Go SDK 里是 `amclient.ParseConnectCode` / `amclient.NewFromCode`。

管理面板本身的 `/api/...`（在 `admin.listen` 上）是面板内部接口，会跟着面板改，不属于客户端协议。

需要登录的 HTTP 接口带请求头 `Authorization: Bearer <token>`；媒体下载也一样（客户端用 fetch 取回后显示）。

## HTTP 接口

### 账号

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/v1/health` | — | `{"ok":true}`（无需登录） |
| POST | `/api/v1/register` | `RegisterRequest` | `SessionResponse`（无需登录） |
| POST | `/api/v1/login` | `LoginRequest` | `SessionResponse`（无需登录） |
| GET | `/api/v1/sessions` | — | `ListSessionsResponse` |
| DELETE | `/api/v1/sessions/{id}` | — | `Empty`（立即断开该设备） |
| GET | `/api/v1/invites` | — | `ListInvitesResponse`（`remaining = -1` 表示不限） |
| POST | `/api/v1/invites` | — | `Invite` |
| PATCH | `/api/v1/me` | `UpdateProfileRequest` | `User` |
| GET | `/api/v1/me/logins` | — | `ListLoginRecordsResponse`（最近 50 条） |
| GET | `/api/v1/users/{id}` | — | `User` |

### 好友与会话

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/v1/friends` | — | `ListFriendsResponse` |
| POST | `/api/v1/friends/request` | `FriendRequest` | `Empty` |
| POST | `/api/v1/friends/accept` | `FriendAccept` | `Empty` |
| POST | `/api/v1/dm` | `OpenDMRequest` | `Conversation` |
| GET | `/api/v1/conversations/{id}` | — | `Conversation`（须是成员） |

向已经向你发过申请的人发好友申请，等于直接接受。

### 群

| 方法 | 路径 | 请求 | 响应 | 权限 |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/groups` | `CreateGroupRequest` | `Conversation` | 成员须是好友 |
| PATCH | `/api/v1/groups/{id}` | `UpdateGroupRequest` | `Conversation` | 管理员 / 群主 |
| DELETE | `/api/v1/groups/{id}` | — | `Empty`（解散） | 群主 |
| POST | `/api/v1/groups/{id}/members` | `InviteMembersRequest` | `InviteMembersResponse` | 成员，只能拉好友 |
| DELETE | `/api/v1/groups/{id}/members/{uid}` | — | `Empty` | 自己 = 退群；他人 = 踢人（角色须更高） |
| POST / DELETE | `/api/v1/groups/{id}/admins/{uid}` | — | `Empty` | 群主 |
| POST | `/api/v1/groups/{id}/transfer` | `TransferGroupRequest` | `Empty` | 群主（原群主变成员） |
| POST | `/api/v1/groups/{id}/mute` | `MuteMemberRequest` | `Empty` | 角色须更高；时长 0 = 解禁，最长 365 天 |
| GET | `/api/v1/groups/{id}/requests` | — | `ListJoinRequestsResponse` | 管理员 / 群主 |
| POST | `/api/v1/groups/{id}/requests/{uid}/approve` 或 `/reject` | — | `Empty` | 管理员 / 群主 |

开了入群审批的群，普通成员拉人会变成入群申请，管理员同意后才进群；管理员和群主拉人直接进。群主不能直接退群，要先转让或解散。

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

## WebSocket 流程

1. 连接 `/ws`，**第一帧**必须是 `ClientFrame{auth}`，10 秒内不发就断开。
2. 服务器回 `ServerFrame{auth}`：自己的资料 + 所有会话（带 `last_seq`、成员和角色、自己的 `self` 状态）。token 无效时先回 `error`（`unauthorized`）再断开。
3. 客户端对比本地每个会话已有的最大 seq 和 `last_seq`，用 `sync` 补齐缺的事件；`has_more` 里的会话还要继续拉下一页。
4. 之后服务器推送（`req_id = 0`）：
   - `event`：会话里有新事件（含系统事件）。
   - `conv`：你加入了新会话（新会话会先于它的事件推送）。
   - `conv_removed`：你离开了某个会话（退群、被踢、群解散），客户端保留只读历史。
   - `friend`：收到好友申请 / 申请被接受。
   - `join_request`：有人被邀请进需要审批的群（发给群主和管理员）。
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
| `already_friends` | 409 | 已经是好友 |
| `no_request` | 404 | 没有这个人的待处理好友申请 |
| `not_friends` | 403 | 不是好友 |
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
| `rate_limited` | 429 | 尝试太频繁 |
| `already_authenticated` | 400 | 已登录的连接又发了 auth |
| `internal_error` | 500 | 服务器内部错误（看服务器日志） |

## 兼容性规则

- 只新增字段和类型，不改、不复用已有字段编号。
- 客户端遇到不认识的事件类型要能显示占位（例如"不支持的消息类型"），不能崩。
