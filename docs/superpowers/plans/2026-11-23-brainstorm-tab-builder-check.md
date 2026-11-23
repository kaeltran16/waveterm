# Brainstorm tab: Builder check

The builder check in the workspace's Brainstorm tab (600 px default, 360 px minimum), built to the approved canvas
(boards Main, A2-many-open, A3-review, A4-narrow-360). The canvas's own colors are the app's `@theme` tokens
(`#5e9cff` accent, `#aebfff` accent-soft, `#e6b450` warning, `#54c79a` success, `#e0726c` error); map onto them,
add none. Read `DESIGN.md` before styling.

What changes at the tab's width:

- The ask rail and the answered rail, which today stack under the main column below 760 px (`BS_SPLIT`/`BS_RAIL`),
  become a one-line **summary** under the stepper: "A builder read the design: …", closed until Show, with a
  scrolling panel (max 300 px) holding the rail's sections.
- The builder question's "Hide pros and cons" toggle moves into its head row beside "Builder N of M · for <part>".
- The pros and cons under an answer row stack in one column; below 480 px the answer rows tighten (A4).
- The approve bar's reason row is not drawn; the reason stays as the disabled button's title.

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-brainstorm-question workspace-brainstorm-check brainstorm-builder-ask brainstorm-builder-check brainstorm-check-review brainstorm-mode brainstorm-question-reasons`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\brainstorm-workspace\project\Main.dc.html

## Decisions beyond the design

- **Narrow only, wide unchanged.** The boards are 600 and 360 px. The summary line, the hidden approve-reason row
  and the hidden one-segment track apply only where `useBsNarrow()` is true (below the existing 760 px `bs`
  breakpoint). Any brainstorm pane 760 px or wider (the Terminal center at 1600, a tab dragged wide) keeps today's
  rails, approve-reason row and track. The design says nothing about wide, so it stays as it is. The one exception is the pros-and-cons toggle in the
  builder head (Task 3), which applies at every width. A builder question has no read line, so today the toggle sits
  alone on an empty row at every width.
- **"Wide" is the pane, not the window.** Narrow is the `bs` container under 760 px, so a 1000x700 window can put
  the Terminal-center brainstorm on the narrow side. brainstorm-builder-check step 4c and brainstorm-check-review
  steps 1c/1d run there. Task 2 measures it (`data-brainstorm-narrow` on the pane at 1000x700). If the pane is
  narrow there, those steps change to the narrow layout (the summary instead of the rail, no reason row) and keep
  what they measure (main column width, Approve inside the viewport, button rows sharing a top edge).
- **One source for the rail's sections.** The summary panel holds the same sections as the wide rails: "For you",
  "The agent decided", "Already in the design" while asking; "You answered" while reviewing. Task 2 lifts them out
  of `AskRail`/`AnsweredRail` into section components that both the rails and the panel render, so the two
  layouts never drift. The ask sections and the summary stay in `brainstormcheck.tsx`. The answered section is
  exported from `brainstormreview.tsx`, which `brainstormcheck.tsx` already imports, and the review file imports
  nothing from the check file, so there is no import cycle. The design's A3 panel adds "Already in the design"
  under "You answered"; the wide answered rail does not gain it (wide unchanged).
- **Motion reuses existing moments.** The panel opening and closing is moment 6b, `PaneReveal` (`paneReveal`),
  rendered unconditionally and driven by `open`. The chevron turns with `turnTransition`, as the review rows'
  chevrons do. The panel's section counts are `TickNumber`s (moment 12), as the rail's are.
- **The panel's intro is the rail line's first sentence only.** "A fresh agent checked whether it could plan from
  this without coming back to you." The count sentence (`checkRailLine`'s "It had N questions.") repeats the
  summary line, so the panel leaves it out. The review panel has no intro, as A3 draws none.
- **"For you" shows only with more than one question.** Main (1 for you) has no queue in its open panel and A2
  (3 for you) does. With one question the queue would repeat the question on screen. The track follows the same
  rule at narrow (Main has none, A2 has three segments).
- **The summary's count line is a pure model function** (`checkSummaryLine` in `brainstormmodel.ts`) computed from
  the file, beside `checkRailLine`/`answeredLine`. A zero count for decided calls or already-in-design is left out.
  Zero for you reads "none for you". "all answered" is appended only when every question for you has an answer.
- **The open state is local to the mounted check view** (closed on mount, as Main's title says). It is not
  persisted per agent: the tab remounts rarely, and the design never shows it restored.
- **The 360 px tier is a container query on the existing `bs` container**, `@max-[480px]/bs:` classes. It is not
  a second measured context, because only class sizes change (A4: 26 px number, 16 px label, 13.5 px detail, 14 px
  row padding, pros and cons indented 52 px, no "press Enter", head row and chip row wrap, the stepper wrapping,
  22 px main padding, the summary line top-aligned at line-height 1.45). 480 is where the 600 px sizes stop fitting
  the 360 board. The tier sits on the shared non-compact `Options` rows. At narrow only the builder question
  draws those: the talk question is compact there, and `JudgingMain` draws its own approach rows, not `Options`. So
  nothing else changes. The 22 px main padding sits on `MainBody`, so the talk question at 360 gets it too, which
  matches A4.
- **The approve reason row goes at narrow** because all three boards with a disabled Approve draw none, only the
  button's title ("Answer the builder's 1 question, then review what it changes", "Review 1 change"). The summary
  line and the main area already say what is pending.
- **The "for <part>" link takes the link color** (`LINK`, accent-soft) as the boards draw it, not today's warning
  text.

### Task 1: Answer rows at the tab's width and the 360 px tier
**Depends on:** none
**Files:** `frontend/app/view/agents/brainstormui.tsx`, `scripts/cdp/scenarios-shared.mjs`, `scripts/cdp/scenarios-workspace-brainstorm-question.mjs`

**What to build:** the shared answer controls in `brainstormui.tsx` as the boards draw them at narrow.

- The pros and cons under a non-compact answer row stack in one column (pros, then cons) below the 760 px `bs`
  breakpoint, at 13 px, instead of the wide two-column grid.
- Below 480 px (`@max-[480px]/bs:`), a non-compact answer row tightens to A4: 14 px padding, 12 px gap, a 26 px
  number at 12 px, a 16 px label, 13.5 px detail, the row's content aligned to its top, and the pros and cons
  indented 52 px.
- `AnswerBox`'s "press Enter" hint is not drawn below 480 px.
- Below 480 px the narrow toolbar's stepper (`Phases`' `ol`) wraps instead of overflowing, and `MainBody`'s
  narrow side padding is 22 px instead of 28 px.
- The pros-and-cons toggle becomes a component other views can place, while `QuestionAnswers` keeps its own toggle
  when not handed one. With `reasonsShown` set, `QuestionAnswers` draws no toggle and shows the rows' pros and
  cons by that value. Its read line, if the question has one, still draws.
- Export a builder-question fixture `BS_BUILDER_OPTIONS` from `scenarios-shared.mjs`: three answer options, the
  first `pick: true`, each with at least one pro and one con. Task 3 reuses it.

**Interfaces:**
- `export function ProsConsToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void })`: the existing
  chip with `data-brainstorm-proscons-toggle`, `aria-expanded={shown}`, "Hide pros and cons" / "Show pros and cons".
- `QuestionAnswers` gains the optional prop `reasonsShown?: boolean`.
- `BS_BUILDER_OPTIONS` in `scripts/cdp/scenarios-shared.mjs`.

**Acceptance:**
- The talk question's toggle (`brainstorm-question-reasons`, `brainstorm-mode`) still shows, hides and reveals
  pros and cons as before.
- New steps in `workspace-brainstorm-question`, in the 600 px tab on a builder check whose open question carries
  `BS_BUILDER_OPTIONS`:
  - at 600 px each option's pros and cons sit in one column (cons below pros);
  - with the width set to 360 (`workspaceWidthAtom`; the scenario's teardown already restores the width) the first
    row's number box is 26 px, its label 16 px, its detail 13.5 px, and the answer box's "press Enter" is not
    displayed. The main body's left padding is 22 px, and the stepper's `ol` fits inside the toolbar
    (`scrollWidth <= clientWidth`), wrapping onto a second line. That step takes a screenshot as the A4 board's
    answer rows.

### Task 2: The builder summary line replaces the stacked rail
**Depends on:** none
**Files:** `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `frontend/app/view/agents/brainstormcheck.tsx`, `frontend/app/view/agents/brainstormreview.tsx`, `scripts/cdp/scenarios-workspace-brainstorm-check.mjs`, `scripts/cdp/scenarios-brainstorm-builder.mjs`, `scripts/cdp/scenarios-brainstorm-review.mjs`

