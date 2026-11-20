# Brainstorm cards: one header row

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs rendered-bs-question rendered-bs-boards workspace-brainstorm-cards rendered-bs-check rendered-bs-design rendered-bs-review rendered-bs-run rendered-bs-mockup workspace-pane-canvas rendered-bs-rows`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\brainstorm-cards\project

This plan restyles the Rendered transcript's brainstorm cards (`frontend/app/view/agents/renderedbrainstorm.tsx` CardFrame,
the `renderedbs*.tsx` cards and the answer rows in `renderedbsrows.tsx`) to the approved canvas above. Every board's
`.head` is the shared header row: icon, kind, subject, chip, a flexible gap, status, and one link. A body sits under an
`edge-faint` rule. Read the board and its `<style>` helmet for sizes and spacing. Colors come only from the `@theme`
tokens in `frontend/tailwindsetup.css` (DESIGN.md). The board hexes map onto existing tokens: `--askingbg` is
`bg-warning/12`, and an error card border is `border-error/45`. Grey `.cap` captions are annotations and are not UI.

Decisions beyond the design, with why:

- **Every CardFrame folds to the one-row card while the Brainstorm tab shows, and that row is always the Brainstorm
  header.** It has the Lightbulb, `Brainstorm`, the topic, the chip while the card asks, the card's `title` in the
  status slot, and Open brainstorm. This applies whatever the card's full kind is. Main's last board shows this row
  with a check-phase title.
  - Today's row titles stay as they are (`Confirm the design`, `Builder question · 1 of 1`, `Review what the check
    changed`), so the pane-tab behaviour is unchanged.
  - The settled design and the gone cards newly fold too, by the same rule; their titles are named in Tasks 4 and 6.
    One rule is simpler than an opt-out prop, and the Brainstorm tab already shows what their bodies say.
- **"Topic on every brainstorm card" means every card whose kind is `Brainstorm`:** question, design confirm, settled
  design, review, approve, the one-row card, and the removed-file card (its subject names the topic). The Builder check
  and Builder question cards carry their own subject (`3 questions back`, `1 of 1`), as in States-Check. Today the
  question and design cards lack the topic; the review card already shows it.
- **Chips** use the asking tone (warning border plus a warning chip). `Needs your input` goes on the question, builder
  question, design-confirm and review cards. `Ready for the builder check` goes on the settled design.
  `Ready to approve` goes on the approve card. Each label is the one its board shows.
- **A settled check keeps its summary card's body** (the spec path and the counts) above the approve card, as Main
  draws it. The States-Check pair that folds the summary to a header row is not adopted: its `A builder read the
  design` would repeat the approve card's own heading directly below.
- **`NeedsInputPill` stays exported.** The agent's own AskCard (`renderedview.tsx`) still draws it. Only the pill above
  a brainstorm card goes.
- **The picks hint follows the goal's wording, not the older boards.** Main, Narrow, States-Question and States-Check
  still show `1–N picks`; only HardCases shows `press 1–9 to pick`, which is the goal's wording.
  - `picksHint` keeps its signature `(rows: number) => string` and caps the key range at `OPTION_KEYS.length` inside
    the function, so every caller gets the fix.
  - It returns `answer in the box below` for 0 rows, `press 1 to pick · or type your own answer below` for 1, and
    `press 1–N to pick · or type your own answer below` above that.
  - One `PicksHint` component draws the keys as the HardCases `.kbd`, for both question cards.
- **The builder answer row reads `Builder question` with no number.** The row view carries no builder index
  (`n: null`), and the goal names `Builder question`. HardCases' `Builder question 1` would need a model field for a
  label alone.
- **The question's part link moves from the head to the body meta line** (`Question 3 → Approach`,
  `Builder question 1 → Final queue`). It keeps `data-rendered-bs-part-link` and still opens the pane at that part.
- Existing `data-*` hooks stay where the element they mark survives (`data-rendered-bs-open`, `-frame`, `-head`,
  `-status`, `-row`, `-row-title`, `data-rendered-mockup-*`, `data-rbs-*`). Other scenarios click them.

### Task 1: The shared header row
**Depends on:** none
**Files:** `frontend/app/view/agents/renderedbrainstorm.tsx`, `frontend/app/view/agents/renderedbsquestion.tsx`, `frontend/app/view/agents/renderedbsquestionmodel.ts`, `frontend/app/view/agents/renderedbsquestionmodel.test.ts`, `frontend/app/view/agents/renderedbscheck.tsx`, `frontend/app/view/agents/renderedbsdesign.tsx`, `frontend/app/view/agents/renderedbsreview.tsx`, `scripts/cdp/scenarios-workspace-brainstorm-cards.mjs`

**What to build:** CardFrame draws the boards' header row with the body under it, and no pill above the card. A
`CardHead` piece holds the row's layout and left cluster, and the Mockup card reuses it.

- **Header row:** 11px vertical and 16px horizontal padding at 13.5px, as `.head`. In a narrow column it wraps the
  chip and the status onto a second line (Narrow).
- **Callers:** every caller drops the removed `head`, `step` and `lead` props and takes the default Brainstorm header.
  The question card's `Question N → part` and the builder question's own header are rebuilt in Tasks 2 and 3; until
  then they show the default header.
- **Shared by both question cards** (they live in this task so Tasks 2 and 3 both build on them):
  - `picksHint`'s new wording and cap;
  - `PicksHint`, used in place of the plain hint in both cards;
  - OptionRows: rows past the 9th draw a blank of the key's width instead of a number.

**Interfaces** (exported from `renderedbrainstorm.tsx`, used by Tasks 2-7):

```ts
CardFrame(p: {
    agent: AgentVM; s: BrainstormState; f: BrainstormFile | null;
    asking: boolean;          // warning border and the chip
    chip?: string;            // the chip's words while asking; default "Needs your input"
    tone?: "error";           // error border (a failed check, an unreadable file)
    icon?: ReactNode;         // default the Lightbulb
    kind?: string;            // default "Brainstorm"
    subject?: ReactNode;      // default s.topic, mono
    status?: ReactNode;       // default cardStatus(f) when f is set; "" for none
    link?: ReactNode | null;  // default Open brainstorm (data-rendered-bs-open); null for none
    title: string;            // the one-row card's status words
    compact: boolean;
    attr: string;
    children?: ReactNode;     // the body; none draws the header alone
})
CardHead(p: { icon: ReactNode; kind: string; subject: ReactNode; mono?: boolean; compact: boolean; children?: ReactNode })
```

From `renderedbsquestion.tsx`, `PicksHint({ rows }: { rows: number })` is exported beside `OptionRows`.

**Acceptance:**
- The existing `picksHint` table covers 0 → `answer in the box below`, 1 → `press 1 to pick · or type your own answer
  below`, 3 → `press 1–3 to pick · …` and 12 → `press 1–9 to pick · …`. The 12 case is the regression; today it says
  `1–12 picks`.
- `workspace-brainstorm-cards` asserts that each one-row card is the header alone: Brainstorm, the topic, the chip while
  it asks (`isRow` no longer expects `!pill`), and its existing title in `[data-rendered-bs-row-title]` with Open
  brainstorm.
- `ROW_MAX_PX` is re-derived from the new row: its height measured on one line, and on two lines when compact. The
  bound sits above that and still below the full card's height, with a comment saying where the number comes from.
- The ten-option keys and hint are shown by Task 2's `rendered-bs-question` HardCases step.

### Task 2: The talk question card
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/renderedbsquestion.tsx`, `scripts/cdp/scenarios-rendered-bs-question.mjs`

