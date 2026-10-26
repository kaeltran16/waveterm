# Workflow scan Implementation Plan

> **For agentic workers:** each task is one engine task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On demand, a quick Opus run reads the last 14 days of run records, has Sonnet name recurring workflow
problems, recounts them in code, drafts small fixes, and applies or declines them as the owner picks in a new
Usage > Workflow lens.

**Architecture:** A pure Go package (`pkg/workflowscan`) builds the corpus, recounts Sonnet's citations and holds the
prompts. wavesrv runs the scan behind new wshrpc commands and keeps every scan's state on the scan run's own record
(`Run.WorkflowScan`). The frontend reads the newest scan run and follows its object. Every way into the lens is the
address `workflowscan:<runid>`, which goes through the one router (`openref.ts`). Picks go back over RPC and reach the
agent as a typed line.

**Tech Stack:** Go (wavesrv, wsh, SQLite store), React 19 + jotai + Tailwind 4, vitest, CDP scenarios.

**Spec:** `C:\Users\kael02\IdeaProjects\waveterm\docs\superpowers\specs\2026-10-26-workflow-scan-design.md` — read its
"Builder decisions" section first: it fixes every name, number and rule this plan uses.
**Verify:** `node scripts/verify.mjs ./pkg/workflowscan/... ./pkg/wstore ./pkg/jarvis ./pkg/wshrpc/... ./cmd/wsh/cmd ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go build ./pkg/... ./cmd/...`
**Final:** `node scripts/cdp/final-verify.mjs workflow-scan workflow-scan-entry usage-work`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\workflow-scan\project\Main.dc.html

Design decisions beyond the canvas are in the spec's "Builder decisions" section. The canvas folder holds three
boards, each covered by scenario steps: `Main.dc.html` and `States.dc.html` by `workflow-scan`, and `Palette.dc.html`
by `workflow-scan-entry`. The spec's "A dropped suggestion stays dropped" overrides any board that offers a Declined
entry as copy for another repo.

**Out of this run's scope, by design:**
- The spec's Acceptance check: the first real scan raises P2, and its verified runs agree with the P2 regex. It needs
  a real Sonnet and Opus scan over the packaged store, so the owner runs it after the land. Task 2's `liveprobe` test
  is the evidence this run can give.
- No scenario fires a real scan start, because that launches an Opus agent. The start paths are unit-tested, and the
  scenarios assert the rows and buttons that start a scan.

## Global Constraints

- Window 14 days by run `createdts`; floor 3 verified runs; per-field cut 1,500 chars; corpus cap 640,000 chars,
  oldest blocks dropped first; a quote under 24 normalized chars is unverified.
- Sonnet pass: `consult.Run` with `consult.SpecForTier("claude", consult.TierMid)` plus `--session-id <uuid>`, run in
  the scan run's project directory. Never `HeadlessSpecForTier`.
- The scan run: a quick run on runtime `claude`, model `opus`, created through the same path `CreateRunCommand` uses.
- A run's project name: its channel's name, else the base name of its project path.
- Nothing persists between scans except git and the newest scan run's record. No new table, no new store.
- No scheduled or after-seal scan. No session or worker transcripts in the corpus.
- The probe's P1, P2, P3 and P6 stay unapplied. No task edits `AGENTS.md`, `workerContract`, `planReviewChecklist` or
  `eslint.config.js` for them.
- Opening a scan anywhere goes through `openTarget` with `{kind: "workflowscan", runId}`; nothing hand-sets the
  surface and lens.
- Colors only from `@theme` tokens in `frontend/tailwindsetup.css`; no new tokens (DESIGN.md). The boards' hex values
  map onto existing tokens.
- Never hand-edit generated files; Task 1 alone runs `task generate`.
- Comments only for why, lower case, matching the surrounding code.

## Review Focus

1. Sonnet cites a run by an 8-char prefix that two runs in the window share: the citation is unverified, never
   counted for either (Task 2 `TestRecountAmbiguousRunId`).
2. The agent sends verdicts that miss a survivor, repeat one, or put a 4-line edit on a `suggest`: the server refuses
   with a reason naming the id (Task 2 `TestValidateVerdicts`).
3. The owner picks Apply on a fix whose `fixproject` is another project, or Drop with an empty reason: refused
   server-side, and the lens never offers it (Task 2 `TestValidatePicks`, Task 5 `workflowlens.test.ts`).
4. A scan run cancelled or crashed mid-scan keeps `State` `scanning`: it must block neither a new start nor the lens's
   button (Task 3 `TestWorkflowScanStartIgnoresFinishedRuns`, Task 5 `scanButton` test).
