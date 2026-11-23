# Brainstorm mockups: choose in the canvas window

The canvas window becomes where you choose between a brainstorm's designs: opened from an answer or a part, its
tabs are that question's answers (or that part's boards) plus one Other boards tab, and an answer band under the
toolbar shows the shown answer's number, label, pick mark, detail, pros, cons and Pick. Every thumbnail in the
Brainstorm tab becomes a name chip, `o` opens the window from the question or the check's review, and the brainstorm
skill asks for like-for-like answer boards. Read `DESIGN.md` before styling; colors only from the `@theme` tokens in
`frontend/tailwindsetup.css`, no new tokens.

**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\6c1bf3f3\docs\superpowers\specs\2026-11-23-brainstorm-mockups-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs brainstorm-answer-boards brainstorm-mode brainstorm-builder-ask brainstorm-working motion-lens workspace-brainstorm-question`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\brainstorm-mockups\project\Prototype.dc.html

## Decisions beyond the design

- **The scope is a snapshot taken when the window opens.** The spec keeps the tabs stable while the brainstorm moves
  on, so the opener builds a `WindowScope` (tabs, labels and band text) from the file at that moment and the window
  holds it in `canvasWindowScopeAtom` beside `canvasWindowAtom`. Only Pick reads the live file: it shows while the
  live question is still the scope's (same `n`, same judging state) and the agent is not writing over it, the gate
  `boardPicks` applies today. Why: a snapshot cannot drift, and the gate keeps a stale Pick from answering the next
  question.
- **The window side knows tabs, not brainstorms.** `canvaswindowmodel.ts` owns the scope types and the tab walk
  (Other boards included); the brainstorm side builds scopes (`brainstormwindowmodel.ts`) and draws the band through
  a render prop on `CanvasPane`, as `boardActions` does today. Why: `CanvasPane` also draws the Terminal view's canvas
  and the workspace canvas tab, which have no brainstorm.
- **Tab labels.** A board named by one answer that names no other board: `N · <answer label>` (the prototype's
  tabs). A board of an answer with several boards, or a board several answers share: `<numbers> · <board label>`
  (`1 · Left-rail`, `1, 3 · Page`), numbers joined by `, `. A board the asked part shows for every answer: `Every
  answer`, or `Every answer · <board label>` when there are several. A part's tabs: the board label. Then `Other
  boards`. Order: answer order, each answer's boards in its listed order (a shared board at its first answer), then
  the every-answer boards in the part's order, then Other boards. Only boards on the canvas get a tab.
- **Other boards.** Its tab appears only when the canvas has a board outside the scope's tabs. Selecting it shows
  those boards in the window's existing rows-of-3 grid (`windowGridLayout`), or the one board alone when there is
  only one; clicking a grid board shows it alone, the tab staying Other boards, with no band. Stored in today's
  `CanvasState` (`all` true is the grid, a `board` outside the tabs is the one shown alone), so no new canvas field.
  `[` and `]` step from Other boards to its neighbours, wrapping.
- **Digits in the window.** On a question's scope a digit shows that answer's first tab; on a part's scope the Nth
  tab; on an unscoped window they do nothing, as today.
- **The unscoped window is today's without the brainstorm extras.** The spec says opened from anywhere else the
  window shows every board by name, All, and no band, so the answer-numbered tab labels (`boardTabLabels`) and the
  pick row (`BoardPicks`, `boardPicks`) go, with their tests. Build this… stays hidden on a brainstorm's canvas, as
  today. A chip opens unscoped when no scope applies: the question closed, or the agent writing over it outside the
  judge's wait.
- **The scoped toolbar names where it came from.** In place of the canvas topic, the question's number and text, or
  `Part` and the part's title, as the prototype's header. The unscoped toolbar keeps the topic.
- **The band hides while marking**, as the board actions row does today: marking is about the board. Mark and Open in
  browser are disabled on the Other boards grid, since they act on one board.
- **Pick mark wording** is the question row's: `Judge’s pick` on a judged question, else `Agent’s pick`.
- **`o` finds the focused answer through the DOM**, the row a digit focuses (`[data-brainstorm-option]` holding
  focus inside the pane); with none focused, or a focused answer without a board, it opens on the scope's first tab.
- **This turn's boards keep their latest mark** as a dot on the latest board's chip, and open the unscoped window on
  their own canvas.
- **Motion** (`docs/reference/motion-system.md`): the band appears and leaves with `composerReveal` (moment 6, as the
  board actions row does); its content swaps with `ViewSwap` keyed on the tab when you flip; the board itself keeps
  its `StepSwap` slide (moment 10); a failed Pick's reason enters with `errorNudge` (moment 13).
- **The canvas's boards and their steps.** Prototype and WinStrip (Window A, the chosen band): `brainstorm-answer-boards`
  steps of Task 4 and the part steps of Task 5. Main (today's tab, chips): `workspace-brainstorm-question`'s Main board
  steps (Task 4). TodayWide (today's 200 px thumbnails): `brainstorm-answer-boards` step 1 (Task 4: chips replace them).
  WinToday (today's window): `brainstorm-working`'s turn-board step (Task 5: the unscoped window). Compare, Crops,
  Stage, Peek, Spread, WinSide, WinCaption, WinStrip2, WinTwoUp, EntryButton, EntryThumb and EntrySheet are the
  rejected options the spec's non-goals name; nothing builds them, so they get no step.

### Task 1: Window scope: types and store
**Depends on:** none
**Files:** `frontend/app/view/agents/canvaswindowmodel.ts`, `frontend/app/view/agents/canvaswindowmodel.test.ts`, `frontend/app/view/agents/canvasstore.ts`, `frontend/app/view/agents/canvasstore.test.ts`

**What to build:** the canvas window can be opened with a scope, and its tab walk follows it. The pure half
(`canvaswindowmodel.ts`) holds the scope types and the walk: the window's tab keys for a scope and the canvas's
current boards (the scope's tabs whose board is still on the canvas, then `OTHER_TAB` when any board is outside
them), the boards Other boards shows, the current tab of a `CanvasState` under a scope, the step by `delta`
(wrapping), and the tab a digit selects. The store (`canvasstore.ts`) adds the scope atom, takes a scope in
`openCanvasWindow`, clears it on close and when the window's canvas detaches, and walks/selects through the scope
when one is set, falling back to today's `stepCanvasBoard` / `selectCanvasTab` when not.

**Interfaces:**

```ts
// canvaswindowmodel.ts
export const OTHER_TAB = "other";
export type BandAnswer = { index: number; label: string; detail: string; pick: boolean; pros: string[]; cons: string[] };
export type ScopeBand =
    | { kind: "answers"; answers: BandAnswer[] }
    | { kind: "every" }
    | { kind: "part"; title: string; gist: string };
