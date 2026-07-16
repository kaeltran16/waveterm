# Tsunami/Builder Retirement + Dead Config Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the builder/tsunami "widget-app" subsystem in full (wavesrv + frontend host integration **and** the standalone `tsunami/` Go module), plus ten dead `window:*`/`app:*` config keys — with no observable change in the cockpit.

**Architecture:** This is a **deletion** effort, not a feature. The subsystem is unreachable in the Tauri cockpit (nothing sets `builderId`, nothing creates `controller:"tsunami"`, `builderMode` is always false in the live chat handler), so removal is behavior-preserving. TDD red-green does not apply to dead-code removal; following the codebase's established cleanup convention (`docs/superpowers/plans/2026-07-13-backend-legacy-cleanup.md`), each task's "test" is a grep-gate (prove zero live callers) followed by the Standard Verification suite (prove nothing broke). Tasks are ordered so Go always compiles: **consumers removed before providers**, `task generate` after every wire-type change.

**Tech Stack:** Go (wavesrv/wsh), Rust (Tauri shell), TypeScript/React (frontend), Task (build orchestration), zig (CGO compiler).

Design spec: `docs/superpowers/specs/2026-07-16-tsunami-builder-retirement-design.md`.

## Global Constraints

- **Go is the source of truth for the wire protocol.** After changing any wshrpc / waveobj / wconfig type, run `task generate` and commit the regenerated files (`frontend/app/store/wshclientapi.ts`, `frontend/app/store/services.ts`, `frontend/types/gotypes.d.ts`, `frontend/types/waveevent.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`) with the Go change. **Never hand-edit generated files.**
- **`npx tsc` stack-overflows on this repo.** Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is exit 0 — any error it reports is yours.
- **Go sqlite tests need CGO+zig.** Run Go tests as `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/...`.
- **Known-failing baseline test:** `pkg/tsgen TestGenerateWaveEventTypes` fails on a clean tree (stale fixture). It is the ONLY expected Go-test failure at baseline. Verification passes if there are **no NEW** failures beyond it.
- **Do NOT touch `secretstore`** — grep-confirmed independent of `waveappstore`; it stores live user data.
- **Do NOT touch** the aiusechat general chat engine, the shell/cmd/durable block controllers, generic fileshare/RPC infra, the `vdom` view, or the `aifilediff` view.
- **Leave the `preview` window-type alone** — it is separate from `builder`.
- **Commits require explicit user approval** (project git rule). Per the user's decision this ships as **two commits total** — one at the end of Part 1, one at the end of Part 2 — NOT per task. Each task instead ends with its Standard Verification gate. The design spec folds into the Part 1 commit (no docs-only commit).
- **Windows environment:** never use PowerShell here-strings in the Bash tool for commit messages; use `git commit -F <file>` or multiple `-m` flags.

### Standard Verification (referenced by tasks as "run Standard Verification")

Run in order; each must be green (modulo the known baseline test) before a task is complete:

