// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// writePiSession writes a fake pi v3 session file (first line = header with cwd) under the sessions
// root with the given mtime, returning its path.
func writePiSession(t *testing.T, root, dir, cwd string, mtime time.Time) string {
	return writePiSessionWithBody(t, root, dir, cwd, mtime, "")
}

// writePiSessionWithBody writes a fake pi v3 session (header line + extra body text) under the
// sessions root with the given mtime.
func writePiSessionWithBody(t *testing.T, root, dir, cwd string, mtime time.Time, body string) string {
	t.Helper()
	path := filepath.Join(root, dir, "session.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	header, _ := json.Marshal(map[string]string{"id": "s1", "cwd": cwd})
	content := header
	if body != "" {
		content = append(content, '\n')
		content = append(content, body...)
	} else {
		content = append(content, '\n')
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLastActivityForRunMatchesWorktreeSession(t *testing.T) {
	ctx := context.Background()
	oldRoot := sessionsRootFor
	root := t.TempDir()
	sessionsRootFor = func(string) string { return root }
	defer func() { sessionsRootFor = oldRoot }()

	worktree := filepath.Join(t.TempDir(), "wt-ev-1")
	old := time.Now().Add(-20 * time.Minute)
	fresh := time.Now().Add(-1 * time.Minute)
	writePiSession(t, root, "other-proj", filepath.Join(t.TempDir(), "elsewhere"), old)
	writePiSession(t, root, "wt-session", worktree, fresh)
	writePiSession(t, root, "wt-session-old", worktree, old)

	ch, err := wstore.CreateChannel(ctx, "liveness", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tabId := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	blockId := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	run := jarvis.NewRun("g", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	run.ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	run.Runtime = "pi"
	run.Phases[0].WorkerOrefs = []string{"tab:" + tabId}
	runPtr := &run
	tab := &waveobj.Tab{OID: tabId, BlockIds: []string{blockId}}
	if err := wstore.DBInsert(ctx, tab); err != nil {
		t.Fatal(err)
	}
	block := &waveobj.Block{OID: blockId, ParentORef: "tab:" + tabId, Meta: waveobj.MetaMapType{waveobj.MetaKey_CmdCwd: worktree}}
	if err := wstore.DBInsert(ctx, block); err != nil {
		t.Fatal(err)
	}

	got, tracked := lastActivityForRun(runPtr, "")
	if !tracked {
		t.Fatal("pi must be a tracked runtime")
	}
	if got != fresh.UnixMilli() {
		t.Fatalf("want newest matching session mtime %d, got %d", fresh.UnixMilli(), got)
	}
	if got, tracked := lastActivityForRun(nil, ""); got != 0 || tracked {
		t.Fatalf("nil run must be (0,false), got (%d,%v)", got, tracked)
	}
}

// TestLastActivityMarkerExcludesSiblings: two children spawned into the same cwd (non-git project)
// must not refresh each other's heartbeat — only the session whose transcript mentions this task's
// marker counts.
func TestLastActivityMarkerExcludesSiblings(t *testing.T) {
	oldRoot := sessionsRootFor
	root := t.TempDir()
	sessionsRootFor = func(string) string { return root }
	defer func() { sessionsRootFor = oldRoot }()

	shared := t.TempDir()
	fresh := time.Now().Add(-1 * time.Minute)
	writePiSessionWithBody(t, root, "sib-a", shared, fresh, dagSessionMarker("dag-1", "t-a")+"\n")
	writePiSession(t, root, "sib-b", shared, fresh)

	run := &waveobj.Run{Runtime: "pi", DagORef: "dag-1", ProjectPath: shared}
	got, _ := lastActivityForRun(run, dagSessionMarker("dag-1", "t-a"))
	if got == 0 {
		t.Fatal("own marker session must match")
	}
	if got, _ := lastActivityForRun(run, dagSessionMarker("dag-1", "t-b")); got != 0 {
		t.Fatalf("sibling-only sessions must not satisfy a task marker, got %d", got)
	}
}

func TestScheduleOnceFlagsStalledChild(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	cc := &captureClient{}
	prevClient := wps.Broker.GetClient()
	wps.Broker.SetClient(cc)
	defer wps.Broker.SetClient(prevClient)
	wps.Broker.Subscribe("stall-events", wps.SubscriptionRequest{Event: DagEventTaskStalled, AllScopes: true})
	defer wps.Broker.Unsubscribe("stall-events", DagEventTaskStalled)

	// no sessions exist for the child -> liveness probe returns 0, LastActivity stays stale
	oldRoot := sessionsRootFor
	sessionsRootFor = func(string) string { return t.TempDir() }
	defer func() { sessionsRootFor = oldRoot }()

	ch, err := wstore.CreateChannel(ctx, "stall", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
	}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	g.Tasks[0].LastActivity = time.Now().Add(-StallThreshold - time.Minute).UnixMilli()
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	child := jarvis.NewRun("child", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	// as childRunFromSpec builds it: a tracked runtime whose worktree cwd resolves, so the probe has
	// somewhere to look and its silence is a real verdict
	child.Runtime = "pi"
	child.DagORef = g.OID
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatal(err)
	}
	g.Tasks[0].RunID = child.ID
	g.Tasks[0].State = TaskState_Running
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		*cur = g
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if g.Tasks[0].State != TaskState_Stalled {
		t.Fatalf("stale running task must flag stalled, got %s", g.Tasks[0].State)
	}
	if !cc.saw(DagEventTaskStalled, waveobj.MakeORef(waveobj.OType_Dag, g.OID).String()) {
		t.Fatal("task-stalled event not published")
	}

	// a stalled task whose child completes derives done (no stale-stall forever)
	if err := wstore.UpdateRun(ctx, ch.OID, child.ID, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Done
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if g.Tasks[0].State != TaskState_Done {
		t.Fatalf("completed child must derive done even from stalled, got %s", g.Tasks[0].State)
	}
}

func TestScheduleOnceDoesNotStallActiveChild(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	oldRoot := sessionsRootFor
	root := t.TempDir()
	sessionsRootFor = func(string) string { return root }
	defer func() { sessionsRootFor = oldRoot }()

	worktree := filepath.Join(t.TempDir(), "wt-ev-3")
	writePiSession(t, root, "wt-session", worktree, time.Now().Add(-1*time.Minute))

	ch, err := wstore.CreateChannel(ctx, "active", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tabId := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	blockId := "ffffffff-ffff-4fff-8fff-ffffffffffff"
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
	}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	g.Tasks[0].LastActivity = time.Now().Add(-StallThreshold - time.Minute).UnixMilli()
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	// schedule probes with this dag's task marker; the fixture session must mention it to count
	writePiSessionWithBody(t, root, "wt-session-marker", worktree, time.Now().Add(-1*time.Minute),
		dagSessionMarker(g.OID, "t-0"))
	child := jarvis.NewRun("child", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.ID = "11111111-1111-4111-8111-111111111111"
	child.Runtime = "pi"
	child.Phases[0].WorkerOrefs = []string{"tab:" + tabId}
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatal(err)
	}
	tab := &waveobj.Tab{OID: tabId, BlockIds: []string{blockId}}
	if err := wstore.DBInsert(ctx, tab); err != nil {
		t.Fatal(err)
	}
	block := &waveobj.Block{OID: blockId, ParentORef: "tab:" + tabId, Meta: waveobj.MetaMapType{waveobj.MetaKey_CmdCwd: worktree}}
	if err := wstore.DBInsert(ctx, block); err != nil {
		t.Fatal(err)
	}
	g.Tasks[0].RunID = child.ID
	g.Tasks[0].State = TaskState_Running
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		*cur = g
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if g.Tasks[0].State != TaskState_Running {
		t.Fatalf("child with fresh transcript writes must stay running, got %s", g.Tasks[0].State)
	}
	if g.Tasks[0].LastActivity <= time.Now().Add(-StallThreshold).UnixMilli() {
		t.Fatalf("lastactivity must refresh from the session probe, got %d", g.Tasks[0].LastActivity)
	}
}

// F18 regression: the liveness scan used to read pi sessions only, so a claude child — the composer's
// default worker route for a claude lead — never moved off its spawn-time seed and flipped stalled at
// the threshold no matter how hard it was working. Its own transcript must refresh the heartbeat.
func TestScheduleOnceDoesNotStallActiveClaudeChild(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	oldRoot := sessionsRootFor
	root := t.TempDir()
	sessionsRootFor = func(string) string { return root }
	defer func() { sessionsRootFor = oldRoot }()

	worktree := filepath.Join(t.TempDir(), "wt-claude")
	ch, err := wstore.CreateChannel(ctx, "claude-active", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	g.Tasks[0].LastActivity = time.Now().Add(-StallThreshold - time.Minute).UnixMilli()
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	fresh := time.Now().Add(-1 * time.Minute)
	writeClaudeSession(t, root, worktree, "claude-sess", "Goal: a\n\n"+dagSessionMarker(g.OID, "t-0"), fresh)

	child := jarvis.NewRun("child", "ws-1", worktree, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.ID = "22222222-2222-4222-8222-222222222222"
	child.Runtime = "claude"
	child.DagORef = g.OID
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatal(err)
	}
	g.Tasks[0].RunID = child.ID
	g.Tasks[0].State = TaskState_Running
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		*cur = g
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if g.Tasks[0].State != TaskState_Running {
		t.Fatalf("claude child with fresh transcript writes must stay running, got %s", g.Tasks[0].State)
	}
	if g.Tasks[0].LastActivity != fresh.UnixMilli() {
		t.Fatalf("lastactivity must refresh from the claude transcript, want %d got %d", fresh.UnixMilli(), g.Tasks[0].LastActivity)
	}
}

// A runtime liveness cannot read has no heartbeat to age, so its task must report freshness unknown
// rather than stall: the lead's answer to a stall is retry, which kills the child it was told about.
func TestScheduleOnceLeavesUntrackedRuntimeFreshnessUnknown(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	oldRoot := sessionsRootFor
	sessionsRootFor = func(string) string { return t.TempDir() }
	defer func() { sessionsRootFor = oldRoot }()

	ch, err := wstore.CreateChannel(ctx, "untracked", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	g.Tasks[0].LastActivity = time.Now().Add(-StallThreshold - time.Minute).UnixMilli()
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	child := jarvis.NewRun("child", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.ID = "33333333-3333-4333-8333-333333333333"
	child.Runtime = "opencode"
	child.DagORef = g.OID
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatal(err)
	}
	g.Tasks[0].RunID = child.ID
	g.Tasks[0].State = TaskState_Running
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		*cur = g
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if g.Tasks[0].State != TaskState_Running {
		t.Fatalf("an unobservable child must not be flagged stalled, got %s", g.Tasks[0].State)
	}
	if g.Tasks[0].LastActivity != 0 {
		t.Fatalf("freshness must read unknown, got %d", g.Tasks[0].LastActivity)
	}
}

func TestWatchdogTickAdvancesDag(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "watchdog", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1, nil)
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

	// the tick lists running dags and advances each — the fresh dag gets its ready task spawned
	watchdogTick(ctx)
	persisted, err := wstore.GetDag(ctx, g.OID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Tasks[0].State != TaskState_Running {
		t.Fatalf("watchdog tick must advance a running dag, got %s", persisted.Tasks[0].State)
	}
}

func TestSafeTickSurvivesPanic(t *testing.T) {
	old := watchdogTick
	defer func() { watchdogTick = old }()

	// a panicking tick must not take the loop down: recover is per-tick, not per-loop
	watchdogTick = func(ctx context.Context) { panic("boom") }
	safeTick(context.Background())

	ticked := false
	watchdogTick = func(ctx context.Context) { ticked = true }
	safeTick(context.Background())
	if !ticked {
		t.Fatal("watchdog must keep ticking after a panicking tick")
	}
}

// A child that never writes a first token has no transcript mtime to age, so before the first-token
// deadline existed it could never stall: the whole stall path is gated on LastActivity > 0. This is
// the hang case specifically - a child that DIED is caught in seconds by the worker-exit hook.
func TestScheduleOnceFlagsFirstTokenTimeout(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()

	// no sessions anywhere: the probe is tracked (pi child, resolvable cwd) but finds nothing
	oldRoot := sessionsRootFor
	sessionsRootFor = func(string) string { return t.TempDir() }
	defer func() { sessionsRootFor = oldRoot }()

	ch, err := wstore.CreateChannel(ctx, "first-token", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	spawnedTs := time.Now().Add(-FirstTokenDeadline - time.Minute).UnixMilli()
	child := jarvis.NewRun("child", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), spawnedTs)
	child.ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	child.Runtime = "pi"
	child.DagORef = g.OID
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatal(err)
	}
	g.Tasks[0].RunID = child.ID
	g.Tasks[0].State = TaskState_Running
	g.Tasks[0].LastActivity = 0 // never observed writing anything
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		*cur = g
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if g.Tasks[0].State != TaskState_Stalled {
		t.Fatalf("child silent past the first-token deadline must flag stalled, got %s", g.Tasks[0].State)
	}
}

// A child spawned moments ago that has not written yet is simply starting up, not dead.
func TestScheduleOnceLeavesFreshSpawnRunning(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	oldRoot := sessionsRootFor
	sessionsRootFor = func(string) string { return t.TempDir() }
	defer func() { sessionsRootFor = oldRoot }()

	ch, err := wstore.CreateChannel(ctx, "fresh-spawn", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	child := jarvis.NewRun("child", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), time.Now().UnixMilli())
	child.ID = "ffffffff-ffff-4fff-8fff-ffffffffffff"
	child.Runtime = "pi"
	child.DagORef = g.OID
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatal(err)
	}
	g.Tasks[0].RunID = child.ID
	g.Tasks[0].State = TaskState_Running
	g.Tasks[0].LastActivity = 0
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		*cur = g
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if g.Tasks[0].State != TaskState_Running {
		t.Fatalf("a just-spawned child must stay running, got %s", g.Tasks[0].State)
	}
}
