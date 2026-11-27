// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/memgate"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// gateWait bounds a call that must not wait at the gate: past it, the call is taken to be held.
const gateWait = 2 * time.Minute

// cleanBook releases what earlier tests bound and fails unless the book is then empty.
func cleanBook(t *testing.T) {
	t.Helper()
	releaseBoundClaims()
	if n := memgate.LiveClaimsForTest(); n != 0 {
		t.Fatalf("the gate's book holds %d claims before the test", n)
	}
}

// refuseAllMemory makes the gate refuse every tree: nothing free, and a claim in the book so the one-tree-always-
// starts rule does not apply. It returns that claim; releasing it empties the book.
func refuseAllMemory(t *testing.T) *memgate.Claim {
	t.Helper()
	cleanBook(t)
	blocker, ok := memgate.TryAdmit(memgate.Request{Tag: memgate.Tag{Role: "test"}})
	if !ok {
		t.Fatal("an empty book must admit")
	}
	restore := memgate.SetFreeForTest(func() (uint64, error) { return 0, nil })
	t.Cleanup(func() {
		restore()
		blocker.Release()
	})
	return blocker
}

// collectMemoryEvents writes gate events to the run log for the test.
func collectMemoryEvents(t *testing.T) {
	t.Helper()
	memgate.SetEventSink(RecordMemoryEvent)
	t.Cleanup(func() { memgate.SetEventSink(nil) })
}