**What to build:** The talk question card follows Main, States-Question, HardCases' ten options and Narrow:

- **Header:** `Brainstorm`, the topic in mono, the `Needs your input` chip, `cardStatus`, and Open brainstorm.
- **Body:** the meta line `Question N → <part>` (just `Question N` with no part), the question and why, the judge strip
  while judging (its clock stays in the strip), the options, the judge's work, and the actions with `PicksHint`.
- **Started row:** it loses Open brainstorm.
- **Judging:** the `Waiting for the judge` line under the card goes (`data-rendered-bs-judge-wait`).

**Acceptance:**
- `rendered-bs-question` steps for Main, judging, judge failed, open question and Narrow assert:
  - the header reads `Brainstorm <topic> Needs your input <status> Open brainstorm`, with `[data-needs-input]` absent
    from the host;
  - the meta line reads `Question N → <part>`, and clicking the part opens the pane at it;
  - the Started row has no Open brainstorm;
  - no `[data-rendered-bs-judge-wait]` appears while judging;
  - the hints read `press 1–N to pick · or type your own answer below`.
- A new HardCases step (ten options) asserts keys `1`–`9` on the first nine rows, no key on the tenth, and the hint
  `press 1–9 to pick · or type your own answer below`.
- `rendered-bs-boards` still passes, since the option chips sit beside the restyled OptionRows.

