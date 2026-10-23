# Unbiased approach questions in brainstorming Implementation Plan

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On an approach question, the brainstorming agent lists approaches and facts with no verdict, and a fresh
Opus judge that never saw its favorite weighs them and writes the options, the pick and the read, which the pane
labels as the judge's.

**Architecture:** The judge rides the builder check's machinery: `wsh brainstorm judge` calls an RPC that writes a
tab record and returns; a detached watcher launches a one-shot judging session (claude + Opus), checks its JSON
result, writes `judge.json` beside `brainstorm.json` and sends the agent one line. The pure half (prompt, result
check, paths, lines, verdict) sits in `pkg/brainstormcheck` beside the builder check's. The pane reads
`question.judge` from the file; the agent tree nests the judge's session under its agent from the tab record, as
855af287 does for the builder check; the skill teaches the agent the list, the command and the copy.

**Tech Stack:** Go (wavesrv, wsh), React + jotai (pane), vitest, CDP scenarios.

**Effort:** effort:07e27e1d-ba07-4868-89dd-c66da6331046
**Spec:** `C:\Users\kael02\IdeaProjects\waveterm\docs\superpowers\specs\2026-10-23-unbiased-approach-questions-design.md` (D9 fixes every shape the tasks share)
**Verify:** `node scripts/verify.mjs ./pkg/brainstormcheck/... ./pkg/jarvis ./pkg/jarvisstate ./pkg/waveobj ./pkg/wshrpc/... ./cmd/...`
**Check:** `go build ./... && go vet ./pkg/brainstormcheck/... ./pkg/jarvis ./pkg/jarvisstate ./pkg/wshrpc/... ./cmd/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brainstorm-judged-question brainstorm-judge-tree brainstorm-builder-tree brainstorm-mode brainstorm-builder-check surface-smoke`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\brainstorm-judge\project\Main.dc.html

## Global Constraints

- Every shape in spec D9 is fixed: `question.approaches` = `[{ "name", "description", "facts": [] }]`;
  `question.judge` = `{ "added": [names], "dropped": [{ "name", "reason" }] }` (weighed) or `{ "failed": "<reason>" }`;
  `judge.json` = `{ "options", "read", "judge": { "added", "dropped" } }`; lines `brainstorm: judged <abs path>` and
  `brainstorm: judge failed: <reason>`; command `wsh brainstorm judge <brainstorm.json> [--line <text>]`; role
  `brainstorm-judge`; route `{ Runtime: "claude", Model: "opus" }`; five `brainstorm:judge*` tab keys.
