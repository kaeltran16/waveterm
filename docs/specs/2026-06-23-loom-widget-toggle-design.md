# loom Widget + Ctrl:g Toggle — Design Spec

**Date:** 2026-06-23
**Base:** Extends the loom git integration (`docs/specs/2026-06-16-loom-git-integration-design.md`). That spec made `Ctrl:g` open loom as a horizontal term split scoped to the active session's repo, binary from `app:loombin`. This spec adds two things: a **loom launcher in the widgets bar** (alongside files/web/processes), and **toggle** behavior so `Ctrl:g` (and the widget) closes loom if it is already open.

## 1. Goal

- A loom icon in the widgets bar that launches loom exactly like `Ctrl:g`: a horizontal split beside the active session's terminal, cwd = that repo, binary = `app:loombin`.
- `Ctrl:g` toggles: press once to open loom, press again to close it. The widget click behaves identically.

## 2. Non-goals

- **No native Wave git view.** loom stays a hosted TUI term block; the diff UI is not reimplemented in React (carried over from the prior loom spec).
- **No new launch logic duplicated.** The widget reuses `handleGitSplit`; it does not re-derive cwd/binary resolution.
- **No config widget marker framework.** The single `app:loom` meta key is the only new identifier.
- **No toast / disabled state** when there is no active session terminal. The click stays a silent no-op, matching current `Ctrl:g`.

## 3. The `app:loom` marker

`MetaType` (TS) is closed and generated from the Go struct `MetaTSType`. A single new boolean block-meta key, `app:loom`, serves three roles:

1. **Widget routing.** The loom widget's `blockdef.meta["app:loom"]` tells `handleWidgetSelect` to route to `handleGitSplit()` instead of the generic `createBlock` path.
2. **Block identity.** `handleGitSplit` stamps the live loom block with `"app:loom": true` when it creates it.
3. **Toggle detection.** The toggle scans the active tab for a block carrying `app:loom` to decide open-vs-close.

This follows the existing fork precedent for the `session:*` keys (`wtypemeta.go:162-165`): add the field in Go, run `task generate`.

## 4. Toggle behavior

`handleGitSplit` becomes:

1. If a loom block is already open in the active tab (`findActiveLoomBlockId()` returns a blockId) → close it via the layout model and return.
2. Otherwise (current behavior): resolve the active session terminal (no-op if none) → build the loom blockdef, now stamped with `app:loom` → split horizontally beside the terminal.

Close reuses the established pattern from `keymodel.ts:173-176` (`getLayoutModelForStaticTab()` → `getNodeByBlockId` → `closeNode`). Focus behavior after close is inherited from `closeNode`.

## 5. Files changed

| File | Change |
| --- | --- |
| `pkg/waveobj/wtypemeta.go` | Add `AppLoom bool` field with `json:"app:loom,omitempty"` |
| `frontend/types/gotypes.d.ts`, `pkg/waveobj/metaconsts.go` | **Generated** by `task generate` — not hand-edited |
| `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts` | Add `findActiveLoomBlockId()` |
| `frontend/app/store/keymodel.ts` | `export` `handleGitSplit`; add toggle + marker stamp; import `findActiveLoomBlockId` |
| `pkg/wconfig/defaultconfig/widgets.json` | Add `defwidget@loom` |
| `frontend/app/workspace/widgets.tsx` | `handleWidgetSelect`: route `app:loom` widgets to `handleGitSplit()`; import it |

## 6. Edge cases

- **No active session terminal:** open path no-ops (unchanged). The close path still works regardless, since it only needs the loom block to exist.
- **loom already open, `Ctrl:g` pressed:** closes it (toggle), independent of whether there is a current session terminal.
- **`app:loombin` changed while loom is open:** close still works (it matches on the `app:loom` marker, not on the binary path).
- **Widget import cycle:** `widgets.tsx` importing `handleGitSplit` from `keymodel.ts` is safe — the call happens at click time, not module-eval time.
- **Config schema:** `schema/widgets.json` sets `blockdef.meta` to `additionalProperties: true` and only requires `blockdef` itself, so the minimal `{ meta: { "app:loom": true } }` validates with no schema regeneration and does not trigger `hasConfigErrors`.

