package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// captureClient records broker events so tests can assert engine event publishing.
type captureClient struct {
	mu     sync.Mutex
	events []wps.WaveEvent
}

func (c *captureClient) SendEvent(_ string, event wps.WaveEvent) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, event)
}

func (c *captureClient) saw(kind, scope string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, e := range c.events {
		if e.Event == kind && e.HasScope(scope) {
			return true
		}
	}
	return false
}

func TestTaskPromptCarriesDescriptionAndContract(t *testing.T) {
	owner := jarvis.NewRun("owner", "ws-1", "/p", nil, jarvis.RunMode_Orchestrator, nil, 1)
	desc := "pin: date-only format (Aug 16)"
	p := taskPrompt(&waveobj.TaskNode{ID: "t-1", Label: "add fmtDate", Description: desc}, &owner)
	if !strings.Contains(p, "add fmtDate") {
		t.Fatalf("label missing from prompt: %q", p)
	}
	if !strings.Contains(p, desc) {
		t.Fatalf("description missing from prompt: %q", p)
	}
	if !strings.Contains(p, HeadlessContract) {
		t.Fatalf("headless contract missing from prompt: %q", p)
	}
}

func TestTaskPromptLabelOnlyStillHasContract(t *testing.T) {
	owner := jarvis.NewRun("owner", "ws-1", "/p", nil, jarvis.RunMode_Orchestrator, nil, 1)
	p := taskPrompt(&waveobj.TaskNode{ID: "t-1", Label: "plain"}, &owner)
	if !strings.Contains(p, HeadlessContract) {
		t.Fatalf("contract missing from prompt: %q", p)
	}
	if strings.Contains(p, "description") {
		t.Fatalf("no description should appear for a label-only task: %q", p)
	}
}

func TestTaskPromptRunSpecGoalWins(t *testing.T) {
	owner := jarvis.NewRun("owner", "ws-1", "/p", nil, jarvis.RunMode_Orchestrator, nil, 1)
	p := taskPrompt(&waveobj.TaskNode{ID: "t-1", Label: "label", RunSpec: waveobj.RunSpec{Goal: "explicit goal"}}, &owner)
	if !strings.Contains(p, "explicit goal") {
		t.Fatalf("runspec goal missing from prompt: %q", p)
	}
	if strings.Contains(p, "label") {
		t.Fatalf("label must not appear when runspec goal is set: %q", p)
	}
}

func allowWorkerHarnessForTest(t *testing.T) {
	t.Helper()
	old := validateWorkerHarness
	validateWorkerHarness = func(string) error { return nil }
	t.Cleanup(func() { validateWorkerHarness = old })
}

func TestScheduleOnceSpawnsUpToCap(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "engine-test", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 2, false, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "c", Deps: []string{"t-0"}},
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}

	var spawned []string
	old := spawnWorker
	spawnWorker = func(ctx context.Context, cap runroute.Capability, workspaceId, projectName, cwd, prompt string, _ jarvis.RunWorkerOptions) (string, error) {
		spawned = append(spawned, prompt)
		return "tab:worker", nil
	}
	defer func() { spawnWorker = old }()

	// first step: only t-0 is ready (no deps), so exactly one spawn despite cap 2
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if len(spawned) != 1 {
		t.Fatalf("want 1 spawn (t-0), got %d", len(spawned))
	}
	if g.Tasks[0].State != TaskState_Running || g.Tasks[0].RunID == "" {
		t.Fatalf("t-0 must be running with a child run: %+v", g.Tasks[0])
	}
	child0 := g.Tasks[0].RunID

	// child t-0 completes; the next step derives done and spawns t-1 and t-2 (cap 2)
	if err := wstore.UpdateRun(ctx, ch.OID, child0, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Done
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if len(spawned) != 3 {
		t.Fatalf("want 2 more spawns (t-1, t-2), got %d total", len(spawned))
	}
	if g.Tasks[0].State != TaskState_Done {
		t.Fatalf("t-0 must derive done, got %s", g.Tasks[0].State)
	}

	// third step: two running, nothing ready -> no spawns
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if len(spawned) != 3 {
		t.Fatalf("no new spawns expected, got %d", len(spawned))
	}
}

