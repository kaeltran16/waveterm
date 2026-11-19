# Brainstorm tab polish

The workspace pane's Brainstorm tab (`BrainstormPane` in `workspacepane.tsx`) at the pane's 600 px, to the approved
canvas: one header row, the "Decided so far" history behind a header toggle instead of a second scroller, the
question at tab size, answers numbered 1..N with digit keys, a one-row transcript card while the tab shows, and the
600 px fixes in the check, review, run and removed views. Read `DESIGN.md` before styling; colors only from the
`@theme` tokens (the canvas's warning-tinted back chip is the design view's existing `border-warning/45
bg-warning/12` chip, the pressed toggle the accent chip `border-accent/45 bg-accent/12`).

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-brainstorm-question workspace-brainstorm-history workspace-brainstorm-cards workspace-brainstorm-check workspace-brainstorm-canvas workspace-pane brainstorm-mode brainstorm-answer-boards brainstorm-main brainstorm-question-reasons brainstorm-review-skim brainstorm-rail-reasons brainstorm-builder-ask brainstorm-builder-check brainstorm-builder-tree brainstorm-judge-tree brainstorm-judge-wait brainstorm-judged-question brainstorm-check-review brainstorm-run-blocked brainstorm-run-landed brainstorm-run-missing brainstorm-working rendered-bs-host rendered-bs-question rendered-bs-boards rendered-bs-mockup rendered-bs-rows rendered-bs-composer rendered-bs-design rendered-bs-check rendered-bs-review rendered-bs-run`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\brainstorm-tab-history

## Decisions beyond the design

- **"Narrow" is measured, not a host prop.** Items 1-4 and 7-9 apply where the brainstorm is narrower than the
  existing 760 px `bs` container breakpoint (the goal's scope rule), so the workspace tab expanded past 760 px and the
  wide Terminal center keep today's layout. `BrainstormPane` measures its own width (`useDimensionsWithCallbackRef`,
  as `RenderedBrainstorm` does) and provides it through a context; components read `useBsNarrow()`. The class-string
  breakpoints (`BS_SPLIT`, `BS_RAIL_STACK`) stay literal (Tailwind needs literals) with a comment naming
  `BS_NARROW_PX` as their twin. Why JS rather than more container queries: the toggle swaps what the main area
  renders, the answer rows swap thumbnails for chips, and the Options sizes are already a `compact` prop.
- **Item 10 follows the host, not the width.** The removed view's copy names the tab when the pane is the workspace
  tab and the switch in the Terminal center, whatever the width: copy that names a control must name the one on
  screen. `BrainstormPane` takes `inTab?: boolean`, set by `workspacepane.tsx`.
- **The history toggle's state lives in the brainstorm store** (`historyOpen`), beside `designOpen`, because `Esc`
  (bindings.ts) has to read it. Opening the design closes the history and pressing the toggle closes the design, so
  the two never stack; `paneBack` returns a `"history"` step that `Esc` takes, ordered board > history > design. When
  the pane is no longer narrow, the pane closes `historyOpen`, so a hidden history never swallows `Esc`.
- **The toggle counts `decidedCount(f)`** (the rail's own "Decided so far · N") and is hidden while it is 0. While
  the agent writes, the history shows under the working line whenever it has rows (recon included).
- **Folding (item 3) applies in the narrow history only**; the wide rail is unchanged. "Show the reasoning" also
  unfolds, since the reasoning is about the folded options. An own-words answer on a question that offered more
  than 3 shows the answer whole and folds every option.
- **Digit keys cover 1..9** (`OPTION_KEYS` becomes `"1"`..`"9"`), so the cap of 4 letter keys goes; with digits `b`
  always closes the brainstorm and `d` always collapses the pane, so their "while the question offers a B / a
  fourth answer" exceptions go. The Rendered view's `agent:permission-choice-N` digits stand down while the shown
  Brainstorm tab claims that digit, so no key has two claims.
- **"The tab is open" for item 6 means the question is on screen there**, by the rule the keys already use:
  `shownPane(true, brainstorm, canvas, ws) === "brainstorm"` (`agentpanes.ts`: the Brainstorm tab active and the pane
  not collapsed), so the one-row card and the digit keys cannot disagree. Behind another tab or collapsed, the card
  answers in place as today. Every card kind that draws in `CardFrame` (question, judging, design, check, review)
  shrinks; the gone card does not.
- **The narrow header of the check and run views** is the same row without the parts count (they pass
  `progress={false}` today): no topic, the phases, the run view's merged step as today.
- **The working line at narrow is 18 px** (board A3), down from today's 22 px.
- **The check and run rails stay stacked under the main area** at narrow, as today; only the talk view's "Decided so
  far" rail becomes the toggle (the canvas draws only that one).
- **One scenario per task** (`workspace-brainstorm-question`, `-history`, `-cards`, `-check`), registered by Task 1,
  so parallel tasks never share a scenario file.

### Task 1: Narrow context, history state, numbered answers
**Depends on:** none
**Files:** `frontend/app/view/agents/brainstormui.tsx`, `frontend/app/view/agents/brainstormpane.tsx`, `frontend/app/view/agents/workspacepane.tsx`, `frontend/app/view/agents/brainstormstore.ts`, `frontend/app/view/agents/brainstormstore.test.ts`, `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `scripts/cdp/scenarios-brainstorm.mjs`, `scripts/cdp/scenarios-brainstorm-builder.mjs`, `scripts/cdp/scenarios-brainstorm-judge.mjs`, `scripts/cdp/scenarios.mjs`, `scripts/cdp/scenarios-workspace-brainstorm-question.mjs`, `scripts/cdp/scenarios-workspace-brainstorm-history.mjs`, `scripts/cdp/scenarios-workspace-brainstorm-cards.mjs`, `scripts/cdp/scenarios-workspace-brainstorm-check.mjs`

