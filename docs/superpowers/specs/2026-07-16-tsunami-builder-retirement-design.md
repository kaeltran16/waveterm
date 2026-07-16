# Tsunami/Builder Widget-App Retirement + Dead Config Keys — Design

**Date:** 2026-07-16
**Status:** Design (approved for planning)

## Goal

Finish the backend legacy-cleanup residue (the three items held back from the
2026-07-13 cleanup, `docs/superpowers/plans/2026-07-13-backend-legacy-cleanup.md`):

1. Retire the builder/tsunami "widget-app" subsystem **in full** — the wavesrv/frontend
   host integration **and** the standalone `tsunami/` Go module (CLAUDE.md's "Layer 4").
2. Resolve `WAVETERM_ELECTRONEXECPATH` (falls out for free — see below).
3. Remove the ten dead `window:*`/`app:*` config keys.

Net effect: a large reduction in backend/frontend surface with **no observable change**
in the cockpit.

## Why this is a deletion, not a feature change

The subsystem is **unreachable in the Tauri cockpit**, verified during brainstorming:

- **Builder windows never open.** The frontend `builder` window-type
  (`frontend/app/store/windowtype.ts`, `global-atoms.ts:18`) is gated on
  `initOpts.builderId`. Nothing sets `builderId` — not `src-tauri/` (zero hits), not the
  boot flow. Builder windows were separate Electron `BrowserWindow`s; that launch path
  died with Electron.
- **Tsunami blocks are never created.** No cockpit code sets `controller:"tsunami"`
  (frontend has zero non-generated `tsunami` references).
- **The AI tools are inert.** `generateToolsForTsunamiBlock` (`pkg/aiusechat/tools.go:186`)
  only fires when a `view:"tsunami"` block already exists in the tab — which never happens.
- **`builderMode` is always false.** In the live chat handler (`pkg/aiusechat/usechat.go`),
  `builderMode := req.BuilderId != ""`, and only the (dead) builder window ever sends
  `BuilderId`. So every builder branch in the live path is dead today.

**Central invariant:** because `builderMode` is always false and no tsunami/builder objects
are ever created, excising this code is behavior-preserving for everything the cockpit does.

`WAVETERM_ELECTRONEXECPATH` (`pkg/wavebase/wavebase.go`) is consumed only by
`buildercontroller.go:212` and `tsunamicontroller.go:169`. Both go away here, so the env-var
plumbing (`WaveAppElectronExecPathVarName`, `AppElectronExecPath_VarCache`,
`GetWaveAppElectronExecPath`) can be removed with them.

## Subsystem boundary (dependency map)

Confirmed by import-tracing. The subsystem is self-contained; the only edges into
still-live code are surgical:

- **Live-code edges (careful surgery, not whole-file deletion):**
  - `pkg/aiusechat/usechat.go` — the live cockpit chat handler has a woven-in builder mode.
  - `pkg/aiusechat/tools.go` — a `"tsunami"` case in an otherwise-general widget switch.
  - `pkg/wshrpc/wshserver/wshserver.go` — builder RPC impls alongside live RPCs.
  - `pkg/blockcontroller/blockcontroller.go` — a tsunami dispatch case alongside
    shell/cmd/durable controllers.
- **Self-contained packages (whole-package deletion):** `pkg/buildercontroller/`,
  `pkg/waveapp/`, `pkg/waveapputil/`, `pkg/tsunamiutil/`, `pkg/waveappstore/`,
  `pkg/blockcontroller/tsunamicontroller.go`, `pkg/aiusechat/tools_tsunami.go`,
  `pkg/aiusechat/tools_builder.go`.
- **The module:** `tsunami/` (own `go.mod`), imported only via `tsunami/build` by the four
  subsystem files above; pulled in by `go.mod:33` (require) + `go.mod:93` (replace).

**Confirmed independent (must stay untouched):**
- `pkg/secretstore` — grep-clean of `waveappstore`/`waveapp`; the "waveapp secrets" coupling
  the original cleanup worried about does not exist in `secretstore`.
- aiusechat general chat engine, block controllers (shell/cmd/durable), generic
  fileshare/RPC infra, `vdom` view, `aifilediff` view.

## Part 1 — Tsunami/builder retirement

### A. Consumers first (keep Go compiling; highest-care item leads)

**`pkg/aiusechat` (live code):**
- Delete `tools_tsunami.go`, `tools_builder.go`.
- `tools.go`: remove the `"tsunami"` desc case, `handleTsunamiBlockDesc`,
  `generateToolsForTsunamiBlock` and its call site (`:186-189`).
- `usechat.go`: excise builder mode — `BuilderMaxTokens` (`:40`); the `isBuilder`/`builderMode`
  params and branches in `getSystemPrompt` (`:49-50`) and `getWaveAISettings` (`:74-77`);
  the `BuilderId`/`BuilderAppId` request fields (`:627-628`) and their plumbing (`:659-714`);
  `BuilderAppGenerator` (`:426`) and `generateBuilderAppData` (`:846`); the RTInfo-from-BuilderId
  branch (`:664-665`); the `builderMode → premium` coupling (`:674`). Keep the general chat path.

**`pkg/wshrpc`:**
- `wshrpctypes.go`: remove `WshRpcBuilderInterface` (`:218`) and its embedding + all builder
  command declarations.
- `wshserver.go`: remove the builder impls (~`:1094-1166`) and the subsystem imports
  (`buildercontroller`, `waveapputil`, `waveappstore`, `tsunami/build`).
- Remove `BuilderStatusData` / `AppMeta` request/response types **only if** a grep shows them
  exclusive to removed commands.

**`pkg/blockcontroller`:**
- Delete `tsunamicontroller.go`.
- `blockcontroller.go`: remove the `BlockController_Tsunami` const (`:36`), the dispatch case
  (`:274-276`), and the `case *TsunamiController` branch in the controller-type-change check
  (`:227-230`).

### B. Provider packages (now unimported — whole-package deletion)

`pkg/buildercontroller/`, `pkg/waveapp/`, `pkg/waveapputil/`, `pkg/tsunamiutil/`,
`pkg/waveappstore/`.

### C. Types / events / config keys

- `pkg/waveobj`: `OType_Builder` (`wtype.go:35,50`); the six `Tsunami*` meta keys
  (`wtypemeta.go:145-150`, `metaconsts.go:141-146`); the `Tsunami*`/`Builder*` RTInfo fields
  (`objrtinfo.go:7-8,22-24`).
- `pkg/wps` (`wpstypes.go`) + `pkg/tsgen` (`tsgenevent.go`): `Event_BuilderStatus`,
  `Event_BuilderOutput`, `Event_TsunamiUpdateMeta` and their tsgen type registrations.
- `pkg/wconfig`: the five `tsunami:*` keys (`metaconsts.go:129-133`, `settingsconfig.go:181-185`)
  and `feature:waveappbuilder` (`metaconsts.go:23`, `settingsconfig.go:75`). Grep
  `defaultconfig/` + the config JSON schema for these keys and remove any references.

### D. `pkg/wavebase`

Remove `WaveAppElectronExecPathVarName` (`:33`), `AppElectronExecPath_VarCache` (`:56`), the
`os.Getenv`/`os.Unsetenv` at init (`:105-106`), and `GetWaveAppElectronExecPath` (`:138-139`).

### E. Frontend

Collapse the `builder` window-type to `"tab" | "preview"`:
- `windowtype.ts` — drop the `builder` union member and its helpers.
- `global-atoms.ts` — remove `builderIdAtom`/`builderAppIdAtom` (`:16-17,131-132`) and the
  `builder` branch (`:18`).
- `global-model.ts` — remove `builderId` (`:15,36`) and drop it from `GlobalInitOptions`.
- `wshrouter.ts` — remove `makeBuilderRouteId` (`:27-28`) and the builder route wiring.
- Preview mocks — `frontend/preview/mock/mockwaveenv.ts:160` (`builderId`) and
  `preview-electron-api.ts:19` (`showBuilderAppMenu`).

Leave the `preview` window-type alone — it is a separate concern from `builder`.

### F. The module + build

- Delete the `tsunami/` directory.
- Remove `go.mod:33` (require) + `go.mod:93` (replace); run `go mod tidy`.
- `Taskfile.yml`: remove `build:tsunamiscaffold` (`:297`) and its use in `build:backend`
  deps (`:26`), the `dist/tsunamiscaffold` packaging, and all standalone `tsunami:*` targets
  (`:472-608`) plus the `tsunami/**` source-watch entries.
- Update `CLAUDE.md` — remove the "Layer 4 / tsunami" architecture section and the
  `task build:tsunamiscaffold` references.

### G. Regenerate

Run `task generate` after the Go type changes (regenerates `wshclientapi.ts`, `gotypes.d.ts`,
`waveevent.d.ts`, `services.ts`). Never hand-edit generated files.

## Part 2 — Dead config keys (independent)

Remove the ten `window:*`/`app:*` keys with zero real readers (confirmed: the only frontend
hits are the generated `gotypes.d.ts`). Grep-gate each against Go readers before removing;
if any key has a live reader, leave it and note it.

`window:zoom`, `window:opacity`, `window:blur`, `window:dimensions`, `window:savelastwindow`,
`window:fullscreenonlaunch`, `window:maxtabcachesize`, `app:globalhotkey`, `app:confirmquit`,
`app:tabbar`.

Remove from `settingsconfig.go` + `metaconsts.go`. `app:tabbar` also ships a default in
`defaultconfig/settings.json` — remove that entry too. `task generate` afterward (config
types are generated).

## Invariants (must not break)

- aiusechat general chat path works end-to-end (a real chat turn succeeds post-surgery).
- `secretstore` untouched.
- shell/cmd/durable block controllers untouched.
- generic fileshare/RPC infra, `vdom`, `aifilediff` untouched.

## Verification

Run the original cleanup's Standard Verification, in order, all green:

1. `task generate` (after any Go type change).
2. `task build:backend` (wavesrv + wsh; exit 0).
3. `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/...`.
4. `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (exit 0 baseline).
5. `npx vitest run`.
6. **BOOT-VERIFY over CDP** (`node scripts/cdp-shot.mjs`): cockpit boots, terminal mounts,
   settings surface renders, no console errors, **and a real AI/Jarvis chat turn succeeds**
   (proves the aiusechat surgery is clean).

Additional, specific to this work:

- `go build ./...` after `go mod tidy` — proves the `tsunami/` module is fully unreferenced.
- Confirm `feature:waveappbuilder` has no surviving frontend gate before removing it.

## Risks

- **High — aiusechat `usechat.go` surgery** (live chat path). Mitigation: `builderMode` is
  always false today (behavior-preserving); the BOOT-VERIFY chat turn is the proof.
- **Medium — config schema changes** (settings load). Mitigation: per-key grep gate +
  BOOT-VERIFY settings render. When unsure about a key, leave it (false-negative is cheap;
  false-positive breaks the app).
- **Low — shared RPC types** (`BuilderStatusData`/`AppMeta`). Mitigation: remove only if grep
  shows exclusivity.

## Out of scope (explicit non-goals)

- Full aiusechat / Wave-AI removal — that is the separate Phase 6 effort. Here we only excise
  the builder-mode branches, not the chat engine.
- `secretstore` rewire (tracked separately).
- The `preview` window-type (distinct from `builder`).
- Any config key outside the ten listed in Part 2.

## Commit strategy

Two commits (per project git rules; spec folds into the Part 1 commit, not a docs-only commit):

1. **Part 1** — the tsunami/builder retirement (the large, higher-risk slice), including this
   spec doc.
2. **Part 2** — the dead config-key removal (independent, low-risk).

Both require explicit user approval before committing.
