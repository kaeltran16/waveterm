// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/agentobserve"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	liveSession    = "0b6f7c1e-4d2a-4f3b-9c8d-1a2b3c4d5e6f"
	siblingSession = "5d1c2b3a-6e7f-4a8b-9c0d-1e2f3a4b5c6d"
)

// writeClaudeSession writes a transcript where claude puts one launched with --session-id: the projects
// dir it derives from cwd, named by the session id.
func writeClaudeSession(t *testing.T, root, cwd, sessionId string, mtime time.Time) string {
	t.Helper()
	return writeTranscript(t, filepath.Join(root, agentobserve.SlugifyCwd(cwd), sessionId+".jsonl"), mtime)
}

// writePiSession writes a transcript the way pi names one launched with --session-id: a timestamp, then
// the id.
func writePiSession(t *testing.T, root, sessionId string, mtime time.Time) string {
	t.Helper()
	return writeTranscript(t, filepath.Join(root, "--wt--", "2026-09-15T03-10-10-831Z_"+sessionId+".jsonl"), mtime)
}

func writeTranscript(t *testing.T, path string, mtime time.Time) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	return path
}

func stubSessionsRoot(t *testing.T, root string) {
	t.Helper()
	prev := sessionsRootFor
	sessionsRootFor = func(string) string { return root }
	t.Cleanup(func() { sessionsRootFor = prev })
}

// A child's heartbeat is its own transcript, opened by the session id it was launched with. A sibling
// spawned into the same cwd writes its own file, and its writes must not keep this child alive.
func TestLastActivityReadsTheChildsOwnSession(t *testing.T) {
	worktree := filepath.Join(t.TempDir(), "wt-t-0")
	own := time.Now().Add(-20 * time.Minute)
	sibling := time.Now().Add(-1 * time.Minute)
	for _, runtime := range []string{"claude", "pi"} {
		t.Run(runtime, func(t *testing.T) {
			root := t.TempDir()
			stubSessionsRoot(t, root)
			if runtime == "claude" {
				writeClaudeSession(t, root, worktree, liveSession, own)
				writeClaudeSession(t, root, worktree, siblingSession, sibling)
			} else {
				writePiSession(t, root, liveSession, own)
				writePiSession(t, root, siblingSession, sibling)
			}
			run := &waveobj.Run{Runtime: runtime, DagORef: "dag-1", ProjectPath: worktree, SessionId: liveSession}
			if got, tracked := lastActivityForRun(run); !tracked || got != own.UnixMilli() {
				t.Fatalf("want (%d, true) from the child's own session, got (%d, %v)", own.UnixMilli(), got, tracked)
			}
		})
	}
}

// Before its first write a child is tracked with nothing to read, which is what the first-token deadline
// judges; that is not the same as a child liveness cannot observe at all.
func TestLastActivityBeforeTheFirstWrite(t *testing.T) {
	stubSessionsRoot(t, t.TempDir())
	run := &waveobj.Run{Runtime: "pi", DagORef: "dag-1", ProjectPath: t.TempDir(), SessionId: liveSession}
	if got, tracked := lastActivityForRun(run); !tracked || got != 0 {
		t.Fatalf("want (0, true), got (%d, %v)", got, tracked)
	}
}

// A child liveness cannot read must report untracked, never a frozen timestamp: the caller's stall
// verdict is what kills a healthy child.
func TestLastActivityUntracked(t *testing.T) {
	stubSessionsRoot(t, t.TempDir())
	for _, rt := range []string{"codex", "opencode", "gemini"} {
		run := &waveobj.Run{Runtime: rt, DagORef: "dag-1", ProjectPath: t.TempDir(), SessionId: liveSession}
		if got, tracked := lastActivityForRun(run); tracked || got != 0 {
			t.Fatalf("runtime %q: want (0,false), got (%d,%v)", rt, got, tracked)
		}
	}
	// a child spawned before workers were launched under a session id has no file to open
	noSession := &waveobj.Run{Runtime: "claude", DagORef: "dag-1", ProjectPath: t.TempDir()}
	if got, tracked := lastActivityForRun(noSession); tracked || got != 0 {
		t.Fatalf("no session id: want (0,false), got (%d,%v)", got, tracked)
	}
	if got, tracked := lastActivityForRun(nil); tracked || got != 0 {
		t.Fatalf("nil run: want (0,false), got (%d,%v)", got, tracked)
	}
}

