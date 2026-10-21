# Brainstorm pane: builder check and Run step — Implementation Plan

> **For agentic workers:** each task's worker implements its own task only. The interfaces below are the
> contract between tasks: use the exact names and shapes, and do not edit a file another task owns.

**Goal:** Redesign the brainstorm pane's builder check (the builder's question fills the main area; a review
of what the check changed, decision by decision) and its Run step (the design handed over, the run's real
state, Close the brainstorm), and fix the five bugs the goal lists.

**Architecture:** Pure derivations in `brainstormmodel.ts` (check) and `brainstormrunmodel.ts` (run step)
with vitest beside them; thin components split out of the 1,900-line `brainstormpane.tsx` into
`brainstormui.tsx` (shared pieces), `brainstormcheck.tsx` (check layout + asking), `brainstormreview.tsx`
(review) and `brainstormrun.tsx` (run step). Task 1 lands the skeleton (every type, signature, slot, store
field and the scenario wiring) so the model work and the three UI tasks run beside each other. Each UI task
writes its own CDP scenario module, which `scenarios.mjs` spreads into `SCENARIOS`.

**Tech Stack:** React 19, jotai, Tailwind 4 `@theme` tokens, vitest, CDP scenarios.

**Verify:** `node scripts/verify.mjs ./skills/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs brainstorm-builder-ask brainstorm-check-review brainstorm-run-blocked brainstorm-run-landed brainstorm-run-missing brainstorm-mode brainstorm-main brainstorm-question-reasons brainstorm-review-skim brainstorm-rail-reasons`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/brainstorm-builder-step/project/Main.dc.html

The canvas folder (`C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/brainstorm-builder-step/project/`)
is the spec: boards `Main.dc.html`, `Check-Review.dc.html`, `Run-Blocked.dc.html`, `Run-Landed.dc.html`.
Read the board your task builds before you start, and `DESIGN.md`. There is no separate spec file.

## Decisions made beyond the canvas (and why)

1. **No new wshrpc command.** `FileDeleteCommand` with `recursive: true` (already used by the code view's
   delete, `codestore.ts`) removes a directory with `os.RemoveAll`. Reusing it keeps `task generate` and Go
   out of this plan.