1. If any `*.go` wire type changed: `task generate`.
2. Backend build: `task build:backend` (exit 0).
3. Go tests: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/...` (no NEW failures beyond `TestGenerateWaveEventTypes`).
4. Frontend typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (exit 0).
5. Frontend tests: `npx vitest run` (pass).
6. **BOOT-VERIFY** (tasks so flagged): with `task dev` running, `node scripts/cdp-shot.mjs` and confirm the cockpit renders (terminal mounts, settings surface renders, no console errors). For the final gate, also drive a real AI/Jarvis chat turn to prove the aiusechat surgery is clean.

---

## Subsystem inventory (reference for all tasks)

Whole-file / whole-package deletes:
- `pkg/blockcontroller/tsunamicontroller.go`
- `pkg/buildercontroller/` (package)
- `pkg/waveapp/` (package: `waveapp.go`, `waveappserverimpl.go`, `streamingresp.go`)
- `pkg/waveapputil/` (package)
- `pkg/tsunamiutil/` (package)
- `pkg/waveappstore/` (package)
- `pkg/aiusechat/tools_tsunami.go`, `pkg/aiusechat/tools_builder.go`
- `pkg/wshrpc/wshrpctypes_builder.go` (the whole `WshRpcBuilderInterface` + all its `AppInfo`/`AppMeta`/`BuilderStatusData`/`Command*Data`/`SecretMeta`/`AppManifest`/`DirEntryOut` types)
- `tsunami/` (module directory)

Surgical edits (live code):
- `pkg/aiusechat/tools.go` — the `"tsunami"` case + `handleTsunamiBlockDesc` + `generateToolsForTsunamiBlock`
- `pkg/aiusechat/usechat.go` — builder-mode branches
- `pkg/wshrpc/wshserver/wshserver.go` — builder impls (~`:920-1200`) + imports
- `pkg/wshrpc/wshrpctypes.go:218` — the `WshRpcBuilderInterface` embed
- `pkg/blockcontroller/blockcontroller.go` — const `:36`, dispatch `:274-276`, type-check branch `:227-230`

Types / events / config:
- `pkg/waveobj/wtype.go:35,50` (`OType_Builder`); `wtypemeta.go:145-150` + `metaconsts.go:141-146` (six `Tsunami*` meta keys); `objrtinfo.go:7-8,22-24` (`Tsunami*`/`Builder*` RTInfo fields)
- `pkg/wps/wpstypes.go:22-23,32-33,46-47,56-57` (`Event_BuilderStatus`, `Event_BuilderOutput`, `Event_WaveAppAppGoUpdated`, `Event_TsunamiUpdateMeta`) + `pkg/tsgen/tsgenevent.go:29-30,39-40` registrations
- `pkg/wconfig/metaconsts.go:23,129-133` + `settingsconfig.go:75,181-185` (`feature:waveappbuilder` + five `tsunami:*` keys)
- `pkg/wavebase/wavebase.go:33,56,105-106,138-139` (`WAVETERM_ELECTRONEXECPATH` plumbing)

Frontend:
- `frontend/app/store/windowtype.ts`, `global-atoms.ts:16-18,131-132`, `global-model.ts:15,36` (+ `GlobalInitOptions.builderId`), `wshrouter.ts:27-28`, `frontend/preview/mock/mockwaveenv.ts:160`, `frontend/preview/mock/preview-electron-api.ts:19`

Module + build:
- `go.mod:33` (require), `go.mod:93` (replace); `Taskfile.yml` (`build:tsunamiscaffold` at `:297`, its use in `tauri:dev` deps `:26`, standalone `tsunami:*` targets `:472-608`, and `tsunami/**` source-watch globs); `CLAUDE.md` (Layer 4 section)

---

# PART 1 — Tsunami/builder retirement

## Task 1: Remove the frontend `builder` window-type plumbing

Frontend-only, self-contained (zero live callers of builder RPCs confirmed). Collapses the window-type to `"tab" | "preview"`.

**Files:**
- Modify: `frontend/app/store/windowtype.ts`
- Modify: `frontend/app/store/global-atoms.ts`
- Modify: `frontend/app/store/global-model.ts`
- Modify: `frontend/app/store/wshrouter.ts`
- Modify: `frontend/preview/mock/mockwaveenv.ts`
- Modify: `frontend/preview/mock/preview-electron-api.ts`

- [ ] **Step 1: Confirm no other builder consumers.** Run:
  ```bash
  grep -rn "builderId\|builderAppId\|makeBuilderRouteId\|getWaveWindowType\|isBuilder\|WaveWindowType" frontend/app frontend/tauri --include=*.ts --include=*.tsx | grep -v ".d.ts"
  ```
  Expect only the six files above (plus any read-only `getWaveWindowType()` callers that switch on `"builder"` — note them; they collapse to the `"tab"`/`"preview"` branches).

- [ ] **Step 2: `windowtype.ts`** — change the union type from `"tab" | "builder" | "preview"` to `"tab" | "preview"` and remove the `isBuilderWindow()` helper (and any `waveWindowType === "builder"` branch). Keep `isPreview`/preview handling.

- [ ] **Step 3: `global-atoms.ts`** — delete `const builderIdAtom` (`:16`) and `const builderAppIdAtom` (`:17`); change line 18 from `setWaveWindowType(initOpts.isPreview ? "preview" : initOpts.builderId != null ? "builder" : "tab")` to `setWaveWindowType(initOpts.isPreview ? "preview" : "tab")`; delete the `builderId`/`builderAppId` entries in the `atoms = {...}` object (`:131-132`).

- [ ] **Step 4: `global-model.ts`** — remove the `builderId` field declaration (`:15`) and the `this.builderId = initOpts.builderId;` assignment (`:36`). Then remove `builderId` from the `GlobalInitOptions` type wherever it is declared (grep `builderId` — it is read in `global-atoms.ts` as `initOpts.builderId`, so the field lives on `GlobalInitOptions`; delete it there too).

- [ ] **Step 5: `wshrouter.ts`** — delete `makeBuilderRouteId` (`:27-28`) and any use of it (grep `makeBuilderRouteId` within the file first; remove the builder route registration).

- [ ] **Step 6: Preview mocks** — remove `builderId: atom("")` from `mockwaveenv.ts:160`; remove the `showBuilderAppMenu` stub from `preview-electron-api.ts:19`.

- [ ] **Step 7: Verify.** Run Standard Verification steps 4-5 (tsc + vitest). Go is untouched, so backend steps are not required for this task.

**Risk:** Low. FE-only; the generated `gotypes.d.ts` still carries `builderId` until Task 6's regen, but nothing references it after this task.

---

## Task 2: Excise builder mode from `pkg/aiusechat`

Delete the two builder-only tool files and surgically remove builder/tsunami branches from the two live chat files. After this, aiusechat no longer imports `buildercontroller`/`waveappstore`/`waveapputil` (those packages still exist, imported by `wshserver`/`tsunamicontroller`, so the build stays green).

**Files:**
- Delete: `pkg/aiusechat/tools_tsunami.go`, `pkg/aiusechat/tools_builder.go`
- Modify: `pkg/aiusechat/tools.go`
- Modify: `pkg/aiusechat/usechat.go`

- [ ] **Step 1: Delete the two files.**
  ```bash
  rm pkg/aiusechat/tools_tsunami.go pkg/aiusechat/tools_builder.go
  ```

- [ ] **Step 2: `tools.go`** — remove the `case "tsunami": return handleTsunamiBlockDesc(block)` arm (`:122-123`); remove the `if viewType == "tsunami" { blockTools := generateToolsForTsunamiBlock(block); tools = append(tools, blockTools...) }` block (`:186-189`); delete the now-orphaned `generateToolsForTsunamiBlock` func (`:240`+) and (if only referenced from the deleted case) `handleTsunamiBlockDesc`. Grep `handleTsunamiBlockDesc\|generateToolsForTsunamiBlock\|GetTsunami` within `pkg/aiusechat` and remove all now-dead tsunami tool-definition helpers they call (`GetTsunamiGetDataToolDefinition`, `GetTsunamiGetConfigToolDefinition`, `GetTsunamiSetConfigToolDefinition`, etc.). Remove any import left unused.

- [ ] **Step 3: `usechat.go`** — excise builder mode:
  - Delete `const BuilderMaxTokens` (`:40`).
  - `getSystemPrompt` (`:49`): drop the `isBuilder` parameter and the `if isBuilder { ... }` branch (`:50`); update the sole caller (`:695`) to stop passing it.
  - `getWaveAISettings` (`:74`): drop the `builderMode` parameter and the `if builderMode { maxTokens = BuilderMaxTokens }` branch (`:76-77`); update the caller (`:679`).
  - Delete the `BuilderId` / `BuilderAppId` fields from the request struct (`:627-628`).
  - Remove the `else if req.BuilderId != ""` RTInfo branch (`:664-665`) so RTInfo resolves from `TabId` only; if `TabId` is empty the existing zero/`nil` path applies.
  - Delete `builderMode := req.BuilderId != ""` (`:673`) and change `premium := shouldUsePremium() || builderMode` to `premium := shouldUsePremium()` (`:674`).
  - Delete the `chatOpts.BuilderId`/`chatOpts.BuilderAppId` assignments (`:692-693`) and the `chatOpts.SystemPrompt = getSystemPrompt(..., chatOpts.BuilderId != "", ...)` builder arg (`:695`).
  - Delete the `if req.BuilderAppId != "" { chatOpts.BuilderAppGenerator = ... }` block (`:704-706`) and the `if req.BuilderAppId != "" { tools = append(tools, GetBuilder*ToolDefinition(...)) }` block (`:710-714`).
  - Delete `generateBuilderAppData` (`:846`+) and the `BuilderAppGenerator` field from `WaveChatOpts` (grep `BuilderAppGenerator` across `pkg/aiusechat` — remove the field in `uctypes` and its consumer at `:426-427`).
  - Remove the now-unused `waveappstore` import and any other import left dangling.

- [ ] **Step 3a: Grep-verify no builder residue in the package.**
  ```bash
  grep -rn "uilder\|waveappstore\|waveapputil\|Tsunami" pkg/aiusechat --include=*.go
  ```
  Expect zero hits (or only unrelated substrings — inspect each).

- [ ] **Step 4: Verify.** Run Standard Verification (steps 1-5; `task generate` is a no-op here since no wire type changed yet, but run it to be safe). `task build:backend` must be green — this proves the surgery left aiusechat compiling.

**Risk:** High (live chat path). Mitigation: `builderMode` is always false today, so removing these branches is behavior-preserving. The final BOOT-VERIFY chat turn (Task 8) is the proof.

---

## Task 3: Remove the builder wshrpc surface

Delete the whole builder RPC interface file, its embed, and all impls + subsystem imports in `wshserver`. Regenerate bindings.

**Files:**
- Delete: `pkg/wshrpc/wshrpctypes_builder.go`
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Regenerated: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`

- [ ] **Step 1: Confirm zero live callers** (frontend already confirmed zero; re-check wsh CLI + Go):
  ```bash
  grep -rn "ListAllAppsCommand\|ListAllEditableAppsCommand\|ListAllAppFilesCommand\|ReadAppFileCommand\|WriteAppFileCommand\|WriteAppGoFileCommand\|DeleteAppFileCommand\|RenameAppFileCommand\|WriteAppSecretBindingsCommand\|DeleteBuilderCommand\|StartBuilderCommand\|StopBuilderCommand\|RestartBuilderAndWaitCommand\|GetBuilderStatusCommand\|GetBuilderOutputCommand\|CheckGoVersionCommand\|PublishAppCommand\|MakeDraftFromLocalCommand" cmd/ frontend/ --include=*.go --include=*.ts --include=*.tsx | grep -v "wshclientapi.ts\|.d.ts"
  ```
  Expect zero. (These route via `builder:` route IDs from the dead builder window only.)

- [ ] **Step 2: Delete the interface file.**
  ```bash
  rm pkg/wshrpc/wshrpctypes_builder.go
  ```

- [ ] **Step 3: `wshrpctypes.go`** — remove the `// builder` comment (`:217`) and the `WshRpcBuilderInterface` embed line (`:218`).

- [ ] **Step 4: `wshserver.go`** — remove every builder impl. Grep the method names inside the file to find exact ranges, then delete each `func (ws *WshServer) <Name>(...)`:
  ```bash
  grep -n "func (ws \*WshServer) \(ListAllApps\|ListAllEditableApps\|ListAllAppFiles\|ReadAppFile\|WriteAppFile\|WriteAppGoFile\|DeleteAppFile\|RenameAppFile\|WriteAppSecretBindings\|DeleteBuilder\|StartBuilder\|StopBuilder\|RestartBuilderAndWait\|GetBuilderStatus\|GetBuilderOutput\|CheckGoVersion\|PublishApp\|MakeDraftFromLocal\)Command" pkg/wshrpc/wshserver/wshserver.go
  ```
  Delete those funcs (the cluster spans ~`:920-1200`). Also remove the `waveappstore`, `waveapputil`, `buildercontroller`, and `tsunami/build` imports (`:30,53,54,67`). **Check the `waveapp.log` reference at `~:2400`:** grep the enclosing func; if it is a builder/waveapp-only log getter with no live caller, remove it too — otherwise leave it and note.

- [ ] **Step 5: Regenerate + verify.** Run `task generate`, then Standard Verification (steps 2-5). `wshclient.go` and `wshclientapi.ts` must regenerate without the builder commands.

**Risk:** Medium. Trap: a builder impl might call a shared helper — only remove helpers grep-confirmed exclusive to builder impls.

---

## Task 4: Remove the tsunami block controller

**Files:**
- Delete: `pkg/blockcontroller/tsunamicontroller.go`
- Modify: `pkg/blockcontroller/blockcontroller.go`

- [ ] **Step 1: Confirm no cockpit path sets `controller:"tsunami"`.**
  ```bash
  grep -rn "\"tsunami\"\|BlockController_Tsunami\|MakeTsunamiController\|TsunamiController" pkg/ frontend/ cmd/ --include=*.go --include=*.ts --include=*.tsx | grep -v "tsunamicontroller.go\|/tsunami/\|aiprompts/"
  ```
  Expect only `blockcontroller.go` (the const, dispatch, type-check) — those are what this task removes.

- [ ] **Step 2: Delete the controller file.**
  ```bash
  rm pkg/blockcontroller/tsunamicontroller.go
  ```

- [ ] **Step 3: `blockcontroller.go`** — remove the `BlockController_Tsunami = "tsunami"` const (`:36`); remove the `case *TsunamiController: if controllerName != BlockController_Tsunami { needsReplace = true }` arm in the controller-type-change switch (`:227-230`); remove the `case BlockController_Tsunami: controller = MakeTsunamiController(...); registerController(...)` arm in the create switch (`:274-276`). Keep the `default:` unknown-controller error.

- [ ] **Step 4: Verify.** Run Standard Verification (steps 2-3). After this, `buildercontroller`/`waveapp`/`waveapputil`/`tsunamiutil`/`waveappstore` are unimported but still present — the build is green (Go tolerates unimported packages).

**Risk:** Low-medium (boot-path file). No BOOT-VERIFY needed yet — Task 8 covers it.

---

## Task 5: Delete the orphaned provider packages

**Files:**
- Delete: `pkg/buildercontroller/`, `pkg/waveapp/`, `pkg/waveapputil/`, `pkg/tsunamiutil/`, `pkg/waveappstore/`

- [ ] **Step 1: Confirm zero importers** for each package:
  ```bash
  for p in buildercontroller waveapp waveapputil tsunamiutil waveappstore; do
    echo "=== $p ==="; grep -rn "wavetermdev/waveterm/pkg/$p\"" --include=*.go pkg cmd | grep -v "/$p/";
  done
  ```
  Every section must be empty. If any hit remains, fix that consumer first (it belongs to an earlier task).

- [ ] **Step 2: Delete the packages.**
  ```bash
  rm -rf pkg/buildercontroller pkg/waveapp pkg/waveapputil pkg/tsunamiutil pkg/waveappstore
  ```

- [ ] **Step 3: Verify.** Run Standard Verification (steps 2-3). Note: these packages import `tsunami/build`; the `tsunami/` module + `go.mod` replace still exist (removed in Task 7), so the build resolves.

**Risk:** Low. Pure package deletion gated by the import check.

---

## Task 6: Remove builder/tsunami types, events, config keys, and the electron-exec-path plumbing

**Files:**
- Modify: `pkg/waveobj/wtype.go`, `pkg/waveobj/wtypemeta.go`, `pkg/waveobj/metaconsts.go`, `pkg/waveobj/objrtinfo.go`
- Modify: `pkg/wps/wpstypes.go`, `pkg/tsgen/tsgenevent.go`
- Modify: `pkg/wconfig/metaconsts.go`, `pkg/wconfig/settingsconfig.go`
- Modify: `pkg/wavebase/wavebase.go`
- Regenerated: `frontend/types/gotypes.d.ts`, `frontend/types/waveevent.d.ts`, config schema

- [ ] **Step 1: `waveobj`** — remove `OType_Builder` from the const block (`wtype.go:35`) and from the `AllOTypes`/validity map (`wtype.go:50`); remove the six `Tsunami*` fields in `wtypemeta.go:145-150` and the matching `MetaKey_Tsunami*` consts in `metaconsts.go:141-146`; remove `TsunamiAppMeta`, `TsunamiSchemas`, `BuilderLayout`, `BuilderAppId`, `BuilderEnv` from `objrtinfo.go:7-8,22-24`.

- [ ] **Step 2: `wps` + `tsgen`** — in `wpstypes.go` remove the four event consts `Event_BuilderStatus`, `Event_BuilderOutput`, `Event_WaveAppAppGoUpdated`, `Event_TsunamiUpdateMeta` (`:22-23,32-33`) and their entries in the events slice (`:46-47,56-57`); in `tsgenevent.go` remove the four map registrations (`:29-30,39-40`).

- [ ] **Step 3: `wconfig`** — remove `ConfigKey_FeatureWaveAppBuilder` (`metaconsts.go:23`) + the five `ConfigKey_Tsunami*` (`:129-133`); remove `FeatureWaveAppBuilder` (`settingsconfig.go:75`) + the five `Tsunami*` struct fields (`:181-185`). Grep `feature:waveappbuilder` across `frontend/` first — confirm no surviving gate (expect only generated `gotypes.d.ts`).

- [ ] **Step 4: `wavebase`** — remove `WaveAppElectronExecPathVarName` (`:33`), `AppElectronExecPath_VarCache` (`:56`), the `os.Getenv`/`os.Unsetenv` lines at init (`:105-106`), and `GetWaveAppElectronExecPath` (`:138-139`). Grep `GetWaveAppElectronExecPath\|WAVETERM_ELECTRONEXECPATH` repo-wide to confirm zero remaining callers (the two consumers were deleted in Tasks 4-5).

- [ ] **Step 5: Regenerate + verify.** Run `task generate`, then full Standard Verification (steps 1-6, **BOOT-VERIFY** — config schema + event types changed; confirm the cockpit boots and the settings surface renders). Re-check `TestGenerateWaveEventTypes`: removing events changes generator output; if the test now legitimately reflects the reduced event set, regenerate/update its fixture — but do not mask a NEW unrelated failure.

**Risk:** Medium-high. Config schema drives settings load. Mitigation: BOOT-VERIFY settings render; the grep gate in Step 3.

---

## Task 7: Delete the `tsunami/` module and its build wiring

**Files:**
- Delete: `tsunami/` (directory)
- Modify: `go.mod` (require `:33`, replace `:93`), `go.sum` (via tidy)
- Modify: `Taskfile.yml`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Confirm nothing in the main module imports `tsunami/`.**
  ```bash
  grep -rn "wavetermdev/waveterm/tsunami" --include=*.go pkg cmd src-tauri
  ```
  Expect zero (all `tsunami/build` importers were removed in Tasks 2-5).

- [ ] **Step 2: Delete the module + go.mod entries.**
  ```bash
  rm -rf tsunami
  ```
  In `go.mod`, delete the require line (`github.com/wavetermdev/waveterm/tsunami v0.12.3`, `:33`) and the replace line (`replace github.com/wavetermdev/waveterm/tsunami => ./tsunami`, `:93`). Then:
  ```bash
  go mod tidy
  ```

- [ ] **Step 3: `Taskfile.yml`** — remove the `build:tsunamiscaffold` task (`:297`+) and its listing in `tauri:dev` deps (`:26`); remove the `dist/tsunamiscaffold` packaging; remove all standalone `tsunami:*` targets (`tsunami:demo:todo`, `tsunami:frontend:*`, `tsunami:scaffold*`, `tsunami:build`, `tsunami:clean`, `tsunami:godoc` — `:472-608`); remove the `tsunami/**/*.go`, `tsunami/go.mod`, `tsunami/go.sum` entries from any `sources:`/watch globs.

- [ ] **Step 4: `CLAUDE.md`** — remove the "### 4. tsunami" architecture section and the "four layers" framing (adjust to three), plus the `task build:tsunamiscaffold` mentions in the build-flow prose.

- [ ] **Step 5: Verify.** Run:
  ```bash
  go build ./...
  ```
  (must exit 0 — proves the module is fully unreferenced), then full Standard Verification (steps 1-6, **BOOT-VERIFY**). Confirm `task dev` still resolves its deps (the `build:tsunamiscaffold` dep is gone) and the cockpit boots.

**Risk:** Medium. `go mod tidy` + Taskfile edits. Mitigation: `go build ./...` and a clean `task dev` boot.

---

## Task 8: Part 1 final verification + commit

- [ ] **Step 1: Full sweep for residue.**
  ```bash
  grep -rni "tsunami\|buildercontroller\|waveappstore\|waveapputil\|builderId\|WaveAppBuilder" pkg cmd frontend/app src-tauri --include=*.go --include=*.ts --include=*.tsx | grep -v ".d.ts\|wshclientapi.ts\|aiprompts/"
  ```
  Expect zero (or only intentional survivors you can name).

- [ ] **Step 2: Full Standard Verification, all six steps, BOOT-VERIFY including a real AI/Jarvis chat turn** (proves the aiusechat surgery preserved chat behavior).

- [ ] **Step 3: Present the batched diff + proposed message for approval.** Do NOT commit without explicit approval. Proposed message:
  ```
  refactor: retire the builder/tsunami widget-app subsystem

  Remove the unreachable builder/tsunami widget-app path in full: the
  tsunami block controller, buildercontroller/waveapp/waveapputil/
  tsunamiutil/waveappstore packages, the aiusechat builder mode, the
  builder wshrpc surface, OType_Builder + tsunami/builder meta/rtinfo/
  events, the tsunami config keys, the frontend builder window-type,
  the WAVETERM_ELECTRONEXECPATH plumbing, and the tsunami/ module +
  build wiring. Behavior-preserving (builderMode was always false in
  the cockpit). Regenerated bindings.
  ```
  Include the design spec (`docs/superpowers/specs/2026-07-16-tsunami-builder-retirement-design.md`) and this plan in the same commit (spec/plan fold into the feature commit per project rules).

---

# PART 2 — Dead config keys

## Task 9: Remove the ten dead `window:*` / `app:*` config keys

Grep-confirmed zero readers in frontend, Go, and Rust — all ten are safe. Independent of Part 1.

**Files:**
- Modify: `pkg/wconfig/metaconsts.go`, `pkg/wconfig/settingsconfig.go`, `pkg/wconfig/defaultconfig/settings.json`
- Regenerated: `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Re-confirm zero readers** (defense in depth):
  ```bash
  for k in "window:zoom" "window:opacity" "window:blur" "window:dimensions" "window:savelastwindow" "window:fullscreenonlaunch" "window:maxtabcachesize" "app:globalhotkey" "app:confirmquit" "app:tabbar"; do
    echo "=== $k ==="; grep -rn "$k" pkg src-tauri cmd frontend --include=*.go --include=*.rs --include=*.ts --include=*.tsx | grep -v "_test.go\|gotypes.d.ts\|metaconsts.go\|settingsconfig.go\|defaultconfig/settings.json";
  done
  ```
  Every section must be empty. If any key has a live reader, **leave that key and note it** (false-positive breaks the app).

