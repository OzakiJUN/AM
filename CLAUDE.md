# CLAUDE.md — working on AM

Read this first, then `docs/todo.md` (open requests), `docs/design.md` and
`docs/protocol.md`, then the module you are changing. Do not rely on chat history for design decisions:
the docs in this repo are the source of truth. When a decision changes,
update the docs in the same commit.

## How the owner (Weiqi) wants to work

- Talk in casual Chinese. Direct answers, no hedging.
- When a batch is done and checked, merge it into `main` yourself (PR, CI
  green, merge) — Weiqi 2026-11-01: "main你要合并的时候就自动合并".
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
- Music widgets (`song`, `playlist`) play sound files the owner uploaded
  (`media.IsAudio`, checked on save) or NetEase songs by id (links read by
  `server/internal/music`, covers copied into uploads; listeners stream from
  NetEase's outer url); the client has one app-wide player (`lib/player.ts`). The old NetEase `music` kind is still valid, just hidden.
- Stickers (docs/design.md §11): `server/internal/sticker` keeps each
  person's collection (`stickers`) and the shared library
  (`sticker_library` + `_files` + `_tags`): shared by default
  (`stickers.default_public`), one entry per picture (same SHA-256, or
  256-bit pHash within `stickers.dedupe_distance`: `match.go`, pure +
  tested), earliest uploader shown, tags per person; private stickers keep
  their own picture and tags. Admin hide / delete (evidence until
  `retention.evidence_days`, optional blocklist) in `library.go`, panel page
  `admin/stickers.go`. A sent sticker is an image with
  `ImageMsg.sticker_tags` (first 10 tags), which AIs read instead of the
  picture; library pictures can be sent without uploading. Client:
  `lib/stickers.ts`, `lib/stickerTags.ts` (tested), `app/Stickers.tsx`
  (「我的」 / 「大家的」); copying my stickers to my other servers in the
  background, paced by the receiving server (stickers.sync_kbps): `lib/stickerSync.ts` + `lib/stickerCopy.ts`
  (pure, tested).
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
- Plugins (docs/plugins.md, docs/design.md §10): NoneBot2 plugins run on the
  server as the built-in bot, one process (`server/internal/plugin`: `host.go`
  runs it and serves OneBot v11 forward WebSocket on loopback, `onebot.go`
  translates, `scan.go` reads settings / commands / requirements from source,
  `unpack.go` reads zips — the last three pure + tested; `service.go` upload /
  settings for the bot only, `RetireAIPlugins` drops AIs' old plugins once).
  Only site admins upload, in the panel (`admin/plugins.go`; runs at once).
  Their commands are the bot's (`helper.SetExternal`: in `ServerInfo.commands`
  and 指令查询; the bot stays quiet on them). New messages reach plugins
  through `plugin.Tap` (wraps the pusher of `message.Service`). Secret
  settings never go back. Client: no plugin UI; `lib/plugins.ts`
  `isPluginCommand` (pure, tested) keeps the runner off bot commands.
  Real NoneBot test: `AM_TEST_NONEBOT=1 go test -run TestPluginsRealNoneBot ./server/internal/e2e`.
- AI hosting (docs/design.md §10 托管): `server/internal/hosting` keeps
  requests (`ai_hosting`, providers encrypted with `data/hosting/key`), the
  panel approves (`admin/hosting.go`), and a manager runs `AM.exe --host
  <host.json>` per approved AI (server-minted AI session, loopback + pinned
  cert, restart with backoff). The client's host mode: Rust `lib.rs`
  (`host_config`, hidden window with its own WebView data dir, no single
  instance / tray / F12) → `lib/ai/host.ts` → runner `startHosted` (settings
  through `/api/v1/me/ai`); what it may do is `hostedSettings` in
  `lib/ai/hostMode.ts` (pure, tested: files only in its work folder).
  `account.OnAIRun` ends hosting when the owner runs the AI again.
- Built-in bot (docs/design.md §10 内置 bot): `server/internal/helper` makes
  one bot account with no owner (`server_settings.helper_user_id`; not
  counted, not put into public channels: `store.notServerBot`) and answers
  "/" commands from `message.OnSent` (`Match` / `Split` pure + tested); it
  invites itself into a channel on behalf of whoever sent the command.
  Features register commands with `helper.Register`; `ServerInfo.commands`
  lets AIs leave them alone. 游戏资讯 = `server/internal/news` (port of
  qqnews: `parse.go` / `rank.go` pure + tested, `sources.go` fetchers,
  `ai.go` OpenAI-compatible model + xAI, `service.go` state in
  `news_state`, subscriptions in `news_subs`, schedule, commands), config
  `[news]`; e2e `news_test.go` runs against fake sites (`SetRewrite`).
  The bot is in every channel (`conv.SetHelper`: added on creation, existing
  channels once via `HelperEverywhere`; never counted in member counts or
  limits, never inherits a channel). 指令查询 = `helper/help.go` (pure +
  tested: `Overview`, `Lookup`, difflib-like `Ratio`, `Suggest`, `Typo`;
  `Command.Safe` = a typo may just run it; `AIDrawing` mirrors nai.ts CMDS).
  电子厕所 = `server/internal/toilet` (`rules.go` pure + tested;
  `toilet_pits`, 16 shared pits, culprit from `ImageMsg.made_for`). Shared
  model `[helper] ai_*` (`helper.Ask`); news uses its own `[news] ai_*` or that.
  Site admins edit the bot like an owner edits an AI (`User.IsServerBot`,
  `UpdateAIProfile`, profile rights; client `HelperProfileDialog`). AIs use
  it through `POST /api/v1/helper/run` (`helper.RunFor`: no command posted;
  `show` or answers captured by a context sink) and the `use_helper` tool;
  `appPrompt` lists `GET /api/v1/helper/commands`.
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
  Servers are identified by certificate pin (address only when unpinned).
- Relay change (docs/design.md §3): the panel probes the new address
  (`admin/relay.go`: same cert + `ServerInfo.instance_id`), saves
  `server.public_address` live (`Runtime.SetPublicAddress`) and broadcasts
  `server_moved`; clients switch in `store.moveServer` only after the new
  address answers with the same pin, keep `oldAddresses` as fallbacks.
- Personalization (theme mode, accent, background, font scale, panel glass
  style / opacity / blur → CSS variables via `glassVars()` in `lib/theme.ts`)
  is per device in localStorage; workshop themes will set the same fields.
  Colours are picked with our own `ui/ColorPicker.tsx` (`ColorButton`), never
  `<input type="color">`.
- Desktop window: the close button hides to the tray by default (prefs
  `closeToTray` → Rust `set_close_to_tray`; tray menu in `lib.rs`), so AIs run
  by this device stay online.
- AI emotion keys and fallbacks are listed in docs/design.md §9; keep the
  client in sync with that table.
- AI accounts (docs/design.md §9): `account/ai.go` on the server (owner-only
  endpoints, settings JSON stored as is, `run` gives one device the AI's
  session). The client runs them in `lib/ai/runner.ts` (only on the device in
  `settings.runner`); providers / persona / mood parsing are pure and tested
  (`lib/ai/providers.ts`, `persona.ts`); model requests go through Rust
  (`src-tauri/src/ai_http.rs`, CA-checked HTTPS, not the pinned AM
  connection); keys: `lib/ai/keys.ts` (one credential-store entry per key,
  synced in the encrypted device state). `TextMsg.mood` is kept only for
  ai / bot senders; `splitMoodTag` accepts the tag anywhere, full-width
  brackets and synonyms (`moodKey`). A bot / AI's profile page is its owner's
  to edit; deleted ones have `User.gone` and drop out of the lists.
- AI operating the computer (docs/design.md §9 操作电脑): tool calling for the
  three providers in `providers.ts` (`AgentMsg`, `ToolCall`, streamed
  arguments); tool list + permission categories in `lib/ai/agent.ts` (pure,
  tested); execution in `lib/ai/tools.ts` → Rust `src-tauri/src/agent.rs`
  (file tools re-check the work folders; Windows-only screen / input deps
  behind `cfg(windows)`); the loop is `reply()` in `runner.ts`; asks, the
  status bar, F12 stop and the action log are `lib/ai/agentState.ts` +
  `app/AgentHost.tsx`. Never run a tool the permission level says no to.
  2b: UI Automation `src-tauri/src/uia.rs` (Windows only, acts by number +
  name check), the AI's own browser `browser.rs` (Edge / Chrome with its own
  profile, DevTools protocol; test with `AM_BROWSER=<chrome> AM_BROWSER_HEADLESS=1
  cargo test`), MCP stdio client `mcp.rs` (servers in `computer.mcp`, tools
  named `mcp__<server>__<tool>`, category `mcp`). New tool categories need
  `ToolCategory`, `DEFAULT_LEVELS` and `CATEGORY_LABEL`. Tools flagged `own`
  (self / social: its status, bio, page note, channels, messaging the owner)
  run through `SelfApi` in the runner and work with the computer off.
