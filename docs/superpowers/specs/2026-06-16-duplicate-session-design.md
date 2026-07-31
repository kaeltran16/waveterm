# Duplicate Session — Design Spec

**Date:** 2026-06-16
**Status:** Design (awaiting review → implementation plan)
**Surface:** Session sidebar (left tab bar), building on Phases 1–3 + subagent visibility.

## 1. Goal

Let a session row clone itself: one action opens a **new tab running the same agent in the same repo** as the source session — no picker, no configuration, no choices. This kills the most repetitive step in the launch half of the multi-agent outer loop (open tab → `cd` → start agent) for the common case of "I want a second agent on the work I'm already in" or "fork a second line of work."

This is the minimal, first slice of the "Session Launcher" direction. Quick-launch into an *arbitrary* repo (a picker), launch presets, and a task backlog were explicitly **deferred** during brainstorming as over-built for the current need.

## 2. The feature (UX)

- **Trigger:** right-click a session row → a context menu (matching the brainstorm mockup): **Rename** · **Pin/Unpin** · **Duplicate session** · ─── · **Close tab**. No hover icon — the row keeps double-click-to-rename and the hover pin as shortcuts; the menu is the discoverable home for all four. Rename and Pin/Unpin reuse the sidebar's existing handlers (`renameSession` → `session:label`, `togglePin` → `session:pinned`); Close tab uses the existing `getApi().closeTab(...)` path; only **Duplicate session** is new behavior.
- **On click:** a new tab is created and becomes active, containing a single terminal block configured exactly like the source session's terminal block. If the source auto-launches an agent (e.g. `claude`), the clone does too; if the source is a plain shell, the clone is a plain shell already `cd`'d to the same directory (graceful degradation — never an error).
- **Result in the sidebar:** the clone appears as a new row in the **same cwd/service group** as the source (grouping derives from `cmd:cwd`, which is copied), with the same agent identity. It starts with its auto label (a custom rename on the source is **not** copied, to avoid two identically-named rows).

## 3. Architecture / data flow

```
right-click row
  → SessionSidebar builds a ContextMenuItem[]:
        Rename         → trigger the row's inline rename (session:label)
        Pin / Unpin    → togglePin(tabId, pinned)            // label by current state
        Duplicate      → duplicateSession(tabId)             // steps below; gated on termBlockOref
        ───────
        Close tab      → getApi().closeTab(workspaceId, tabId, false)
  → ContextMenuModel.getInstance().showContextMenu(menu, e)

duplicateSession(sourceTabId):
        1. resolve source tab → its terminal block (view==="term" && meta["cmd:cwd"])
        2. buildDuplicateBlockMeta(sourceBlockMeta) → new block def meta (whitelist copy)
        3. WorkspaceService.CreateTab(workspaceId, "", activateTab=true) → newTabId
        4. createBlock(newBlockDef)            // into the now-active new tab
        5. SetMetaCommand(tab:newTabId, { "session:agent": <copied> })
```

Everything composes primitives that already exist; no new RPC, no new event, no backend change.

### What gets copied (single source of truth = the source terminal block)

Duplicate **reproduces the source terminal block** rather than inventing an agent→command map. From the source block's `meta`, copy the launch-relevant keys into the new block def:

| Key | Why |
|---|---|
| `view` (`"term"`) | it's a terminal session |
| `controller` (`"shell"` \| `"cmd"`) | preserves how it runs |
| `cmd` | the agent/command the source launches (absent for a plain shell) |
| `cmd:args` | command args, if any |
| `cmd:cwd` | the repo — also what the sidebar groups on |
| `cmd:interactive` | preserves interactive launch |
| `connection` | preserves remote/SSH host so the cwd resolves correctly |