export type ScopeTab = { board: string; label: string; band: ScopeBand };
export type ScopeSource =
    | { kind: "question"; n: number; text: string; judging: boolean; judged: boolean }
    | { kind: "part"; id: string; title: string };
export type WindowScope = { source: ScopeSource; tabs: ScopeTab[] };
export function windowTabs(scope: WindowScope, boards: CanvasBoard[]): string[];
export function otherBoards(scope: WindowScope, boards: CanvasBoard[]): CanvasBoard[];
export function windowTab(scope: WindowScope, s: CanvasState): string;
export function digitTab(scope: WindowScope, digit: number): string | null; // digit is 0-based

// canvasstore.ts
export const canvasWindowScopeAtom: PrimitiveAtom<WindowScope | null>;
export function openCanvasWindow(agentId: string, at?: { board?: string; mark?: boolean; scope?: WindowScope }): void;
export function stepCanvasWindow(agentId: string, delta: number): void;
export function selectCanvasWindowTab(agentId: string, tab: string): void;
export function selectCanvasWindowDigit(agentId: string, digit: number): void;
```

**Acceptance:**
- `windowTabs` lists the scope's on-canvas tab boards in scope order, then `OTHER_TAB` only when a canvas board is
  outside them; a tab whose board left the canvas is dropped.
- `windowTab` is the shown board's key when it is one of the scope's tabs, `OTHER_TAB` when the grid shows (`all`) or
  the shown board is outside the tabs.
- Stepping walks `windowTabs` both ways and wraps; stepping onto Other boards shows the grid, or the one other board
  alone when there is one; selecting a board from the grid shows it alone with the tab staying Other boards.
- `digitTab` on a question scope returns the first tab whose band answers include that answer index, on a part scope
  the Nth tab, and null past the end.
- `openCanvasWindow` with a scope sets the scope atom and opens on `at.board`; without one it clears the atom;
  `closeCanvasWindow` and `detachCanvas` of the window's agent clear it; with no scope set, `stepCanvasWindow` and
  `selectCanvasWindowTab` behave as `stepCanvasBoard` and `selectCanvasTab`.

### Task 2: The canvas window draws a scope
**Depends on:** Task 1 (uses `WindowScope`, `OTHER_TAB`, `windowTabs`, `otherBoards`, `windowTab` and the window store functions)
**Files:** `frontend/app/view/agents/canvaspane.tsx`, `frontend/app/view/agents/canvaswindow.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-brainstorm.mjs`

**What to build:** with a scope set, the window's toolbar shows the scope's tabs (labels from the scope, truncating
with the full label as the title) and Other boards instead of every board and All, and names the question (`N` and
its text) or the part (`Part` and its title) in place of the topic. A scope tab shows its board alone at the window's
width, scrolling under the band; Other boards shows the grid or one board alone. `CanvasPane` gains
`scope?: WindowScope` and `band?: (tab: ScopeTab, scope: WindowScope) => ReactNode`, drawn under the toolbar for the
shown scope tab, never on Other boards or while marking, revealed with `composerReveal`. Mark and Open in browser
are disabled on the Other boards grid. `canvaswindow.tsx` reads `canvasWindowScopeAtom` and passes it; the band is
wired by Task 4, so here nothing passes `band` yet, and the existing `tabLabels` / `boardActions` props keep working
for the unscoped window (Task 4 removes them). The window's `[` / `]` bindings call `stepCanvasWindow`, and new digit
bindings `1`…`9` call `selectCanvasWindowDigit` while a scope is set (gated as the other window keys, never while a
field is focused). The Terminal view's canvas center and the workspace canvas tab render as today.
`docs/keyboard-shortcuts.md`'s canvas window section lists the digits and says `[` / `]` include Other boards.

**Acceptance:**
- Binding tests: with a scoped window open, `]` / `[` walk the scope's tabs and Other boards, a digit selects its
  tab, and with no scope the digits do nothing and `[` / `]` keep today's walk.
- Scenario step added to `brainstorm-answer-boards` (it may open the window through `canvasstore`'s
  `openCanvasWindow` with a scope literal over the scenario's canvas, imported as
  `scenarios-workspace-brainstorm-question.mjs`'s store helper does): the toolbar shows the scope's tab labels then
  Other boards and the question's number and text; `]` steps to the next tab; Other boards shows the grid; a click on
  a grid board shows it alone with Mark enabled; a digit returns to its answer's tab. Screenshot of the scoped toolbar
  and of the grid.

### Task 3: Brainstorm scopes and the band's gates
**Depends on:** Task 1 (builds `WindowScope` values)
**Files:** `frontend/app/view/agents/brainstormwindowmodel.ts`, `frontend/app/view/agents/brainstormwindowmodel.test.ts`

**What to build:** the pure brainstorm side of the window: the scope a question or a part opens, whether the band
may offer Pick now, and where `o` opens. Builds on `brainstormmodel.ts`'s exports (`questionBoardLayout`,
`optionNumber`, `judgeWait`, `judgeWork`, `partGist`, `boardLabel` from `canvasmodel.ts`) without changing them.

**Interfaces:**

```ts
export function questionScope(f: BrainstormFile, onCanvas: string[], judging: boolean): WindowScope | null;
export function partScope(f: BrainstormFile, partId: string, onCanvas: string[]): WindowScope | null;
export function bandPickable(f: BrainstormFile, source: ScopeSource, linePending: boolean): boolean;
export function scopeOpenBoard(scope: WindowScope, answer: number | null): string | null;
```

**Acceptance:**
- `questionScope` builds the tabs, labels and order of the header's rules from the options (or, `judging`, the
  approaches: label is the name, detail the description, no pros, cons or pick), leaving out boards not in
  `onCanvas`; a board two answers share is one tab whose band lists both answers; the asked part's boards no answer
  names are Every answer tabs with an `every` band; `source` carries `n`, the question text, `judging`, and `judged`
  from `judgeWork`. Null when there is no question, when the agent writes over it outside the judge's wait, or when no
  tab would draw.
- `partScope` gives the part's on-canvas boards as tabs labelled by board name, each with a `part` band (title and
  `partGist`); null for an unknown part or one with no board on the canvas.
- `bandPickable` is true only for a question source whose `n` is the live question's, whose `judging` equals
  `judgeWait(f, linePending)`, and while the agent is not writing over it outside the judge's wait; always false for
  a part source.
- `scopeOpenBoard` returns the given answer's first tab's board, else the first tab's board, else null.

### Task 4: Choose an answer in the window
**Depends on:** Task 2, Task 3 (uses `questionScope` and `bandPickable`)
**Files:** `frontend/app/view/agents/brainstormui.tsx`, `frontend/app/view/agents/brainstormpane.tsx`, `frontend/app/view/agents/brainstormstore.ts`, `frontend/app/view/agents/brainstormstore.test.ts`, `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `frontend/app/view/agents/canvaspane.tsx`, `frontend/app/view/agents/canvaswindow.tsx`, `scripts/cdp/scenarios-brainstorm.mjs`, `scripts/cdp/scenarios-motion-lens.mjs`, `scripts/cdp/scenarios-workspace-brainstorm-question.mjs`