### Task 3: Builder check card, the builder question and the approve card
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/renderedbscheck.tsx`, `frontend/app/view/agents/renderedbscheckmodel.ts`, `frontend/app/view/agents/renderedbscheckmodel.test.ts`, `scripts/cdp/scenarios-rendered-bs-check.mjs`

**What to build:** ClockBox, FailedBox and SummaryBox become CardFrames with kind `Builder check` (States-Check, Main):

- **Reading:** a spinner icon, success-colored within the usual time and warning-colored past it. The subject is the
  state line, the status is `usual … · longest …`, and the link slot holds the mono clock. The body has the bar and
  the note.
- **Taking in:** the success dot and `Taking in the builder's questions.`, with the times. It draws at full strength:
  nothing in it below opacity 1, and no muted subject.
- **Failed:** `tone: "error"`, an error-colored icon, `The builder check did not finish`, and Try again in the link
  slot. The body holds the reason.
- **Questions back:** a FileCheck icon, `N questions back`, and the Spec link. The body has the spec path and the
  counts.
- **Builder question** (States-Check, HardCases): kind `Builder question`, subject `i of n`, the `Needs your input`
  chip, no status, and Open brainstorm. The body has the meta line `Builder question i → <part>` with the part link,
  the question and why, OptionRows, Let the agent decide, and `PicksHint`. `builderHead` gives the pieces this needs.
  Its row title stays `Builder question · i of n` (`checkRowTitle`).
- **Approve:** ApproveBar becomes a Brainstorm CardFrame with the `Ready to approve` chip and status `Builder check`.
  Its body keeps the heading, settled line, blocker, Keep talking and Approve and start run.
- **Past the usual time:** only the lead `Taking longer than usual:` is warning-colored; the rest of the note stays
  muted. The lead is one exported constant shared by the model's note and the view's split, not retyped.

**Acceptance:**
- The `cardClock` and `builderHead`/`checkRowTitle` tests cover the past-usual note's lead and its rest (through the
  exported constant), the builder head's pieces, and the unchanged row title.
- `rendered-bs-check` steps assert each state:
  - reading: header `Builder check A builder is reading the design. usual … · longest …` with the clock;
  - past usual: only the lead carries `text-warning` (`noteWarns` now reads the lead);
  - taking in: computed opacity 1 on the card and every ancestor up to the host, read after the swap settles;
  - failed: header with Try again;
  - questions back: `Builder check N questions back Spec`;
  - builder question: `Builder question 1 of 1 Needs your input Open brainstorm`, the meta line, and the hint
    `press 1–2 to pick · …`;
  - settled: the summary card above the approve card, whose header reads
    `Brainstorm <topic> Ready to approve Builder check Open brainstorm`.
- A step for HardCases' second builder question asserts the header subject `2 of 3`.

### Task 4: Design card: confirm and settled
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/renderedbsdesign.tsx`, `scripts/cdp/scenarios-rendered-bs-design.mjs`

**What to build:** The confirm card's body follows Review and States-Design:

- The `Confirm the design` heading at question size, its why line, and Confirm all on the right.
- Rows: dot, name, gist, and actions, with the `changed` tag as the 12px accent-soft text before That's right.
- What the agent found and the waiting hint.

SettledDesign stops being a headless row. It becomes a CardFrame with the `Ready for the builder check` chip, no status
(`status=""`) and Open brainstorm. Its body is one row: the check icon, `The design · N of N yours`, the confirmed-guesses
hint, and Check with a builder. Its `title` is the design view's settled `line` (`The design · N of N yours`), so it
folds to that row while the Brainstorm tab shows.

**Acceptance:** `rendered-bs-design` steps assert the confirm header
`Brainstorm <topic> Needs your input Talking it through · … Open brainstorm`, the `changed` tag on a changed row
(States-Design), and the settled card's header `Brainstorm <topic> Ready for the builder check Open brainstorm` above
its one body row. They replace the old `no card head` expectation.

### Task 5: Review card: plain source tags and calls
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/renderedbsreview.tsx`, `scripts/cdp/scenarios-rendered-bs-review.mjs`