5. The scan's agent tab is gone when picks arrive: picks are stored and `applying` is set, and the lens shows the
   delivery error naming the run (Task 3 `TestWorkflowScanPicksStoredWhenDeliveryFails`).

---

### Task 1: The scan's types, RPC surface and address
**Depends on:** none
**Files:** `pkg/waveobj/wtype.go`, `pkg/wshrpc/wshrpctypes_workflowscan.go`, `pkg/wshrpc/wshrpctypes.go`, `pkg/wshrpc/wshserver/wshserver_workflowscan.go`, `pkg/jarvis/usage.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `frontend/app/view/agents/usagestore.ts`, `frontend/app/view/agents/workflowscanstart.ts`, `frontend/app/view/jarvis/address.ts`, `frontend/app/view/jarvis/address.test.ts`, `frontend/app/view/jarvis/openref.ts`

The interface every other task builds on. Small on purpose: the handlers here are stubs Task 3 replaces.

**Produces:**

- In `pkg/waveobj/wtype.go`, on `Run`:
  - `WorkflowScan *WorkflowScan \`json:"workflowscan,omitempty"\``
  - `ConsultSessions []ConsultSession \`json:"consultsessions,omitempty"\`` — sessions a run started outside its
    own agent, each with the usage role it played.
- New types in the same file, json tags all lower case with no separators, as the file does:
  - `ConsultSession{SessionId, Role string}`
  - `WorkflowScan{State, Stage, Project string; WindowDays int; FromTs, ToTs int64; Runs, Projects, Candidates,
    Kept, Dropped int; Survivors, UnderFloor []WorkflowScanPattern; Verdicts []WorkflowScanVerdict;
    Picks []WorkflowScanPick; Error string}`. `Project` is the scan's own project name.
  - `WorkflowScanPattern{Id, Title, FixTarget string; Runs, Days int; Projects []WorkflowScanProject;
    Quotes []WorkflowScanQuote}`
  - `WorkflowScanProject{Name string; Runs int}`
  - `WorkflowScanQuote{RunId, Project, Date, Text string}`: `RunId` the full id, `Date` `YYYY-MM-DD`.
  - `WorkflowScanVerdict{Id, Verdict, Note, File, Where, FixProject, Edit string; DeclinedAt int}`
  - `WorkflowScanPick{Id, Pick, Reason string}`
- Exported string constants in `pkg/waveobj/wtype.go`: `WorkflowScanState_Scanning|Picking|Applying|Failed`,
  `WorkflowScanStage_Read|Patterns|Recount|Checking`, `WorkflowScanVerdict_Suggest|Covered|Declined`,
  `WorkflowScanPick_Apply|Drop`, with the spec's values (`scanning`, `read`, `suggest`, `apply`, ...).
- `jarvis.UsageRole_WorkflowScan = "workflow-scan"` in `pkg/jarvis/usage.go`.
- `WorkflowScanCommands` interface in `pkg/wshrpc/wshrpctypes_workflowscan.go`, embedded in `WshRpcInterface`:
  - `WorkflowScanStartCommand(ctx, CommandWorkflowScanStartData{ChannelId, WorkspaceId string; WindowDays int})
    (*CommandWorkflowScanStartRtnData{Run *waveobj.Run}, error)`
  - `WorkflowScanCommand(ctx, CommandWorkflowScanData{ORef string; WindowDays int}) (*waveobj.WorkflowScan, error)`
    — `ORef` is the calling agent's `tab:<id>`.
  - `WorkflowScanResultCommand(ctx, CommandWorkflowScanResultData{ORef string; Verdicts []waveobj.WorkflowScanVerdict}) error`
  - `WorkflowScanPicksCommand(ctx, CommandWorkflowScanPicksData{ChannelId, RunId string; Picks []waveobj.WorkflowScanPick}) error`
  - `GetWorkflowScanCommand(ctx, CommandGetWorkflowScanData{ORef string}) (*CommandGetWorkflowScanRtnData{ChannelId, RunId string; Scan *waveobj.WorkflowScan}, error)`
    — with `ORef`, the scan run that tab works; without, the newest run that has a `WorkflowScan`; none is a nil
    `Scan`, not an error.
- Stub handlers in `pkg/wshrpc/wshserver/wshserver_workflowscan.go`, each returning
  `errors.New("workflow scan is not built yet")`.
