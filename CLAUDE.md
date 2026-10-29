# CLAUDE.md — working on AM

Read this first, then `docs/design.md` and `docs/protocol.md`, then the
module you are changing. Do not rely on chat history for design decisions:
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

## Commands

```sh
buf lint && buf generate            # after editing proto (needs buf + protoc-gen-go)
go vet ./...
go test -race ./...                 # e2e tests run on SQLite always
AM_TEST_DATABASE_URL="postgres://...:5432/am_test?sslmode=disable" go test -race ./...   # + PostgreSQL
go run ./server/cmd/am-server       # creates config.toml on first run
go run ./server/cmd/am-server setup-db
go run ./tools/testclient -profile alice
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
- Stage 1 uses a bare IP + self-signed certificate; clients pin the SHA-256
  fingerprint printed at startup. A domain needs ICP filing (备案) in
  mainland China, planned later; switching only changes client config and
  `tls.mode = "files"`.
- No Redis in stage 1 (single server, Windows). Add it when there is more
  than one gateway.
- Uploaded media lives under `data/media` (content-addressed by SHA-256);
  all file access goes through the `media` package so moving to object
  storage + CDN later touches only that package.