**What to build:** on an open question (and the judge's wait), every board is a name chip at every width: an answer
row's boards as chips (today's `BoardChip`), and the For every answer boards as chips too; no thumbnail is drawn in
the question. A chip opens the window with `questionScope` on its board (unscoped when it returns null), through
`openBrainstormBoard(agentId, canvas, board, scope?)`, which gains the optional scope (Task 5 relies on it). The
band, marked `data-brainstorm-band` (replacing `BoardPicks` in `brainstormpane.tsx`, passed to
`CanvasPane` as `band` by `canvaswindow.tsx`) shows for an `answers` band each answer's number and label, the pick
mark, detail, pros (`+`) and cons (`−`), and `Pick N` while `bandPickable`; for `every` a line saying the board applies
to every answer, with no Pick. Pick sends the answer exactly as its row does (`sendText` of the option label, or the
approach name while judging), closes the window on success, and on failure stays open with the reason in the band.
The band's content swaps with the tab. Remove `boardTabLabels`, `boardPicks`, `BoardPick`, `BoardPicks` and
`CanvasPane`'s `tabLabels` / `boardActions` props, with their tests; `useBrainstormBoards` becomes what feeds the band
and hides Build this… on the brainstorm's canvas. A question with no options whose part lists boards (question 5 in
`brainstorm-mode`) opens a scope of Every answer tabs. The `o` key is Task 5's.