// The engine names each worker's session when it spawns it and records the name on the child run, which
// is how liveness and evidence open the right transcript. claude rejects an id that is not a UUID.
func TestDispatchLaunchesWorkerUnderRecordedSessionId(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx, g, channelID, _ := seedDispatchDag(t, "dispatch-session-id")
	var launched string
	old := spawnWorker
	spawnWorker = func(_ context.Context, _ runroute.Capability, _, _, _, _ string, opts jarvis.RunWorkerOptions) (string, error) {
		launched = opts.SessionId
		return "tab:worker", nil
	}
	t.Cleanup(func() { spawnWorker = old })

	if err := ScheduleOnce(ctx, g); err != nil {
		t.Fatal(err)
	}
	if _, err := uuid.Parse(launched); err != nil {
		t.Fatalf("worker launched with session id %q: %v", launched, err)
	}
	child, err := wstore.GetRun(ctx, channelID, g.Tasks[0].RunID)
	if err != nil {
		t.Fatal(err)
	}
	if child.SessionId != launched {
		t.Fatalf("child run records session %q, the worker was launched with %q", child.SessionId, launched)
	}
}

// seedSilentChild records a running pi child spawned past the first-token deadline that has written
// nothing, so the next tick flags its task stalled.
func seedSilentChild(t *testing.T, name string) (context.Context, *waveobj.TaskGroup) {
	t.Helper()
	allowWorkerHarnessForTest(t)
	stubSessionsRoot(t, t.TempDir())
	ctx, g, channelID, _ := seedDispatchDag(t, name)
	spawned := time.Now().Add(-FirstTokenDeadline - time.Minute).UnixMilli()
	child := jarvis.NewRun("child", "ws-1", t.TempDir(), nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), spawned)
	child.Runtime = "pi"
	child.DagORef = g.OID
	child.SessionId = liveSession
	if err := wstore.AppendRun(ctx, channelID, child); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[0].RunID = child.ID
		cur.Tasks[0].State = TaskState_Running
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return ctx, g
}

// A stalled task is the lead's judgment unless its worker is waiting on an answer, which belongs to the
// question queue. A worker whose process is gone while its task still runs was missed by the exit path, so
// the lead hears of it.
func TestStalledTaskWakesLeadUnlessWorkerIsAsking(t *testing.T) {
	const workerBlock = "3c9d2e1f-8a7b-4c6d-9e5f-0a1b2c3d4e5f"
	cases := []struct {
		name   string
		alive  bool
		asking bool
		status string
		want   []string
	}{
		{"hung-alive", true, false, blockcontroller.Status_Running, []string{"wake: task t-0 hung: silent 6m, process alive, no ask pending. wsh jarvis dag status"}},
		{"hung-asking", true, true, blockcontroller.Status_Running, nil},
		{"hung-exited", false, false, blockcontroller.Status_Done, []string{"wake: task t-0's worker exited without reporting complete. wsh jarvis dag status"}},
		// no process ever means no exit hook either, so the lead is the only one who will hear of it
		{"never-started", false, false, blockcontroller.Status_Init, []string{"wake: task t-0 never started: no worker process 6m after spawn. wsh jarvis dag retry t-0"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeLead(t)
			ctx, g := seedSilentChild(t, tc.name)
			prev := workerBlockFn
			workerBlockFn = func(context.Context, *waveobj.Run) (string, bool) { return workerBlock, tc.alive }
			prevStatus := blockShellStatus
			blockShellStatus = func(string) string { return tc.status }
			t.Cleanup(func() { workerBlockFn, blockShellStatus = prev, prevStatus })
			if tc.asking {
				oref := waveobj.MakeORef(waveobj.OType_Block, workerBlock).String()
				agentask.GlobalRegistry.Set(oref, agentask.PendingAsk{AskId: "a1", BlockId: workerBlock})
			}

			if err := ScheduleOnce(ctx, g); err != nil {
				t.Fatal(err)
			}
			if g.Tasks[0].State != TaskState_Stalled {
				t.Fatalf("a pi child silent past the first-token deadline stalls, got %s", g.Tasks[0].State)
			}
			if !reflect.DeepEqual(f.sends, tc.want) {
				t.Fatalf("want wakes %q, got %q", tc.want, f.sends)
			}
		})
	}
}

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