**What to build:** at narrow, the builder check (`Check` in `brainstormcheck.tsx`) draws no rail. Under the stepper
toolbar (and the stale banner) it draws the summary: a full-width button (`aria-expanded`) reading
"A builder read the design: 4 questions, **1 for you**, 3 already in the design". The bold run is `yours`. On its
right sits "Show" with a down chevron, or "Hide" with the chevron turned up. Open, a panel under it (max 300 px,
scrolls) holds:

- while the main area is not the review: the intro "A fresh agent checked whether it could plan from this without
  coming back to you."; "For you · N" ("only you can answer") with the queue's rows and their now / answered /
  waiting dots, drawn only when N > 1; "The agent decided · N" ("you review them with the changes") with the calls
  grouped by part, each part title a link that moves the review cursor as the rail's does; "Already in the design ·
  N", or the rail's "Nothing the builder asked was already in the design."
- while the main area is the review: "You answered · N", each with its question, a check and the answer, and
  "Changed <part links>" that move the review cursor; then "Already in the design · N".

The panel opens and closes with `PaneReveal` (moment 6b) and the chevron turns with `turnTransition`. Below 480 px
the summary button aligns its content to the top at line-height 1.45, so at 360 the line wraps to two lines with
Show on the first.

The wide `AskRail` and `AnsweredRail` render the same section components and look as they do today. The ask
sections and the summary live in `brainstormcheck.tsx`, and the answered section is exported from
`brainstormreview.tsx`. With no `f.check`, no summary is drawn.