**What to build:** The review body follows Review and HardCases:

- A row's source tag (`builder question 1`, `answer 3: …`, `check`, from `row.cause`) is plain muted sans 12px on its
  own line under the gist. It is no longer mono.
- `Agent's call` loses its tinted fill: a semibold secondary lead, then the call in ink-mid 12.5px, in the row's
  text column.
- Yours, unchanged and What the agent found draw as the board's `.fold` lines.
- The picks bar is the board's `.sendbar`.

**Acceptance:** `rendered-bs-review` steps assert:
- the header `Brainstorm <topic> Needs your input Checking with a builder Open brainstorm`;
- `[data-rendered-bs-review-cause]` has no `font-mono` class and a computed sans family;
- each `[data-rendered-bs-review-call]` has a transparent computed background;
- the HardCases choice-made state shows `1 choice made, 2 still open` with Send.

### Task 6: Gone cards on the header
**Depends on:** Task 1 (uses the new CardFrame props: kind, subject, tone, link)
**Files:** `frontend/app/view/agents/renderedbsrun.tsx`, `frontend/app/view/agents/renderedbsrunmodel.ts`, `frontend/app/view/agents/renderedbsrunmodel.test.ts`, `scripts/cdp/scenarios-rendered-bs-run.mjs`

**What to build:** Per States-Gone, the removed and unreadable cards become CardFrames with `link={null}` and no
status. Each card's `title` is its `goneView` title, so it folds to that row while the Brainstorm tab shows.

- **Removed:** the subject is `<topic>'s brainstorm file is gone`.
  - The body line stays `brainstormGoneText(path)` followed by `The answers above stay in the transcript.`, which keeps
    its run-worktree variant. Do not edit `brainstormmodel.ts`, since `brainstormpane.tsx` and its test use it.
  - The mono path shows under the line only when the line does not already contain it. `goneView` may add a path field
    for this, and its test changes with it.
- **Unreadable:** `tone: "error"`, an error-colored icon, and the subject `Arc could not read this brainstorm`. The
  body has the error line in secondary, then the path.
- **Closed:** the closed row and the Started run row stay as they are.

**Acceptance:** `rendered-bs-run` steps assert the removed card's header `Brainstorm <topic>'s brainstorm file is
gone` with its line in the body, and the unreadable card's header with its error and path. `data-rendered-bs-gone`
values are unchanged.

### Task 7: Mockup card on the shared header
**Depends on:** Task 1 (uses `CardHead`)
**Files:** `frontend/app/view/agents/renderedbsboards.tsx`, `scripts/cdp/scenarios-rendered-bs-mockup.mjs`, `scripts/cdp/scenarios-workspace-pane.mjs`

**What to build:** MockupHead draws through `CardHead`, as on Main: PanelsTopLeft, `Mockup`, the topic in mono, and
the status `N boards · updated Xs ago` before the gap. Then Open canvas and Mark. In a narrow column, Open canvas and
Mark wrap to a second line (Narrow), replacing today's stacked layout. The empty, server-down and removed states keep
their bodies and rows. `data-rendered-mockup-*` hooks stay.

**Acceptance:**
- `rendered-bs-mockup` steps assert the header reads `Mockup <topic> N boards · updated … Open canvas Mark` on one line
  wide. A narrow step asserts that the status shares the first line with the topic while Open canvas and Mark sit on
  the second.
- `workspace-pane-canvas`'s mockup-row step reads the new text: it asserts `startsWith("Mockup <topic> N boards ·
  updated")`, replacing today's `N boards updated`.

### Task 8: Answer rows read Question N
**Depends on:** none
**Files:** `frontend/app/view/agents/renderedbsrows.tsx`, `scripts/cdp/scenarios-rendered-bs-rows.mjs`

**What to build:** The folded answer follows States-Question's `.ans` row: the Lightbulb, the kind `Question N` (or
`Builder question`) in ink-mid sans, the question in ink-mid at weight 400, the gap, the check, the answer, where it
was picked, and the chevron. Its padding and size match the board. The opened body is unchanged in content. The pinned
bar shares AnswerSummary, so it reads `Question N` too. The centred `You answered question N:` row stays.

**Acceptance:** `rendered-bs-rows` steps match rows by `Question 1`, `Question 2` and `Question 4`, and the builder
answer by `Builder question`, never `Q1` or `Builder` alone. They assert the label carries no `font-mono` class.