- `task generate` output committed.
- Frontend:
  - `UsageLens` in `usagestore.ts` gains `"workflow"`.
  - `frontend/app/view/agents/workflowscanstart.ts` exports `workflowScanRunAtom: PrimitiveAtom<string | null>`, the
    run id the lens follows.
  - The same file exports `startWorkflowScan(model: AgentsViewModel, channelId: string): Promise<Run>`. It calls
    `WorkflowScanStartCommand` with the workspace id, then `openTarget(model, {kind: "workflowscan", runId})`. A
    start error propagates to the caller.
  - `address.ts`: `OpenTarget` gains `{kind: "workflowscan"; runId: string}`, and `parseAddress("workflowscan:<id>")`
    returns it.
  - `openref.ts` routes that kind: it sets `workflowScanRunAtom`, sets `usageLensAtom` to `"workflow"` and lands on
    the `usage` surface. It needs no loading step, like `memhygiene`.

- [ ] Add a case to `address.test.ts`: `"workflowscan:r-1"` parses to `{kind: "workflowscan", runId: "r-1"}`. Run
  `npx vitest run frontend/app/view/jarvis/address.test.ts` and see it fail.
- [ ] Add the Go types, constants, interface and stubs; run `task generate`; run `go build ./pkg/... ./cmd/...`.
- [ ] Add the lens value, `workflowscanstart.ts`, the address kind and its route. Run the address test (it passes)
  and `task check:ts` (exit 0).
- [ ] Commit.

**Acceptance:** `go build ./pkg/... ./cmd/...` and `task check:ts` pass; the generated TS has
`WorkflowScanStartCommand` and the `WorkflowScan` type; the `address.test.ts` case passes.

### Task 2: Corpus, recount, prompts and validation (`pkg/workflowscan`)
**Depends on:** Task 1 (uses the `waveobj.WorkflowScan*` types)
**Files:** `pkg/workflowscan/corpus.go`, `pkg/workflowscan/corpus_test.go`, `pkg/workflowscan/recount.go`, `pkg/workflowscan/recount_test.go`, `pkg/workflowscan/sonnet.go`, `pkg/workflowscan/sonnet_test.go`, `pkg/workflowscan/goal.go`, `pkg/workflowscan/validate.go`, `pkg/workflowscan/validate_test.go`, `pkg/workflowscan/liveprobe_test.go`

Pure package: no store, no consult, no RPC. It ports `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/dag-measure/corpus.mjs`.
That file is gitignored, so it is in the main checkout only, not in a worktree. The spec's Corpus section lists every
signal and tag, so it is enough on its own.

**Produces:**

- `type RunInfo struct{ Run *waveobj.Run; Project string }`. The caller resolves `Project` by the Global Constraints
  rule.
- `type Corpus struct{ Text string; Blocks []Block; Runs, Projects, Dropped int }` and
  `type Block struct{ RunId, Short, Project, Date string; Lines []string }`.
- `BuildCorpus(runs []RunInfo, events []waveobj.RunEvent, now time.Time, windowDays int) Corpus`:
  - the window and the brainstorm and scan exclusions are applied here;
  - blocks go in `createdts` order;
  - `MaxField = 1500` and `MaxCorpusChars = 640000` are exported constants;
  - the header and line format are the spec's.
- `type Candidate struct{ Title, FixTarget string; Citations []Citation }` and
  `type Citation struct{ Run, Quote string }`.
- `Recount(c Corpus, cands []Candidate) (survivors, underFloor []waveobj.WorkflowScanPattern)`:
  - `Floor = 3` and `MinQuoteChars = 24` are exported;
  - the normalization is lower case with whitespace runs collapsed to one space;
  - survivor ids are `p1..`, in order of verified runs, most first;
  - under-floor rows carry no id;
  - `Days` counts distinct `Date`s;
  - `Projects` are ordered by runs, most first.
- `SonnetPrompt(c Corpus) string` and `ParseSonnetReply(reply string) ([]Candidate, error)`.
  - The prompt asks only for patterns seen in 3 or more distinct runs, one verbatim quote per cited run, the fix
    target as `<file> · <symbol or section>`, and the output schema from the spec.
  - Parse reads the last fenced `json` block, falling back to the outermost `{...}`. No block, or bad JSON, is an
    error that quotes the first 200 chars of the reply.
- `Goal(project string, windowDays int) string`: the Opus run's instructions, first line `Workflow scan`.
  - They spell out the spec's six steps and the exact commands from the spec's "The Opus run" section.
  - The verdict JSON shape is given as `{"verdicts":[{"id","verdict","note","file","where","fixproject","edit","declinedat"}]}`.
  - The Declined entry format is copied from the spec, written to `docs/deferred.md` in this repo, creating the file
    if the repo has none.
  - Fixes to Arc's own prompts (engine, plan review, skills) live in the Arc repo `waveterm`.
  - The agent waits idle for the picks line and does not poll.
  - It commits only the files it changed, with a `chore(workflow):` subject.
