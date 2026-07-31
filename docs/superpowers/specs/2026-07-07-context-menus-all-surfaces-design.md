# Context Menus Across Cockpit Surfaces — Design

**Date:** 2026-07-07
**Status:** Approved (design), pending plan
**Builds on:** `docs/superpowers/specs/2026-07-07-right-click-context-menu-design.md` (the themed menu infrastructure, shipped).

## Goal

Extend right-click context menus to the cockpit surfaces that lack them, and curate the item sets so each menu offers the *useful* actions (notably a copy group, absent everywhere today) without over-stuffing.

Add menus to **5 surfaces**: Channels, Activity, Files, Sessions, Memory.
Re-curate **3 existing** cockpit menus: card, agent header, transcript.

Out of scope: Usage and Settings (display-only / config-form — no per-row data to act on); the upstream block-view menus (terminal, preview, process viewer — already comprehensive, not cockpit "tabs"); menus on the 5 Channels *message-row* kinds (they already carry inline answer/override/deliver affordances).

## Architecture

Unchanged from the shipped feature. Each right-clickable row gets an `onContextMenu={(e) => ContextMenuModel.getInstance().showContextMenu(items, e)}` handler. The themed `<ContextMenuHost/>` (already mounted in `cockpit-root`) renders the panel. **Every menu item reuses a handler the surface already calls** for a button/click — a right-click never introduces a new backend call. This is the same pattern the card menu (Task 5 of the prior plan) used.

No new store, no new component, no changes to `contextmenu.ts` / `contextmenu.tsx`. Pure additions of `onContextMenu` handlers (and small item-builder functions) inside each surface file.

## House style

Consistent item ordering across every cockpit row menu:

1. **Primary action** — what the row's main click/button does (Open / Jump / Resume).
2. **Secondary navigation** — Open terminal, Review changes, etc.
3. **Copy group** — Copy name / path / summary. The biggest gap today; no cockpit menu offers copy.
4. **Toggles / state** — Full width, Mute/Background, Set tier.
5. **Separator, then destructive last** — Delete / Close.

Items that depend on optional data use `visible`/`enabled` (from the `ContextMenuItem` type, `frontend/types/custom.d.ts:153`) rather than being conditionally pushed, where that reads more clearly; conditional-push is also acceptable (matches existing code).

## New surface menus

### Activity — event row (`activitysurface.tsx:162`)
Row data `ActivityEvent`: `agentName, project, type, ts, text, sessionPath, live, liveId`. Wired: `jump(model, e)` (module-local, live-only).

| # | Item | Action | Condition |
|---|------|--------|-----------|
| 1 | Jump to agent | `jump(model, e)` | only if `e.live` |
| 2 | Filter to "{type}" | set `model.activityFilterAtom` to `e.type` | always |
| 3 | Copy summary | `navigator.clipboard.writeText(e.text)` | always |
| 4 | Copy project | `navigator.clipboard.writeText(e.project)` | always |

### Files — changed-file row (`FileRow`, rendered at `filessurface.tsx:412`)
Row data `GitChange`: `path, status, adds, dels`; `state.cwd` (worktree root) in scope. Row-click already opens the diff (`selectFile`), so the menu adds what click can't. Wired: `getApi().openExternal`.

| # | Item | Action |
|---|------|--------|
| 1 | Open in editor | `getApi().openExternal(`${cwd}/${c.path}`)` |
| 2 | Copy path | `navigator.clipboard.writeText(c.path)` |
| 3 | Copy absolute path | `navigator.clipboard.writeText(`${cwd}/${c.path}`)` |

### Sessions — session row (`sessionssurface.tsx:164`)
Row data `SessionInfo`: `runtime, projectpath, projectname, branch, task, model, tokenstotal, resumecommand`. Wired: `resume(s)` (module-local, guarded by `resumecommand`).

| # | Item | Action | Condition |
|---|------|--------|-----------|
| 1 | Resume | `resume(s)` | `enabled: !!s.resumecommand` |
| 2 | Copy resume command | `navigator.clipboard.writeText(s.resumecommand)` | only if `resumecommand` |
| 3 | Copy project path | `navigator.clipboard.writeText(s.projectpath)` | always |

