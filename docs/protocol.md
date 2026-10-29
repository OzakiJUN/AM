# AM 协议说明

协议定义在 `proto/am/v1/*.proto`，这里说明怎么用。字段的含义以 proto 文件里的注释为准。

## 连接方式

| 用途 | 方式 | 编码 |
| --- | --- | --- |
| 登录、注册、好友、会话管理等 | HTTP `/api/v1/...` | protojson（字段名小驼峰，64 位整数是字符串） |
| 实时消息、同步 | WebSocket `/ws` | 二进制 protobuf，一条 WebSocket 消息 = 一个 `ClientFrame` / `ServerFrame` |

服务器默认 `https://<IP>:8443`。第一阶段使用自签证书，客户端必须固定（pin）服务器启动时打印的 SHA-256 指纹，而不是信任系统 CA。

需要登录的 HTTP 接口带请求头 `Authorization: Bearer <token>`。

## HTTP 接口

| 方法 | 路径 | 请求 | 响应 | 需要登录 |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/health` | — | `{"ok":true}` | 否 |
| POST | `/api/v1/register` | `RegisterRequest` | `SessionResponse` | 否 |
| POST | `/api/v1/login` | `LoginRequest` | `SessionResponse` | 否 |
| GET | `/api/v1/sessions` | — | `ListSessionsResponse` | 是 |
| DELETE | `/api/v1/sessions/{id}` | — | `Empty` | 是 |
| GET | `/api/v1/invites` | — | `ListInvitesResponse` | 是 |
| POST | `/api/v1/invites` | — | `Invite` | 是 |
| GET | `/api/v1/friends` | — | `ListFriendsResponse` | 是 |
| POST | `/api/v1/friends/request` | `FriendRequest` | `Empty` | 是 |
| POST | `/api/v1/friends/accept` | `FriendAccept` | `Empty` | 是 |
| POST | `/api/v1/dm` | `OpenDMRequest` | `Conversation` | 是 |

出错时返回非 2xx 状态码，body 是 `Error`（`code` + `message`）。

- 注册 / 登录每个 IP 每分钟限 `limits.login_attempts_per_minute` 次。
- `ListInvitesResponse.remaining = -1` 表示不限（站点管理员）。
- 向已经向你发过申请的人发好友申请，等于直接接受。
- 踢掉某个会话（DELETE sessions）会立即断开该设备的 WebSocket。

## WebSocket 流程

1. 连接 `/ws`，**第一帧**必须是 `ClientFrame{auth}`，10 秒内不发就断开。
2. 服务器回 `ServerFrame{auth}`：自己的资料 + 所有会话（带 `last_seq` 和自己的 `self` 状态）。token 无效时先回 `error`（`unauthorized`）再断开。
3. 客户端对比本地每个会话已有的最大 seq 和 `last_seq`，用 `sync` 补齐缺的事件；`has_more` 里列出的会话还要继续拉下一页。
4. 之后服务器推送（`req_id = 0`）：
   - `event`：会话里有新事件。
   - `conv`：新会话出现，或会话信息、成员变了。
   - `friend`：收到好友申请 / 申请被接受。
5. 请求带客户端自定的 `req_id`，响应带同一个 `req_id`。

服务器每 30 秒发一次 WebSocket ping；客户端也可以发 `ping` 帧。客户端读得太慢（服务器发送队列满）会被断开，重连后 sync 即可。

### 发消息

`SendRequest` 必须带 `client_msg_id`（客户端随机生成，≤ 64 字符）。同一个账号重复发送同一个 `client_msg_id`，服务器返回第一次存下的事件，不会产生第二条。

发送成功后：
- 发送请求的那个连接收到 `send` 响应（含完整事件）。
- 发送者的其他设备收到 `event` 推送（带 `client_msg_id`）。
- 其他成员收到 `event` 推送（不带 `client_msg_id`）。

### 划掉

`SendRequest{strike: {target_event_id}}`。只能划自己的文字 / 图片 / 文件消息，每条只能划一次。划掉本身也是一条事件（占一个 seq），客户端看到它就给目标消息加删除线。

### 管理员删除（下一批实现）

目标事件的 `body` 被清空，`redaction` 记录删除者、原因、时间；同时追加一条 `admin_delete` 事件。客户端在原位置显示"已被 xx 删除 · 原因"。

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
| `not_implemented` | 501 | 还没实现（如图片 / 文件，下一批） |
| `rate_limited` | 429 | 尝试太频繁 |
| `already_authenticated` | 400 | 已登录的连接又发了 auth |
| `internal_error` | 500 | 服务器内部错误（看服务器日志） |

## 兼容性规则

- 只新增字段和类型，不改、不复用已有字段编号。
- 客户端遇到不认识的事件类型要能显示占位（例如"不支持的消息类型"），不能崩。