**What to build:** the interfaces the other tasks build on, plus item 5's display half and item 10.
- The narrow context: `BrainstormPane` measures its root and provides whether it is under `BS_NARROW_PX` (760).
- Two slots Tasks 3 and 4 share, unstyled here: `Toolbar`'s `trailing`, drawn last in its row, and `WorkingMain`'s
  `children`, drawn under its content inside `MainBody`'s scroll. Unused, nothing renders differently.
- `historyOpen` in `BrainstormState` (default false) with `openBrainstormHistory`; `openBrainstormDesign(id, true)`
  clears it and `openBrainstormHistory(id, true)` clears `designOpen`. `paneBack` returns `"history"` while
  `historyOpen` is set and the design view's main area is the question or the judge's wait; `agent:brainstorm-back`
  (`Esc`) closes it.
- `foldedHistory`: the pure fold rule of item 3 over a `HistoryRow`.
- Answers numbered 1..N: `optionLetter` is replaced by `optionNumber` (grep every caller: `brainstormui.tsx` answer
  and approach badges, `brainstormpane.tsx` `BoardPicks` "Pick N", `boardTabLabels` "1, 2 · Board", the bindings'
  palette label, `brainstormmodel.test.ts`). Update every letter assertion to numbers: in `scenarios-brainstorm.mjs`
  the BSAB tab labels and "Pick A/B/C" (~2016-2323), `optionText` at ~684 and ~982 (brainstorm-mode, with step 2p's
  text), `letters = "ABCD"` at ~1614 (brainstorm-question-reasons), `optionText` at ~1665 (brainstorm-main); in
  `scenarios-brainstorm-builder.mjs` the `String.fromCharCode(65 + i)` badge check at ~555 (brainstorm-builder-ask);
  in `scenarios-brainstorm-judge.mjs` `rowText` at ~339 (brainstorm-judge-wait, brainstorm-judged-question).
- Item 10: `BrainstormPane` takes `inTab`; `workspacepane.tsx` passes it; the removed view says the tab disappears
  once closed when `inTab`, the switch otherwise.
- The four scenario files, registered in `scenarios.mjs`, each with one step: the RBS_KIT fixture agent in Rendered,
  `W.workspaceWidthAtom` at 600 and `W.openWorkspaceTab(id, { kind: "brainstorm" })` with an asking `bsFile`, the tab
  showing the pane. Later tasks add their steps to their own file.

**Interfaces:**
- `export const BS_NARROW_PX = 760` and `export function useBsNarrow(): boolean` in `brainstormui.tsx` (false
  outside a `BrainstormPane`).
- `BrainstormPane({ model, agent, inTab }: { model; agent; inTab?: boolean })`.
- `Toolbar({ topic, f, progress, merged, trailing }: { ...; trailing?: ReactNode })`.
- `WorkingMain({ ..., children }: { ...; children?: ReactNode })`.
- `BrainstormState.historyOpen: boolean`; `export function openBrainstormHistory(agentId: string, open: boolean): void`
  in `brainstormstore.ts`.
- `export type PaneBack = "board" | "history" | "design"`.
- `export const HISTORY_FOLD_AT = 3` and `export function foldedHistory(h: HistoryRow, unfolded: boolean): { options:
  HistoryRow["options"]; folded: number }` in `brainstormmodel.ts`: `folded` is how many options are hidden behind
  "N other options"; the own-words `answer` is never folded.
- `export function optionNumber(i: number): string` ("1" for 0).
- The four scenario modules' exported names and scenario names `workspace-brainstorm-question`,
  `workspace-brainstorm-history`, `workspace-brainstorm-cards`, `workspace-brainstorm-check`.