// seedReadyDag stores a dag of n independent ready tasks that may all run at once.
func seedReadyDag(t *testing.T, n int) (context.Context, *waveobj.TaskGroup, string, string) {
	t.Helper()
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "memgate-"+t.Name(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	var tasks []waveobj.TaskNode
	for i := range n {
		tasks = append(tasks, waveobj.TaskNode{ID: fmt.Sprintf("t-%d", i), Label: "task"})
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", n, false, tasks, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	return ctx, &g, ch.OID, owner.ID
}

// heldTaskIDs are the tasks with a memory-held event on the run, once n have arrived (or the wait ran out).
func heldTaskIDs(t *testing.T, channelID, runID string, n int) map[string]bool {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		held := map[string]bool{}
		for _, ev := range lifecycleEvents(t, channelID, runID) {
			if ev.Kind == waveobj.RunEventKindMemoryHeld {
				held[eventDetail(t, []waveobj.RunEvent{ev}, ev.Kind)["taskid"].(string)] = true
			}
		}
		if len(held) >= n || time.Now().After(deadline) {
			return held
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// ownerRun is the dag owner's run, which keys a worker's request to its project.
func ownerRun(t *testing.T, ctx context.Context, channelID, runID string) *waveobj.Run {
	t.Helper()
	owner, err := wstore.GetRun(ctx, channelID, runID)
	if err != nil {
		t.Fatal(err)
	}
	return owner
}

func TestClaimWorkersStopsAtMemory(t *testing.T) {
	allowWorkerHarnessForTest(t)
	cleanBook(t)
	collectMemoryEvents(t)
	ctx, g, channelID, runID := seedReadyDag(t, 3)
	// the first worker starts on an empty book; its starting estimate leaves less than another for the next
	need := memgate.Estimate(workerRequest(g, ownerRun(t, ctx, channelID, runID), "t-0").Key)
	defer memgate.SetFreeForTest(func() (uint64, error) { return need + need/2, nil })()
	spawns := 0
	old := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		spawns++
		return "tab:worker", nil
	}
	restoreAfterStages(t, func() { spawnWorker = old })

	if err := ScheduleOnce(ctx, g); err != nil {
		t.Fatal(err)
	}
	if spawns != 1 {
		t.Fatalf("memory for one worker started %d", spawns)
	}
	for i, want := range []string{TaskState_Running, TaskState_Pending, TaskState_Pending} {
		if g.Tasks[i].State != want {
			t.Fatalf("task %s is %s, want %s", g.Tasks[i].ID, g.Tasks[i].State, want)
		}
	}
	held := heldTaskIDs(t, channelID, runID, 2)
	if len(held) != 2 || !held["t-1"] || !held["t-2"] {
		t.Fatalf("held events for %v, want t-1 and t-2", held)
	}
}

// a tick that fails part-way releases every claim it took and did not bind, and leaves a started worker's
func TestUnboundClaimsReleasedAfterTick(t *testing.T) {
	allowWorkerHarnessForTest(t)
	cleanBook(t)
	ctx, g, _, _ := seedTwoTaskDispatchDag(t, "memgate-unbound")
	worker, _ := newWorkerTabWithBlock(t)
	orefs := []string{worker, "tab:worker-unrecorded"}
	oldSpawn, oldAppend, oldStop := spawnWorker, appendChildRun, stopSpawnedWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		oref := orefs[0]
		orefs = orefs[1:]
		return oref, nil
	}
	appends := 0
	appendChildRun = func(ctx context.Context, channelID string, run waveobj.Run) error {
		appends++
		if appends == 2 {
			return errors.New("child run persist failed")
		}
		return oldAppend(ctx, channelID, run)
	}
	stopSpawnedWorker = func(context.Context, string) error { return nil }
	restoreAfterStages(t, func() { spawnWorker, appendChildRun, stopSpawnedWorker = oldSpawn, oldAppend, oldStop })

	if err := Schedule(ctx, g.OID); err == nil {
		t.Fatal("want the persist failure returned")
	}
	if n := memgate.LiveClaimsForTest(); n != 1 {
		t.Fatalf("after the failed tick the book holds %d claims, want only the started worker's bound one", n)
	}
	releaseBoundClaims()
	if n := memgate.LiveClaimsForTest(); n != 0 {
		t.Fatalf("the book holds %d unbound claims after the tick", n)
	}
}

func TestSpawnFailureReleasesClaim(t *testing.T) {
	allowWorkerHarnessForTest(t)
	cleanBook(t)
	ctx, g, _, _ := seedDispatchDag(t, "memgate-spawn-fails")
	claimsAtSpawn := -1
	old := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		claimsAtSpawn = memgate.LiveClaimsForTest()
		return "", errors.New("no worker slot available")
	}
	restoreAfterStages(t, func() { spawnWorker = old })

	if err := ScheduleOnce(ctx, g); err != nil {
		t.Fatal(err)
	}
	if claimsAtSpawn != 1 {
		t.Fatalf("the spawn saw %d claims, want its own", claimsAtSpawn)
	}
	if n := memgate.LiveClaimsForTest(); n != 0 {
		t.Fatalf("a failed spawn left %d claims in the book", n)
	}
}

// a reviewer is progress: a lane's land waits on it, so memory may delay it (it counts) but never hold it
func TestIdleFinishedWorkerNeverBlocksItsReviewer(t *testing.T) {
	ctx, dag, worker := seedReviewDag(t)
	stubReviewTree(t, worker.EndCommit)
	calls := captureSpawns(t)
	_, blockID := newWorkerTabWithBlock(t)
	refuseAllMemory(t)
	// the worker's claim counts its estimate against free memory, which is already nothing
	bindToBlock(memgate.Admit(workerRequest(dag, &worker, "t-0")), blockID, nil)

	schedule(t, ctx, dag.OID)
	if task := firstTask(t, ctx, dag.OID); len(*calls) != 1 || task.ReviewRunID == "" {
		t.Fatalf("a worker's claim held its reviewer: %d spawns, reviewer %q", len(*calls), task.ReviewRunID)
	}
}

func TestStartingPlanCommandHoldsAWorker(t *testing.T) {
	allowWorkerHarnessForTest(t)
	cleanBook(t)
	ctx, g, channelID, runID := seedReadyDag(t, 1)
	owner := ownerRun(t, ctx, channelID, runID)
	verify := memgate.Key{Project: MemProjectKey(owner.ProjectPath), Role: PlanCmd_Verify}
	defer memgate.SetFreeForTest(func() (uint64, error) { return memgate.Estimate(verify) + 1<<30, nil })()
	cmd := admitPlanCommand(withRunCmdOwner(ctx, runID, PlanCmd_Verify, ""), owner.ProjectPath)
	if cmd == nil {
		t.Fatal("a Verify with a run owner takes a claim")
	}

	next, claims := claimWorkers(g, owner, []string{"t-0"})
	if len(next) != 0 {
		t.Fatalf("a starting Verify's estimate left room for a worker: %v", next)
	}
	cmd.Release()
	next, claims = claimWorkers(g, owner, []string{"t-0"})
	if len(next) != 1 {
		t.Fatalf("with the Verify's claim released the worker was not admitted: %v", next)
	}
	claims["t-0"].Release()
}

func TestWorkerRequestKeysItsProject(t *testing.T) {
	owner := &waveobj.Run{ProjectPath: t.TempDir()}
	g := &waveobj.TaskGroup{RunID: "run-" + uuid.NewString()}
	want := memgate.Key{Project: MemProjectKey(owner.ProjectPath), Role: memgate.RoleWorker}
	if got := workerRequest(g, owner, "t-0").Key; got != want {
		t.Fatalf("worker key = %+v, want %+v", got, want)
	}
}

// a detached tree's Setup runs before its command's claim is taken, so it takes none of its own
func TestDetachedTreeSetupTakesNoClaim(t *testing.T) {
	ctx := withRunCmdOwner(context.Background(), "run-"+uuid.NewString(), PlanCmd_Check, "")
	cleanBook(t)
	check := admitPlanCommand(ctx, t.TempDir())
	if check == nil {
		t.Fatal("precondition: a Check takes a claim")
	}
	check.Release()
	setupCtx := detachedSetupCtx(ctx)
	if claim := admitPlanCommand(setupCtx, t.TempDir()); claim != nil {
		t.Fatalf("a detached tree's Setup took a claim: %+v", claim)
	}
	if owner, _ := jobobject.OwnerFrom(setupCtx); owner.Cmd != PlanCmd_Setup {
		t.Fatalf("Setup's owner command = %q, want %q", owner.Cmd, PlanCmd_Setup)
	}
}

// a finished worker idles alive at its prompt until its lane lands, which waits on the review: its claim must leave
// the book once its run is done, so it no longer counts against the reviewer its lane waits on
func TestFinishedWorkerClaimDoesNotHoldItsReviewer(t *testing.T) {
	cleanBook(t)
	ctx, dag, worker := seedReviewDag(t)
	stubReviewTree(t, worker.EndCommit)
	calls := captureSpawns(t)
	tab, blockID := newWorkerTabWithBlock(t)
	if err := wstore.UpdateRun(ctx, dag.ChannelId, worker.ID, func(r *waveobj.Run) error {
		r.Phases[0].WorkerOrefs = []string{tab}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	claim, ok := memgate.TryAdmit(workerRequest(dag, &worker, "t-0"))
	if !ok {
		t.Fatal("an empty book must admit the worker")
	}
	bindToBlock(claim, blockID, nil)

	done, err := wstore.GetRun(ctx, dag.ChannelId, worker.ID)
	if err != nil {
		t.Fatal(err)
	}
	ReleaseRunClaims(ctx, done)
	if n := memgate.LiveClaimsForTest(); n != 0 {
		t.Fatalf("a done worker's claim stayed in the book: %d claims", n)
	}
	schedule(t, ctx, dag.OID)
	if task := firstTask(t, ctx, dag.OID); len(*calls) != 1 || task.ReviewRunID == "" {
		t.Fatalf("a done worker's reviewer did not start: %d spawns, reviewer %q", len(*calls), task.ReviewRunID)
	}
}

func TestWorkerCacheExpiry(t *testing.T) {
	root := t.TempDir()
	stubSessionsRoot(t, root)
	worktree := filepath.Join(t.TempDir(), "wt-t-0")
	wrote := time.Now().Add(-time.Minute).Truncate(time.Millisecond)
	writeClaudeSession(t, root, worktree, liveSession, wrote)

	run := &waveobj.Run{Runtime: "claude", ProjectPath: worktree, SessionId: liveSession}
	got, ok := workerCacheExpiry(run)
	if want := wrote.Add(5 * time.Minute); !ok || !got.Equal(want) {
		t.Fatalf("expiry = %v, %v; want %v, true", got, ok, want)
	}
	noSession := &waveobj.Run{Runtime: "claude", ProjectPath: worktree}
	if _, ok := workerCacheExpiry(noSession); ok {
		t.Fatal("a run with no session id has a known expiry")
	}
	noTranscript := &waveobj.Run{Runtime: "claude", ProjectPath: worktree, SessionId: siblingSession}
	if _, ok := workerCacheExpiry(noTranscript); ok {
		t.Fatal("a tracked run with no transcript yet has a known expiry")
	}
}

func TestDispatchBindsWorkerCacheExpiry(t *testing.T) {
	allowWorkerHarnessForTest(t)
	cleanBook(t)
	ctx, g, _, _ := seedDispatchDag(t, "memgate-expiry-worker")
	tab, _ := newWorkerTabWithBlock(t)
	old := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		return tab, nil
	}
	restoreAfterStages(t, func() { spawnWorker = old })

	if err := ScheduleOnce(ctx, g); err != nil {
		t.Fatal(err)
	}
	boundClaims.Lock()
	defer boundClaims.Unlock()
	if len(boundClaims.list) != 1 || !memgate.HasCacheExpiryForTest(boundClaims.list[0]) {
		t.Fatalf("the dispatched worker's bound claim has no cache expiry: %d bound claims", len(boundClaims.list))
	}
}

func TestReviewerBindsNoCacheExpiry(t *testing.T) {
	cleanBook(t)
	ctx, dag, worker := seedReviewDag(t)
	stubReviewTree(t, worker.EndCommit)
	calls := captureSpawns(t)
	tab, _ := newWorkerTabWithBlock(t)
	old := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		*calls = append(*calls, spawnCall{})
		return tab, nil
	}
	restoreAfterStages(t, func() { spawnWorker = old })

	schedule(t, ctx, dag.OID)
	boundClaims.Lock()
	defer boundClaims.Unlock()
	if len(*calls) != 1 || len(boundClaims.list) != 1 {
		t.Fatalf("%d reviewers spawned, %d claims bound; want one of each", len(*calls), len(boundClaims.list))
	}
	if memgate.HasCacheExpiryForTest(boundClaims.list[0]) {
		t.Fatal("a reviewer's claim carries a cache expiry, so the loop could pause it")
	}
}

// within gateWait, or the test fails as held
func within(t *testing.T, what string, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		fn()
	}()
	select {
	case <-done:
	case <-time.After(gateWait):
		t.Fatalf("%s waited at a gate that refuses everything", what)
	}
}

