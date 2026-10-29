# 在 Windows 上搭建 AM 服务器

AM 是自建服务：每个人用自己的电脑或服务器跑 `am-server`，朋友们的客户端连过来。默认用 SQLite，**不用安装任何数据库**，解压就能跑。

## 1. 下载

1. 打开仓库的 **Actions** 页面，点最新一次成功（绿色勾）的运行。
2. 在页面下方 Artifacts 里下载 `am-windows-amd64`，解压到一个固定文件夹，比如 `D:\am`。

| 文件 | 用途 |
| --- | --- |
| `am-server.exe` | 服务器 |
| `am-testclient.exe` | 命令行测试客户端 |
| `1_start_server.bat` | 启动服务器 |
| `2_testclient.bat` | 打开测试客户端 |
| `postgres_setup_db.bat` | 只有改用 PostgreSQL 时才需要 |

## 2. 第一次启动

双击 `1_start_server.bat`。第一次会自动：

- 生成 `config.toml`（所有设置都在这里）；
- 在 `data\` 里建数据库文件 `am.db`、证书和上传文件目录；
- 打印两样重要的东西：

```
msg="no users yet - register the first (admin) account with this invite code" invite=XXXXXXXXXX
msg="TLS self-signed certificate - put this fingerprint into client configs" fingerprint=AB:CD:...
```

- **invite**：第一个账号的注册码，用它注册的账号是站点管理员。也存在 `data\bootstrap_invite.txt`。
- **fingerprint**：证书指纹，所有客户端都要填。以后每次启动都会打印同一个（证书在 `data\tls\`，别删）。

关掉窗口，进入下一步改配置。

## 3. 改配置

用记事本打开 `config.toml`：

```toml
[tls]
hosts = ["127.0.0.1", "localhost", "你的公网IP或域名"]
```

用 frp 中转的话，再打开真实 IP（登录记录和登录限频要用）：

```toml
[server]
proxy_protocol = true
```

其他参数旁边都有英文注释，一般不用动。改完重新双击 `1_start_server.bat`。

## 4. frp 转发（家里没有公网 IP 时）

在 frpc 的配置里加一条 TCP 转发（frp 0.52 以后的 toml 写法）：

```toml
[[proxies]]
name = "am"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8443
remotePort = 8443
# 把用户的真实 IP 传给 AM（配合 config.toml 里的 proxy_protocol = true）
transport.proxyProtocolVersion = "v2"
```

然后：

- 重启 frpc；
- **云服务器控制台 → 防火墙 / 安全组，放行 TCP 8443。**

注意：`proxy_protocol = true` 和 frp 的 `proxyProtocolVersion` 要么都开、要么都关。服务器只信任来自本机（frpc）的真实 IP 信息，外人伪造不了。

## 5. 用测试客户端试一下

1. 双击 `2_testclient.bat`，第一次会生成 `testclient.toml` 后退出。
2. 打开 `testclient.toml`，填：
   ```toml
   server = "https://你的公网IP:8443"
   fingerprint = "第 2 步打印的指纹"
   ```
   （在服务器本机测试可以写 `https://127.0.0.1:8443`）
3. 再双击 `2_testclient.bat`，输入一个配置名（比如 `alice`），然后：
   ```
   register 第2步的邀请码 alice 你的密码 爱丽丝
   newinvite
   ```
   `newinvite` 生成的码发给朋友注册用（每人 3 个，管理员不限）。
4. 再开一个窗口，配置名填 `bob`，用新邀请码注册。之后：
   - bob：`add alice`
   - alice：`accept bob`，然后 `dm bob`，直接打字回车就是发消息
   - 建群：`group 群名 bob`；发图：`img D:\pic.png`；输入 `help` 看全部命令。

## 6. 备份

关掉服务器后，把整个 `data\` 文件夹复制一份就是完整备份（数据库、图片、证书都在里面）。

## 人多了想换 PostgreSQL

1. 装好 PostgreSQL，记住 postgres 用户的密码。
2. `config.toml` 里改 `[database] driver = "postgres"`。
3. 双击 `postgres_setup_db.bat`，输入 postgres 密码，自动建好用户和库。
4. 启动服务器。

（目前不会自动把 SQLite 里的数据搬到 PostgreSQL，换之前请先确认。）

## 常见问题

- **客户端报 `fingerprint mismatch`**：指纹填错了，或者 `data\tls` 被删了导致证书重新生成。从服务器日志重新复制。
- **外网连不上、本机能连**：检查 frpc 是否运行、安全组是否放行 8443。
- **登录记录里 IP 全是 127.0.0.1**：没开 proxy protocol，见第 3、4 步。
- **停止服务器**：在服务器窗口按 Ctrl+C，或直接关窗口。