- AI in channels and its day (docs/design.md §9 频道和作息): when to speak,
  the day plan, `[status:…]` / `[skip]` parsing are pure in `lib/ai/social.ts`
  (tested); the runner debounces channel turns (`considerChannel`), ticks the
  routine every 30 s, prompts in `persona.ts` (`channelPrompt`,
  `routinePrompt`). @-mentions: `lib/mentions.ts`. Portrait pokes hit-test the
  picture's alpha (`hitPortrait`) and send "[戳一戳] …".
- AI batch 3: silent persona evolution (`maybeEvolve` in runner, pure helpers
  `evolvePrompt` / `parseEvolved` / `adoptPersona`), offline `catchUp`,
  shared AI rooms (`Conversation.ai_id`, `POST /api/v1/ai/{id}/room`, listed
  on the AI page via `botOf`), and someone else's AI on my computer: the
  server only relays (`server/internal/remote`, gateway `remote_tool*`
  frames); this device decides with `lib/ai/remote.ts` (local, per AI, off
  by default, every raise warns).
- AI wrap-up (docs/design.md §9): share requests (`ai_share_requests`,
  `account.RequestShare` / `TakeShareRequest`, push `ai_share_request`;
  approving joins / creates the AI's room); "添加 bot" in channel headers
  lists only my AIs; games are MCP templates only (`GAME_TEMPLATES` in
  `agent.ts`: Minecraft via minecraft-mcp-server, RimWorld via RIMAPI +
  RimAPI_MCP_Server; `McpServer.env` / `trusted`); balances in
  `providers.ts` (`balanceQuery` / `parseBalance`, pure) + `lib/ai/balance.ts`
  (reminder), fetched through Rust `ai_get`; an AI's own portrait pack in
  `portrait_packs` (`User.portraits_at` = cache version, `ownPack` needs
  `neutral`, `usePortraitPack` in `app/Portrait.tsx`); voice input is only
  the `SpeechInput` slot in `lib/voice.ts` (null implementation).
- Board games + workshop (docs/design.md §13; 数字迷踪 = `game/trail.go`, our
  own design — never clone a published game): the server holds each game
  as one JSON row (`games`, locked while changed) and checks the rules in
  `server/internal/game` (`rules.go` pure + tested; `View` hides secret
  words; push `game` per viewer); client `lib/games.ts` (pure, tested: coords,
  board text for AIs, `gomokuMove` fallback), `app/Games.tsx` (header button,
  game strip, window), `app/Workshop.tsx`. AIs join / open /
  play through tools in category `games` (`gameTool`, `onGame`, `gameTurn`
  with a fallback move in runner.ts; `wantsToJoin` in social.ts).
- Creative workshop (docs/design.md §13): the index lives in the GitHub repo
  OzakiJUN/am-workshop (items/*.json, its own Go checker + Actions; signed
  `index.json` on its `index` branch, Ed25519, private key only in its
  Secret `WORKSHOP_SIGNING_KEY`, made by `am-server workshop-keygen` /
  `workshop_keygen.bat`). Client: `lib/workshopIndex.ts` (signature with
  `WORKSHOP_PUBLIC_KEY`, versions, mirror; pure + tested),
  `lib/workshopPackage.ts` (unzip with fflate + the same package rules as
  am-workshop's `format.go`; pure + tested — change both together),
  `lib/workshopStore.ts` (IndexedDB), `lib/workshop.ts` (install / update /
  sideload / apply), downloads through Rust `web_get_bytes`. Only data works
  for now (theme, portrait, persona, stickers); program works need a sandbox first.
- Channel museum (docs/design.md §13 博物馆): `server/internal/museum`
  (`rules.go` pure + tested: 8-place first hall, queue jump, swap, second
  hall ranking, titles; `museum.go` votes when members > `museum.min_members`,
  settled every 10 s, `sys_museum` events). Art media is readable by channel
  members, or by everyone for public channels (`CanAccessMedia`), and never
  GC'd. `ImageMsg.made_with` / `nsfw` are kept only for bot / ai senders.
  Client: `app/Museum.tsx` (header button, window, 「挂到博物馆」 dialog).
- NetEase songs in the desktop app play from `ammusic://<id>` served by Rust
  (`src-tauri/src/music.rs`: NetEase headers, follows the CDN redirect,
  in-memory cache, Range); browser dev mode uses the outer url directly.
- AI memory / initiative (docs/design.md §9): every reply's system prompt
  has `appPrompt` (what AM offers: tools + installed plugins) and
  `elsewherePrompt` (last 12 h of all its chats + its games); `proactive` in social.ts (hello / status / quiet topics, tick every
  30 s); its own page through `view_my_page` / `edit_my_page`
  (`lib/ai/page.ts`, pure + tested). Game turns are `silent` replies (tools
  only); one remark after the game. Games: `rematch`, history (`?ended=1`,
  `retention.games_days`).
- Drawing (docs/design.md §10 画画, NovelAI only) is the built-in bot's:
  `server/internal/draw` (`nai.go` pure + tested: options, rules, payload,
  answers; `images.go`; `service.go`), one server key in `[draw]`, commands
  /nai /nai5 /角色参考 /风格迁移 /放大 /查标签 /nai余额, 「用我的头像」 = the
  asker's avatar as the character reference. AIs draw with `draw_picture`
  → `drawCommandFor` (agent.ts, pure + tested) → `helper/run` with show; in
  an AI's DM the bot speaks as the AI (`helper.Speaker`). The client has no
  NovelAI code any more (old `novelai` providers only load). Channels have
  `conversations.nsfw`, set per channel in the admin panel only
  (`conv.SetNsfw`, recorded as said by the built-in bot); minors are never drawn.
- AI memory (docs/design.md §9 一个记忆): `lib/ai/memory.ts` (pure, tested:
  per-person notes by account id, events, known plugins, 28 KB cap) stored as
  the AI account's own client state; `rememberNow` (runner) updates it in batches with a persisted per-chat cursor; every reply gets `whoPrompt` (who is talking,
  owner / AI, recognise by account), `memoryPrompt`, and `elsewhere` (all
  chats incl. private ones, last 12 h). Installed workshop items live in
  `lib/workshop.ts` (`useWorkshop`); `syncPlugins` teaches them to running AIs.
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
- Updates (docs/release.md, docs/design.md §3): every GitHub release has a
  signed `release.json` (Ed25519; `internal/release` + `client/src/lib/release.ts`,
  both pure + tested — change together; key from `am-server release-keygen`,
  private key only in the Secret RELEASE_SIGNING_KEY). Releases come from the
  `release` workflow (workflow_dispatch, version checked in package.json /
  tauri.conf.json / Cargo.toml / CHANGELOG, builds via `build.yml`, signs with
  `tools/release`). Weiqi says 「发版」 → bump the versions + CHANGELOG in a PR,
  merge, run `release`. The server updates itself (`server/internal/update`,
  beside the supervisor: check, panel 更新 page, `update.auto` at night,
  replace exe + relaunch in `main.go`), keeps the client installer
  (`/api/v1/update/*`, `ServerInfo.client_version`, push `client_update`);
  the client checks GitHub too (`lib/update.ts`, Rust `update.rs` downloads +
  checks SHA-256 + runs `AM-setup.exe /P /UPDATE /R`). No UI hot update.
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
