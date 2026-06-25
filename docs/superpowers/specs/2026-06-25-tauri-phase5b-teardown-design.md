# Tauri Migration — Phase 5b Frontend-Teardown Spec

> Captured 2026-06-25. The fifth phase sub-spec under
> [`tauri-migration-meta-spec.md`](../../tauri-migration-meta-spec.md), following
> [`2026-06-24-tauri-phase5a-boot-cockpit-design.md`](./2026-06-24-tauri-phase5a-boot-cockpit-design.md).
> Covers the **second half** of meta spec §8 row **"5 · Frontend teardown"**: 5a booted the
> real cockpit with the old machinery *dormant*; 5b deletes the now-provably-dead machinery,
> performs the Phase 2 consumer-flips, and unifies the build entry. Per meta spec §12 this spec
> is the input to the Phase 5b plan (`writing-plans → executing-plans`).
>
> **Revision note (planning pass):** the implementation plan's code-level investigation corrected
> three design points from the first draft — the block engine is **slimmed, not deleted** (the
> cockpit terminal renders VDOM via `SubBlock`→`makeViewModel`); `keymodel.ts` is **kept** (a
> shared module with live consumers incl. `term-model`'s `appHandleKeyDown`), only its
> deleted-tree imports are pruned; and `ContextMenuModel` is **rewritten internally** to delegate
> to `buildTauriMenu` rather than deleted (its orphaned-view callers survive). These are folded in
> below.

## 1. Goal

Delete the Electron-era frontend machinery that 5a proved the cockpit boots without — the
block-tiling layout engine, the tab UI, `workspace.tsx`, `builder/`, `tsunami`, `<webview>`, the
block tiling-frame, and the Electron render entry — making the **Tauri cockpit the sole
frontend**. Perform the Phase 2 consumer-flips deferred from chrome work (route context menus
through `buildTauriMenu`; remove the chrome cut-methods + the dormant `setActiveTab`). Promote
`frontend/tauri/vite.config.ts` to the sole frontend renderer config.

The cockpit must boot and behave **identically** to its end-of-5a state after the teardown — the
phase removes code, it does not change cockpit behavior.

## 2. Guiding rule — separate live from dead, then delete

5b is **not** "`rm` six directories." Tracing actual import lines (this session's coupling scan)
shows the cockpit's own subsystems reach *into* the doomed trees: the agents roster imports
model/store files inside `app/tab/sessionsidebar/`; `term-model`, `keymodel`, `global.ts` import
symbols from the layout/workspace trees; the cockpit terminal renders VDOM through `SubBlock`,
which lives in `block.tsx` and uses `blockregistry`. So the deletion is gated on first **severing
those couplings** — relocating live code out of the doomed trees, slimming shared modules to
their cockpit-needed surface, and pruning Electron-only paths — *then* deleting the
genuinely-dead remainder.

This is the same make-it-work-then-delete logic that justified the 5a/5b split (meta spec T11),
applied one level down: establish a green "decoupled, nothing deleted yet" checkpoint so any
later breakage is unambiguously a deletion mistake, never a missed decoupling.

## 3. Scope

**In scope (5b):**

- **Stage 1 — decouple & relocate** (§5.1): relocate the live session-model layer; extract the
  `NodeModel` type and split `SubBlock` to surviving modules; slim `blockregistry`; cut the
  AI-panel state off the term view; prune Electron-only paths from `global.ts`/`keymodel.ts`;
  flip `ContextMenuModel` to `buildTauriMenu`; remove the dormant `setActiveTab`.
- **Stage 2 — decouple observe-gate** (§5.2): the cockpit still boots/roster/terminal/chrome with
  nothing deleted yet.
- **Stage 3 — bulk delete** (§5.3): the orphaned trees + the Electron render entry + orphaned
  test files.
- **Stage 4 — vite/entry unification** (§5.4): remove the dead Electron renderer config; the
  Tauri vite config becomes the sole renderer config.

**Out of scope (→ Phase 4 unless noted):** `emain/` + electron-builder removal, the Tauri
bundler/signing/updater pipeline, and the `package.json` run/build-script repoint (Phase 4 owns
the run/package pipeline, §7); the standalone `frontend/preview/` dev harness (§7); the
non-term/non-agents block view types (`preview`, `processviewer`, `sysinfo`, `launcher`, `vdom`,
etc.), which are clean of doomed-tree imports and are **kept** as orphaned-but-compiling code
(§4); any redesign cockpit surfaces beyond the existing agents view. No new Rust and no new Go.

## 4. The coupling reality (corrected from the meta-spec estimate)

The meta spec sized 5b as a flat "~15.5k LOC delete." The scan refines that to four kinds of
work. Totals are `wc -l` estimates over the named trees; per-file evidence is cited in §5.

| Bucket | Approx LOC | What it is |
|---|---|---|
| **Clean delete** | ~14,000 | Reachable *only* via the dying Electron entry tree. Delete outright (§5.3). |
| **Clean relocate** | 839 | The `sessionsidebar` model/store layer the agents roster reads — **zero** imports back into any doomed tree (§5.1.1). A move, not a rewrite. |
| **Slim / split** | small | `blockregistry` slimmed; `SubBlock` split out of `block.tsx`; `NodeModel` type extracted (§5.1.2–5.1.4). |
| **Prune** | ~50–250 | Electron-only paths inside shared survivors `global.ts` / `keymodel.ts` / `term-model.ts` (§5.1.5–5.1.6). |

Confirmed **dead-anyway** (verified not cockpit-reachable; die in §5.3): `focusManager.ts`,
`tabrpcclient.ts`'s `TabClient`, `app/view/waveai/waveai.tsx`, `app/aipanel/*` (freed by §5.1.5),
`aitooluse.tsx`, `onboarding*.tsx`, `conntypeahead.tsx`, `modalregistry.tsx`. Confirmed **kept**
(clean, orphaned after `blockregistry` slims, or shared with live consumers): the
non-term/non-agents view types, `contextmenu.ts` (rewritten, §5.1.6), `keymodel.ts` (pruned,
§5.1.5), `blocktypes.ts` (NodeModel extracted in, §5.1.2).

## 5. The Phase 5b primitives

### 5.1 Stage 1 — decouple & relocate

#### 5.1.1 Relocate the live session-model layer (decision P5b-5)

`frontend/app/tab/sessionsidebar/` holds both dead UI and live model code. The live files have
**zero doomed-tree imports** — a clean stratum trapped in a dying directory:

| File | Cockpit importer |
|---|---|
| `sessionsidebarmodel.ts` | `liveagents.ts:11`, `keymodel.ts:24` |
| `sessionviewmodel.ts` (+ `sessionviewmodel.test.ts`) | `liveagents.ts:12`, `agentsviewmodel.ts:3`, `keymodel.ts:25` |
| `agentstatusstore.ts` | `liveagents.ts:10` |
| `sessiongroupstore.ts` | `sessionsidebarmodel.ts` |

Move these (and the test) to a surviving home (proposed `frontend/app/view/agents/session-models/`)
and update the importers. The dead UI in the same dir (`sessionsidebar.tsx`, `sessionrow.tsx`,
`sessionrow.test.tsx`) deletes in stage 3. (The `keymodel.ts` importers vanish if those keymodel
functions are pruned in §5.1.5; otherwise they repoint to the new home.)

#### 5.1.2 Extract the `NodeModel` type (decision P5b-6)

`blocktypes.ts:4` imports `NodeModel` from `@/layout/index` — a **type-only** use (in
`FullBlockProps`/`BlockProps`/`BlockFrameProps`). `blocktypes.ts` must survive (the cockpit's
`synthetic-node-model.ts`, the slimmed `blockregistry`, and `SubBlock` depend on it). Relocate
the `NodeModel` interface (`frontend/layout/lib/types.ts:382`) into a surviving type module so
`blocktypes.ts` no longer imports the dying layout tree.

#### 5.1.3 Split `SubBlock` out of `block.tsx` (decision P5b-6)

`term.tsx:5` imports `SubBlock` from `@/app/block/block` and renders it (lines 108, 153) for the
terminal's VDOM sub-block. `block.tsx` mixes the tiling-frame `Block` (uses `BlockFrame` +
`@/layout`) with the `SubBlock` chain (`getViewElem` + `BlockSubBlock` + `SubBlockInner` +
`SubBlock`, lines 29–333). Extract the `SubBlock` chain into a new `frontend/app/block/subblock.tsx`
and repoint `term.tsx`'s import. `SubBlock` keeps using `makeViewModel` (from the slimmed
`blockregistry`, §5.1.4) and does not import `BlockFrame` or `@/layout` — so the tiling-frame
remainder of `block.tsx` can be deleted in stage 3.

