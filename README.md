# AM (AI Message)

AM (AI Message) 是我和小克一起打造的新一代 AI 集成聊天工具，支持基础聊天、聊天 Bot、AI 接入和经典社区等功能。

## 特色

- **像 Discord 一样的自建服务器**：没有好友，服务器里的人都能直接私信（可以屏蔽）；频道分公开和私密。
- **划掉代替撤回**：消息发出去就撤不回，只能加删除线"划掉"；管理员删除也会留下记录。
- **AI / Bot 身份由服务器盖章**：bot 不限功能，但名字旁永远显示「AI · 主人：xx」，伪造不了。
- **原生 AI 对话栏**：填自己的 API key，直接和各家模型聊天（规划中）。
- **表情包库**：全站共享、带上传者和关键词，个人收藏夹分类（规划中）。
- **社区 & 创意工坊**：动态广场、小游戏和插件，开了什么插件强制公示（规划中）。

## 自己搭服务器

AM 是自建服务：下载服务器，在自己的电脑或云服务器上跑起来，邀请朋友用客户端连接。服务器就是**一个文件**，默认使用 SQLite，不用装数据库；人多了可以切换到 PostgreSQL。

看 [docs/server-setup.md](docs/server-setup.md)。简单说：

1. 下载 `am-server.exe`（[Releases](../../releases)，或 [Actions](../../actions) 里的最新开发版）。
2. 双击运行。右下角出现托盘图标，弹出服务器管理窗口。
3. 用窗口里的管理员加入码在客户端注册；之后每个账号自动有 3 个邀请，把加入码或二维码发给朋友就行。

## 客户端

Windows 版下载 `AM-setup.exe`（安装版）或 `AM.exe`（免安装），在 [Releases](../../releases) 或 [Actions](../../actions) 的 `am-client-windows` 里。需要 WebView2（Win10/11 自带，没有时安装程序会自动下载）。

第一次打开：复制朋友发来的加入码再打开客户端，会自动识别；也可以粘贴加入码，或选一张二维码图片。设置里可以换主题色、深浅色、背景图片和字体大小。安卓版之后做。

## 当前进度

第一阶段已完成四批：
- **后端核心**：邀请码注册、登录、多设备会话、私聊、发消息、划掉、断线补消息、已读位置。
- **群与媒体**：群聊与群管理、入群审批、管理员删除（留证据和审计日志）、登录记录、图片 / 文件 / GIF 头像、图片黑名单。
- **服务器管理面板**：单文件 exe、托盘图标、独立管理窗口（用户管理、邀请码、删除记录、操作记录、日志、设置）、加入码 / 二维码、注册自动发邀请、开机自启。
- **Windows 客户端**：NapCatQQ 风格界面、可换主题和背景、多服务器、加入码 / 扫码注册、频道（公开 / 私密）和私信、成员列表和屏蔽、图片文件、频道管理、系统通知、AI 栏（立绘界面）。

下一批：客户端免重装更新、Windows 版正式发布。详见 [CHANGELOG.md](CHANGELOG.md) 和 [docs/design.md](docs/design.md)。

## 目录

| 目录 | 内容 |
| --- | --- |
| `docs/` | 设计文档、协议说明、部署说明 |
| `proto/` | Protobuf 协议定义（唯一真相来源） |
| `gen/` | 由 proto 自动生成的代码，不要手改 |
| `server/` | Go 后端 |
| `sdk/go/amclient` | Go 客户端库（测试客户端、测试、Go 写的 bot 都用它） |
| `server/internal/admin/web` | 管理面板网页（纯 JS，打包进 exe） |
| `client/` | 图形界面客户端（Tauri 2 + React），见 [client/README.md](client/README.md) |
| `internal/connectcode` | 加入码格式（服务器和客户端共用） |
| `tools/testclient` | 命令行测试客户端 |
| `assets` | 图标及生成脚本 |
| `scripts/windows` | Windows 启动脚本 |

## 开发

```sh
# 改了 proto 之后重新生成代码
buf generate

# 运行全部测试（端到端测试默认跑 SQLite）
go test -race ./...

# 同时测 PostgreSQL（需要一个可以随便清空的数据库）
AM_TEST_DATABASE_URL="postgres://user:pass@127.0.0.1:5432/am_test?sslmode=disable" go test -race ./...
```

客户端开发见 [client/README.md](client/README.md)。

每次推送到 main，GitHub Actions 会跑测试并编译 Windows 版服务器和客户端；打 `v*` 标签会自动发布 Release。
