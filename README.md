# AM (AI Message)

AM (AI Message) 是我和小克一起打造的新一代 AI 集成聊天工具，支持基础聊天、聊天 Bot、AI 接入和经典社区等功能。

## 特色

- **划掉代替撤回**：消息发出去就撤不回，只能加删除线"划掉"；管理员删除也会留下记录。
- **AI / Bot 身份由服务器盖章**：bot 不限功能，但名字旁永远显示「AI · 主人：xx」，伪造不了。
- **原生 AI 对话栏**：填自己的 API key，直接和各家模型聊天（规划中）。
- **表情包库**：全站共享、带上传者和关键词，个人收藏夹分类（规划中）。
- **社区 & 创意工坊**：动态广场、小游戏和插件，开了什么插件强制公示（规划中）。

## 当前进度

第一阶段第 1 批：**后端核心**已完成 —— 邀请码注册、登录、多设备会话、好友、私聊、发消息、划掉、断线补消息、已读位置。现在可以用命令行测试客户端互相聊天。

下一批：群聊与群管理、管理员删除、图片和文件。详见 [CHANGELOG.md](CHANGELOG.md) 和 [docs/design.md](docs/design.md)。

## 在 Windows 服务器上运行

看 [docs/server-setup.md](docs/server-setup.md)。简单说：

1. 在 [Actions](../../actions) 里下载最新的 `am-windows-amd64.zip`，解压。
2. 双击 `1_setup_db.bat` 建数据库（需要先装好 PostgreSQL）。
3. 双击 `2_start_server.bat` 启动服务器。
4. 双击 `3_testclient.bat` 打开测试客户端。

## 目录

| 目录 | 内容 |
| --- | --- |
| `docs/` | 设计文档、协议说明、部署说明 |
| `proto/` | Protobuf 协议定义（唯一真相来源） |
| `gen/` | 由 proto 自动生成的代码，不要手改 |
| `server/` | Go 后端 |
| `sdk/go/amclient` | Go 客户端库（测试客户端、测试、Go 写的 bot 都用它） |
| `tools/testclient` | 命令行测试客户端 |
| `scripts/windows` | Windows 启动脚本 |

## 开发

```sh
# 改了 proto 之后重新生成代码
buf generate

# 运行全部测试（端到端测试需要一个可以随便清空的 PostgreSQL 数据库）
AM_TEST_DATABASE_URL="postgres://user:pass@127.0.0.1:5432/am_test?sslmode=disable" go test -race ./...
```

每次推送到 main，GitHub Actions 会跑测试并编译 Windows 版；打 `v*` 标签会自动发布 Release。
