# Brainstorm pane: the judge's wait Implementation Plan

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the judge weighs an approach question, the brainstorm pane shows the question, a judge status line,
the approaches being weighed as clickable rows, and an open answer box; answering early stops the judge.

**Architecture:** The pane decides the judge's wait from the file (`working` set, `question.approaches` non-empty)
and whether a line Arc sent is pending, in `brainstormmodel.ts`, as a new `"judging"` main view; `shownFile` hides a
question answered during the wait. A new RPC, `BrainstormJudgeStopCommand`, stops a reading judge and records it
`stopped`; the judge's watcher then exits silently on a record that is no longer its own. The pane calls the stop
before it sends an answer or Skip during the wait. The arc:brainstorm skill tells the agent how to take those lines.

**Tech Stack:** Go (wavesrv), React + jotai (pane), vitest, CDP scenarios.

**Spec:** `C:\Users\kael02\IdeaProjects\waveterm\docs\superpowers\specs\2026-10-26-brainstorm-pane-interaction-design.md` (its "Build decisions" section fixes every shape the tasks share)
**Verify:** `node scripts/verify.mjs ./pkg/wshrpc/... ./cmd/...`
**Check:** `go build ./... && go vet ./pkg/wshrpc/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brainstorm-judge-wait brainstorm-judge-tree brainstorm-judged-question brainstorm-mode brainstorm-builder-check surface-smoke`

## Global Constraints

- Only the judge's wait changes; the wait after a talk answer, the builder check's reading and every other working
  state keep `WorkingMain`.
- The wait copy, verbatim: heading `What the judge is weighing · N` (N = number of approaches); box placeholder
  `Or answer now in your own words…`; the status line is the file's `working` text. Pending texts stay the existing
  `Writing up your answer.` and `Taking in your change.`.
- The board to match is only
  `C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\brainstorm-judge-wait\project\Main.dc.html`. The same
  folder's `Steer.dc.html` and `Watch.dc.html` are rejected alternatives (spec non-goals): build nothing from them.
- The new judge record state is the string `stopped`; a stopped judge sends the agent no line.
- Never hand-edit generated files: change the Go types, then `task generate`.
- Edit `skills/`, never `cmd/wsh/cmd/claude-mod/` by hand: `task sync:claudemod` writes the copy, which is tracked
  and committed with its source.
- Colors come from `@theme` tokens; reuse the option rows' classes, no new tokens.
- Typecheck with `task check:ts` (~2 min), never `npx tsc`.
- Workers do not run `final-verify.mjs`: the Final line runs every scenario named here on the merged result.

## Review Focus

- A stop that lands while the watcher is still launching the judge's session: the launched run must be stopped and
  the record must stay `stopped` (Task 2 test).
- A stale watcher after a stop and a fresh judge started for a rerun: the old watcher must not deliver, fail or write
  over the new `reading` record (Task 2 test).
- Skip sent during the wait: the pane must show `Taking in your change.`, not the open box (Task 3 test: `shownFile`
  plus `linePending` give `"working"`).
- A file with `working` set and `approaches: []`, or a talk answer's `working` with no question: Working view, not
  the wait (Task 3 test).
- A stop RPC that errors: the line is not sent and the error shows (Task 5 test and scenario step).

---

### Task 1: The stop RPC
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_agents.go`, `pkg/wshrpc/wshserver/wshserver_brainstorm.go`, `pkg/wshrpc/wshserver/wshserver_brainstorm_test.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Produces: `BrainstormJudgeStopCommand(ctx context.Context, data CommandBrainstormJudgeStopData) error` on
  `WshRpcInterface`, with `CommandBrainstormJudgeStopData{ BlockId string }` (json tag `blockid`); generated TS
  `RpcApi.BrainstormJudgeStopCommand(client, { blockid })`. The `brainstorm:judgestate` value `stopped`, as a const
  `brainstormStopped` beside `brainstormReading`.

