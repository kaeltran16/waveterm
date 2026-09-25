// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

type leadCompleteFixture struct {
	projectDir string
	channelId  string
	owner      waveobj.Run
	child      waveobj.Run
	seal       func()
}

func (f *leadCompleteFixture) git(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", f.projectDir}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func (f *leadCompleteFixture) write(t *testing.T, rel, content string) {
	t.Helper()
	path := filepath.Join(f.projectDir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// a plan-driven run whose task landed through the engine's merge, with the untracked recovery patch a
// cancelled earlier attempt left in the project tree
func newLeadCompleteFixture(t *testing.T) *leadCompleteFixture {
	ctx := context.Background()
	f := &leadCompleteFixture{projectDir: t.TempDir()}
	f.git(t, "init", "-b", "main")
	f.git(t, "config", "user.email", "t@test")
	f.git(t, "config", "user.name", "t")
	f.write(t, "base.txt", "base\n")
	f.git(t, "add", ".")
	f.git(t, "commit", "-m", "base")
	base := f.git(t, "rev-parse", "HEAD")

	ch, err := wstore.CreateChannel(ctx, "lead-complete", f.projectDir)
	if err != nil {
		t.Fatal(err)
	}
	f.channelId = ch.OID
	f.owner = jarvis.NewRun("ship it", "ws-1", f.projectDir, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(), 1)
	f.owner.BaseCommit = base
	f.child = jarvis.NewRun("task 1", "ws-1", f.projectDir, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	f.child.BaseCommit = base
	dag, err := orchestrate.NewTaskGroup(f.owner.ID, ch.OID, "g", 1, true, []waveobj.TaskNode{{ID: "t-1", Label: "task 1"}}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.owner.DagORef, f.child.DagORef = dag.OID, dag.OID
	for _, r := range []waveobj.Run{f.owner, f.child} {
		if err := wstore.AppendRun(ctx, ch.OID, r); err != nil {
			t.Fatal(err)
		}
	}
	if err := wstore.AppendDag(ctx, &dag); err != nil {
		t.Fatal(err)
	}

	f.write(t, "t-1.txt", "hello\n")
	f.git(t, "add", ".")
	f.git(t, "commit", "-m", "run t-1: task 1", "-m", jarvis.RunTrailerKey+": "+f.owner.ID+"-t-1")
	f.write(t, ".waveterm/recovery/earlier-attempt-t-1.patch", "")

	origSeal, origCapture, origSchedule := sealAsync, captureAsync, scheduleAsync
	sealAsync = func(fn func()) { f.seal = fn }
	captureAsync = func(func()) {}
	// the engine would spawn the fixture's t-1 in a worktree of the temp repo while the test removes it
	scheduleAsync = func(func()) {}
	t.Cleanup(func() { sealAsync, captureAsync, scheduleAsync = origSeal, origCapture, origSchedule })
	return f
}

func (f *leadCompleteFixture) complete(t *testing.T, runId string) *waveobj.Run {
	t.Helper()
	ctx := context.Background()
	if err := (&WshServer{}).AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: f.channelId, RunId: runId, PhaseIdx: 0, Action: jarvis.RunAction_Complete,
	}); err != nil {
		t.Fatalf("AdvanceRunCommand: %v", err)
	}
	run, err := wstore.GetRun(ctx, f.channelId, runId)
	if err != nil {
		t.Fatal(err)
	}
	return run
}

// the lead's rules end the run with a bare `wsh jarvis complete`: every task landed through the engine's
// merges, so the project head is the run's work, as it is for a run the engine closes with no lead.
// Without it the seal diffed the working tree and counted the engine's own .waveterm files.
func TestLeadCompletingItsPlanRunRecordsTheProjectHead(t *testing.T) {
	f := newLeadCompleteFixture(t)
	run := f.complete(t, f.owner.ID)
	if head := f.git(t, "rev-parse", "HEAD"); run.EndCommit != head {
		t.Fatalf("EndCommit = %q, want the project head %s", run.EndCommit, head)
	}
	if f.seal == nil {
		t.Fatal("completing the run dispatched no evidence seal")
	}
	f.seal()
	sealed, err := wstore.GetRun(context.Background(), f.channelId, f.owner.ID)
	if err != nil || sealed.Evidence == nil {
		t.Fatalf("evidence not sealed: %v", err)
	}
	var files []string
	for _, ef := range sealed.Evidence.Files {
		files = append(files, ef.Path)
	}
	if len(files) != 1 || files[0] != "t-1.txt" {
		t.Fatalf("sealed files = %v, want only the landed t-1.txt", files)
	}
}

// a task's worker completes in its own worktree and reports its commit itself; the project head is not its
// work, and the engine records the lane's merge commit on it later
func TestATaskCompletingWithoutACommitGetsNoProjectHead(t *testing.T) {
	f := newLeadCompleteFixture(t)
	if run := f.complete(t, f.child.ID); run.EndCommit != "" {
		t.Fatalf("a task run must not be credited with the project head, got %q", run.EndCommit)
	}
}