- `ValidateVerdicts(survivors []waveobj.WorkflowScanPattern, vs []waveobj.WorkflowScanVerdict) error` and
  `ValidatePicks(scan *waveobj.WorkflowScan, picks []waveobj.WorkflowScanPick) error`, with the spec's rules and errors
  that name the id.

- [ ] Write the failing tests:
  - `TestCorpusSignals`: one fixture run per event kind and evidence field, each landing as its tagged line.
    `task-review-passed` with no `unverified`, `child-answered`, `task-lead-told` and text `none` / `undefined` /
    empty produce no line.
  - `TestCorpusFieldCut`: a 2,000-char field becomes 1,500 chars plus ` …`.
  - `TestCorpusWindow`: a run created 15 days before `now` is left out at 14 and kept at `windowDays` 30.
  - `TestCorpusSkipsBrainstormAndScanRuns`.
  - `TestCorpusCapDropsOldest`: `Dropped` counts the cut blocks and the newest block survives.
  - `TestRecountNormalizes`: a quote differing only in case and line breaks verifies.
  - `TestRecountOneCountPerRun`: two citations of one run count once.
  - `TestRecountFloor`: 2 verified runs goes under the floor and 3 survives.
  - `TestRecountShortQuote`: a 23-char quote is not verified.
  - `TestRecountAmbiguousRunId`: two runs sharing a prefix leave that citation unverified.
  - `TestRecountWrongRun`: a true quote cited to the wrong run is unverified.
  - `TestRecountIdsAndDays`.
  - `TestSonnetPromptAsks`: the prompt holds the 3-run floor, the verbatim-quote rule, the
    `<file> · <symbol or section>` target form and the corpus text.
  - `TestParseSonnetReply`: a fenced block, prose around it, and no block, which errors.
  - `TestValidateVerdicts`:
    - errors: a missing id, a duplicate, an unknown id, a `suggest` with 4 `+` lines, a `suggest` with 4 `-` lines, a
      `suggest` with no file, a `covered` with no note, a `declined` with `declinedat` 0;
    - valid: a set holding a `suggest` with `declinedat` set (raised again).
  - `TestValidatePicks`: apply on another project's fix, drop with a blank reason, a non-suggest id, and a valid set.
  - `TestGoalNamesCommands`: the goal holds each `wsh workflow` command and `docs/deferred.md`.
- [ ] Run `go test ./pkg/workflowscan -run 'TestCorpus|TestRecount|TestSonnetPrompt|TestParseSonnetReply|TestValidate|TestGoal'`
  and see them fail.
- [ ] Implement until they pass.
- [ ] Write `liveprobe_test.go` behind `//go:build liveprobe`. It reads a store snapshot path from
  `WORKFLOWSCAN_STORE`, builds the corpus over 14 days, and asserts that every run matched by the spec's P2 regex has
  a block. Run it if you can make a snapshot of the packaged store (SQLite `VACUUM INTO` from
  `%LOCALAPPDATA%\dev.arc.app\data\db\waveterm.db`), and report the counts; otherwise say it was not run.
- [ ] Commit.

**Acceptance:** the `go test` line above passes; the liveprobe result, or why it did not run, is in the report.

### Task 3: The scan in wavesrv, and `wsh workflow`
**Depends on:** Task 1, Task 2 (calls `BuildCorpus`, `Recount`, `SonnetPrompt`, `ParseSonnetReply`, `Goal`, `ValidateVerdicts`, `ValidatePicks`)
**Files:** `pkg/wshrpc/wshserver/wshserver_workflowscan.go`, `pkg/wshrpc/wshserver/wshserver_workflowscan_test.go`, `pkg/wshrpc/wshserver/wshserver_runs.go`, `pkg/wstore/wstore_workflowscan.go`, `pkg/wstore/wstore_workflowscan_test.go`, `cmd/wsh/cmd/wshcmd-workflow.go`, `cmd/wsh/cmd/wshcmd-workflow_test.go`

Replace Task 1's stubs.

- `pkg/wstore/wstore_workflowscan.go`:
  - `GetRunsCreatedSince(ctx, sinceTs int64) ([]*waveobj.Run, error)`;
  - `QueryRunEventsSince(ctx, sinceTs int64, kinds []string) ([]waveobj.RunEvent, error)`, across all runs;
  - `GetNewestWorkflowScanRun(ctx) (*waveobj.Run, error)`, nil when none.
  These are pure reads; they go in their own file because Task 4 edits `wstore_channel.go`.
- `runProjectName(run *waveobj.Run, channels map[string]*waveobj.Channel) string` in the handler file applies the
  Global Constraints rule. It feeds each `workflowscan.RunInfo.Project` and the scan's own `WorkflowScan.Project`.
