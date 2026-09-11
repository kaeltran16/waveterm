# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Personal working-style conventions (no emojis, solution ladder, git workflow, etc.) live in
`AGENTS.md` — see the "Working style" / "Git workflow — strict" sections there; they apply here too.

## Project status

Wave Terminal — an open-source, AI-native terminal. This fork has **migrated the desktop shell from Electron to Tauri** and is pivoting toward an agent-cockpit UI. `main` is the Tauri build; the original Electron shell was removed from `main` and preserved on the `legacy/electron` branch.

Consequences that matter while working here:

- The upstream Electron-era docs are **gone** (2026-07-31 cleanup): `BUILD.md`, `CONTRIBUTING.md`, `RELEASES.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, the whole Docusaurus site under `docs/`, and `aiprompts/` were deleted; `README.md` was rewritten for Arc. Trust the Taskfile and this file for run/build flow. `docs/README.md` maps what remains.
- Tauri packaging is currently **Windows-only** (`cargo tauri build` → NSIS; bundles `wavesrv.x64.exe` + `wsh-*-windows.x64.exe`).
- Electron-era files still on disk but **not loaded by the cockpit**: `electron.vite.config.ts`, `frontend/app/app.scss`, `frontend/app/theme.scss`. The cockpit's only stylesheet entry is `frontend/tauri/tailwind.css` → `frontend/tailwindsetup.css`.

## Build & dev commands

The build is orchestrated by [Task](https://taskfile.dev) (`Taskfile.yml`), a `make` replacement. Tasks chain Go, Rust, and npm steps.

| Command | What it does |
|---|---|
| `task init` | First-time setup: `npm install` + `go mod tidy`. |
| `task dev` (alias of `task tauri:dev`) | The main way to run. Builds backend, then `cargo tauri dev` (Vite dev server on `:5174`, HMR). |
| `task build:backend` | Builds `wavesrv` + `wsh` into `dist/bin/`. |
| `task generate` | Regenerates TS + Go bindings from Go source. **Run after changing any wshrpc / waveobj / wconfig type.** |
| `npm test` / `npx vitest` | Frontend unit tests (vitest). |
| `task tauri:build` (alias `build:app`, and what `npm run build` now runs) | Production build: patch-bumps the version, syncs it into every version site, builds the backend, then `cargo tauri build`. `BUMP=none\|minor\|major` overrides the bump. |
| `task check:version` | Fail if `package.json`'s version has drifted from `src-tauri/tauri.conf.json` or `src-tauri/Cargo.toml`. `package.json` is the single source of truth; `scripts/sync-tauri-version.mjs` holds the list of sites. |
| `task preview` | Standalone component preview server (no backend, no shell). |
| `npm run cockpit:fixtures` | Regenerate the cockpit fixture data under `scripts/cockpit-fixtures/`. |

Other useful commands:

- **Single frontend test:** `npx vitest run frontend/app/view/agents/projectname.test.ts`, or filter by name: `npx vitest run -t "parses estart"`.
- **Rust tests:** `cargo test --manifest-path src-tauri/Cargo.toml`.
- **Lint / format:** flat ESLint config (`eslint.config.js`) + Prettier (`prettier.config.cjs`), but **no Task/npm wrapper** — run `npx eslint .` and `npx prettier --check .` directly. The config still references removed `emain/` (Electron) — dead; ignore. The phantom `tsunami/frontend` and `docs` npm workspaces were removed 2026-07-31.
- **Clear dev data/config:** `task dev:cleardata`, `task dev:clearconfig` (dev app uses `waveterm-dev` data dirs, isolated from a packaged install).

### Gotchas

- **`npx tsc` stack-overflows on this repo** — which means **`task check:ts` is broken** (it just runs `npx tsc --noEmit`). Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` instead. The baseline is clean (exit 0) — any error it reports is yours.
- **Bare `go test ./pkg/...` fails to *build* 6 packages** (`jarvisembed` + its dependents `jarvisattrib`, `jarvisproactive`, `jarvisrecall`, `web`, `wshrpc/wshserver`) with `sqlite-vec.h: fatal error: sqlite3.h: No such file or directory`. CGO needs the vendored header in `pkg/jarvisembed/csrc`, and the `-I` path must be **Windows-style** — a Git-Bash POSIX path (`/c/Users/...`) silently fails with the identical error. From PowerShell at the repo root:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  go test ./pkg/...
  ```
  `task build:backend` sets this itself (`build:server:internal`) and needs no setup.
- **Task resolves the global `VERSION` var once per `task` process.** Bumping the version and building in the same invocation stamps the Go binaries (and the `wsh-<version>-*` filenames) with the *pre-bump* version. That is why `tauri:build` shells out to `tauri:build:post-bump` instead of using a nested `task:` call — and why the callee can't be marked `internal`.
- **Never hand-edit generated files.** Go is the source of truth for the wire protocol and object types; `task generate` produces `frontend/app/store/wshclientapi.ts` and the generated Go/TS type files. Edit the Go definitions, then regenerate.
- **A new registered `waveobj` type needs a SQL migration** in `db/migrations-wstore/NNNNNN.{up,down}.sql`, or it fails at runtime with "no such table".
- CGO backend builds use the **zig** compiler for cross/static linking (required dependency, see `Taskfile.yml` `build:server:*`).
- **Worktrees (Windows):** `task worktree:prepare` (run inside the worktree) junctions `node_modules`,
  `src-tauri/target`, `dist/bin` from the main checkout so `task dev` there is fast instead of a cold
  npm+cargo install. Remove with `task worktree:cleanup -- <path>` — it deletes the junction links
  first, never a real directory (a recursive delete can follow a junction into the main checkout and
  wipe its `node_modules`). To run a worktree dev app beside the main one, give it its own CDP port
  and WebView2 profile: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" WEBVIEW2_USER_DATA_FOLDER="$TEMP/wave-wt-profile" task dev`, then `CDP_PORT=9223 task verify:ui`.