Decisions (spec "The stop"):
- The handler requires a block id, finds the block's tab, and under `judgeKind.mu` reads the judge record. Not
  `reading`: return nil, change nothing. `reading`: when the record names a run, load it (`readBrainstormRun` with the
  record's channel and run) and stop it with `stopStageSession`; a run that cannot be loaded is logged with the run id
  and the record is still written. Write the record `stopped` with `ts` = now, keeping run and channel
  (`setBrainstormRecord`). Send no line.
- Run `task generate` after the type change.

- [ ] **Step 1: Write the failing tests** in `wshserver_brainstorm_test.go`, using the file's existing fakes and
  store setup (`readBrainstormRun`, `stopStageSession` vars):
  - `TestBrainstormJudgeStopStopsAReadingJudge`: a reading record with a run → record state `stopped`, run and
    channel kept, `stopStageSession` called once with that run, no agent line delivered.
  - `TestBrainstormJudgeStopWithoutRun`: a reading record with no run yet → record `stopped`, no stop call.
  - `TestBrainstormJudgeStopIgnoresIdleRecord`: records `answered`, `failed`, none → nil error, record unchanged, no
    stop call.
  - `TestBrainstormJudgeStopNeedsBlock`: empty block id → error.
  - `TestJudgeStartsAfterStop`: `BrainstormJudgeCommand` after a `stopped` record is accepted.
- [ ] **Step 2: Run, expect failures:** `go test ./pkg/wshrpc/wshserver -run 'BrainstormJudgeStop|JudgeStartsAfterStop'`
- [ ] **Step 3: Implement** the type, the handler, then `task generate`.
- [ ] **Step 4: Run** the Step 2 command: PASS.
- [ ] **Step 5: Commit** `feat(brainstorm): a command that stops a reading judge`

### Task 2: The judge's watcher yields to a stop
**Depends on:** Task 1
**Files:** `pkg/wshrpc/wshserver/wshserver_brainstorm.go`, `pkg/wshrpc/wshserver/wshserver_brainstorm_test.go`

Decisions (spec "The stop"):
- A helper (yours to name) reports, under the kind's lock, whether the tab's record is still this session's
  `reading` (state `reading` and `ts` == the session's `StartedTs`).
- `watchBrainstormSession` checks it before each tick and exits silently when not. `launchSessionRun` checks it under
  the lock before writing the launched run onto the record; when superseded it stops the run it launched
  (`stopStageSession`) and returns without writing. `tickBrainstormSession`'s deliver and fail paths write no
  `judge.json`, no record and no line when superseded.
- The builder check shares this code and is never stopped: its behavior stays as it is (existing tests keep passing).

- [ ] **Step 1: Write the failing tests:**
  - `TestJudgeWatcherExitsAfterStop`: a watcher whose record was stopped ticks once → returns settled, no
    `judge.json`, no line, record stays `stopped`.
  - `TestJudgeLaunchAfterStopStopsItsRun`: the fake launch stops the record before it returns → the launched run is
    stopped and the record stays `stopped` with no run written over it.
  - `TestStaleJudgeWatcherLeavesNewJudge`: stop, then a new `reading` record with a newer ts → the old watcher's tick
    writes nothing and sends nothing; the new record is unchanged.
- [ ] **Step 2: Run, expect failures:** `go test ./pkg/wshrpc/wshserver -run 'JudgeWatcherExitsAfterStop|JudgeLaunchAfterStop|StaleJudgeWatcher'`
- [ ] **Step 3: Implement** the helper and the three checks.
- [ ] **Step 4: Run** the Step 2 command plus `go test ./pkg/wshrpc/wshserver -run 'Brainstorm|Judge|BuilderCheck'`: PASS.
- [ ] **Step 5: Commit** `feat(brainstorm): a stopped judge's watcher exits without a word`

### Task 3: The judge's wait in the pane's model, and the stopped tree row
**Depends on:** none
**Files:** `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `frontend/app/view/agents/session-models/sessionviewmodel.ts`, `frontend/app/view/agents/session-models/sessionviewmodel.test.ts`, `frontend/app/view/agents/agenttree.tsx`, `scripts/cdp/scenarios-brainstorm-builder.mjs`

**Interfaces** (all in `brainstormmodel.ts` unless named):
- Produces:
  - `judgeWait(f: BrainstormFile, linePending: boolean): boolean` — `!linePending && f.working != null &&
    (f.question?.approaches?.length ?? 0) > 0`.
  - `shownFile(f, sent)`: when `sent != null` and `judgeWait(f, false)`, it substitutes as for a file with no
    `working`: an answer → `working: "Writing up your answer."`, `question: null`; any other kind →
    `working: "Taking in your change."`, question kept. Every other file with `working` is returned as today.
  - `MainView = "question" | "judging" | "working" | "design"`;
    `mainView(f, designOpen, checkPending = false, linePending = false): MainView` returns `"judging"` where it
    returned `"working"` when `judgeWait(f, linePending)`.
  - `CheckMain = "working" | "judging" | "question" | "builder" | "review"`;
    `checkMain(f, designOpen, linePending = false): CheckMain`, same rule.
  - `designUnder`, `checkUnder` take a trailing `linePending = false` and pass it through;
    `boardBackLabel(f, designOpen, linePending = false)` says "Back to the question" for `"judging"` too.
  - `pickableOptions(f, s: { designOpen; board; removed; sent?: SentLine | null })`: `linePending` is
    `s.sent != null` (so `BrainstormState` passes as is from `bindings.ts`); during `"judging"` (talk or check pane) it
    returns `Math.min(approaches.length, OPTION_KEYS.length)`.
  - `stopsJudge(a: BrainstormAction, f: BrainstormFile | null, linePending: boolean): boolean` — true when
    `f != null && judgeWait(f, linePending)` and `a.kind` is `"answer"` or `"skip"`.
  - `BuilderCheckRecord["state"]` gains `"stopped"`; `sessionviewmodel.ts`'s `CHECK_STATES` accepts it.
    `builderCheckView` is unaffected (a builder check is never stopped).
  - `agenttree.tsx`'s `CHECK_OUTCOME` maps `stopped` to a finished outcome (the closest existing `StageOutcome` that
    is not `"passed"`); the nested row's verdict line reads `stopped`.

- [ ] **Step 1: Write the failing tests** in `brainstormmodel.test.ts` (inside the existing `mainView`, `checkMain`,
  `pickableOptions` describes, plus new `judgeWait`, `shownFile during the judge's wait` and `stopsJudge` describes):
  - `working` + 7 approaches, no line pending → `mainView` and `checkMain` `"judging"`; the same with the earlier
    `options`, `read` and `judge` still on the question (a rerun) → `"judging"`.
  - with `linePending: true` → `"working"`; `approaches: []` or absent → `"working"`; `question: null` with `working`
    → `"working"`; no `working` and options → `"question"`.
  - `designOpen` over the wait → `"design"` / `"review"`; `designUnder` → `"judging"`; `boardBackLabel` →
    `"Back to the question"`.
  - `shownFile` on a wait file: answer sent → working `Writing up your answer.`, question null; skip sent → working
    `Taking in your change.`, question kept, and `mainView(shown, false, false, true)` → `"working"`; no sent → the
    file itself; a non-wait file with `working` and a sent line → the file itself (unchanged behavior).
  - `pickableOptions` during the wait with 7 approaches → 4, with 2 → 2, with a sent line → 0.
  - `stopsJudge`: answer and skip during the wait → true; confirm, edit, guess → false; answer with `linePending`
    → false; answer on a judged question with no `working` → false.
  - `sessionviewmodel.test.ts`: `brainstorm:judgestate: "stopped"` reads as a record with state `stopped`.
- [ ] **Step 2: Run, expect failures:** `npx vitest run frontend/app/view/agents/brainstormmodel.test.ts frontend/app/view/agents/session-models/sessionviewmodel.test.ts`
- [ ] **Step 3: Implement** the signatures above and the `CHECK_OUTCOME` entry.
- [ ] **Step 4: Add the tree step** to `brainstorm-judge-tree` in `scripts/cdp/scenarios-brainstorm-builder.mjs`: in
  the nesting scenario's states loop, add `stopped` for the judge kind only (the builder check's scenario keeps its
  three), with its own shot: the judge row stays nested right under the brainstorm, reads `stopped`, counts
  unchanged. Renumber the later step. Check it parses: `node --check scripts/cdp/scenarios-brainstorm-builder.mjs`.
- [ ] **Step 5: Run** the Step 2 command: PASS; `task check:ts`: exit 0.
- [ ] **Step 6: Commit** `feat(brainstorm): the pane's model knows the judge's wait`

### Task 4: The skill takes lines that arrive while the judge runs
**Depends on:** none
**Files:** `skills/brainstorm/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/brainstorm/SKILL.md`, `docs/agents/brainstorm.md`

Add a section headed `**While the judge weighs.**` after **Approach questions go to the judge** (spec "The skill"),
in the file's voice:
- Arc shows the question and the approach list while the judge runs, with the answer box open, and stops the judge
  itself before it sends an answer or Skip; the agent never stops it.
- An answer (typed, or an approach `name` from a clicked row) is recorded as any answer: `a` is the text, `picked`
  left out, `options` copied into the history entry only when the question has them; then the next question as after
  any answer, `working` back to `null`.
- Pushback or "double check" during the wait reruns the judge with `--line`, as on a judged question, adding any
  alternative it names to `approaches`; `working` stays set.
- `brainstorm: skip questions` works as today.
- A `brainstorm: judge failed` line for a question no longer open is ignored; a stopped judge sends no line.
Point the `brainstorm: judge failed` row of the lines table at that rule. Bring the judge section of
`docs/agents/brainstorm.md` up to date: the wait view, the pane's stop (`BrainstormJudgeStopCommand`), the `stopped`
record.

- [ ] **Step 1: Edit** `skills/brainstorm/SKILL.md` and `docs/agents/brainstorm.md`.
- [ ] **Step 2: Sync and check:** `task sync:claudemod && diff skills/brainstorm/SKILL.md cmd/wsh/cmd/claude-mod/skills/brainstorm/SKILL.md && grep -c "While the judge weighs" cmd/wsh/cmd/claude-mod/skills/brainstorm/SKILL.md && claude plugin validate claude/arc-mod`
  → no diff, a count of 1, validate passes.
- [ ] **Step 3: Commit** `docs(brainstorm): the skill takes answers and pushback during the judge's wait`

### Task 5: The judge's wait view, the stop on send, and its scenario
**Depends on:** Task 1 (calls `RpcApi.BrainstormJudgeStopCommand`), Task 3 (uses `"judging"`, `judgeWait`, `stopsJudge`, `pickableOptions`, `shownFile`)
**Files:** `frontend/app/view/agents/brainstormui.tsx`, `frontend/app/view/agents/brainstormpane.tsx`, `frontend/app/view/agents/brainstormcheck.tsx`, `frontend/app/view/agents/brainstormsend.ts`, `frontend/app/view/agents/brainstormsend.test.ts`, `frontend/app/store/keybindings/bindings.ts`, `scripts/cdp/scenarios-brainstorm-judge.mjs`

Decisions (spec "What the judge's wait shows", "The rows", "Verification"):
- A `JudgingMain` view in `brainstormui.tsx`, rendered by `brainstormpane.tsx` for `"judging"` and by
  `brainstormcheck.tsx` for its `"judging"`: the question's part link, number, text and `why` as `QuestionMain`
  draws them; a status line with `f.working` (`data-brainstorm-judge-status`) where options go; the heading
  `What the judge is weighing · N` (`data-brainstorm-judge-list`); one row per approach in file order, each a button
  carrying `data-brainstorm-approach` and the option rows' `data-brainstorm-option="<index>"`, styled as an option row
  (no pros, cons or pick) with name, description and `N fact`/`N facts`, letters `a`–`d` on the first four; the answer
  box open with placeholder `Or answer now in your own words…`; no Guess for me; Skip the questions where
  `QuestionMain` has it; Design as on any question. On a rerun the question still holds the earlier `options`,
  `read` and `judge`: the wait view draws none of them.
- Both panes pass `linePending` (the pane state's `sent != null`) to `mainView` / `checkMain` / back labels.
- `bindings.ts`: the letter bindings already pass the `BrainstormState` to `pickableOptions` (Task 3 reads `sent`
  from it) and focus `[data-brainstorm-option=i]`; confirm both reach the approach rows during the wait, changing
  the binding only if they do not.
- A clicked row sends `{ kind: "answer", text: approach.name }`.
- `brainstormsend.ts`: `PromptIO` gains `stopJudge(blockId: string): Promise<void>` (the Tauri impl calls
  `RpcApi.BrainstormJudgeStopCommand(TabRpcClient, { blockid })`). `sendBrainstorm` calls it first when
  `stopsJudge(action, the state's file, the state's sent != null)`; when it throws, `sendBrainstorm` throws
  `Couldn't stop the judge: <message>` and sends nothing, and the pane shows it as it shows a send error.

- [ ] **Step 1: Write the failing tests** in `brainstormsend.test.ts`: during the wait an answer calls `stopJudge`
  before `prompt`; Skip does the same; a confirm does not call `stopJudge`; outside the wait no `stopJudge`; a
  `stopJudge` that rejects → `sendBrainstorm` rejects with a message starting `Couldn't stop the judge:` and `prompt`
  was not called.
- [ ] **Step 2: Run, expect failures:** `npx vitest run frontend/app/view/agents/brainstormsend.test.ts`
- [ ] **Step 3: Implement** the send change, `JudgingMain`, the wiring in both panes, and any binding change.
- [ ] **Step 4: Add the scenario** `brainstorm-judge-wait` to `scripts/cdp/scenarios-brainstorm-judge.mjs` with the
  kit (`bsBoardScenario`, `bsWrite`, `bsUntil`, `bsClick`, `bsMark`, `bsTyped`, `bsNothingTyped`, `bsAgentTook`,
  `bsOpenDesign`, `bsKeysArrive`, `bsKey`, `bsFill`). The file: `working: "The judge is weighing 7 approaches."`, a
  `question` with text, `why` and 7 `approaches` with facts, no `options`. Before each sending step, write the
  file back and set a `reading` judge record on the tab (`setmeta` on `tab:<id>` with the five `brainstorm:judge*`
  keys, no run, as `scenarios-brainstorm-builder.mjs` does). One shot per step:
  1. the wait: question text and `why`, status line `The judge is weighing 7 approaches.`, heading
     `What the judge is weighing · 7`, 7 rows in file order with their facts counts, box enabled with placeholder
     `Or answer now in your own words…`, no `Guess for me`;
  2. Design over the wait shows the design with `Back to the question`; Back returns to the wait;
  3. a click on the second row: `bsTyped` reads exactly that approach's name sent, the tab's
     `brainstorm:judgestate` reads `stopped`, the pane shows `Writing up your answer.`; then `bsAgentTook`;
  4. the letter `c` focuses the third row and Enter sends its name (`bsTyped`); when `bsKeysArrive` reports keys do
     not reach the WebView, the step is `skip` with that reason;
  5. a typed line in the box, sent: `bsTyped` reads the line, the pane shows `Writing up your answer.`;
  6. Skip the questions: `bsTyped` reads `brainstorm: skip questions`, the pane shows `Taking in your change.`;
  7. a failing stop: wrap `window.TabRpcClient.wshRpcCall` so `brainstormjudgestop` rejects (restored after the
     step); a row click sends nothing (`bsNothingTyped`) and the pane shows text starting `Couldn't stop the judge:`;
  8. the same wait file with `check` set (`check: { yours: [], calls: [], answered: [], touched: [] }`): the builder
     check's pane shows the status line, heading and 7 rows;
  9. the file with `approaches` removed shows the Working view (`data-brainstorm-working`), no rows.
  Check it parses: `node --check scripts/cdp/scenarios-brainstorm-judge.mjs` (Final runs it live).
- [ ] **Step 5: Run** the Step 2 command: PASS; `task check:ts`: exit 0.
- [ ] **Step 6: Commit** `feat(brainstorm): the pane shows the judge's wait and answers stop the judge`
