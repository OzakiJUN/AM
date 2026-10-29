# 在 Windows 上部署 AM 服务器

适用于第一阶段：服务器跑在家里的 Windows 电脑上，通过阿里云中转机（frp）对外，不用域名。

## 1. 装 PostgreSQL（只需一次）

1. 到 PostgreSQL 官网下载 Windows 安装包（EDB 提供的版本，16 或更新都行），一路默认安装。
2. 安装时会让你设置 **postgres 用户的密码**，记下来，下一步要用。
3. 不需要装 Stack Builder 里的附加组件。

## 2. 下载 AM

1. 打开仓库的 **Actions** 页面，点最新一次成功（绿色勾）的运行。
2. 在页面下方 Artifacts 里下载 `am-windows-amd64`，解压到一个固定的文件夹，比如 `D:\am`。

里面有：

| 文件 | 用途 |
| --- | --- |
| `am-server.exe` | 服务器 |
| `am-testclient.exe` | 命令行测试客户端 |
| `1_setup_db.bat` | 建数据库（只需一次） |
| `2_start_server.bat` | 启动服务器 |
| `3_testclient.bat` | 打开测试客户端 |

## 3. 建数据库

双击 `1_setup_db.bat`：

- 第一次运行会自动生成 `config.toml`（数据库密码是随机生成的，不用管）。
- 输入第 1 步设置的 postgres 密码（输入时不显示字符，正常）。
- 看到 `Database ready` 就好了。

## 4. 改配置

用记事本打开 `config.toml`，只需要改一处：

```toml
[tls]
hosts = ["127.0.0.1", "localhost", "你的阿里云公网IP"]
```

端口默认 `8443`，想换就改 `[server] listen`。其他参数旁边都有英文注释，一般不用动。

## 5. 启动服务器

双击 `2_start_server.bat`。第一次启动会打印两样重要的东西：

```
msg="no users yet - register the first (admin) account with this invite code" invite=XXXXXXXXXX
msg="TLS self-signed certificate - put this fingerprint into client configs" fingerprint=AB:CD:...
```

- **invite**：第一个账号的注册码，用它注册的账号是站点管理员。也存在 `data\bootstrap_invite.txt`。
- **fingerprint**：证书指纹，所有客户端都要填。以后每次启动都会打印同一个（证书存在 `data\tls\`，别删）。

## 6. frp 转发

在 frpc 的配置里加一条 TCP 转发（frp 0.52 以后的 toml 写法）：

```toml
[[proxies]]
name = "am"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8443
remotePort = 8443
```

然后：

- 重启 frpc。
- **阿里云控制台 → 防火墙 / 安全组，放行 TCP 8443。**

## 7. 用测试客户端试一下

1. 双击 `3_testclient.bat`，第一次会生成 `testclient.toml` 后退出。
2. 打开 `testclient.toml`，填：
   ```toml
   server = "https://你的阿里云公网IP:8443"
   fingerprint = "第 5 步打印的指纹"
   ```
   （在服务器本机测试可以写 `https://127.0.0.1:8443`）
3. 再双击 `3_testclient.bat`，输入一个配置名（比如 `alice`），然后：
   ```
   register 第5步的邀请码 alice 你的密码 爱丽丝
   newinvite
   ```
   `newinvite` 生成的码发给朋友注册用。
4. 再开一个窗口，配置名填 `bob`，用新邀请码注册。之后：
   - bob：`add alice`
   - alice：`accept bob`，然后 `dm bob`，直接打字回车就是发消息
   - 输入 `help` 看全部命令。

## 常见问题

- **启动报 `connect to database` 错误**：PostgreSQL 服务没启动，或者没运行过 `1_setup_db.bat`。
- **客户端报 `fingerprint mismatch`**：指纹填错了，或者服务器的 `data\tls` 被删了导致证书重新生成。从服务器日志重新复制。
- **外网连不上、本机能连**：检查 frpc 是否运行、阿里云安全组是否放行 8443。
- **停止服务器**：在服务器窗口按 Ctrl+C，或直接关窗口。