func TestPlanCommandNeverWaits(t *testing.T) {
	refuseAllMemory(t)
	ctx := withRunCmdOwner(context.Background(), "run-"+uuid.NewString(), PlanCmd_Verify, "")
	var out string
	var err error
	within(t, "the Verify", func() { out, err = execPlanCommandEnv(ctx, t.TempDir(), "echo ok", nil, 200*time.Millisecond, nil) })
	if err != nil {
		t.Fatalf("a plan command at a gate that refuses everything failed: %v (%s)", err, out)
	}
	if n := memgate.LiveClaimsForTest(); n != 1 {
		t.Fatalf("the book holds %d claims after the command, want only the blocker", n)
	}
}

// the 11-13 deadlock: a finished worker idling at its prompt kept its claim, and nothing else could start
func TestIdleFinishedWorkerNeverBlocksVerify(t *testing.T) {
	cleanBook(t)
	t.Cleanup(releaseBoundClaims)
	g := &waveobj.TaskGroup{RunID: "run-" + uuid.NewString()}
	worker, ok := memgate.TryAdmit(workerRequest(g, &waveobj.Run{}, "t-0"))
	if !ok {
		t.Fatal("an empty book must admit the worker")
	}
	bindToBlock(worker, uuid.NewString(), nil)
	defer memgate.SetFreeForTest(func() (uint64, error) { return 0, nil })()

	ctx := withRunCmdOwner(context.Background(), g.RunID, PlanCmd_Verify, "t-0")
	var out string
	var err error
	within(t, "the Verify", func() { out, err = execPlanCommandEnv(ctx, t.TempDir(), "echo ok", nil, time.Minute, nil) })
	if err != nil {
		t.Fatalf("Verify beside an idle worker's claim failed: %v (%s)", err, out)
	}
}

