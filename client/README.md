# AM 客户端

Tauri 2 + React 19 + TypeScript + Vite + Tailwind CSS 4。先做 Windows，安卓以后用同一份代码。
设计说明见 [docs/design.md](../docs/design.md) 第 5 节。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/ui` | 自己写的界面组件（按钮、输入框、弹窗、菜单、提示……）和动画参数 |
| `src/app` | 各个页面：欢迎 / 注册、会话、聊天、群、联系人、我、设置 |
| `src/lib` | 会话与同步（`session.ts`）、全局状态（`store.ts`）、联网（`transport.ts`）、加入码、主题 |
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

### 桌面版

```sh
npx tauri dev                    # 开发（热更新）
npx tauri build --bundles nsis   # 打包：src-tauri/target/release/am-client.exe 和 bundle/nsis/*-setup.exe
```

桌面版所有请求都走 Rust，连正常的（自签证书）服务器即可，不需要关 TLS。

## 检查

```sh
npm run typecheck
npm test          # 加入码编解码，和 Go 版用同一组测试向量
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

脚本用两个账号走一遍：加入码注册、剪贴板识别、加好友、私聊文字和图片、建群、划掉，每步截图到 `AM_E2E_OUT`，最后打印 `E2E OK`。