Measure whether the Terminal-center pane is narrow at 1000x700. If it is, update brainstorm-builder-check step 4c
(`scenarios-brainstorm-builder.mjs`) and brainstorm-check-review steps 1c/1d (`scenarios-brainstorm-review.mjs`)
to the narrow layout, keeping what each measures. If it is not, leave those files untouched.

At narrow the approve bar draws no reason row (`data-brainstorm-approve-reason`). The disabled Approve keeps the
blocker as its title. Wide keeps the row.

**Interfaces:**
- `export function checkSummaryLine(f: BrainstormFile): { lead: string; yours: string; rest: string }` in
  `brainstormmodel.ts`. Examples: (4 questions, 1 yours unanswered, 0 calls, 3 already) gives
  `lead "A builder read the design: 4 questions, "`, `yours "1 for you"`, `rest ", 3 already in the design"`.
  (8, 3 yours one answered, 2 calls, 3 already) gives `yours "3 for you"`,
  `rest ", 2 the agent decided, 3 already in the design"`. (4, 1 yours answered, 0, 3) gives
  `yours "1 for you, all answered"`. 0 yours gives `yours "none for you"`. A zero calls or already count is left
  out of `rest`.
- The summary root carries `data-brainstorm-check-summary`; its panel `data-brainstorm-check-summary-panel`.