- At least five approaches (D1's floor), 2-4 options, exactly one pick (D9).
- The judge's prompt holds every user answer, every confirmed part, the question's text and the shuffled list, and
  never the agent's `why`, `read`, guesses, notes or odds (D3).
- Never hand-edit generated files: change the Go types, then `task generate`.
- Edit `skills/`, never `cmd/wsh/cmd/claude-mod/`: `task sync:claudemod` writes the copy.
- Colors come from `@theme` tokens; copy the pane's existing classes for the new line, no new tokens.
- Typecheck with `task check:ts` (~2 min), never `npx tsc`.

## Review Focus

- A judge report with prose or a code fence around the JSON: the judge fails with a reason naming the result, never
  delivers half a question (Task 1 test).
- An approach with an empty `name`: it does not count toward the five, so four named approaches plus one nameless
  are refused (Task 1 test).
- A builder check reading on the same tab: a judge still starts, and a reading judge does not block a builder check
  (Task 3 test).
- A `judge` value of the wrong shape (`"x"`, `{}`, `{ "added": 3 }`): parsed as no record, the question draws as
  today (Task 4 test).
- A weighed record whose question lost its `approaches`, or that dropped nothing: the work line still reads as a
  sentence, and no dropped toggle shows when nothing was dropped (Task 4 test).

---

### Task 1: The judge's pure half

**Depends on:** none
**Files:** `pkg/brainstormcheck/judge.go`, `pkg/brainstormcheck/judge_test.go`, `pkg/brainstormcheck/judge-prompt.md`, `pkg/brainstormcheck/brainstormcheck.go`, `pkg/brainstormcheck/doc.go`

Everything about the judge that needs no store, process or clock. `brainstormcheck.Decide`'s signature stays as is
(Task 3's file calls it): share its body through an unexported helper that takes the empty-report reason.

**Interfaces (Produces, used by Task 3):**

```go
const MinApproaches = 5
const JudgeEmptyReason = "The judge ended without its result."

type Approach struct { Name, Description string; Facts []string }          // json: name, description, facts
type JudgeOption struct { Label, Detail string; Pros, Cons []string; Pick bool } // json: label, detail, pros, cons, pick (omitempty)
type JudgeInput struct {
    Question   string
    Answers    []QA            // every history entry of kind "question" with a non-empty a and not superseded, then
                               // every check.yours entry with a non-empty a: {Q, A}
    Confirmed  []ConfirmedPart // every part with state "yours" and no kind "note": {Title, Body}
    Approaches []Approach
    Earlier    []JudgeOption   // question.options when question.judge is a weighed record, else nil
}

func ReadJudgeInput(raw []byte) (JudgeInput, error)
func JudgePrompt(in JudgeInput, line, reportPath string, shuffle func(n int, swap func(i, j int))) string
func DecideJudge(run *waveobj.Run, lostReason string) (Action, []byte) // Deliver carries judge.json's bytes
func JudgeResultPath(brainstormFile string) string                      // <dir of brainstormFile>/judge.json
func JudgedLine(path string) string                                     // "brainstorm: judged " + path
func JudgeFailedLine(reason string) string                              // "brainstorm: judge failed: " + reason
```

- [ ] **Step 1: Write the failing tests in `judge_test.go`**
  - `TestReadJudgeInputRefusals`: invalid JSON, `question: null`, a question with no `approaches`, and four named
    approaches plus one with `"name": ""` each return an error; the last error names the floor of 5.
  - `TestReadJudgeInputKeepsOnlyWhatTheJudgeMaySee`: from a fixture with an answered question, a superseded one, a
    recon entry, a `check` holding one answered and one unanswered `yours` entry, a `yours` part, a `guess` part and
    a note, `Answers` holds the answered question and the answered builder question (its `q` and `a`) and nothing
    else, `Confirmed` only the `yours` part; `Earlier` is nil without `question.judge`, and equals `question.options` with a weighed
    record, nil with `{ "failed": ... }`.
  - `TestJudgePromptHoldsTheListShuffledAndNoFavorite`: with a fixture whose `why`, `read`, guess part and note carry
    marker strings and whose approaches carry a `"probability"` field, the prompt contains every approach's name,
    description and facts, the question text, the answers and confirmed parts, and the report path; it contains none
    of the marker strings and no `probability`. With a reversing `shuffle`, the approaches appear in reverse file
    order.
  - `TestJudgePromptOnARerun`: with `Earlier` set and a `line` of `"double check"`, the prompt holds each earlier
    option's label, which one was the pick, and the line verbatim; with neither, it holds no rerun section.
  - `TestJudgePromptSaysWhatTheJudgeMustDo`: the prompt names `.superpowers/` as off limits, says to verify facts
    and to ask what approach would beat every listed one, and ends with `wsh jarvis complete --report <reportPath>`.
  - `TestDecideJudge`: running run → Wait; done with empty report → Fail `JudgeEmptyReason`; done with prose around
    the JSON, wrapped in a markdown json fence, with 1 or 5 options, with no pick or two picks, with an empty `read`, with an
    option missing its label or detail, or a dropped entry missing its reason → Fail whose reason starts
    `"The judge's result is not usable: "`; done with a good report → Deliver, and the bytes unmarshal to exactly
    `{ "options", "read", "judge": { "added", "dropped" } }` (`added: []` when the judge wrote none); not done with
    a lost reason → Fail with that reason.
  - `TestJudgePathsAndLines`: `JudgeResultPath` is `judge.json` beside the file; the two lines are exact.
  - The existing `TestDecide` still passes unchanged.

- [ ] **Step 2: Run them and see them fail:** `go test ./pkg/brainstormcheck -run 'Judge'` fails to compile.

- [ ] **Step 3: Implement** `judge.go` and `judge-prompt.md` (embedded like `builder-check-prompt.md`, with
  placeholders). The prompt starts from the benchmark's judge prompt
  (`C:\Users\kael02\IdeaProjects\waveterm\.superpowers\brainstorm\brainstorm-like-orchestrator\bench\run.js`,
  `prompts.J`) and today's **Check an approach before you offer it** rule in `skills/brainstorm/SKILL.md`: read-only;
  never read `.superpowers/`; the list's facts may be wrong, verify the ones the choice turns on; first ask what
  approach would beat every listed one and add it if one does; ground every pro and con in a named fact; write 2-4
  options with one pick, a `read` naming the fact the pick rests on, the names it `added`, and every listed approach
  it did not offer in `dropped` with a one-line reason; write only the JSON object to the report path, then run
  `wsh jarvis complete --report <path>`. Update `doc.go` to say the package holds the judge's pure half too.

- [ ] **Step 4: Run** `go test ./pkg/brainstormcheck -run 'Judge|Decide|Prompt|Line|ReportPath'`: PASS.

- [ ] **Step 5: Commit** `feat(brainstorm): the judge's prompt, result check and lines`.

### Task 2: A judge's run is hidden like a builder check's

**Depends on:** none
**Files:** `pkg/jarvis/usage.go`, `pkg/jarvis/usage_test.go`, `pkg/jarvis/attention.go`, `pkg/jarvis/attention_test.go`, `pkg/jarvisstate/jarvisstate.go`, `pkg/jarvisstate/jarvisstate_test.go`, `pkg/wshrpc/wshserver/wshserver_channels.go`, `pkg/wshrpc/wshserver/wshserver_channels_test.go`, `pkg/wshrpc/wshserver/wshserver_runs.go`, `pkg/wshrpc/wshserver/wshserver_run_test.go`, `cmd/wsh/cmd/wshcmd-runs.go`, `cmd/wsh/cmd/wshcmd-runs_test.go`

Spec D4: the judge's run is left out wherever a builder-check run is (the session tree's side is Task 6).

**Interfaces (Produces, used by Task 3):**

```go
const UsageRole_BrainstormJudge = "brainstorm-judge" // pkg/jarvis/usage.go
func IsBrainstormSession(r *waveobj.Run) bool          // replaces IsBuilderCheck: builder-check or brainstorm-judge
```

- [ ] **Step 1: Write the failing tests**
  - `pkg/jarvis/usage_test.go`: `TestIsBrainstormSession` is true for both roles, false for a plain run, a
    plan reviewer and a task reviewer; `TestUsageRoleOfAStageSession` gains a `brainstorm-judge` row.
  - Extend each existing builder-check test with a judge run beside the builder-check one:
    `TestBuildAttentionLeavesOutABuilderCheckRun`, `TestBuilderCheckRunIsNoRunYouStarted`,
    `TestGetChannelRunCommandsLeaveOutABuilderCheck`, `TestBuilderCheckRunLeavesSealDueFalse`.
  - `cmd/wsh/cmd/wshcmd-runs_test.go`: `TestRunsIsTask` gains
    `{"brainstorm judge", waveobj.Run{Mode: jarvis.RunMode_Quick, StageRole: jarvis.UsageRole_BrainstormJudge}, true}`
    beside its builder-check row.

- [ ] **Step 2: Run** `go test ./pkg/jarvis ./pkg/jarvisstate -run 'BrainstormSession|StageSession|BuilderCheck'`
  and `go test ./cmd/wsh/cmd -run 'RunsIsTask'`: they fail.

- [ ] **Step 3: Implement.** Add the role; rename `IsBuilderCheck` to `IsBrainstormSession` and widen it; update
  every caller (grep `IsBuilderCheck` and `UsageRole_BuilderCheck`: `attention.go`, `jarvisstate.go`,
  `wshserver_channels.go`, `wshserver_runs.go`'s `sealDue`, `wshcmd-runs.go`) and the comments that say "builder
  check" where they now mean both.

- [ ] **Step 4: Run** the Step 2 commands plus
  `go test ./pkg/wshrpc/wshserver -run 'BuilderCheck|LeaveOut'`: PASS. `grep -rn IsBuilderCheck --include=*.go .`
  (outside `.worktrees`) finds nothing.

- [ ] **Step 5: Commit** `feat(brainstorm): hide a judge's run like a builder check's`.

### Task 3: wsh brainstorm judge, the watcher and delivery

**Depends on:** Task 1 (uses ReadJudgeInput, JudgePrompt, DecideJudge, the paths and lines), Task 2 (uses UsageRole_BrainstormJudge)
**Chunk:** Build: judge session (wsh brainstorm judge, watcher, result, line)
**Files:** `pkg/wshrpc/wshrpctypes_agents.go`, `pkg/waveobj/wtypemeta.go`, `pkg/waveobj/metaconsts.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshserver/wshserver_brainstorm.go`, `pkg/wshrpc/wshserver/wshserver_brainstorm_test.go`, `cmd/server/main-server.go`, `cmd/wsh/cmd/wshcmd-brainstorm.go`, `cmd/wsh/cmd/wshcmd-brainstorm_test.go`

Spec flow steps 2-4, D4, D6, D9. Generalize the builder check's handler, watcher, tick and startup sweep in
`wshserver_brainstorm.go` over what differs between the two (record keys, role, label, route, prompt, verdict,
what delivery writes and sends, the failure path) instead of copying them. What differs for the judge:

- Record keys `brainstorm:judgestate|judgets|judgerun|judgechannel|judgereason`, states `reading`, `answered`,
  `failed`; its own mutex-guarded "already reading" refusal, independent of the builder check's.
- The handler reads the file with `brainstormcheck.ReadJudgeInput` (its error is the refusal), checks the file is
  under `.superpowers` as the check does, and builds the prompt at launch with `rand.Shuffle` and the data's `Line`.
- Route `waveobj.RoutePin{Runtime: "claude", Model: "opus"}` always; role `jarvis.UsageRole_BrainstormJudge`;
  label `"Judge · " + title`.
- Deliver: write `DecideJudge`'s bytes to `JudgeResultPath(file)`, send `JudgedLine(path)`. Fail (empty, unusable,
  lost, launch error, write error, restart before launch, detached brainstorm): record `failed` with the reason AND
  send `JudgeFailedLine(reason)` to the agent's block, since the pane has no judge card (D9).

**Interfaces:**
- Consumes: Task 1's functions; Task 2's role.
- Produces: RPC `BrainstormJudgeCommand(ctx, CommandBrainstormJudgeData) error` with
  `CommandBrainstormJudgeData{ BlockId string "blockid"; File string "file"; Line string "line,omitempty" }`;
  `wsh brainstorm judge <brainstorm.json> [--line <text>]`, printing `judge started`; the startup sweep re-arms both
  kinds and is renamed `ResumeBrainstormSessions` (update its call in `cmd/server/main-server.go`; Task 5's doc
  cites this name).

- [ ] **Step 1: Write the failing tests** in `wshserver_brainstorm_test.go`, with the launch, run read and arm vars
  stubbed as the builder-check tests do:
  - `TestBrainstormJudgeRefusals`: no block, a relative path, a file with no question, four approaches, a tab whose
    `brainstorm:judgestate` is `reading` each return an error and launch nothing.
  - `TestBrainstormJudgeIgnoresABuilderCheck`: a tab whose `brainstorm:checkstate` is `reading` still starts a judge,
    and a `reading` judge does not refuse `BrainstormCheckCommand`.
  - `TestBrainstormJudgeLaunchWritesReadingThenTheRun`: the record goes `reading`, then gains run and channel; the
    launched session has role `brainstorm-judge`, route claude/opus whatever the agent's runtime and the channel's
    reviewer route, a label starting `Judge · `, and a prompt holding every approach and the `--line` text.
  - `TestBrainstormJudgeDelivers`: a done run with a good report writes `judge.json` beside the file with
    `DecideJudge`'s bytes, sends exactly `brainstorm: judged <path>` to the block, record `answered`.
  - `TestBrainstormJudgeFailsWithALine`: an unusable report, an empty one, and a lost run each record `failed` with
    the reason and send `brainstorm: judge failed: <reason>`; a lost run is stopped.
  - `TestResumeBrainstormSessionsRearmsOrFailsJudges`: a `reading` judge with a run is re-armed, one without a run
    fails with a line, one whose tab has no brainstorm fails; `TestResumeBuilderChecksRearmsOrFails` moves onto
    `ResumeBrainstormSessions` with its assertions unchanged.
  - `wshcmd-brainstorm_test.go`: `TestBrainstormJudgeCmdSendsBlockPathAndLine` (relative path made absolute, `--line`
    passed through verbatim, absent line sends ""), `TestBrainstormJudgeCmdReturnsTheRpcError`.
  - Every existing builder-check test still passes.

- [ ] **Step 2: Run** `go test ./pkg/wshrpc/wshserver -run 'Brainstorm|BuilderCheck|Resume'` and
  `go test ./cmd/wsh/cmd -run 'Brainstorm'`: they fail.

- [ ] **Step 3: Implement.** Add the data type and RPC to `wshrpctypes_agents.go` and the five keys to
  `wtypemeta.go`, run `task generate`, then the handler, the generalized watcher and the command.

- [ ] **Step 4: Run** the Step 2 commands: PASS. `go build ./...` succeeds.

- [ ] **Step 5: Commit** `feat(brainstorm): wsh brainstorm judge runs a blind Opus judge and delivers its result`.

### Task 4: The judged question in the pane

**Depends on:** none
**Chunk:** Build: judged question in the pane (labels, work line, dropped list)
**Files:** `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `frontend/app/view/agents/brainstormui.tsx`, `frontend/app/view/agents/brainstormpane.tsx`, `scripts/cdp/scenarios-brainstorm-judge.mjs`, `scripts/cdp/scenarios.mjs`

Spec D5, D6, D9; the board is the Prototype. Pure parts go in `brainstormmodel.ts`; the `.tsx` files only draw.

**Interfaces (Produces):**

```ts
export type Approach = { name: string; description: string; facts: string[] };
export type JudgeRecord =
    | { kind: "weighed"; added: string[]; dropped: { name: string; reason: string }[] }
    | { kind: "failed"; reason: string };
// BrainstormQuestion gains approaches?: Approach[] and judge?: JudgeRecord; HistoryEntry gains judge?: JudgeRecord;
// HistoryRow gains judged: boolean (its entry's judge is weighed)
export type JudgeWork = { line: string; judged: boolean; dropped: { name: string; reason: string }[] };
export function judgeWork(q: BrainstormQuestion): JudgeWork | null; // null without a judge record
```

Copy, from the board: the read's label is `Judge’s read: ` and the pick's `Judge’s pick` on a weighed question.
The work line is `Judge’s work: ` then `weighed the 7 approaches the agent listed, added none, dropped 3.`, where
"added" names the added approaches (`added A`, `added A and B`, `added A, B and C`) and "dropped" counts them
(`dropped none` when none); with no `approaches`, `weighed the approaches the agent listed`. A failed record keeps
`Agent’s read` / `Agent’s pick` and its line is `the judge failed, so the read and pick are the agent’s: <reason>`.
The toggle reads `Show the 3 dropped` / `Hide the 3 dropped`, starts closed, and is absent when nothing was dropped;
each dropped row shows the name and `Dropped: <reason>`. A history row whose entry is judged reads `Judge’s pick`.
DOM hooks for the scenario: `data-brainstorm-judge-work` on the line, `data-brainstorm-judge-dropped-toggle` on the
toggle, `data-brainstorm-judge-dropped` on the list; the read keeps `data-brainstorm-read`.

- [ ] **Step 1: Write the failing tests** in `brainstormmodel.test.ts`:
  - parses `approaches` and a weighed `judge` on the question and on a history entry; parses `{ "failed": "x" }`
    as a failed record; `judge` of `"x"`, `{}`, `{ "added": 3 }` parses as no record and the rest of the question as
    today; a question without `judge` parses exactly as before.
  - `judgeWork`: the board's case gives the board's line and three dropped; one added, two added and three added
    name them as above; nothing dropped gives `dropped none`; no `approaches` gives the fallback wording; a failed
    record gives the failure line with `judged: false`; no record gives `null`.
  - the history row of a judged entry has `judged: true`, of an unjudged one `false`.

- [ ] **Step 2: Run** `npx vitest run frontend/app/view/agents/brainstormmodel.test.ts`: the new cases fail.

- [ ] **Step 3: Implement** the parse and `judgeWork`, then the drawing: `QuestionAnswers` picks the labels and
  draws the work line and dropped list under the options (toggle state is local, closed on mount); `Options` takes
  the pick label instead of hardcoding it; the history row in `brainstormpane.tsx` reads `row.judged`.

- [ ] **Step 4: Write the CDP scenario** `brainstorm-judged-question` in `scripts/cdp/scenarios-brainstorm-judge.mjs`
  (a module like `scenarios-brainstorm-findings.mjs`, using `bsBoardScenario` from the kit) and register it in
  `scenarios.mjs` beside the other brainstorm modules. Its fixture is the board's question: 7 approaches, the board's
  4 options and read, `judge` with no added and the board's 3 dropped. Steps, each a `rec` with a shot:
  1. the pane shows `Judge’s read:`, one `Judge’s pick`, no `Agent’s`, the exact work line, and the dropped list closed;
  2. clicking the toggle opens the list with the 3 names and their `Dropped:` reasons, and the toggle reads `Hide the 3 dropped`;
  3. rewriting the file with `{ "failed": "Arc restarted before the judge started." }` shows `Agent’s read:`, `Agent’s pick` and the failure line;
  4. rewriting it with the question answered (history entry holding the options, `picked` and the weighed `judge`) shows `Judge’s pick` on that history row.

- [ ] **Step 5: Run** `npx vitest run frontend/app/view/agents/brainstormmodel.test.ts` (PASS) and `task check:ts`
  (exit 0). If a dev app with CDP is up, `task verify:ui -- brainstorm-judged-question`; Final runs it regardless.

- [ ] **Step 6: Commit** `feat(brainstorm): the pane draws a judged question`.

### Task 5: The skill and the docs

**Depends on:** none
**Chunk:** Build: brainstorm skill's approach-question flow
**Files:** `skills/brainstorm/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/brainstorm/SKILL.md`, `docs/agents/brainstorm.md`, `docs/deferred.md`

Spec flow steps 1, 5, 7, D2, D6, D7, D8, D9. Keep the skill's voice: short imperative rules, the lines table, one
example. Changes to `skills/brainstorm/SKILL.md`:

- The `question` field row and the example gain `approaches` and `judge` as D9 shapes them.
- **Check an approach before you offer it** becomes the approach-question rule: its scope (D2: how to build, which
  design, which mechanism; permissions, process steps, plain choices and builder-check questions keep "Agent's pick");
  the list (at least five distinct approaches, each with the facts found in the code, naming files and functions; no
  odds, no pick, no ranking, no pros and cons; odds may widen the list in the agent's head, never in the file); the
  question's `why` states facts and what is unknown, never a lean; no `options` or `read`; `working` set to one line
  (`The judge is weighing 7 approaches.`); run `wsh brainstorm judge <abs path of brainstorm.json>`; end the turn.
  If the command fails, do as for `judge failed`, with the command's error as the reason.
- Two rows in the lines table: `brainstorm: judged <path>`: one `node -e` script that `Object.assign`s the file at
  `<path>` onto `question` and sets `working` to `null` in the same write, never retyping it, then end the turn on
  the question. `brainstorm: judge failed: <reason>`: write your own `options` and `read` with one `pick`, set
  `question.judge` to `{ "failed": "<reason>" }` and `working` to `null`.
- **On an answer**: a judged question's history entry copies `judge` beside `options`.
- **When the line is not an answer** and **A line with no question open**: on a judged question, pushback against the
  options or a typed "double check" adds any alternative the user names to `approaches`, sets `working`, and runs
  `wsh brainstorm judge <path> --line "<their line, verbatim>"`; a plain question back is answered in `why` as today.
  On such a rerun the question keeps its `options`, `read` and `judge` until the new `judge.json` is copied over
  them: Arc reads the earlier options and pick from there (the "no `options` or `read`" rule is for a question's
  first judge only). Remove the references to rerunning the old check.

Then run `task sync:claudemod`. `docs/agents/brainstorm.md` gets a section "How Arc runs the judge" in the style of
"How Arc runs the builder check" (the handoff, the session and its fixed route, the tab record, the watcher and the
result check, delivery and the two lines, the startup sweep, the hidden run, the nested tree row), and the two
lines. Its "The startup sweep" bullet names `ResumeBrainstormSessions` (Task 3's rename of `ResumeBuilderChecks`)
and says it re-arms both kinds. `docs/deferred.md` gets one entry: an end-to-end check of a live judge in a real brainstorm, which no
scenario can run (a real session, about a minute).

- [ ] **Step 1:** Edit the skill, run `task sync:claudemod`.
- [ ] **Step 2:** `diff -r skills/brainstorm cmd/wsh/cmd/claude-mod/skills/brainstorm` prints nothing;
  `grep -n "Check an approach before you offer it" skills/brainstorm/SKILL.md` finds nothing;
  `grep -c "wsh brainstorm judge" skills/brainstorm/SKILL.md` is at least 2.
- [ ] **Step 3:** Edit `docs/agents/brainstorm.md` and `docs/deferred.md`.
- [ ] **Step 4: Commit** `docs(brainstorm): approach questions go to the judge`.

### Task 6: The judge's session nests under its agent in the agent tree

**Depends on:** none
**Files:** `frontend/app/view/agents/session-models/sessionviewmodel.ts`, `frontend/app/view/agents/session-models/sessionviewmodel.test.ts`, `frontend/app/view/agents/session-models/sessionsidebarmodel.ts`, `frontend/app/view/agents/liveagents.ts`, `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/agenttreemodel.ts`, `frontend/app/view/agents/agenttreemodel.test.ts`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/view/agents/runlineage.ts`, `frontend/app/view/agents/sessionsruns.ts`, `frontend/app/view/agents/sessionsruns.test.ts`, `scripts/cdp/scenarios-brainstorm-builder.mjs`

Spec D4: the judge's session is a solo in the session list and nests under the brainstorming agent in the agent
tree, exactly as 855af287 nests the builder check's reviewer. Follow that commit's path end to end
(`git show 855af287`): the tab record is read in `sessionviewmodel.ts`, carried through `sessionsidebarmodel.ts`,
`liveagents.ts` and `agentsviewmodel.ts` onto the `AgentVM`, and `buildAgentTree` nests the session whose run the
record names. Generalize each step over the two records rather than copying it.

**Interfaces:**
- Consumes: the five tab keys `brainstorm:judgestate|judgets|judgerun|judgechannel|judgereason` (spec D9; Task 3
  writes them, nothing here waits on it), with the builder check's state values.
- Produces: `BRAINSTORM_JUDGE_ROLE = "brainstorm-judge"` in `runlineage.ts`, with stage label `Judge`;
  `brainstormJudgeOf(tabMeta)` beside `builderCheckOf`, both reading through one helper parameterized by the key
  prefix and returning `BuilderCheckRecord`; `AgentVM.brainstormJudge?: BuilderCheckRecord`; the tree's `check` row
  carries the stage role it draws, so `agenttree.tsx` titles a judge's row `Judge` and a reviewer's `Builder check`.

- [ ] **Step 1: Write the failing tests**
  - `sessionviewmodel.test.ts`: `brainstormJudgeOf` reads the five judge keys as `builderCheckOf` reads the check's,
    ignores the check's keys, and an unknown state is no record; `builderCheckOf` ignores the judge's keys.
  - `agenttreemodel.test.ts`, beside the builder-check nesting cases: a session whose run a brainstorming agent's
    judge record names nests right under that agent with the judge's role and the record's state; a tab holding
    both records nests both sessions under it; with the brainstorming agent gone the judge's session is a plain row;
    the group's counts are unchanged by nesting.
  - `sessionsruns.test.ts`: the "leaves a builder-check session solo" case also holds a `role: "brainstorm-judge"`
    session, which stays solo with no run row.

- [ ] **Step 2: Run** `npx vitest run frontend/app/view/agents/session-models/sessionviewmodel.test.ts frontend/app/view/agents/agenttreemodel.test.ts frontend/app/view/agents/sessionsruns.test.ts`:
  the new cases fail.

- [ ] **Step 3: Implement** the reader, the plumbing, the nesting and the row title.

- [ ] **Step 4: Add the CDP scenario** `brainstorm-judge-tree` to `scenarios-brainstorm-builder.mjs`, as a variant of
  `brainstorm-builder-tree` sharing its arrange, read and teardown helpers: a stand-in judge tab whose session has
  `role: "brainstorm-judge"`, and the judge record written on the brainstorm's tab. Steps, each with a shot:
  1. no record: the judge's session is a top-level row;
  2-4. the record names its run, as `reading`, `answered`, `failed`: it is a `Judge` row nested right under the
  brainstorm, the counts unchanged;
  5. the brainstorm's tab closes: it is a top-level row again.
  `brainstorm-builder-tree` keeps passing unchanged.

- [ ] **Step 5: Run** the Step 2 command (PASS) and `task check:ts` (exit 0). Final runs both tree scenarios.

- [ ] **Step 6: Commit** `feat(agents): nest a brainstorm's judge under its brainstorming agent`.
