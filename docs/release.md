# 发版和自动更新

设计见 [design.md 第 3 节「更新」](design.md)。这里写清楚怎么发版、更新是怎么走的、钥匙放在哪。

## 一次性准备：发布签名钥匙（Weiqi 做一次）

每个版本都用一把 Ed25519 私钥签名。am-server 和客户端里内置对应的公钥，验签对不上就不装。所以无论安装包是从 GitHub、镜像还是别人的服务器下载的，都改不了。

1. 在自己电脑上，进 am-server 所在的文件夹，双击 `release_keygen.bat`（或者运行 `am-server release-keygen`）。
2. 生成的 `release_signing_key.txt` 是**私钥**。把里面的内容粘贴到 GitHub：AM 仓库 → Settings → Secrets and variables → Actions → New repository secret，名字填 `RELEASE_SIGNING_KEY`。粘完就把这个文件删掉。私钥不要发给任何人，聊天里也不要发。
3. 屏幕上打印的**公钥**（也存在 `release_public_key.txt` 里）发给 Claude。它会写进 `internal/release/release.go` 的 `PublicKey` 和 `client/src/lib/release.ts` 的 `RELEASE_PUBLIC_KEY`。
4. 公钥合进 main 之前，打出来的版本都不能自动更新：面板和客户端会显示「这个版本没有内置发布公钥」。

**换钥匙**：老版本只认老公钥。所以换钥匙之后，用户得手动下载一次新版，之后才能继续自动更新。私钥一旦泄露就必须换。

## 发版（Weiqi 说「发版」时 Claude 做）

1. 定版本号 `X.Y.Z`（先 `0.x`；只修 bug 动最后一位，加功能动中间一位）。
2. 一个 PR 里改这些：
   - `client/package.json`、`client/src-tauri/tauri.conf.json`、`client/src-tauri/Cargo.toml`（还有 `Cargo.lock`）里的版本号都改成 `X.Y.Z`。
   - `CHANGELOG.md` 里的「## 未发布」改名为「## X.Y.Z（日期）」，上面再加一个空的「## 未发布」。
3. PR 的 CI 绿了就合并进 main。
4. 在 GitHub Actions 里运行 **release** 工作流，`version` 填 `X.Y.Z`。Claude 可以直接触发；Weiqi 也可以在 Actions 页面 → release → Run workflow 手动跑。它会依次：
   - **检查**：只能从 main 发；三个文件里的版本号都要是 `X.Y.Z`；CHANGELOG 里要有这一节；公钥已经内置；这个 tag 还没用过。
   - **构建**：跑和 CI 一样的构建（`build.yml`），版本号写进 am-server（`-X main.version`）和客户端（`AM_VERSION`）。
   - **签名**：`tools/release` 给所有文件算大小和 SHA-256，备注取 CHANGELOG 里这一节，生成 `release.json`，再用 `RELEASE_SIGNING_KEY` 签出 `release.json.sig`。如果签名钥匙和内置公钥对不上，直接失败。
   - **发布**：打 tag `vX.Y.Z`，建 GitHub Release，把所有文件都传上去：`am-windows-amd64.zip`、`am-server-windows-amd64.exe`、`am-server-linux-amd64`、`AM.exe`、`AM-setup.exe`、`release.json`、`release.json.sig`。版本号带 `-`（比如 `0.3.0-beta.1`）的算预发布版，「latest」不指向它，所以不会推给大家。

## 服务器怎么更新（`server/internal/update`）

