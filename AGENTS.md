# AGENTS.md

The project instruction file for AI agents in this repo, read by Pi and by Claude Code (which loads
`AGENTS.md` when a project has no `CLAUDE.md`). Personal working-style conventions come from the harness's
global file and are not repeated here.

## Project status

Arc: an agent cockpit for driving and supervising coding agents. A fork of Wave Terminal (the code keeps Wave
names: `wavesrv`, `wsh`, `waveobj`) whose desktop shell moved from Electron to Tauri; the Electron shell
lives only on the `legacy/electron` branch. The upstream Electron-era docs are deleted: trust the Taskfile
and this file for build flow, and `docs/README.md` for what remains of `docs/`. Packaging is Windows-only
(`cargo tauri build` → NSIS, bundling `wavesrv.x64.exe` + `wsh-*-windows.x64.exe`).

## Build, test, run

[Task](https://taskfile.dev) (`Taskfile.yml`) chains the Go, Rust and npm steps.

| Command | What it does |
|---|---|
| `task dev` | The main way to run: dev backend (wavesrv + host wsh), artifact and version sync, then `cargo tauri dev` (Vite on `:5174`, HMR). |
| `task build:backend:quickdev:windows` | Rebuilds only `wavesrv`: the fast loop for Go server changes. |
| `task generate` | Regenerates TS + Go bindings. **Run after changing any wshrpc / waveobj / wconfig type.** |
| `task check:ts` | Typecheck the frontend (~2 min: give it a timeout over 2 min). Baseline is clean, so any error is yours. `npx tsc` stack-overflows here. |
| `npx vitest run <file>` / `-t "<name>"` | Frontend unit tests. |
| `go test ./pkg/x -run '^TestName$'` | One Go test. |
| `ARC_VERIFY_CHANGED=<file> node scripts/verify.mjs ./pkg/x` | A Go package's tests, given a file of changed paths (`git diff --name-only main > <file>`): tests only what they can break and deals a big package across 4 processes (`pkg/orchestrate`: under 2 min vs 4-7 as plain `go test`). Keep go's 10-minute timeout: reaching it means a hung test, and the dump names it. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust tests. |
| `task tauri:build` | Production build. No bump by default; for a release pass `BUMP=patch\|minor\|major` and commit the bump. `package.json` is the version's single source of truth (`task check:version`). |
| `npm run cockpit:fixtures -- <scenario>` | Inject a fixture roster into the dev app (`--clear` returns to live data; no argument lists them), then reload the app. |

- **Lint/format on paths only:** `npx eslint <paths>`, `npx prettier --check <paths>`. HEAD is not
  formatter-clean (gofmt and prettier both flag files), so check only the files you touched and leave the
  rest of the tree as it is. Keep prettier off `scripts/*.mjs`: it reindents those hand-formatted 4-space
  files to 2.
- **Dev data and logs** live in `%LOCALAPPDATA%\dev.arc.app-dev\{data,config,EBWebView}` (packaged:
  `dev.arc.app`). `task dev:cleardata` / `dev:clearconfig` with the dev app stopped. `data\waveapp.log` holds
  wavesrv stderr (panic stacks), `fe-log` lines and `[tauri]` lines; `[tauri] wavesrv stderr closed` marks a
  backend exit.

## Gotchas

- **Edit the source, never the copy.** The build and launch overwrite every copy:
  - Generated files (also in merge conflicts): edit the Go definitions, then `task generate`. It writes
    `frontend/app/store/{wshclientapi,services}.ts`, `frontend/types/{gotypes,waveevent}.d.ts`,
    `pkg/wshrpc/wshclient/wshclient.go` and `pkg/{waveobj,wconfig}/metaconsts.go`.
  - `pi/extensions/*`, `pi/themes/arc.json` → copied into `cmd/wsh/cmd/`.
  - `claude/arc-mod/`, `claude/arc-view-mod/`, `claude/arc-skim-mod/` → copied into `cmd/wsh/cmd/claude-*`.
  - `skills/` (Arc's `arc:` skills) → the vault, the arc mod and each harness.
  - The `cmd/wsh/cmd/claude-*` copies are tracked: after editing a source, run `task sync:claudemod` and
    commit the copies with it.
  - Mods and skills, how they install and their traps: `docs/agents/claude-mods.md`.
- **Renaming a wshrpc command breaks `task generate` itself** (`undefined: wshrpc.Command<Old>Data`).
  Replace the three symbols (`<Old>Command`, `Command<Old>Data`, wire string `"<old>"`) in
  `pkg/wshrpc/wshclient/wshclient.go`, then `task generate`: the one allowed hand-edit of a generated file.
- **A new registered `waveobj` type needs a SQL migration** in `db/migrations-wstore/NNNNNN.{up,down}.sql`,
  or it fails at runtime with "no such table".
- **`tsconfig.json` is `strict: false`, so an ok-union does not narrow.** `result.ok ? a : b` fails tsc
  when the false arm reads `reason`, while vitest passes. Narrow with `"reason" in result` (precedent:
  `command-palette.tsx`); keep existing `in` checks.
- **Task resolves `VERSION` once per process**, so a bump and a build in one invocation stamp the pre-bump
  version. That is why `tauri:build` shells out to `tauri:build:post-bump` (which therefore can't be
  `internal`).
- CGO backend builds need **zig** (`build:server:*`).
- **Processes:** the dev app and the user's packaged Arc share the image names `wave-tauri.exe` and
  `wavesrv.x64.exe`, so stopping by image name kills the user's Arc and every agent in it. Stop only a dev
  app you started, by PID: `Get-Process wave-tauri,wavesrv.x64 | Select Id,Path`, path in a repo checkout
  (`src-tauri\target`, `dist\bin`), never under `AppData\Local\Arc`. For any other `wavesrv`/`wave-tauri`
  process, propose the kill and wait for a yes.
- **Worktrees:** `task worktree:prepare` (inside the worktree) junctions `node_modules`, `src-tauri/target`
  and `dist/bin` from the main checkout; `task dev` and `task check:ts` are safe there. Remove one only with
  `task worktree:cleanup -- <path>`, which unlinks the junctions first: a recursive delete follows a
  junction into the main checkout and wipes its `node_modules`. For a worktree-local backend build, run
  `mkdir -p dist/bin` before prepare.

## Verifying UI

The cockpit has no render tests: verify rendered UI in the **live dev app** over CDP (port 9222 in dev
builds). `task verify:ui -- <scenario...>` runs the repeatable checks; `node scripts/cdp-shot.mjs` takes a
one-off screenshot. **Before committing a UI change, see it in the running dev app**; if the live check
could not run, say exactly what was not verified. Attaching, writing scenarios, the popup target, viewport
and reload traps, and a second dev app beside the main one: `docs/reference/cdp-verification.md`.

## Architecture

Full map: `docs/reference/architecture.md`. Read it before working in an area you don't know.

- **Tauri shell** (`src-tauri/`, Rust): a thin host that spawns `wavesrv` and runs
  `wsh install-agent-hooks` each launch. Build Tauri-native primitives rather than re-porting
  Electron-IPC-shaped contracts.
- **Go backend** (`cmd/`, `pkg/`): `wavesrv` (SQLite store, HTTP, websocket RPC) and `wsh`, through which
  agents report into and drive the cockpit. The managed hook list is `cmd/wsh/cmd/wshcmd-installhooks.go`.
- **`pkg/wshrpc` is the spine:** nearly all cross-process behavior is a typed wshrpc command, composed from
  per-domain `wshrpctypes_*.go`.
- **`pkg/orchestrate`** is the deterministic DAG engine behind orchestrator runs; run workers are claude +
  pi only. Older specs describe removed models; `docs/orchestrator-guide.md` is current.
- **Frontend** (`frontend/`, React 19 + Vite + Tailwind 4 + jotai): one window with N surfaces, not tabs.
  Surface keys are not labels (`files` renders as "Diff"); the order is `SURFACE_ORDER` in
  `frontend/app/view/agents/agents.tsx`.
  - **Only the Agent surface stays mounted** off-screen; every other surface unmounts on switch, so keep
    anything that must survive in a per-entity jotai atom, and cross-surface concerns in the shell.
  - **Open an item on another surface through the router** `frontend/app/view/jarvis/openref.ts`
    (`openAddress` for a string, `openTarget` for an id), which loads, selects, then switches surface.
  - **Keybindings** are defined in `frontend/app/store/keybindings/bindings.ts` and activated per surface
    with `useKeybindings(...)` in its component; `docs/keyboard-shortcuts.md` mirrors them.
  - **Logic is extracted, not rendered:** a pure `foo.ts` with `foo.test.ts` beside it, consumed by a thin
    `foo.tsx`. When wiring is risky, extract it to a model and unit-test that.
  - **UI design follows `DESIGN.md`**; read it before planning or styling new UI. Colors come from the
    `@theme` tokens in `frontend/tailwindsetup.css` (runtime themes override those properties, so a raw
    color opts out of every theme). Prefer Tailwind to new SCSS.

## Working rules

- **Before deleting a file, grep every import of it**, `import type` and re-exports included.
- **"Housekeeping" or "cleanup" means removing code and files**, not only updating docs.
- **Monitoring an orchestrator run means observe and log only**, unless asked to intervene.
- **Merge a feature branch with `--no-ff`**, and run the tests on the merged result before deleting it.
- **A plan with several edits to one file:** anchor each edit on quoted surrounding content, and state
  "every line number below is pre-edit" when a task lands more than one edit in the same file.

## Docs

- Specs `docs/superpowers/specs/`, plans `docs/superpowers/plans/`, named `YYYY-MM-DD-<topic>[-design].md`.
  Specs are kept; a plan is deleted once it ships.
- `docs/open-issues.md` is the single "what's left" list; `docs/orchestrator-redesign-flaws.md` tracks the
  engine. Deferring something: add it to `docs/deferred.md` with the recovery command
  (`git show COMMIT:path`), and mark it RESOLVED with date and commits when built or declined.
- **Plans the engine runs** follow `jarvis.PlanFormat` (`pkg/jarvis/plan.go`); the format, Setup, exit codes
  and landing are in `docs/orchestrator-guide.md` ("The plan format", "The final stage"). For this repo:
  - **Verify:** `node scripts/verify.mjs <go package patterns>`. **Final:**
    `node scripts/cdp/final-verify.mjs [scenario...]`. The checked-in `.arc/setup` does the junctions.
  - **Name a scenario for each UI the plan changes**, and have each task that builds a view, visual state or
    interaction name the step that shows it, adding one if none does (opening its surface does not count;
    with a Prototype, every board needs one). Final runs only the named scenarios, so a UI no scenario opens
    goes unverified.
  - Tasks with no `**Depends on:**` line run serially; the Depends lines set the plan's width.