### Memory — note list-row (`memorysurface.tsx:134`)
Row data `MemNote`: `id, title, description, type, path, links`. Wired: `selectNote(id)`, `deleteNote(path)` (both imported store actions).

| # | Item | Action |
|---|------|--------|
| 1 | Open | `fireAndForget(() => selectNote(n.id))` |
| 2 | Copy title | `navigator.clipboard.writeText(n.title)` |
| 3 | Copy path | `navigator.clipboard.writeText(n.path)` |
| 4 | — separator — | |
| 5 | Delete | `fireAndForget(() => deleteNote(n.path))` |

**Decision:** Delete keeps parity with the existing detail-rail Delete button (no confirm). Flagged as a mis-fire risk; revisit if it bites.

### Channels — two row menus
Deliberately scoped to the two clean row kinds; message rows keep their inline affordances.

**Channel-rail row** (`channelrail.tsx:55`). Data `Channel`: `oid, name, meta.tier, projectpath`. Wired: `selectChannel(oid)`, `deleteChannel(oid)`, `RpcApi.SetChannelTierCommand`.

| # | Item | Action |
|---|------|--------|
| 1 | Open | `selectChannel(c.oid)` |
| 2 | Tier ▸ | submenu: Concierge / Gatekeeper / Delegator → `SetChannelTierCommand`; `checkbox` marks current `c.meta.tier` |
| 3 | — separator — | |
| 4 | Delete channel | `deleteChannel(c.oid)` |

**Worker row** (`channelsprimitives.tsx:113`). Data `WorkerState`: `oref (tab:<id>), name, state`. Wired: `jumpToAgent`.

| # | Item | Action | Condition |
|---|------|--------|-----------|
| 1 | Open agent | `jumpToAgent(model, w.oref.slice("tab:".length))` | `enabled: w.state !== "gone"` |

## Re-curated existing menus

- **Card** (`agentrow.tsx:221`): keep all current items (Open / Open terminal / [Review changes] / [Full width] / [Mute|Dismiss] / — / Close). **Add** `Copy name` (`navigator.clipboard.writeText(agent.name)`) as a copy group before the separator. Fills the missing-copy gap.
- **Agent header** (`agentheader.tsx:63`): no change. Interrupt / Fullscreen / Show details / — / Close is already tight; no cuts identified, no missing action with a wired handler.
- **Transcript** (`narrationtimeline.tsx:65`): keep `Copy text`; **add** `Copy conversation` — joins the text of all `message`/`user` entries in the local `items` array. Reuses already-computed state; no plumbing.

## Testing / verification

- **CDP visual check per surface** (the repo has no jsdom render harness for the cockpit): right-click a row on each of the 5 surfaces + the re-curated 3, confirm the themed panel shows the specified items and each action fires. `node scripts/cdp-shot.mjs <name>.png`; inject data first with `node scripts/inject-live-agents.mjs <scenario>` where a surface is empty.
- **Unit test** only where there is pure logic worth pinning: the transcript "Copy conversation" join is a pure function of `items` → extract it as a tiny helper and unit-test it (input entries → joined string). The rest is view wiring with no pure branch to assert.
- **Typecheck** clean: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.
- **Full suite** green: `npx vitest run`.

## Files touched

- `frontend/app/view/agents/activitysurface.tsx` — event-row menu.
- `frontend/app/view/agents/filessurface.tsx` — changed-file-row menu.
- `frontend/app/view/agents/sessionssurface.tsx` — session-row menu.
- `frontend/app/view/agents/memorysurface.tsx` — note-row menu.
- `frontend/app/view/agents/channelssurface.tsx` + `channelrail.tsx` + `channelsprimitives.tsx` — channel-rail and worker-row menus.
- `frontend/app/view/agents/agentrow.tsx` — add `Copy name`.
- `frontend/app/view/agents/narrationtimeline.tsx` — add `Copy conversation` (+ extract join helper for the unit test).

## Notes / deferred

- **Usage / Settings menus** — deferred (no per-row data). Revisit only if a concrete action emerges.
- **Channels message-row menus** — deferred; inline affordances cover the actions today.
- **Memory delete confirm** — parity with existing (no confirm). Revisit if mis-fires happen.
- **Files review-mode & source-picker rows** — the browse changed-file row is the primary target; review/source-picker rows deferred unless requested.