**Acceptance:**
- `useBsNarrow()` reads true in the 600 px tab and false in the Terminal center at the scenario's 1600 px viewport.
- Store: opening the history closes the design and opening the design closes the history; `paneBack` gives
  `"history"` only while the question or judge's wait is under it; `Esc` with the history open leaves the question
  showing (bindings test).
- `foldedHistory`: 3 options show all; 5 options with the second picked show only it, `folded` 4; `unfolded` shows
  all; an own-words answer over 6 options shows the answer, `folded` 6.
- The answer badges in the pane read 1, 2, 3; the board view's tabs read "1 · Left-rail" and its button "Pick 1".
  `brainstorm-answer-boards`, `brainstorm-mode`, `brainstorm-question-reasons`, `brainstorm-main`,
  `brainstorm-builder-ask`, `brainstorm-judge-wait` and `brainstorm-judged-question` pass with number assertions.
- `workspace-brainstorm-history` step "the removed brainstorm file names the tab": with the file gone, the tab's
  removed view says the Brainstorm tab disappears once closed; the existing Terminal-center removed step still names
  the switch.
- Each new scenario's opening step passes.

### Task 2: Digit keys pick answers
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-workspace-brainstorm-canvas.mjs`, `scripts/cdp/scenarios-brainstorm.mjs`, `scripts/cdp/scenarios-brainstorm-judge.mjs`

**What to build:** the tab's (and the Terminal center's) answer keys move from letters to digits 1..9, per the
decisions above: `OPTION_KEYS` digits, `pickableOptions` capped at 9, the `b` and `d` exceptions removed, the
permission-choice digits standing down while the shown brainstorm claims the digit. `docs/keyboard-shortcuts.md`
mirrors it (the brainstorm table's `a`/`b`/`c`/`d` row, the `b` and `d` rows' exceptions).

**Acceptance:**
- Bindings test: with a shown tab asking 4 answers, `1`..`4` each claim only `agent:brainstorm-option-N`, `5`
  claims only the permission digit, `d` claims only `agent:toggle-workspace`, `b` only `agent:brainstorm-close`;
  behind another tab the digits go back to the permission binding; no key has two claims.
- `workspace-brainstorm-canvas`: its "d picks the fourth answer" step becomes "4 focuses the fourth answer and
  Enter answers it, the pane stays open" and passes; the letter-key steps in `scenarios-brainstorm.mjs` (2s) and
  `scenarios-brainstorm-judge.mjs` (step 4, `brainstorm-judge-wait`) press the digit and pass.

### Task 3: Header row and the question at tab size
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/brainstormui.tsx`, `scripts/cdp/scenarios-workspace-brainstorm-question.mjs`

**What to build:** items 1 and 4, narrow only (wide unchanged), styling the slots Task 1 adds.
- `Toolbar` at narrow: one row with the phases, then the parts count ("4 of 7 parts yours", the `Progress` text
  without its segments) when `progress`, then `trailing`; no topic. The check and run views' header follows (no
  count, as today). The per-question `Track` under it stays.
- The question (`QuestionMain`, and `JudgingMain` through the same head and rows): content from the top of the main
  area (no third-down spacer) in one scroll, part line 12.5 px, heading 20 px / 1.35 semibold, why 13 px; answer rows
  in the compact sizes (label 13.5 px semibold over detail 12.5 px, 22-24 px number badge) with the Agent's/Judge's
  pick tag right after the label; a board a row names is a small chip at the row's right (the board icon and its
  name, as `boardLabel` gives it) that opens that board in the pane (`openBrainstormBoard`), not a thumbnail; a row's
  spikes stay links in the row. Shared boards keep their thumbnails. The answer box, chips and The design button
  as the Main board draws them.
- `WorkingMain` at narrow starts at the top, its working line at 18 px (A3), its `children` under it.

**Acceptance (`workspace-brainstorm-question`):**
- "Main board": the 600 px tab asking question 4 of the canvas's fixture (3 answers, two naming boards) has one
  header row with the phases and "4 of 7 parts yours", no topic text and no Progress segments in the header
  (`[data-brainstorm-progress] span[data-state]`) while `[data-brainstorm-track]` stays; the h1 computes 20 px,
  the why 13 px, labels 13.5 px; badges 1-3; the pick tag sits in the label's line; rows 1 and 2 carry board chips
  and no thumbnail; clicking row 1's chip opens that board full size; nothing scrolls sideways.
- "LA1 board": question 9 with a long why and 5 long answers is one scroll that reaches the last answer and the
  answer box; nothing scrolls sideways.