- Handlers:
  - **Start:**
    - Load the channel and create a quick run on the same internal path `CreateRunCommand` takes. Runtime is
      `claude`, model `opus`, the goal is `workflowscan.Goal(<project name>, windowDays)`.
    - The run carries `WorkflowScan{State: scanning, Stage: read, Project, WindowDays}` before its agent can call
      back: set it on the create path in `wshserver_runs.go`, not after the spawn.
    - Refuse a start, naming the run, while another scan in that channel is scanning, picking or applying and its
      run is neither done nor cancelled. A scan whose run ended mid-scan blocks nothing.
  - **Scan:**
    - Resolve the run from `ORef` with `jarvis.ResolveRunWorkerFromMeta`, and refuse a run with no `WorkflowScan`.
    - Then step through `read` → `patterns` → `recount` → `checking`, writing the stage and its counts to the run and
      sending the WaveObj update at each step.
    - At the `patterns` step, the Sonnet call runs in the scan run's `ProjectPath`, with a 15-minute context and a
      new uuid `--session-id`. That id is appended to the run's `ConsultSessions` with role
      `jarvis.UsageRole_WorkflowScan` before the call.
    - Survivors and under-floor rows go on the record, which is returned.
    - Any error sets `State` `failed` and `Error`, and is returned.
    - The model call is a package var, so tests script it and can read the spec and cwd it was given.
  - **Result:** `ValidateVerdicts`, store them, then `State` `picking`.
  - **Picks:** `ValidatePicks`, store them and set `applying`, then deliver the spec's line through
    `deliverAgentMessage` to the run's agent block. A delivery error comes back wrapped with the run id, after the
    store.
  - **Get:** as Task 1 describes.
- `wsh workflow`:
  - `scan [--window N] [--start]`. Without `--start` it calls `WorkflowScanCommand` with a 20-minute timeout and
    prints, for the agent, each survivor's id, title, fix target, runs and days, projects and quotes with run ids,
    then the under-floor rows. With `--start` it resolves the channel and workspace as `wsh runs start` does
    (`runsChannel`, `runsWorkspaceId`), calls Start and prints the run id.
  - `result <file>` reads `{"verdicts":[...]}` and sends it.
  - `picks` prints the stored picks as JSON with each suggestion's verdict beside it.

Not split into a store-and-plumbing task plus a scan task: the plan's longest chain is 3 either way (Task 1 → Task 5 →
Task 7), so the split would add a review and a merge and save no wall time.

- [ ] Write the failing tests:
  - `TestGetRunsCreatedSince`, `TestQueryRunEventsSince`, `TestGetNewestWorkflowScanRun`.
  - `TestRunProjectName`: the channel name, and the base name of the path when the channel is gone.
  - `TestWorkflowScanStages`: a scripted model reply and seeded runs and events reach `checking` with the counts and
    survivors. `ConsultSessions` holds the session, and the model call got the run's `ProjectPath` and a
    `--session-id`.
  - `TestWorkflowScanFailsOnBadReply`: state `failed`, the reason stored.
  - `TestWorkflowScanRefusesNonScanRun`.
  - `TestWorkflowScanStartRefusesWhileActive`.
  - `TestWorkflowScanStartIgnoresFinishedRuns`: a cancelled run left in `scanning`, and a done run left in `picking`,
    do not block a start.
  - `TestWorkflowScanResultSetsPicking`.
  - `TestWorkflowScanPicksDelivers`.
  - `TestWorkflowScanPicksStoredWhenDeliveryFails`.
  - `TestGetWorkflowScanNewest`.
  - `TestWorkflowPrintSurvivors`, in wsh, on the printed text.
- [ ] Run `go test ./pkg/wstore -run 'TestGetRunsCreatedSince|TestQueryRunEventsSince|TestGetNewestWorkflowScanRun'`,
  `go test ./pkg/wshrpc/wshserver -run 'TestWorkflowScan|TestGetWorkflowScan|TestRunProjectName'` and
  `go test ./cmd/wsh/cmd -run 'TestWorkflow'`, and see them fail.
- [ ] Implement until they pass. Commit.

**Acceptance:** the three `go test` lines above pass.

### Task 4: Usage attributes the Sonnet pass
**Depends on:** Task 1 (uses `Run.ConsultSessions` and `UsageRole_WorkflowScan`)
**Files:** `pkg/wstore/wstore_channel.go`, `pkg/wshrpc/wshserver/sessionruns.go`, `pkg/wshrpc/wshserver/usagesessions.go`, `pkg/wshrpc/wshserver/usagesessions_test.go`