func TestScheduleOncePublishesChildDone(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	cc := &captureClient{}
	prevClient := wps.Broker.GetClient()
	wps.Broker.SetClient(cc)
	defer wps.Broker.SetClient(prevClient)
	wps.Broker.Subscribe("engine-events-test", wps.SubscriptionRequest{Event: DagEventTaskSpawned, AllScopes: true})
	wps.Broker.Subscribe("engine-events-test", wps.SubscriptionRequest{Event: DagEventChildDone, AllScopes: true})
	defer wps.Broker.Unsubscribe("engine-events-test", DagEventTaskSpawned)
	defer wps.Broker.Unsubscribe("engine-events-test", DagEventChildDone)

	ch, err := wstore.CreateChannel(ctx, "engine-events", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 2, false, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}

	old := spawnWorker
	spawnWorker = func(ctx context.Context, cap runroute.Capability, workspaceId, projectName, cwd, prompt string, _ jarvis.RunWorkerOptions) (string, error) {
		return "tab:worker", nil
	}
	defer func() { spawnWorker = old }()

	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	child0 := g.Tasks[0].RunID
	scope := waveobj.MakeORef(waveobj.OType_Dag, g.OID).String()
	if !cc.saw(DagEventTaskSpawned, scope) {
		t.Fatal("task-spawned event not published")
	}
	// the spawn also lands on the owning run's lifecycle log, so its card timeline shows the task.
	events, err := wstore.QueryRunEvents(ctx, ch.OID, owner.ID, 50)
	if err != nil {
		t.Fatalf("query run events: %v", err)
	}
	var sawSpawn bool
	for _, e := range events {
		if e.Kind == waveobj.RunEventKindTaskSpawned {
			sawSpawn = true
		}
	}
	if !sawSpawn {
		t.Fatalf("expected task-spawned event on the owning run's log, got %+v", events)
	}

	if err := wstore.UpdateRun(ctx, ch.OID, child0, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Done
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if !cc.saw(DagEventChildDone, scope) {
		t.Fatal("child-done event not published on running->done transition")
	}
	if g.Tasks[0].State != TaskState_Done {
		t.Fatalf("t-0 must derive done, got %s", g.Tasks[0].State)
	}
}

func TestScheduleOnceUsesTaskRouteForSpawnAndChild(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "route-task", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	owner.Runtime = "claude"
	owner.Tier = "mid"
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{{
		ID: "t-0", Label: "pi task", RunSpec: waveobj.RunSpec{Runtime: "pi", Tier: "cheap"},
	}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	var gotCap runroute.Capability
	old := spawnWorker
	spawnWorker = func(_ context.Context, cap runroute.Capability, _, _, _, _ string, _ jarvis.RunWorkerOptions) (string, error) {
		gotCap = cap
		return "tab:worker", nil
	}
	t.Cleanup(func() { spawnWorker = old })

	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if gotCap.Runtime != "pi" || gotCap.Tier != "cheap" || len(gotCap.ModelArgs) != 2 || gotCap.ModelArgs[1] != consult.PiCheapModel {
		t.Fatalf("spawn capability = %+v, want pi/cheap with flash model args", gotCap)
	}
	child, err := wstore.GetRun(ctx, ch.OID, g.Tasks[0].RunID)
	if err != nil {
		t.Fatal(err)
	}
	if child.Runtime != "pi" || child.Tier != "cheap" {
		t.Fatalf("child route = %s/%s, want pi/cheap", child.Runtime, child.Tier)
	}
}

func TestScheduleOnceRejectsUnavailableTaskRouteBeforeSpawn(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "route-unavailable", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	owner.Runtime = "claude"
	owner.Tier = "capable"
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{{
		ID: "t-0", Label: "a", RunSpec: waveobj.RunSpec{Runtime: "pi", Tier: "cheap"},
	}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	oldValidate := validateWorkerHarness
	validateWorkerHarness = func(string) error { return errors.New("unavailable") }
	t.Cleanup(func() { validateWorkerHarness = oldValidate })
	spawned := 0
	oldSpawn := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		spawned++
		return "tab:worker", nil
	}
	t.Cleanup(func() { spawnWorker = oldSpawn })

	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if g.Tasks[0].State != TaskState_Failed || spawned != 0 || g.Tasks[0].RunID != "" {
		t.Fatalf("unavailable route state=%s run=%q spawned=%d", g.Tasks[0].State, g.Tasks[0].RunID, spawned)
	}
}

func TestScheduleOnceLegacyRuntimeOnlyAndInheritedRoutes(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "route-legacy", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	owner.Runtime = "pi"
	owner.Tier = "mid"
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 2, false, []waveobj.TaskNode{
		{ID: "legacy", Label: "legacy", RunSpec: waveobj.RunSpec{Runtime: "claude"}},
		{ID: "inherited", Label: "inherited"},
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	caps := map[string]runroute.Capability{}
	old := spawnWorker
	spawnWorker = func(_ context.Context, cap runroute.Capability, _, _, _, prompt string, _ jarvis.RunWorkerOptions) (string, error) {
		if strings.Contains(prompt, "legacy") {
			caps["legacy"] = cap
		} else {
			caps["inherited"] = cap
		}
		return "tab:worker", nil
	}
	t.Cleanup(func() { spawnWorker = old })

	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"legacy", "inherited"} {
		task := taskByID(&g, id)
		child, cerr := wstore.GetRun(ctx, ch.OID, task.RunID)
		if cerr != nil {
			t.Fatal(cerr)
		}
		if id == "legacy" {
			if caps[id].Runtime != "claude" || caps[id].Tier != "capable" || child.Runtime != "claude" || child.Tier != "capable" {
				t.Fatalf("legacy route = cap %+v child %s/%s, want claude/capable", caps[id], child.Runtime, child.Tier)
			}
		} else if caps[id].Runtime != "pi" || caps[id].Tier != "mid" || child.Runtime != "pi" || child.Tier != "mid" {
			t.Fatalf("inherited route = cap %+v child %s/%s, want pi/mid", caps[id], child.Runtime, child.Tier)
		}
	}
}

func TestSchedulePersistsSpawnedWorkerOwnership(t *testing.T) {
	ctx, dag := seedPendingDag(t)
	allowWorkerHarnessForTest(t)
	cc := &captureClient{}
	prevClient := wps.Broker.GetClient()
	wps.Broker.SetClient(cc)
	t.Cleanup(func() { wps.Broker.SetClient(prevClient) })
	const subscriber = "schedule-child-run-updates"
	wps.Broker.Subscribe(subscriber, wps.SubscriptionRequest{Event: wps.Event_WaveObjUpdate, AllScopes: true})
	t.Cleanup(func() { wps.Broker.Unsubscribe(subscriber, wps.Event_WaveObjUpdate) })
	workerTabID := "12121212-1212-4212-8212-121212121212"
	worker := waveobj.MakeORef(waveobj.OType_Tab, workerTabID).String()
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: workerTabID}); err != nil {
		t.Fatal(err)
	}
	stubSpawnWorker(t, worker, nil)
	if err := Schedule(ctx, dag.OID); err != nil {
		t.Fatal(err)
	}
	got, _ := wstore.GetDag(ctx, dag.OID)
	if len(got.Tasks) == 0 || got.Tasks[0].RunID == "" {
		t.Fatalf("dag task not running: %+v", got.Tasks)
	}
	child, _ := wstore.GetRun(ctx, got.ChannelId, got.Tasks[0].RunID)
	if len(child.Phases) == 0 || len(child.Phases[0].WorkerOrefs) != 1 || child.Phases[0].WorkerOrefs[0] != worker {
		t.Fatalf("worker ownership = %+v, want %s", child.Phases, worker)
	}
	runORef, channelORef, err := wstore.GetWorkerOwner(ctx, worker)
	if err != nil {
		t.Fatal(err)
	}
	if runORef != waveobj.MakeORef(waveobj.OType_Run, child.ID).String() || channelORef != waveobj.MakeORef(waveobj.OType_Channel, dag.ChannelId).String() {
		t.Fatalf("worker owner metadata = %q/%q", runORef, channelORef)
	}
	if !cc.saw(wps.Event_WaveObjUpdate, waveobj.MakeORef(waveobj.OType_Run, child.ID).String()) ||
		!cc.saw(wps.Event_WaveObjUpdate, waveobj.MakeORef(waveobj.OType_Channel, dag.ChannelId).String()) {
		t.Fatal("committed child Run/channel updates were not published")
	}
}

