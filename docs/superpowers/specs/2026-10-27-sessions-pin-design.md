# Sessions: pin a session

**Prototype:** `C:\Users\kael02\AppData\Local\arc-wt\de0bcda5\.superpowers\design\sessions-pin\project\Main.dc.html`
(boards: Main, the list with a Pinned group; Menu, the right-click menu; Search, a pinned match under search)

## Intent

Keep a few sessions (solo sessions or whole orchestrator runs) at the top of the Sessions list, whatever
their recency, so the ones the user keeps returning to are one glance away instead of a scroll through
Today and Earlier. A pin is a bookmark of the session, not of a tab: it holds for an ended session that has
no tab, and it lasts until the session ages out of the list's 30-day window.

## Context

- **The list** (`frontend/app/view/agents/sessionssurface.tsx`): "All activity", then the recency groups
  from `groupByRecency` (`sessionsarchivestore.ts`: Live now / Today / Earlier), paged across groups by
  `pageGroups`. A run is one `RunCard` (row key `run:<runId>`, `runSelKey`); every other session is a
  `SoloCard` (row key `${runtime}:${id}`, `sessionKey`). The rows the groups get are already filtered:
  `scopeRows` (project filter), `keepRow` (status filter), or `composeSearchRows` while a query is typed.
  j/k list nav walks `navIds`, which follow the group order.
- **The archive** comes from `GetSessionsActivity` with `windowdays: 30, all: true`; `sessionsIncompleteAtom`
  is true while wavesrv is still indexing, and `sessionsErrorAtom` is true after a failed load.
- **Agent-tree pin (prior art, stays as is):** `togglePin` in `session-models/sessionsidebarmodel.ts` writes tab
  meta `session:pinned`; `agenttree.tsx` shows Pin/Unpin in the row's context menu with lucide `Pin` /
  `PinOff` at size 15, via `ContextMenuModel.getInstance().showContextMenu(items, e)`.
- **Precedent for a user-level list in meta:** the Agent tree keeps `session:collapsedgroups` (a string
  list) on the workspace and writes it whole with `SetMetaCommand` (`setCollapsedGroups`).

## Decisions

1. **What can be pinned:** solo sessions and runs. A run pins as one card.
2. **Where pinned rows show:** a new first group, "Pinned" (group key `pinned`), above Live now. A pinned row
   leaves its recency group, so a pinned live session sits under Pinned, not Live now, and keeps its
   running/asking mark there. Pinned sorts newest first (`lastactivets` desc), like the other groups; there
   is no manual reordering. The header has the same look as the other groups (label, rule, count). Cards
   carry no pin icon, so the group itself is the marker. The toolbar's live count and "Needs you" count are
   unchanged. j/k order and paging follow the groups, so Pinned comes first.
3. **How to pin and unpin:** right-click a `SoloCard` or `RunCard` (also while search results show) to open
   the app's context menu with one item: "Pin" with lucide `Pin`, or "Unpin" with `PinOff`, size 15, as in
   the Agent tree. There is no hover button, no keybinding and no detail-pane button.
4. **Separate from the Agent-tree pin.** The Sessions pin and the tab meta `session:pinned` neither read nor
   write each other.
5. **Storage:** a new meta key `sessions:pinned` (`[]string` of row keys) on the **client** object, declared
   in `pkg/waveobj/wtypemeta.go` with a `// client` comment, then `task generate`. The frontend reads it
   reactively from `ClientModel.getInstance().clientAtom` and writes the whole list with `SetMetaCommand` on
   `client:<oid>`. An empty list writes `null`, which removes the key. It lives in wavesrv's store, so it
   survives a WebView2 profile wipe. The dev app and the packaged app keep separate stores, as they do
   for everything else.
6. **Which rows count as pinned:** a solo row is pinned when its key is in the set. A run row is pinned when
   `run:<runId>` or the key of any of its sessions is in the set, so a pinned session that later shows as a
   run's lead keeps its row pinned. "Unpin" on a run row removes its run key and every one of its sessions'
   keys; "Pin" on a run row adds its run key.
7. **Aging out: a pin follows the 30-day window and is removed with it.** After a load of the archive that
   succeeded and is complete (`incomplete` false), drop every pin key that no session in the archive
   matches (`${runtime}:${id}`) and no run matches (`run:<runid>` of any session that has a run id). Write
   the set only if it changed. Never prune after a failed or incomplete load, and never from search
   results. There is no backend change to `GetSessionsActivity`.
8. **Filters and search:** Pinned is the first group of the rows the status filter, project filter and
   search already let through. With the Live filter only live pins show, and under a query only matching
   pins show, with their snippet rows. When no pinned row passes, there is no Pinned group.
9. **Errors:** a failed pin write is logged with its context (as `fireAndForget` does for
   `setCollapsedGroups`) and leaves the list as the store last reported it. No toast.

## Non-goals

Pins past the 30-day window, reordering pins, a pin count limit, a pin keybinding, a hover or detail-pane
pin control, linking with the Agent-tree pin, and pinning from Ctrl+P.

## Shape of the change (the builder decides the rest)

- **Go:** the `sessions:pinned` meta key, and the generated `pkg/waveobj/metaconsts.go` and
  `frontend/types/gotypes.d.ts`.
- **Pure frontend logic**, unit tested with vitest: which rows are pinned (decision 6), the new set after
  Pin/Unpin on a row, the pruned set after a load (decision 7), and `groupByRecency` taking which items are
  pinned and returning the `pinned` group first (`RecencyGroup.key` gains `"pinned"`, labelled "Pinned").
  Callers that pass no pins get today's groups unchanged.
- **Wiring:** a reactive pin-set atom and its writer, pruning after a complete load, the grouping call in
  `SessionsSurface`, and `onContextMenu` on both cards.
- **Live check:** a CDP scenario `sessions-pin` (in `scripts/cdp/scenarios-sessions.mjs`, seeded with the
  sessions-search fixtures) that saves the user's `sessions:pinned` value in arrange and restores it in
  teardown. It covers pinning a solo card and a run card from the context menu and showing them under
  Pinned, the Live filter hiding ended pins, a search listing a pinned match under Pinned, unpinning back
  to the recency group, and pruning a key no session matches.
