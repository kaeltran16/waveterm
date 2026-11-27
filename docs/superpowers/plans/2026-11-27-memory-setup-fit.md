# Memory tab: two panes like Instructions

**Verify:** `node scripts/verify.mjs ./pkg/memhygiene`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs setup-memory`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\memory-setup-fit\project\Main.dc.html

The Setup surface's Memory tab (`frontend/app/view/agents/setupmemory.tsx`) becomes a 320px list beside a fluid
detail pane, as the Prototype's one board shows. Decisions beyond the design, with why:

- **One selection replaces open + focus.** `memoryOpenAtom` and `memoryFocusAtom` collapse into
  `memorySelectedAtom` (the stored key: a row key or a did-line key, or null). In a master-detail layout the
  selected item is what the detail shows, so a separate "opened" state has nothing left to mean. `j`/`k` and the
  arrows move the selection; `a`/`x` press the selected waiting row's buttons; `u` undoes the selected did line.
  `Enter` and `Esc` are dropped: nothing opens or closes any more.
- **The shown item is derived, not stored.** `resolveSelection(projects, now, stored)` in `memorymodel.ts`: the
  stored key while it is in the list; else, for a stored waiting-row key whose row left the list, the did line
  with the same morph key (a split, cleanup or doc move that was applied: the detail follows "the same thing,
  now here" instead of jumping to another item); else the first key in list order (waiting rows, then did
  lines); else null. Pure, so the view and the keys read the same answer, and an Undo that brings the row back
  shows the row again because the stored key never changed. The morph keys (`rowMorph`/`lineMorph`, today in the
  view) move into the model for this.
- **The memhygiene address keeps its contract:** `landMemoryProject` stores the project's first row key (null for
  a project with nothing waiting, which then shows the first item by the rule above).
- **List rows carry no buttons.** The closed row's Review / Check now and the did line's Undo / See … go; every
  action is in the detail header. A did line's detail shows its digest outright (per-change Undo, the index line)
  with Undo all N top-right, so the See memories / See changes / Hide … toggle and `DidLine.see` are removed: a
  disclosure control, not information.
- **Every action sits top-right in the detail header**, stopped states included: the stop box holds its text only,
  and Undo the N / Check now / Try again sit in the header. The goal puts RowActions top-right.
- **Sub lines:** a waiting list row's sub is `<chip> · <sub>` ("Own memory · 71 come over: ..."); a did list
  row's is `Applied · <text>`. The detail header's sub is the plain sub (a cleanup's is its opened sub,
  `cleanupDetail().opened`, as today when opened). A split's tag (`N of M here`, `Applying`) shows with its dot
  on the list row and in the detail header, so a split applying in the background stays visible.
- **The split's full list replaces the spot check:** `spotCheck`, `SPOT_CHECK`, `splitItemChip`, Show all /
  Show fewer and "N more below" are removed; `splitList` groups render as bands in one bordered scroll box. The
  body keeps today's state mapping: the review list for open and partial, the progress bar while applying, the
  stop box for changed, newer and failed.
- **The detail pane** is a header (flex-none), a body that scrolls (the split's box fills it and scrolls itself),
  and "How it works" with today's intro text pinned at the bottom. The detail is keyed by the shown key, so its
  `AnimatePresence initial={false}` remounts on a selection change and a stop box nudges (moment 13) only when it
  appears after an action, never when selected. A selection change swaps the detail instantly, as Instructions
  does. Kept: progress fill (11), TickNumber on the waiting count (12), the list row moving from Waiting to Arc
  did this week under one `layoutId` (17, now a list-row morph) with popLayout reflow (2).
- **Empty state:** with nothing waiting the list shows `emptyText()` in place of the Waiting section; the did
  section stays and its first line is shown. With nothing at all, the detail shows only How it works. Load
  failed (with Retry), the error banner and Reading… render as today, across both panes.
- **Icon tints** map onto existing tokens: accent `bg-accentbg text-accent-soft`, error `bg-error/10
  text-error-soft`, success `bg-success/12 text-success`. Icons (lucide): split `GitFork`, cleanup `Eraser`, doc
  move `FileText`, failed check `TriangleAlert`, did line `Check`.
- **DOM contract** (task 1 builds it, task 2 asserts it, so they run side by side):
  - list `nav[data-memory-list]`; `[data-memory-waiting]` (its first child the heading "Waiting for you · N"),
    `[data-memory-empty]`, `[data-memory-did]`;
  - list rows `button[data-memory-row=<rowKey>]` and `button[data-memory-line=<lineKey>]`, the shown one with
    `aria-current="true"`, each holding `[data-memory-title]`, `[data-memory-sub]` and, for a split with one,
    `[data-memory-tag]`;
  - detail `main[data-memory-detail=<shown key or "">]` with `[data-memory-title]`, `[data-memory-sub]`,
    `[data-memory-tag]`, the actions `[data-memory-apply]`, `[data-memory-check]`, `[data-memory-keep]`,
    `[data-memory-undo="split"]`, `[data-memory-undo="all"]`; the body's `[data-memory-split]` box of
    `[data-memory-group]` bands, `[data-memory-item=<changeId>]` with `[data-memory-leaveout]` or
    `[data-memory-undo="change"]`, `[data-memory-stop=<state>]`, `[data-memory-progress]`,
    `[data-memory-evidence]`, `[data-memory-diff]`, `[data-memory-index]`, `[data-memory-undo-refused]` with
    `[data-memory-undo="cleanup"]`, a cleanup's body paragraph `[data-memory-body]`; `[data-memory-intro]`;
  - unchanged: `[data-memory-error]`, `[data-memory-retry]`, `#setup-tab-memory`, the toolbar status.