**Acceptance:**
- Unit tests for any scope-picking logic the opener adds; the deleted functions' tests are gone.
- `brainstorm-answer-boards` rewritten, with Task 2's store-driven step removed: the chip-driven steps below cover the
  same toolbar, flip, grid and digit checks, so each behaviour keeps one check. (1) the wide question draws no thumbnail
  and no iframe; each answer row's boards and the For every answer boards are chips (TodayWide's replacement);
  (2) a chip on 1's board opens the window scoped to the question, on that board, tabs in the header's label rules and
  order ending in Other boards; the band shows 1's number, label, pick mark, detail, pros, cons and Pick 1;
  (3) `]` flips to the next tab and the band swaps with it, a digit jumps to that answer; (4) the Every answer tab's
  band has no Pick; (5) Other boards shows the grid and a clicked board shows alone with no band; (6) Pick 2 sends 2's
  label and closes the window on the agent writing it up; (7) during the judge's wait a chip opens the approaches'
  scope, the band with the approach's name and description, no pros or cons, and Pick. Screenshots of the band on an answer tab, the Every answer tab and Other
  boards.
- `brainstorm-mode` steps 2l2, 2l3 and 2l4 (~L989-1030) rewritten: 2l2, question 5 (no answers) draws its part's two
  boards once as chips above the answer box, no iframe, no For every answer heading; 2l3, the answers that name no
  board, and above them, once, under For every answer, the two boards as chips; 2l4, a chip opens the window scoped to
  the question, its Every answer tab's band saying the board applies to every answer with no Pick, the pane left on
  the question, and Close returns to it.
