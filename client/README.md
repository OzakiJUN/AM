# AM 客户端

Tauri 2 + React 19 + TypeScript + Vite + Tailwind CSS 4。先做 Windows，安卓以后用同一份代码。
设计说明见 [docs/design.md](../docs/design.md) 第 5 节。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/ui` | 自己写的界面组件（按钮、输入框、弹窗、菜单、提示……）和动画参数 |
| `src/app` | 各个页面：欢迎 / 注册、频道和私信列表（`ConvList`）、聊天、频道管理（`Group`、`Channels`）、成员和屏蔽（`People`）、AI 栏和立绘（`AI`、`Portrait`）、我、设置 |
| `src/lib` | 会话与同步（`session.ts`）、全局状态和页面路由（`store.ts`）、联网（`transport.ts`）、加入码、主题、AI 立绘包（`portraits.ts`）、本机偏好（`prefs.ts`） |
| `src/assets/portraits/default` | 默认 AI 立绘包（每种情绪一张 WebP，文件名 = 情绪名） |
| `src/gen` | `buf generate` 生成的协议代码，不要手改 |
| `src-tauri` | Rust 外壳：联网与证书指纹校验（`src/net.rs`）、`ammedia://` 媒体协议、命令 |
| `e2e` | 双用户端到端测试脚本（Playwright） |

## 开发

需要 Node 22+；打包桌面版还要 Rust（stable）和对应平台的 Tauri 依赖（Windows 自带 WebView2）。

```sh
npm ci
```

### 浏览器里调界面（最快）

浏览器没法按指纹信任自签证书，所以开发时让本机的 am-server 关掉 TLS，Vite 把 `/api`、`/ws` 转发过去：

1. 准备一个测试用 config.toml，`[tls]` 里写 `mode = "off"`，`server.listen` 比如 `127.0.0.1:8443`。
2. `go run ./server/cmd/am-server -headless -config 路径/config.toml`
3. `AM_DEV_SERVER=127.0.0.1:8443 npm run dev`，打开 http://localhost:1420
4. 管理员加入码：`go run ./server/cmd/am-server panel -config 路径/config.toml` 打印面板链接，在面板概览里复制。

想试跨服务器的功能（资料同步）就再起一个关掉 TLS 的服务器（端口不同，比如 `127.0.0.1:8453`），并设 `AM_DEV_SERVER2=127.0.0.1:8453`：加入码里是这个地址的服务器走 `/s2/api`、`/s2/ws`。这个变量在构建时写进页面，`vite build` + `vite preview` 时两步都要带上。

### 桌面版

```sh
npx tauri dev                    # 开发（热更新）
npx tauri build --bundles nsis   # 打包：src-tauri/target/release/am-client.exe 和 bundle/nsis/*-setup.exe
```

桌面版所有请求都走 Rust，连正常的（自签证书）服务器即可，不需要关 TLS。

## 检查

```sh
npm run typecheck
npm test          # 加入码编解码（和 Go 版同一组测试向量）、立绘包的情绪替代规则、状态文字、小组件格子排布、资料同步、登录码和加密、服务器列表合并、AI 服务商请求和流式解析、人格和情绪标签
npx vite build
cd src-tauri && cargo test
```

Rust 联网的真实连接测试（可选）：`AM_TEST_SERVER=127.0.0.1:8443 AM_TEST_PIN=<面板里证书指纹的十六进制> cargo test -- --nocapture`。

改了 proto 以后在仓库根目录跑 `buf generate`（要先 `npm ci`，因为它用 `node_modules/.bin/protoc-gen-es`），生成的 `src/gen` 要一起提交，CI 会检查。

## 端到端测试

起一个全新的、关掉 TLS 的 am-server（同上），然后：

```sh
npm i --no-save playwright && npx playwright install chromium
npx vite build && AM_DEV_SERVER=127.0.0.1:8443 npx vite preview --port 4173 &
AM_E2E_JOIN=<管理员加入码> AM_E2E_IMAGE=任意图片.png AM_E2E_OUT=/tmp node e2e/e2e.mjs
```

脚本用两个账号走一遍：加入码注册、剪贴板识别、默认频道「大厅」、成员列表发私信、私信文字和图片、屏蔽 / 取消屏蔽、建私密频道、划掉、个性签名、在线状态和"正在听歌"、隐身、收起左右边栏、浏览公开频道、服务器主页、退出服务器再用新邀请码回来，重新登录用保存的密码、用登录码添加新设备（服务器列表、密码、设置都带过去，登录码只能用一次），每步截图到 `AM_E2E_OUT`，失败时截 `e2e-fail-*.png`，最后打印 `E2E OK`。

再起第二个全新的服务器、构建和预览时都带上 `AM_DEV_SERVER2`，并设 `AM_E2E_JOIN2=<第二个服务器的管理员加入码>`，脚本还会测资料同步：用「用我的资料」加入第二个服务器（不用输密码），检查签名、状态、主页都复制过去了，再在第二个服务器改签名，等它同步回第一个；配对过的新设备会收到「你在另一台设备上加入了」，点加入用保存的密码登录。

设了 `AM_E2E_ADMIN`（服务器 1 的面板地址，如 127.0.0.1:8444）、`AM_E2E_ADMIN_KEY`（它的 data/admin_key.txt）和 `AM_E2E_MOVE_TO`（能连到服务器 1 的另一个地址，如 localhost:8443）时，还会在面板里换中转地址，检查客户端自动切过去、照样能聊。

最后测 AI：脚本自己起一个假的模型服务（OpenAI 兼容、流式，端口 `AM_E2E_MOCK_PORT`，默认 8460），新建 AI、添加服务商并测试、选模型、聊一句，检查回复一个字一个字出来、情绪标签不显示。不需要真的 key。
