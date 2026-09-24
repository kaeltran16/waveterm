# Orchestrator Liveness and Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `go test ./pkg/orchestrate/ ./pkg/jarvis/ ./pkg/wshrpc/... ./cmd/wsh/... && npx vitest run frontend/app/view/orchestrate frontend/app/view/jarvis frontend/app/view/agents`

**Goal:** Stop the engine from leaking reviewer processes that block worktree cleanup, make a finished-but-unreported or dead worker reach the lead within minutes instead of never, and make cleanup debt say what it is and be fixable.

**Architecture:** All engine fixes live in `pkg/orchestrate` (cleanup reap, reviewer brief, liveness, a new `RetryCleanup` entry point), wired through the existing `DagActionCommand` RPC and `wsh jarvis dag` CLI. `AdvanceRunCommand` stops running the scheduler tick inside the child's RPC budget. The frontend only relabels a cleanup-only `needs-you` digest; no new state.

**Tech Stack:** Go (wavesrv, wsh, cobra), React + TypeScript (vitest), SQLite via `wstore`.

**Spec:** none — the source is effort `ad5ab3e7` ("Orchestrator: reviewer leak and cleanup debt"; `wsh effort show ad5ab3e7`), whose chunk notes carry the evidence from run `28caa81f`. Task N below maps to the effort chunk named in its heading.

## Global Constraints

- Work in a git worktree off `main` HEAD: the main checkout carries another session's uncommitted edits in `pkg/orchestrate/engine.go`, `pkg/orchestrate/review.go`, `pkg/waveobj/wtype.go`, `pkg/wshrpc/wshrpctypes.go`, `pkg/wshrpc/wshserver/wshserver_agents.go`, `pkg/wstore/wstore_channel.go` and an untracked `pkg/wshrpc/wshserver/sessionruns.go`. Never stage or revert them.
- No wshrpc / waveobj type changes, so no `task generate`. If you find you need one, stop and ask.
- Comments explain why, lower case, only where needed. No emojis. Commit subjects `type(scope): description`, under 72 chars, no `Co-Authored-By` or other trailers.
- Colors only from `@theme` tokens (`text-warning`, etc.); no new tokens.
- Check formatting only on files you touch (`gofmt -l <files>`, `npx prettier --check <files>`); the tree is not formatter-clean.
- Typecheck with `task check:ts` (about 2 minutes; give it a 300000 ms timeout), never bare `npx tsc`.
- Never kill `wave-tauri.exe` / `wavesrv.x64.exe` by image name (AGENTS.md).

## Review Focus

1. A worker that ends its turn while a background test runs is idle to Claude but busy on CPU: it must not be stalled or reported. (Task 6 test "turn ended, background test still running")
2. A worker whose run already completed but whose Stop hook arrives late must not be woken about: only `TaskState_Running` tasks are judged. (Task 6 — the check is gated on `TaskState_Running`; the test seeds a running task only, so reviewers confirm the gate by reading.)
3. Two ticks inside the same millisecond with flat CPU must not read as work (elapsed 0 makes any floor 0). (Task 6 test "flat CPU in the same millisecond")
4. `retry-cleanup` on a task with no debt, on an unknown task, and on a cancelled dag. (Task 3 tests)
5. A reviewer's note typed into another task's worker must not appear in this task's reviewer brief. (Task 2 test, the `t-9` event)

---

### Task 1: Reap every run in a lane tree before removing it

**Depends on:** none

Effort chunk: "Reap every run in a lane tree before removing it".

Why: `applyReviewVerdict` (`pkg/orchestrate/review.go`) clears `t.ReviewRunID` and assumes the reviewer exits after its verdict; claude instead sits at its prompt with the lane tree as its cwd. `reapLaneWorkers` (`pkg/orchestrate/cleanup.go:110`) stops only each lane task's `RunID`, so on Windows the tree cannot be deleted, five attempts burn, and the dag reads `needs-you` for good. The rule becomes: stop every child run of this dag whose `ProjectPath` is the tree being removed — worker, reviewer, replacement reviewer, sendback worker.

**Files:**
- Modify: `pkg/orchestrate/cleanup.go` (`CleanupTaskWorktree`, `reapLaneWorkers`)
- Test: `pkg/orchestrate/cleanup_test.go` (append)

**Interfaces:**
- Consumes: `wstore.GetChannelRuns(ctx, channelId) ([]*waveobj.Run, error)`, `worktreeDir(projectPath, key string) string` (`worktree.go:17`), `LaneWorktreeKey(g, taskID)`, `stopRunWorkers` (var, `mutation.go:53`).
- Produces: `reapLaneWorkers(ctx context.Context, g *waveobj.TaskGroup, taskID, tree string)` — signature gains `tree`.

- [ ] **Step 1: Write the failing test** — append to `pkg/orchestrate/cleanup_test.go`:

```go
// A reviewer runs in the lane tree and stays at its prompt after its verdict, holding the tree as its cwd; the
// run's ReviewRunID is cleared by then, so only the tree path finds it (run 28caa81f lost five trees this way).
func TestCleanupTaskWorktreeReapsEveryRunInTheTree(t *testing.T) {
	ctx := context.Background()
	projectDir := newGitRepo(t)
	ch, err := wstore.CreateChannel(ctx, "cleanup-reap-tree", projectDir)
	if err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup("run-1", ch.OID, "reap tree group", 2, false, []waveobj.TaskNode{
		{ID: "t-1", Label: "one"},
		{ID: "t-2", Label: "two"},
	}, time.Now().UnixMilli(), nil)
	if err != nil {
		t.Fatal(err)
	}
	g.Tasks[0].RunID, g.Tasks[0].State, g.Tasks[0].Merged = "worker-t-1", TaskState_Done, true
	g.Tasks[0].CleanupPending = true
	tree := worktreeDir(projectDir, LaneWorktreeKey(&g, "t-1"))
	otherTree := worktreeDir(projectDir, LaneWorktreeKey(&g, "t-2"))
	for _, r := range []waveobj.Run{
		{ID: "worker-t-1", DagORef: g.OID, ProjectPath: tree},
		{ID: "reviewer-t-1", DagORef: g.OID, ProjectPath: tree},
		{ID: "reviewer-t-2", DagORef: g.OID, ProjectPath: otherTree},
		{ID: "other-dag", DagORef: "some-other-dag", ProjectPath: tree},
	} {
		r.Phases = []waveobj.RunPhase{{WorkerOrefs: []string{"tab:" + r.ID}}}
		if err := wstore.AppendRun(ctx, ch.OID, r); err != nil {
			t.Fatal(err)
		}
	}

	var stopped []string
	oldStop := stopRunWorkers
	stopRunWorkers = func(_ context.Context, run *waveobj.Run) error {
		stopped = append(stopped, run.ID)
		return nil
	}
	t.Cleanup(func() { stopRunWorkers = oldStop })
	stubCleanupRemover(t, func(context.Context, string, string) error { return nil })

	if err := CleanupTaskWorktree(ctx, &g, "t-1"); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	slices.Sort(stopped)
	if want := []string{"reviewer-t-1", "worker-t-1"}; !slices.Equal(stopped, want) {
		t.Fatalf("cleanup of t-1 stopped %v, want %v (never another tree's reviewer or another dag's run)", stopped, want)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `go test ./pkg/orchestrate/ -run TestCleanupTaskWorktreeReapsEveryRunInTheTree -v`
Expected: FAIL — `stopped [worker-t-1]`, the reviewer is missing.

- [ ] **Step 3: Implement** — in `pkg/orchestrate/cleanup.go`, change the call in `CleanupTaskWorktree` and rewrite `reapLaneWorkers`:

```go
	key := LaneWorktreeKey(g, taskID)
	reapLaneWorkers(ctx, g, taskID, worktreeDir(projectPath, key))
	err = RemoveTaskWorktree(ctx, projectPath, key)
