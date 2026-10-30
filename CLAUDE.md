# CLAUDE.md — working on AM

Read this first, then `docs/todo.md` (open requests), `docs/design.md` and
`docs/protocol.md`, then the module you are changing. Do not rely on chat history for design decisions:
the docs in this repo are the source of truth. When a decision changes,
update the docs in the same commit.

## How the owner (Weiqi) wants to work

- Talk in casual Chinese. Direct answers, no hedging.
- **Propose a plan and wait for confirmation before changing code.** Batch
  small changes for the next update instead of pushing them one by one.
- When handing over files, give complete files, not patches.
- Every tunable goes in a config file (`config.toml`, `testclient.toml`),
  never "edit this line in the code".
- Windows `.bat` files: English only, no Chinese characters (encoding
  breaks). Keep CRLF (enforced by `.gitattributes`).
- Verify before stating things (look it up / run it). He cannot always tell
  outdated or wrong information apart.
- Update `CHANGELOG.md` with every user-visible change.

## Architecture rules

- One Go module at the repo root (`github.com/OzakiJUN/am`).
- `server/internal/store` is the **only** package that runs SQL. Other
  modules call store methods.
- Two databases behind the same store methods: SQLite (default, pure-Go
  `modernc.org/sqlite`, no cgo) and PostgreSQL (`pgx` stdlib). Write SQL with
  `?` placeholders and portable syntax (`rebind()` converts for PostgreSQL);
  use `inList()` instead of arrays and `forUpdate()` for row locks.
- Schema changes = a new `NNNN_name.sql` in BOTH `store/migrations/postgres/`
  and `store/migrations/sqlite/` (never edit a released migration). Statements
  end with `;` at line end; no `;` inside literals.
- SQLite runs on ONE connection. Inside `Store.InTx(func(q))` use only `q`:
  calling `s.st.X()` there deadlocks. Read rows fully before running another
  query.
- Modules (`account`, `conv`, `message`, ...) never import `gateway`; they
  push to users through the `push.Pusher` interface.
- Client-visible errors are `apperr` values with stable codes; list new
  codes in `docs/protocol.md`.
- Protocol changes start in `proto/am/v1/*.proto`, then `buf generate`.
  Generated code in `gen/` is committed and CI checks it is current.
  Only add fields; never renumber or reuse field numbers.
- Events are append-only. "Strike" and "admin delete" are new events that
  point at the target. Users can never delete. Admin delete hides the content
  from all users but moves it into an admin-only evidence store, kept for a
  configurable period (default 6 months) and then purged automatically —
  required so deletions never destroy evidence (see docs/design.md §14).
- Login records (time, IP, device) are kept at least 6 months.
- No "overseas mode" switch in the client. An international version, if ever,
  is a fully separate deployment.
- Account type (human / bot / ai) and owner are set by the server only.
- Presence lives in `server/internal/presence` (the gateway calls Connect /
  Disconnect). Invisible users look offline to everyone except themselves
  and their own bot / ai accounts (their AI may give them away: intended).
  Invisible + activity are saved in `users`.
- Leaving a server (`account.Leave`, `POST /api/v1/me/leave`) marks the
  account left (`users.left_at`), logs it out everywhere and takes it out of
  every channel (`conv.LeaveAll`: owned channels pass on or are dissolved).
  Left accounts are treated like banned ones in lists / DMs (`User.Gone()`);
  logging in again needs an unused invite code (`LoginRequest.invite_code`).
- Profile pages (a user's / the server's) are widget boards:
  `server/internal/profile` validates layouts (`validate.go`: kinds, sizes,
  board bounds, config limits), checks rights field by field against the
  previous version, and stores every save as a new version
  (`profile_layouts`, purged after retention). Widget media goes in
  `profile_media` (visible to everyone, kept by media GC). Keep the kind list
  in `validate.go`, `client/src/lib/widgetKinds.ts` and docs/protocol.md in sync.
- Server profile settings (description, widget permissions) live in the
  `server_settings` table and are edited in the panel (no restart); the icon
  is `data/media/server_icon.png` via the `media` package.
- `am-server` = `supervisor` (restartable chat-server loop, the admin panel
  stays up even when the server fails to start) + `admin` (embedded panel on
  `admin.listen`, loopback by default, key in `data/admin_key.txt`) +
  `desktop` (tray, panel window, browser, autostart, message box; Windows-only code behind
  build tags, no cgo). The Windows build uses `-H=windowsgui`; output goes to
  the log sink (file + panel ring), and to the console only when one exists.