func TestMemProjectKeyFoldsWorktrees(t *testing.T) {
	repo := newGitRepo(t)
	worktree := filepath.Join(t.TempDir(), "wt")
	gitCmd(t, repo, "worktree", "add", "-b", "memgate-wt", worktree)
	project := MemProjectKey(repo)
	if project == "" || MemProjectKey(worktree) != project {
		t.Fatalf("worktree key %q does not fold to the project key %q", MemProjectKey(worktree), project)
	}
}

func TestLandAndBaseCheckNeverWait(t *testing.T) {
	repo := newGitRepo(t)
	commit := gitCmd(t, repo, "rev-parse", "HEAD")
	f, tree := landFixture(t)
	commitOnBranch(t, tree, "code.txt", "code\n")
	out := filepath.ToSlash(t.TempDir())
	f.setLandCommands(t, "echo check > "+out+"/check", "true")
	refuseAllMemory(t)

	var state, detail string
	within(t, "the base Check", func() {
		state, detail = runBaseCheck(context.Background(), "run-"+uuid.NewString(), repo, commit, "", "true")
	})
	if state != BaseCheckState_Passed {
		t.Fatalf("base Check %s: %s", state, detail)
	}
	var land *waveobj.RunLand
	var err error
	within(t, "the land", func() { land, err = LandRun(f.ctx, f.channel, f.ownerID, false) })
	if err != nil || land.State != LandState_Landed {
		t.Fatalf("land = %+v, %v; want landed", land, err)
	}
	if _, err := os.Stat(filepath.Join(out, "check")); err != nil {
		t.Fatalf("the land's Check did not run: %v", err)
	}
}

