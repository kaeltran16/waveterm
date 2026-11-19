# Changes tab: opens collapsed, folder toggles, Expand all / Collapse all

**Verify:** `node scripts/verify.mjs ./pkg/gitinfo`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-changes workspace-pane`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\changes-tree-rail\project\Main.dc.html

The workspace pane's Changes tab (`frontend/app/view/agents/workspacechangestab.tsx`) to the prototype's three boards,
drawn at the pane's 600 px: **Main** (opens collapsed: each folder is one list box of its files, a folder label
toggles its files), **Opened** (after Shift+N: the stepped-into file opens as its own card, and the next step into
another file collapses it again) and **Expanded** (after Expand all: every file open, stepping collapses nothing).
Everything else the tab draws today stays as it is: the summary line, the change counter (0/N before the first step,
wrapping), Hide whitespace, Open on Diff, Open in Code, the file bodies and notes, the loading / failed / not-a-repo /
No changes states, and `tab.selected` scrolling its file into view.

Sizes and colors come from `Main.dc.html`; every color maps onto an existing `@theme` token the tab already uses
(`bg-surface-code` folder label and scroller, `bg-surface` list box and card header, `border-border` box edge,
`border-edge-faint` row separators, `text-muted` / `text-ink-faint` label and count). No raw hex, no new token.

## Decisions beyond the design

1. **Every file starts closed, new or not.** The rule "a new file starts closed, any other open" goes, and with it
   `fileOpen` and the "toggled flips the default" atom: a file's open state is now an explicit per-agent record
   (absent = closed). Why: the Main board opens every file collapsed, and with one default the flip indirection buys
   nothing. A closed new file still reads "new file".
2. **The step-opened file is tracked per agent (`stepOpened`).** A step (button or Shift+N / Shift+P) landing in a
   closed file opens it and remembers it; the next step whose hunk is in a different file closes the remembered file
   first. Steps within the same file keep it open. A file the user opens or closes by any means (its header, its
   folder label, Expand all / Collapse all, or `tab.selected` naming it) is theirs from then on: if it was the
   remembered file, the memory clears, and no step closes it. Why: the Opened board's note, "the next step collapses
   it", and the prototype's rule "a file the user opened is never in it".
3. **A folder toggle clears `stepOpened` only when the remembered file is in that folder**; Expand all and Collapse
   all always clear it. The prototype clears it on any folder toggle; the narrower rule is the same "a file the user
   toggles is theirs" rule applied consistently, and it still gives the Expanded board's "stepping collapses nothing"
   (after Expand all every file is open and none is remembered).
4. **Expand all opens every listed file, new files included.** The Expanded board's own initial state leaves the new
   file closed, but its title ("every file open") and the prototype's Expand all handler open every file; the handler
   is the behaviour, the initial state a board shortcut.
5. **The header button reads "Expand all" when no listed file is open, otherwise "Collapse all"**, with lucide's
   `ChevronsUpDown` / `ChevronsDownUp` (the prototype's two icon paths). It sits after Hide whitespace, before the
   divider, in the header's `barBtn` style, and is drawn whenever the file list is (the `files` view). "Any open"
   counts only the files currently listed, so a stale path left in the record by a file that no longer changes does
   not flip the label. No keybinding: the design gives none.
6. **A folder label becomes a button** (sticky, as now) with a leading 12 px chevron turned 90° while any of its files
   is open; it opens every file in the folder when none is open, else closes every one. `aria-expanded` is "any
   open"; its label and title read "Expand every file in `<dir>/`" / "Collapse every file in `<dir>/`". Root files
   (dir `""`) keep having no folder label, so no folder toggle: Expand all / Collapse all covers them.
7. **Within each group, consecutive closed files render as one list box** (bordered, rounded, 34 px rows separated by
   a faint top border), and an open file breaks the run as its own card (today's file block). The segmenting is a pure
   model function so the tab stays thin. Each closed row and each open card carries `data-changes-file` and, when
   open, `data-changes-open`, and both keep `data-changes-toggle` on the header button, so the step's scroll target
   (`[data-changes-file] [data-changes-hunk]`) and existing selectors still resolve. A closed row's scroll margin is
   the folder label's 32 px (0 at the root), as the card's is.
8. **Motion: the chevrons turn (the existing CSS `transition-transform`, reduced-motion off), nothing else moves.** A
   body opens and closes instantly, and the list box splits and rejoins by plain re-render, as on the prototype. Why:
   Expand all opens many bodies at once and a step reveals its hunk by measuring right after render; a height tween
   would put the hunk off its mark, and motion's height-from-auto exit is known to clamp this kind of scroller.
9. **One task.** Every change lands in the tab component and its store, and the scenario steps that show it read the
   DOM that component draws; a split would be a serial chain with an extra review and merge and no width.

### Task 1: The Changes tab opens collapsed, with folder toggles, Expand all / Collapse all and step-collapse
**Depends on:** none
**Files:** `frontend/app/view/agents/workspacechangesmodel.ts`, `frontend/app/view/agents/workspacechangesmodel.test.ts`, `frontend/app/view/agents/workspacechangesstore.ts`, `frontend/app/view/agents/workspacechangesstore.test.ts`, `frontend/app/view/agents/workspacechangestab.tsx`, `scripts/cdp/scenarios-workspace-changes.mjs`, `scripts/cdp/scenarios-workspace-pane.mjs`, `docs/keyboard-shortcuts.md`

**What to build:** the open-state model of decisions 1-4 as pure functions in `workspacechangesmodel.ts` (state in,
state out) with the list-box segmenting of decision 7, the per-agent atom and actions in `workspacechangesstore.ts`
(replacing `changesToggledAtom`; `isChangesFileOpen` and `openChangesFile` lose their `isNew` parameter, and
`stepChangesHunk` keeps its signature and return, which `bindings.ts` relies on), and the tab's rendering of
decisions 5-8. `docs/keyboard-shortcuts.md`'s Shift+N / Shift+P row says a step opens a collapsed file and the next
step into another file closes it again, unless you opened it yourself. The existing `workspace-changes` steps that read
hunks, rows, notes or skeletons now open the files they inspect first (Expand all, or their headers); the
`workspace-pane` wrap step opens its file through its header before measuring.

**Acceptance:**
- With no toggles, every listed file is closed, new or not; a closed new file reads "new file".
- A step into a closed file opens it and the counter moves; the next step into another file closes it; a step into the
  same file's next hunk leaves it open; a file opened by its header, its folder label, Expand all or `tab.selected` is
  never closed by a step. Open state and the remembered file are per agent and survive the tab unmounting and an agent
  switch.
- A folder label opens every file in its folder when none is open, else closes them all, and clears the remembered
  file only when it is in that folder; Expand all / Collapse all open / close every listed file and clear it.
- The header button reads "Expand all" with no listed file open and "Collapse all" otherwise; a folder label's chevron
  is turned and `aria-expanded` is true while any of its files is open.
- Consecutive closed files in a group are one list box; an open file between them splits it into list, card, list.
- `npx vitest run` over the model and store tests passes; the Check typechecks clean.
- Scenario `workspace-changes`, step "opens collapsed: every file a row in its folder's one list box, the header reads
  Expand all; a folder label opens its files and closes them again (Main board)", with shot
  `cdp-shots/workspace-changes-main.png` taken in the collapsed state.
- Scenario `workspace-changes`, step "Shift+N opens the stepped-into file as its own card between list boxes; the next
  step into another file closes it; a file opened from its header stays open across steps (Opened board)", with shot
  `cdp-shots/workspace-changes-opened.png` taken while the stepped-into card shows.
- Scenario `workspace-changes`, step "Expand all opens every file, new ones too, and reads Collapse all; stepping
  closes nothing; Collapse all returns each folder to one list box (Expanded board)", with shot
  `cdp-shots/workspace-changes-expanded.png` taken after Expand all.
- Every other `workspace-changes` step and the `workspace-pane` steps still pass.