#### 5.1.4 Slim `blockregistry` (decision P5b-7)

`blockregistry.ts` statically imports **every** view model, which is what drags `webview`/`tsunami`
into the cockpit build. Remove the imports + `BlockRegistry.set(...)` entries for the views being
deleted — `web` (`WebViewModel`), `tsunami` (`TsunamiViewModel`), `help` (`HelpViewModel`), and
`waveai` (`WaveAiModel`, the dead-anyway block view). Keep the rest (`term`, `agents`, `vdom`,
`preview`, `sysinfo`/`cpuplot`, `tips`, `launcher`, `aifilediff`, `waveconfig`, `processviewer`) —
all clean of doomed-tree imports. `blockregistry` and `makeViewModel` survive; `focus-pane.tsx`
and `SubBlock` keep using them unchanged.

#### 5.1.5 Cut the AI-panel state; prune `global.ts` and `keymodel.ts`

- **AI-panel cut (decision P5b-4):** `term-model.ts` reaches the dying `WorkspaceLayoutModel` at
  two points — the AI-panel-gated shell button (`endIconButtons`, lines 288–294) and the "Send to
  Wave AI" context-menu item (lines 843–859). Both gate the per-terminal Wave AI side-panel, which
  the cockpit never mounts (its backing `setWaveAIOpen` + workspaces are already cut, meta spec §6).
  Remove both blocks; that removes the only live imports of `WorkspaceLayoutModel` (line 16) and
  `WaveAIModel` (line 4), moving `WorkspaceLayoutModel` and `app/aipanel/*` into the delete bucket.