func TestDispatchSetupNeverWaits(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, "", "echo ok > setup-ran")
	var spawned []string
	stubSpawn(t, &spawned)
	cleanBook(t)
	// the worker is the one tree an empty book admits; a Setup that waited would never be let in after it
	defer memgate.SetFreeForTest(func() (uint64, error) { return 0, nil })()

	var err error
	within(t, "the dispatch", func() { err = Schedule(f.ctx, f.dagID) })
	if err != nil {
		t.Fatal(err)
	}
	wt := worktreeDir(f.project, TaskWorktreeKey(f.ownerID, "t-0"))
	if _, err := os.Stat(filepath.Join(wt, "setup-ran")); err != nil {
		t.Fatalf("Setup did not run: %v", err)
	}
	if len(spawned) != 1 {
		t.Fatalf("%d workers spawned, want 1", len(spawned))
	}
}

func TestKickHeldRunsTicksDag(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx, g, channelID, runID := seedDispatchDag(t, "memgate-kick")
	if err := wstore.UpdateRun(ctx, channelID, runID, func(r *waveobj.Run) error {
		r.DagORef = g.OID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	spawned := make(chan struct{}, 1)
	old := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		spawned <- struct{}{}
		return "tab:worker", nil
	}
	restoreAfterStages(t, func() { spawnWorker = old })

	KickHeldRuns([]string{"no-such-run", runID})
	select {
	case <-spawned:
	case <-time.After(10 * time.Second):
		t.Fatal("kicking the held run never ticked its dag")
	}
}

func TestRecordMemoryEventDetail(t *testing.T) {
	_, _, channelID, runID := seedDispatchDag(t, "memgate-event")
	const free, need = uint64(1) << 30, uint64(3) << 30
	RecordMemoryEvent(memgate.Event{Kind: memgate.EventHeld, Tag: memgate.Tag{RunId: runID, TaskId: "t-1", Role: memgate.RoleWorker}, Free: free, Need: need})
	detail := eventDetail(t, lifecycleEvents(t, channelID, runID), waveobj.RunEventKindMemoryHeld)
	if detail == nil {
		t.Fatal("no memory-held event on the run")
	}
	want := map[string]any{"taskid": "t-1", "role": memgate.RoleWorker, "free": float64(free), "need": float64(need)}
	for k, v := range want {
		if detail[k] != v {
			t.Fatalf("detail[%s] = %v, want %v (detail %v)", k, detail[k], v, detail)
		}
	}
}