- [ ] **Step 2: `metaconsts.go`** — remove the ten `ConfigKey_*` consts: `ConfigKey_WindowZoom` (`:114`), `ConfigKey_WindowOpacity` (`:102`), `ConfigKey_WindowBlur` (`:101`), `ConfigKey_WindowDimensions` (`:113`), `ConfigKey_WindowSaveLastWindow` (`:112`), `ConfigKey_WindowFullscreenOnLaunch` (`:99`), `ConfigKey_WindowMaxTabCacheSize` (`:106`), `ConfigKey_AppGlobalHotkey` (`:10`), `ConfigKey_AppConfirmQuit` (`:15`), `ConfigKey_AppTabBar` (`:20`).

- [ ] **Step 3: `settingsconfig.go`** — remove the ten struct fields: `WindowZoom` (`:166`), `WindowOpacity` (`:154`), `WindowBlur` (`:153`), `WindowDimensions` (`:165`), `WindowSaveLastWindow` (`:164`), `WindowFullscreenOnLaunch` (`:151`), `WindowMaxTabCacheSize` (`:158`), `AppGlobalHotkey` (`:62`), `AppConfirmQuit` (`:67`), `AppTabBar` (`:72`).

- [ ] **Step 4: `defaultconfig/settings.json`** — remove the five default entries that exist: `"app:tabbar"` (`:7`), `"app:confirmquit"` (`:9`), `"window:maxtabcachesize"` (`:25`), `"window:fullscreenonlaunch"` (`:29`), `"window:savelastwindow"` (`:32`). Fix trailing-comma/JSON validity after removal.