## 7. Implementation

1. **`pkg/waveobj/wtypemeta.go`** — near the session fork fields, add:
   ```go
   // for loom git client (Wave Agent Sessions fork)
   AppLoom bool `json:"app:loom,omitempty"` // block (marks the live loom block for toggle)
   ```
2. **`task generate`** — regenerates `gotypes.d.ts` (`"app:loom"?: boolean` on `MetaType`) and `metaconsts.go` (`MetaKey_AppLoom = "app:loom"`).
3. **`sessionsidebarmodel.ts`** — add, mirroring `findActiveSessionTermBlock`:
   ```ts
   /** Find the active tab's loom block (stamped with app:loom), if open. */
   export function findActiveLoomBlockId(): string | undefined {
       const ws = globalStore.get(atoms.workspace);
       const activeId = ws?.activetabid;
       if (activeId == null) {
           return undefined;
       }
       const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", activeId)));
       for (const blockId of tab?.blockids ?? []) {
           const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
           if (block?.meta?.["app:loom"]) {
               return blockId;
           }
       }
       return undefined;
   }
   ```
4. **`keymodel.ts`** — import `findActiveLoomBlockId` (same import as `findActiveSessionTermBlock`); rewrite `handleGitSplit`:
   ```ts
   export async function handleGitSplit() {
       const existingLoom = findActiveLoomBlockId();
       if (existingLoom != null) {
           const layoutModel = getLayoutModelForStaticTab();
           const node = layoutModel.getNodeByBlockId(existingLoom);
           if (node) {
               fireAndForget(() => layoutModel.closeNode(node.id));
           }
           return;
       }
       const termBlock = findActiveSessionTermBlock();
       if (termBlock == null) {
           return;
       }
       const loomBin = loomBinOrDefault(globalStore.get(getSettingsKeyAtom("app:loombin")));
       const blockDef: BlockDef = {
           meta: {
               view: "term",
               controller: "cmd",
               cmd: loomBin,
               "cmd:interactive": true,
               "cmd:cwd": termBlock.cwd,
               "app:loom": true,
           },
       };
       await createBlockSplitHorizontally(blockDef, termBlock.blockId, "after");
   }
   ```
5. **`widgets.json`** — add after `defwidget@processviewer`:
   ```json
   "defwidget@loom": {
       "display:order": 0,
       "icon": "code-branch",
       "label": "loom",
       "blockdef": {
           "meta": {
               "app:loom": true
           }
       }
   }
   ```
6. **`widgets.tsx`** — import `handleGitSplit`; in `handleWidgetSelect`:
   ```ts
   async function handleWidgetSelect(widget: WidgetConfigType, env: WidgetsEnv) {
       const blockDef = widget.blockdef;
       if (blockDef?.meta?.["app:loom"]) {
           handleGitSplit();
           return;
       }
       env.createBlock(blockDef, widget.magnified);
   }
   ```

## 8. Manual test plan

1. Open a session in a git repo. Click the **loom** widget → loom opens as a split beside the terminal, showing that repo's status.
2. Click the loom widget again → loom closes.
3. Press `Ctrl:g` → loom opens. Press `Ctrl:g` again → loom closes.
4. Open loom via the widget, close via `Ctrl:g` (and vice-versa) → both find the same block.
5. With no terminal in the tab, click the widget / press `Ctrl:g` → nothing happens (no crash, no stray block).
6. Set `app:loombin` to an explicit path; reload; widget/`Ctrl:g` launches that binary. Open loom, change `app:loombin`, then `Ctrl:g` → still closes.