func stubChildCPU(t *testing.T, sample func(call int) (int64, bool)) {
	t.Helper()
	prev, calls := childCPUTime, 0
	childCPUTime = func(string) (int64, bool) {
		calls++
		return sample(calls)
	}
	t.Cleanup(func() { childCPUTime = prev })
}

func tick(t *testing.T, ctx context.Context, g *waveobj.TaskGroup) *waveobj.TaskNode {
	t.Helper()
	if err := ScheduleOnce(ctx, g); err != nil {
		t.Fatal(err)
	}
	return &g.Tasks[0]
}

// A worker sitting in a foreground test run writes no transcript, but its process tree is using CPU.
func TestBusyChildIsNotStalled(t *testing.T) {
	ctx, g, quiet := seedQuietChild(t, "busy-child")
	stubChildCPU(t, func(call int) (int64, bool) { return int64(call) * 1000, true })

	if task := tick(t, ctx, g); task.State != TaskState_Running {
		t.Fatalf("the first reading is only a baseline, got %s", task.State)
	}
	before := time.Now().UnixMilli()
	task := tick(t, ctx, g)
	if task.State != TaskState_Running {
		t.Fatalf("a child whose CPU advanced is not stalled, got %s", task.State)
	}
	if task.LastActivity <= quiet || task.LastActivity < before {
		t.Fatalf("busy CPU refreshes LastActivity past the transcript's %d, got %d", quiet, task.LastActivity)
	}
}

func TestIdleChildStillStalls(t *testing.T) {
	ctx, g, _ := seedQuietChild(t, "idle-child")
	stubChildCPU(t, func(int) (int64, bool) { return 5000, true })

	if task := tick(t, ctx, g); task.State != TaskState_Running {
		t.Fatalf("the first reading is only a baseline, got %s", task.State)
	}
	if task := tick(t, ctx, g); task.State != TaskState_Stalled {
		t.Fatalf("a child with flat CPU stalls, got %s", task.State)
	}
}

func TestNoCPUReadingLeavesTheMtimeRule(t *testing.T) {
	ctx, g, _ := seedQuietChild(t, "no-cpu-reading")
	stubChildCPU(t, func(int) (int64, bool) { return 0, false })

	if task := tick(t, ctx, g); task.State != TaskState_Stalled {
		t.Fatalf("with no CPU reading the transcript age decides, got %s", task.State)
	}
}

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

// an empty id makes the scope "", which the broker keeps every event under: a worker with no tab must not read
// another block's status as its own
func TestLatestAgentStatusIgnoresAnEmptyScope(t *testing.T) {
	const otherBlock = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
	wps.Broker.Publish(blockcontroller.AgentStatusEvent(otherBlock, baseds.AgentState_Idle, "claude", time.Now().UnixMilli()))
	if st := latestAgentStatus("9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b", ""); st.State != "" {
		t.Fatalf("a block with no status of its own read %q from another block", st.State)
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