- **`global.ts` prune:** `createBlock`, `createBlockSplitHorizontally`, `createBlockSplitVertically`,
  and `replaceBlock` (lines ~365–445) all call `getLayoutModelForStaticTab()` — tiling-tree
  operations the cockpit never uses (agent blocks are created via `ObjectService.CreateBlock`, the
  backend RPC, per `cockpit-actions.ts:12`). Remove them + the `@/layout` imports (lines 7–16), and
  remove `createBlock` from `waveenvimpl.ts:34` and the `WaveEnv` interface (`waveenv.ts`).
- **`keymodel.ts` prune (kept module):** `keymodel` is shared — live consumers after the teardown
  are `boot-core` (`registerControlShiftStateUpdateHandler`), `term-model.ts:6` (`appHandleKeyDown`),
  and `waveconfig`/`preview-edit` (`tryReinjectKey`). Keep it; remove only its dependence on deleted
  trees: delete the Electron-only `registerGlobalKeys` (line 521→end) and `registerElectronReinjectKeyHandler`
  (498–502) and any helper used only by them (e.g. `handleGitSplit`, `uxCloseBlock`, tiling-nav
  helpers); prune the `if (isTabWindow()) { getLayoutModelForStaticTab()… }` block in
  `appHandleKeyDown` (lines 470–484); remove the now-unused imports (`WorkspaceLayoutModel`:26,
  `@/layout`:27, the `createBlockSplit*`/`replaceBlock` names:9,10,20) and repoint the
  `sessionsidebar` imports (24–25) to the relocated home (or drop them if their only users were
  pruned). A `tsc --noEmit` sweep drives residual cleanup.

#### 5.1.6 Consumer-flips (deferred from Phase 2 §7)