- The admin panel UI is plain HTML/CSS/JS in `server/internal/admin/web`
  (no build step, no external requests, CSP `self`). Build DOM with `el()`,
  never `innerHTML` with server data. Panel JSON sends int64 ids as strings.
  The panel API is internal (not in protocol.md); settings it may edit are
  whitelisted in `admin/api.go` and written with `config.Apply` (keeps comments).
  The panel can read every channel's history (read-only, `channel_view` in the
  audit log) but never DMs, and serves media only from channels, avatars and
  evidence (`store.PanelCanSeeMedia`).
- Site-admin actions (ban, reset password, revoke invites) live in
  `account/admin.go` and write the audit log; actor 0 = admin panel.
- Discord-style servers: there are NO friends. Anyone on a server can DM
  anyone (unless blocked; blocks stop DMs both ways). Groups are "channels"
  in the UI: public (site admins create; everyone joins, new accounts join
  automatically via `conv.Welcome`) or private (invite only). The first
  admin gets `server.default_channel`. Friend messages stay in the proto only
  so their numbers are never reused.

## Client rules (`client/`)

- Tauri 2 + React 19 + TS + Vite + Tailwind 4 + motion + zustand; own UI kit in
  `client/src/ui` (no component library). Dependencies are pinned to exact
  versions. `client/go.mod` only stops `go ./...` from walking into it.
- In the desktop app ALL network traffic goes through Rust
  (`src-tauri/src/net.rs`, pins the cert from the join code); the UI calls it
  via `src/lib/transport.ts`. Media is served through the `ammedia://` scheme.
  Browser mode (`npm run dev` / `vite preview`) exists only for development
  and e2e: Vite proxies `/api` and `/ws` to `AM_DEV_SERVER` (tls.mode off).
- Protocol code for TS is generated into `client/src/gen` by `buf generate`
  (needs `npm ci` in client first); commit it, CI diffs it.
- The join code format is implemented twice (`internal/connectcode` and
  `client/src/lib/joincode.ts`); keep them byte-identical — the TS test uses
  vectors printed by `AM_PRINT_VECTORS=1 go test ./internal/connectcode`.
- UI style follows NapCatQQ: glass cards with shadow, hover lifts / press
  sinks (`card`, `lift`, `press` utilities), non-linear easing only
  (`--ease-out`, `--ease-spring`, motion springs). Never linear animations.
- Every action that waits for the server shows a loading state and can't be
  clicked twice: return the promise from `Button` / `IconButton` onClick,
  `Toggle` onChange or a `MenuItem` (give menu items a `key` with the target);
  use `ask({ run })` for confirm-then-act; `loading` prop for form submits.
- Pages: 频道 (groups), 私信 (DMs), AI (DMs with bot / ai accounts), and at
  the bottom of the nav 账号设置 (`Account.tsx`: name, avatar, bio, status +
  invisible in `MyStatus.tsx`, sync, devices), 设置, and the avatar →
  个人主页 (`Profile.tsx`, display only).
  `convPage()` decides where a conversation lives; `openConv()` routes to it.
- Widget boards: grid logic is pure and tested (`lib/widgets.ts`); the board
  UI is `app/widgets/` (Board, Kinds, Editor, Guestbook). External embeds
  (NetEase player) load only after a click and need a CSP `frame-src` entry.
- The conversation list and the member list fold into avatar strips
  (`app/Fold.tsx`, prefs `listFolded` / `membersFolded`). Presence is
  `SessionView.presence`; `UserAvatar presence` shows the dot top-right
  (activity emoji, or a white check when just online; plain dot under 28px).
  Pin / do-not-disturb are my own per-conversation settings on the server
  (`self.pinned_order` / `dnd_until`, -1 = until turned off); list order is
  `byListOrder`, DND convs don't notify and don't count in `unread()`.
  Dialogs render through a portal (glass panels' backdrop-filter would trap
  fixed overlays).
- AI portraits: packs map emotion keys to images (`lib/portraits.ts`, pure
  and unit-tested; default pack in `assets/portraits/default`). The portrait
  floats in the AI chat without covering messages; position is a per-device
  pref (`lib/prefs.ts`).
