package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func seedPendingDag(t *testing.T) (context.Context, *waveobj.TaskGroup) {
	t.Helper()
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "mutation-seed", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
	}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	return ctx, &g
}

func TestScheduleSerializesSameDag(t *testing.T) {
	ctx, dag := seedPendingDag(t)
	allowWorkerHarnessForTest(t)

	entered := make(chan struct{})
	duplicateEntered := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	old := spawnWorker
	spawnWorker = func(ctx context.Context, cap runroute.Capability, workspaceId, projectName, cwd, prompt string, _ jarvis.RunWorkerOptions) (string, error) {
		switch calls.Add(1) {
		case 1:
			close(entered)
			<-release
		case 2:
			close(duplicateEntered)
		}
		return waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String(), nil
	}
	t.Cleanup(func() { spawnWorker = old })

	errs := make(chan error, 2)
	go func() { errs <- Schedule(ctx, dag.OID) }()
	<-entered
	secondStarted := make(chan struct{})
	go func() {
		close(secondStarted)
		errs <- Schedule(ctx, dag.OID)
	}()
	<-secondStarted
	select {
	case <-duplicateEntered:
		t.Fatal("second scheduler entered spawn while the first still held the DAG")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	if err := <-errs; err != nil {
		t.Fatal(err)
	}
	if err := <-errs; err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("spawn calls = %d, want 1", calls.Load())
	}
}

func seedFailedDag(t *testing.T) (context.Context, *waveobj.TaskGroup, waveobj.Run) {
	t.Helper()
	ctx, dag := seedPendingDag(t)
	child := jarvis.NewRun("child goal", "ws-1", t.TempDir(), nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.Status = jarvis.RunStatus_Blocked
	if err := wstore.AppendRun(ctx, dag.ChannelId, child); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].State = TaskState_Running
		g.Tasks[0].RunID = child.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return ctx, dag, child
}

func TestScheduleRetainsFailedChildOwnershipForRetry(t *testing.T) {
	ctx, dag, child := seedFailedDag(t)

	if err := Schedule(ctx, dag.OID); err != nil {
		t.Fatal(err)
	}
	got, err := wstore.GetDag(ctx, dag.OID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Tasks[0].State != TaskState_Failed || got.Tasks[0].RunID != child.ID {
		t.Fatalf("failed task ownership = state %q run %q, want failed/%q", got.Tasks[0].State, got.Tasks[0].RunID, child.ID)
	}
}

func TestRetryKeepsFailedOwnershipWhenWorkerStopFails(t *testing.T) {
	ctx, dag, child := seedFailedDag(t)
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].State = TaskState_Failed
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	oldStop := stopRunWorkers
	stopRunWorkers = func(context.Context, *waveobj.Run) error { return errors.New("stop failed") }
	t.Cleanup(func() { stopRunWorkers = oldStop })

	err := ApplyAction(ctx, dag.OID, dag.Tasks[0].ID, "retry", waveobj.RoutePin{})
	if err == nil || !strings.Contains(err.Error(), "stop failed") {
		t.Fatalf("retry error = %v, want stop failure", err)
	}
	got, getErr := wstore.GetDag(ctx, dag.OID)
	if getErr != nil {
		t.Fatal(getErr)
	}
	if got.Tasks[0].State != TaskState_Failed || got.Tasks[0].RunID != child.ID {
		t.Fatalf("failed task ownership = state %q run %q, want failed/%q", got.Tasks[0].State, got.Tasks[0].RunID, child.ID)
	}
}

