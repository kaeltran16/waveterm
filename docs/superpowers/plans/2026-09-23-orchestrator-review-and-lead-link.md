# Orchestrator Review Loop and Lead-Worker Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `go test ./pkg/orchestrate/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/ ./cmd/wsh/cmd/ && npx vitest run frontend/app/view/agents frontend/app/view/orchestrate frontend/app/view/jarvis`

**Goal:** Every dag task's finished commit is judged by an independent reviewer before it lands, and the lead learns what each task did and can pass discoveries to later tasks.

**Architecture:** A new `reviewing` task state sits between a worker's `done` run and the task's `done`. The engine spawns a reviewer child run on the lead's route in the lane worktree. The reviewer's verdict command either lands the task, sends it back to a worker with the findings, or hands it to the lead after two failures. Passed reviews queue "quiet" lines that ride on the lead's next wake. New lead commands (`amend`, `tell`, `sendback` with guidance, `approve`) let the lead act on what it learns.

**Tech Stack:** Go (`pkg/orchestrate`, `pkg/wshrpc`, `cmd/wsh`), React 19 + TypeScript (`frontend/app/view/{agents,orchestrate,jarvis}`), vitest, Go `testing`.

**Spec:** `docs/superpowers/specs/2026-09-23-orchestrator-review-and-lead-link-design.md`

## Global Constraints