### Visual verification (dev)

There is no jsdom/render-test harness for the cockpit — verify rendered UI by screenshotting the **live dev app** over the Chrome DevTools Protocol. Tauri renders through WebView2 (Chromium/Edge on Windows), which speaks CDP.

- **Enable:** `src-tauri/src/main.rs` sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, gated by `#[cfg(debug_assertions)]` (compiled out of `cargo tauri build` — never ships). `cargo tauri dev` watches `src-tauri/`, so the flag activates on the next dev rebuild.
- **Capture:** `node scripts/cdp-shot.mjs [out.png]` — discovers the page target on `:9222` and writes a PNG (the page is the Vite app inside WebView2, `http://localhost:5174/`). The same attach pattern drives full CDP (`Runtime.evaluate` to read the DOM / jotai atoms, `Input.dispatchKeyEvent` for keys). `claude-in-chrome` MCP can't attach (needs Chrome + extension) — use raw CDP.
- **Scenario harness:** `task verify:ui -- <name...>` (→ `scripts/cdp/verify.mjs`) runs each scenario in `scripts/cdp/scenarios.mjs` as arrange → goto → shot → assert → teardown, prints a PASS/FAIL table, writes a contact sheet to `cdp-shots/index.html`, and exits nonzero on failure. Prefer this over ad-hoc `cdp-shot.mjs` when a repeatable check exists; shared attach logic is in `scripts/cdp/attach.mjs`.
- **Inject test data first** if you need a populated cockpit: `node scripts/inject-live-agents.mjs <scenario>` (see that script's header).
- **Worktree dev app:** the CDP port is env-overridable — `CDP_PORT=9223 task verify:ui` attaches to a
  dev app launched with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"` and its
  own `WEBVIEW2_USER_DATA_FOLDER` (profile lock + port collision prevent two dev apps on 9222).
  `task worktree:prepare`/`worktree:cleanup` handle the junction sharing so `task dev` boots in a
  worktree at all.

## Architecture

Three layers, all part of the running app. **Full map: `docs/reference/architecture.md`** — read it
before working in an area you don't already know.

- **Tauri shell — Rust (`src-tauri/`)** — thin native host replacing the Electron main process. Mints
  a per-launch auth key, spawns `wavesrv` as a child, parses its `WAVESRV-ESTART` stderr line for the
  dynamic ports. Six Tauri commands only; the window is borderless and the titlebar is drawn in React.
- **Go backend (`cmd/`, `pkg/`)** — `wavesrv` (SQLite object store + HTTP + websocket RPC) and `wsh`
  (CLI helper shipped into terminals). **Agents report into the cockpit through `wsh`**, so if it
  isn't on PATH in a spawned shell the cockpit stays empty.
- **Frontend — React 19 + Vite + Tailwind 4 + jotai (`frontend/`)** — `frontend/tauri/main.tsx` is the
  sole shipping entry. The cockpit is **one window with N surfaces, not tabs**.

Load-bearing rules:

- **`pkg/wshrpc` is the spine** — the typed RPC system spanning frontend ↔ wavesrv ↔ wsh ↔ remote.
  Nearly all cross-process behavior is a wshrpc command, composed from per-domain `wshrpctypes_*.go`.
- **Don't re-port Electron-IPC-shaped contracts** — build the Tauri-native primitive and let the old
  method die.
- **Only the Agent surface stays mounted** when off-screen (so its live xterm is never torn down and
  re-fitted at a stale size). Every other surface unmounts on switch — surface-local `useState` is
  lost, so persist anything survival-worthy in a per-entity jotai atom. Cross-surface concerns live in
  the always-mounted shell, not in a surface.
- **`pkg/agentask`** — multi-answer is gated **server-side** in `encode.go`.

### Frontend conventions

- **Testable logic is extracted, not rendered.** The pattern throughout `view/agents` and `view/jarvis` is a pure `foo.ts` (derive/model/reducer) with a `foo.test.ts` beside it, consumed by a thin `foo.tsx`. There are deliberately **no jsdom render/snapshot tests** — "does it render" is covered by the CDP `surface-smoke` scenario. When wiring is risky, extract it to a model and unit-test that.
- **UI design work follows `DESIGN.md` (repo root)** — design tokens, typography, layout, motion,
  and the do's and don'ts. Read it before planning or styling new UI.
- **Colors come from `@theme` tokens in `frontend/tailwindsetup.css`** — never raw hex/rgba in components. Runtime theming (`view/agents/themes.ts` + `themestore.ts`) works by overriding those same `--color-*` custom properties on `document.documentElement`, so a hardcoded color silently opts out of every theme.
- Prefer Tailwind over new SCSS.

## Design docs

- Specs and plans: `docs/superpowers/specs/` and `docs/superpowers/plans/` (paired, date-prefixed — the Tauri migration phases, the Jarvis second-brain sub-projects, agents-tab work). Standalone briefs and meta-specs: `docs/superpowers/briefs/`.
- Live issue trackers: `docs/open-issues.md`, `docs/jarvis-*-open-issues.md`. `docs/README.md` maps the rest of `docs/`.
- Deliberately-deferred items and fabricated placeholder data: `docs/deferred.md`.
- Agent-cockpit integration notes (hooks, ask protocol, usage reporting): `docs/agents/`.