- **检查**：am-server 每 `update.check_hours` 小时（默认 6）读一次 `https://github.com/<repo>/releases/latest/download/release.json` 和 `.sig`。GitHub 连不上就挨个试 `update.mirrors`（默认 `https://ghfast.top/`，加在 GitHub 地址前面）。读到后先验签。
- **一键更新**：管理面板「更新」页显示现在的版本、最新版本和更新说明，点「更新到 X.Y.Z」开始：
  1. 下载这个系统的 am-server（`am-server-windows-amd64.exe` 或 `am-server-linux-amd64`），核对大小和 SHA-256。
  2. 换掉正在运行的那个。Windows 上先把 `am-server.exe` 改名成 `.old`（正在运行的 exe 可以改名，不能删），再把新的放进来，下次启动时删掉 `.old`。Linux 上直接改名覆盖。
  3. 停掉所有东西再启动新版本。Windows 上启动一个新进程（带 `-autostart`，不会再开一个面板窗口；已经开着的面板窗口会重新连上）。Linux 上用 exec 原地替换，进程号不变，systemd 不受影响。
  4. 在线的人会断开几秒，然后客户端自动重连。
- 更新器挂在 supervisor 旁边，不在聊天服务器里面，所以聊天服务器启动不了的时候也能更新。
- **夜里自动更新**：设置里打开 `update.auto` 后，有新版时会在 `update.auto_at`（这台电脑的时间，默认 04:00）之后的一小时内自己更新，每天最多试一次。
- 不能一键更新的情况（面板会写原因）：没内置公钥、开发时用 `go run` 跑的、这个系统没有现成的包，或者 am-server 所在的文件夹不能写。
- **客户端安装包**（只存安装包，免安装版从 GitHub 或镜像下载）：服务器运行的版本已经是最新版、并且开着 `update.keep_client` 时，会把这个版本的 `AM-setup.exe` 连同 `release.json` 和 `.sig` 存到 `data/update/`（同样验过）。然后在 `ServerInfo.client_version` 里报出这个版本，并向在线的人推 `client_update`。

## 客户端怎么更新（`client/src/lib/update.ts`、`src-tauri/src/update.rs`）

- **什么时候检查**：桌面版启动 20 秒后检查一次，之后每 6 小时一次（设置 → 关于与更新 →「自动检查新版本」，默认开）。服务器说它存着更新的客户端时（`client_version` / `client_update`），也会去读那台服务器存的清单。所有清单都先用 `RELEASE_PUBLIC_KEY` 验签。
- **提示**：有新版时弹一次提示，左边「设置」图标上挂一个红点。设置 →「关于与更新」里能看到更新说明，点「下载并安装」。
- **两种 AM**：安装版（安装程序装的，程序旁边有 `uninstall.exe`）和免安装版（`AM.exe` 放在哪都能直接运行，Weiqi 和朋友们现在用的就是这种）。`update.rs` 的 `mode()` 就是看有没有 `uninstall.exe` 来判断的。
- **下载**：安装版下 `AM-setup.exe`，免安装版下 `AM.exe`（两个都在 Release 里，都列在签过名的清单里）。Rust 按顺序试 GitHub、镜像，最后是存着这个版本的服务器（走固定证书的连接；服务器只存安装包）。下载时核对大小和 SHA-256，对不上就换下一个来源。
- **安装版**：运行 `AM-setup.exe /P /UPDATE /R`（只显示进度、按更新安装、装完重新打开 AM），然后 AM 自己退出。安装程序是装给当前用户的，不弹管理员权限确认。
- **免安装版**：先把正在运行的 `AM.exe` 改名成 `AM.exe.old`（Windows 允许给正在运行的 exe 改名，不能删），再把新的复制到原来的位置，名字不变。然后启动新的，旧的退出。新的会先等旧的退出完（不然单实例检查会把它交给旧的），再删掉 `AM.exe.old`。放进新版失败时会把旧的改回来。放在不能写的文件夹里（比如 `C:\Program Files`）就会报错，请用户手动换。两种版本的登录和设置都存在同一个地方（应用数据目录、系统凭据管理器），换完不用重新登录。
- 浏览器开发模式、托管模式（`--host`）、开发版（版本号不是 `X.Y.Z` 这种）都不自动更新。
- 不做界面热更新，每次都是完整安装包（Weiqi 2026-11-02 定的）。