```

```go
// reapLaneWorkers stops every run still holding the tree about to be removed. A harness sits at its prompt after
// reporting done instead of exiting, and on Windows a live process holding the tree as its cwd is what makes
// git's removal leave the directory behind. The lane's own tasks are reaped by id; everything else this dag ran
// in the tree - reviewers, whose ReviewRunID is cleared once their verdict applies, and replacements - is found
// by path. Best effort: the removal below is what decides whether cleanup succeeded.
func reapLaneWorkers(ctx context.Context, g *waveobj.TaskGroup, taskID, tree string) {
	reaped := map[string]bool{}
	stop := func(run *waveobj.Run) {
		if run == nil || reaped[run.ID] {
			return
		}
		reaped[run.ID] = true
		if err := stopRunWorkers(ctx, run); err != nil {
			log.Printf("dag %s run %s: stopping worker in %s: %v", g.OID, run.ID, tree, err)
		}
	}
	for _, id := range laneOf(g, taskID) {
		task := taskByID(g, id)
		if task == nil || task.RunID == "" {
			continue
		}
		child, err := wstore.GetRun(ctx, g.ChannelId, task.RunID)
		if err != nil {
			log.Printf("dag %s task %s: loading child run to stop its worker: %v", g.OID, id, err)
			continue
		}
		stop(child)
	}
	runs, err := wstore.GetChannelRuns(ctx, g.ChannelId)
	if err != nil {
		log.Printf("dag %s: listing runs to reap %s: %v", g.OID, tree, err)
		return
	}
	for _, run := range runs {
		if run.DagORef == g.OID && run.ProjectPath != "" && filepath.Clean(run.ProjectPath) == filepath.Clean(tree) {
			stop(run)
		}
	}
}
```

Add `"path/filepath"` to the imports. Keep the existing `TestCleanupTaskWorktreeReapsTheLanesWorkersFirst` passing unchanged: its runs carry no `ProjectPath`, so they are reaped by id only, and the order `stop, stop, remove` still holds.

- [ ] **Step 4: Run the package tests**

Run: `go test ./pkg/orchestrate/ -run 'Cleanup|Reap' -v`
Expected: PASS, including the old lane-reap test.

- [ ] **Step 5: Commit**

```bash
git add pkg/orchestrate/cleanup.go pkg/orchestrate/cleanup_test.go
git commit -m "fix(orchestrate): reap reviewers before removing a lane's worktree"
```

---

### Task 2: Reviewer brief carries the task's amendments and downstream notes

**Depends on:** none

Effort chunk: "Reviewer brief carries the task's amendments and downstream notes".

Why: `routeDownstream` puts a reviewer's `--downstream` note into the next task's `LeadNotes` (not yet started) or types it to the live worker (recorded as `task-lead-told`). The worker acts on it, but `reviewPrompt` gives the reviewer only the plan's task text and the worker's summary. In run `28caa81f`, t-2's reviewer called the requested change "one justified extension beyond the file list"; a stricter reviewer would have failed it.

**Files:**
- Modify: `pkg/orchestrate/review.go` (`spawnReviewer`, `reviewPrompt`, two new helpers)
- Test: `pkg/orchestrate/review_test.go` (append)

**Interfaces:**
- Consumes: `wstore.QueryRunEventsByKind(ctx, channelId, runId string, kinds []string, limit int) ([]waveobj.RunEvent, error)` (newest first), `waveobj.RunEventKindTaskLeadTold`, `waveobj.RunEventKindTaskTold`.
- Produces: `reviewPrompt(g *waveobj.TaskGroup, task *waveobj.TaskNode, worker *waveobj.Run, told []string) string`; `toldToTask(ctx context.Context, g *waveobj.TaskGroup, taskID string) []string`; `reviewAdditions(task *waveobj.TaskNode, told []string) string`.

- [ ] **Step 1: Write the failing test** — append to `pkg/orchestrate/review_test.go`:

```go
// The worker was told more than the plan says: a note an earlier reviewer sent downstream, the lead's guidance,
// and text typed into its terminal. Its reviewer judges against all of it, or a requested change reads as scope
// creep. What was typed to another task's worker stays out.
func TestReviewerBriefCarriesWhatTheWorkerWasTold(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].LeadNotes = []string{"t-1's reviewer: install the latch only once the layout has loaded"}
		g.Tasks[0].LeadGuidance = "keep the skeleton card-shaped"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, ev := range []map[string]any{
		{"taskid": "t-0", "text": "also gate on the workspace atom"},
		{"taskid": "t-9", "text": "a note for someone else"},
	} {
		if _, err := wstore.AppendRunEvent(ctx, dag.ChannelId, dag.RunID, waveobj.RunEventKindTaskLeadTold, nil, ev); err != nil {
			t.Fatal(err)
		}
	}
	stubReviewTree(t, worker.EndCommit)
	calls := captureSpawns(t)
	schedule(t, ctx, dag.OID)
	if len(*calls) != 1 {
		t.Fatalf("want one reviewer, got %d", len(*calls))
	}
	p := (*calls)[0].prompt
	for _, want := range []string{
		"install the latch only once the layout has loaded",
		"keep the skeleton card-shaped",
		"also gate on the workspace atom",
	} {
		if !strings.Contains(p, want) {
			t.Fatalf("reviewer brief missing %q:\n%s", want, p)
		}
	}
	if strings.Contains(p, "a note for someone else") {
		t.Fatalf("reviewer brief carries another task's message:\n%s", p)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `go test ./pkg/orchestrate/ -run TestReviewerBriefCarriesWhatTheWorkerWasTold -v`
Expected: FAIL — `reviewer brief missing "install the latch only once the layout has loaded"`.

- [ ] **Step 3: Implement** — in `pkg/orchestrate/review.go`:

In `spawnReviewer`, replace `prompt := reviewPrompt(g, t, worker)` with:

```go
	prompt := reviewPrompt(g, t, worker, toldToTask(ctx, g, t.ID))
```

Change the signature to `func reviewPrompt(g *waveobj.TaskGroup, task *waveobj.TaskNode, worker *waveobj.Run, told []string) string` and, just before `return b.String()`, add:

```go
	if extra := reviewAdditions(task, told); extra != "" {
		b.WriteString("\n\n")
		b.WriteString(extra)
	}
```

Add the helpers below `reviewPrompt`:

```go
// reviewAdditions is what the task gained after the plan was written: notes the lead or an earlier reviewer
// added (LeadNotes), the lead's guidance after a sendback, and what was typed to its worker. The worker was
// asked to act on them, so a reviewer judging against the plan alone reads a requested change as scope creep.
func reviewAdditions(task *waveobj.TaskNode, told []string) string {
	lines := append([]string{}, task.LeadNotes...)
	if task.LeadGuidance != "" {
		lines = append(lines, "the lead's guidance after a sendback: "+task.LeadGuidance)
	}
	for _, s := range told {
		lines = append(lines, "typed to the worker: "+s)
	}
	if len(lines) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("The worker was also told these after the plan was written; judge the change against them too:")
	for _, l := range lines {
		fmt.Fprintf(&b, "\n- %s", l)
	}
	return b.String()
}

// toldToTask is what was typed into a task's worker, oldest first: the lead's `dag tell` and a reviewer's
// downstream note typed to a live worker (task-lead-told), and the human's own messages (task-told). A failed
// read leaves the brief without them rather than failing the review.
func toldToTask(ctx context.Context, g *waveobj.TaskGroup, taskID string) []string {
	kinds := []string{waveobj.RunEventKindTaskLeadTold, waveobj.RunEventKindTaskTold}
	evs, err := wstore.QueryRunEventsByKind(ctx, g.ChannelId, g.RunID, kinds, 0)
	if err != nil {
		log.Printf("dag %s task %s: reading what its worker was told: %v", g.OID, taskID, err)
		return nil
	}
	var out []string
	for i := len(evs) - 1; i >= 0; i-- {
		var d struct {
			TaskId string `json:"taskid"`
			Text   string `json:"text"`
		}
		if json.Unmarshal(evs[i].Detail, &d) != nil || d.TaskId != taskID || d.Text == "" {
			continue
		}
		out = append(out, d.Text)
	}
	return out
}
```

Add `"encoding/json"` to the imports if missing (`log`, `fmt`, `strings` are already imported). `evs[i].Detail` is the raw JSON the digest's `toldMessages` already unmarshals the same way.

- [ ] **Step 4: Run the review tests**

Run: `go test ./pkg/orchestrate/ -run 'Review' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/orchestrate/review.go pkg/orchestrate/review_test.go
git commit -m "fix(orchestrate): brief reviewers on what the worker was told"
```

---

### Task 3: Implement retry-cleanup

**Depends on:** Task 1

Effort chunk: "Decide: implement retry-cleanup or stop advertising it" — decided: implement it. After Task 1 the leftover case is a tree something outside the engine holds (an editor, a shell you opened there); once you close it, you need a way to finish the job, and the digest already names this action (`digest.go:303`, `:583`).

**Files:**
- Modify: `pkg/orchestrate/cleanup.go` (new `RetryCleanup`)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`DagActionCommand` switch)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`dagAction`, registration at line ~661)
- Test: `pkg/orchestrate/cleanup_test.go` (append)
- Docs: `docs/orchestrator-guide.md` — add `wsh jarvis dag retry-cleanup <task>` wherever the guide lists the dag actions (grep for `dag retry`); if it lists none, add one line under the section about worktrees.