From the source **tab** meta, copy `session:agent` (so the cloned row shows the same agent identity). Do **not** copy `session:label` (avoid duplicate custom names) or `session:pinned` (a clone shouldn't inherit pin state).

This is simpler and more correct than a hardcoded `claude→claude` map: the clone does whatever the source does. The earlier "derive command from `session:agent`" idea is dropped (YAGNI) — the source block already holds the command.

## 4. Files touched

| File | Change |
|---|---|
| `frontend/app/tab/sessionsidebar/sessionviewmodel.ts` | **Add** the pure `buildDuplicateBlockMeta(sourceBlockMeta)` that whitelists the launch keys above into a new block-def `meta`. Lives here (the React/Wave-free pure module) so it is unit-testable, matching the existing pure-function pattern. |
| `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts` | **Add** `duplicateSession(sourceTabId)` (wiring): resolve source term block, call `buildDuplicateBlockMeta`, `WorkspaceService.CreateTab`, `createBlock`, `SetMetaCommand`. |
| `frontend/app/tab/sessionsidebar/sessionrow.tsx` | **Add** an optional `onContextMenu?: (e) => void` prop to `SessionRow` wired to the row `<div>`. Expose the inline-rename trigger via a `renameRef` (mirroring the existing `tab.tsx` / `buildTabContextMenu` pattern) so the menu's "Rename" can start the same inline edit double-click uses. |
| `frontend/app/tab/sessionsidebar/sessionsidebar.tsx` | In `SessionRowTree`, build the full `ContextMenuItem[]` (Rename, Pin/Unpin, Duplicate session, separator, Close tab) wired to the existing handlers (`renameSession`/`togglePin`/`getApi().closeTab`) + `duplicateSession`, and show via `ContextMenuModel.getInstance().showContextMenu(menu, e)`. Gate the **Duplicate session** item on `row.termBlockOref`. |

`SessionRowVM` already exposes `termBlockOref`, so the row knows whether it has a duplicable terminal block.

## 5. Behavior & edge cases

- **No terminal block** (a session with no `cmd:cwd` term block): omit the "Duplicate session" item (or no-op). The VM's `termBlockOref` is the gate.
- **Plain shell source** (no `cmd`): clone is a shell already `cd`'d to the cwd. Useful, not a failure.
- **Remote session** (`connection` set): copied, so the clone runs on the same host.
- **Agent mid-conversation:** the clone starts a *fresh* agent process — that's the intended "fork," not a transcript copy.
- **Active tab:** the new tab is activated on creation (matches "I want to work in the clone now").

## 6. Testing

- **Pure unit test** — `buildDuplicateBlockMeta(sourceMeta)`: table-driven over (a) `controller:"cmd"` agent source → copies `cmd`/`cmd:interactive`; (b) plain `controller:"shell"` source → no `cmd`, keeps `cmd:cwd`; (c) remote source → copies `connection`; (d) ensures excluded keys (`session:label`, `session:pinned`, view-unrelated meta) are not carried. This is the logic worth locking; it has no Wave/React deps.
- **Render test** — `SessionRow` invokes `onContextMenu` on right-click (renderToStaticMarkup / handler spy, matching `sessionrow.test.tsx` conventions).
- **Live verification** — the wiring (`CreateTab` → `createBlock` → `SetMetaCommand`, and the context-menu trigger) is verified live over CDP (`:9222`), matching how Phases 1–3 verified atom/RPC wiring. Confirm: right-click a session → Duplicate → new active tab with a terminal in the same cwd; for an agent session the agent relaunches; the clone appears in the same group; a plain-shell session clones as a shell in the cwd.

## 7. Open implementation question (resolve in the plan)

`createBlock` (`frontend/app/store/global.ts:408`) inserts into the **active static tab's** layout model (`getLayoutModelForStaticTab()`). After `WorkspaceService.CreateTab(..., activateTab=true)` the new tab becomes active, but the plan must confirm the new tab's layout model is initialized before `createBlock` runs — and, if there's a race, use the correct ordering (e.g. await the active-tab switch) or a backend path that creates the block in a specified tab. **This is the primary implementation risk**; everything else is straightforward composition.

## 8. Out of scope (YAGNI)

- Hover-icon affordance on the row (context-menu only).
- Repo/agent picker, launch presets, kickoff-prompt presets, task backlog (deferred from brainstorming).
- Duplicating a full multi-block tab layout — v1 clones the session's terminal/agent block only.
- Cross-workspace duplication.
- Copying the live agent transcript/state — the clone is a fresh process.
