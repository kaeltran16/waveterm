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
	t.Helper()
	path := filepath.Join(root, dir, "session.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	header, _ := json.Marshal(map[string]string{"id": "s1", "cwd": cwd})
	if err := os.WriteFile(path, append(header, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLastActivityForRunMatchesWorktreeSession(t *testing.T) {
	ctx := context.Background()
	oldRoot := piSessionsRoot
	root := t.TempDir()
	piSessionsRoot = func() string { return root }
	defer func() { piSessionsRoot = oldRoot }()

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

	got := lastActivityForRun(runPtr)
	if got != fresh.UnixMilli() {
		t.Fatalf("want newest matching session mtime %d, got %d", fresh.UnixMilli(), got)
	}
	if got := lastActivityForRun(nil); got != 0 {
		t.Fatalf("nil run must be 0, got %d", got)
	}
}

func TestScheduleOnceFlagsStalledChild(t *testing.T) {
	ctx := context.Background()
	cc := &captureClient{}
	prevClient := wps.Broker.GetClient()
	wps.Broker.SetClient(cc)
	defer wps.Broker.SetClient(prevClient)
	wps.Broker.Subscribe("stall-events", wps.SubscriptionRequest{Event: DagEventTaskStalled, AllScopes: true})
	defer wps.Broker.Unsubscribe("stall-events", DagEventTaskStalled)

	// no pi sessions exist for the child -> liveness probe returns 0, LastActivity stays stale
	oldRoot := piSessionsRoot
	piSessionsRoot = func() string { return t.TempDir() }
	defer func() { piSessionsRoot = oldRoot }()

	ch, err := wstore.CreateChannel(ctx, "stall", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, []waveobj.TaskNode{
		{ID: "t-0", Label: "a", LastActivity: time.Now().Add(-StallThreshold - time.Minute).UnixMilli()},
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	child := jarvis.NewRun("child", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
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
	ctx := context.Background()
	oldRoot := piSessionsRoot
	root := t.TempDir()
	piSessionsRoot = func() string { return root }
	defer func() { piSessionsRoot = oldRoot }()

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
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, []waveobj.TaskNode{
		{ID: "t-0", Label: "a", LastActivity: time.Now().Add(-StallThreshold - time.Minute).UnixMilli()},
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	child := jarvis.NewRun("child", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.ID = "11111111-1111-4111-8111-111111111111"
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

func TestWatchdogTickAdvancesDag(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "watchdog", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	old := spawnWorker
	spawnWorker = func(ctx context.Context, cap runroute.Capability, workspaceId, projectName, cwd, prompt string) (string, error) {
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