**Interfaces:**
- Consumes: `CleanupTaskWorktree`, `PersistCleanupState`, `withDagMutation(dagID string, fn func() error) error` (`mutation.go`), `appendRunEvent` (var).
- Produces: `func RetryCleanup(ctx context.Context, dagID, taskID string) error`; RPC action string `"retry-cleanup"`.

- [ ] **Step 1: Write the failing tests** — append to `pkg/orchestrate/cleanup_test.go`:

```go
// seedCleanupDebt is a one-task dag whose merged task's tree failed removal until its attempts ran out.
func seedCleanupDebt(t *testing.T) (context.Context, *waveobj.TaskGroup) {
	t.Helper()
	ctx, dag := seedPendingDag(t)
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].State, g.Tasks[0].Merged = TaskState_Done, true
		g.Tasks[0].CleanupError = "removing worktree dir: unlinkat: The process cannot access the file"
		g.Tasks[0].CleanupAttempts = MaxCleanupAttempts
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	stubStopRunWorkers(t)
	return ctx, dag
}

func TestRetryCleanupClearsDebtOnceTheTreeGoes(t *testing.T) {
	ctx, dag := seedCleanupDebt(t)
	stubCleanupRemover(t, func(context.Context, string, string) error { return nil })
	if err := RetryCleanup(ctx, dag.OID, "t-0"); err != nil {
		t.Fatalf("retry-cleanup: %v", err)
	}
	task := firstTask(t, ctx, dag.OID)
	if task.CleanupError != "" || task.CleanupAttempts != 0 || task.CleanupPending {
		t.Fatalf("a removed tree clears the debt, got error %q attempts %d pending %v", task.CleanupError, task.CleanupAttempts, task.CleanupPending)
	}
}

// the attempts reset, so a tree still held counts one fresh failure and the watchdog keeps retrying it
func TestRetryCleanupThatFailsAgainRestartsTheAttempts(t *testing.T) {
	ctx, dag := seedCleanupDebt(t)
	stubCleanupRemover(t, func(context.Context, string, string) error { return errors.New("still locked") })
	err := RetryCleanup(ctx, dag.OID, "t-0")
	if err == nil || !strings.Contains(err.Error(), "still locked") {
		t.Fatalf("want the removal's error, got %v", err)
	}
	if task := firstTask(t, ctx, dag.OID); task.CleanupAttempts != 1 || task.CleanupError == "" {
		t.Fatalf("want one fresh attempt recorded, got attempts %d error %q", task.CleanupAttempts, task.CleanupError)
	}
}

func TestRetryCleanupRefusesATaskWithNoDebt(t *testing.T) {
	ctx, dag := seedPendingDag(t)
	if err := RetryCleanup(ctx, dag.OID, "t-0"); err == nil {
		t.Fatal("a task with no tree left must be refused")
	}
	if err := RetryCleanup(ctx, dag.OID, "t-404"); err == nil {
		t.Fatal("an unknown task must be refused")
	}
}

// cancelling queues every tree for cleanup, so a cancelled dag's debt must stay retryable
func TestRetryCleanupWorksOnACancelledDag(t *testing.T) {
	ctx, dag := seedCleanupDebt(t)
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Status = DagStatus_Cancelled
		g.Tasks[0].Merged = false
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	stubCleanupRemover(t, func(context.Context, string, string) error { return nil })
	if err := RetryCleanup(ctx, dag.OID, "t-0"); err != nil {
		t.Fatalf("retry-cleanup on a cancelled dag: %v", err)
	}
}
```

Add `"errors"` and `"strings"` to the test file's imports if missing. `firstTask` and `stubStopRunWorkers` live in `review_test.go`, same package.

- [ ] **Step 2: Run them and watch them fail**

Run: `go test ./pkg/orchestrate/ -run TestRetryCleanup -v`
Expected: FAIL to compile — `undefined: RetryCleanup`.

- [ ] **Step 3: Implement `RetryCleanup`** — append to `pkg/orchestrate/cleanup.go`:

```go
// RetryCleanup is the human's retry-cleanup: it gives a task's stuck worktree a fresh set of attempts and tries
// once now, reaping whatever still holds the tree first. The watchdog's own retries stop at MaxCleanupAttempts,
// so without this a tree freed later (an editor closed, a shell exited) stays debt until the dag is cancelled.
// A cancelled dag is allowed: cancelling is what queued its trees.
func RetryCleanup(ctx context.Context, dagID, taskID string) error {
	return withDagMutation(dagID, func() error {
		g, err := wstore.GetDag(ctx, dagID)
		if err != nil {
			return fmt.Errorf("loading dag: %w", err)
		}
		task := taskByID(g, taskID)
		if task == nil {
			return fmt.Errorf("no task %q", taskID)
		}
		if !task.CleanupPending && task.CleanupError == "" {
			return fmt.Errorf("task %s has no worktree left to clean up", taskID)
		}
		task.CleanupAttempts = 0
		cleanupErr := CleanupTaskWorktree(ctx, g, taskID)
		if err := PersistCleanupState(ctx, g); err != nil {
			return err
		}
		if cleanupErr != nil {
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskCleanupFailed, nil, map[string]any{"taskid": taskID, "error": cleanupErr.Error()})
			return fmt.Errorf("task %s's worktree still could not be removed: %w", taskID, cleanupErr)
		}
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskCleanupCompleted, nil, map[string]any{"taskid": taskID})
		return nil
	})
}
```

Check `withDagMutation` exists with that name in `mutation.go` (`grep -n "func withDagMutation\|withDagMutation =" pkg/orchestrate/*.go`); use whatever the package's own callers use (`HandleChildOutcome` in `outcome.go` calls `withDagMutation(run.DagORef, ...)`).

- [ ] **Step 4: Run the tests**

Run: `go test ./pkg/orchestrate/ -run 'TestRetryCleanup|Cleanup' -v`
Expected: PASS.

- [ ] **Step 5: Wire the RPC** — in `pkg/wshrpc/wshserver/wshserver_dag.go`, `DagActionCommand`'s `switch data.Action`, add beside `case "cancel":`:

```go
	case "retry-cleanup":
		return orchestrate.RetryCleanup(ctx, run.DagORef, data.TaskId)
```

- [ ] **Step 6: Wire the CLI** — in `cmd/wsh/cmd/wshcmd-jarvisdag.go`, give `dagAction` a timeout parameter (removing a big tree and reaping its processes outlasts 10 s, and the server's work is cancelled with the client's budget):

```go
func dagAction(action string) *cobra.Command {
	return dagActionWithin(action, 10_000)
}

func dagActionWithin(action string, timeoutMs int64) *cobra.Command {
	return &cobra.Command{
		Use:     fmt.Sprintf("%s <task-id>", action),
		Short:   fmt.Sprintf("dag action: %s", action),
		Args:    cobra.ExactArgs(1),
		PreRunE: preRunSetupRpcClient,
		RunE: func(cmd *cobra.Command, args []string) error {
			channelId, runId, err := dagIds(cmd)
			if err != nil {
				return err
			}
			return wshclient.DagActionCommand(RpcClient, wshrpc.CommandDagActionData{
				ChannelId: channelId, RunId: runId, TaskId: args[0], Action: action,
			}, &wshrpc.RpcOpts{Timeout: timeoutMs})
		},
	}
}
```

Match `timeoutMs`'s type to `wshrpc.RpcOpts.Timeout` (check `grep -n "Timeout " pkg/wshrpc/wshrpctypes.go`). Register it next to the others:

```go
	jarvisDagCmd.AddCommand(dagAction("approve"), dagSendbackCmd, dagAction("retry"), dagAction("skip"), dagEscalateCmd, dagAction("cancel"), dagActionWithin("retry-cleanup", 60_000))
```

- [ ] **Step 7: Build and run the wsh tests**

Run: `go build ./cmd/... && go test ./cmd/wsh/... ./pkg/wshrpc/...`
Expected: PASS. Then `go run ./cmd/wsh jarvis dag retry-cleanup --help` prints `dag action: retry-cleanup`.

- [ ] **Step 8: Docs** — add the command to `docs/orchestrator-guide.md` as described under Files.

- [ ] **Step 9: Commit**

```bash
git add pkg/orchestrate/cleanup.go pkg/orchestrate/cleanup_test.go pkg/wshrpc/wshserver/wshserver_dag.go cmd/wsh/cmd/wshcmd-jarvisdag.go docs/orchestrator-guide.md
git commit -m "feat(orchestrate): let the human retry a worktree cleanup that gave up"
```

---

### Task 4: Name leftover worktrees instead of a generic "Waiting on you"

**Depends on:** none

Effort chunk: "Name leftover worktrees in the run status, not a generic Waiting on you".

Why: cleanup debt alone puts health at `needs-you`, and the run rail renders `Waiting on you · next waiting on you — retry-cleanup…` (`RUN_STATUS["needs-you"]` in `frontend/app/view/agents/runrailsections.tsx`; `nextStepText` in `frontend/app/view/orchestrate/dagdigest.ts`). The human looks for a question and finds none. When cleanup is the only thing asked of the human, say that.

**Files:**
- Modify: `frontend/app/view/orchestrate/dagdigest.ts` (new `cleanupOnly`, `nextStepText` case)
- Modify: `frontend/app/view/agents/runrailsections.tsx` (`RunStatus`)
- Modify: `frontend/app/view/jarvis/runsheetmodel.ts` (`daggedStatus`, before the `human-action` branch)
- Test: `frontend/app/view/orchestrate/dagdigest.test.ts`, `frontend/app/view/jarvis/runsheetmodel.test.ts` (append)

**Interfaces:**
- Produces: `export function cleanupOnly(digest: DagStatusDigest | undefined): boolean`; `nextStepText` renders `{kind: "human-action", actions: ["retry-cleanup"]}` as `worktrees not removed: <names> — wsh jarvis dag retry-cleanup`.