- **Context menus → `buildTauriMenu`:** `term.tsx` has no `WaveEnv` in scope, and `ContextMenuModel`
  has many surviving (orphaned-view) callers, so flip the **implementation, not the call sites**:
  rewrite `ContextMenuModel.showContextMenu` (`contextmenu.ts`) to `await buildTauriMenu(menu)` +
  `.popup()`, dropping the Electron id-round-trip and `getApi().showContextMenu`. Every caller
  (cockpit-reachable `waveenvimpl`/`term.tsx` + orphaned views) then gets a working native menu
  with one edit. `contextmenu.ts` **survives** (rewritten); update `contextmenu.test.ts` to the
  new behavior. (`buildTauriMenu` lives in `frontend/tauri/menu.ts`; the app is Tauri-only now, so
  `contextmenu.ts` importing it is acceptable.)
- **Chrome cut-methods:** delete `updateWindowControlsOverlay` (+ its `app-bg.tsx` caller) and
  `onMenuItemAbout` (their callers die with the Electron tree). The `api.ts` `showContextMenu`/
  `onContextMenuClick` stubs are now unused but harmless — leave them (and their `api.test.ts`)
  to minimize churn; their removal is optional cleanup.
- **`setActiveTab`:** `agents.tsx:635` (`openTerminal`'s else branch) is dead — the `inlineTerminal`
  path above it (630–633) already replaced it. Remove the else branch + the `setActiveTab` import.

### 5.2 Stage 2 — decouple observe-gate (checkpoint)

With stage 1 complete and **nothing deleted yet**, run `npx tauri dev` and confirm the cockpit
still: boots into the shell, lists the real agent roster, renders the focused agent's terminal
inline (output + input round-trip), starts a new agent session, and retains Phase 2 chrome
(drag/min/max/close, zoom, fullscreen, right-click menu — now via `buildTauriMenu`). This green
baseline is the precondition for stage 3.

### 5.3 Stage 3 — bulk delete

Delete the orphaned trees and the Electron render entry:

- `frontend/layout/` (~4,083) — tiling engine.
- `frontend/app/workspace/` (~1,266) — incl. `workspace.tsx`, `workspace-layout-model.ts`,
  `widgets.tsx`, `widgetfilter.ts`/`.test.ts`.
- `frontend/builder/` (~2,753).
- `frontend/app/view/tsunami/`, `frontend/app/view/webview/` (+ its test), `frontend/app/view/helpview/`.
- `frontend/app/view/waveai/waveai.tsx`; `frontend/app/aipanel/*` (freed by §5.1.5 — confirm no
  surviving importer with `tsc`).
- `frontend/app/tab/` **minus** the relocated session-model files: tab bar/content/vtab +
  `sessionsidebar/{sessionsidebar.tsx, sessionrow.tsx, sessionrow.test.tsx}`.
- Block tiling-frame in `frontend/app/block/`: the `block.tsx` remainder (after the §5.1.3 split),
  `blockframe.tsx`, `blockframe-header.tsx`, `block-model.ts`, `connstatusoverlay.tsx`. **Keep**
  `blockregistry.ts` (slimmed), `blocktypes.ts`, `subblock.tsx`, `blockenv.ts`, `blockutil.ts`.
- Dead-anyway files (§4): `focusManager.ts`, `tabrpcclient.ts`, `aitooluse.tsx`, `onboarding*.tsx`,
  `conntypeahead.tsx`, `modalregistry.tsx` (verify each with `tsc` before deletion).
- **Electron render entry:** `frontend/wave.ts`, `frontend/app/app.tsx`, `frontend/index.html`.
- Orphaned test files importing any deleted module (delete or fix so `vitest` stays green).

A `tsc --noEmit` + `vitest run` sweep after the deletions surfaces any missed importer.

### 5.4 Stage 4 — vite / entry unification (decision P5b-1, P5b-2)

- Remove the dead `renderer` block from `electron.vite.config.ts` (its `index.html` input is
  deleted in §5.3). The `main`/`preload` blocks stay for Phase 4 to remove with `emain/`.
- The Tauri build already uses `frontend/tauri/vite.config.ts` (since Phase 0) — it is now the
  sole frontend renderer config by being the only one. Optionally drop its now-dead `@/layout` /
  `@/builder` aliases (harmless if left).
- **`package.json` run/build scripts are not touched in 5b** — they drive the dying `electron-vite`
  build; Phase 4 repoints them when it removes `emain/` + electron-builder. The dev workflow is
  `npx tauri dev` (working since Phase 0).

## 6. Verification (per meta spec §12)

- **Type/compile:** `npx tsc --noEmit -p tsconfig.json` clean after each stage-1 task and after the
  stage-3 deletions (the primary teardown safety net).
- **Unit:** `npx vitest run` — green after orphaned tests are deleted/fixed and `contextmenu.test.ts`
  is updated (§5.1.6). The relocated session-model files keep their behavior; no new logic.
- **Rust codegen:** `cargo check --manifest-path src-tauri/Cargo.toml` — no Rust changes, validates
  the build after config edits.
- **Observe-gates** (Windows dev Tauri app, [[cdp-verify-dev-app]]):
  - **Stage-2 gate** (§5.2) — decoupled cockpit, nothing deleted.
  - **Final gates 1–5** (same battery as 5a §7) after stages 3–4: boots → real roster → inline
    terminal (output + input) → new agent session → Phase 2 chrome → no `[tauri-bridge] stub
    called:` on the happy path.

## 7. Deferred / out of scope

- **`emain/` + electron-builder removal**, the Tauri bundler/signing/updater pipeline, and the
  `package.json` script repoint → **Phase 4**. The `feat/tauri-phase4-packaging` worktree (code
  Tasks 1–3 already green, build gates paused pending 5a/5b) **rebases onto post-5b
  `feat/tauri-migration`** and wires only bundler/signing on top of the unified vite config.
- **`frontend/preview/`** — a standalone dev/preview server (its own `vite.config.ts`, port 7007),
  in neither production build. It imports components deleted here, so it will no longer run;
  deletion is **deferred** as optional cleanup. Flagged so its breakage is expected.
- **Non-term/non-agents block views + `contextmenu.ts`** — kept (clean / shared). Mass deletion of
  unused views is a separate future cleanup, not the Electron-shell teardown.

## 8. Risks

- **Term view is the cockpit's core surface.** Stage-1 surgery (`SubBlock` split, AI-panel cut,
  `blockregistry` slim) carries the real regression risk. Mitigation: the stage-2 gate proves the
  term view (incl. VDOM + context menu) before any deletion.
