# AGENTS.md

Guidance for AI coding agents working in this repository — the single project instruction file,
read by both Pi and Claude Code (which loads `AGENTS.md` for a project that has no `CLAUDE.md`).

Personal working-style conventions are projected into every harness by Arc (`~/.claude/CLAUDE.md`,
`~/.pi/agent/AGENTS.md`) and apply here too; they are not repeated in this file.

## Project status

Arc — an agent cockpit for driving and supervising coding agents. It began as a fork of Wave Terminal (the code still uses Wave names: `wavesrv`, `wsh`, `waveobj`); the desktop shell was **migrated from Electron to Tauri**. `main` is the Tauri build; the original Electron shell was removed from `main` and preserved on the `legacy/electron` branch.

Consequences that matter while working here:

- The upstream Electron-era docs are **gone** (2026-07-31 cleanup): `BUILD.md`, `CONTRIBUTING.md`, `RELEASES.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, the whole Docusaurus site under `docs/`, and `aiprompts/` were deleted; `README.md` was rewritten for Arc. Trust the Taskfile and this file for run/build flow. `docs/README.md` maps what remains.
- Tauri packaging is currently **Windows-only** (`cargo tauri build` → NSIS; bundles `wavesrv.x64.exe` + `wsh-*-windows.x64.exe`).

## Build & dev commands

The build is orchestrated by [Task](https://taskfile.dev) (`Taskfile.yml`), a `make` replacement. Tasks chain Go, Rust, and npm steps.

| Command | What it does |
|---|---|
| `task init` | First-time setup: `npm install` + `go mod tidy`. |
| `task dev` (alias of `task tauri:dev`) | The main way to run. Builds the dev-host backend only (wavesrv + host wsh), syncs `pi/` artifacts and the version, then `cargo tauri dev` (Vite dev server on `:5174`, HMR). |
| `task build:backend` | Builds `wavesrv` + `wsh` for the full release matrix into `dist/bin/`. |
| `task build:backend:quickdev:windows` | Rebuilds only `wavesrv` (no wsh, no generate) — the fast loop for Go server changes. |
| `task generate` | Regenerates TS + Go bindings from Go source. **Run after changing any wshrpc / waveobj / wconfig type.** |
| `task check:ts` | Typecheck the frontend (see the tsc gotcha below). |
| `npm test` / `npx vitest` | Frontend unit tests (vitest). |
| `task tauri:build` (alias `build:app`, and what `npm run build` now runs) | Production build: patch-bumps the version, syncs it into every version site, builds the backend, then `cargo tauri build`. `BUMP=patch\|minor\|major\|none` overrides the bump (default `patch`). |
| `task check:version` | Fail if `package.json`'s version has drifted from `src-tauri/tauri.conf.json` or `src-tauri/Cargo.toml`. `package.json` is the single source of truth; `scripts/sync-tauri-version.mjs` holds the list of sites. |
| `task preview` | Standalone component preview server (no backend, no shell). |
| `npm run cockpit:fixtures -- <scenario>` | Inject a fixture roster into the dev app: writes the scenario (source: `scripts/cockpit-fixtures/`) to `public/cockpit-fixtures/active.json`; reload the app to load it. `--clear` returns to live data; no argument lists scenarios. |

Other useful commands:

- **Single frontend test:** `npx vitest run frontend/app/view/agents/projectname.test.ts`, or filter by name: `npx vitest run -t "handles backslash paths"`.
- **Rust tests:** `cargo test --manifest-path src-tauri/Cargo.toml`.
- **Lint / format:** flat ESLint config (`eslint.config.js`) + Prettier (`prettier.config.cjs`), but **no Task/npm wrapper** — run `npx eslint` and `npx prettier --check` directly, **on paths**: `npx eslint .` also walks the worktree copies under `.worktrees/` and `.claude/worktrees/`. The config still references removed `emain/` (Electron) — dead; ignore.
- **HEAD is not formatter-clean** (`gofmt -l pkg cmd` lists ~50 files; prettier fails in places too). Check only the files you touched; never `--write` the tree. Never run prettier on `scripts/*.mjs` — `.editorconfig` omits `.mjs`, so prettier reindents those hand-formatted 4-space files to 2.
- **Clear dev data:** the dev app keeps its store, config, and WebView2 profile in `%LOCALAPPDATA%\dev.arc.app-dev\{data,config,EBWebView}` (isolated from a packaged install, which uses `dev.arc.app`). `task dev:cleardata` / `dev:clearconfig` still target the old Electron `waveterm-dev` paths and do **not** clear it — delete the dir by hand with the dev app stopped.

### Gotchas

- **`npx tsc` stack-overflows on this repo.** Typecheck with `task check:ts` (it runs `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`). It takes ~2 minutes — give the command a longer timeout than the 2-minute default. The baseline is clean (exit 0) — any error it reports is yours.
- **Task resolves the global `VERSION` var once per `task` process.** Bumping the version and building in the same invocation stamps the Go binaries (and the `wsh-<version>-*` filenames) with the *pre-bump* version. That is why `tauri:build` shells out to `tauri:build:post-bump` instead of using a nested `task:` call — and why the callee can't be marked `internal`.
- **Never hand-edit generated files.** Go is the source of truth for the wire protocol and object types; `task generate` writes `frontend/app/store/wshclientapi.ts`, `frontend/app/store/services.ts`, `frontend/types/gotypes.d.ts`, `frontend/types/waveevent.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`, and `pkg/{waveobj,wconfig}/metaconsts.go`. Edit the Go definitions, then regenerate.
- **`pi/` is the source for the pi artifacts `wsh` embeds.** `task sync:piartifacts` (run by every dev and backend build) copies `pi/extensions/*` and `pi/themes/arc.json` over `cmd/wsh/cmd/pi-*-extension.ts` and `cmd/wsh/cmd/arc-theme.json` — edit `pi/`, never the copies. The same task overwrites `~/.claude/skills/effort-tracking/SKILL.md` from `pi/skills/`.
- **A new registered `waveobj` type needs a SQL migration** in `db/migrations-wstore/NNNNNN.{up,down}.sql`, or it fails at runtime with "no such table".
- CGO backend builds use the **zig** compiler for cross/static linking (required dependency, see `Taskfile.yml` `build:server:*`).
- **Worktrees (Windows):** `task worktree:prepare` (run inside the worktree) junctions `node_modules`,
  `src-tauri/target`, `dist/bin` from the main checkout so `task dev` there is fast instead of a cold
  npm+cargo install. It does not copy `.task/checksum/npm-install`, so the first `task dev` in a worktree
  runs a real `npm install` that replaces the `node_modules` junction — copy that checksum file from the
  main checkout first. Remove with `task worktree:cleanup -- <path>` — it deletes the junction links
  first, never a real directory (a recursive delete can follow a junction into the main checkout and
  wipe its `node_modules`), then runs `git worktree remove` and `git branch -d`. To run a worktree dev app beside the main one, give it its own CDP port
  and WebView2 profile: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" WEBVIEW2_USER_DATA_FOLDER="$TEMP/wave-wt-profile" task dev`, then `CDP_PORT=9223 task verify:ui`.

### Visual verification (dev)

There is no jsdom/render-test harness for the cockpit — verify rendered UI by screenshotting the **live dev app** over the Chrome DevTools Protocol. Tauri renders through WebView2 (Chromium/Edge on Windows), which speaks CDP.

- **Enable:** `src-tauri/src/main.rs` sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, gated by `#[cfg(debug_assertions)]` (compiled out of `cargo tauri build` — never ships).
- **Capture:** `node scripts/cdp-shot.mjs [out.png] [port]` — discovers the page target (port defaults to `9222`; it ignores `CDP_PORT`) and writes a PNG (the page is the Vite app inside WebView2, `http://localhost:5174/`). The same attach pattern drives full CDP (`Runtime.evaluate` to read the DOM / jotai atoms, `Input.dispatchKeyEvent` for keys). `claude-in-chrome` MCP can't attach (needs Chrome + extension) — use raw CDP.
- **Scenario harness:** `task verify:ui -- <name...>` (→ `scripts/cdp/verify.mjs`) runs each scenario in `scripts/cdp/scenarios.mjs` as arrange → goto → shot → assert → teardown, prints a PASS/FAIL table, writes a contact sheet to `cdp-shots/index.html`, and exits nonzero on failure. With no names it runs every scenario. Prefer this over ad-hoc `cdp-shot.mjs` when a repeatable check exists; shared attach logic is in `scripts/cdp/attach.mjs`.
- **Inject test data first** if you need a populated cockpit: `node scripts/inject-live-agents.mjs <scenario>` (see that script's header).

## Architecture

Three layers, all part of the running app. **Full map: `docs/reference/architecture.md`** — read it
before working in an area you don't already know.

- **Tauri shell — Rust (`src-tauri/`)** — thin native host replacing the Electron main process. Mints
  a per-launch auth key, spawns `wavesrv` as a child, parses its `WAVESRV-ESTART` stderr line for the
  dynamic ports, and runs `wsh install-agent-hooks` on every launch. Five Tauri commands only; the
  window is borderless and the titlebar is drawn in React.
- **Go backend (`cmd/`, `pkg/`)** — `wavesrv` (SQLite object store + HTTP + websocket RPC) and `wsh`
  (CLI helper shipped into terminals). **Agents report into and drive the cockpit through `wsh`**
  (`wsh agent-hook`, `wsh ask`; `wsh runs`, `wsh ui`, `wsh effort`). The launch-time
  `install-agent-hooks` writes the Claude Code hooks into
  `~/.claude/settings.json` and the pi/opencode extensions, all pointing at a fixed copy under
  `~/.arc/bin/` — not PATH. The managed hook list is `cmd/wsh/cmd/wshcmd-installhooks.go`.
- **Frontend — React 19 + Vite + Tailwind 4 + jotai (`frontend/`)** — `frontend/tauri/main.tsx` is the
  sole shipping entry. The cockpit is **one window with N surfaces, not tabs**. Surface keys are not
  their labels: `files` renders as "Diff", `code` is the eighth; the order is
  `SURFACE_ORDER` in `frontend/app/view/agents/agents.tsx`.

Load-bearing rules:

- **`pkg/wshrpc` is the spine** — the typed RPC system spanning frontend ↔ wavesrv ↔ wsh ↔ remote.
  Nearly all cross-process behavior is a wshrpc command, composed from per-domain `wshrpctypes_*.go`.
- **Don't re-port Electron-IPC-shaped contracts** — build the Tauri-native primitive and let the old
  method die.
- **Only the Agent surface stays mounted** when off-screen (so its live xterm is never torn down and
  re-fitted at a stale size). Every other surface unmounts on switch — surface-local `useState` is
  lost, so persist anything survival-worthy in a per-entity jotai atom. Cross-surface concerns live in
  the always-mounted shell, not in a surface.
- **Opening an item on another surface goes through the one router**, `frontend/app/view/jarvis/openref.ts`
  (`openAddress` for a string, `openTarget` for an id): it loads the target, writes the destination's
  selection, then switches surface. Don't hand-roll set-selection-then-`surfaceAtom`.
- **Keybindings:** every binding is defined in `frontend/app/store/keybindings/bindings.ts` (a
  `build<Surface>Bindings()` per surface, plus global), but each surface activates its own with
  `useKeybindings(...)` in its component body — there is no central activation point.
  `docs/keyboard-shortcuts.md` mirrors the bindings.
- **`pkg/orchestrate`** is the deterministic DAG engine behind orchestrator runs (worktrees, lanes,
  merges, Setup/Verify); UI in `frontend/app/view/orchestrate`. The plan gate, task cap, adaptive
  orchestration, and pipeline mode were deleted (1e4bb179) and run workers are claude + pi only —
  older specs and `docs/orchestrator-howto.md` still describe the removed model;
  `docs/orchestrator-guide.md` is current.

### Frontend conventions

- **Testable logic is extracted, not rendered.** The pattern throughout `frontend/app/view/*` and `frontend/app/cockpit/` is a pure `foo.ts` (derive/model/reducer) with a `foo.test.ts` beside it, consumed by a thin `foo.tsx`. There are deliberately **no jsdom render/snapshot tests** — "does it render" is covered by the CDP `surface-smoke` scenario. When wiring is risky, extract it to a model and unit-test that.
- **UI design work follows `DESIGN.md` (repo root)** — design tokens, typography, layout, motion,
  and the do's and don'ts. Read it before planning or styling new UI. Mockups start from
  `docs/prototype/mockup-template.html`; run `task mockup:kit` after changing `@theme` tokens so its
  token block doesn't drift. Present a mockup only after its audit checklist passes (`pi/skills/ui-mockup`).
- **Colors come from `@theme` tokens in `frontend/tailwindsetup.css`** — never raw hex/rgba in components. Runtime theming (`view/agents/themes.ts` + `themestore.ts`) works by overriding those same `--color-*` custom properties on `document.documentElement`, so a hardcoded color silently opts out of every theme. `pi/themes/arc.json` is the exception — it is a TUI theme file.
- Prefer Tailwind over new SCSS.

## Design docs

- Specs and plans: `docs/superpowers/specs/` and `docs/superpowers/plans/`, named `YYYY-MM-DD-<topic>[-design].md`. Not paired: a plan backed by a spec is deleted once shipped. Standalone briefs and meta-specs: `docs/superpowers/briefs/`.
- Live issue trackers: `docs/open-issues.md` (the single "what's left" list) and `docs/orchestrator-redesign-flaws.md` (the orchestrator engine). The `docs/jarvis-*-open-issues.md` files are archived. `docs/README.md` maps the rest of `docs/`.
- Deliberately-deferred items and fabricated placeholder data: `docs/deferred.md`.
- Agent-cockpit integration notes (hooks, ask protocol, usage reporting): `docs/agents/`.
- **Plans the engine runs** (`wsh runs start --plan <file>`, or + Run → Orchestrator → A plan file; a lead hands its own plan over with `wsh jarvis dag submit --plan`) follow `jarvis.PlanFormat` (`pkg/jarvis/plan.go`): optional `**Verify:**` and `**Setup:**` commands in backticks before the first task, which run in a POSIX shell (Git Bash on Windows); `### Task N: <title>` (or `##`) headings numbered 1, 2, 3…; and, as a task's first line, an optional `**Depends on:**` — `none`, or `Task 1, Task 3`; left out, the task runs after the previous one, so a plan with no Depends lines is serial. The engine runs tasks with nothing between them at the same time, so split a plan by what can proceed independently — the Depends lines are what set its width.