- `motion-lens` step 8a (`boardActionsSteps` in `scenarios-motion-lens.mjs`) reads `[data-brainstorm-band]` instead of
  `[data-brainstorm-board-picks]`, opens the window from a chip instead of "Open full size", and selects Other boards
  instead of All: stepping from Other boards back onto an answer tab reveals the band from opacity 0 through
  intermediate heights, settling at 1.
- `workspace-brainstorm-question`'s Main board steps hold: the narrow tab's rows keep their chips and no thumbnail,
  and row 1's chip opens the scoped window on its board with the band.

### Task 5: Parts and this turn's boards as chips, and the `o` key
**Files:** `frontend/app/view/agents/brainstormui.tsx`, `frontend/app/view/agents/brainstormpane.tsx`, `frontend/app/view/agents/brainstormreview.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-brainstorm.mjs`, `scripts/cdp/scenarios-brainstorm-builder.mjs`, `scripts/cdp/scenarios-brainstorm-working.mjs`

**What to build:** a part's boards (`PartMockups`, in the design list and the builder check's review) are name chips
that open the window with `partScope` on that board; its band names the part (title and gist) with no Pick. The
boards made this turn (`TurnBoards`) are chips too, the latest with its dot, opening today's unscoped window on their
own canvas. `Thumbnails`, `THUMB_W`, `THUMB_W_QUESTION`, `THUMB_W_TURN`, `THUMB_MAX_H` and the "Open full size" link
are deleted (grep every reference first). Spikes stay links. A new binding `o` (Agent group, listed with the
brainstorm's keys), while the brainstorm is shown and no field is focused: on an open question or the judge's wait it
opens the window with `questionScope` on `scopeOpenBoard(scope, focused answer)`; in the builder check's review it
opens the window with `partScope` of the part under the review's cursor; in the design list, or with no scope, it
does nothing. `docs/keyboard-shortcuts.md` lists `o` in the brainstorm section and drops "Open full size" from the
canvas window intro.

**Acceptance:**
- Binding tests: `o` on a shown open question opens the window scoped to it on the focused answer's first board, on
  the first tab with none focused; in the review it opens the window scoped to the cursor part's boards; it does
  nothing with the question closed, with no board to show, on a cursor part without boards, in the design list, or
  while a field is focused.
- `brainstorm-answer-boards` gains a step: `o` on the question opens the window on the focused answer's board, with
  that answer's band.
- `brainstorm-mode`'s part steps (~L750-805): a part opened in the design shows its boards as chips with no iframe,
  and a chip opens the window with the part's boards as tabs, `Part` and its title in the toolbar, and the band's
  title and gist with no Pick. Screenshot of the part's window. Step 3 (~L1046-1059, "Open full size from the
  design") becomes: a part's chip in the design opens the canvas window with Mark and Close and no Build this, and
  closing it returns to the design, not the question.
- `brainstorm-builder-ask` 3a: the review's role row opens to its board chip and spike link; the chip opens the
  part's scoped window; `o` with the cursor on the row opens the same window.
- `brainstorm-working`: this turn's boards are chips (the latest marked) and one opens today's unscoped window
  (WinToday) on that board, every board by name with All and no band.

### Task 6: The brainstorm skill asks for like-for-like boards
**Depends on:** none
**Files:** `skills/brainstorm/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/brainstorm/SKILL.md`

**What to build:** the brainstorm skill says the boards of one question's answers show the same screen, at the same
moment, with the same data, so flipping between them shows only what the answer changes, and that a board carries
no banner restating its option, since the window's band says it. Its text on how Arc draws boards follows the new
UI: an answer's or a part's boards show as name chips that open the canvas window, where the user flips between the
answers' boards and picks (the "thumbnail" wording goes). Edit `skills/brainstorm/SKILL.md`, then run
`task sync:claudemod` and include the refreshed `cmd/wsh/cmd/claude-mod/skills/brainstorm/SKILL.md`; no other copy
should change.

**Acceptance:**
- The two `SKILL.md` files are identical, and the source contains the like-for-like rule and no claim that Arc draws
  boards as thumbnails. Prose only: no test.