- The agent writing: the working line's title computes 18 px.
- The builder check and the run view (fixtures with `f.check` and `BS_HANDOFF`'s run): the header is one row with
  the phases and no topic text or parts count.
- The same file in the Terminal center at 1600 px still draws the 30 px heading, the topic and the segments.

### Task 4: The Decided toggle and the narrow history
**Depends on:** Task 1 (the toggle goes in `Toolbar`'s `trailing`, the working history in `WorkingMain`'s `children`; `historyOpen`, `foldedHistory`)
**Files:** `frontend/app/view/agents/brainstormpane.tsx`, `scripts/cdp/scenarios-workspace-brainstorm-history.mjs`

**What to build:** items 2 and 3 in `Design`, narrow only. The rail's list becomes one history component the wide
rail and the narrow main area share. At narrow there is no stacked rail: a "Decided · N" toggle (history icon,
`aria-pressed`) in the header's trailing slot swaps the main area to the history (heading "Decided so far · N",
newest first, the rail's rows) under a "Back to question N" chip (warning-tinted, as the design view's back chip);
the toggle, the chip or `Esc` return. Hidden while `decidedCount` is 0. While the agent writes, the history sits
under the working line on its own and the toggle shows pressed and is inert. Narrow history rows fold per
`foldedHistory`, with "N other options" opening in place. Closes `historyOpen` when the pane is not narrow.

**Acceptance (`workspace-brainstorm-history`, at 600 px):**
- "Main board": question 4 with 3 decided: the header's "Decided · 3" toggle at rest, no rail or second scroller in
  the pane.
- "A2 board": the toggle pressed shows the history newest first (Q3 first, the recon last) under "Back to question
  4"; the back chip returns to the question, and so do the toggle and `Esc` (each checked).
- "A3 board": the agent writing: the working line, then the history under it in one scroll; the toggle reads
  pressed and clicking it changes nothing.
- "LA1/LA2 boards": 8 decided, the toggle reads "Decided · 8"; pressed, a 6-option question shows its pick and "5
  other options", which opens in place to all 6; a 4-option question folds too; Q7's own-words answer shows whole.
- Question 1 with nothing decided draws no toggle.
- At 1600 px in the Terminal center the rail is beside the question as today, and no toggle shows.

### Task 5: One-row transcript card while the tab shows
**Depends on:** Task 1 (its `workspace-brainstorm-cards` scenario file)
**Files:** `frontend/app/view/agents/renderedbrainstorm.tsx`, `frontend/app/view/agents/renderedbsquestion.tsx`, `frontend/app/view/agents/renderedbsdesign.tsx`, `frontend/app/view/agents/renderedbscheck.tsx`, `frontend/app/view/agents/renderedbsreview.tsx`, `scripts/cdp/scenarios-workspace-brainstorm-cards.mjs`

**What to build:** item 6. While the Brainstorm tab is on screen (`shownPane(true, brainstorm, canvas, ws) ===
"brainstorm"`, the rule the digit keys use; no new rule), `CardFrame` draws one row: the card's step (its existing
head lead, e.g. "Brainstorm · 4 →"), a title (the question's text, truncated to the row; "Confirm the design"; the
builder step the check card names; "Review what the check changed"), and Open, with no body, pill or status. Each
card passes its title. The one row keeps `data-rendered-bs-open` on its Open button and the host's
`data-rendered-bs-card`, so `workspace-brainstorm-canvas`'s steps that click Open and wait on the card keep passing.
Otherwise the card is as today.

**Acceptance (`workspace-brainstorm-cards`):**
- With the tab showing, the question card is one row (height under 48 px) holding the question's text and Open, no
  answer rows; closing the tab brings the full card with its answers back.
- The design card's row reads "Confirm the design"; the check card's row names the builder step; the review card's
  row reads "Review what the check changed".
- Switching the pane to another tab, or collapsing it, brings the full card back.

### Task 6: Check, review and run at 600 px
**Depends on:** Task 1 (uses `useBsNarrow`)
**Files:** `frontend/app/view/agents/brainstormreview.tsx`, `frontend/app/view/agents/brainstormrun.tsx`, `frontend/app/view/agents/brainstormcheck.tsx`, `scripts/cdp/scenarios-workspace-brainstorm-check.mjs`

**What to build:** items 7-9. In the tab, the check review's rows and the run view's handed-over rows stack as the
design view's do: the title over its body across the row, actions under them. The review's key-hint footer is not
drawn at narrow (the keys still work). The builder check's approve bar lets the run line wrap under the title
instead of truncating, and its buttons take their own row when they do not fit beside it.

**Acceptance (`workspace-brainstorm-check`, at 600 px):**
- The review: each row's body starts under its title and is wider than 400 px; no `[data-brainstorm-review-hints]`
  in the tab, and `j` still moves the cursor; in the Terminal center at 1600 px the footer is there.
- The run view: a handed-over row's body starts under its title and is wider than 400 px.
- The approve bar: the title and the full run line are visible with no ellipsis (`scrollWidth <= clientWidth`), and
  no button overlaps the text.
