# 搭建 AM 服务器

AM 是自建服务：每个人用自己的电脑或服务器跑 `am-server`，朋友们的客户端连过来。默认用 SQLite，**不用安装任何数据库**，一个文件就能跑。

## 1. 下载

- 正式版：仓库的 **Releases** 页面，下载 `am-server-windows-amd64.exe`（只要服务器）或 `am-windows-amd64.zip`（服务器 + 命令行测试客户端 + 脚本）。
- 最新开发版：仓库的 **Actions** 页面 → 最新一次成功（绿色勾）的运行 → 页面下方 Artifacts 里的 `am-windows-amd64`。

放到一个固定的文件夹，比如 `D:\am`。服务器的所有数据都会放在这个文件夹里。

| 文件 | 用途 |
| --- | --- |
| `am-server.exe` | 服务器，双击运行 |
| `am-testclient.exe` / `testclient.bat` | 命令行测试客户端（图形客户端出来之前先用它） |
| `server_console.bat` | 带日志窗口运行服务器，排查问题时用 |
| `postgres_setup_db.bat` | 只有改用 PostgreSQL 时才需要 |

## 2. 第一次启动

双击 `am-server.exe`：

- 不会弹黑框。任务栏右下角出现 AM 图标（可能在 ^ 里面），浏览器自动打开**管理面板**。
- 第一次会在旁边生成 `config.toml`（设置）和 `data\` 文件夹（数据库、证书、上传的文件、日志）。
- Windows 可能弹防火墙提示，允许"专用网络"即可（用 frp 的话本机连接不需要放行）。

管理面板的概览页有一张"入场券"：

- **连接码 + 二维码**：客户端用它添加服务器（里面带了地址和证书指纹，不用手填）。
- **管理员邀请码**：用它注册的第一个账号是站点管理员，只能用一次。

之后要打开面板：左键点托盘图标，或右键 → 打开管理面板。右键菜单里还有"重启服务器"和"退出"。再双击 `am-server.exe` 也只会打开面板，不会开第二个。

想开机自动启动：面板 → 设置 → Windows → 开机自动启动（开机时不会弹浏览器）。

## 3. 让外面的朋友连进来

家里没有公网 IP 时用 frp 转发到云服务器（阿里云等）。

在 frpc 的配置里加一条 TCP 转发（frp 0.52 以后的 toml 写法）：

```toml
[[proxies]]
name = "am"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8443
remotePort = 8443
# 把用户的真实 IP 传给 AM（配合面板里的"读取真实 IP"）
transport.proxyProtocolVersion = "v2"
```

然后：

1. 重启 frpc；云服务器控制台 → 防火墙 / 安全组，放行 TCP 8443（`remotePort`）。
2. 管理面板 → 概览，在入场券下面填**公网地址**：云服务器的 IP 加 `remotePort`，比如 `47.1.2.3:8443`。连接码会跟着变。
3. 面板 → 设置 → 打开"读取真实 IP（proxy protocol）"，保存后点"现在重启"。

注意："读取真实 IP"和 frp 的 `proxyProtocolVersion` 要么都开、要么都关。服务器只信任来自本机（frpc）的真实 IP 信息，外人伪造不了。

## 4. 邀请朋友

面板 → 概览 → **复制整段邀请文字**，发给朋友。里面有下载地址、连接码和一个邀请码。每个邀请码只能注册一个账号，用掉后点"再生成一个"。

邀请码页可以批量生成、加备注、作废没用过的码。用户自己在客户端里也能生成（默认每人 3 个，设置里可改）。

## 5. 用测试客户端试一下

1. 双击 `testclient.bat`，第一次会让你粘贴连接码（从面板复制）。
2. 输入一个配置名（比如 `alice`），然后：
   ```
   register 管理员邀请码 alice 你的密码 爱丽丝
   newinvite
   ```
3. 再开一个窗口，配置名填 `bob`，用新邀请码注册。之后：
   - bob：`add alice`
   - alice：`accept bob`，然后 `dm bob`，直接打字回车就是发消息
   - 建群：`group 群名 bob`；发图：`img D:\pic.png`；输入 `help` 看全部命令。

## 6. 日常管理

都在管理面板里：

- **用户**：封禁（对方立刻下线）、解封、重置密码（生成临时密码）、设为站点管理员、看登录记录。
- **删除记录**：被删除消息的原内容，默认保留 180 天后自动清除，只有你能看到。
- **操作记录**：所有管理操作，不能删除。
- **运行日志**：出问题时把这里的内容复制给开发者。
- **设置**：常用设置是表单；数据库、证书等高级设置在"直接编辑 config.toml"里。保存前会检查格式，写错不会保存，上一版存成 `config.toml.bak`。

## 7. 备份

面板 → 设置 → 退出 am-server，然后把 `config.toml` 和整个 `data\` 文件夹复制一份就是完整备份。

## 在 Linux 云服务器上跑

下载 `am-server-linux-amd64`：

```sh
chmod +x am-server-linux-amd64
./am-server-linux-amd64 -headless      # 第一次运行生成 config.toml 和 data/
./am-server-linux-amd64 panel          # 打印管理面板的登录链接
```

管理面板只监听服务器本机。在自己电脑上开 SSH 隧道后用浏览器打开上面的链接：

```sh
ssh -L 8444:127.0.0.1:8444 你的服务器
```

长期运行可以写成 systemd 服务（`WorkingDirectory` 指向放 config.toml 的文件夹，`ExecStart=... -headless`）。

## 人多了想换 PostgreSQL

1. 装好 PostgreSQL，记住 postgres 用户的密码。
2. 面板 → 设置 → 直接编辑 config.toml，把 `[database]` 里的 `driver` 改成 `"postgres"`，保存。
3. 双击 `postgres_setup_db.bat`，输入 postgres 密码，自动建好用户和库。
4. 面板里点"现在重启"。

（目前不会自动把 SQLite 里的数据搬到 PostgreSQL，换之前请先确认。）

## 常见问题

- **双击没反应**：看看托盘里是不是已经有 AM 图标（已经在运行）；或者用 `server_console.bat` 启动看日志。
- **面板显示"服务器没有启动成功"**：上面写了原因。最常见的是端口被占用，到设置里换一个监听端口，点重试。
- **客户端报 `fingerprint mismatch`**：`data\tls` 被删了导致证书重新生成。重新从面板复制连接码给大家。
- **外网连不上、本机能连**：检查 frpc 是否运行、安全组是否放行端口、公网地址填得对不对。
- **登录记录里 IP 全是 127.0.0.1**：没开"读取真实 IP"，见第 3 步。
- **忘了面板登录密钥**：用托盘图标打开会自动登录；或者打开 `data\admin_key.txt`。