- **`keymodel.ts` is densely shared.** Pruning the wrong function breaks a live consumer.
  Mitigation: prune only the named Electron-only functions + the layout block; `tsc` + the gate
  catch over-pruning.
- **`global.ts` prune is delicate** (core module). Mitigation: agent creation uses the backend RPC
  (verified), not the pruned functions; `tsc` + the gate are the backstop.
- **Deletion-by-reachability.** `app/aipanel/*`, `tabrpcclient.ts`, etc. are deleted on "reachable
  only via X" evidence. Mitigation: `tsc` after each deletion surfaces any missed importer.

## 9. Layout (file disposition)

```
frontend/
  wave.ts | index.html | app/app.tsx          DELETE (Electron entry)
  layout/ | builder/ | app/workspace/          DELETE
  app/tab/                                     DELETE — except sessionsidebar model layer:
    sessionsidebar/{sessionsidebarmodel,sessionviewmodel(+test),
      agentstatusstore,sessiongroupstore}.ts   RELOCATE → app/view/agents/session-models/
  app/view/{tsunami,webview,helpview}/          DELETE
  app/view/waveai/waveai.tsx | app/aipanel/*    DELETE (dead-anyway / freed by §5.1.5)
  app/block/
    block.tsx                                  SPLIT — SubBlock chain → subblock.tsx (new);
                                                 tiling-frame remainder DELETE
    subblock.tsx (new)                         KEEP (uses makeViewModel)
    blockframe.tsx | blockframe-header.tsx
      | block-model.ts | connstatusoverlay.tsx DELETE (tiling frame)
    blockregistry.ts                           SLIM (drop web/waveai/help/tsunami)
    blocktypes.ts | blockenv.ts | blockutil.ts KEEP (NodeModel type extracted into blocktypes)
  app/store/
    global.ts                                  PRUNE (createBlock* / replaceBlock + @/layout imports)
    keymodel.ts                                PRUNE (registerGlobalKeys etc. + deleted-tree imports)
    contextmenu.ts (+ test)                    REWRITE (showContextMenu → buildTauriMenu)
    focusManager.ts | tabrpcclient.ts          DELETE (dead-anyway; verify)
  app/view/term/
    term-model.ts                              EDIT (cut AI-panel touchpoints §5.1.5)
    term.tsx                                   EDIT (import SubBlock from subblock.tsx)
  app/view/agents/agents.tsx                   EDIT (remove setActiveTab else-branch §5.1.6)
  app/{onboarding,modals}/*                    DELETE (dead-anyway)
  app/waveenv/{waveenv.ts,waveenvimpl.ts}      EDIT (drop createBlock from WaveEnv)
  <surviving NodeModel type module>            CREATE (§5.1.2)
electron.vite.config.ts                        EDIT (remove renderer block §5.4)
frontend/tauri/vite.config.ts                  KEEP (sole renderer config; optional alias cleanup)
src-tauri/                                     UNCHANGED (no new Rust)
```