func TestSkipRejectsRunningTaskWithoutClearingOwnership(t *testing.T) {
	ctx, dag, _, child := seedRunningDag(t)
	if err := ApplyAction(ctx, dag.OID, dag.Tasks[0].ID, "skip", waveobj.RoutePin{}); err == nil {
		t.Fatal("running task accepted skip")
	}
	got, err := wstore.GetDag(ctx, dag.OID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Tasks[0].State != TaskState_Running || got.Tasks[0].RunID != child.ID {
		t.Fatalf("running task ownership changed: state=%q run=%q", got.Tasks[0].State, got.Tasks[0].RunID)
	}
}

func TestSkipStopsStalledChildBeforeClearingOwnership(t *testing.T) {
	ctx, dag, _, child := seedRunningDag(t)
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].State = TaskState_Stalled
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	oldStop := stopRunWorkers
	stopped := false
	stopRunWorkers = func(_ context.Context, run *waveobj.Run) error {
		stopped = run.ID == child.ID
		return nil
	}
	t.Cleanup(func() { stopRunWorkers = oldStop })

	if err := ApplyAction(ctx, dag.OID, dag.Tasks[0].ID, "skip", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}
	gotDag, _ := wstore.GetDag(ctx, dag.OID)
	gotChild, _ := wstore.GetRun(ctx, dag.ChannelId, child.ID)
	if !stopped || gotChild.Status != jarvis.RunStatus_Cancelled {
		t.Fatalf("stalled child stop=%v status=%q, want stopped/cancelled", stopped, gotChild.Status)
	}
	if gotDag.Tasks[0].State != TaskState_Skipped || gotDag.Tasks[0].RunID != "" {
		t.Fatalf("skipped task = state %q run %q", gotDag.Tasks[0].State, gotDag.Tasks[0].RunID)
	}
}

func TestRetryKeepsOwnershipWhenCancelledChildCannotReload(t *testing.T) {
	ctx, dag, child := seedFailedDag(t)
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].State = TaskState_Failed
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	const trigger = "delete_retry_child_after_update"
	if err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		tx.Exec(fmt.Sprintf(`CREATE TEMP TRIGGER %s AFTER UPDATE ON db_run WHEN NEW.oid = '%s' BEGIN DELETE FROM db_run WHERE oid = NEW.oid; END`, trigger, child.ID))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = wstore.WithTx(context.Background(), func(tx *wstore.TxWrap) error {
			tx.Exec("DROP TRIGGER IF EXISTS " + trigger)
			return nil
		})
	})

	err := ApplyAction(ctx, dag.OID, dag.Tasks[0].ID, "retry", waveobj.RoutePin{})
	if err == nil || !strings.Contains(err.Error(), "loading old run") {
		t.Fatalf("retry error = %v, want child reload failure", err)
	}
	got, getErr := wstore.GetDag(ctx, dag.OID)
	if getErr != nil {
		t.Fatal(getErr)
	}
	if got.Tasks[0].State != TaskState_Failed || got.Tasks[0].RunID != child.ID {
		t.Fatalf("failed task ownership = state %q run %q, want failed/%q", got.Tasks[0].State, got.Tasks[0].RunID, child.ID)
	}
}

func seedRunningDag(t *testing.T) (context.Context, *waveobj.TaskGroup, *waveobj.Run, waveobj.Run) {
	t.Helper()
	ctx, dag := seedPendingDag(t)
	owner, err := wstore.GetRun(ctx, dag.ChannelId, dag.RunID)
	if err != nil {
		t.Fatal(err)
	}
	child := jarvis.NewRun("child", "ws-1", t.TempDir(), nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.Phases[0].WorkerOrefs = []string{"tab:worker"}
	if err := wstore.AppendRun(ctx, dag.ChannelId, child); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].State = TaskState_Running
		g.Tasks[0].RunID = child.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return ctx, dag, owner, child
}

