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
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
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

// A stalled task is the lead's judgment only when its worker is hung: the process still runs and it is
// not waiting on an answer. A worker whose process exited fails through the exit path, and one waiting on
// an answer belongs to the question queue.
func TestStalledTaskWakesLeadOnlyWhenWorkerIsHung(t *testing.T) {
	const workerBlock = "3c9d2e1f-8a7b-4c6d-9e5f-0a1b2c3d4e5f"
	cases := []struct {
		name   string
		alive  bool
		asking bool
		want   []string
	}{
		{"hung-alive", true, false, []string{"wake: task t-0 hung: silent 6m, process alive, no ask pending. wsh jarvis dag status"}},
		{"hung-asking", true, true, nil},
		{"hung-exited", false, false, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeLead(t)
			ctx, g := seedSilentChild(t, tc.name)
			prev := workerBlockFn
			workerBlockFn = func(context.Context, *waveobj.Run) (string, bool) { return workerBlock, tc.alive }
			t.Cleanup(func() { workerBlockFn = prev })
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