- Go is the source of truth for wire types. After changing a type in `pkg/waveobj` or `pkg/wshrpc`, run `task generate`; never hand-edit `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `frontend/app/store/services.ts`, `pkg/wshrpc/wshclient/wshclient.go`.
- Typecheck the frontend with `task check:ts` (~2 minutes; give it a 5-minute timeout). Never `npx tsc`: it stack-overflows on this repo.
- Colors come from existing `@theme` token classes (`text-warning`, `border-accent/60`, …). No raw hex/rgba, no new tokens.
- The tree is not formatter-clean. Check only the files you touched: `gofmt -l <files>`, `npx prettier --check <files>`. Never `--write` the tree, and never run prettier on `scripts/*.mjs`.
- Commits: run in-session, the feature lands as one commit at the end, after the user approves the files and message (`feat(orchestrate): …`). A worker run by the engine commits its own task, as its contract says. Never write `Co-Authored-By` or any attribution trailer.
- Comments explain why, never what, in the style of the surrounding file.

## Review Focus

- **A dag already running when this ships.** Tasks already `done` must stay done, not re-enter review. Task 1 pins it (`TestDeriveTaskStatesLeavesReviewStatesAlone` covers an already-done task).
- **A worker finishing before its evidence is sealed.** The seal runs off the completion RPC, so the reviewer would get no closing note. Review waits up to a minute for it. Task 3 pins it (`TestReviewWaitsForTheWorkersEvidence`).
- **A reviewer that can't start** (spawn error, bad route) must not park the task forever. Task 3 pins it (`TestReviewerThatCannotStartIsRetriedOnce`).
- **Cancelling a dag while a review runs** must stop the reviewer too. Task 3 pins it (`TestChildRunIDsIncludeReviewers`, `TestCancelGroupCancelsReviewStates` in Task 1).
- **Skipping or retrying a `review-failed` task** must not rewrite the worker's finished run to `cancelled` (`jarvis.CancelRun` accepts a done run). Task 4 pins it (`TestSkipAFailedReviewKeepsTheWorkersRun`, `TestRetryAfterAFailedReviewResetsTheRound`).

---

### Task 1: Review states and wire types

**Depends on:** none

**Files:**
- Modify: `pkg/waveobj/wtype.go` (TaskNode, after `MergeFailures`)
- Modify: `pkg/waveobj/runevent.go` (kind constants, after `RunEventKindMergeHeld`)
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (`CommandDagActionData`, `DagTaskDigest`)
- Modify: `pkg/orchestrate/dag.go` (states, verdicts, `taskInFlight`, `reviewState`, `enterReview`, `DeriveTaskStates`, `RecomputeDagStatus`, `NewTaskGroup`)
- Modify: `pkg/orchestrate/scheduler.go` (`NextToSpawn`, `CancelGroup`)
- Regenerate: `task generate`
- Test: `pkg/orchestrate/dag_test.go`, `pkg/orchestrate/scheduler_test.go`

**Interfaces:**
- Produces: `TaskState_Reviewing = "reviewing"`, `TaskState_ReviewFailed = "review-failed"`, `ReviewVerdict_Pass = "pass"`, `ReviewVerdict_Fail = "fail"`; `func taskInFlight(state string) bool`; `func reviewState(state string) bool`; `func enterReview(t *waveobj.TaskNode, worker *waveobj.Run)`.
- Produces TaskNode fields: `ReviewRunID string`, `ReviewSpawnedTs int64`, `ReviewRespawns int`, `ReviewRound int`, `ReviewVerdict string`, `ReviewNote string`, `ReviewDownstream string`, `ReviewBase string`, `ReviewCommit string`, `LeadGuidance string`, `LeadNotes []string`, `LeadTold []string`.
- Produces `CommandDagActionData.Downstream string`; `DagTaskDigest.{Result, ReviewVerdict, ReviewNote, ReviewDownstream string; ReviewRound int}`.
- Produces run event kinds: `RunEventKindTaskReviewStarted`, `RunEventKindTaskReviewPassed`, `RunEventKindTaskReviewFailed`, `RunEventKindReviewOverruled`, `RunEventKindTaskAmended`, `RunEventKindTaskLeadTold`.

- [ ] **Step 1: Add the TaskNode fields**

In `pkg/waveobj/wtype.go`, inside `type TaskNode struct`, directly after the `MergeFailures int` line, add:

```go
	// The review loop (spec 2026-09-23-orchestrator-review-and-lead-link): a worker's finished commit is judged
	// by a reviewer before the task counts as done. ReviewRunID is the reviewer's child run while the task is
	// reviewing, ReviewSpawnedTs when it was spawned (UnixMilli; the review timeout runs from it), and
	// ReviewRespawns how many of this round's reviewers were replaced after ending without a verdict.
	ReviewRunID     string `json:"reviewrunid,omitempty"`
	ReviewSpawnedTs int64  `json:"reviewspawnedts,omitempty"`
	ReviewRespawns  int    `json:"reviewrespawns,omitempty"`
	// ReviewRound counts failed reviews; at the limit the lead judges the task.
	ReviewRound int `json:"reviewround,omitempty"`
	// ReviewVerdict (pass | fail), ReviewNote (the summary, the findings, or why the review itself failed) and
	// ReviewDownstream (what later tasks must know, from a pass) are the latest review's outcome.
	ReviewVerdict    string `json:"reviewverdict,omitempty"`
	ReviewNote       string `json:"reviewnote,omitempty"`
	ReviewDownstream string `json:"reviewdownstream,omitempty"`
	// ReviewBase is the commit the task's first reviewed attempt started from, so a fix after a failed round
	// is judged together with the work it fixes; ReviewCommit is the worker commit the latest verdict judged.
	ReviewBase   string `json:"reviewbase,omitempty"`
	ReviewCommit string `json:"reviewcommit,omitempty"`
	// LeadGuidance is the lead's note for the attempt after a sendback, LeadNotes what the lead added with
	// `dag amend` before the task started, and LeadTold what the lead typed with `dag tell` that the scan
	// for the human's messages has not matched yet.
	LeadGuidance string   `json:"leadguidance,omitempty"`
	LeadNotes    []string `json:"leadnotes,omitempty"`
	LeadTold     []string `json:"leadtold,omitempty"`
```

- [ ] **Step 2: Add the run event kinds**

In `pkg/waveobj/runevent.go`, directly after the `RunEventKindMergeHeld = "merge-held"` line (inside the same `const (` block), add:

```go

	// the review loop and the lead's steering (spec 2026-09-23-orchestrator-review-and-lead-link):
	//   task-review-started  a reviewer was spawned for a finished task ("taskid", "runid")
	//   task-review-passed   "taskid", "note", "downstream"
	//   task-review-failed   "taskid", "note", "round", "final" (true when it went to the lead)
	//   review-overruled     the lead approved a task whose review failed ("taskid")
	//   task-amended         the lead added a note to a task not started yet ("taskid", "text")
	//   task-lead-told       the lead typed into a running worker or reviewer ("taskid", "text")
	RunEventKindTaskReviewStarted = "task-review-started"
	RunEventKindTaskReviewPassed  = "task-review-passed"
	RunEventKindTaskReviewFailed  = "task-review-failed"
	RunEventKindReviewOverruled   = "review-overruled"
	RunEventKindTaskAmended       = "task-amended"
	RunEventKindTaskLeadTold      = "task-lead-told"
```

- [ ] **Step 3: Extend the dag wire types**

In `pkg/wshrpc/wshrpctypes_dag.go`, replace `CommandDagActionData` with:

```go
type CommandDagActionData struct {
	ChannelId  string `json:"channelid"`
	RunId      string `json:"runid"`
	TaskId     string `json:"taskid"`
	Action     string `json:"action"`               // approve | sendback | retry | skip | escalate | cancel | forward | takeover | relaunch-lead | review-pass | review-fail | amend | tell
	Model      string `json:"model,omitempty"`      // escalate target model (exact id); required
	Runtime    string `json:"runtime,omitempty"`    // escalate target runtime; empty = task's current runtime
	Notes      string `json:"notes,omitempty"`      // forward: what the lead checked; review: summary or findings; amend: the note; tell: the text; sendback: guidance
	Downstream string `json:"downstream,omitempty"` // review-pass: what later tasks must know
}
```

In `DagTaskDigest`, change the `WaitReason` comment to `// none | dependency | parallelism | gate | ask | lead-ask | failure | merge | verify | review | cleanup | terminal`, and add these fields after `CleanupState`:

```go
	Result           string `json:"result,omitempty"`           // the worker's closing note, bounded
	ReviewVerdict    string `json:"reviewverdict,omitempty"`    // pass | fail: the latest review
	ReviewRound      int    `json:"reviewround,omitempty"`      // failed reviews so far
	ReviewNote       string `json:"reviewnote,omitempty"`       // the reviewer's summary or findings, or why the review failed
	ReviewDownstream string `json:"reviewdownstream,omitempty"` // what later tasks must know, from a pass
```

- [ ] **Step 4: Write the failing state tests**

Append to `pkg/orchestrate/dag_test.go`:

```go
func TestDeriveTaskStatesSendsACommittedFinishToReview(t *testing.T) {
	g := mustGroup(t, mkTasks())
	g.Tasks[0].State = TaskState_Running
	g.Tasks[0].RunID = "r-0"
	g.Tasks[0].ReviewRespawns = 1
	g.Tasks[0].ReviewVerdict = ReviewVerdict_Fail
	DeriveTaskStates(g, map[string]*waveobj.Run{"r-0": {ID: "r-0", Status: jarvis.RunStatus_Done, BaseCommit: "base0", EndCommit: "work1"}})
	got := g.Tasks[0]
	if got.State != TaskState_Reviewing {
		t.Fatalf("a finished worker with a commit must be reviewed, got %s", got.State)
	}
	if got.ReviewBase != "base0" || got.ReviewRespawns != 0 || got.ReviewVerdict != "" {
		t.Fatalf("entering review must reset the round's bookkeeping and keep the base: %+v", got)
	}
}

func TestDeriveTaskStatesKeepsTheFirstReviewBase(t *testing.T) {
	g := mustGroup(t, mkTasks())
	g.Tasks[0].State = TaskState_Running
	g.Tasks[0].RunID = "r-0"
	g.Tasks[0].ReviewBase = "first"
	DeriveTaskStates(g, map[string]*waveobj.Run{"r-0": {ID: "r-0", Status: jarvis.RunStatus_Done, BaseCommit: "fix-base", EndCommit: "fix1"}})
	if g.Tasks[0].ReviewBase != "first" {
		t.Fatalf("a later round must diff the whole task, got base %q", g.Tasks[0].ReviewBase)
	}
}

func TestDeriveTaskStatesDoneWithoutACommitSkipsReview(t *testing.T) {
	g := mustGroup(t, mkTasks())
	g.Tasks[0].State = TaskState_Running
	g.Tasks[0].RunID = "r-0"
	DeriveTaskStates(g, map[string]*waveobj.Run{"r-0": {ID: "r-0", Status: jarvis.RunStatus_Done}})
	if g.Tasks[0].State != TaskState_Done {
		t.Fatalf("nothing committed means nothing to review, got %s", g.Tasks[0].State)
	}
}

func TestDeriveTaskStatesLeavesReviewStatesAlone(t *testing.T) {
	for _, state := range []string{TaskState_Reviewing, TaskState_ReviewFailed, TaskState_Done} {
		g := mustGroup(t, mkTasks())
		g.Tasks[0].State = state
		g.Tasks[0].RunID = "r-0"
		DeriveTaskStates(g, map[string]*waveobj.Run{"r-0": {ID: "r-0", Status: jarvis.RunStatus_Done, EndCommit: "work1"}})
		if g.Tasks[0].State != state {
			t.Fatalf("a done worker run must not move a %s task, got %s", state, g.Tasks[0].State)
		}
	}
}

func TestReviewFailedBlocksTheDag(t *testing.T) {
	g := mustGroup(t, mkTasks())
	g.Tasks[0].State = TaskState_ReviewFailed
	RecomputeDagStatus(g)
	if g.Status != DagStatus_Blocked {
		t.Fatalf("a failed review waits on judgment like a failed task, got %s", g.Status)
	}
}

func TestNewTaskGroupRejectsReviewFields(t *testing.T) {
	tasks := []waveobj.TaskNode{{ID: "t-1", Label: "one", ReviewVerdict: ReviewVerdict_Pass}}
	if _, err := NewTaskGroup("run", "channel", "title", 1, true, tasks, 1, nil); err == nil {
		t.Fatal("caller-supplied review fields must be rejected")
	}
}
```

Append to `pkg/orchestrate/scheduler_test.go`:

```go
func TestNextToSpawnReviewingHoldsSlot(t *testing.T) {
	g := groupWith(TaskState_Done, TaskState_Reviewing)
	g.Parallelism = 1
	if got := NextToSpawn(g); len(got) != 0 {
		t.Fatalf("a reviewing task holds its slot, got %v", got)
	}
}

func TestReviewingTaskDoesNotSatisfyDependents(t *testing.T) {
	g := groupWith(TaskState_Done, TaskState_Reviewing, TaskState_Done)
	for _, id := range ReadyTasks(g) {
		if id == "t-3" {
			t.Fatal("t-3 depends on a task still under review")
		}
	}
}

func TestCancelGroupCancelsReviewStates(t *testing.T) {
	g := groupWith(TaskState_Done, TaskState_Reviewing, TaskState_ReviewFailed)
	CancelGroup(g)
	if g.Tasks[1].State != TaskState_Cancelled || g.Tasks[2].State != TaskState_Cancelled {
		t.Fatalf("cancel must end review states, got %s and %s", g.Tasks[1].State, g.Tasks[2].State)
	}
}
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `go test ./pkg/orchestrate/ -run "TestDeriveTaskStates|TestReviewFailedBlocksTheDag|TestNewTaskGroupRejectsReviewFields|TestNextToSpawnReviewingHoldsSlot|TestReviewingTaskDoesNotSatisfyDependents|TestCancelGroupCancelsReviewStates"`
Expected: FAIL to compile with `undefined: TaskState_Reviewing` (and `ReviewVerdict_Fail`, `TaskState_ReviewFailed`).

- [ ] **Step 6: Add the states and helpers to dag.go**

In `pkg/orchestrate/dag.go`, add two lines to the task-state `const (` block, after `TaskState_VerifyFailed`:

```go
	TaskState_Reviewing    = "reviewing"     // the worker finished with a commit; a reviewer is judging it against the task and spec
	TaskState_ReviewFailed = "review-failed" // review failed twice, or the reviewer could not do its job; the lead judges it
```

Directly after the `taskActive` function, add:

```go
// taskInFlight reports a task that still holds its parallelism slot and its lane: a live worker, or a finished
// worker's commit under review. taskActive is about the worker process alone, which a reviewing task no
// longer has.
func taskInFlight(state string) bool {
	return taskActive(state) || state == TaskState_Reviewing
}

// reviewState reports a state the review loop owns. The worker's done run would derive done and erase it.
func reviewState(state string) bool {
	return state == TaskState_Reviewing || state == TaskState_ReviewFailed
}

// Review verdicts a reviewer records with `wsh jarvis dag review`.
const (
	ReviewVerdict_Pass = "pass"
	ReviewVerdict_Fail = "fail"
)

// enterReview starts a finished worker's review round. The round before's reviewer bookkeeping is cleared; the
// base of the task's first reviewed attempt is kept, so every round diffs the whole task.
func enterReview(t *waveobj.TaskNode, worker *waveobj.Run) {
	t.State = TaskState_Reviewing
	t.ReviewRunID, t.ReviewSpawnedTs, t.ReviewRespawns = "", 0, 0
	t.ReviewVerdict, t.ReviewDownstream = "", ""
	if t.ReviewBase == "" {
		t.ReviewBase = worker.BaseCommit
	}
}
```

Replace the body of `DeriveTaskStates` with:

```go
func DeriveTaskStates(g *waveobj.TaskGroup, runs map[string]*waveobj.Run) {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.RunID == "" || landingState(t.State) || reviewState(t.State) {
			continue
		}
		r, ok := runs[t.RunID]
		if !ok {
			continue
		}
		switch r.Status {
		case jarvis.RunStatus_Done:
			// only a worker finishing now is reviewed: a task that was already done when review shipped stays done
			if taskActive(t.State) && r.EndCommit != "" {
				enterReview(t, r)
				continue
			}
			t.State = TaskState_Done
		case jarvis.RunStatus_Cancelled:
			t.State = TaskState_Cancelled
		case jarvis.RunStatus_Blocked:
			t.State = TaskState_Failed
		}
	}
}
```

In `RecomputeDagStatus`, change `case TaskState_Failed, TaskState_BlockedMerge, TaskState_VerifyFailed:` to:

```go
		case TaskState_Failed, TaskState_BlockedMerge, TaskState_VerifyFailed, TaskState_ReviewFailed:
```

In `NewTaskGroup`, inside the `for _, t := range tasks {` rejection loop, directly after the `Escalations` check, add:

```go
		if t.ReviewRunID != "" || t.ReviewSpawnedTs != 0 || t.ReviewRespawns != 0 || t.ReviewRound != 0 ||
			t.ReviewVerdict != "" || t.ReviewNote != "" || t.ReviewDownstream != "" || t.ReviewBase != "" || t.ReviewCommit != "" {
			return waveobj.TaskGroup{}, fmt.Errorf("task %q review fields must be empty", t.ID)
		}
		if t.LeadGuidance != "" || len(t.LeadNotes) != 0 || len(t.LeadTold) != 0 {
			return waveobj.TaskGroup{}, fmt.Errorf("task %q lead fields must be empty", t.ID)
		}
```

- [ ] **Step 7: Count reviewing tasks as busy and cancel review states**

In `pkg/orchestrate/scheduler.go` `NextToSpawn`, replace both occurrences of `if taskActive(g.Tasks[i].State) {` with `if taskInFlight(g.Tasks[i].State) {` (the busy count and the busy-lane map).

In `CancelGroup`, change `case TaskState_Running, TaskState_Stalled:` to:

```go
		case TaskState_Running, TaskState_Stalled, TaskState_Reviewing, TaskState_ReviewFailed:
```

- [ ] **Step 8: Regenerate bindings and run the tests**

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts` gains `reviewrunid?`, `reviewround?`, `reviewverdict?`, `reviewnote?`, `leadnotes?`, … on `TaskNode`, `downstream?` on `CommandDagActionData`, and `result?`, `review*?` on `DagTaskDigest`.

Run: `go test ./pkg/orchestrate/`
Expected: PASS (the whole package: existing tests complete workers without an `EndCommit`, so they still go straight to done).

- [ ] **Step 9: Check formatting of the touched files**

Run: `gofmt -l pkg/waveobj/wtype.go pkg/waveobj/runevent.go pkg/wshrpc/wshrpctypes_dag.go pkg/orchestrate/dag.go pkg/orchestrate/scheduler.go pkg/orchestrate/dag_test.go pkg/orchestrate/scheduler_test.go`
Expected: no output.

---

### Task 2: Quiet lines in the wake queue

**Depends on:** none

**Files:**
- Modify: `pkg/orchestrate/wake.go` (`runWake`, `PostQuiet`, `withQuiet`, `flushLocked`, `launchLocked`)
- Test: `pkg/orchestrate/wake_test.go`

**Interfaces:**
- Produces: `func PostQuiet(ctx context.Context, channelId, runId, line string)`. Quiet lines never flush on their own; the next wake or lead launch carries them under the heading `Since your last wake:`.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/orchestrate/wake_test.go`:

```go
func TestQuietLinesWaitForAWake(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	PostQuiet(ctx, wakeChannel, wakeRun, "t-1 passed review: adds fmtDate")
	if len(f.sends) != 0 {
		t.Fatalf("a quiet line must not wake the lead: %q", f.sends)
	}
	PostWake(ctx, wakeChannel, wakeRun, failedLine)
	want := "Since your last wake:\nt-1 passed review: adds fmtDate\n" + failedLine
	if len(f.sends) != 1 || f.sends[0] != want {
		t.Fatalf("the wake must carry the quiet lines first, got %q", f.sends)
	}
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	PostWake(ctx, wakeChannel, wakeRun, finishedLine)
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))
	if len(f.sends) != 2 || f.sends[1] != finishedLine {
		t.Fatalf("delivered quiet lines must not repeat, got %q", f.sends)
	}
}

func TestQuietLinesAloneLaunchNoLead(t *testing.T) {
	f := newFakeLead(t)
	f.state = leadState{NoLead: true}
	launched := stubLaunch(t)
	ctx := context.Background()
	PostQuiet(ctx, wakeChannel, wakeRun, "t-1 passed review: adds fmtDate")
	PostWake(ctx, wakeChannel, wakeRun, finishedLine)
	if len(*launched) != 0 {
		t.Fatalf("a clean finish with only quiet lines needs no lead, launched %q", *launched)
	}
}

func TestLaunchedLeadGetsTheQuietLines(t *testing.T) {
	f := newFakeLead(t)
	f.state = leadState{NoLead: true}
	launched := stubLaunch(t)
	ctx := context.Background()
	PostQuiet(ctx, wakeChannel, wakeRun, "t-1 passed review: adds fmtDate")
	PostWake(ctx, wakeChannel, wakeRun, failedLine)
	want := "Since your last wake:\nt-1 passed review: adds fmtDate\n" + failedLine
	if len(*launched) != 1 || (*launched)[0] != want {
		t.Fatalf("the first lead must learn what landed before it, got %q", *launched)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/orchestrate/ -run "TestQuietLines|TestLaunchedLeadGetsTheQuietLines"`
Expected: FAIL to compile with `undefined: PostQuiet`.

- [ ] **Step 3: Implement quiet lines**

In `pkg/orchestrate/wake.go`, add a field to `type runWake struct`, directly after `lines     []string`:

```go
	// quiet is what the lead should read that needs no judgment (a task passed review); it goes out ahead of
	// the next wake and never starts one
	quiet []string
```

After the `PostWake` function, add:

```go
// PostQuiet queues a line the lead should read but that needs no judgment: it rides on the next wake instead of
// costing the lead a turn of its own. A dead lead's are dropped; its replacement reads `dag status`.
func PostQuiet(ctx context.Context, channelId, runId, line string) {
	wakes.lock.Lock()
	defer wakes.lock.Unlock()
	rw := wakes.runLocked(channelId, runId)
	if rw.dead {
		return
	}
	rw.quiet = append(rw.quiet, line)
}

// withQuiet puts the queued quiet lines ahead of a wake's own lines, under one heading.
func withQuiet(quiet, lines []string) []string {
	if len(quiet) == 0 {
		return append([]string{}, lines...)
	}
	out := append([]string{"Since your last wake:"}, quiet...)
	return append(out, lines...)
}
```

In `flushLocked`, replace:

```go
	lines := append([]string{}, rw.lines...)
	if untold {
		lines = append(lines, questionsLine(asks))
	}
	text := strings.Join(lines, "\n")
	sendWakeFn(st.BlockId, text)
	rw.lines, rw.sentAt, rw.retried = nil, wakeNow(), false
```

with:

```go
	lines := withQuiet(rw.quiet, rw.lines)
	if untold {
		lines = append(lines, questionsLine(asks))
	}
	text := strings.Join(lines, "\n")
	sendWakeFn(st.BlockId, text)
	rw.lines, rw.quiet, rw.sentAt, rw.retried = nil, nil, wakeNow(), false
```

In `launchLocked`, replace:

```go
	if !untold && onlyRunFinished(rw.lines) {
		rw.lines, rw.handoff = nil, false
		return
	}
	lines := append([]string{}, rw.lines...)
```

with:

```go
	if !untold && onlyRunFinished(rw.lines) {
		rw.lines, rw.quiet, rw.handoff = nil, nil, false
		return
	}
	lines := withQuiet(rw.quiet, rw.lines)
	rw.quiet = nil
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/orchestrate/ -run "Wake|Quiet|Launch|Lead"`
Expected: PASS (the new tests and every existing wake test).

- [ ] **Step 5: Check formatting**

Run: `gofmt -l pkg/orchestrate/wake.go pkg/orchestrate/wake_test.go`
Expected: no output.

---

### Task 3: The review loop

**Depends on:** Task 1, Task 2

**Files:**
- Create: `pkg/orchestrate/review.go`
- Modify: `pkg/orchestrate/told.go` (`clipRunes`, `toldText`)
- Modify: `pkg/orchestrate/queue.go` (`reviewFailedWake`, `downstreamWake`)
- Modify: `pkg/orchestrate/engine.go` (`scheduleLocked`, `workerContract`, `taskPrompt`)
- Modify: `pkg/orchestrate/outcome.go` (`HandleChildOutcome`)
- Modify: `pkg/orchestrate/mutation.go` (`childRunIDs`)
- Test: `pkg/orchestrate/review_test.go` (create), `pkg/orchestrate/engine_test.go`

**Interfaces:**
- Consumes: Task 1's states, verdicts, `enterReview`, `taskInFlight`, TaskNode review fields, event kinds; Task 2's `PostQuiet`.
- Produces: `func RecordReviewVerdict(ctx context.Context, dagID, reviewerRunID, verdict, note, downstream string) error` (records only; the caller schedules); `func taskByReviewRunID(g *waveobj.TaskGroup, runID string) *waveobj.TaskNode`; `func clipRunes(s string, n int) string`; `func reviewFeedback(task *waveobj.TaskNode) string`; consts `MaxReviewRounds = 2`, `MaxReviewRespawns = 1`, `ReviewTimeout = 20 * time.Minute`, `MaxReviewNoteLen = 2000`; test seams `reviewTreeHead`, `resetReviewTree`.

- [ ] **Step 1: Write the failing prompt tests**

Append to `pkg/orchestrate/engine_test.go`:

```go
func TestWorkerContractNamesTheReviewerAndTheLead(t *testing.T) {
	c := workerContract(&waveobj.TaskGroup{}, &waveobj.TaskNode{ID: "t-1"}, "claude")
	for _, want := range []string{"A reviewer checks your commit against this task and the spec", "the lead reads your final message", "anything a later task must know"} {
		if !strings.Contains(c, want) {
			t.Fatalf("contract missing %q: %q", want, c)
		}
	}
}

func TestTaskPromptCarriesReviewFindingsAndGuidance(t *testing.T) {
	owner := jarvis.NewRun("owner", "ws-1", "/p", nil, jarvis.RunMode_Orchestrator, nil, 1)
	task := &waveobj.TaskNode{
		ID: "t-1", Label: "add fmtDate",
		ReviewVerdict: ReviewVerdict_Fail, ReviewCommit: "work111", ReviewNote: "misses the empty-input case",
		LeadGuidance: "reuse parseDate",
	}
	p := taskPrompt(&waveobj.TaskGroup{}, task, &owner, "claude", "")
	for _, want := range []string{
		"A reviewer rejected the previous attempt (commit work111): misses the empty-input case",
		"Fix these on top of that commit; don't restart.",
		"The lead's guidance: reuse parseDate",
	} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt missing %q: %q", want, p)
		}
	}
	passed := &waveobj.TaskNode{ID: "t-2", Label: "x", ReviewVerdict: ReviewVerdict_Pass, ReviewNote: "fine", ReviewCommit: "c"}
	if strings.Contains(taskPrompt(&waveobj.TaskGroup{}, passed, &owner, "claude", ""), "rejected") {
		t.Fatal("a passed review carries no findings")
	}
}
```

- [ ] **Step 2: Write the failing loop tests**

Create `pkg/orchestrate/review_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// seedReviewDag is a one-task dag whose worker has just finished with a commit: the state review starts from.
func seedReviewDag(t *testing.T) (context.Context, *waveobj.TaskGroup, waveobj.Run) {
	t.Helper()
	ctx, dag := seedPendingDag(t)
	worker := jarvis.NewRun("worker goal", "ws-1", t.TempDir(), nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	worker.Status = jarvis.RunStatus_Done
	worker.BaseCommit = "base000"
	worker.EndCommit = "work111"
	worker.DagORef = dag.OID
	if err := wstore.AppendRun(ctx, dag.ChannelId, worker); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].State = TaskState_Running
		g.Tasks[0].RunID = worker.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return ctx, dag, worker
}

// stubReviewTree scripts the lane tree's HEAD and counts the resets a moved HEAD triggers.
func stubReviewTree(t *testing.T, head string) *int {
	t.Helper()
	resets := 0
	oldHead, oldReset := reviewTreeHead, resetReviewTree
	reviewTreeHead = func(context.Context, string) (string, error) { return head, nil }
	resetReviewTree = func(context.Context, string, string) error { resets++; return nil }
	t.Cleanup(func() { reviewTreeHead, resetReviewTree = oldHead, oldReset })
	return &resets
}

type spawnCall struct {
	cap    runroute.Capability
	cwd    string
	prompt string
	opts   jarvis.RunWorkerOptions
}

// captureSpawns records every worker and reviewer the engine starts.
func captureSpawns(t *testing.T) *[]spawnCall {
	t.Helper()
	allowWorkerHarnessForTest(t)
	var calls []spawnCall
	old := spawnWorker
	spawnWorker = func(_ context.Context, cap runroute.Capability, _, _, cwd, prompt string, opts jarvis.RunWorkerOptions) (string, error) {
		calls = append(calls, spawnCall{cap: cap, cwd: cwd, prompt: prompt, opts: opts})
		return waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String(), nil
	}
	t.Cleanup(func() { spawnWorker = old })
	return &calls
}

func stubStopRunWorkers(t *testing.T) {
	t.Helper()
	old := stopRunWorkers
	stopRunWorkers = func(context.Context, *waveobj.Run) error { return nil }
	t.Cleanup(func() { stopRunWorkers = old })
}

func firstTask(t *testing.T, ctx context.Context, dagID string) waveobj.TaskNode {
	t.Helper()
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		t.Fatal(err)
	}
	return g.Tasks[0]
}

func schedule(t *testing.T, ctx context.Context, dagID string) {
	t.Helper()
	if err := Schedule(ctx, dagID); err != nil {
		t.Fatal(err)
	}
}

func endRun(t *testing.T, ctx context.Context, channelId, runID string) {
	t.Helper()
	if err := wstore.UpdateRun(ctx, channelId, runID, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Cancelled
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestFinishedWorkerIsReviewedBeforeItCountsAsDone(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	stubReviewTree(t, worker.EndCommit)
	calls := captureSpawns(t)
	schedule(t, ctx, dag.OID)
	task := firstTask(t, ctx, dag.OID)
	if task.State != TaskState_Reviewing || task.ReviewRunID == "" {
		t.Fatalf("want reviewing with a reviewer, got %s reviewer %q", task.State, task.ReviewRunID)
	}
	if len(*calls) != 1 {
		t.Fatalf("want one reviewer spawned, got %d", len(*calls))
	}
	p := (*calls)[0].prompt
	for _, want := range []string{"You are the reviewer for task t-0", "git diff base000..work111", "wsh jarvis dag review pass", "wsh jarvis dag review fail"} {
		if !strings.Contains(p, want) {
			t.Fatalf("reviewer prompt missing %q: %q", want, p)
		}
	}
	schedule(t, ctx, dag.OID)
	if len(*calls) != 1 {
		t.Fatalf("a second tick must not spawn another reviewer, got %d", len(*calls))
	}
}

func TestReviewerRunsOnTheLeadsRouteInTheLaneTree(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	if err := wstore.UpdateRun(ctx, dag.ChannelId, dag.RunID, func(r *waveobj.Run) error {
		r.Runtime, r.Model = "claude", "opus"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.WorkerRoute = &waveobj.RoutePin{Runtime: "claude", Model: "sonnet"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	stubReviewTree(t, worker.EndCommit)
	calls := captureSpawns(t)
	schedule(t, ctx, dag.OID)
	if len(*calls) != 1 {
		t.Fatalf("want one reviewer, got %d", len(*calls))
	}
	c := (*calls)[0]
	if c.cap.Model != "opus" || c.cwd != worker.ProjectPath || c.opts.Label != "review t-0" || c.opts.TaskId != "t-0" {
		t.Fatalf("reviewer must run on the lead's route in the lane tree, got model %q cwd %q opts %+v", c.cap.Model, c.cwd, c.opts)
	}
}

func TestReviewWaitsForTheWorkersEvidence(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	if err := wstore.UpdateRun(ctx, dag.ChannelId, worker.ID, func(r *waveobj.Run) error {
		r.Phases[0].DoneTs = time.Now().UnixMilli()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	stubReviewTree(t, worker.EndCommit)
	calls := captureSpawns(t)
	schedule(t, ctx, dag.OID)
	if len(*calls) != 0 {
		t.Fatal("a reviewer must wait for the worker's closing note while the seal is in flight")
	}
	if err := wstore.UpdateRun(ctx, dag.ChannelId, worker.ID, func(r *waveobj.Run) error {
		r.Evidence = &waveobj.RunEvidence{Summary: "Added fmtDate with tests."}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	schedule(t, ctx, dag.OID)
	if len(*calls) != 1 || !strings.Contains((*calls)[0].prompt, "The worker reported: Added fmtDate with tests.") {
		t.Fatalf("the reviewer must get the worker's note, got %d spawns", len(*calls))
	}
}

func TestReviewPassLandsTheTaskAndTellsTheLeadQuietly(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	stubReviewTree(t, worker.EndCommit)
	captureSpawns(t)
	f := newFakeLead(t)
	schedule(t, ctx, dag.OID)
	reviewer := firstTask(t, ctx, dag.OID).ReviewRunID
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Pass, "adds fmtDate with tests", ""); err != nil {
		t.Fatal(err)
	}
	schedule(t, ctx, dag.OID)
	if got := firstTask(t, ctx, dag.OID); got.State != TaskState_Done {
		t.Fatalf("a pass lands the task, got %s", got.State)
	}
	joined := strings.Join(f.sends, "\n")
	if !strings.Contains(joined, "Since your last wake:\nt-0 passed review: adds fmtDate with tests") {
		t.Fatalf("the run-finished wake must carry the quiet line, got %q", f.sends)
	}
	if f.countKind(waveobj.RunEventKindTaskReviewPassed) != 1 {
		t.Fatal("want one task-review-passed row")
	}
}

func TestReviewPassWithDownstreamWakesTheLead(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	stubReviewTree(t, worker.EndCommit)
	captureSpawns(t)
	f := newFakeLead(t)
	schedule(t, ctx, dag.OID)
	reviewer := firstTask(t, ctx, dag.OID).ReviewRunID
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Pass, "adds fmtDate", "fmtDate lives in\nutil/date.go"); err != nil {
		t.Fatal(err)
	}
	schedule(t, ctx, dag.OID)
	want := "wake: task t-0 passed review with a note for later tasks: fmtDate lives in util/date.go. wsh jarvis dag status"
	if !strings.Contains(strings.Join(f.sends, "\n"), want) {
		t.Fatalf("want the downstream wake %q, got %q", want, f.sends)
	}
}

func TestFirstFailedReviewSendsTheTaskBackWithFindings(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	stubReviewTree(t, worker.EndCommit)
	calls := captureSpawns(t)
	schedule(t, ctx, dag.OID)
	reviewer := firstTask(t, ctx, dag.OID).ReviewRunID
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Fail, "misses the empty-input case", ""); err != nil {
		t.Fatal(err)
	}
	schedule(t, ctx, dag.OID)
	task := firstTask(t, ctx, dag.OID)
	if task.State != TaskState_Running || task.ReviewRound != 1 || task.RunID == worker.ID {
		t.Fatalf("a first fail re-dispatches a worker, got state %s round %d run %q", task.State, task.ReviewRound, task.RunID)
	}
	if len(*calls) != 2 || !strings.Contains((*calls)[1].prompt, "A reviewer rejected the previous attempt (commit work111): misses the empty-input case") {
		t.Fatalf("the next worker must get the findings, got %d spawns", len(*calls))
	}
}

func TestSecondFailedReviewGoesToTheLead(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].ReviewRound = 1
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	stubReviewTree(t, worker.EndCommit)
	captureSpawns(t)
	f := newFakeLead(t)
	schedule(t, ctx, dag.OID)
	reviewer := firstTask(t, ctx, dag.OID).ReviewRunID
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Fail, "still misses it", ""); err != nil {
		t.Fatal(err)
	}
	schedule(t, ctx, dag.OID)
	task := firstTask(t, ctx, dag.OID)
	if task.State != TaskState_ReviewFailed || task.ReviewNote != "still misses it" || task.RunID != worker.ID {
		t.Fatalf("want review-failed keeping the findings and the worker run, got %+v", task)
	}
	if !strings.Contains(strings.Join(f.sends, "\n"), "wake: review failed for task t-0. wsh jarvis dag status") {
		t.Fatalf("the lead must be woken, got %q", f.sends)
	}
}

func TestVerdictsAreRefusedWhenTheyCannotApply(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	stubReviewTree(t, worker.EndCommit)
	captureSpawns(t)
	schedule(t, ctx, dag.OID)
	reviewer := firstTask(t, ctx, dag.OID).ReviewRunID
	cases := []struct{ name, run, verdict, note, downstream string }{
		{"not the reviewer", worker.ID, ReviewVerdict_Pass, "ok", ""},
		{"unknown verdict", reviewer, "maybe", "ok", ""},
		{"no note", reviewer, ReviewVerdict_Fail, "  ", ""},
		{"downstream on a fail", reviewer, ReviewVerdict_Fail, "bad", "later"},
	}
	for _, c := range cases {
		if err := RecordReviewVerdict(ctx, dag.OID, c.run, c.verdict, c.note, c.downstream); err == nil {
			t.Fatalf("%s: want an error", c.name)
		}
	}
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Pass, "ok", ""); err != nil {
		t.Fatal(err)
	}
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Fail, "changed my mind", ""); err == nil {
		t.Fatal("a second verdict must be refused")
	}
}

func TestReviewerThatEndsWithoutAVerdictIsReplacedOnce(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	stubReviewTree(t, worker.EndCommit)
	stubStopRunWorkers(t)
	calls := captureSpawns(t)
	schedule(t, ctx, dag.OID)
	endRun(t, ctx, dag.ChannelId, firstTask(t, ctx, dag.OID).ReviewRunID)
	schedule(t, ctx, dag.OID)
	task := firstTask(t, ctx, dag.OID)
	if len(*calls) != 2 || task.ReviewRespawns != 1 || task.State != TaskState_Reviewing {
		t.Fatalf("want one replacement reviewer, got %d spawns, %+v", len(*calls), task)
	}
	endRun(t, ctx, dag.ChannelId, task.ReviewRunID)
	schedule(t, ctx, dag.OID)
	task = firstTask(t, ctx, dag.OID)
	if task.State != TaskState_ReviewFailed || task.ReviewNote != "reviewer ended without a verdict" || len(*calls) != 2 {
		t.Fatalf("a second silent reviewer hands the task to the lead, got %+v after %d spawns", task, len(*calls))
	}
}

func TestReviewerThatCommittedIsOverruled(t *testing.T) {
	ctx, dag, _ := seedReviewDag(t)
	resets := stubReviewTree(t, "moved999")
	captureSpawns(t)
	schedule(t, ctx, dag.OID)
	reviewer := firstTask(t, ctx, dag.OID).ReviewRunID
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Pass, "looks fine", ""); err != nil {
		t.Fatal(err)
	}
	schedule(t, ctx, dag.OID)
	task := firstTask(t, ctx, dag.OID)
	if task.State != TaskState_ReviewFailed || !strings.Contains(task.ReviewNote, "reviewer modified the worktree") || *resets != 1 {
		t.Fatalf("a reviewer's commit discards its verdict and resets the tree, got %+v resets %d", task, *resets)
	}
}

func TestReviewerThatCannotStartIsRetriedOnce(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	stubReviewTree(t, worker.EndCommit)
	allowWorkerHarnessForTest(t)
	stubSpawnWorker(t, "", errors.New("no tab"))
	schedule(t, ctx, dag.OID)
	task := firstTask(t, ctx, dag.OID)
	if task.State != TaskState_Reviewing || task.ReviewRespawns != 1 {
		t.Fatalf("a failed spawn spends the round's one retry, got %+v", task)
	}
	schedule(t, ctx, dag.OID)
	task = firstTask(t, ctx, dag.OID)
	if task.State != TaskState_ReviewFailed || !strings.Contains(task.ReviewNote, "reviewer could not start: no tab") {
		t.Fatalf("want review-failed with the spawn error, got %+v", task)
	}
}

func TestChildRunIDsIncludeReviewers(t *testing.T) {
	g := &waveobj.TaskGroup{Tasks: []waveobj.TaskNode{{ID: "t-0", RunID: "worker", ReviewRunID: "reviewer"}}}
	got := strings.Join(childRunIDs(g), ",")
	if got != "worker,reviewer" {
		t.Fatalf("cancel must reach a live reviewer, got %q", got)
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `go test ./pkg/orchestrate/ -run "TestWorkerContractNamesTheReviewer|TestTaskPromptCarriesReviewFindings|Review|TestChildRunIDsIncludeReviewers"`
Expected: FAIL to compile with `undefined: reviewTreeHead` (and `RecordReviewVerdict`, `resetReviewTree`).

- [ ] **Step 4: Add `clipRunes` and route `toldText` through it**

In `pkg/orchestrate/told.go`, replace the `toldText` function with:

```go
func toldText(s string) string {
	return clipRunes(s, MaxToldLen)
}

// clipRunes bounds s to n runes, marking a cut with an ellipsis.
func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
```

- [ ] **Step 5: Add the wake lines**

In `pkg/orchestrate/queue.go`, directly after `verifyFailedWake`, add:

```go
// reviewFailedWake hands a task's failed review to the lead; the findings are in its status.
func reviewFailedWake(taskID string) string {
	return fmt.Sprintf("wake: review failed for task %s. wsh jarvis dag status", taskID)
}

// downstreamWake carries what a passed task's reviewer said later tasks must know. A wake is typed as one
// line, so the note is flattened.
func downstreamWake(taskID, note string) string {
	return fmt.Sprintf("wake: task %s passed review with a note for later tasks: %s. wsh jarvis dag status", taskID, strings.Join(strings.Fields(note), " "))
}
```

(`queue.go` already imports `fmt` and `strings`.)

- [ ] **Step 6: Create review.go**

Create `pkg/orchestrate/review.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	// MaxReviewRounds is how many failed reviews a task takes before the lead judges it: one round back to a
	// worker with the findings, then the lead.
	MaxReviewRounds = 2
	// MaxReviewRespawns is how many times a round's reviewer is replaced after ending without a verdict.
	MaxReviewRespawns = 1
	// ReviewTimeout bounds one reviewer. Reading a diff against its task takes minutes; one silent past this
	// is stuck whatever its process says.
	ReviewTimeout = 20 * time.Minute
	// MaxReviewNoteLen bounds a verdict's note in runes: it goes into a worker's prompt and the lead's status.
	MaxReviewNoteLen = 2000
	// reviewEvidenceWait is how long review waits for the worker's evidence seal, which runs off the completion
	// RPC and carries the worker's closing note: the one account of its work the reviewer gets.
	reviewEvidenceWait = time.Minute
)

// reviewTreeHead reads the lane tree's HEAD, and resetReviewTree moves the lane's branch back to the worker's
// commit. Vars so tests need no repo.
var reviewTreeHead = func(ctx context.Context, wt string) (string, error) {
	return git(ctx, wt, "rev-parse", "HEAD")
}

var resetReviewTree = func(ctx context.Context, wt, commit string) error {
	_, err := git(ctx, wt, "reset", "--hard", commit)
	return err
}

func taskByReviewRunID(g *waveobj.TaskGroup, runID string) *waveobj.TaskNode {
	for i := range g.Tasks {
		if g.Tasks[i].ReviewRunID != "" && g.Tasks[i].ReviewRunID == runID {
			return &g.Tasks[i]
		}
	}
	return nil
}

// advanceReviews moves every reviewing task one step: a recorded verdict is applied, a reviewer that ended
// without one is replaced once, and a task with no reviewer gets one. It runs in the tick, before the task-done
// accounting, so a pass is counted done in the tick that applies it.
func advanceReviews(ctx, spawnCtx context.Context, g *waveobj.TaskGroup, owner *waveobj.Run, runs map[string]*waveobj.Run, now int64, afterCommit *[]func()) {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State != TaskState_Reviewing {
			continue
		}
		worker := runs[t.RunID]
		if worker == nil {
			continue // unreadable this tick; the next one retries
		}
		if t.ReviewRunID != "" && t.ReviewVerdict != "" {
			applyReviewVerdict(ctx, g, t, worker, afterCommit)
			continue
		}
		if t.ReviewRunID != "" {
			reason := reviewerLost(ctx, g, t, now)
			if reason == "" {
				continue
			}
			stopReviewer(ctx, g, t.ReviewRunID, afterCommit)
			t.ReviewRunID = ""
			if !spendReviewRespawn(ctx, g, t, reason, afterCommit) {
				continue
			}
		}
		if worker.Evidence == nil && now-workerDoneTs(worker) < reviewEvidenceWait.Milliseconds() {
			continue
		}
		spawnReviewer(ctx, spawnCtx, g, t, owner, worker, now, afterCommit)
	}
}

// workerDoneTs is when the worker's run finished: its latest phase completion.
func workerDoneTs(run *waveobj.Run) int64 {
	var ts int64
	for _, p := range run.Phases {
		if p.DoneTs > ts {
			ts = p.DoneTs
		}
	}
	return ts
}

// spawnReviewer starts a task's reviewer in the worker's lane tree, on the lead's route: the model picked for
// judgment, and not the worker's own.
func spawnReviewer(ctx, spawnCtx context.Context, g *waveobj.TaskGroup, t *waveobj.TaskNode, owner, worker *waveobj.Run, now int64, afterCommit *[]func()) {
	pin := waveobj.RoutePin{Runtime: runroute.DefaultRuntime(owner.Runtime), Model: owner.Model}
	capability, err := runroute.Resolve(pin)
	if err == nil {
		err = validateWorkerHarness(pin.Runtime)
	}
	if err != nil {
		failReview(ctx, g, t, "reviewer could not start: "+err.Error(), afterCommit)
		return
	}
	prompt := reviewPrompt(g, t, worker)
	runID, sessionId := uuid.NewString(), uuid.NewString()
	oref, err := spawnWorker(spawnCtx, capability, owner.WorkspaceId, "", worker.ProjectPath, prompt,
		jarvis.RunWorkerOptions{SessionId: sessionId, RunId: runID, TaskId: t.ID, Label: "review " + t.ID})
	if err != nil {
		spendReviewRespawn(ctx, g, t, "reviewer could not start: "+err.Error(), afterCommit)
		return
	}
	child := childRunFromSpec(g, t, owner, pin, worker.ProjectPath, worker.EndCommit, prompt)
	child.ID = runID
	child.SessionId = sessionId
	for i := range child.Phases {
		if child.Phases[i].State == jarvis.PhaseState_Running {
			child.Phases[i].WorkerOrefs = []string{oref}
			break
		}
	}
	if err := appendChildRun(spawnCtx, g.ChannelId, child); err != nil {
		if serr := stopSpawnedWorker(spawnCtx, oref); serr != nil {
			log.Printf("dag %s task %s: stopping unrecorded reviewer %s: %v", g.OID, t.ID, oref, serr)
		}
		spendReviewRespawn(ctx, g, t, "recording the reviewer failed: "+err.Error(), afterCommit)
		return
	}
	runORef := waveobj.MakeORef(waveobj.OType_Run, runID).String()
	channelORef := waveobj.MakeORef(waveobj.OType_Channel, g.ChannelId).String()
	if err := stampSpawnedWorker(spawnCtx, oref, runORef, channelORef); err != nil {
		log.Printf("dag %s task %s: stamp reviewer %s: %v", g.OID, t.ID, oref, err)
	}
	t.ReviewRunID, t.ReviewSpawnedTs = runID, now
	taskID := t.ID
	*afterCommit = append(*afterCommit, func() {
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Run, runID))
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, g.ChannelId))
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskReviewStarted, nil, map[string]any{"taskid": taskID, "runid": runID})
	})
}

// reviewerLost says why a reviewer with no verdict is done for, or "" while it is still working.
func reviewerLost(ctx context.Context, g *waveobj.TaskGroup, t *waveobj.TaskNode, now int64) string {
	if now-t.ReviewSpawnedTs > ReviewTimeout.Milliseconds() {
		return fmt.Sprintf("reviewer gave no verdict within %s", ReviewTimeout)
	}
	run, err := wstore.GetRun(ctx, g.ChannelId, t.ReviewRunID)
	if err != nil {
		return "" // unreadable this tick; the timeout still bounds it
	}
	switch run.Status {
	case jarvis.RunStatus_Done, jarvis.RunStatus_Cancelled, jarvis.RunStatus_Blocked:
		return "reviewer ended without a verdict"
	}
	if workerControllerGone(ctx, run) {
		return "reviewer exited without a verdict"
	}
	return ""
}

// stopReviewer cancels a reviewer being replaced and stops its process once the tick commits. A reviewer
// that already finished keeps the status it finished with.
func stopReviewer(ctx context.Context, g *waveobj.TaskGroup, runID string, afterCommit *[]func()) {
	*afterCommit = append(*afterCommit, func() {
		if err := wstore.UpdateRun(ctx, g.ChannelId, runID, func(r *waveobj.Run) error {
			if r.Status == jarvis.RunStatus_Executing || r.Status == jarvis.RunStatus_Planning {
				*r = jarvis.CancelRun(*r)
			}
			return nil
		}); err != nil {
			log.Printf("dag %s: cancelling reviewer run %s: %v", g.OID, runID, err)
			return
		}
		run, err := wstore.GetRun(ctx, g.ChannelId, runID)
		if err != nil {
			return
		}
		if err := stopRunWorkers(ctx, run); err != nil {
			log.Printf("dag %s: stopping reviewer run %s: %v", g.OID, runID, err)
		}
	})
}

// spendReviewRespawn allows one more reviewer this round; past the limit the review fails for the lead with
// reason. It reports whether another reviewer may be spawned.
func spendReviewRespawn(ctx context.Context, g *waveobj.TaskGroup, t *waveobj.TaskNode, reason string, afterCommit *[]func()) bool {
	if t.ReviewRespawns >= MaxReviewRespawns {
		failReview(ctx, g, t, reason, afterCommit)
		return false
	}
	t.ReviewRespawns++
	return true
}

// applyReviewVerdict acts on a recorded verdict. The reviewer completes its own run after the verdict, so it
// is not stopped here.
func applyReviewVerdict(ctx context.Context, g *waveobj.TaskGroup, t *waveobj.TaskNode, worker *waveobj.Run, afterCommit *[]func()) {
	t.ReviewRunID = ""
	t.ReviewCommit = worker.EndCommit
	// a reviewer's commit would land with the lane; its uncommitted edits cannot, since a lane lands by squashing
	// its branch and the next dispatch rebuilds a dirty tree
	head, err := reviewTreeHead(ctx, worker.ProjectPath)
	if err != nil || head != worker.EndCommit {
		reason := "reviewer modified the worktree"
		if err != nil {
			reason = "reading the worktree after review: " + err.Error()
		} else if rerr := resetReviewTree(ctx, worker.ProjectPath, worker.EndCommit); rerr != nil {
			reason += "; resetting it failed: " + rerr.Error()
		}
		failReview(ctx, g, t, reason, afterCommit)
		return
	}
	taskID, note, downstream := t.ID, t.ReviewNote, t.ReviewDownstream
	if t.ReviewVerdict == ReviewVerdict_Pass {
		t.State = TaskState_Done
		t.LeadGuidance = ""
		*afterCommit = append(*afterCommit, func() {
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskReviewPassed, nil, map[string]any{"taskid": taskID, "note": note, "downstream": downstream})
			PostQuiet(ctx, g.ChannelId, g.RunID, fmt.Sprintf("%s passed review: %s", taskID, truncateNote(note, handoffMaxSummaryLen)))
			if downstream != "" {
				PostWake(ctx, g.ChannelId, g.RunID, downstreamWake(taskID, downstream))
			}
		})
		return
	}
	t.ReviewRound++
	if t.ReviewRound >= MaxReviewRounds {
		failReview(ctx, g, t, note, afterCommit)
		return
	}
	round := t.ReviewRound
	// back to a worker in the same lane tree, which still holds the rejected commit; taskPrompt carries the findings
	t.State = TaskState_Pending
	t.RunID = ""
	*afterCommit = append(*afterCommit, func() {
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskReviewFailed, nil, map[string]any{"taskid": taskID, "note": note, "round": round, "final": false})
	})
}

// failReview hands a task's review to the lead: failed rounds spent, or a reviewer that could not do its job.
// The worker's run stays on the task, so the lead's approve can land it as it is.
func failReview(ctx context.Context, g *waveobj.TaskGroup, t *waveobj.TaskNode, reason string, afterCommit *[]func()) {
	t.State = TaskState_ReviewFailed
	t.ReviewNote = reason
	taskID, round := t.ID, t.ReviewRound
	*afterCommit = append(*afterCommit, func() {
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskReviewFailed, nil, map[string]any{"taskid": taskID, "note": reason, "round": round, "final": true})
		PostWake(ctx, g.ChannelId, g.RunID, reviewFailedWake(taskID))
	})
}

// RecordReviewVerdict records a reviewer's verdict on the task it reviews. It does not schedule: the caller
// does, off the reviewer's RPC, because the tick that applies a fail can spawn the next worker.
func RecordReviewVerdict(ctx context.Context, dagID, reviewerRunID, verdict, note, downstream string) error {
	note, downstream = strings.TrimSpace(note), strings.TrimSpace(downstream)
	switch {
	case verdict != ReviewVerdict_Pass && verdict != ReviewVerdict_Fail:
		return fmt.Errorf("verdict must be %s or %s, got %q", ReviewVerdict_Pass, ReviewVerdict_Fail, verdict)
	case note == "":
		return fmt.Errorf("a %s verdict needs its note: the summary for a pass, the findings for a fail", verdict)
	case verdict == ReviewVerdict_Fail && downstream != "":
		return fmt.Errorf("--downstream goes with a pass; put what later tasks need in the findings")
	}
	return withDagMutation(dagID, func() error {
		g, err := wstore.GetDag(ctx, dagID)
		if err != nil {
			return fmt.Errorf("loading dag: %w", err)
		}
		t := taskByReviewRunID(g, reviewerRunID)
		if t == nil || t.State != TaskState_Reviewing {
			return fmt.Errorf("run %s is not reviewing a task of this dag", reviewerRunID)
		}
		if t.ReviewVerdict != "" {
			return fmt.Errorf("task %s already has a %s verdict", t.ID, t.ReviewVerdict)
		}
		t.ReviewVerdict = verdict
		t.ReviewNote = clipRunes(note, MaxReviewNoteLen)
		t.ReviewDownstream = clipRunes(downstream, MaxReviewNoteLen)
		g.UpdatedTs = time.Now().UnixMilli()
		if err := wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
			*cur = *g
			return nil
		}); err != nil {
			return err
		}
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
		return nil
	})
}

// reviewPrompt is a reviewer's whole brief: what the task asked for, where the spec and plan are, what the
// worker said it did, and the one diff to judge. It checks intent, not tests: Verify runs those at the merge.
func reviewPrompt(g *waveobj.TaskGroup, task *waveobj.TaskNode, worker *waveobj.Run) string {
	var b strings.Builder
	fmt.Fprintf(&b, "You are the reviewer for task %s", task.ID)
	if g.PlanPath != "" {
		fmt.Fprintf(&b, " of the plan at %s", g.PlanPath)
	}
	if g.SpecPath != "" {
		fmt.Fprintf(&b, " (spec: %s)", g.SpecPath)
	}
	b.WriteString(". A worker finished it; judge its change against what the task asked for before it lands.\n")
	fmt.Fprintf(&b, "The change: `git diff %s..%s` in this directory.\n", task.ReviewBase, worker.EndCommit)
	b.WriteString("Check it against the task below and the spec: every requirement met, nothing that contradicts the spec, no corners cut (stubs, skipped cases, weakened or deleted tests, TODOs), nothing outside the task's scope. The plan's Verify runs the tests after the merge, so don't run the full suite; run a focused test only to settle a doubt.\n")
	b.WriteString("Only read: never edit, stage or commit, and ask no questions, since nobody answers a reviewer.\n")
	b.WriteString("Finish with exactly one command, which ends your session:\n")
	b.WriteString("- `wsh jarvis dag review pass \"<one paragraph: what landed>\"`, adding `--downstream \"<what a later task must know>\"` when the change affects later tasks (a renamed API, a plan assumption that turned out wrong);\n")
	b.WriteString("- `wsh jarvis dag review fail \"<findings: each problem, where it is, and the fix>\"`.\n\n")
	if g.Preamble != "" {
		b.WriteString("The plan's header applies to every task:\n")
		b.WriteString(g.Preamble)
		b.WriteString("\n\n")
	}
	b.WriteString("The task:\n")
	goal := task.RunSpec.Goal
	if goal == "" {
		goal = task.Label
	}
	b.WriteString(goal)
	if task.Description != "" {
		b.WriteString("\n\n")
		b.WriteString(task.Description)
	}
	if worker.Evidence != nil {
		if note := truncateNote(worker.Evidence.Summary, handoffMaxSummaryLen); note != "" {
			fmt.Fprintf(&b, "\n\nThe worker reported: %s", note)
		}
	}
	return b.String()
}

// reviewFeedback is what a re-dispatched task is told about the attempt a reviewer rejected: the findings, and
// the lead's guidance when the lead sent it back. Empty for a task no reviewer has failed.
func reviewFeedback(task *waveobj.TaskNode) string {
	var parts []string
	if task.ReviewVerdict == ReviewVerdict_Fail && task.ReviewCommit != "" {
		parts = append(parts, fmt.Sprintf("A reviewer rejected the previous attempt (commit %s): %s\nFix these on top of that commit; don't restart.", task.ReviewCommit, task.ReviewNote))
	}
	if task.LeadGuidance != "" {
		parts = append(parts, "The lead's guidance: "+task.LeadGuidance)
	}
	return strings.Join(parts, "\n")
}
```

- [ ] **Step 7: Wire the loop into the tick**

In `pkg/orchestrate/engine.go` `scheduleLocked`, directly before the line `// child-done: record the task-done lifecycle boundary (task id + child run id). A done child is not`, add:

```go
	// review: apply verdicts, replace a reviewer that ended without one, spawn the missing ones. Before the
	// task-done accounting below, so a pass is counted done in the tick that applied it.
	advanceReviews(ctx, spawnCtx, g, owner, runs, now, &afterCommit)
```

In the same function, change `if t.State == TaskState_Done && t.RunID != "" && taskActive(prevStates[t.ID]) {` to:

```go
		if t.State == TaskState_Done && t.RunID != "" && taskInFlight(prevStates[t.ID]) {
```

and change `if !taskActive(prevStates[g.Tasks[i].ID]) || g.Tasks[i].State != TaskState_Done {` to:

```go
		if !taskInFlight(prevStates[g.Tasks[i].ID]) || g.Tasks[i].State != TaskState_Done {
```

- [ ] **Step 8: Tell workers about the reviewer, and re-dispatches about the findings**

In `workerContract`, replace:

```go
	fmt.Fprintf(&b, "The plan is approved: don't re-plan or pause for design approval. If a consequential decision isn't pinned, or the plan and the code disagree, ask once with %s and concrete options, then wait; the lead or the human answers.\n", jarvis.AskTool(runtime))
```

with:

```go
	fmt.Fprintf(&b, "The plan is approved: don't re-plan or pause for design approval. If a consequential decision isn't pinned, or the plan and the code disagree, ask once with %s and concrete options, then wait; the lead or the human answers.\n", jarvis.AskTool(runtime))
	b.WriteString("A reviewer checks your commit against this task and the spec before it lands, and the lead reads your final message: end with what you did, anything you did differently from the task and why, and anything a later task must know.\n")
```

In `taskPrompt`, replace:

```go
	if task.Description != "" {
		b.WriteString("\n\n")
		b.WriteString(task.Description)
	}
	if handoff != "" {
```

with:

```go
	if task.Description != "" {
		b.WriteString("\n\n")
		b.WriteString(task.Description)
	}
	if feedback := reviewFeedback(task); feedback != "" {
		b.WriteString("\n\n")
		b.WriteString(feedback)
	}
	if handoff != "" {
```

- [ ] **Step 9: Schedule on a reviewer's exit, and let cancel reach reviewers**

In `pkg/orchestrate/outcome.go` `HandleChildOutcome`, replace:

```go
		task := taskByRunID(g, run.ID)
		if task == nil || !taskActive(task.State) {
			return nil
		}
```

with:

```go
		task := taskByRunID(g, run.ID)
		if task == nil {
			// a reviewer's exit: judge now whether it left a verdict, not at the watchdog's next pass
			if taskByReviewRunID(g, run.ID) != nil {
				return scheduleLocked(context.WithoutCancel(ctx), g.OID)
			}
			return nil
		}
		if !taskActive(task.State) {
			return nil
		}
```

In `pkg/orchestrate/mutation.go`, replace the body of `childRunIDs` with:

```go
func childRunIDs(g *waveobj.TaskGroup) []string {
	var out []string
	for i := range g.Tasks {
		if g.Tasks[i].RunID != "" {
			out = append(out, g.Tasks[i].RunID)
		}
		// a live reviewer is a child too: cancelling the dag must stop it
		if g.Tasks[i].ReviewRunID != "" {
			out = append(out, g.Tasks[i].ReviewRunID)
		}
	}
	return out
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `go test ./pkg/orchestrate/`
Expected: PASS, the new review tests and the whole package.

- [ ] **Step 11: Check formatting**

Run: `gofmt -l pkg/orchestrate/review.go pkg/orchestrate/review_test.go pkg/orchestrate/told.go pkg/orchestrate/queue.go pkg/orchestrate/engine.go pkg/orchestrate/engine_test.go pkg/orchestrate/outcome.go pkg/orchestrate/mutation.go`
Expected: no output. `engine.go` and `mutation.go` may already be listed at HEAD (the tree isn't formatter-clean); for a listed file run `gofmt -d <file>` and confirm no hunk touches a line you changed. Don't use `git stash` for a baseline: other sessions edit this working tree.

---

### Task 4: Lead steering commands

**Depends on:** Task 3

**Files:**
- Create: `pkg/orchestrate/leadsteer.go`
- Modify: `pkg/orchestrate/mutation.go` (`applyActionLocked`, `escalationTarget`)
- Modify: `pkg/orchestrate/scheduler.go` (`SkipTask`)
- Modify: `pkg/orchestrate/queue.go` (`ForwardTask`)
- Modify: `pkg/orchestrate/engine.go` (`taskPrompt` lead notes, the told scan)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`DagActionCommand`)
- Test: `pkg/orchestrate/leadsteer_test.go` (create)

**Interfaces:**
- Consumes: Task 3's `RecordReviewVerdict`, `clipRunes`, `MaxReviewNoteLen`, `reviewFeedback`; Task 1's states and fields.
- Produces: `func AmendTask(ctx context.Context, dagID, taskID, note string) error`; `func TellTask(ctx context.Context, dagID, taskID, text string) error`; `func SendBack(ctx context.Context, dagID, taskID, guidance string) error`; `func takeLeadTold(t *waveobj.TaskNode, text string) bool`; test seam `var runBlockORefs = RunBlockORefs`. Server actions `review-pass`, `review-fail`, `amend`, `tell`, `sendback` (with guidance in `Notes`).

- [ ] **Step 1: Write the failing tests**

Create `pkg/orchestrate/leadsteer_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// seedReviewFailedDag is a task whose second review failed: the lead's to judge.
func seedReviewFailedDag(t *testing.T) (context.Context, *waveobj.TaskGroup, waveobj.Run) {
	t.Helper()
	ctx, dag, worker := seedReviewDag(t)
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		task := &g.Tasks[0]
		task.State = TaskState_ReviewFailed
		task.ReviewRound = MaxReviewRounds
		task.ReviewVerdict = ReviewVerdict_Fail
		task.ReviewNote = "misses the empty-input case"
		task.ReviewCommit = worker.EndCommit
		RecomputeDagStatus(g)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return ctx, dag, worker
}

// seedRunningTask is a task whose worker is still at work.
func seedRunningTask(t *testing.T) (context.Context, *waveobj.TaskGroup) {
	t.Helper()
	ctx, dag := seedPendingDag(t)
	worker := jarvis.NewRun("worker goal", "ws-1", t.TempDir(), nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	worker.DagORef = dag.OID
	if err := wstore.AppendRun(ctx, dag.ChannelId, worker); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].State = TaskState_Running
		g.Tasks[0].RunID = worker.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return ctx, dag
}

func TestApproveOverrulesAFailedReview(t *testing.T) {
	ctx, dag, _ := seedReviewFailedDag(t)
	f := newFakeLead(t)
	if err := ApplyAction(ctx, dag.OID, "t-0", "approve", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}
	if got := firstTask(t, ctx, dag.OID).State; got != TaskState_Done {
		t.Fatalf("approve lands the task as it is, got %s", got)
	}
	if f.countKind(waveobj.RunEventKindReviewOverruled) != 1 {
		t.Fatal("want one review-overruled row")
	}
}

func TestSendBackRunsAnotherRoundWithTheLeadsGuidance(t *testing.T) {
	ctx, dag, _ := seedReviewFailedDag(t)
	calls := captureSpawns(t)
	if err := SendBack(ctx, dag.OID, "t-0", "reuse parseDate"); err != nil {
		t.Fatal(err)
	}
	task := firstTask(t, ctx, dag.OID)
	if task.State != TaskState_Running || task.ReviewRound != MaxReviewRounds || task.LeadGuidance != "reuse parseDate" {
		t.Fatalf("sendback dispatches with the round kept, got %+v", task)
	}
	p := (*calls)[0].prompt
	for _, want := range []string{"misses the empty-input case", "The lead's guidance: reuse parseDate"} {
		if !strings.Contains(p, want) {
			t.Fatalf("worker prompt missing %q: %q", want, p)
		}
	}
}

func TestRetryAfterAFailedReviewResetsTheRound(t *testing.T) {
	ctx, dag, worker := seedReviewFailedDag(t)
	calls := captureSpawns(t)
	if err := ApplyAction(ctx, dag.OID, "t-0", "retry", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}
	task := firstTask(t, ctx, dag.OID)
	if task.State != TaskState_Running || task.ReviewRound != 0 || len(*calls) != 1 {
		t.Fatalf("retry starts the rounds over, got %+v after %d spawns", task, len(*calls))
	}
	run, err := wstore.GetRun(ctx, dag.ChannelId, worker.ID)
	if err != nil || run.Status != jarvis.RunStatus_Done {
		t.Fatalf("the rejected worker's run keeps its done status, got %v %v", run.Status, err)
	}
}

func TestSkipAFailedReviewKeepsTheWorkersRun(t *testing.T) {
	ctx, dag, worker := seedReviewFailedDag(t)
	if err := ApplyAction(ctx, dag.OID, "t-0", "skip", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}
	if got := firstTask(t, ctx, dag.OID).State; got != TaskState_Skipped {
		t.Fatalf("want skipped, got %s", got)
	}
	run, err := wstore.GetRun(ctx, dag.ChannelId, worker.ID)
	if err != nil || run.Status != jarvis.RunStatus_Done {
		t.Fatalf("skip must not rewrite a finished run, got %v %v", run.Status, err)
	}
}

func TestForwardAcceptsAFailedReview(t *testing.T) {
	ctx, dag, _ := seedReviewFailedDag(t)
	if err := ForwardTask(ctx, dag.OID, "t-0", "the reviewer and the spec disagree on empty input"); err != nil {
		t.Fatal(err)
	}
}

func TestAmendReachesOnlyATaskNotStarted(t *testing.T) {
	ctx, dag := seedPendingDag(t)
	f := newFakeLead(t)
	if err := AmendTask(ctx, dag.OID, "t-0", "fmtDate moved to util/date.go"); err != nil {
		t.Fatal(err)
	}
	if got := firstTask(t, ctx, dag.OID).LeadNotes; len(got) != 1 || got[0] != "fmtDate moved to util/date.go" {
		t.Fatalf("want the note kept, got %q", got)
	}
	if f.countKind(waveobj.RunEventKindTaskAmended) != 1 {
		t.Fatal("want one task-amended row")
	}
	ctx2, running := seedRunningTask(t)
	err := AmendTask(ctx2, running.OID, "t-0", "too late")
	if err == nil || !strings.Contains(err.Error(), "dag tell") {
		t.Fatalf("amending a running task must point at tell, got %v", err)
	}
}

func TestTellTypesIntoTheRunningWorker(t *testing.T) {
	ctx, dag := seedRunningTask(t)
	f := newFakeLead(t)
	old := runBlockORefs
	runBlockORefs = func(context.Context, *waveobj.Run) []string {
		return []string{waveobj.MakeORef(waveobj.OType_Block, wakeLeadBlock).String()}
	}
	t.Cleanup(func() { runBlockORefs = old })
	if err := TellTask(ctx, dag.OID, "t-0", "use fmtDate from t-1"); err != nil {
		t.Fatal(err)
	}
	if len(f.sends) != 1 || f.sends[0] != "use fmtDate from t-1" {
		t.Fatalf("want the text typed into the worker, got %q", f.sends)
	}
	if got := firstTask(t, ctx, dag.OID).LeadTold; len(got) != 1 {
		t.Fatalf("the text must wait for the told scan, got %q", got)
	}
	if f.countKind(waveobj.RunEventKindTaskLeadTold) != 1 {
		t.Fatal("want one task-lead-told row")
	}
}

func TestTellRefusesATaskNotRunning(t *testing.T) {
	ctx, dag := seedPendingDag(t)
	err := TellTask(ctx, dag.OID, "t-0", "hello")
	if err == nil || !strings.Contains(err.Error(), "dag amend") {
		t.Fatalf("telling a task not started must point at amend, got %v", err)
	}
}

func TestTakeLeadToldConsumesTheLeadsText(t *testing.T) {
	task := &waveobj.TaskNode{LeadTold: []string{"use fmtDate"}}
	if !takeLeadTold(task, " use fmtDate \n") || len(task.LeadTold) != 0 {
		t.Fatalf("the lead's text must be matched once, left %q", task.LeadTold)
	}
	if takeLeadTold(task, "use fmtDate") {
		t.Fatal("a second identical message is the human's")
	}
}

func TestTaskPromptCarriesLeadNotes(t *testing.T) {
	owner := jarvis.NewRun("owner", "ws-1", "/p", nil, jarvis.RunMode_Orchestrator, nil, 1)
	task := &waveobj.TaskNode{ID: "t-2", Label: "use fmtDate", LeadNotes: []string{"fmtDate moved to util/date.go"}}
	p := taskPrompt(&waveobj.TaskGroup{}, task, &owner, "claude", "")
	if !strings.Contains(p, "The lead added after earlier tasks landed:\n- fmtDate moved to util/date.go") {
		t.Fatalf("prompt missing the lead's note: %q", p)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/orchestrate/ -run "Approve|SendBack|AfterAFailedReview|FailedReview|Amend|Tell|TakeLeadTold|LeadNotes"`
Expected: FAIL to compile with `undefined: SendBack` (and `AmendTask`, `TellTask`, `runBlockORefs`, `takeLeadTold`).

- [ ] **Step 3: Create leadsteer.go**

Create `pkg/orchestrate/leadsteer.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// runBlockORefs is RunBlockORefs, a var so tests need no live tab.
var runBlockORefs = RunBlockORefs

func reviewFailed(g *waveobj.TaskGroup, taskID string) bool {
	t := taskByID(g, taskID)
	return t != nil && t.State == TaskState_ReviewFailed
}

func persistDag(ctx context.Context, g *waveobj.TaskGroup) error {
	g.UpdatedTs = time.Now().UnixMilli()
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	return nil
}

// AmendTask adds the lead's note to a task that has not started, carried into its worker's prompt. It is how
// the lead passes on what an earlier task found without re-planning; a started task is reached with TellTask.
func AmendTask(ctx context.Context, dagID, taskID, note string) error {
	note = strings.TrimSpace(note)
	if note == "" {
		return fmt.Errorf("amend needs the note to add")
	}
	var g *waveobj.TaskGroup
	err := withDagMutation(dagID, func() error {
		var err error
		if g, err = wstore.GetDag(ctx, dagID); err != nil {
			return fmt.Errorf("loading dag: %w", err)
		}
		task := taskByID(g, taskID)
		if task == nil {
			return fmt.Errorf("no task %q", taskID)
		}
		if task.State != TaskState_Pending && task.State != TaskState_Ready {
			return fmt.Errorf("task %s is %s: amend reaches only a task that has not started; use dag tell for a running one", taskID, task.State)
		}
		task.LeadNotes = append(task.LeadNotes, toldText(note))
		return persistDag(ctx, g)
	})
	if err != nil {
		return err
	}
	appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskAmended, nil, map[string]any{"taskid": taskID, "text": toldText(note)})
	return nil
}

// TellTask types the lead's message into a running worker's or reviewer's terminal, the way the human can. The
// text stays on the task until the scan for what the human typed matches it, so it is never recorded as theirs.
func TellTask(ctx context.Context, dagID, taskID, text string) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return fmt.Errorf("tell needs the text to send")
	}
	var g *waveobj.TaskGroup
	var blockId string
	err := withDagMutation(dagID, func() error {
		var err error
		if g, err = wstore.GetDag(ctx, dagID); err != nil {
			return fmt.Errorf("loading dag: %w", err)
		}
		task := taskByID(g, taskID)
		if task == nil {
			return fmt.Errorf("no task %q", taskID)
		}
		runID := ""
		switch task.State {
		case TaskState_Running, TaskState_Stalled:
			runID = task.RunID
		case TaskState_Reviewing:
			runID = task.ReviewRunID
		}
		if runID == "" {
			return fmt.Errorf("task %s is %s: tell reaches only a running worker or reviewer; use dag amend for a task that has not started", taskID, task.State)
		}
		run, err := wstore.GetRun(ctx, g.ChannelId, runID)
		if err != nil {
			return fmt.Errorf("loading run %s: %w", runID, err)
		}
		blocks := runBlockORefs(ctx, run)
		if len(blocks) == 0 {
			return fmt.Errorf("task %s has no live terminal to type into", taskID)
		}
		ref, err := waveobj.ParseORef(blocks[0])
		if err != nil {
			return fmt.Errorf("task %s terminal %q: %w", taskID, blocks[0], err)
		}
		blockId = ref.OID
		task.LeadTold = append(task.LeadTold, text)
		return persistDag(ctx, g)
	})
	if err != nil {
		return err
	}
	sendWakeFn(blockId, text)
	appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskLeadTold, nil, map[string]any{"taskid": taskID, "text": toldText(text)})
	return nil
}

// takeLeadTold consumes a message the lead typed with TellTask, so the told scan does not record the lead's own
// words as the human's.
func takeLeadTold(t *waveobj.TaskNode, text string) bool {
	want := strings.TrimSpace(text)
	for i, s := range t.LeadTold {
		if strings.TrimSpace(s) == want {
			t.LeadTold = append(t.LeadTold[:i], t.LeadTold[i+1:]...)
			return true
		}
	}
	return false
}

// SendBack returns a task to a worker. A task whose review failed gets one more round, with the lead's guidance
// beside the reviewer's findings; ReviewRound is kept, so a further fail comes straight back to the lead. Any
// other task takes the old plan-gate sendback, which has no guidance.
func SendBack(ctx context.Context, dagID, taskID, guidance string) error {
	err := withDagMutation(dagID, func() error {
		g, err := wstore.GetDag(ctx, dagID)
		if err != nil {
			return fmt.Errorf("loading dag: %w", err)
		}
		if !reviewFailed(g, taskID) {
			return applyActionLocked(ctx, dagID, taskID, "sendback", waveobj.RoutePin{})
		}
		task := taskByID(g, taskID)
		task.LeadGuidance = clipRunes(strings.TrimSpace(guidance), MaxReviewNoteLen)
		task.State = TaskState_Pending
		task.RunID = ""
		RecomputeDagStatus(g)
		return persistDag(ctx, g)
	})
	if err != nil {
		return err
	}
	return Schedule(ctx, dagID)
}
```

- [ ] **Step 4: Route approve, skip, retry and escalate for a failed review**

In `pkg/orchestrate/mutation.go` `applyActionLocked`, add `var emit []func()` directly after the `if g.Status == DagStatus_Cancelled { … }` block, then replace the `case "approve":` block:

```go
	case "approve":
		g2, err := ApproveGate(g, taskID)
		if err != nil {
			return err
		}
		g = g2
```

with:

```go
	case "approve":
		if reviewFailed(g, taskID) {
			// the lead overrules the reviewer: the worker's commit lands as it is
			taskByID(g, taskID).State = TaskState_Done
			emit = append(emit, func() {
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindReviewOverruled, nil, map[string]any{"taskid": taskID})
			})
		} else {
			g2, err := ApproveGate(g, taskID)
			if err != nil {
				return err
			}
			g = g2
		}
```

In `case "skip":`, replace:

```go
		if task.State != TaskState_Failed && task.State != TaskState_Stalled && task.State != TaskState_Ready {
			return fmt.Errorf("task %q cannot be skipped from state %q", taskID, task.State)
		}
		if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
			return err
		}
```

with:

```go
		if task.State != TaskState_Failed && task.State != TaskState_Stalled && task.State != TaskState_Ready && task.State != TaskState_ReviewFailed {
			return fmt.Errorf("task %q cannot be skipped from state %q", taskID, task.State)
		}
		// a failed review's worker already finished: cancelling its run would rewrite a done run
		if task.State != TaskState_ReviewFailed {
			if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
				return err
			}
		}
```

Replace the `case "retry":` block:

```go
	case "retry":
		if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
			return err
		}
		if err := RetryTask(g, taskID); err != nil {
			return err
		}
```

with:

```go
	case "retry":
		if reviewFailed(g, taskID) {
			// the rounds start over from the findings; the worker's run already finished
			taskByID(g, taskID).ReviewRound = 0
		} else if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
			return err
		}
		if err := RetryTask(g, taskID); err != nil {
			return err
		}
```

In `case "escalate":`, replace:

```go
		if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
			return err
		}
		applyEscalation(task, target)
```

with:

```go
		if task.State == TaskState_ReviewFailed {
			task.ReviewRound = 0
		} else if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
			return err
		}
		applyEscalation(task, target)
```

At the end of `applyActionLocked`, replace:

```go
	g.Failures = 0
	RecomputeDagStatus(g)
	g.UpdatedTs = time.Now().UnixMilli()
	if err := wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	return nil
}
```

with:

```go
	g.Failures = 0
	RecomputeDagStatus(g)
	g.UpdatedTs = time.Now().UnixMilli()
	if err := wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	for _, fn := range emit {
		fn()
	}
	return nil
}
```

In `pkg/orchestrate/scheduler.go` `SkipTask`, change:

```go
		if g.Tasks[i].State != TaskState_Failed && g.Tasks[i].State != TaskState_Stalled && g.Tasks[i].State != TaskState_Ready {
```

to:

```go
		if g.Tasks[i].State != TaskState_Failed && g.Tasks[i].State != TaskState_Stalled && g.Tasks[i].State != TaskState_Ready && g.Tasks[i].State != TaskState_ReviewFailed {
```

In `escalationTarget`, change:

```go
	if task.State != TaskState_Failed && task.State != TaskState_Stalled && task.State != TaskState_BlockedMerge {
```

to:

```go
	if task.State != TaskState_Failed && task.State != TaskState_Stalled && task.State != TaskState_BlockedMerge && task.State != TaskState_ReviewFailed {
```

In `pkg/orchestrate/queue.go` `ForwardTask`, change `case TaskState_Failed, TaskState_Stalled, TaskState_BlockedMerge, TaskState_VerifyFailed:` to:

```go
	case TaskState_Failed, TaskState_Stalled, TaskState_BlockedMerge, TaskState_VerifyFailed, TaskState_ReviewFailed:
```

and change its error text `"task %s has no question, failure, stall, merge conflict or failed Verify to forward (state %q)"` to `"task %s has no question, failure, stall, merge conflict, failed Verify or failed review to forward (state %q)"`.

- [ ] **Step 5: Render lead notes, and skip the lead's text in the told scan**

In `pkg/orchestrate/engine.go` `taskPrompt`, replace:

```go
	if feedback := reviewFeedback(task); feedback != "" {
```

with:

```go
	if len(task.LeadNotes) > 0 {
		b.WriteString("\n\nThe lead added after earlier tasks landed:")
		for _, n := range task.LeadNotes {
			fmt.Fprintf(&b, "\n- %s", n)
		}
	}
	if feedback := reviewFeedback(task); feedback != "" {
```

In `scheduleLocked`'s told scan, replace:

```go
				// an answer to the worker's prose question was typed for whoever answered it, and its ask rows say who
				if agentask.GlobalRegistry.TakeTypedAnswer(g.OID, t.ID, p.Text, p.Ts) {
```

with:

```go
				// the lead's own `dag tell`, which the transcript shows as typed input
				if takeLeadTold(t, p.Text) {
					continue
				}
				// an answer to the worker's prose question was typed for whoever answered it, and its ask rows say who
				if agentask.GlobalRegistry.TakeTypedAnswer(g.OID, t.ID, p.Text, p.Ts) {
```

- [ ] **Step 6: Route the new actions in the server**

In `pkg/wshrpc/wshserver/wshserver_dag.go` `DagActionCommand`, replace:

```go
	case "relaunch-lead":
		return orchestrate.RelaunchLead(ctx, data.ChannelId, data.RunId)
	}
```

with:

```go
	case "relaunch-lead":
		return orchestrate.RelaunchLead(ctx, data.ChannelId, data.RunId)
	case "review-pass", "review-fail":
		// RunId is the reviewer's own run: `dag review` resolves it from the reviewer's terminal
		verdict := strings.TrimPrefix(data.Action, "review-")
		if err := orchestrate.RecordReviewVerdict(ctx, run.DagORef, data.RunId, verdict, data.Notes, data.Downstream); err != nil {
			return err
		}
		// the verdict is durable; the tick that applies it can spawn a worker, which outlasts the reviewer's RPC budget
		dagID := run.DagORef
		go func() {
			if err := orchestrate.Schedule(context.Background(), dagID); err != nil {
				log.Printf("dag schedule after review verdict: %v", err)
			}
		}()
		return nil
	case "amend":
		return orchestrate.AmendTask(ctx, run.DagORef, data.TaskId, data.Notes)
	case "tell":
		return orchestrate.TellTask(ctx, run.DagORef, data.TaskId, data.Notes)
	case "sendback":
		return orchestrate.SendBack(ctx, run.DagORef, data.TaskId, data.Notes)
	}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `go test ./pkg/orchestrate/ ./pkg/wshrpc/wshserver/`
Expected: PASS.

- [ ] **Step 8: Check formatting**

Run: `gofmt -l pkg/orchestrate/leadsteer.go pkg/orchestrate/leadsteer_test.go pkg/orchestrate/mutation.go pkg/orchestrate/queue.go pkg/orchestrate/engine.go pkg/wshrpc/wshserver/wshserver_dag.go`
Expected: no output; for a file already listed at HEAD, `gofmt -d <file>` shows no hunk on a line you changed.

---

### Task 5: The lead's view: digest, CLI and rules

**Depends on:** Task 4

**Files:**
- Modify: `pkg/orchestrate/digest.go`
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go`
- Modify: `pkg/jarvis/leadprompt.go`
- Test: `pkg/orchestrate/digest_test.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`, `pkg/jarvis/leadprompt_test.go`

**Interfaces:**
- Consumes: Task 1's digest fields and states; Task 4's server actions `review-pass`, `review-fail`, `amend`, `tell`, `sendback`.
- Produces: `digestActionReviewFailed = []string{"approve", "sendback", "retry", "skip", "escalate"}`; CLI commands `dag review <pass|fail> <note> [--downstream]`, `dag amend <task> <note>`, `dag tell <task> <text>`, `dag sendback <task> [guidance]`; `func dagReviewData(cmd *cobra.Command, args []string) (wshrpc.CommandDagActionData, error)`; `func dagNoteData(cmd *cobra.Command, action string, args []string) (wshrpc.CommandDagActionData, error)`.

- [ ] **Step 1: Write the failing digest tests**

Append to `pkg/orchestrate/digest_test.go` (add `"strings"` to its imports if missing):

```go
func TestDigestCarriesTheWorkersResultAndReview(t *testing.T) {
	g := digestGroup(t, false, []waveobj.TaskNode{{ID: "t-1", Label: "a"}})
	g.Tasks[0].State = TaskState_Done
	g.Tasks[0].RunID = "run-1"
	g.Tasks[0].ReviewVerdict = ReviewVerdict_Pass
	g.Tasks[0].ReviewNote = "adds fmtDate"
	g.Tasks[0].ReviewDownstream = "fmtDate lives in util/date.go"
	run := childRun("run-1", nil)
	run.Evidence = &waveobj.RunEvidence{Summary: "Added fmtDate and its tests."}
	d := BuildDigest(digestSnapshot(g, []*waveobj.Run{run}, nil, nil, time.UnixMilli(10_000)))
	td := d.Tasks[0]
	if td.Result != "Added fmtDate and its tests." || td.ReviewVerdict != ReviewVerdict_Pass || td.ReviewNote != "adds fmtDate" || td.ReviewDownstream != "fmtDate lives in util/date.go" {
		t.Fatalf("the lead must read what the task did, got %+v", td)
	}
}

func TestDigestNamesAFailedReviewForJudgment(t *testing.T) {
	g := digestGroup(t, false, []waveobj.TaskNode{{ID: "t-1", Label: "a"}, {ID: "t-2", Label: "b", Deps: []string{"t-1"}}})
	g.Tasks[0].State = TaskState_ReviewFailed
	RecomputeDagStatus(g)
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, time.UnixMilli(10_000)))
	if d.Next.Kind != "human-action" || strings.Join(d.Next.Actions, ",") != "approve,sendback,retry,skip,escalate" {
		t.Fatalf("want the review-failed actions, got %+v", d.Next)
	}
	if d.Tasks[0].WaitReason != "review" || d.Health != "needs-you" || d.Counts.Attention != 1 {
		t.Fatalf("a failed review needs judgment, got %+v health %s", d.Tasks[0], d.Health)
	}
}

func TestDigestCountsAReviewingTaskAsBusy(t *testing.T) {
	g := digestGroup(t, false, []waveobj.TaskNode{{ID: "t-1", Label: "a"}})
	g.Tasks[0].State = TaskState_Reviewing
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, time.UnixMilli(10_000)))
	if d.Counts.Running != 1 || d.Next.Kind != "parallelism-wait" || d.Tasks[0].WaitReason != "review" {
		t.Fatalf("a review in flight is busy work, got counts %+v next %+v task %+v", d.Counts, d.Next, d.Tasks[0])
	}
}
```

- [ ] **Step 2: Run the digest tests to verify they fail**

Run: `go test ./pkg/orchestrate/ -run TestDigest`
Expected: FAIL: `Result` is empty, the next step for a failed review is not the review actions, and the wait reason is `none`.

- [ ] **Step 3: Implement the digest changes**

In `pkg/orchestrate/digest.go`, add to the action-set `var (` block:

```go
	digestActionReviewFailed      = []string{"approve", "sendback", "retry", "skip", "escalate"}
```

In `BuildDigest`, replace:

```go
	for i := range g.Tasks {
		d.Tasks = append(d.Tasks, buildTaskDigest(g, &g.Tasks[i], askByTask, retried))
	}
```

with:

```go
	runByID := map[string]*waveobj.Run{}
	for _, r := range sn.Runs {
		if r != nil {
			runByID[r.ID] = r
		}
	}
	for i := range g.Tasks {
		td := buildTaskDigest(g, &g.Tasks[i], askByTask, retried)
		withReview(&td, &g.Tasks[i], runByID[g.Tasks[i].RunID])
		d.Tasks = append(d.Tasks, td)
	}
```

Add after `BuildDigest`:

```go
// withReview adds what the lead reads about a task's outcome: the worker's closing note and the latest review.
func withReview(td *wshrpc.DagTaskDigest, t *waveobj.TaskNode, worker *waveobj.Run) {
	if worker != nil && worker.Evidence != nil {
		td.Result = truncateNote(worker.Evidence.Summary, handoffMaxSummaryLen)
	}
	td.ReviewVerdict, td.ReviewRound = t.ReviewVerdict, t.ReviewRound
	td.ReviewNote, td.ReviewDownstream = t.ReviewNote, t.ReviewDownstream
}
```

In `taskAttention`, change `if t.State == TaskState_Failed || t.State == TaskState_BlockedMerge || t.State == TaskState_VerifyFailed {` to:

```go
	if t.State == TaskState_Failed || t.State == TaskState_BlockedMerge || t.State == TaskState_VerifyFailed || t.State == TaskState_ReviewFailed {
```

In `buildCounts`, change `case TaskState_Running:` to `case TaskState_Running, TaskState_Reviewing:`.

In `buildNext`, directly after the `if ids := tasksWithAsk(g, askByTask, false); …` block, add:

```go
	if ids := tasksInState(g, TaskState_ReviewFailed); len(ids) > 0 {
		return humanActionStep("approve/sendback", ids, digestActionReviewFailed)
	}
```

In `busyTaskIDs` and in `taskIsParallelismCapped`, change `if taskActive(g.Tasks[i].State) {` to `if taskInFlight(g.Tasks[i].State) {`.

In `taskWaitReason`, add before `case TaskState_Done:`:

```go
	case TaskState_Reviewing, TaskState_ReviewFailed:
		return "review"
```

In `taskHumanActions`, add as the first case after `case t.CleanupError != "":` and its return:

```go
	case t.State == TaskState_ReviewFailed:
		return digestActionReviewFailed
```

- [ ] **Step 4: Run the digest tests to verify they pass**

Run: `go test ./pkg/orchestrate/`
Expected: PASS.

- [ ] **Step 5: Write the failing CLI and rules tests**

Append to `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`:

```go
func TestDagReviewData(t *testing.T) {
	cmd := newDagEscalateTestCmd(t, map[string]string{"channel": "ch", "runid": "reviewer-run"})
	cmd.Flags().String("downstream", "", "")
	if err := cmd.Flags().Set("downstream", "fmtDate moved"); err != nil {
		t.Fatal(err)
	}
	got, err := dagReviewData(cmd, []string{"pass", "adds fmtDate"})
	if err != nil {
		t.Fatal(err)
	}
	want := wshrpc.CommandDagActionData{ChannelId: "ch", RunId: "reviewer-run", Action: "review-pass", Notes: "adds fmtDate", Downstream: "fmtDate moved"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("review data = %+v, want %+v", got, want)
	}
	if _, err := dagReviewData(cmd, []string{"maybe", "x"}); err == nil {
		t.Fatal("an unknown verdict must be refused before it is sent")
	}
}

func TestDagNoteDataSendbackWithoutGuidance(t *testing.T) {
	cmd := newDagEscalateTestCmd(t, map[string]string{"channel": "ch", "runid": "run"})
	got, err := dagNoteData(cmd, "sendback", []string{"t-2"})
	if err != nil {
		t.Fatal(err)
	}
	want := wshrpc.CommandDagActionData{ChannelId: "ch", RunId: "run", TaskId: "t-2", Action: "sendback"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sendback data = %+v, want %+v", got, want)
	}
}

func TestDagStatusLinesPrintResultAndReview(t *testing.T) {
	rtn := &wshrpc.CommandDagStatusRtnData{
		Group: &waveobj.TaskGroup{ID: "d", Tasks: []waveobj.TaskNode{{ID: "t-1", Label: "a", State: "done"}, {ID: "t-2", Label: "b", State: "review-failed"}}},
		Digest: wshrpc.DagStatusDigest{Tasks: []wshrpc.DagTaskDigest{
			{TaskId: "t-1", Result: "Added fmtDate.", ReviewVerdict: "pass", ReviewNote: "adds fmtDate", ReviewDownstream: "fmtDate is in util"},
			{TaskId: "t-2", ReviewVerdict: "fail", ReviewRound: 2, ReviewNote: "misses\nempty input"},
		}},
	}
	out := strings.Join(dagStatusLines(rtn, 0), "\n")
	for _, want := range []string{
		"t-1 result: Added fmtDate.",
		"t-1 review pass: adds fmtDate · later tasks: fmtDate is in util",
		"t-2 review fail (failed rounds 2): misses empty input",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("status missing %q:\n%s", want, out)
		}
	}
}
```

(Add `"github.com/wavetermdev/waveterm/pkg/waveobj"` to that file's imports if it is not already there.)

Append to `pkg/jarvis/leadprompt_test.go`:

```go
func TestOrchestrationRulesCoverReviewAndDownstream(t *testing.T) {
	r := OrchestrationRules("run-1", "", "")
	for _, want := range []string{
		"- a task passed review with a note for later tasks:",
		"wsh jarvis dag amend <task>",
		"wsh jarvis dag tell <task>",
		"never add, remove or reorder tasks",
		"- review failed:",
		"wsh jarvis dag sendback <task>",
		"wsh jarvis dag approve <task>",
	} {
		if !strings.Contains(r, want) {
			t.Fatalf("rules missing %q:\n%s", want, r)
		}
	}
}
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `go test ./cmd/wsh/cmd/ -run "TestDagReviewData|TestDagNoteData|TestDagStatusLinesPrintResultAndReview" && go test ./pkg/jarvis/ -run TestOrchestrationRulesCoverReviewAndDownstream`
Expected: FAIL to compile with `undefined: dagReviewData` (and `dagNoteData`), and the rules test fails on the missing lines.

- [ ] **Step 7: Implement the CLI commands and status lines**

In `cmd/wsh/cmd/wshcmd-jarvisdag.go` `dagStatusLines`, directly before the line `// nothing wakes the lead for what the human typed to a worker, so this is where it learns of it`, add:

```go
	// what each task did and how its review went: the lead's account of the work, not just its state
	for _, t := range g.Tasks {
		td, ok := taskDigestByID[t.ID]
		if !ok {
			continue
		}
		if td.Result != "" {
			lines = append(lines, fmt.Sprintf("%s result: %s", t.ID, flatText(td.Result)))
		}
		if td.ReviewNote != "" {
			lines = append(lines, reviewLine(t.ID, td))
		}
	}
```

Add after `dagStatusLines`:

```go
// reviewLine is a task's latest review as one line: verdict, failed rounds, and what the reviewer said.
func reviewLine(taskID string, td wshrpc.DagTaskDigest) string {
	head := "review"
	if td.ReviewVerdict != "" {
		head += " " + td.ReviewVerdict
	}
	if td.ReviewRound > 0 {
		head += fmt.Sprintf(" (failed rounds %d)", td.ReviewRound)
	}
	line := fmt.Sprintf("%s %s: %s", taskID, head, flatText(td.ReviewNote))
	if td.ReviewDownstream != "" {
		line += " · later tasks: " + flatText(td.ReviewDownstream)
	}
	return line
}

func flatText(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
```

Add the commands after `dagForwardCmd`:

```go
// dagReviewData is a reviewer's verdict payload. RunId resolves to the reviewer's own run, which is how the
// server finds the task it reviews.
func dagReviewData(cmd *cobra.Command, args []string) (wshrpc.CommandDagActionData, error) {
	verdict := args[0]
	if verdict != "pass" && verdict != "fail" {
		return wshrpc.CommandDagActionData{}, fmt.Errorf("verdict must be pass or fail, got %q", verdict)
	}
	channelId, runId, err := dagIds(cmd)
	if err != nil {
		return wshrpc.CommandDagActionData{}, err
	}
	downstream, _ := cmd.Flags().GetString("downstream")
	return wshrpc.CommandDagActionData{ChannelId: channelId, RunId: runId, Action: "review-" + verdict, Notes: args[1], Downstream: downstream}, nil
}

var dagReviewCmd = &cobra.Command{
	Use:     "review <pass|fail> <note>",
	Short:   "as a task's reviewer: record your verdict (a pass's summary, or a fail's findings), then end your session",
	Args:    cobra.ExactArgs(2),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		data, err := dagReviewData(cmd, args)
		if err != nil {
			return err
		}
		if err := wshclient.DagActionCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 10_000}); err != nil {
			return err
		}
		return reportRunPhase(wshrpc.CommandReportRunPhaseData{Action: "complete"})
	},
}

// dagNoteData is the payload of a lead action that carries text for a task: amend's note, tell's message,
// sendback's optional guidance.
func dagNoteData(cmd *cobra.Command, action string, args []string) (wshrpc.CommandDagActionData, error) {
	channelId, runId, err := dagIds(cmd)
	if err != nil {
		return wshrpc.CommandDagActionData{}, err
	}
	data := wshrpc.CommandDagActionData{ChannelId: channelId, RunId: runId, TaskId: args[0], Action: action}
	if len(args) > 1 {
		data.Notes = args[1]
	}
	return data, nil
}

func dagNoteCmd(use, action, short string, args cobra.PositionalArgs) *cobra.Command {
	return &cobra.Command{
		Use:     use,
		Short:   short,
		Args:    args,
		PreRunE: preRunSetupRpcClient,
		RunE: func(cmd *cobra.Command, a []string) error {
			data, err := dagNoteData(cmd, action, a)
			if err != nil {
				return err
			}
			return wshclient.DagActionCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 10_000})
		},
	}
}

var (
	dagAmendCmd    = dagNoteCmd("amend <task-id> <note>", "amend", "add a note to a task that has not started; its worker's prompt carries it", cobra.ExactArgs(2))
	dagTellCmd     = dagNoteCmd("tell <task-id> <text>", "tell", "type a message into a running worker's (or reviewer's) terminal", cobra.ExactArgs(2))
	dagSendbackCmd = dagNoteCmd("sendback <task-id> [guidance]", "sendback", "send a task whose review failed back for one more round, with your guidance beside the findings", cobra.RangeArgs(1, 2))
)
```

In `init`, replace the two `jarvisDagCmd.AddCommand(…)` lines with:

```go
	jarvisDagCmd.AddCommand(dagSubmitCmd, dagStatusCmd, dagMergeCmd, dagAsksCmd, dagAnswerCmd, dagForwardCmd, dagRulesCmd, dagReviewCmd, dagAmendCmd, dagTellCmd)
	jarvisDagCmd.AddCommand(dagAction("approve"), dagSendbackCmd, dagAction("retry"), dagAction("skip"), dagEscalateCmd, dagAction("cancel"))
```

and after `dagEscalateCmd.Flags().String("runtime", …)`, add:

```go
	dagReviewCmd.Flags().String("downstream", "", "with pass: what a later task must know (a renamed API, a plan assumption that turned out wrong); wakes the lead")
```

- [ ] **Step 8: Add the two rules lines**

In `pkg/jarvis/leadprompt.go` `OrchestrationRules`, directly before the line `// complete closes this tab mid-turn, so everything the human must see or answer comes first.`, add:

```go
	b.WriteString("- a task passed review with a note for later tasks: check the pending tasks it affects and add what they need with `wsh jarvis dag amend <task> \"<note>\"`; use `wsh jarvis dag tell <task> \"<text>\"` only for a running task the note changes. Amending is not re-planning: never add, remove or reorder tasks.\n")
	b.WriteString("- review failed: the findings are in `wsh jarvis dag status`. `wsh jarvis dag sendback <task> \"<guidance>\"` if the fix is clear, `wsh jarvis dag approve <task>` if the reviewer is wrong, otherwise retry, escalate, skip or forward.\n")
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `go test ./pkg/orchestrate/ ./pkg/jarvis/ ./cmd/wsh/cmd/`
Expected: PASS.

- [ ] **Step 10: Check formatting**

Run: `gofmt -l pkg/orchestrate/digest.go pkg/orchestrate/digest_test.go cmd/wsh/cmd/wshcmd-jarvisdag.go cmd/wsh/cmd/wshcmd-jarvisdag_test.go pkg/jarvis/leadprompt.go pkg/jarvis/leadprompt_test.go`
Expected: no output; for a file already listed at HEAD, `gofmt -d <file>` shows no hunk on a line you changed.

---

### Task 6: The review states in the cockpit

**Depends on:** Task 1

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (`AgentVM.atPrompt`, `agentVMFromInput`)
- Modify: `frontend/app/view/agents/runlineage.ts` (`runRoleOf`, `leadStandingBy`)
- Modify: `frontend/app/view/agents/agenttree.tsx` (`ParentRow` state label)
- Modify: `frontend/app/view/agents/runrail.ts` (`FAILING`)
- Modify: `frontend/app/view/agents/runtimeline.ts` (kinds, titles, tones, `eventText`)
- Modify: `frontend/app/view/orchestrate/timelinefilter.ts`, `daggraph.tsx`, `dagstore.ts`, `escalate.ts`, `dagpeek.ts`, `attentionqueue.ts`, `workertasksort.ts`
- Modify: `frontend/app/view/jarvis/runsheetmodel.ts` (`liveTaskRow`)
- Test: `frontend/app/view/agents/runlineage.test.ts`, `frontend/app/view/agents/agentsviewmodel.test.ts`, `frontend/app/view/orchestrate/dagstore.test.ts`, `frontend/app/view/orchestrate/dagpeek.test.ts`

**Interfaces:**
- Consumes: Task 1's generated `TaskNode` fields (`reviewrunid`, `reviewround`, `reviewverdict`, `reviewnote`) and task states `reviewing` / `review-failed`.
- Produces: `AgentVM.atPrompt?: boolean`; `export function leadStandingBy(agent: Pick<AgentVM, "atPrompt">, run: RunInfo): boolean`.

- [ ] **Step 1: Write the failing tests**

In `frontend/app/view/agents/runlineage.test.ts`, add `leadStandingBy` to the import list from `"./runlineage"`, and append:

```ts
describe("runRoleOf for a reviewer", () => {
    it("reads a task's reviewer run as that task's worker", () => {
        const reviewed = { ...dag, tasks: [{ id: "t-1", runid: "child-run", reviewrunid: "review-run", state: "reviewing" }] } as TaskGroup;
        const run = { oid: "review-run", dagoref: "dag:dag-1", mode: "quick" } as Run;
        expect(runRoleOf(run, reviewed)).toEqual({ kind: "worker", leadRunId: "lead-run", taskId: "t-1" });
    });
});

describe("leadStandingBy", () => {
    const run = { runId: "lead-run", channelId: "c", title: "", project: "", dag: { ...dag, status: "running" } as TaskGroup };

    it("reads a lead at its prompt while the plan executes as standing by", () => {
        expect(leadStandingBy({ atPrompt: true }, run)).toBe(true);
    });

    it("keeps a busy lead, a finished run and a run with no plan as they are", () => {
        expect(leadStandingBy({ atPrompt: undefined }, run)).toBe(false);
        expect(leadStandingBy({ atPrompt: true }, { ...run, dag: { ...dag, status: "done" } as TaskGroup })).toBe(false);
        expect(leadStandingBy({ atPrompt: true }, { ...run, dag: undefined })).toBe(false);
    });
});
```

In `frontend/app/view/agents/agentsviewmodel.test.ts`, inside `describe("agentVMFromInput", …)`, append:

```ts
    it("marks a waiting or idle row as at its prompt, and a working one not", () => {
        expect(agentVMFromInput({ id: "t", name: "a", status: "waiting", ts: 1000 }, 2000).atPrompt).toBe(true);
        expect(agentVMFromInput({ id: "t", name: "a", status: "idle", ts: 1000 }, 2000).atPrompt).toBe(true);
        expect(agentVMFromInput({ id: "t", name: "a", status: "working", ts: 1000 }, 2000).atPrompt).toBeUndefined();
    });
```

In `frontend/app/view/orchestrate/dagstore.test.ts`, append:

```ts
describe("buildViewData for a failed review", () => {
    it("offers the lead's review actions", () => {
        const reviewGroup = { id: "dag-2", runid: "run-1", parallelism: 1, tasks: [{ id: "t-0", label: "x", state: "review-failed" }] } as any;
        const { nodes } = buildViewData(reviewGroup, owner, harnesses, none);
        expect(nodes[0].actions).toEqual(["approve", "sendback", "retry", "skip", "escalate"]);
    });
});
```

In `frontend/app/view/orchestrate/dagpeek.test.ts`, append:

```ts
describe("taskPeek review rows", () => {
    it("shows a failed review's findings as a warning", () => {
        const peek = taskPeek(task({ state: "review-failed", reviewverdict: "fail", reviewnote: "misses empty input\nsee parse.ts" }), undefined, briefs, NOW);
        expect(peek.rows).toContainEqual({ text: "review fail: misses empty input", tone: "warning" });
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/runlineage.test.ts frontend/app/view/agents/agentsviewmodel.test.ts frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/orchestrate/dagpeek.test.ts`
Expected: FAIL: `leadStandingBy` is not exported, `atPrompt` is undefined, the review-failed node has no actions, and the peek has no review row.

- [ ] **Step 3: Agent roster and lineage**

In `frontend/app/view/agents/agentsviewmodel.ts`, add to `interface AgentVM` directly after the `runId?: string; …` line:

```ts
    atPrompt?: boolean; // the raw status was waiting or idle, whatever state it folds to: a lead between wakes
```

In `agentVMFromInput`, directly after the `if (input.runORef?.startsWith("run:")) { … }` block, add:

```ts
    if (input.status === "waiting" || input.status === "idle") {
        vm.atPrompt = true;
    }
```

In `frontend/app/view/agents/runlineage.ts` `runRoleOf`, change:

```ts
        const task = (dag.tasks ?? []).find((t) => t.runid === run.oid);
```

to:

```ts
        // a task's reviewer works that task too, so it nests under the lead beside the worker it follows
        const task = (dag.tasks ?? []).find((t) => t.runid === run.oid || t.reviewrunid === run.oid);
```

Add after `runProgress`:

```ts
// leadStandingBy reports a lead sitting at its prompt while its run's plan executes: between wakes it only waits
// for the engine, and the roster's folding of waiting into working would read that as busy.
export function leadStandingBy(agent: Pick<AgentVM, "atPrompt">, run: RunInfo): boolean {
    const status = run.dag?.status;
    return agent.atPrompt === true && run.dag != null && status !== "done" && status !== "cancelled";
}
```

In `frontend/app/view/agents/agenttree.tsx`, add `leadStandingBy` to the existing import from `"./runlineage"` (the file already imports `runProgress` from there). In `ParentRow`, directly after `const asking = agent.state === "asking";`, add:

```tsx
    const standingBy = lead != null && leadStandingBy(agent, lead.run);
```

Change `<StatusDot state={agent.state} pulse={agent.state !== "idle"} className="!h-[7px] !w-[7px]" />` to:

```tsx
                <StatusDot state={standingBy ? "idle" : agent.state} pulse={agent.state !== "idle" && !standingBy} className="!h-[7px] !w-[7px]" />
```

and replace:

```tsx
                <span className="font-mono text-[10px] font-medium transition-colors duration-[140ms]" style={{ color: STATE_COLOR[agent.state] }}>
                    {STATE_LABEL[agent.state]}
                </span>
```

with:

```tsx
                <span
                    className="font-mono text-[10px] font-medium transition-colors duration-[140ms]"
                    style={{ color: STATE_COLOR[standingBy ? "idle" : agent.state] }}
                >
                    {standingBy ? "standing by" : STATE_LABEL[agent.state]}
                </span>
```

- [ ] **Step 4: Rail, timeline and filters**

In `frontend/app/view/agents/runrail.ts`, change `const FAILING = new Set(["stalled", "failed", "verify-failed", "blocked-merge"]);` to:

```ts
const FAILING = new Set(["stalled", "failed", "verify-failed", "blocked-merge", "review-failed"]);
```

In `frontend/app/view/agents/runtimeline.ts`:
- add `"task-review-started"`, `"task-review-passed"`, `"task-review-failed"`, `"review-overruled"`, `"task-amended"`, `"task-lead-told"` to the `RUN_GROUP_KINDS` set (after `"merge-held",`);
- add to `KIND_TITLE`:

```ts
    "task-review-started": "Review started",
    "task-review-passed": "Review passed",
    "task-review-failed": "Review failed",
    "review-overruled": "Lead overruled the review",
    "task-amended": "Lead amended a task",
    "task-lead-told": "Lead told a worker",
```

- add to `KIND_TONE`:

```ts
    "task-review-passed": "text-success",
    "task-review-failed": "text-warning",
    "task-review-started": "text-muted",
    "review-overruled": "text-muted",
    "task-amended": "text-muted",
    "task-lead-told": "text-muted",
```

- in `eventText`, add before `case "merge-held":`:

```ts
        case "task-lead-told":
            return [`lead told ${task}`, d?.text?.replace(/\s+/g, " ")].filter(Boolean).join(" · ");
        case "task-amended":
            return [`lead amended ${task}`, d?.text?.replace(/\s+/g, " ")].filter(Boolean).join(" · ");
        case "task-review-passed":
        case "task-review-failed":
            return [`${eventTitle(event)} · ${task}`, d?.note?.replace(/\s+/g, " ")].filter(Boolean).join(" · ");
```

In `frontend/app/view/orchestrate/timelinefilter.ts`, add `"task-review-failed",` to `ATTENTION_KINDS`, and add to `TASK_TARGET_KINDS`:

```ts
    "task-review-started": "worker",
    "task-lead-told": "worker",
    "task-review-passed": "dag-task",
    "task-review-failed": "dag-task",
    "review-overruled": "dag-task",
    "task-amended": "dag-task",
```

- [ ] **Step 5: DAG view, peek, queue and sort**

In `frontend/app/view/orchestrate/daggraph.tsx` `STATE_TONE`, add:

```ts
    reviewing: "border-accent/60 bg-accent/15 text-accent-soft",
    "review-failed": "border-warning/70 bg-warning/15 text-warning",
```

In `frontend/app/view/orchestrate/dagstore.ts` `ACTION_BY_STATE`, add:

```ts
    "review-failed": ["approve", "sendback", "retry", "skip"],
```

In `frontend/app/view/orchestrate/escalate.ts`, change the `canEscalate` body to:

```ts
    return (task.state === "failed" || task.state === "stalled" || task.state === "review-failed") && (task.escalations ?? 0) < 1;
```

In `frontend/app/view/orchestrate/dagpeek.ts` `taskPeek`, directly before `for (const err of [task.verifyerror, task.mergeerror, task.cleanuperror]) {`, add:

```ts
    if (task.state === "reviewing") {
        const round = (task.reviewround ?? 0) + 1;
        rows.push({ text: round > 1 ? `reviewer checking the fix · round ${round}` : "reviewer checking the commit", tone: "muted" });
    }
    const reviewNote = firstLine(task.reviewnote);
    if (reviewNote) {
        const failed = task.state === "review-failed" || task.reviewverdict === "fail";
        const verdict = task.reviewverdict ? ` ${task.reviewverdict}` : "";
        rows.push({ text: `review${verdict}: ${reviewNote}`, tone: failed ? "warning" : "muted" });
    }
```

In `frontend/app/view/orchestrate/attentionqueue.ts` `needsAttention`, add `task.state === "review-failed" ||` to the state list:

```ts
    if (
        task.state === "failed" ||
        task.state === "stalled" ||
        task.state === "blocked-merge" ||
        task.state === "verify-failed" ||
        task.state === "review-failed"
    ) {
```

In `frontend/app/view/orchestrate/workertasksort.ts` `workerBucket`, add `case "review-failed":` after `case "verify-failed":` (attention), and `case "reviewing":` after `case "verifying":` (running).

- [ ] **Step 6: Run sheet rows**

In `frontend/app/view/jarvis/runsheetmodel.ts` `liveTaskRow`, add before `case "failed":`:

```ts
        case "reviewing": {
            const round = (task.reviewround ?? 0) + 1;
            return {
                ...base,
                meta: round > 1 ? `review round ${round}` : "reviewer checking the commit",
                metaTone: "success-soft",
                state: "reviewing",
                stateTone: "success",
                action: "open-dag-task",
            };
        }
        case "review-failed":
            return {
                ...base,
                meta: firstLine(task.reviewnote) || "review failed",
                metaTone: "warning",
                state: "review failed",
                stateTone: "warning",
                action: "open-dag-task",
            };
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run frontend/app/view/agents frontend/app/view/orchestrate frontend/app/view/jarvis`
Expected: PASS.

Run: `task check:ts` (timeout 5 minutes)
Expected: exit 0.

- [ ] **Step 8: Check formatting**

Run: `npx prettier --check frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/runlineage.ts frontend/app/view/agents/agenttree.tsx frontend/app/view/agents/runrail.ts frontend/app/view/agents/runtimeline.ts frontend/app/view/orchestrate/timelinefilter.ts frontend/app/view/orchestrate/daggraph.tsx frontend/app/view/orchestrate/dagstore.ts frontend/app/view/orchestrate/escalate.ts frontend/app/view/orchestrate/dagpeek.ts frontend/app/view/orchestrate/attentionqueue.ts frontend/app/view/orchestrate/workertasksort.ts frontend/app/view/jarvis/runsheetmodel.ts frontend/app/view/agents/runlineage.test.ts frontend/app/view/agents/agentsviewmodel.test.ts frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/orchestrate/dagpeek.test.ts`
Expected: no file listed, except one that already fails at HEAD (the orchestrate views are known to); for those, `git show HEAD:<file> | npx prettier --stdin-filepath <file> --check` confirms the failure predates this task. Don't use `git stash`: other sessions edit this working tree.

---

### Task 7: The guide

**Depends on:** Task 5, Task 6

**Files:**
- Modify: `docs/orchestrator-guide.md`

- [ ] **Step 1: Confirm the facts the new text states**

Run: `grep -n "Preamble" pkg/jarvis/plan.go pkg/orchestrate/engine.go && grep -n "report" pkg/jarvis/leadprompt.go && grep -n "EffortOID" pkg/orchestrate/verify.go`
Expected: `Preamble` is parsed in `plan.go` and written by `taskPrompt`; the rules name `wsh jarvis complete --report <file>`; `verify.go` closes a task's chunks after its merge's Verify. If any line is missing, stop and report which claim no longer holds.

- [ ] **Step 2: Correct the plan-header bullet**

In `docs/orchestrator-guide.md`, replace the bullet that starts `- **A worker sees only its own task.**` (through `Repeat every rule and command a worker needs inside each task that needs it.`) with:

```markdown
- **Every worker gets the plan's header.** Its prompt is the engine's worker contract, then the prose above
  Task 1, then its own task's section (`taskPrompt`, `engine.go`). This used to be the task alone: the backlog
  plan's header said "Never edit `docs/`. Task 13 writes all docs." and five lanes edited `docs/open-issues.md`
  anyway. Put rules every task shares in the header; a rule for one task belongs in that task.
```

- [ ] **Step 3: Replace the between-wakes passage**

Replace the paragraph that starts `Between wakes the lead's conversation says nothing about the run` (through `(`agentVMFromInput`,
`agentsviewmodel.ts`).`) with:

```markdown
A landing doesn't wake the lead. Each task that passes review queues a line (`t-4 passed review: …`) that goes
out ahead of the lead's next wake, and the run-finished wake carries whatever is left, so the lead learns what
landed without a turn per task. `wsh jarvis dag status` shows each task's result and latest review. While the lead
waits at its prompt, its row reads `standing by`.
```

- [ ] **Step 4: Add the review section**

Directly before the `### Merge conflict and failed Verify` heading, add:

```markdown
### A task's review

Tests are not the only check. When a worker finishes with a commit, the task goes to **reviewing** and the engine
starts a reviewer in the task's lane worktree, on the **lead's** model. The reviewer reads the task, the spec and
`git diff` of the task's commits, checks the change against what the task asked for (missing requirements,
contradictions of the spec, cut corners, changes outside the task), and ends with one command:

- `wsh jarvis dag review pass "<summary>"`: the task lands as before. Adding `--downstream "<note>"` wakes the lead
  with what later tasks must know.
- `wsh jarvis dag review fail "<findings>"`: the first time, the task goes back to a worker in the same worktree,
  starting from the rejected commit with the findings in its prompt. The second time, it goes to
  **review-failed** and the lead wakes.

A reviewer that ends without a verdict or runs past 20 minutes is replaced once; a reviewer that commits has its
verdict thrown out. Either way the task goes to review-failed after that. A worker that commits nothing is not
reviewed.

On a review-failed task the lead (or you, from the DAG) can `approve` it (overrule the reviewer; it lands as it
is), `sendback` it with guidance for one more round, or `retry`, `escalate`, `skip` or `forward` it.

The lead steers later tasks with `dag amend <task> "<note>"` (added to the prompt of a task that hasn't started)
and `dag tell <task> "<text>"` (typed into a running worker's terminal, logged as `lead told t-N`).
```

In the event table under `## When the run needs judgment`, add a row after the **Verify failed** row:

```markdown
| **Review failed** twice, or the reviewer couldn't do its job | reads the findings in `dag status`; `dag sendback <task> "<guidance>"`, `dag approve <task>`, retry, escalate, skip or forward | forwarded review failures |
| **A passed task with a note for later tasks** | amends the pending tasks the note affects (`dag amend`), or tells a running one (`dag tell`) | nothing |
```

- [ ] **Step 5: Correct "Who wraps up" and the initiative section**

In the `### Who wraps up` table, replace the row that starts `| Closing the initiative's tracker chunks | **Nobody's.**` with:

```markdown
| Closing the initiative's tracker chunks | **The engine's.** A task names its chunks with `**Chunk:**` lines after its Depends line, and the engine marks each done with the landed commit once the task's merge passes Verify. | The plan gave it to workers through a header line they never saw. The tracker read 3/16 with all 13 tasks landed. |
```

Replace everything from `Until the first two are fixed, plan for them yourself:` through the end of proposal item 2 (the line ending `since only the engine knows which commit landed.`) with:

```markdown
Both gaps the backlog run hit are closed in code: `wsh jarvis complete --report <file>` seals the report the lead
wrote, and `**Chunk:**` lines let the engine close the tracker. If a sealed summary is still a half-sentence, the
lead ran `complete` without `--report`; its last full message is the closest thing to a report.
```

In `## Tracking an initiative across runs`, replace the sentence `Nothing in the engine does it (see
[Who wraps up](#who-wraps-up)).` with `The engine does it for a task that names its chunk with a `**Chunk:**` line
(see [Who wraps up](#who-wraps-up)).`

- [ ] **Step 6: Add the commands to the CLI table**

In the `## CLI: `wsh jarvis dag`` table, add after the `dag forward` row:

```markdown
| `dag amend <task> "<note>"` | add a note to a task that hasn't started; its worker's prompt carries it |
| `dag tell <task> "<text>"` | type into a running worker's or reviewer's terminal |
| `dag sendback <task> ["<guidance>"]` | one more round for a review-failed task, with your guidance beside the findings |
| `dag approve <task>` | overrule a failed review; the task lands as it is |
| `dag review <pass\|fail> "<note>" [--downstream "<note>"]` | a reviewer's verdict; ends the reviewer's session |
```

- [ ] **Step 7: Check the doc renders sensibly**

Run: `grep -n "A task's review\|standing by\|dag amend\|Every worker gets the plan's header" docs/orchestrator-guide.md`
Expected: each phrase found once or more; no leftover `A worker sees only its own task`.