- [ ] **Step 1: Write the failing tests** — append to `frontend/app/view/orchestrate/dagdigest.test.ts` (reuse the file's existing imports; add `cleanupOnly` to the import from `./dagdigest`):

```ts
describe("cleanupOnly", () => {
    const task = (taskid: string, humanactions?: string[]) => ({ taskid, humanactions }) as DagTaskDigest;
    const digest = (health: string, tasks: DagTaskDigest[]) => ({ health, tasks }) as DagStatusDigest;

    it("is true when every task asking the human only needs its worktree removed", () => {
        expect(cleanupOnly(digest("needs-you", [task("t-1"), task("t-2", ["retry-cleanup"])]))).toBe(true);
    });
    it("is false when a question, gate or failure also needs the human", () => {
        expect(cleanupOnly(digest("needs-you", [task("t-1", ["answer"]), task("t-2", ["retry-cleanup"])]))).toBe(false);
        expect(cleanupOnly(digest("needs-you", [task("t-1", ["retry", "skip", "escalate"])]))).toBe(false);
    });
    it("is false for a healthy digest, a blocked dag with no task actions, or none at all", () => {
        expect(cleanupOnly(digest("healthy", [task("t-1", ["retry-cleanup"])]))).toBe(false);
        expect(cleanupOnly(digest("needs-you", [task("t-1")]))).toBe(false);
        expect(cleanupOnly(undefined)).toBe(false);
    });
});

it("names worktree cleanup as what it is", () => {
    expect(nextStepText({ kind: "human-action", taskids: ["t-2", "t-3"], actions: ["retry-cleanup"] })).toBe(
        "worktrees not removed: t-2, t-3 — wsh jarvis dag retry-cleanup"
    );
});
```

Check how the file names tasks without briefs (`nameList` falls back to the raw id) and adjust the expected string's separator to whatever `nameList` joins with. Import `DagTaskDigest` / `DagStatusDigest` only if the file doesn't rely on the global `gotypes.d.ts` declarations (it does elsewhere — check the top of the file).

Append to `frontend/app/view/jarvis/runsheetmodel.test.ts`, inside the describe that covers the dagged statuses (use the file's own `digest(...)` factory, as the `human-action` cases near line 220 do):

```ts
it("says cleanup failed, not waiting on you, when only worktrees are left", () => {
    const s = sheetStatus(
        read({
            dag: {
                digest: fresh(
                    digest(
                        {
                            health: "needs-you",
                            next: { kind: "human-action", taskids: ["t-2"], actions: ["retry-cleanup"] },
                            tasks: [{ taskid: "t-2", humanactions: ["retry-cleanup"] } as DagTaskDigest],
                        },
                        { attention: 1, running: 0 }
                    )
                ),
                group: group(["done", "done", "done", "done"]),
                groupRead: "ready",
            },
        })
    );
    expect(s.verb).toBe("Cleanup failed");
    expect(s.sub).toBe("1 worktree could not be removed");
});
```

`sheetStatus`, `read`, `fresh`, `digest` and `group` are the file's own helpers (see the "waits on you when a decision is all that is left" test, which this mirrors).

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run frontend/app/view/orchestrate/dagdigest.test.ts frontend/app/view/jarvis/runsheetmodel.test.ts`
Expected: FAIL — `cleanupOnly` is not exported; the sheet says `Waiting on you`.

- [ ] **Step 3: Implement in `dagdigest.ts`** — add below `nextStepText`:

```ts
// cleanupOnly is a needs-you digest whose only ask of the human is removing worktrees the engine could not.
// Nothing is asking, so "Waiting on you" sends the human looking for a question that is not there.
export function cleanupOnly(digest: DagStatusDigest | undefined): boolean {
    if (digest?.health !== "needs-you") {
        return false;
    }
    const acting = (digest.tasks ?? []).filter((td) => (td.humanactions?.length ?? 0) > 0);
    return acting.length > 0 && acting.every((td) => td.humanactions.length === 1 && td.humanactions[0] === "retry-cleanup");
}
```

and at the top of the `"human-action"` case in `nextStepText`:

```ts
        case "human-action": {
            if (next.actions?.length === 1 && next.actions[0] === "retry-cleanup") {
                return `worktrees not removed${named ? `: ${named}` : ""} — wsh jarvis dag retry-cleanup`;
            }
            const actions = next.actions?.join(" / ") ?? "action";
            return `waiting on you — ${actions}` + (named ? `: ${named}` : "");
        }
```

- [ ] **Step 4: Implement in `runsheetmodel.ts`** — in `daggedStatus`, directly before `if (digest.next.kind === "human-action") {`:

```ts
    if (cleanupOnly(digest)) {
        const left = (digest.tasks ?? []).filter((td) => td.humanactions?.[0] === "retry-cleanup").length;
        return {
            verb: "Cleanup failed",
            sub: `${plural(left, "worktree")} could not be removed`,
            tone: "warning",
            pulse: false,
            meter,
            meta,
            next,
            retry: false,
        };
    }
```

Import `cleanupOnly` from `@/app/view/orchestrate/dagdigest` next to the file's other imports from it. It sits after the `userAsks`/`workerAsking` branch on purpose: a real question still wins.

- [ ] **Step 5: Implement in `runrailsections.tsx`** — in `RunStatus`, replace the `status` line:

```tsx
    const status = waitingOnYou
        ? RUN_STATUS["needs-you"]
        : !state.stale && cleanupOnly(digest)
          ? { text: "Cleanup failed", tone: "text-warning" }
          : (known ?? healthView(state));
```

and add `cleanupOnly` to the existing import from `@/app/view/orchestrate/dagdigest`. The tail already comes from `nextStepView`, which now reads `worktrees not removed: …`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run frontend/app/view/orchestrate frontend/app/view/jarvis frontend/app/view/agents`
Expected: PASS. Update any existing expectation that asserted the old `waiting on you — retry-cleanup` wording (grep the three test dirs for `retry-cleanup` first).
Run: `task check:ts` (timeout 300000). Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/orchestrate/dagdigest.ts frontend/app/view/orchestrate/dagdigest.test.ts frontend/app/view/jarvis/runsheetmodel.ts frontend/app/view/jarvis/runsheetmodel.test.ts frontend/app/view/agents/runrailsections.tsx
git commit -m "fix(cockpit): say cleanup failed, not waiting on you, for leftover trees"
```

---

### Task 5: The lead's wrap-up names leftover trees

**Depends on:** none

Effort chunk: "Decide: should the lead's wrap-up report leftover trees" — decided: no wake and no cleanup job for the lead (removal is deterministic engine work, and the lead can do nothing the engine can't); its end-of-run report lists them so its summary doesn't claim a clean finish.

**Files:**
- Modify: `pkg/jarvis/leadprompt.go:59` (the `run finished:` rule)
- Test: `pkg/jarvis/leadprompt_test.go` (append)

- [ ] **Step 1: Write the failing test** — append to `pkg/jarvis/leadprompt_test.go`:

```go
func TestRunFinishedReportNamesLeftoverWorktrees(t *testing.T) {
	rules := OrchestrationRules("run-1", "", "")
	if !strings.Contains(rules, "worktrees left behind (tasks whose status shows retry-cleanup)") {
		t.Fatalf("the run-finished report must list leftover worktrees:\n%s", rules)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `go test ./pkg/jarvis/ -run TestRunFinishedReportNamesLeftoverWorktrees -v`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `pkg/jarvis/leadprompt.go:59`, change the report list:

```go
	b.WriteString("- run finished: review what landed with `wsh jarvis dag status`, and fix and commit what the landed tasks left behind (a stale doc line, an orphaned file). Write the report (landed, unverified, answered, forwarded, worktrees left behind (tasks whose status shows retry-cleanup), what needs a live check) to a file. Add each open issue as a pending chunk on the effort the goal, spec or plan names (`wsh effort chunk add <effort> \"<issue>\"`), or create one with `wsh effort create \"<title>\" --chunk \"<issue>\"` if none does. ")
```

- [ ] **Step 4: Run the package tests**

Run: `go test ./pkg/jarvis/`
Expected: PASS (fix any golden/contains test that pinned the old sentence).

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvis/leadprompt.go pkg/jarvis/leadprompt_test.go
git commit -m "feat(jarvis): lead's run report lists worktrees left behind"
```

---

### Task 6: Wake the lead when a worker ends its turn without completing, or dies

**Depends on:** none

Effort chunk: "Wake the lead when a worker ends its turn without completing".

Why (run `28caa81f` t-4): the worker committed, its `wsh jarvis complete` got `EC-TIME`, it ended its turn at 09:27:31Z, and no `task-stalled` event followed until the human prompted the lead at 09:52:42Z. Two gaps:
1. `childStillWorking` (`pkg/orchestrate/liveness.go:200`) counts any CPU change as work. An idle claude at its prompt used ~110 ms of CPU per 20 s (measured 2026-09-24 on idle reviewer PIDs), so an idle worker never stalls.
2. Even with that fixed, the transcript is fresh when the turn ends, so the stall waits `StallThreshold` (15 min). The Stop hook already publishes `agent:status` `idle` for the worker's block; the engine never reads it for workers.
3. `hungWake` returns `""` for a worker whose process is gone, trusting the exit hook — but a task still `running` at stall time is proof the exit hook missed it (reboot, lost exit event). Nobody is told.

**Files:**
- Modify: `pkg/orchestrate/liveness.go` (constants, `childStillWorking`, new `workerTurnEndedAt`, `turnEndedPast`, `hungWake`)
- Modify: `pkg/orchestrate/wake.go` (`latestAgentStatus` beside `latestAgentState`)
- Modify: `pkg/orchestrate/engine.go` (the stall check at ~line 351 and the stalled block at ~line 388)
- Modify: `pkg/orchestrate/queue.go` (two wake lines)
- Test: `pkg/orchestrate/liveness_test.go` (refactor `seedQuietChild`, append tests, update one case)

**Interfaces:**
- Produces: `const TurnEndedGrace = 3 * time.Minute`; `const IdleCPUShare = 0.05`; `var workerTurnEndedAt func(ctx context.Context, run *waveobj.Run) int64`; `func turnEndedPast(ctx context.Context, run *waveobj.Run, now int64) bool`; `func latestAgentStatus(blockId, tabId string) baseds.AgentStatusData`; `func taskTurnEndedWake(taskID string) string`; `func taskWorkerGoneWake(taskID string) string`.

- [ ] **Step 1: Refactor the test seed** — in `pkg/orchestrate/liveness_test.go`, turn `seedQuietChild` into a wrapper so tests can seed a fresh transcript and read the fake lead's wakes:

```go
// seedQuietChild records a running pi child whose transcript last moved past StallThreshold ago, under a
// live lead so a stall stays a stall. It returns the dag and the transcript's mtime.
func seedQuietChild(t *testing.T, name string) (context.Context, *waveobj.TaskGroup, int64) {
	ctx, g, _ := seedChildWrittenAt(t, name, time.Now().Add(-StallThreshold-time.Minute))
	return ctx, g, g.Tasks[0].LastActivity
}

// seedChildWrittenAt records a running pi child whose transcript last moved at lastWrite, under a live lead,
// and returns the fake lead so a test can read the wakes it was sent.
func seedChildWrittenAt(t *testing.T, name string, lastWrite time.Time) (context.Context, *waveobj.TaskGroup, *fakeLead) {
	t.Helper()
	allowWorkerHarnessForTest(t)
	f := newFakeLead(t)
	f.state.Alive = true
	root := t.TempDir()
	stubSessionsRoot(t, root)
	writePiSession(t, root, liveSession, lastWrite)
	ctx, g, channelID, _ := seedDispatchDag(t, name)
	child := jarvis.NewRun("child", "ws-1", t.TempDir(), nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), lastWrite.UnixMilli())
	child.Runtime = "pi"
	child.DagORef = g.OID
	child.SessionId = liveSession
	if err := wstore.AppendRun(ctx, channelID, child); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[0].RunID = child.ID
		cur.Tasks[0].State = TaskState_Running
		cur.Tasks[0].LastActivity = lastWrite.UnixMilli()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	g.Tasks[0].LastActivity = lastWrite.UnixMilli()
	prevBlock := workerBlockFn
	workerBlockFn = func(context.Context, *waveobj.Run) (string, bool) { return "worker-block", true }
	t.Cleanup(func() { workerBlockFn = prevBlock })
	return ctx, g, f
}

func stubTurnEnded(t *testing.T, at int64) {
	t.Helper()
	prev := workerTurnEndedAt
	workerTurnEndedAt = func(context.Context, *waveobj.Run) int64 { return at }
	t.Cleanup(func() { workerTurnEndedAt = prev })
}
```

`seedQuietChild`'s callers use its third return as the transcript mtime; keep that meaning (it reads the seeded `LastActivity`, which is `lastWrite`). Check `seedDispatchDag` returns the dag by pointer so the `g.Tasks[0].LastActivity` write is harmless; if `g` is re-read by the first tick anyway, drop that line.

Run: `go test ./pkg/orchestrate/ -run 'Stall|Busy|Idle|CPU' -v` — Expected: PASS (pure refactor).

- [ ] **Step 2: Write the failing tests** — append to `pkg/orchestrate/liveness_test.go`:

```go
// An idle harness at its prompt still ticks: about 110ms in 20s on an idle claude (measured 2026-09-24). Only
// CPU above IdleCPUShare of a core is work; a lower total means a child in the tree exited, which is activity.
func TestIdleHarnessCPUTrickleIsNotWork(t *testing.T) {
	prev := workerBlockFn
	workerBlockFn = func(context.Context, *waveobj.Run) (string, bool) { return "worker-block", true }
	t.Cleanup(func() { workerBlockFn = prev })
	now := time.Now().UnixMilli()
	cases := []struct {
		name    string
		next    int64
		elapsed int64
		want    bool
	}{
		{"idle claude's trickle", 5_110, 20_000, false},
		{"a test run", 15_000, 20_000, true},
		{"a child in the tree exited", 4_000, 20_000, true},
		{"flat CPU in the same millisecond", 5_000, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stubChildCPU(t, func(int) (int64, bool) { return tc.next, true })
			task := waveobj.TaskNode{CPUSample: 5_000, CPUSampleTs: now - tc.elapsed}
			if got := childStillWorking(context.Background(), &task, &waveobj.Run{}, now); got != tc.want {
				t.Fatalf("childStillWorking = %v, want %v", got, tc.want)
			}
		})
	}
}

// Run 28caa81f's t-4: its complete timed out, it ended its turn, and the lead heard nothing for 25 minutes,
// because its transcript was fresh and an idle claude's CPU read as work.
func TestWorkerThatEndedItsTurnWakesTheLead(t *testing.T) {
	ctx, g, f := seedChildWrittenAt(t, "turn-ended", time.Now().Add(-4*time.Minute))
	stubTurnEnded(t, time.Now().Add(-4*time.Minute).UnixMilli())
	stubChildCPU(t, func(int) (int64, bool) { return 5_000, true })

	if task := tick(t, ctx, g); task.State != TaskState_Running {
		t.Fatalf("the first CPU reading is only a baseline, got %s", task.State)
	}
	if task := tick(t, ctx, g); task.State != TaskState_Stalled {
		t.Fatalf("a worker idle past TurnEndedGrace with flat CPU stalls, got %s", task.State)
	}
	if want := []string{taskTurnEndedWake("t-0")}; !reflect.DeepEqual(f.sends, want) {
		t.Fatalf("want wakes %q, got %q", want, f.sends)
	}
}

func TestWorkerJustAfterItsTurnIsLeftAlone(t *testing.T) {
	ctx, g, f := seedChildWrittenAt(t, "turn-just-ended", time.Now().Add(-30*time.Second))
	stubTurnEnded(t, time.Now().Add(-30*time.Second).UnixMilli())
	stubChildCPU(t, func(int) (int64, bool) { return 5_000, true })
	tick(t, ctx, g)
	if task := tick(t, ctx, g); task.State != TaskState_Running || len(f.sends) != 0 {
		t.Fatalf("inside TurnEndedGrace the worker is left alone, got %s and wakes %q", task.State, f.sends)
	}
}

// a turn can end on a background test run: Claude is idle, its process tree is not
func TestTurnEndedOnABackgroundTestIsNotStalled(t *testing.T) {
	ctx, g, f := seedChildWrittenAt(t, "turn-ended-busy", time.Now().Add(-4*time.Minute))
	stubTurnEnded(t, time.Now().Add(-4*time.Minute).UnixMilli())
	stubChildCPU(t, func(call int) (int64, bool) { return int64(call) * 60_000, true })
	tick(t, ctx, g)
	if task := tick(t, ctx, g); task.State != TaskState_Running || len(f.sends) != 0 {
		t.Fatalf("a busy process tree keeps the task running, got %s and wakes %q", task.State, f.sends)
	}
}
```

And in `TestStalledTaskWakesLeadOnlyWhenWorkerIsHung`, change the `hung-exited` case's expectation (a task still running when its process is gone means the exit hook missed it):

```go
		{"hung-exited", false, false, blockcontroller.Status_Done, []string{"wake: task t-0's worker exited without reporting complete. wsh jarvis dag status"}},
```

Rename that test to `TestStalledTaskWakesLeadUnlessWorkerIsAsking` and update its doc comment to: "A stalled task is the lead's judgment unless its worker is waiting on an answer, which belongs to the question queue. A worker whose process is gone while its task still runs was missed by the exit path, so the lead hears of it."

- [ ] **Step 3: Run them and watch them fail**

Run: `go test ./pkg/orchestrate/ -run 'IdleHarness|EndedItsTurn|JustAfterItsTurn|BackgroundTest|WakesLeadUnless' -v`
Expected: FAIL to compile — `undefined: workerTurnEndedAt`, `undefined: taskTurnEndedWake`.

- [ ] **Step 4: Add the wake lines** — in `pkg/orchestrate/queue.go`, beside `taskHungWake`:

```go
// taskTurnEndedWake is for a worker idle at its prompt with its run still open: its complete may not have
// landed (an EC-TIME), or it stopped on a question asked in prose. Only its last message says which.
func taskTurnEndedWake(taskID string) string {
	return fmt.Sprintf("wake: task %s's worker ended its turn without completing and is idle; its complete may not have landed or it stopped on a question. wsh jarvis dag status", taskID)
}

// taskWorkerGoneWake is for a worker whose process is gone while its task still runs: the exit hook that would
// have failed or retried it never fired (a reboot, a lost exit event).
func taskWorkerGoneWake(taskID string) string {
	return fmt.Sprintf("wake: task %s's worker exited without reporting complete. wsh jarvis dag status", taskID)
}
```

The test's `hung-exited` string must equal `taskWorkerGoneWake("t-0")`; you may write the case as `[]string{taskWorkerGoneWake("t-0")}` instead of the literal.

- [ ] **Step 5: Read the worker's own status** — in `pkg/orchestrate/wake.go`, split `latestAgentState`:

```go
// latestAgentState is the newest state reported for the lead. Hooks report on the block, but a reporter
// may use the tab, so both scopes are read and the later report wins.
func latestAgentState(blockId, tabId string) string {
	return latestAgentStatus(blockId, tabId).State
}

// latestAgentStatus is the newest status reported for a block or its tab, zero when there is none.
func latestAgentStatus(blockId, tabId string) baseds.AgentStatusData {
	var best baseds.AgentStatusData
	scopes := []string{waveobj.MakeORef(waveobj.OType_Block, blockId).String(), waveobj.MakeORef(waveobj.OType_Tab, tabId).String()}
	for _, scope := range scopes {
		for _, ev := range wps.Broker.ReadEventHistory(wps.Event_AgentStatus, scope, 1) {
			var d baseds.AgentStatusData
			if utilfn.ReUnmarshal(&d, ev.Data) == nil && d.State != "" && d.Ts >= best.Ts {
				best = d
			}
		}
	}
	return best
}
```

- [ ] **Step 6: Liveness changes** — in `pkg/orchestrate/liveness.go`, add near `StallThreshold`:

```go
// TurnEndedGrace is how long a worker may sit idle after its turn ends, with its run still open, before the
// engine stops counting it as working. Its `wsh jarvis complete` lands before the Stop hook fires, so this only
// covers an auto-compaction's brief idle inside a turn and hook delivery lag.
const TurnEndedGrace = 3 * time.Minute

// IdleCPUShare is the share of one core a worker's process tree must use between two samples to count as
// working. An idle claude at its prompt still ticks (about 0.5% of a core, measured 2026-09-24), so counting
// any change kept a finished worker "working" forever; a build or a test run is far above this.
const IdleCPUShare = 0.05
```

Replace the tail of `childStillWorking` (from `prev, hadBaseline := ...`) with:

```go
	prev, prevTs := t.CPUSample, t.CPUSampleTs
	t.CPUSample, t.CPUSampleTs = cpu, now
	if prevTs == 0 {
		return true
	}
	// a lower total means a child in the tree exited, which is activity; a rise counts only above an idle
	// harness's own ticking
	if delta := cpu - prev; delta < 0 || (delta > 0 && float64(delta) >= IdleCPUShare*float64(now-prevTs)) {
		t.LastActivity = now
		return true
	}
	return false
```

and update its doc comment's last sentences: "A total that fell counts as activity, because a child that finished and exited lowers the tree's sum; a rise counts only above IdleCPUShare, because an idle harness at its prompt still ticks."

Add below `workerControllerGone`:

```go
// workerTurnEndedAt is when a worker last reported its turn over (the Stop hook's idle), 0 while its latest
// report is anything else or it has none. A var so tests can script it.
var workerTurnEndedAt = func(ctx context.Context, run *waveobj.Run) int64 {
	blockId, _ := workerBlockFn(ctx, run)
	if blockId == "" {
		return 0
	}
	st := latestAgentStatus(blockId, runTabID(run))
	if st.State != baseds.AgentState_Idle {
		return 0
	}
	return st.Ts
}

// turnEndedPast reports a worker idle at its prompt for longer than TurnEndedGrace.
func turnEndedPast(ctx context.Context, run *waveobj.Run, now int64) bool {
	ended := workerTurnEndedAt(ctx, run)
	return ended > 0 && now-ended > TurnEndedGrace.Milliseconds()
}
```

Rewrite `hungWake`:

```go
// hungWake is the judgment line for a task that just stalled, or "" when its worker is waiting on an answer,
// which belongs to the question queue. Every other stalled worker is the lead's: one whose process never
// started, one whose process is gone while its task still runs (the exit path missed it), one idle at its
// prompt with its run still open, and one alive and silent.
func hungWake(ctx context.Context, taskID string, run *waveobj.Run, silentMs int64) string {
	blockId, alive := workerBlockFn(ctx, run)
	if !alive {
		if shellStuckStarting(blockId) {
			return taskNeverStartedWake(taskID, silentMs/time.Minute.Milliseconds())
		}
		return taskWorkerGoneWake(taskID)
	}
	if _, asking := agentask.GlobalRegistry.Get(waveobj.MakeORef(waveobj.OType_Block, blockId).String()); asking {
		return ""
	}
	if workerTurnEndedAt(ctx, run) > 0 {
		return taskTurnEndedWake(taskID)
	}
	return taskHungWake(taskID, silentMs/time.Minute.Milliseconds())
}
```

Add `"github.com/wavetermdev/waveterm/pkg/baseds"` to `liveness.go`'s imports if missing.

- [ ] **Step 7: Engine changes** — in `pkg/orchestrate/engine.go`, replace the StallThreshold check (currently):

```go
		if t.State == TaskState_Running && t.LastActivity > 0 && now-t.LastActivity > StallThreshold.Milliseconds() &&
			!childStillWorking(ctx, t, runs[t.RunID], now) {
			t.State = TaskState_Stalled
		}
```

with:

```go
		// a worker whose turn ended with its run still open has nothing left to write, so its transcript can sit
		// fresh for all of StallThreshold while nobody hears of it (run 28caa81f's t-4). Its CPU still decides,
		// because a turn can end on a background test run.
		quiet := t.LastActivity > 0 && now-t.LastActivity > StallThreshold.Milliseconds()
		if t.State == TaskState_Running && (quiet || turnEndedPast(ctx, runs[t.RunID], now)) &&
			!childStillWorking(ctx, t, runs[t.RunID], now) {
			t.State = TaskState_Stalled
		}
```

In the stalled block (the `if t.State == TaskState_Stalled && prevStates[t.ID] == TaskState_Running {` loop), replace `retried := autoRetryStalled(ctx, g, taskID)` with:

```go
			// a worker that ended its turn may have finished (its complete lost to an EC-TIME): a retry would throw
			// its work away, so the lead judges it
			retried := workerTurnEndedAt(ctx, runs[t.RunID]) == 0 && autoRetryStalled(ctx, g, taskID)
```

- [ ] **Step 8: Run the tests**

Run: `go test ./pkg/orchestrate/ -v -run 'Stall|Busy|Idle|CPU|Turn|Hung|WakesLead|Liveness'`
Expected: PASS. Then the whole package: `go test ./pkg/orchestrate/` — Expected: PASS. If a wake-count test elsewhere now sees an extra `taskWorkerGoneWake`, read it: it is correct only if that test's task was still `running` with a dead worker; otherwise the test's worker stub must say alive.

- [ ] **Step 9: Commit**

```bash
git add pkg/orchestrate/liveness.go pkg/orchestrate/liveness_test.go pkg/orchestrate/wake.go pkg/orchestrate/engine.go pkg/orchestrate/queue.go
git commit -m "fix(orchestrate): wake the lead for a worker idle or gone without completing"
```

---

### Task 7: `wsh jarvis complete` survives a busy engine

**Depends on:** none

Effort chunk: "wsh jarvis complete survives a busy engine".

Why: `wsh jarvis complete` → `ReportRunPhaseCommand` → `AdvanceRunCommand` (`pkg/wshrpc/wshserver/wshserver_runs.go:535`) with the default 5 s budget (`wshutil.DefaultTimeoutMs`), and the server's work is cancelled with it. The handler persists the run, then calls `orchestrate.Schedule` synchronously — a whole tick that can merge, run Setup and spawn (t-7's spawn took 15 s). t-4's call at 09:27:08Z got `EC-TIME` and its `phase-complete` row never appeared until the resend at 09:52:47Z, so the write itself did not land in time either (the tick was busy writing too). The review-verdict path already solved the same problem by scheduling off the RPC (`wshserver_dag.go`, `case "review-pass", "review-fail"`).

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (`AdvanceRunCommand`, the "engine-owned DAGs" block)
- Modify: `cmd/wsh/cmd/wshcmd-jarvis.go` (`reportRunPhase`)

- [ ] **Step 1: Schedule off the RPC** — in `AdvanceRunCommand`, replace:

```go
		if grp, gerr := orchestrate.GroupForRun(ctx, run.ChannelOID, run.ID); gerr == nil {
			if serr := orchestrate.Schedule(ctx, grp.OID); serr != nil {
				log.Printf("dag schedule error: %v", serr)
			}
		}
```

with:

```go
		if grp, gerr := orchestrate.GroupForRun(ctx, run.ChannelOID, run.ID); gerr == nil {
			// the transition is durable; the tick it pokes can merge, run Setup and spawn, which outlasts the
			// child's RPC budget and reads to the child as a failed complete (run 28caa81f's t-4)
			dagID := grp.OID
			go func() {
				if serr := orchestrate.Schedule(context.Background(), dagID); serr != nil {
					log.Printf("dag schedule error: %v", serr)
				}
			}()
		}
```

Check the second `orchestrate.Schedule(ctx, grp.OID)` call near line 778 (a different handler): leave it unless it is also reached from `wsh jarvis complete`; note what you found in the commit body.

- [ ] **Step 2: Give complete a budget a busy store can meet** — in `cmd/wsh/cmd/wshcmd-jarvis.go`:

```go
func reportRunPhase(data wshrpc.CommandReportRunPhaseData) error {
	// the server's write is cancelled with the client's budget, and the store can be busy behind an engine tick
	// for longer than the 5s default; a lost complete leaves the task running with nobody told
	return wshclient.ReportRunPhaseCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 30_000})
}
```

Keep whatever the function body did before the `return` (read it first; the plan shows only the return line changing).

- [ ] **Step 3: Build and test**

Run: `go build ./cmd/... && go test ./pkg/wshrpc/... ./cmd/wsh/...`
Expected: PASS. There is no unit test for this task: `orchestrate.Schedule` is a package function, not a seam, and the timeout is a constant. The behaviour it protects is covered from the other side by Task 6 (a lost complete now reaches the lead within `TurnEndedGrace`).

- [ ] **Step 4: Commit**

```bash
git add pkg/wshrpc/wshserver/wshserver_runs.go cmd/wsh/cmd/wshcmd-jarvis.go
git commit -m "fix(jarvis): keep a worker's complete from timing out on a busy engine"
```

---

### Task 8: Clear run 28caa81f's cleanup flags

**Depends on:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7

Effort chunk "Clear run 28caa81f's leftover trees and idle reviewer sessions" is already done: on 2026-09-24 the run's lead, with the human's approval, stopped the five reviewer sessions by PID, removed the empty worktree directories and deleted the `wave/*` branches. What is left is the dag's own record: t-2, t-3, t-5, t-6 and t-7 still carry `CleanupError` with their attempts spent, so the run reads `needs-you` (`wsh runs show 28caa81f-746c-4ff3-8901-5ab676ea984e`). Not engine work — do it by hand after the branch is merged and a build with Task 3 is what the packaged Arc runs.

- [ ] **Step 1: Retry each task's cleanup** — the trees are gone, so `RemoveRunWorktree` finds nothing and succeeds. `wsh jarvis dag` resolves the run from the terminal it runs in, so run these from the run's lead terminal (or pass the run explicitly if `wsh jarvis dag retry-cleanup --help` offers a flag for it):

```bash
for n in 2 3 5 6 7; do wsh jarvis dag retry-cleanup t-$n; done
```

- [ ] **Step 2: Confirm** — `wsh runs show 28caa81f-746c-4ff3-8901-5ab676ea984e` shows no `retry-cleanup` column entries, and the run rail no longer says "Cleanup failed".

- [ ] **Step 3: Tick the effort** — `wsh effort chunk status ad5ab3e7-8f54-423c-b38b-2af04a47daaf "<chunk>" done --note "<commit>"` for each chunk this plan finished, one at a time, only after its task's commit landed.
