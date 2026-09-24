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
	"github.com/wavetermdev/waveterm/pkg/agentask"
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
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Pass, "adds fmtDate with tests", "", nil); err != nil {
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
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Pass, "adds fmtDate", "fmtDate lives in\nutil/date.go", nil); err != nil {
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
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Fail, "misses the empty-input case", "", nil); err != nil {
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
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Fail, "still misses it", "", nil); err != nil {
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
	addTask(t, ctx, dag, waveobj.TaskNode{ID: "t-1", Label: "b", State: TaskState_Pending, Deps: []string{"t-0"}})
	cases := []struct {
		name, run, verdict, note, downstream string
		downstreamFor                        []string
	}{
		{"not the reviewer", worker.ID, ReviewVerdict_Pass, "ok", "", nil},
		{"unknown verdict", reviewer, "maybe", "ok", "", nil},
		{"no note", reviewer, ReviewVerdict_Fail, "  ", "", nil},
		{"downstream on a fail", reviewer, ReviewVerdict_Fail, "bad", "later", nil},
		{"targets without a note", reviewer, ReviewVerdict_Pass, "ok", "", []string{"t-1"}},
		{"an unknown target", reviewer, ReviewVerdict_Pass, "ok", "later", []string{"t-9"}},
		{"the reviewed task as its own target", reviewer, ReviewVerdict_Pass, "ok", "later", []string{"t-0"}},
	}
	for _, c := range cases {
		if err := RecordReviewVerdict(ctx, dag.OID, c.run, c.verdict, c.note, c.downstream, c.downstreamFor); err == nil {
			t.Fatalf("%s: want an error", c.name)
		}
	}
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Pass, "ok", "", nil); err != nil {
		t.Fatal(err)
	}
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Fail, "changed my mind", "", nil); err == nil {
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
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Pass, "looks fine", "", nil); err != nil {
		t.Fatal(err)
	}
	schedule(t, ctx, dag.OID)
	task := firstTask(t, ctx, dag.OID)
	if task.State != TaskState_ReviewFailed || !strings.Contains(task.ReviewNote, "reviewer modified the worktree") || *resets != 1 || task.ReviewVerdict != "" {
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

// a worker that reports no commit skips review and lands as done, so the lead hears it on its next wake: a task that did
// nothing and one that committed but never said so both read as done otherwise
func TestWorkerWithoutACommitTellsTheLeadQuietly(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	if err := wstore.UpdateRun(ctx, dag.ChannelId, worker.ID, func(r *waveobj.Run) error {
		r.EndCommit = ""
		r.Evidence = &waveobj.RunEvidence{Summary: "Nothing to change: fmtDate already exists."}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	calls := captureSpawns(t)
	f := newFakeLead(t)
	schedule(t, ctx, dag.OID)
	if got := firstTask(t, ctx, dag.OID); got.State != TaskState_Done || len(*calls) != 0 {
		t.Fatalf("no commit skips review, got state %s and %d spawns", got.State, len(*calls))
	}
	want := "Since your last wake:\nt-0 finished without reporting a commit: Nothing to change: fmtDate already exists."
	if !strings.Contains(strings.Join(f.sends, "\n"), want) {
		t.Fatalf("want the quiet line %q, got %q", want, f.sends)
	}
}

// addTask puts another task in a seeded dag.
func addTask(t *testing.T, ctx context.Context, dag *waveobj.TaskGroup, task waveobj.TaskNode) {
	t.Helper()
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks = append(g.Tasks, task)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// passWithDownstream reviews t-0 and passes it with a note for the named tasks.
func passWithDownstream(t *testing.T, ctx context.Context, dag *waveobj.TaskGroup, downstreamFor ...string) {
	t.Helper()
	schedule(t, ctx, dag.OID)
	reviewer := firstTask(t, ctx, dag.OID).ReviewRunID
	if err := RecordReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Pass, "adds fmtDate", "fmtDate lives in util/date.go", downstreamFor); err != nil {
		t.Fatal(err)
	}
	schedule(t, ctx, dag.OID)
}

func taskNamed(t *testing.T, ctx context.Context, dagID, id string) waveobj.TaskNode {
	t.Helper()
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		t.Fatal(err)
	}
	return *taskByID(g, id)
}

// a note for a task that has not started goes into its prompt without the lead: in run ad78cbcb the lead knew what
// t-3 needed 14 minutes before t-3 started, and t-3 never heard it
func TestReviewDownstreamForAPendingTaskAmendsItWithoutWakingTheLead(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	addTask(t, ctx, dag, waveobj.TaskNode{ID: "t-1", Label: "b", State: TaskState_Pending, Deps: []string{"t-0"}})
	stubReviewTree(t, worker.EndCommit)
	captureSpawns(t)
	f := newFakeLead(t)
	passWithDownstream(t, ctx, dag, "t-1")
	if got := taskNamed(t, ctx, dag.OID, "t-1").LeadNotes; len(got) != 1 || got[0] != "t-0's reviewer: fmtDate lives in util/date.go" {
		t.Fatalf("want the note in t-1's prompt, got %q", got)
	}
	if strings.Contains(strings.Join(f.sends, "\n"), "note for later tasks") {
		t.Fatalf("a routed note must not wake the lead, got %q", f.sends)
	}
	if f.countKind(waveobj.RunEventKindTaskAmended) != 1 {
		t.Fatal("want one task-amended row")
	}
	PostWake(ctx, dag.ChannelId, dag.RunID, "wake: next")
	if want := "t-0's review note reached t-1 (added to its prompt): fmtDate lives in util/date.go"; !strings.Contains(strings.Join(f.sends, "\n"), want) {
		t.Fatalf("the lead's next wake must carry %q, got %q", want, f.sends)
	}
}

func TestReviewDownstreamForARunningTaskTypesItToTheWorker(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	other := jarvis.NewRun("other goal", "ws-1", t.TempDir(), nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	other.DagORef = dag.OID
	if err := wstore.AppendRun(ctx, dag.ChannelId, other); err != nil {
		t.Fatal(err)
	}
	addTask(t, ctx, dag, waveobj.TaskNode{ID: "t-1", Label: "b", State: TaskState_Running, RunID: other.ID})
	old := runBlockORefs
	runBlockORefs = func(_ context.Context, r *waveobj.Run) []string {
		if r.ID != other.ID {
			return nil
		}
		return []string{waveobj.MakeORef(waveobj.OType_Block, "11111111-1111-1111-1111-111111111111").String()}
	}
	t.Cleanup(func() { runBlockORefs = old })
	stubReviewTree(t, worker.EndCommit)
	captureSpawns(t)
	f := newFakeLead(t)
	passWithDownstream(t, ctx, dag, "t-1")
	want := "t-0 passed review with a note for your task: fmtDate lives in util/date.go"
	if !strings.Contains(strings.Join(f.sends, "\n"), want) {
		t.Fatalf("want %q typed to t-1's worker, got %q", want, f.sends)
	}
	if got := taskNamed(t, ctx, dag.OID, "t-1").LeadTold; len(got) != 1 || got[0] != want {
		t.Fatalf("the typed note must not read as the human's, got %q", got)
	}
}

// a note the engine cannot deliver stays the lead's, as before
func TestReviewDownstreamForAFinishedTaskWakesTheLead(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	addTask(t, ctx, dag, waveobj.TaskNode{ID: "t-1", Label: "b", State: TaskState_Done})
	stubReviewTree(t, worker.EndCommit)
	captureSpawns(t)
	f := newFakeLead(t)
	passWithDownstream(t, ctx, dag, "t-1")
	want := "wake: task t-0 passed review with a note for later tasks (not delivered to t-1, which is done): fmtDate lives in util/date.go. wsh jarvis dag status"
	if !strings.Contains(strings.Join(f.sends, "\n"), want) {
		t.Fatalf("want %q, got %q", want, f.sends)
	}
}

// the reviewer can only name a task it knows exists, so its brief lists the ones a note can still reach
func TestReviewerIsToldWhichTasksANoteCanReach(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	addTask(t, ctx, dag, waveobj.TaskNode{ID: "t-1", Label: "b", State: TaskState_Pending, Deps: []string{"t-0"}})
	addTask(t, ctx, dag, waveobj.TaskNode{ID: "t-2", Label: "c", State: TaskState_Done})
	stubReviewTree(t, worker.EndCommit)
	calls := captureSpawns(t)
	schedule(t, ctx, dag.OID)
	if len(*calls) != 1 {
		t.Fatalf("want the reviewer spawned, got %d spawns", len(*calls))
	}
	p := (*calls)[0].prompt
	if !strings.Contains(p, "Tasks not finished yet, which --for can name: t-1 (b).") {
		t.Fatalf("the brief must list t-1 alone, got %q", p)
	}
}

// a worker waiting on its question has a picker open, which a typed note and its enter would answer
func TestReviewDownstreamSkipsAWorkerWaitingOnAQuestion(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	other := jarvis.NewRun("other goal", "ws-1", t.TempDir(), nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	other.DagORef = dag.OID
	if err := wstore.AppendRun(ctx, dag.ChannelId, other); err != nil {
		t.Fatal(err)
	}
	addTask(t, ctx, dag, waveobj.TaskNode{ID: "t-1", Label: "b", State: TaskState_Running, RunID: other.ID})
	block := waveobj.MakeORef(waveobj.OType_Block, "11111111-1111-1111-1111-111111111111").String()
	old := runBlockORefs
	runBlockORefs = func(_ context.Context, r *waveobj.Run) []string {
		if r.ID != other.ID {
			return nil
		}
		return []string{block}
	}
	t.Cleanup(func() { runBlockORefs = old })
	stubReviewTree(t, worker.EndCommit)
	captureSpawns(t)
	f := newFakeLead(t)
	agentask.GlobalRegistry.Set(block, agentask.PendingAsk{AskId: "a1", BlockId: "11111111-1111-1111-1111-111111111111"})
	passWithDownstream(t, ctx, dag, "t-1")
	joined := strings.Join(f.sends, "\n")
	if strings.Contains(joined, "a note for your task") {
		t.Fatalf("nothing may be typed into a worker's open question, got %q", f.sends)
	}
	if !strings.Contains(joined, "(not delivered to t-1, which is waiting on a question)") {
		t.Fatalf("the lead must be woken to route it, got %q", f.sends)
	}
}