**Acceptance:**
- `checkSummaryLine` returns the strings above for those cases (unit tests at the model seam).
- In the 600 px tab (`workspace-brainstorm-check`), with Main's check: a local variant of `BS_HANDOFF` whose check
  has 1 question for you, `calls: []` and 3 already-in-design lines. No `aside[aria-label="The builder check"]` is
  drawn. The summary reads exactly "A builder read the design: 4 questions, 1 for you, 3 already in the design" and
  is closed (`aria-expanded="false"`, panel height 0). After Show the panel has grown to a non-zero height and
  holds the intro and "Already in the design · 3", with no "For you" and no "The agent decided" section. After Hide
  its height returns to 0. Screenshot as the Main board.
- Same tab, a check with 3 questions for you, the first answered, and calls on two parts: the open panel has
  "For you · 3" with dots answered / now / waiting, "The agent decided · 2" with a part link that moves the review
  cursor to that part, and "Already in the design". Screenshot as the A2 board.
- Same tab on the review (`REVIEW_FILE`): the summary reads "…1 for you, all answered…"; open, it has "You
  answered · 1" whose Changed link moves the review cursor, and "Already in the design". No
  `data-brainstorm-approve-reason` is drawn, and the disabled Approve's title is the blocker text. Screenshot as
  the A3 board.
- The existing 1600 px Terminal-center step still finds the review's key hints, and the Terminal-center scenarios
  in Final pass: brainstorm-builder-ask, brainstorm-builder-check, brainstorm-check-review and brainstorm-mode.
  Steps that run at 1000x700 pass with the layout the measured pane width gives.

### Task 3: The builder question's head row
**Depends on:** Task 1 (uses `ProsConsToggle`, `QuestionAnswers.reasonsShown` and `BS_BUILDER_OPTIONS`), Task 2
**Files:** `frontend/app/view/agents/brainstormcheck.tsx`, `scripts/cdp/scenarios-workspace-brainstorm-check.mjs`, `scripts/cdp/scenarios-brainstorm-builder.mjs`

**What to build:** `BuilderAsk` as the boards draw it. `data-brainstorm-builder-head` stays on the label span
("Builder N of M · for <part>"), not on the new row that holds it and the toggle. brainstorm-builder-ask reads
that span's text. Touch `scenarios-brainstorm-builder.mjs` only if a step there depends on what this task
changes.

- At every width, when the open question's options have pros or cons, its head row holds "Builder N of M · for
  <part>" on the left and `ProsConsToggle` on the right. `BuilderAsk` owns the shown state (shown at first) and
  passes it to `QuestionAnswers` as `reasonsShown`, so no toggle row draws above the answers.
- The "for <part>" title is a `LINK`-colored button.
- At narrow the track is not drawn when the check has one question for you.
- Below 480 px (`@max-[480px]/bs:`) the head row wraps, the label taking the row and the toggle going under it
  when they do not fit. The "Let the agent decide" / "The design · N of M yours" row wraps without its spacer.

**Acceptance:**
- In the 600 px tab on a 1-question check whose question carries `BS_BUILDER_OPTIONS`: the head row's toggle sits
  on the same line as "Builder 1 of 1", no `data-brainstorm-proscons-toggle` sits inside the answers group, the
  "for" link's color is the accent-soft token, and no `data-brainstorm-track` is drawn. Clicking the toggle hides
  every row's pros and cons and reads "Show pros and cons"; clicking again shows them. Screenshot as the Main board
  with pros and cons shown.
- The same tab on Task 2's 3-question check draws the track with three segments.
- With the width at 360: no element in the builder question overflows the pane horizontally
  (`scrollWidth <= clientWidth` on the main column and on the toolbar). The toggle and both chips are fully inside
  it. The summary line is closed and spans two lines, with "Show" top-aligned to its first line. Screenshot as the
  A4 board.
- brainstorm-builder-ask and brainstorm-builder-check pass (the toggle and link color change at every width).