## 10. Decision log

- **P5b-1 — Full Electron-entry delete:** delete `wave.ts`/`app.tsx`/`index.html` and the whole
  Electron-rendered tree; the cockpit is the sole frontend. The Electron renderer build stops
  working until Phase 4 removes `emain/`. *On Tauri now, nothing runs Electron. (Q1.)*
- **P5b-2 — Tauri vite config becomes the sole renderer config:** Phase 4 rebases onto it and adds
  bundler/signing + the `package.json` script repoint. *Single source of truth. (Q2.)*
- **P5b-3 — Staged decouple → gate → delete → unify:** an intra-phase observe-gate after the
  decouple, before any deletion. *Make-it-work-then-delete; isolates any breakage to the deletion.*
- **P5b-4 — Cut the AI-panel state, don't slim `WorkspaceLayoutModel`:** remove the two `term-model`
  touchpoints; delete `WorkspaceLayoutModel` + `app/aipanel/*`. *Slimming is more work, keeps a
  circular knot alive, and preserves a toggle for a panel the cockpit never mounts.*
- **P5b-5 — Relocate the 839-LOC session-model layer:** move, don't delete (zero doomed imports;
  the agents roster's live data source).
- **P5b-6 — Extract `NodeModel` type + split `SubBlock`** out of `block.tsx` (rather than relocate
  whole or delete). *The terminal renders VDOM via `SubBlock`; only the tiling-frame is dead.*
- **P5b-7 — Slim `blockregistry`, keep it (and the non-doomed views):** drop only the
  webview/tsunami/help/waveai registrations. *The registry is the static-import hub that drags
  `webview`/`tsunami` in; removing those four entries frees them while keeping `makeViewModel` for
  the term/agents/vdom path. (Corrects the first draft's "delete blockregistry.")*
- **P5b-8 — Flip `ContextMenuModel` internally, keep the file:** rewrite `showContextMenu` to use
  `buildTauriMenu`; don't edit every call site or delete `contextmenu.ts`. *Many orphaned-view
  callers survive; one implementation edit fixes them all and kills `getApi().showContextMenu`.*

## 11. Spec coverage

§2 rule (separate-then-delete) → §5.1/§5.2/§5.3 staging. §4 buckets → §5.1 (relocate/slim/split/
prune) + §5.3 (clean delete). Each stage-1 unit (§5.1.1–5.1.6) is gated by §5.2 and re-verified by
§6. Consumer-flips (§5.1.6) discharge the Phase 2 §7 deferrals (context menus,
`updateWindowControlsOverlay`, `onMenuItemAbout`, `setActiveTab`). §5.4 discharges meta spec §8's
"unify the Tauri vite entry." §7 maps every deferral to Phase 4 (incl. the worktree rebase) or to
out-of-scope. §8 risks each have a §5.2/§6 mitigation. §10 decisions trace to Q1/Q2 and the
planning-pass corrections. No new Rust/Go, per §3.