- `GetRunsBySessionIds` also matches `$.consultsessions[*].sessionid`.
- `runsBySession` maps those ids to their run.
- `linkUsageSession` links such a session to its run as that run's work item (a quick scan run is its own item),
  with `Role` set from the matching `ConsultSession`.
- Nothing else changes for other sessions.

The By work row is proven by this Go test, not a scenario: a row needs a real transcript with usage under that
session id, which a fixture cannot make without a real model call.

- [ ] Write the failing test `TestUsageSessionsConsultSession`: a quick run with a `ConsultSessions` entry gives that
  session `RunId` of the run, `RunMode` `quick` and `Role` `workflow-scan`, and the run's own session keeps its
  existing link.
- [ ] Run `go test ./pkg/wshrpc/wshserver -run 'TestUsageSessions'` and see it fail; implement until it passes, with
  the existing `TestUsageSessions*` still passing. Commit.

**Acceptance:** `go test ./pkg/wshrpc/wshserver -run 'TestUsageSessions'` passes; the `usage-work` scenario still
passes in Final.

### Task 5: The Workflow lens
**Depends on:** Task 1 (uses the types, `usageLensAtom` `"workflow"`, `workflowScanRunAtom`, `startWorkflowScan`, the `workflowscan` target)
**Files:** `frontend/app/view/agents/workflowlens.ts`, `frontend/app/view/agents/workflowlens.test.ts`, `frontend/app/view/agents/workflowlens.tsx`, `frontend/app/view/agents/usagesurface.tsx`, `scripts/cdp/scenarios.mjs`

Usage gains a third lens, `Workflow`, after By provider and By work. Match `Main.dc.html` and `States.dc.html`.

**The model, `workflowlens.ts` (pure).** It exports:

- `workflowView(run: Run | null, picks: Record<string, PickDraft>): WorkflowView`, a discriminated union on `kind`:
  - `idle`, with `last?: {date, outcome: "cancelled" | "failed", error?}`. A cancelled run shows as idle whatever its
    `State`.
  - `scanning`, with `stages: {label, fact, phase: "done" | "now" | "todo"}[]`, the five rows of the Running board.
  - `picking`, with `cards`, `covered`, `declined` and `underFloor`.
  - `applying`.
  - `done`, with `commit?` and `rows: {tag: "applied" | "declined", title, file}[]`.
  - `nothing`, with `covered`, `declined` and `underFloor` counts and rows.
