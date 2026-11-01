# AGENTS.md

Instructions for any coding agent working on this repository (Codex, GPT,
Claude, ...). The rules live in one place: **read `CLAUDE.md` first and follow
it** — it is not Claude-specific. Then read `docs/todo.md`, `docs/design.md`,
`docs/protocol.md` and the module you are changing.

The short version:

- The owner (Weiqi) talks in casual Chinese. Propose a plan and wait for his
  confirmation before changing code (bug fixes he asked for included).
- The docs are the source of truth: when behaviour or a decision changes,
  update `docs/` and `CHANGELOG.md` in the same commit.
- Server: `server/internal/store` is the only package that runs SQL; schema
  changes are new migrations in both `store/migrations/sqlite/` and
  `store/migrations/postgres/`. Protocol changes start in `proto/`, then
  `buf generate`, and the generated code is committed.
- Checks before you push:
  - `go vet ./... && go test -race ./...`
  - `cd client && npm run typecheck && npm test && npx vite build`
- Work on your own branch and open a pull request; don't push to `main` or to
  another agent's branch (`claude/*`). Keep each fix to what the bug needs.