- One person, many servers (docs/design.md §7 资料同步): each server has its
  own account; the client copies my profile (name, avatar, bio, invisible /
  activity, profile board + its pictures) between them. Engine is pure and
  tested (`lib/profileSync.ts`); `lib/sync.ts` queues changes (persisted,
  debounced by prefs `syncDelay`, newest wins) from `Session.onOwnChange`;
  writes made by the sync pass `quiet = true` so they don't echo. New
  profile fields must be added to the sync too.
- The saved login (`lib/identity.ts`): username in localStorage, password in
  the OS credential store via Rust (`src-tauri/src/secrets.rs`, Windows
  Credential Manager). Never put secrets in localStorage outside browser dev mode.
- Several devices (docs/design.md §7 多设备): a human account is logged in on at
  most `limits.max_devices` devices (bots / AI don't count; `too_many_devices`
  on login, making or redeeming a pairing code). "添加新设备" = one-time
  tickets (`POST /api/v1/pair`) + an AES-GCM bundle whose key is only in the
  `AMP-` pairing code (`lib/paircode.ts`, client-only format). My server list
  is synced between my devices as encrypted client state on every server
  (`lib/devices.ts`, merge logic in `lib/deviceState.ts`; the vault key lives
  in the OS credential store). The server never sees the keys or contents.
- Personalization (theme mode, accent, background, font scale) is per device
  in localStorage; workshop themes will set the same fields.
- AI emotion keys and fallbacks are listed in docs/design.md §9; keep the
  client in sync with that table.
- Checks: `cd client && npm run typecheck && npm test && npx vite build`;
  e2e: `client/e2e/e2e.mjs` (see client/README.md).

## Commands

```sh
buf lint && buf generate            # after editing proto (needs buf + protoc-gen-go)
go vet ./...
go test -race ./...                 # e2e tests run on SQLite always
AM_TEST_DATABASE_URL="postgres://...:5432/am_test?sslmode=disable" go test -race ./...   # + PostgreSQL
go run ./server/cmd/am-server -headless   # creates config.toml on first run; prints the panel URL
go run ./server/cmd/am-server panel       # print the admin panel login URL
go run ./server/cmd/am-server setup-db
go run ./tools/testclient -profile alice
cd client && npm ci && npm run dev       # client in a browser (needs AM_DEV_SERVER, see client/README.md)
cd client && npx tauri dev               # desktop client
```

The end-to-end tests (`server/internal/e2e`) run every scenario on SQLite and,
when AM_TEST_DATABASE_URL is set, on PostgreSQL — wiping that database's
schema. Never point it at a real database.

## Product / deployment facts

- AM is distributed as software: users self-host `am-server` and connect
  clients by address/domain or a connection code. Only the official creative
  workshop (separate service, later) talks to the owner's servers; approved
  workshop items are signed, sideloading is allowed with warnings.
- Client updates come from GitHub Releases, not from self-hosted servers.
- The owner's own server runs on his Windows PC (i5-13600) behind CGNAT,
  exposed through frp on an Alibaba Cloud 5 Mbps relay; frp sends proxy
  protocol v2, `server.proxy_protocol = true` (trusted from localhost only).
- Servers use a bare IP + self-signed certificate; clients pin it (the pin
  is in the join code). A real certificate (`tls.mode = "files"`) is
  optional for self-hosters; nothing in the plan depends on a domain.
- No Redis in stage 1 (single server, Windows). Add it when there is more
  than one gateway.
- Relative paths in config.toml resolve against the config file's folder
  (am-server chdirs there). On Windows the default config is next to the exe.
- Join codes (`AM1-...`: address + cert pin + optional invite, obfuscated;
  QR = `<download_url>#join=<code>`) are defined in `internal/connectcode`
  and documented in docs/protocol.md. Every account gets `invites.per_user`
  invite codes automatically at registration; the admin panel never creates
  invites (view / revoke only).
- No official server, no ICP filing: we only distribute tools. The workshop
  will live on GitHub (index repo + authors' releases). No pure web client.
- The admin panel opens in its own window: a child `am-server window`
  process using WebView2 (`desktop.RunPanelWindow`), browser as fallback.
- Portrait images from generators: clean them with
  `python3 scripts/portraits/clean_pack.py <in> <out>` (outline only, lossless WebP).
- Icons (client pink / lavender, server mint / blue with a server badge) are
  generated by `python3 scripts/icons/make_icons.py`; never hand-edit the PNG / ICO files.
- Uploaded media lives under `data/media` (content-addressed by SHA-256);
  all file access goes through the `media` package so moving to object
  storage + CDN later touches only that package.