### Task 1: Two-pane Memory tab with one selection
**Depends on:** none
**Files:** `frontend/app/view/agents/setupmemory.tsx`, `frontend/app/view/agents/memorymodel.ts`, `frontend/app/view/agents/memorymodel.test.ts`, `frontend/app/view/agents/memorystore.ts`, `frontend/app/view/agents/memorystore.test.ts`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/store.test.ts`, `frontend/app/view/jarvis/openref.test.ts`, `docs/keyboard-shortcuts.md`

Build the header's layout, selection and DOM contract.

- The tab renders a 320px `border-r border-border bg-surface` list (Instructions' `ROW`/`ROW_SELECTED` look,
  20px tinted icon box per row) and a fluid detail pane; no centered 880px page and no "Memory" h2.
- `resolveSelection` follows the header's rule, unit-tested: stored key present, a stored applied row resolving to
  its did line, a gone key falling to the first, an empty list giving null. `selectionOrder` and `stepSelection`
  replace `focusOrder` and `stepFocus`; `rowMorphKey(row)` and `lineMorphKey(line)` are exported from the model.
- `memorySelectedAtom`, `selectMemory(key)`, `stepMemorySelection(delta)` replace the open/focus atoms,
  `toggleMemoryOpen` and `stepMemoryFocus`; `pressMemoryRow` and `u` act on the resolved selection; the Enter
  and Escape memory bindings are gone; `docs/keyboard-shortcuts.md` matches.
- Selecting a row shows it in the detail with its title (15px semibold), sub, tag and today's RowActions
  labels top-right; split, cleanup, doc move, failed check, did-line digest, stop boxes, refusal box and applying
  progress show today's content and labels in the detail; "How it works" with the intro text at the bottom.
- `spotCheck`, `splitItemChip` and `DidLine.see` are removed with their tests; every other label and count shown
  today still shows.
- Scenario `setup-memory` steps 1 (list + selected split), 10 (selected doc move) and 12 (empty state) show it.

### Task 2: setup-memory scenario on the two-pane contract
**Depends on:** none
**Files:** `scripts/cdp/scenarios-settings.mjs`

Rewrite the `setup-memory` scenario's steps to select through list rows and read the detail by the header's
DOM contract; it keeps its fixtures, arrange and teardown.

- Every step that opened a row in place selects its list row and reads `[data-memory-detail]`; the focus probe
  reads `memorySelectedAtom`.
- Step 1 asserts the list in board order with the 20px icon boxes' rows, the sub `<chip> · <sub>`, and a selected
  split showing every Move here / Copy here item in `[data-memory-split]`, Keep sharing and Apply and switch over.
- Step 2 replaces Show all with: all items present in the box, Leave out one reads muted "Left out" with Bring
  back, the counts follow, Bring back restores them.
- Steps 3-9 and 11 keep their assertions with the actions read from the detail header (did line: Undo all N, no
  See toggle); step 4 asserts the detail follows the applied split to its did line.
- Step 10 shows a selected doc move (evidence, two diffs, Keep, Move to CLAUDE.md); step 12 the empty state;
  step 13 asserts j, j, k move the selection and the detail follows, with no Enter/Esc.
- Each of steps 1, 10 and 12 writes a screenshot.