- `type PickDraft = {pick?: "apply" | "drop"; reason: string}`.
- A card holds title, runs, days, projects, `quotes`, `more`, `file`, `where`, `edit` lines, `raisedAgain?:
  {declinedAt, now}`, and `elsewhere?: string` (the fix project when it is not the scan's). `quotes` is the first 2,
  with the rest behind `more`.
- `ctaLabel(cards, picks): string`, as the board's `Apply 2, decline 1`, and `""` when nothing is picked.
- `canSend(cards, picks): boolean`, false while any Drop lacks a reason or nothing is picked.
- `picksPayload(cards, picks): WorkflowScanPick[]`.
- `copyText(card): string`, the text Copy for #project puts on the clipboard: the file, where, and the edit lines.
- `scanButton(view: WorkflowView, home: Channel | null): {enabled: boolean; channelId?: string; title: string}`. It
  is disabled while the view is `scanning`, `picking` or `applying`, and when there is no home project, with a title
  saying why.

**The view, `workflowlens.tsx`.**

- The header's `Scan workflow` button sits right of the lens switch, and the Idle state's big button is the same
  action. Both start a scan in the home project with `startWorkflowScan(model, channelId)`.
  - The home project is `palettePickChannel(activeChannel, projectRows, recentProjects[0] ?? null)` from
    `frontend/app/cockpit/palette-data.ts`, fed the same atoms `command-palette.tsx` feeds it. Reuse that function;
    do not write a second rule.
  - A start error shows inline beside the button.
- On mount, read `GetWorkflowScanCommand`, unless `workflowScanRunAtom` is already set. Follow the run object through
  the WaveObj hooks the cockpit uses for runs.
- Picking state:
  - Apply/Drop toggles, with a Reason input when Drop is picked.
  - Copy for #project replaces Apply on a card whose fix is in another project. It writes `copyText(card)` to the
    clipboard and shows `Copied` on the button.
  - The sticky primary button sends `WorkflowScanPicksCommand`; a send error shows inline under it.
- Run ids, Open run and Open in Diff go through `openTarget`. Open in Diff opens the scan run, whose evidence shows
  its commit.
- "Already covered ›" and "Under 3 runs ›" expand their rows in place.

**The scenario.** One new `workflow-scan` scenario in `scripts/cdp/scenarios.mjs`.

- Arrange it per `docs/reference/cdp-run-fixtures.md`: a temp-dir channel and a deferred quick run. Seed each state by
  writing the run's `workflowscan` (and its `status` for done and cancelled) through `waveService` `UpdateObject`,
  then a `setmeta` bump.
- Steps, each with a screenshot. "Header button" means the lens header's Scan workflow button.
  1. Idle, no scan: the big button and the `last 14 days · every project` line show, and the header button is
     enabled.
  2. Scanning, stage `recount`: the five stage rows with the recount row `now`; the header button is disabled.
  3. Picking with three suggestions, one raised again and one in another project, matching Main. The header button is
     disabled.
     - Click "Already covered ›", then "Under 3 runs ›": assert each one's rows appear, with a shot.
  4. Click Copy for #project on the other-project card and assert the button shows `Copied`. The copied text itself is
     proven by the `copyText` unit test, because clipboard reads are not reliable over CDP.
  5. Pick Drop on one card. Assert the reason field shows, and the button reads `Apply 1, decline 1` and stays disabled
     until a reason is typed.
  6. Send the picks. Assert on the record that the picks are stored and the state is `applying`. The delivery error
     that the fixture's missing agent causes shows inline. The header button stays disabled.
  7. Done, with a commit and three rows; the header button is enabled.
     - Click Open in Diff and assert the scan run opened (the surface and selection `openTarget` sets), then return to
       Usage › Workflow.
     - Click a quote's run id in a re-seeded picking state and assert that run opened.
  8. Nothing to suggest, with the Not raised list.
  9. A cancelled run left in `scanning` shows as idle with its `last:` line, and the header button is enabled.
  10. Failed, shown as idle with its `last:` line and the error.
- The scenario never clicks an enabled Scan workflow button: that launches a real Opus agent.
- Teardown with `teardownFixtureRun`.

- [ ] Write `workflowlens.test.ts`:
  - the state mapping for each record state and run status, a cancelled run in `scanning` included;
  - the stage phases for each `Stage`;
  - the first-2 quote cut and `more`;
  - `elsewhere` set only when `fixproject` differs from `scan.project`;
  - `ctaLabel` for 2 apply + 1 drop, only drops, and nothing;
  - `canSend` false with a reasonless Drop;
  - `picksPayload` leaving unpicked cards out;
  - `copyText`;
  - `scanButton`: enabled on idle, done, nothing and failed; disabled on scanning, picking and applying, and with no
    home channel.
- [ ] Run `npx vitest run frontend/app/view/agents/workflowlens.test.ts` and see it fail; implement the model until
  it passes.
- [ ] Build the view and the lens option; run `task check:ts`.
- [ ] Add the scenario. If a dev app is running, run `CDP_PORT=<port> task verify:ui -- workflow-scan`; otherwise say
  so and leave it to Final.
- [ ] Commit.

**Acceptance:** `npx vitest run frontend/app/view/agents/workflowlens.test.ts` passes; `task check:ts` exits 0;
the `workflow-scan` scenario's 10 steps are written and pass in Final.

### Task 6: The Needs you item (server)
**Depends on:** Task 1 (uses `Run.WorkflowScan`)
**Files:** `pkg/jarvis/attention.go`, `pkg/jarvis/attention_workflowscan_test.go`, `pkg/wshrpc/wshrpctypes_channels.go`

- `AttentionWorkflowScan = "workflow-scan"`.
- `BuildAttention` adds one item per run whose `WorkflowScan.State` is `picking` and whose status is neither done nor
  cancelled:
  - `Kind` `AttentionWorkflowScan`, `Key` `workflow-scan:<runid>`;
  - `RunId`, `ChannelId` and `ChannelName` from the run and its channel;
  - `ORef` `workflowscan:<runid>`, the address every surface opens it by;
  - `Action` `Decide`;
  - `Text` `<n> suggestions to decide`, where n is the `suggest` verdicts;
  - `Source` `Workflow scan`;
  - `WaitingSince` the run's `CreatedTs`;
  - `Why` `The scan's agent waits for your picks in Usage › Workflow.`
- It is ordered with the asks.
- Update the `ORef` field's comment in `wshrpctypes_channels.go`, which today says the server sets none.

- [ ] Write `TestAttentionWorkflowScan`. A picking run gives one item, and the test asserts `Kind`, `Key`, `RunId`,
  `ChannelId`, `ChannelName`, `ORef`, `Action` and `Text`. Scanning, applying, done and cancelled runs give none.
- [ ] Run `go test ./pkg/jarvis -run 'TestAttentionWorkflowScan|TestBuildAttention'`, see it fail, implement, pass.
  Commit.

**Acceptance:** `go test ./pkg/jarvis -run 'TestAttentionWorkflowScan|TestBuildAttention'` passes.

### Task 7: Ways in: palette, project action, Needs you everywhere
**Depends on:** Task 5 (shares `scripts/cdp/scenarios.mjs`), Task 6 (step 3 of its scenario needs the `workflow-scan` attention item Task 6 raises)
**Files:** `frontend/app/cockpit/palette-commands.ts`, `frontend/app/cockpit/palette-commands.test.ts`, `frontend/app/cockpit/palette-items.ts`, `frontend/app/cockpit/palette-needs.ts`, `frontend/app/cockpit/palette-needs.test.ts`, `frontend/app/cockpit/command-palette.tsx`, `frontend/app/cockpit/actions/project.ts`, `frontend/app/cockpit/actions/project.test.ts`, `frontend/app/view/jarvis/briefingmodel.ts`, `frontend/app/view/jarvis/briefingmodel.test.ts`, `frontend/app/view/agents/attentionpopuptarget.test.ts`, `scripts/cdp/scenarios.mjs`

Match `Palette.dc.html`.

- **Palette Start row:**
  - `StartId` gains `"scan"`, titled `Scan workflow`, with the Lucide `ScanSearch` icon.
  - The row's meta is `#<home project>`, from the palette's existing `homeChannel`.
  - The verb is `Start`, and the echo reads `Starts a scan, opens Usage › Workflow`.
  - It is absent when there is no home channel.
  - Running it calls `startWorkflowScan(model, homeChannel.oid)` and closes the palette; an error goes to
    `setPaletteError`.
- **Project action:** `channel:scan`, `Scan workflow`, group `steer`, placed after New run in it. It calls
  `startWorkflowScan(model, p.channel.oid)`, and an error is shown the way the other project actions show theirs.
- **Needs you, on every surface that lists it.** Each opens the item by its `oref` (`workflowscan:<runid>`) through
  `openTarget`:
  - Palette: `KIND_GROUP["workflow-scan"] = "reviews"` in `palette-needs.ts`; `NEEDS_STATUS` reads `workflow scan`;
    activating the row parses the item's oref and opens it.
  - Briefing: the kind label reads `workflow scan`, and a `workflow-scan` row's nav is `{kind: "oref", oref}`, not the
    channel-and-run nav other rows get.
  - Desktop popup: `popupTarget` already opens `item.oref` when it parses. Add the test that proves it, and change no
    code unless that test fails.
- **Scenario** `workflow-scan-entry` in `scripts/cdp/scenarios.mjs`, each step with a screenshot:
  1. Typing `scan` in the palette shows the Scan workflow row with `#<project>`, verb `Start` and its echo, matching
     the left panel.
  2. Projects › #fixture shows Scan workflow right after New run in it, matching the right panel.
  3. A fixture run seeded in `picking` puts a `workflow scan` row in the palette's Needs you scope. Activating it opens
     Usage with the Workflow lens pressed.
  4. The same seeded run shows a `workflow scan` row in the Brief's attention queue. Activating it opens Usage ›
     Workflow.
  Steps 1 and 2 never fire the row or the action, because that launches a real Opus agent; their start calls are
  unit-tested.

- [ ] Write the failing tests:
  - `palette-commands.test.ts`: the scan start item is present with a home channel and absent without one.
  - `actions/project.test.ts`: `channel:scan` is listed right after `channel:new-run`, and running it calls
    `startWorkflowScan` with the project's channel (mock the module).
  - `palette-needs.test.ts`: a `workflow-scan` item groups under reviews.
  - `briefingmodel.test.ts`: a `workflow-scan` item's row carries the `workflowscan:<id>` oref nav and the
    `workflow scan` label.
  - `attentionpopuptarget.test.ts`: a `workflow-scan` item opens `{kind: "workflowscan", runId}`.
- [ ] Run `npx vitest run frontend/app/cockpit/palette-commands.test.ts frontend/app/cockpit/actions/project.test.ts frontend/app/cockpit/palette-needs.test.ts frontend/app/view/jarvis/briefingmodel.test.ts frontend/app/view/agents/attentionpopuptarget.test.ts`,
  see the new ones fail, implement, pass.
- [ ] Add the scenario; run `task check:ts`. If a dev app is running, run
  `CDP_PORT=<port> task verify:ui -- workflow-scan-entry`.
- [ ] Commit.

**Acceptance:** the vitest line above passes; `task check:ts` exits 0; the `workflow-scan-entry` scenario's 4 steps
are written and pass in Final.