func seedEscalationDag(t *testing.T, runtime, tier, state string, escalations int) (context.Context, *waveobj.TaskGroup, waveobj.Run, string) {
	t.Helper()
	ctx, dag := seedPendingDag(t)
	if err := wstore.UpdateRun(ctx, dag.ChannelId, dag.RunID, func(owner *waveobj.Run) error {
		owner.Runtime = runtime
		owner.Tier = tier
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	worker := waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String()
	child := jarvis.NewRun("child", "ws-1", t.TempDir(), nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.Status = jarvis.RunStatus_Blocked
	child.Phases[0].WorkerOrefs = []string{worker}
	if err := wstore.AppendRun(ctx, dag.ChannelId, child); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].State = state
		g.Tasks[0].RunID = child.ID
		g.Tasks[0].Attempts = 2
		g.Tasks[0].LastFailureKind = FailureKindTimeout
		g.Tasks[0].Escalations = escalations
		RecomputeDagStatus(g)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return ctx, dag, child, worker
}

func mustLoadDag(t *testing.T, ctx context.Context, dagID string) *waveobj.TaskGroup {
	t.Helper()
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func allowEscalationSchedule(t *testing.T) {
	t.Helper()
	allowWorkerHarnessForTest(t)
	oldStop := stopRunWorkers
	stopRunWorkers = func(context.Context, *waveobj.Run) error { return nil }
	t.Cleanup(func() { stopRunWorkers = oldStop })
	oldStamp := stampSpawnedWorker
	stampSpawnedWorker = func(context.Context, string, string, string) error { return nil }
	t.Cleanup(func() { stampSpawnedWorker = oldStamp })
	stubSpawnWorker(t, waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String(), nil)
}

func assertEscalationRejectedWithoutCancelling(t *testing.T, ctx context.Context, dag *waveobj.TaskGroup, child waveobj.Run, worker string, target waveobj.RoutePin) {
	t.Helper()
	if err := ApplyAction(ctx, dag.OID, "t-0", "escalate", target); err == nil {
		t.Fatal("want escalation rejection")
	}
	got, err := wstore.GetRun(ctx, dag.ChannelId, child.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != jarvis.RunStatus_Blocked || len(got.Phases) == 0 || len(got.Phases[0].WorkerOrefs) != 1 || got.Phases[0].WorkerOrefs[0] != worker {
		t.Fatalf("rejected escalation mutated child: %+v", got)
	}
}

func TestEscalateRejectsEmptyTarget(t *testing.T) {
	ctx, dag, _, _ := seedEscalationDag(t, "pi", "mid", TaskState_Failed, 0)
	allowEscalationSchedule(t)
	// no automatic tier ladder: a judged hop requires an explicit model or higher tier
	if err := ApplyAction(ctx, dag.OID, "t-0", "escalate", waveobj.RoutePin{}); err == nil {
		t.Fatal("empty escalate target must be rejected")
	}
	got := mustLoadDag(t, ctx, dag.OID)
	task := got.Tasks[0]
	if task.RunSpec.Runtime != "" || task.RunSpec.Tier != "" || task.Escalations != 0 || task.State != TaskState_Failed {
		t.Fatalf("rejected escalation mutated task route/state = %+v", task)
	}
}

func TestEscalateAcceptsExplicitHigherTier(t *testing.T) {
	ctx, dag, _, _ := seedEscalationDag(t, "pi", "cheap", TaskState_Failed, 0)
	allowEscalationSchedule(t)
	if err := ApplyAction(ctx, dag.OID, "t-0", "escalate", waveobj.RoutePin{Tier: "capable"}); err != nil {
		t.Fatal(err)
	}
	got := mustLoadDag(t, ctx, dag.OID)
	if got.Tasks[0].RunSpec.Runtime != "pi" || got.Tasks[0].RunSpec.Tier != "capable" || got.Tasks[0].Escalations != 1 {
		t.Fatalf("explicit escalation = %+v", got.Tasks[0])
	}
}

func TestEscalateRejectsSameOrLowerTierWithoutCancellingRun(t *testing.T) {
	for _, requested := range []string{"mid", "cheap"} {
		t.Run(requested, func(t *testing.T) {
			ctx, dag, child, worker := seedEscalationDag(t, "pi", "mid", TaskState_Failed, 0)
			assertEscalationRejectedWithoutCancelling(t, ctx, dag, child, worker, waveobj.RoutePin{Tier: requested})
		})
	}
}

func TestEscalateRejectsSecondHopWithoutCancellingRun(t *testing.T) {
	ctx, dag, child, worker := seedEscalationDag(t, "pi", "mid", TaskState_Failed, 1)
	assertEscalationRejectedWithoutCancelling(t, ctx, dag, child, worker, waveobj.RoutePin{Tier: "capable"})
}

func TestEscalateRejectsUnsupportedRouteWithoutCancellingRun(t *testing.T) {
	ctx, dag, child, worker := seedEscalationDag(t, "codex", "cheap", TaskState_Failed, 0)
	assertEscalationRejectedWithoutCancelling(t, ctx, dag, child, worker, waveobj.RoutePin{Tier: "mid"})
}

func TestEscalateRejectsPendingTask(t *testing.T) {
	ctx, dag := seedPendingDag(t)
	if err := wstore.UpdateRun(ctx, dag.ChannelId, dag.RunID, func(owner *waveobj.Run) error {
		owner.Runtime = "pi"
		owner.Tier = "mid"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := ApplyAction(ctx, dag.OID, "t-0", "escalate", waveobj.RoutePin{Tier: "capable"}); err == nil {
		t.Fatal("pending task accepted escalation")
	}
	got := mustLoadDag(t, ctx, dag.OID)
	if got.Tasks[0].State != TaskState_Pending || got.Tasks[0].RunID != "" {
		t.Fatalf("rejected pending escalation mutated task: %+v", got.Tasks[0])
	}
}

func TestCancelPersistsBeforeStoppingWorkersAndIsIdempotent(t *testing.T) {
	ctx, dag, owner, child := seedRunningDag(t)
	oldStop := stopRunWorkers
	stopCalls := 0
	stopObservedCancelled := true
	stopRunWorkers = func(ctx context.Context, _ *waveobj.Run) error {
		stopCalls++
		gotDag, dagErr := wstore.GetDag(ctx, dag.OID)
		gotOwner, ownerErr := wstore.GetRun(ctx, dag.ChannelId, owner.ID)
		gotChild, childErr := wstore.GetRun(ctx, dag.ChannelId, child.ID)
		stopObservedCancelled = stopObservedCancelled && dagErr == nil && ownerErr == nil && childErr == nil &&
			gotDag.Status == DagStatus_Cancelled && gotDag.Tasks[0].State == TaskState_Cancelled &&
			gotOwner.Status == jarvis.RunStatus_Cancelled && gotChild.Status == jarvis.RunStatus_Cancelled
		return nil
	}
	t.Cleanup(func() { stopRunWorkers = oldStop })

	if err := Cancel(ctx, dag.OID); err != nil {
		t.Fatal(err)
	}
	if err := Cancel(ctx, dag.OID); err != nil {
		t.Fatal(err)
	}
	if !stopObservedCancelled {
		t.Fatal("worker stop ran before terminal state committed")
	}
	if stopCalls != 4 {
		t.Fatalf("stop calls = %d, want owner and child on each cancellation", stopCalls)
	}
}

func TestCancelDetachesWorkerCleanupFromCallerContext(t *testing.T) {
	baseCtx, dag, _, _ := seedRunningDag(t)
	ctx, cancel := context.WithCancel(baseCtx)
	oldTx, oldStop := withMutationTx, stopRunWorkers
	withMutationTx = func(ctx context.Context, fn func(*wstore.TxWrap) error) error {
		err := wstore.WithTx(ctx, fn)
		cancel()
		return err
	}
	stopCalls := 0
	stopRunWorkers = func(ctx context.Context, _ *waveobj.Run) error {
		stopCalls++
		if ctx.Err() != nil {
			return fmt.Errorf("cleanup context is cancelled: %w", ctx.Err())
		}
		return nil
	}
	t.Cleanup(func() { withMutationTx, stopRunWorkers = oldTx, oldStop })

	if err := Cancel(ctx, dag.OID); err != nil {
		t.Fatal(err)
	}
	if stopCalls != 2 {
		t.Fatalf("stop calls = %d, want owner and child", stopCalls)
	}
}

func TestCancelReturnsStopFailureWithoutRevertingState(t *testing.T) {
	ctx, dag, _, child := seedRunningDag(t)
	oldStop := stopRunWorkers
	stopRunWorkers = func(_ context.Context, run *waveobj.Run) error {
		if run.ID == child.ID {
			return errors.New("worker stop failed")
		}
		return nil
	}
	t.Cleanup(func() { stopRunWorkers = oldStop })

	err := Cancel(ctx, dag.OID)
	if err == nil || !strings.Contains(err.Error(), child.ID) || !strings.Contains(err.Error(), "worker stop failed") {
		t.Fatalf("cancel error = %v, want contextual child stop failure", err)
	}
	gotDag, _ := wstore.GetDag(ctx, dag.OID)
	gotChild, _ := wstore.GetRun(ctx, dag.ChannelId, child.ID)
	if gotDag.Status != DagStatus_Cancelled || gotChild.Status != jarvis.RunStatus_Cancelled {
		t.Fatalf("stop failure reverted cancellation: dag=%q child=%q", gotDag.Status, gotChild.Status)
	}
}

func TestCancelPersistsCleanupDebtAndRetry(t *testing.T) {
	ctx := context.Background()
	projectDir := newGitRepo(t)
	ch, err := wstore.CreateChannel(ctx, "cancel-cleanup", projectDir)
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", projectDir, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	owner.BaseCommit = gitCmd(t, projectDir, "rev-parse", "HEAD")
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, true, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureRunWorktree(ctx, projectDir, TaskWorktreeKey(owner.ID, "t-0"), owner.BaseCommit); err != nil {
		t.Fatal(err)
	}

	oldRemover := RemoveTaskWorktree
	persistedPending := false
	RemoveTaskWorktree = func(cleanupCtx context.Context, _, _ string) error {
		stored, loadErr := wstore.GetDag(cleanupCtx, g.OID)
		persistedPending = loadErr == nil && stored.Status == DagStatus_Cancelled && stored.Tasks[0].CleanupPending
		return errors.New("locked")
	}
	t.Cleanup(func() { RemoveTaskWorktree = oldRemover })

	if err := Cancel(ctx, g.OID); err == nil || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("cancel error = %v, want cleanup failure", err)
	}
	if !persistedPending {
		t.Fatal("cancelled cleanup pending must persist before removal")
	}
	stored, err := wstore.GetDag(ctx, g.OID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != DagStatus_Cancelled || stored.Tasks[0].CleanupPending || stored.Tasks[0].CleanupError == "" {
		t.Fatalf("cancelled cleanup debt = status %q pending %v error %q", stored.Status, stored.Tasks[0].CleanupPending, stored.Tasks[0].CleanupError)
	}

	RemoveTaskWorktree = func(context.Context, string, string) error { return nil }
	if err := RetryPendingCleanup(ctx, stored); err != nil {
		t.Fatal(err)
	}
	if err := PersistCleanupState(ctx, stored); err != nil {
		t.Fatal(err)
	}
	if stored.Status != DagStatus_Cancelled || HasCleanupDebt(stored) {
		t.Fatalf("cleanup retry reopened or retained debt: status %q debt %v", stored.Status, HasCleanupDebt(stored))
	}
}

func TestCancelRollsBackAllStateBeforeWorkerStop(t *testing.T) {
	ctx, dag, owner, child := seedRunningDag(t)
	const trigger = "fail_cancel_run_update"
	if err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		tx.Exec(`CREATE TEMP TRIGGER fail_cancel_run_update BEFORE UPDATE ON db_run BEGIN SELECT RAISE(ABORT, 'forced cancel failure'); END`)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = wstore.WithTx(context.Background(), func(tx *wstore.TxWrap) error {
			tx.Exec("DROP TRIGGER IF EXISTS " + trigger)
			return nil
		})
	})
	oldStop := stopRunWorkers
	stopCalls := 0
	stopRunWorkers = func(context.Context, *waveobj.Run) error { stopCalls++; return nil }
	t.Cleanup(func() { stopRunWorkers = oldStop })

	if err := Cancel(ctx, dag.OID); err == nil {
		t.Fatal("want forced cancellation transaction failure")
	}
	gotDag, _ := wstore.GetDag(ctx, dag.OID)
	gotOwner, _ := wstore.GetRun(ctx, dag.ChannelId, owner.ID)
	gotChild, _ := wstore.GetRun(ctx, dag.ChannelId, child.ID)
	if gotDag.Status == DagStatus_Cancelled || gotOwner.Status == jarvis.RunStatus_Cancelled || gotChild.Status == jarvis.RunStatus_Cancelled {
		t.Fatalf("cancellation partially committed: dag=%q owner=%q child=%q", gotDag.Status, gotOwner.Status, gotChild.Status)
	}
	if stopCalls != 0 {
		t.Fatalf("worker stop called %d times before transaction committed", stopCalls)
	}
}

func TestMarkBlockedMergeChangesOnlyOwningTask(t *testing.T) {
	ctx, dag := seedPendingDag(t)
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks = append(g.Tasks, waveobj.TaskNode{ID: "t-1", Label: "b", State: TaskState_Running, RunID: "child-1"})
		g.Tasks[0].State = TaskState_Running
		g.Tasks[0].RunID = "child-0"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := MarkBlockedMerge(ctx, dag.OID, "child-1"); err != nil {
		t.Fatal(err)
	}
	got, _ := wstore.GetDag(ctx, dag.OID)
	if got.Tasks[0].State != TaskState_Running || got.Tasks[1].State != TaskState_BlockedMerge {
		t.Fatalf("merge block changed wrong tasks: %+v", got.Tasks)
	}
}

func TestCancelledDagRejectsFurtherMutations(t *testing.T) {
	ctx, dag, _, child := seedRunningDag(t)
	oldStop, oldSpawn := stopRunWorkers, spawnWorker
	stopRunWorkers = func(context.Context, *waveobj.Run) error { return nil }
	spawnCalls := 0
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		spawnCalls++
		return "tab:unexpected", nil
	}
	t.Cleanup(func() { stopRunWorkers, spawnWorker = oldStop, oldSpawn })
	if err := Cancel(ctx, dag.OID); err != nil {
		t.Fatal(err)
	}

	for _, action := range []string{"approve", "sendback", "retry", "skip", "escalate"} {
		if err := ApplyAction(ctx, dag.OID, dag.Tasks[0].ID, action, waveobj.RoutePin{}); err == nil {
			t.Fatalf("cancelled DAG accepted %q", action)
		}
	}
	if err := MarkBlockedMerge(ctx, dag.OID, child.ID); err == nil {
		t.Fatal("cancelled DAG accepted blocked-merge mutation")
	}
	got, err := wstore.GetDag(ctx, dag.OID)
	if err != nil {
		t.Fatal(err)
	}
	RecomputeDagStatus(got)
	if got.Status != DagStatus_Cancelled || got.Tasks[0].State != TaskState_Cancelled || spawnCalls != 0 {
		t.Fatalf("cancelled DAG reopened: status=%q task=%q spawns=%d", got.Status, got.Tasks[0].State, spawnCalls)
	}
}

func TestCancelHoldsDagAuthorityThroughWorkerCleanup(t *testing.T) {
	ctx, dag, _, _ := seedRunningDag(t)
	oldStop := stopRunWorkers
	entered := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	stopRunWorkers = func(context.Context, *waveobj.Run) error {
		if calls.Add(1) == 1 {
			close(entered)
			<-release
		}
		return nil
	}
	t.Cleanup(func() { stopRunWorkers = oldStop })

	cancelDone := make(chan error, 1)
	go func() { cancelDone <- Cancel(ctx, dag.OID) }()
	<-entered
	actionDone := make(chan error, 1)
	go func() { actionDone <- ApplyAction(ctx, dag.OID, dag.Tasks[0].ID, "retry", waveobj.RoutePin{}) }()
	select {
	case err := <-actionDone:
		t.Fatalf("action escaped cancellation authority before worker cleanup: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	if err := <-cancelDone; err != nil {
		t.Fatal(err)
	}
	if err := <-actionDone; err == nil {
		t.Fatal("cancelled DAG accepted retry after cleanup")
	}
}

func TestCancelWaitsForSpawnAndStopsAttachedWorker(t *testing.T) {
	ctx, dag := seedPendingDag(t)
	allowWorkerHarnessForTest(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	worker := waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String()
	oldSpawn, oldStamp, oldStop := spawnWorker, stampSpawnedWorker, stopRunWorkers
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		close(entered)
		<-release
		return worker, nil
	}
	stampSpawnedWorker = func(context.Context, string, string, string) error { return nil }
	stoppedAttachedWorker := false
	stopRunWorkers = func(_ context.Context, run *waveobj.Run) error {
		for _, phase := range run.Phases {
			for _, oref := range phase.WorkerOrefs {
				if oref == worker {
					stoppedAttachedWorker = true
				}
			}
		}
		return nil
	}
	t.Cleanup(func() { spawnWorker, stampSpawnedWorker, stopRunWorkers = oldSpawn, oldStamp, oldStop })

	scheduleDone := make(chan error, 1)
	go func() { scheduleDone <- Schedule(ctx, dag.OID) }()
	<-entered
	cancelDone := make(chan error, 1)
	go func() { cancelDone <- Cancel(ctx, dag.OID) }()
	select {
	case err := <-cancelDone:
		t.Fatalf("cancellation returned before bounded spawn completed: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	if err := <-scheduleDone; err != nil {
		t.Fatal(err)
	}
	if err := <-cancelDone; err != nil {
		t.Fatal(err)
	}
	if !stoppedAttachedWorker {
		t.Fatal("cancellation did not stop the worker attached during spawn")
	}
}

func TestScheduleDifferentDagsProceedConcurrently(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx1, dag1 := seedPendingDag(t)
	ctx2, dag2 := seedPendingDag(t)
	// ctx is shared; both dags use background context, but we need to block dag1's spawn
	entered := make(chan struct{})
	release := make(chan struct{})
	var callsDag1 atomic.Int32
	var callsDag2 atomic.Int32
	old := spawnWorker
	spawnWorker = func(ctx context.Context, cap runroute.Capability, workspaceId, projectName, cwd, prompt string, _ jarvis.RunWorkerOptions) (string, error) {
		// We can't easily know which dag is calling; use a simple counter and block only first call.
		// Instead we separate by using dag1's spawn path: block first spawn, let second dag proceed.
		if callsDag1.Load() == 0 && callsDag2.Load() == 0 {
			// first overall spawn -> dag1 blocked
			callsDag1.Add(1)
			close(entered)
			<-release
			return waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String(), nil
		}
		callsDag2.Add(1)
		return waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String(), nil
	}
	t.Cleanup(func() { spawnWorker = old })

	errs := make(chan error, 2)
	go func() { errs <- Schedule(ctx1, dag1.OID) }()
	<-entered
	// while dag1 is blocked, dag2 should be able to complete
	done := make(chan error, 1)
	go func() { done <- Schedule(ctx2, dag2.OID) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("dag2 schedule failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("different DAG was blocked by unrelated scheduling")
	}
	close(release)
	if err := <-errs; err != nil {
		t.Fatal(err)
	}
	// dag2 already done; ensure counts
	if callsDag1.Load() != 1 {
		t.Fatalf("dag1 spawn calls = %d, want 1", callsDag1.Load())
	}
	if callsDag2.Load() != 1 {
		t.Fatalf("dag2 spawn calls = %d, want 1", callsDag2.Load())
	}
}

// TestCancelSweepsTaskWorktrees: cancelling a dag removes every task's worktree (dumping dirty
// state to a recovery patch first) so abandoned trees and branches don't accumulate in the project.
func TestCancelSweepsTaskWorktrees(t *testing.T) {
	ctx, dag := seedPendingDag(t)
	allowWorkerHarnessForTest(t)

	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, dag.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	newGitRepoAt(t, ch.ProjectPath)
	base := gitCmd(t, ch.ProjectPath, "rev-parse", "HEAD")
	if err := wstore.UpdateRun(ctx, ch.OID, dag.RunID, func(r *waveobj.Run) error {
		r.BaseCommit = base
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	old := spawnWorker
	spawnWorker = func(ctx context.Context, cap runroute.Capability, workspaceId, projectName, cwd, prompt string, _ jarvis.RunWorkerOptions) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String(), nil
	}
	defer func() { spawnWorker = old }()
	oldStop := stopRunWorkers
	stopRunWorkers = func(ctx context.Context, r *waveobj.Run) error { return nil }
	defer func() { stopRunWorkers = oldStop }()

	if err := ScheduleOnce(ctx, dag); err != nil {
		t.Fatal(err)
	}
	key := TaskWorktreeKey(dag.RunID, "t-0")
	wtPath := filepath.Join(ch.ProjectPath, ".waveterm", "worktrees", key)
	if _, err := os.Stat(wtPath); err != nil {
		t.Fatalf("expected spawned task worktree at %s: %v", wtPath, err)
	}
	os.WriteFile(filepath.Join(wtPath, "uncommitted.txt"), []byte("wip"), 0o644)

	if err := Cancel(ctx, dag.OID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wtPath); !os.IsNotExist(err) {
		t.Fatalf("cancel must sweep the task worktree, stat err = %v", err)
	}
	if gitCmd(t, ch.ProjectPath, "branch", "--list", "wave/"+key) != "" {
		t.Fatal("cancel must delete the task branch")
	}
	patch, err := os.ReadFile(filepath.Join(ch.ProjectPath, ".waveterm", "recovery", key+".patch"))
	if err != nil {
		t.Fatalf("dirty state must be dumped before the sweep: %v", err)
	}
	if !strings.Contains(string(patch), "uncommitted.txt") {
		t.Fatalf("patch must capture uncommitted work:\n%s", patch)
	}
}

func TestEscalationTargetModel(t *testing.T) {
	task := &waveobj.TaskNode{ID: "t-1", State: TaskState_Failed, RunSpec: waveobj.RunSpec{Runtime: "pi", Model: "opencode/deepseek-v4-flash"}}
	owner := &waveobj.Run{Runtime: "pi"}
	target, err := escalationTarget(task, owner, nil, waveobj.RoutePin{Runtime: "claude", Model: "opus"})
	if err != nil {
		t.Fatal(err)
	}
	if target.Runtime != "claude" || target.Model != "opus" {
		t.Fatalf("cross-runtime model escalation failed: %+v", target)
	}
}

func TestEscalationTargetRequiresValidModel(t *testing.T) {
	task := &waveobj.TaskNode{ID: "t-1", State: TaskState_Failed, RunSpec: waveobj.RunSpec{Runtime: "pi"}}
	owner := &waveobj.Run{Runtime: "pi"}
	if _, err := escalationTarget(task, owner, nil, waveobj.RoutePin{Runtime: "claude", Model: "gpt-5.4"}); err == nil {
		t.Fatal("cross-namespace model must be rejected")
	}
	if _, err := escalationTarget(task, owner, nil, waveobj.RoutePin{}); err == nil {
		t.Fatal("empty target must be rejected")
	}
}

func TestEscalationTargetCapHolds(t *testing.T) {
	task := &waveobj.TaskNode{ID: "t-1", State: TaskState_Stalled, Escalations: 1, RunSpec: waveobj.RunSpec{Runtime: "pi"}}
	owner := &waveobj.Run{Runtime: "pi"}
	if _, err := escalationTarget(task, owner, nil, waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"}); err == nil {
		t.Fatal("escalations cap must refuse a second hop")
	}
}

func TestEffectiveTaskRouteModel(t *testing.T) {
	task := &waveobj.TaskNode{RunSpec: waveobj.RunSpec{Runtime: "", Model: "opencode/claude-opus-4-8"}}
	owner := &waveobj.Run{Runtime: "pi"}
	got := effectiveTaskRoute(task, owner, nil)
	if got.Model != "opencode/claude-opus-4-8" || got.Runtime != "pi" {
		t.Fatalf("model RunSpec must inherit owner runtime: %+v", got)
	}
	ownerWithModel := &waveobj.Run{Runtime: "pi", Model: "opencode/deepseek-v4-pro"}
	inherited := effectiveTaskRoute(&waveobj.TaskNode{}, ownerWithModel, nil)
	if inherited.Model != "opencode/deepseek-v4-pro" || inherited.Runtime != "pi" {
		t.Fatalf("owner model must flow to tasks without a route: %+v", inherited)
	}
}