2. **Close is guarded in pure code.** `closeTargets` refuses a `topic` or `canvas` that is not one plain path
   segment (empty, `.`, `..`, or containing `/` or `\`): both come from an agent-written file, and a canvas
   of `../..` would otherwise delete outside the project. The gate (run landed **and** its final `passed`) is
   re-checked at click time, not only when the button draws. The canvas directory is deleted first, then the
   brainstorm directory, so a failed first delete leaves the brainstorm (and its Close button) in place for a
   retry; each failure is shown under the button with the path, and a path already gone counts as done.
3. **Builder questions settle like talk questions.** `check.yours[]` entries gain `part` (the part the
   question is for), `label` (a short line for the rail's queue; the full `q` when absent), `options`
   (parsed with the same `parseOptions` as talk questions: label, detail, pick, pros, cons), and `into`
   becomes a list (a string in the file still parses, as a one-item list) so the review rail can say which
   decisions an answer changed. A picked option is sent as `brainstorm: builder answer: <label>`, like a typed one.
4. **Let the agent decide** is a new line, `brainstorm: builder decide`: the agent moves the first unanswered
   `check.yours` entry into `check.calls` under its part. Arc keeps no state for it: the entry leaves `yours`.
5. **Which question the main area shows during the check:** the talk question first (the agent is waiting on
   it in the terminal, and its answer may settle builder questions — bug 3), then the first unanswered
   builder question, else the review. While the agent writes, the working view. The design chip opens the
   review over a question (the existing `designOpen` flag); the Check wrapper draws a "Back to the question"
   button over the review then. The Check-Review board draws the review while question 16 is open, i.e. the
   review opened over a question.
6. **The review's rows are derived, not stored.** "Changed since you confirmed" = decision parts with `was`
   (pending keep/put back) plus decision parts that are `yours` and either in `check.touched` or carrying an
   agent's call (drawn settled, "Yours"). "New since the check" = decisions that are a guess without `was`,
   `asked` or `open` — nothing but `yours` can exist when the check starts, so anything else is new. The
   cause line is the part's `why` (the skill names the answer that caused it), else its `from`.
7. **Approve blocks until the design is settled** (bug 1): no talk question open, every builder question
   answered or delegated, and every decision (not notes) `yours`. Exact copy is in Task 2.
8. **Run state is read from the run, never from `f.run` alone** (bug 4). The final stage comes from the
   dag's own `final` (`TaskGroup.final`, live over WOS), else the digest's; the land from `Run.land`.
   "Merged" means `land.state === "landed"`. Run ids show 8 characters (the boards' `Open run 9c6eb723`), a
   merge sha 7. Once merged, the phase stepper reads all three phases done (Run-Landed board).
9. **Keys in the review:** `j`/`k` move the review cursor instead of the agent cursor while the review is the
   main area (the arrows and `Ctrl+Tab` still move between agents); `Enter` toggles the cursor row's
   was/now only when focus is not on a button, input or textarea; `y` keeps the change (on a guess row it
   confirms, "That's right"); `u` puts mine back (changed rows only); `b` keeps its job, back to the terminal.
   `y` and `u` are bound nowhere on the Agent surface today. The cursor and the open rows live in the
   agent's `BrainstormState`, since the keybindings and the asking rail's links act on them from outside the review.
10. **Scenario modules instead of one shared file.** Three UI tasks run at once, so each owns
    `scripts/cdp/scenarios-brainstorm-<x>.mjs`, exporting `default function (kit) { return [scenario, ...]; }`.
    Task 1 wires them and passes the helpers as `kit`; a helper not in the kit is copied locally.
11. **Old check/run scenario steps are retired**, not patched: `brainstorm-mode` steps 8 through 9d and the
    whole `brainstorm-check-answered` scenario assert DOM this redesign removes (count tiles, the 430px card,
    "Run X started"). The new modules cover what they proved (lines sent, approve opening New run, tree line).
12. **The check and run views drop the toolbar's Progress segments**: every board's top bar is title +
    phases only. The talk view keeps them.
13. The design chip keeps today's `designLabel` copy ("The design · 3 of 13 yours"); the board's
    "decisions yours" variant is not worth changing the talk view's label. Acceptance reads today's copy.
14. A `closeTargets` refusal draws Close disabled with the refusal as the error line under it.

## Global Constraints

- Colors only from `@theme` tokens (`frontend/tailwindsetup.css`); no new tokens. Copy classes from the
  existing brainstorm components; inline diff lines use `diff-added` / `diff-removed` (bug 5).
- Fluid content; fixed widths only for the 460px rails.
- Copy uses the boards' wording (section captions included) and typographic apostrophes (’) as the pane does.
- Never hand-edit generated files. Edit `skills/`, never the copies of the skill.
- Every action that changes the design is one line sent to the agent (`sendBrainstorm`); the only thing Arc
  ever deletes is the Close targets.

## Review Focus

1. A canvas or topic name that is not one path segment (`..`, `a/b`, empty): Close must refuse, never
   delete. Pinned in Task 4's `closeTargets` tests and Task 7's scenario step.
2. A run that is gone or still loading (`f.run` names a run Arc can't find): the Run step and tree line say
   so, and Close stays off. Pinned in Task 4's tests and the `brainstorm-run-missing` scenario.
3. A `check.yours` entry with `into` as a string (files written before this change) and calls with no
   `part`: parse and group without dropping anything. Pinned in Task 1 and Task 2 tests.
4. `j`/`k`/`y`/`u`/`Enter` typed into the answer box or an edit textarea: must type, not act. Pinned in
   Task 6's binding tests.
5. Close pressed twice, or the brainstorm dir deleted by the agent first: a missing path is done, not an
   error that hides the removed view. Task 7.

---

### Task 1: Skeleton: types, signatures, pane split, store, scenario wiring
**Depends on:** none
**Files:** `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `frontend/app/view/agents/brainstormstore.ts`, `frontend/app/view/agents/brainstormstore.test.ts`, `frontend/app/view/agents/brainstormpane.tsx`, `frontend/app/view/agents/brainstormui.tsx`, `frontend/app/view/agents/brainstormcheck.tsx`, `frontend/app/view/agents/brainstormreview.tsx`, `frontend/app/view/agents/brainstormrun.tsx`, `scripts/cdp/scenarios.mjs`, `scripts/cdp/scenarios-brainstorm-builder.mjs`, `scripts/cdp/scenarios-brainstorm-review.mjs`, `scripts/cdp/scenarios-brainstorm-run.mjs`

Small and mechanical: the interface Tasks 2, 5, 6 and 7 build on. On screen nothing changes except the
toolbar on the check view (decision 12).

**Model (`brainstormmodel.ts`), implemented here with tests in `brainstormmodel.test.ts`:**
- `BuilderQuestion = { q: string; label?: string; why?: string; a?: string; into?: string[]; part?: string; options?: AnswerOption[] }`.
  `parseCheck` reads `label`, `part`, `options` (via `parseOptions`), `into` as a string or string array.
  Test: `into: "anti"` parses to `["anti"]`; options with pros/cons/pick parse as for a question.
- `BrainstormAction` gains `{ kind: "builder-decide" }`; `brainstormLine` → `"brainstorm: builder decide"`.
- `CheckMain = "working" | "question" | "builder" | "review"`; `checkMain(f, designOpen: boolean): CheckMain`
  per decision 5 (`designOpen` → `"review"`). Tested.
- `pickableOptions` counts the talk question's options when `checkMain` is `"question"`, the open builder
  question's when `"builder"`, else 0 (talk phase unchanged). Tested.
- `PaneView` gains `"run"`: order removed, error, exited (still skipped when `f.run` is set), board, run
  (`file.run != null`), check, design. Tested.
- `treeLine(f, asking, run?: { text: string; merged: boolean }): TreeLine`: with `f.run`, lead
  `"Brainstorm done"` only when `run?.merged`, else `"Brainstorm"`; text `run?.text ?? "run <id8>"`; `runId` as today. Tested.
- `phaseSteps(f, merged = false)`: with `merged`, all three steps `done`. Tested.
- Signatures only, with trivial bodies (Task 2 implements them): `approveBlocker(f): string | null` (keep
  today's body), `checkAsk(f): AskModel`, `checkReview(f): ReviewModel`, with the types exported:
  - `AskModel = { index: number; total: number; open: BuilderQuestion | null; queue: { label: string; state: "now" | "waiting" | "answered" }[]; callGroups: { part: string | null; title: string; calls: string[] }[]; calls: number; already: string[]; questions: number }`
  - `ReviewRow = { id: string; title: string; gist: string; cause: string; was?: string; body: string; view: PartView; action: "keep-restore" | "confirm" | "answer" | null; question?: number; calls: string[] }`
  - `ReviewModel = { changed: ReviewRow[]; fresh: ReviewRow[]; unchanged: BrainstormPart[]; notes: BrainstormPart[]; cursorIds: string[]; summary: string; answered: { q: string; a: string; changed: { id: string; title: string }[] }[] }`

**Store (`brainstormstore.ts`), tested in `brainstormstore.test.ts`:** `BrainstormState.review:
{ cursor: string | null; open: Record<string, boolean> }` (initial `{ cursor: null, open: {} }`), and
`moveReviewCursor(agentId, ids: string[], delta: 1 | -1)`, `setReviewCursor(agentId, id: string)`,
`toggleReviewRow(agentId, id: string)`. Tests: clamps at both ends, a null cursor starts at the first id, a
cursor no longer in `ids` restarts at the first, toggle flips one row only.

**Pane split** (move, don't rewrite): `brainstormui.tsx` exports the class constants (`DOT*`, `SMALL_DOT`,
`CHIP`, `FIELD`, `LINK`, `PART_BTN`, `ERROR_LINE`, `SECTION_HEAD`, `CARD_LABEL`), `WORKING_TITLE`, `errText`,
`useAction`, `onEnter`, `Toolbar({ topic, f, progress = true, merged = false })` (`progress` false hides the
Progress segments; `merged` goes to `phaseSteps`), `StaleBanner`, `MainBody`, `DesignHead`, `CheckMark`,
`QuestionAnswers`, `Options`, `AnswerBox`, `QuestionMain`, `WorkingMain`, `ChangeDiff`, and
`useAnswer(agent, kind: "answer" | "builder-answer" = "answer")` (the kind a draft and a picked option are
sent as). `ChangeDiff` colors with `bg-diff-added/10` / `bg-diff-removed/10` and `text-diff-added` /
`text-diff-removed` (bug 5).
- `brainstormcheck.tsx`: `export function Check({ model, agent, s, f })` — `Toolbar` with `progress={false}`,
  StaleBanner, a row of [main column: the main `checkMain` picks, `ApproveBar` at its bottom] and a 460px rail,
  then `<ReviewHints/>` full width when the main is the review. Mains: `question` → `QuestionMain`; `builder`
  → `BuilderAsk` (for now today's builder card); `working` → `WorkingMain`; `review` → `CheckReview`. Rails:
  `AskRail` (for now today's left column) or `AnsweredRail` on the review. `ApproveBar` moves here.
- `brainstormreview.tsx`: `CheckReview({ model, agent, s, f })` (for now today's `FinishedDesign`),
  `AnsweredRail({ f })` (for now the answered cards), `ReviewHints()` (returns null).
- `brainstormrun.tsx`: `RunStep({ model, agent, s, f })` (for now Toolbar + today's "Run X started / Open run").
- `BrainstormPane` routes `"run"` → `RunStep`, `"check"` → `Check`.

**Scenarios:** create the three modules, each `export default function (kit) { return []; }`; in
`scenarios.mjs` import them and spread `...builder(BS_KIT), ...review(BS_KIT), ...run(BS_KIT)` into
`SCENARIOS`. `BS_KIT` holds at least: `bsBoardScenario, bsArrangeAgent, bsShowFile, bsTeardownAgent, bsWrite,
bsRead, bsUntil, bsBrief, bsClick, bsMouseClick, bsFill, bsKey, bsKeysArrive, bsMark, bsTyped, bsNothingTyped,
bsAgentTook, bsPublishProc, bsOpenDesign, bsCloseDesign, bsTermText, polishWaitFor, polishNap, skipStep,
waveService, arrangeSheetDagRun, teardownFixtureRun, seedDag, seedFinalShots, fstShow, fstWriteRun,
RUN_SHEET_POLISH_TASKS, UI_ROUTE, BS_PANE, BS_SWITCH, BS_TREE_LINE, NEW_RUN, PEEKS_ESC, flatText`, plus
anything the retired steps used. Retire `brainstorm-mode` steps 8 through 9d and the
`brainstorm-check-answered` scenario (decision 11); the flow continues at step 10.

**Acceptance:** `npx vitest run frontend/app/view/agents/brainstormmodel.test.ts frontend/app/view/agents/brainstormstore.test.ts`
passes with the tests above; Check passes; `node -e "import('./scripts/cdp/scenarios.mjs')"` exits 0. The
talk view is unchanged: `brainstorm-main`, `brainstorm-question-reasons`, `brainstorm-review-skim`,
`brainstorm-rail-reasons` and `brainstorm-mode` (steps up to 7d and 10 onward) pass in Final.

### Task 2: Check model: Approve blocker, asking and review derivations
**Depends on:** Task 1 (implements the signatures it adds)
**Files:** `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`

Test-first in `brainstormmodel.test.ts`:
- `approveBlocker(f)` (bug 1). `null` once `f.run` is set; while `f.working`, today's text. With `n`
  unanswered builder questions: ``Answer the builder’s ${n} question(s), then review what they change``
  (singular for 1), with `, and answer question ${q.n}` appended when a talk question is open. Otherwise the
  non-empty items of [`Review N change(s)`, `confirm N guess(es)`, `answer question N`, `N decision(s) still open`]
  joined with ", ", first letter capitalized; `null` when none. Counts: changed = decisions whose view is
  `changed`; guesses = view `guess`; open = `asked`/`open` decisions other than the open question's part.
  Tests with the boards' strings: 3 unanswered → `"Answer the builder’s 3 questions, then review what they change"`;
  8 changed + 1 guess + question 16 → `"Review 8 changes, confirm 1 guess, answer question 16"`; everything
  yours, no question, all answered → `null`; a design with 10 guesses (llm-authored-ce-rules) is blocked;
  notes never count.
- `checkAsk(f)`: `index` the open entry's 1-based position in `yours`, `total` = `yours.length`; `queue`
  labels are `label ?? q`; `callGroups` in the design's part order, calls without a part last under
  "Other decisions"; `questions` = yours + calls + answered. Test on a detector-engine-models-shaped check
  (3 yours, 8 calls over 3 parts, 0 answered → `questions` 11).
- `checkReview(f)` per decision 6. `action`: changed → `keep-restore`; guess → `confirm`; asked with the open
  question on it → `answer` with `question` = its n; else `null`. `cursorIds` = changed then fresh ids.
  `summary` from the board ("Your answers to the builder changed N decisions you had confirmed, and M are
  new. Keep each change or put yours back; the agent’s K calls sit under the decision they belong to."),
  dropping a clause whose count is 0. `answered[].changed` from each answered entry's `into`. Tests: the
  Check-Review board's shape (8 changed with causes, 2 new — one guess, one asked by question 16 — 3
  unchanged, 6 notes); a kept part (yours, touched, no `was`) draws in `changed` with view `yours` and no action.

**Acceptance:** `npx vitest run frontend/app/view/agents/brainstormmodel.test.ts` passes; Check passes. The
rendered result is judged in Tasks 5 and 6's scenarios (`brainstorm-builder-ask` step 1,
`brainstorm-check-review` step 1).

### Task 3: Skill: builder decide, settling builder questions, the check's fields
**Depends on:** none
**Files:** `skills/brainstorm/SKILL.md`

Edit only `skills/brainstorm/SKILL.md` (bug 3 and decisions 3–4):
- The `check` example and field list: each `yours` entry `{ "q", "label", "why", "part", "options", "a", "into" }`;
  `label` a short line under 80 characters; `options` exactly as a talk question's (label, detail, pros,
  cons, one `pick`); `into` the list of every part the answer changed.
- New table row: `brainstorm: builder decide` — move the first `check.yours` entry with no `a` into
  `check.calls` as `{ "text": <your decision>, "part": <its part> }`, fold it into that part and the spec
  (marked "Agent's call"), write the file.
- `brainstorm: builder answer: <text>`: set `a`, set `into` to every part it changed; a confirmed part the
  answer rewrites gets `was` + `why` naming "builder question N" and waits for keep or put back, one by one
  (no keep-all).
- New rule: **an answer settles builder questions too.** When any answer (talk or builder) settles a
  `check.yours` entry, set its `a` (what was decided, in a few words) and `into` in the same write; the pane
  otherwise keeps asking it.
- New rule: refresh `check.touched` whenever the check's parts change (rewritten, added or annotated).
- Every `why` on a changed part names its cause in a few words, e.g. `answer 12: your boss wants PyTorch`,
  `builder question 1` — the review shows it under the decision.
- Approve: Arc enables it only once no question is open, every builder question is answered or decided by
  the agent, and every decision is `yours`.

**Acceptance:** valid frontmatter (`name: brainstorm`); `node scripts/verify.mjs ./skills/...` passes (the
embed compiles); `grep -n "builder decide" skills/brainstorm/SKILL.md` finds the table row.

### Task 4: Run state for the brainstorm: RunInfo by id and the run-step model
**Depends on:** none
**Files:** `frontend/app/view/agents/runlineage.ts`, `frontend/app/view/agents/runlineage.test.ts`, `frontend/app/view/agents/runlineagestore.ts`, `frontend/app/view/agents/brainstormrunmodel.ts`, `frontend/app/view/agents/brainstormrunmodel.test.ts`

- `runlineage.ts`: `RunInfo` gains `base?: string` (from `Run.basebranch`). Extract the object
  `lineageAtomFor` builds into `export function runInfoOf(runId: string, leadRun: Run | undefined, dag: TaskGroup | undefined, digest: DagStatusDigest | undefined): RunInfo`
  and use it there (same fields, plus `base`). Test it in `runlineage.test.ts`.
- `runlineagestore.ts`: `export function runInfoAtom(runId: string): Atom<{ run: RunInfo | undefined; loaded: boolean }>`
  (memoized per id; `loaded` from `WOS.getWaveObjectLoadingAtom` of the run, so a missing run reads
  `{ run: undefined, loaded: true }`) built with `runInfoOf` from the WOS run, its dag and `runDigestsAtom`,
  and `export function useRunInfo(runId: string | null): { run: RunInfo | undefined; loaded: boolean }`
  that also keeps the digest current with `useRunDigests`.
- `brainstormrunmodel.ts` (pure):
  - `RunStepState = "missing" | "loading" | "planning" | "building" | "final" | "final-failed" | "unverified" | "landing" | "held" | "merged" | "cancelled"`.
  - `runStepView(runId: string, run: RunInfo | undefined, loaded: boolean): { state: RunStepState; headline: string; detail: string; tree: string; merged: boolean; canClose: boolean; closeOff: string | null; sha?: string; done: number; total: number; round?: number }`.
    Final from `run.dag?.final ?? run.digest?.final`; land from `run.land`; `base` falls back to "its base".
    Copy (boards): final-failed headline `"The run built every task, but its final check failed"`, detail
    `"All 10 tasks landed on wave/9c6eb723. The final check failed in round 2, so nothing has merged into main yet. The run shows what failed and reruns the check."`
    (`"N of M tasks landed"` when not all did, with the headline `"The run’s final check failed"`); merged
    headline `"Built and merged into main at 7867142"`; missing headline `"Arc can’t find run 9c6eb723"`.
    The other states' copy in the same plain voice (where it is, what happens next).
    `tree`: `"final failed"`, `"merged"`, `"building 3/10"`, `"final check"`, `"land held"`, `"landing"`,
    `"cancelled"`, `"planning"`, `"not found"`, and `""` while loading. `canClose` only when merged and the
    final state is `passed`; `closeOff` says why not when merged otherwise (e.g. the final is `unverified`).
  - `runTreeText(runId, view)` = `"run <id8> · <tree>"` (`"run 9c6eb723 · final failed"`), `"run <id8>"` when `tree` is empty.
  - `closeTargets(cwd: string, topic: string, canvas?: string): { ok: true; paths: string[] } | { ok: false; reason: string }`
    → `[<cwd>/.superpowers/design/<canvas>, <cwd>/.superpowers/brainstorm/<topic>]` (canvas first, only when
    named; `canvasDir` from `canvasmodel.ts`, the `join` the model uses), refusing per decision 2 with a
    reason naming the bad name. Callers check `"reason" in r` (non-strict TS does not narrow on `ok`).
- Tests in `brainstormrunmodel.test.ts`: 9c6eb723 (10/10 landed, final failed round 2, no land) →
  final-failed with the board copy, `canClose` false; 95585dce (landed at a sha, final passed) → merged,
  `canClose` true; landed + final `unverified` → `canClose` false with a `closeOff`; run undefined and loaded
  → missing; run undefined, not loaded → loading; `closeTargets` refusing `..`, `a/b`, `a\b`, `""`, `.` for
  topic and canvas, and the two paths in order for a good pair (one path with no canvas).

**Acceptance:** `npx vitest run frontend/app/view/agents/brainstormrunmodel.test.ts frontend/app/view/agents/runlineage.test.ts`
passes; Check passes. Rendered in Task 7's scenarios.

### Task 5: Builder check, asking (Main board)
**Depends on:** Task 1 (uses `AskModel`, `checkMain`, the builder-decide action, the store's review cursor and the Check skeleton)
**Files:** `frontend/app/view/agents/brainstormcheck.tsx`, `frontend/app/view/agents/brainstormui.tsx`, `scripts/cdp/scenarios-brainstorm-builder.mjs`

Build `Main.dc.html` in `brainstormcheck.tsx`:
- `BuilderAsk`: a track of one segment per builder question (answered / now / ahead, the talk track's
  classes); header `Builder {index} of {total}` (mono) `· for <part title>` (shown when the entry has a
  `part`; a link that sets the review cursor to that part with `setReviewCursor` and opens the review with
  `openBrainstormDesign(agent.id, true)`); the question as the talk question's large heading; `why`;
  `QuestionAnswers` + `AnswerBox` with `useAnswer(agent, "builder-answer")` (options with pros/cons and
  Agent's pick as a talk question's; `data-brainstorm-option` kept so a–d work); a row with **Let the agent
  decide** (sends `builder-decide`) and the design chip (opens the review).
- A talk question during the check uses `QuestionMain` in the same main area (no 430px card any more).
- Over the review, while a question is open, the Check wrapper draws **Back to the question**
  (`openBrainstormDesign(agent.id, false)`), the same button style as the talk view's back button.
- `AskRail` (460px): "A builder read the design"; "A fresh agent checked whether it could plan from this
  without coming back to you. It had {questions} questions."; "For you · N" with caption "only you can
  answer", the queue (current tinted `bg-warning/12` with a filled warning dot, waiting a hollow dot,
  answered a success dot); "The agent decided · N" with caption "you review them with the changes",
  grouped by part (the part title a link like the header's); "Nothing the builder asked was already in the
  design." when `already` is empty, else "Already in the design · N" and its lines.
- `ApproveBar`: across the main column's bottom; the blocker from `approveBlocker`; drop the old
  "Run X started" branch (the run step replaces it).

**Acceptance (scenario `brainstorm-builder-ask` in `scenarios-brainstorm-builder.mjs`; fixture from
detector-engine-models' check with the Main board's copy and labels):**
1. builder question 1 fills the main area: `Builder 1 of 3 · for Where the forecast sits`, three lettered
   answers with pros/cons and Agent's pick on B; the rail shows For you · 3 (first tinted) with its caption,
   The agent decided · 8 under 3 parts, and the "Nothing the builder asked…" line; no Progress segments in
   the toolbar; Approve disabled reading `Answer the builder’s 3 questions, then review what they change` (screenshot).
2. clicking answer B sends `brainstorm: builder answer: Add a per-entity event_count field`; a typed answer +
   Enter sends `brainstorm: builder answer: <text>`; **Let the agent decide** sends `brainstorm: builder decide`.
3. the design chip (today's copy, "The design · N of M yours") opens the review over the question; **Back to
   the question** returns to it (screenshot of each).
4. the rail's part link "The forecast model" opens the review with that row as the cursor row
   (the row `[data-brainstorm-review-row="model"]` carries `data-cursor`, the contract Task 6 draws).
5. a talk question written during the check (question 16) takes the main area with its options (screenshot).
6. with everything settled, Approve is enabled, sends `brainstorm: approved` and opens New run with the
   spec's absolute path and the prototype; Change opens New run and sends nothing (what retired step 9 proved).

### Task 6: Builder check, reviewing what it changed (Check-Review board) and its keys
**Depends on:** Task 1 (uses `ReviewModel`, `ChangeDiff`, the store's review cursor and the review/rail/hints slots)
**Files:** `frontend/app/view/agents/brainstormreview.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-brainstorm-review.mjs`

Build `Check-Review.dc.html` (bug 2):
- `CheckReview`: heading "Review what the check changed" + `summary`; "Changed since you confirmed · N" with
  caption "open one to see what it was": each row one grid line (`7px | minmax(120px,190px) | 1fr |
  max-content | 12px`): dot (accent ring pending, success when yours), title, gist + the cause in mono,
  **Keep the change** (bordered, `PART_BTN`) and **Put mine back** (quiet text) for `keep-restore`, "Yours"
  when settled, and an expand arrow that is a real `<button>` with `aria-label` "Show what it was" /
  "Hide what it was" and `aria-expanded`, opening `ChangeDiff`; the agent's calls under their row
  (`bg-accentbg`, "Agent’s call"). "New since the check · N": `confirm` rows with That’s right (sends
  `confirm`) / Edit (opens an edit box that sends `edit`, as the design view's row does); `answer` rows with
  "Answer question N" (warning-tinted; `openBrainstormDesign(agent.id, false)` returns the main area to the
  question). "Yours, unchanged · N" and "What the agent found · N" as one line of links each; a link opens
  that part's body under the line.
- Cursor row (`data-brainstorm-review-row` with `data-cursor` on the cursor row): `bg-surface-selected` +
  accent outline; clicking a row moves the cursor there (`setReviewCursor`). Open rows come from `s.review.open`.
- `AnsweredRail`: "A builder read the design", "It had N questions: X for you, all answered; the agent
  decided K, shown under their decisions.", then each builder question with its answer (check mark) and
  "Changed <links>" from `answered[].changed` (a link moves the cursor to that row).
- `ReviewHints`: a 28px bar styled like `frontend/app/cockpit/hints-footer.tsx`: `j k` Next or previous
  decision, `Enter` Show what it was, `y` Keep the change, `u` Put mine back, `b` Back to the terminal.
- `bindings.ts`: `agent:brainstorm-review-next` (`j`), `-prev` (`k`), `-open` (`Enter`), `-keep` (`y`),
  `-restore` (`u`), all `when` the focused agent is in brainstorm mode, its pane view is `check`,
  `checkMain` is `"review"` and no input is focused (decision 9); `agent:prev-k` / `agent:next-j` stand down
  in that state. `y`/`u` send `keep`/`restore` (or `confirm` for a guess row) through `sendBrainstorm` for
  the cursor row; `j`/`k` call `moveReviewCursor` with `checkReview(f).cursorIds`; `Enter` `toggleReviewRow`.
  Tests in `bindings.test.ts`: the new keys fire only in the review, not while typing, not in the talk view;
  agent `j`/`k` still move agents outside the review; nothing else on the Agent surface claims `y` or `u` in brainstorm mode.
- `docs/keyboard-shortcuts.md`: add the review keys to "Agent: brainstorm mode" and correct its note that
  `j`/`k` always move between agents.

**Acceptance (scenario `brainstorm-check-review`; fixture with the board's 8 changed decisions, 2 new, 3
unchanged, 6 notes, 3 answered builder questions and question 16 open — so the review is opened with the
design chip, `bsOpenDesign`):**
1. the review draws as the board: 8 changed rows with cause lines and captions, the calls under
   "The forecast model", New since the check · 2 with "Answer question 16", the two link lines, the
   AnsweredRail with three answers and their Changed links, the hints bar, and the blocker
   `Review 8 changes, confirm 1 guess, answer question 16` (screenshot).
2. the expand arrow opens − was / + now in the diff tokens (computed colors equal `--color-diff-removed` /
   `--color-diff-added`) and its aria-label flips (screenshot).
3. clicking a row moves the cursor to it; `j` moves it on, `Enter` opens it, `y` sends `brainstorm: keep <id>`,
   `u` on the next row sends `brainstorm: restore <id>` (read with `bsTyped`; if CDP keys cannot reach the
   page, the step says so and skips rather than failing).
4. Keep the change / Put mine back send the same lines by click; That’s right sends `brainstorm: confirm <id>`;
   Edit opens the edit box.
5. a "Yours, unchanged" link and a "What the agent found" link each open that part's body under the line.
6. after the file records a keep (the part `yours`, touched, no `was`) the row reads "Yours" with a success dot (screenshot).
7. "Answer question 16" returns the main area to question 16.

### Task 7: Run step (Run-Blocked, Run-Landed), Close, and the tree line
**Depends on:** Task 1 (uses the `RunStep` slot, `Toolbar`'s `merged`, and `treeLine`'s run argument), Task 4 (uses `useRunInfo`, `runStepView`, `runTreeText`, `closeTargets`)
**Files:** `frontend/app/view/agents/brainstormrun.tsx`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/view/agents/runrailsections.tsx`, `scripts/cdp/scenarios-brainstorm-run.mjs`

- `RunStep`: `Toolbar` with `progress={false}` and `merged`; header with the title, the spec path (mono), and
  **Open run {id8}** through `openTarget(model, { kind: "run", runId })` — the primary button while not
  merged, bordered once merged; the state card from `runStepView` (error dot for final-failed / held /
  cancelled / missing, check mark for merged); "What you handed over · N" with caption "the design the run
  builds from" while not merged: every decision read-only, one grid line each (dot, title, gist, `from` in
  mono). Rail 460px: `RunSection` from `runrailsections.tsx` with `useRunAsks` — reused, not re-drawn;
  export anything else it needs from there. A missing run: the card, no rail, no Close.
- Once merged with the final passed: the card reads "Built and merged into {base} at {sha7}", "The final
  check passed. The spec stays in docs/. The brainstorm file and its mockups were scaffolding for the
  design: closing deletes .superpowers/brainstorm/{topic} and the {canvas} canvas." (canvas clause only with
  `f.canvas`), and **Close the brainstorm** (primary). On click: re-check `canClose`, take
  `closeTargets(s.cwd, s.topic, f.canvas)`, then `RpcApi.FileDeleteCommand(TabRpcClient, { path, recursive: true })`
  for each in order; an error naming the path stays under the button; a not-found error counts as done. The
  poller then shows today's removed state. Merged but not closable: no Close, `closeOff` said in its place.
  A refusal: Close disabled with the reason under it (decision 14).
- `agenttree.tsx`: `BrainstormTreeLine` passes `{ text: runTreeText(...), merged }` from `useRunInfo(f.run)`
  into `treeLine` (bug 4).

**Fixtures:** each run scenario makes a temp project with a brainstorm (`bsArrangeAgent`) and a deferred
fixture run (`arrangeSheetDagRun` with a 10-task list, so no lead starts), then seeds the dag's state with
`seedDag` and the run's `land` with `fstWriteRun` (`docs/reference/cdp-run-fixtures.md`, "A state the engine
has not reached"). The engine acts on a dag that is `finalizing`, so a seeded dag must not be one: read
`pkg/orchestrate/final.go` and the watchdog for a status the engine leaves alone with a settled `final`
(`done` for the landed case; for the blocked case keep one task at work and assert the "9 of 10 tasks
landed" copy if no such status exists for a failed final). The brainstorm's `run` is the fixture run's id;
the Run-Landed canvas is a fixture canvas inside the temp project. Each scenario ends by asserting the
seeded `final` is unchanged.

**Acceptance (scenarios in `scenarios-brainstorm-run.mjs`):**
- `brainstorm-run-blocked`: 1. header with Open run {id8} primary, the final-failed card (round 2, nothing
   merged), What you handed over · 12 with sources and caption, `RunSection` in the rail, no Progress
   segments (screenshot); 2. the tree line reads `Brainstorm · run <id8> · final failed`; 3. Open run opens the run.
- `brainstorm-run-landed`: 1. with the final `unverified` and the land `landed`: the merged card, no Close,
   the `closeOff` line (screenshot); 2. with the final `passed`: "Built and merged into main at <sha7>",
   Close the brainstorm, RunSection finished, all three phases done (screenshot); 3. the tree line reads
   `Brainstorm done · run <id8> · merged`; 4. with the file's `canvas` set to `../escape`, Close is disabled
   with the refusal under it and nothing is deleted; 5. with the canvas restored, Close deletes exactly the
   temp project's `.superpowers/brainstorm/<topic>` and `.superpowers/design/<canvas>` (a sibling file in
   `.superpowers/` survives) and the pane shows the removed state (screenshot).
- `brainstorm-run-missing` (no fixture run; `run` names an id no run has): the card "Arc can’t find run
   <id8>", no rail, no Close (screenshot); the tree line reads `Brainstorm · run <id8> · not found`.