func TestScheduleStopsWorkerWhenChildPersistFails(t *testing.T) {
	ctx, dag := seedPendingDag(t)
	allowWorkerHarnessForTest(t)
	worker := waveobj.MakeORef(waveobj.OType_Tab, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").String()
	stubSpawnWorker(t, worker, nil)
	stopped := false
	oldAppend, oldStop := appendChildRun, stopSpawnedWorker
	appendChildRun = func(context.Context, string, waveobj.Run) error { return errors.New("persist failed") }
	stopSpawnedWorker = func(context.Context, string) error { stopped = true; return nil }
	t.Cleanup(func() { appendChildRun, stopSpawnedWorker = oldAppend, oldStop })
	err := Schedule(ctx, dag.OID)
	if err == nil || !strings.Contains(err.Error(), "persist failed") {
		t.Fatalf("want persist failed error, got %v", err)
	}
	if !stopped {
		t.Fatal("worker not stopped on persist failure")
	}
}

func TestScheduleCleansAllWorkersWhenLaterChildPersistFails(t *testing.T) {
	ctx, dag := seedPendingDag(t)
	allowWorkerHarnessForTest(t)
	cc := &captureClient{}
	prevClient := wps.Broker.GetClient()
	wps.Broker.SetClient(cc)
	t.Cleanup(func() { wps.Broker.SetClient(prevClient) })
	const subscriber = "schedule-child-cleanup-updates"
	wps.Broker.Subscribe(subscriber, wps.SubscriptionRequest{Event: wps.Event_WaveObjUpdate, AllScopes: true})
	t.Cleanup(func() { wps.Broker.Unsubscribe(subscriber, wps.Event_WaveObjUpdate) })
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Parallelism = 2
		g.Tasks = append(g.Tasks, waveobj.TaskNode{ID: "t-1", Label: "b", State: TaskState_Pending})
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	oldSpawn, oldAppend, oldStop, oldStamp := spawnWorker, appendChildRun, stopSpawnedWorker, stampSpawnedWorker
	var spawnCalls int
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		spawnCalls++
		return fmt.Sprintf("tab:worker-%d", spawnCalls), nil
	}
	var persisted []waveobj.Run
	appendCalls := 0
	appendChildRun = func(ctx context.Context, channelID string, run waveobj.Run) error {
		appendCalls++
		if appendCalls == 2 {
			return errors.New("second child persist failed")
		}
		if err := oldAppend(ctx, channelID, run); err != nil {
			return err
		}
		persisted = append(persisted, run)
		return nil
	}
	var stopped []string
	stopSpawnedWorker = func(_ context.Context, oref string) error {
		stopped = append(stopped, oref)
		return nil
	}
	stampSpawnedWorker = func(context.Context, string, string, string) error { return nil }
	t.Cleanup(func() {
		spawnWorker, appendChildRun, stopSpawnedWorker, stampSpawnedWorker = oldSpawn, oldAppend, oldStop, oldStamp
	})

	err := Schedule(ctx, dag.OID)
	if err == nil || !strings.Contains(err.Error(), "second child persist failed") {
		t.Fatalf("schedule error = %v, want second child persistence failure", err)
	}
	if len(stopped) != 2 {
		t.Fatalf("stopped workers = %v, want both spawned workers", stopped)
	}
	if len(persisted) != 1 {
		t.Fatalf("persisted children = %d, want 1", len(persisted))
	}
	child, err := wstore.GetRun(ctx, dag.ChannelId, persisted[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if child.Status != jarvis.RunStatus_Cancelled {
		t.Fatalf("persisted child status = %q, want cancelled", child.Status)
	}
	if !cc.saw(wps.Event_WaveObjUpdate, waveobj.MakeORef(waveobj.OType_Run, child.ID).String()) ||
		!cc.saw(wps.Event_WaveObjUpdate, waveobj.MakeORef(waveobj.OType_Channel, dag.ChannelId).String()) {
		t.Fatal("compensated child Run/channel updates were not published")
	}
	got, err := wstore.GetDag(ctx, dag.OID)
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range got.Tasks {
		if task.State != TaskState_Failed || task.RunID != "" {
			t.Fatalf("task %s cleanup = state %q run %q, want failed with no run", task.ID, task.State, task.RunID)
		}
	}
}

func TestScheduleUsesDetachedContextForPersistenceCleanup(t *testing.T) {
	baseCtx, dag := seedPendingDag(t)
	ctx, cancel := context.WithCancel(baseCtx)
	allowWorkerHarnessForTest(t)
	worker := "tab:worker-detached-cleanup"
	cc := &captureClient{}
	prevClient := wps.Broker.GetClient()
	wps.Broker.SetClient(cc)
	t.Cleanup(func() { wps.Broker.SetClient(prevClient) })
	const subscriber = "schedule-persist-failure-events"
	wps.Broker.Subscribe(subscriber, wps.SubscriptionRequest{Event: DagEventTaskSpawned, AllScopes: true})
	t.Cleanup(func() { wps.Broker.Unsubscribe(subscriber, DagEventTaskSpawned) })

	oldAppend, oldStop, oldStamp := appendChildRun, stopSpawnedWorker, stampSpawnedWorker
	var childID string
	appendChildRun = func(ctx context.Context, channelID string, run waveobj.Run) error {
		if err := oldAppend(ctx, channelID, run); err != nil {
			return err
		}
		childID = run.ID
		cancel()
		return nil
	}
	stopSpawnedWorker = func(context.Context, string) error { return nil }
	stampSpawnedWorker = func(context.Context, string, string, string) error { return nil }
	t.Cleanup(func() {
		appendChildRun, stopSpawnedWorker, stampSpawnedWorker = oldAppend, oldStop, oldStamp
	})
	stubSpawnWorker(t, worker, nil)

	err := Schedule(ctx, dag.OID)
	if err == nil {
		t.Fatal("want persistence failure after caller cancellation")
	}
	scope := waveobj.MakeORef(waveobj.OType_Dag, dag.OID).String()
	if cc.saw(DagEventTaskSpawned, scope) {
		t.Fatal("task-spawned event published before DAG persistence")
	}
	child, getErr := wstore.GetRun(baseCtx, dag.ChannelId, childID)
	if getErr != nil {
		t.Fatal(getErr)
	}
	if child.Status != jarvis.RunStatus_Cancelled {
		t.Fatalf("child status = %q, want cancelled", child.Status)
	}
	got, getErr := wstore.GetDag(baseCtx, dag.OID)
	if getErr != nil {
		t.Fatal(getErr)
	}
	if got.Tasks[0].State != TaskState_Failed || got.Tasks[0].RunID != "" {
		t.Fatalf("task cleanup = state %q run %q, want failed with no run", got.Tasks[0].State, got.Tasks[0].RunID)
	}
}

func TestScheduleResetsFailureStateForEveryParallelSuccess(t *testing.T) {
	h := newChildOutcomeHarness(t, 2)
	g := h.loadDag(t)
	for i := range g.Tasks {
		g.Tasks[i].Attempts = i + 1
		g.Tasks[i].LastFailureKind = FailureKindToolError
		if err := wstore.UpdateRun(h.ctx, h.channel, g.Tasks[i].RunID, func(run *waveobj.Run) error {
			run.Status = jarvis.RunStatus_Done
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := wstore.UpdateDag(h.ctx, h.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Failures = 2
		for i := range cur.Tasks {
			cur.Tasks[i].Attempts = g.Tasks[i].Attempts
			cur.Tasks[i].LastFailureKind = g.Tasks[i].LastFailureKind
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := Schedule(h.ctx, h.dagID); err != nil {
		t.Fatal(err)
	}
	got := h.loadDag(t)
	for _, task := range got.Tasks {
		if task.State != TaskState_Done || task.Attempts != 0 || task.LastFailureKind != "" {
			t.Fatalf("successful task retained failure state: %+v", task)
		}
	}
	if got.Failures != 0 {
		t.Fatalf("failure streak = %d, want 0", got.Failures)
	}
}

func TestShouldCloseOrchestratorLead(t *testing.T) {
	tests := []struct {
		name string
		run  waveobj.Run
		dag  waveobj.TaskGroup
		want bool
	}{
		{
			name: "running dag keeps lead",
			run:  waveobj.Run{Mode: jarvis.RunMode_Orchestrator, Status: jarvis.RunStatus_Executing, Phases: []waveobj.RunPhase{{State: jarvis.PhaseState_Running}}},
			dag:  waveobj.TaskGroup{Status: "running", Tasks: []waveobj.TaskNode{{ID: "t-0", State: TaskState_Running}}},
			want: false,
		},
		{
			name: "orchestrator done + dag done closes",
			run:  waveobj.Run{Mode: jarvis.RunMode_Orchestrator, Status: jarvis.RunStatus_Done, Phases: []waveobj.RunPhase{{State: jarvis.PhaseState_Done}}},
			dag:  waveobj.TaskGroup{Status: "done", Tasks: []waveobj.TaskNode{{ID: "t-0", State: TaskState_Done}}},
			want: true,
		},
		{
			name: "orchestrator done but dag still running keeps",
			run:  waveobj.Run{Mode: jarvis.RunMode_Orchestrator, Status: jarvis.RunStatus_Done},
			dag:  waveobj.TaskGroup{Status: "running", Tasks: []waveobj.TaskNode{{ID: "t-0", State: TaskState_Running}}},
			want: false,
		},
		{
			name: "pipeline done never closes via orchestrator path",
			run:  waveobj.Run{Mode: jarvis.RunMode_Pipeline, Status: jarvis.RunStatus_Done},
			dag:  waveobj.TaskGroup{Status: "done"},
			want: false,
		},
		{
			name: "cancelled orchestrator + dag cancelled closes",
			run:  waveobj.Run{Mode: jarvis.RunMode_Orchestrator, Status: jarvis.RunStatus_Cancelled},
			dag:  waveobj.TaskGroup{Status: "cancelled", Tasks: []waveobj.TaskNode{{ID: "t-0", State: TaskState_Cancelled}}},
			want: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ShouldCloseOrchestratorLead(&tc.run, &tc.dag); got != tc.want {
				t.Errorf("ShouldCloseOrchestratorLead = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMaybeCloseOrchestratorLead(t *testing.T) {
	ctx := context.Background()
	run := &waveobj.Run{
		Mode:        jarvis.RunMode_Orchestrator,
		Status:      jarvis.RunStatus_Done,
		WorkspaceId: "ws-1",
		Phases:      []waveobj.RunPhase{{WorkerOrefs: []string{"tab:lead-tab"}}},
	}
	dagDone := &waveobj.TaskGroup{Status: DagStatus_Done, Tasks: []waveobj.TaskNode{{ID: "t-0", State: TaskState_Done}}}
	dagRunning := &waveobj.TaskGroup{Status: DagStatus_Running, Tasks: []waveobj.TaskNode{{ID: "t-0", State: TaskState_Running}}}

	// should close when done
	called := false
	orig := deleteLeadTab
	deleteLeadTab = func(_ context.Context, ws, tab string) error {
		called = true
		if ws != "ws-1" || tab != "lead-tab" {
			t.Fatalf("delete args ws=%q tab=%q, want ws-1/lead-tab", ws, tab)
		}
		return nil
	}
	t.Cleanup(func() { deleteLeadTab = orig })
	ok, err := MaybeCloseOrchestratorLead(ctx, run, dagDone)
	if err != nil || !ok || !called {
		t.Fatalf("should close done dag: ok=%v err=%v called=%v", ok, err, called)
	}
	// should NOT close while dag still running
	called = false
	ok, err = MaybeCloseOrchestratorLead(ctx, run, dagRunning)
	if err != nil || ok || called {
		t.Fatalf("should keep running dag: ok=%v err=%v called=%v", ok, err, called)
	}
	// pipeline never closes via this path
	pipeRun := &waveobj.Run{Mode: jarvis.RunMode_Pipeline, Status: jarvis.RunStatus_Done, WorkspaceId: "ws-1", Phases: []waveobj.RunPhase{{WorkerOrefs: []string{"tab:lead-tab"}}}}
	called = false
	ok, err = MaybeCloseOrchestratorLead(ctx, pipeRun, dagDone)
	if err != nil || ok || called {
		t.Fatalf("pipeline should not close: ok=%v", ok)
	}
}

func stubSpawnWorker(t *testing.T, worker string, err error) {
	t.Helper()
	old := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		return worker, err
	}
	t.Cleanup(func() { spawnWorker = old })
}