- [ ] **Step 5: Regenerate + verify.** Run `task generate`, then full Standard Verification (steps 1-6, **BOOT-VERIFY** — confirm the cockpit boots and the settings surface renders; the config struct changed).

- [ ] **Step 6: Present diff + proposed message for approval** (second and final commit):
  ```
  refactor(config): remove dead window:*/app:* config keys

  Remove ten config keys with zero readers in frontend, Go, or Tauri:
  window:{zoom,opacity,blur,dimensions,savelastwindow,fullscreenonlaunch,
  maxtabcachesize} and app:{globalhotkey,confirmquit,tabbar}. Dropped the
  five that shipped defaults in defaultconfig/settings.json. Regenerated
  bindings.
  ```

**Risk:** Low-medium. Config schema change. Mitigation: the per-key grep gate + BOOT-VERIFY settings render.

---

## Self-Review Notes

- **Spec coverage:** Part 1 §A → Tasks 2 (aiusechat), 3 (wshrpc), 4 (blockcontroller); §B → Task 5; §C → Task 6; §D (wavebase/ElectronExecPath) → Task 6 Step 4; §E (frontend) → Task 1; §F (module+build) → Task 7; §G (regenerate) → after each wire-type task. Part 2 → Task 9. Verification/invariants/risks map to the Standard Verification block + per-task risk notes.
- **Ordering rationale:** consumers before providers so Go always compiles (aiusechat & wshserver & blockcontroller drop their imports → provider packages become unreferenced → deleted → types/events/config pruned → module nuked). FE removal (Task 1) is independent and placed first. Config keys (Part 2) are fully independent and could run before or after Part 1.
- **No new tests:** deletion is behavior-preserving; the guard is grep-gates + the existing test suite + BOOT-VERIFY (including a live chat turn for the one live-code surgery). Adding unit tests for removed code would be theater (YAGNI).
- **Deliberately deferred to implementation-time grep (not asserted here):** exact `wshserver.go` builder-impl line ranges (Task 3 Step 4 greps them), the `waveapp.log` getter at `~:2400` (Task 3 Step 4), and any `getWaveWindowType()` `"builder"` switch consumers (Task 1 Step 1).
