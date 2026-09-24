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
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// newLandingRepo is a git project with one commit on main.
func newLandingRepo(t *testing.T) (string, func(args ...string) string) {
	t.Helper()
	dir := t.TempDir()
	execGit := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	execGit("init", "-b", "main")
	execGit("config", "user.email", "t@test")
	execGit("config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	execGit("add", ".")
	execGit("commit", "-m", "base")
	return dir, execGit
}

// a lead's bare `wsh jarvis complete` records the landing branch's tip, not the checkout's head, which is
// the human's work
func TestLeadCompletingABranchRunRecordsTheLandingTip(t *testing.T) {
	f := newLeadCompleteFixture(t)
	ctx := context.Background()
	tree, err := orchestrate.CreateRunWorktree(ctx, f.projectDir, f.owner.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tree, "landed.txt"), []byte("lane\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.git(t, "-C", tree, "add", "landed.txt")
	f.git(t, "-C", tree, "commit", "-m", "run t-1: landed")
	if err := wstore.UpdateRun(ctx, f.channelId, f.owner.ID, func(r *waveobj.Run) error {
		r.LandPath = tree
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	run := f.complete(t, f.owner.ID)
	if tip := f.git(t, "rev-parse", "wave/"+f.owner.ID); run.EndCommit != tip {
		t.Fatalf("EndCommit = %q, want the landing tip %s", run.EndCommit, tip)
	}
}

func TestDagSubmitRunsSetupInTheLandingTree(t *testing.T) {
	ctx := context.Background()
	// newRun returns the run's project and a submit of the plan whose Setup is setup, in the given context
	newRun := func(t *testing.T, landPath, setup string) (string, func(context.Context) error) {
		t.Helper()
		ch, err := wstore.CreateChannel(ctx, "landing-setup", t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		run := jarvis.NewRun("g", "ws", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(), 1)
		run.Status = jarvis.RunStatus_Planning
		run.LandPath = landPath
		if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
			t.Fatal(err)
		}
		plan := filepath.Join(t.TempDir(), "plan.md")
		if err := os.WriteFile(plan, []byte("**Setup:** `"+setup+"`\n\n### Task 1: input\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		return ch.ProjectPath, func(c context.Context) error {
			_, err := (&WshServer{}).DagSubmitCommand(c, wshrpc.CommandDagSubmitData{ChannelId: ch.OID, RunId: run.ID, PlanPath: plan})
			return err
		}
	}
	submit := func(t *testing.T, landPath, setup string) (string, error) {
		t.Helper()
		project, do := newRun(t, landPath, setup)
		return project, do(ctx)
	}

	// a lead's `dag submit` carries a short RPC deadline; a Setup such as a fresh install outlives it
	t.Run("setup is not bound by the submit's deadline", func(t *testing.T) {
		tree := t.TempDir()
		_, do := newRun(t, tree, "sleep 2 && echo ok > prepared.txt")
		short, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
		defer cancel()
		if err := do(short); err != nil {
			t.Fatalf("submit: %v", err)
		}
		if _, err := os.Stat(filepath.Join(tree, "prepared.txt")); err != nil {
			t.Fatalf("setup did not finish: %v", err)
		}
	})

	// a resubmit after a client timeout finds the dag stored and merges possibly running in the tree
	t.Run("a resubmit does not run setup again", func(t *testing.T) {
		tree := t.TempDir()
		_, do := newRun(t, tree, "echo run >> setup.log")
		if err := do(ctx); err != nil {
			t.Fatal(err)
		}
		_ = do(ctx)
		out, err := os.ReadFile(filepath.Join(tree, "setup.log"))
		if err != nil {
			t.Fatal(err)
		}
		if n := strings.Count(string(out), "run"); n != 1 {
			t.Fatalf("setup ran %d times, want once", n)
		}
	})

	t.Run("setup prepares the landing tree, not the checkout", func(t *testing.T) {
		tree := t.TempDir()
		project, err := submit(t, tree, "echo ok > prepared.txt")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(tree, "prepared.txt")); err != nil {
			t.Fatalf("setup did not run in the landing tree: %v", err)
		}
		if _, err := os.Stat(filepath.Join(project, "prepared.txt")); err == nil {
			t.Fatal("setup ran in the project checkout")
		}
	})

	t.Run("a failing setup refuses the submit", func(t *testing.T) {
		if _, err := submit(t, t.TempDir(), "exit 3"); err == nil || !strings.Contains(err.Error(), "setup") {
			t.Fatalf("error %v should refuse the submit over setup", err)
		}
	})

	t.Run("a run landing in the checkout runs no setup at submit", func(t *testing.T) {
		project, err := submit(t, "", "echo ok > prepared.txt")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(project, "prepared.txt")); err == nil {
			t.Fatal("setup ran at submit for a run with no landing tree")
		}
	})
}

func createLandingRun(t *testing.T, ctx context.Context, projectDir, mode string, landing *string) (*waveobj.Channel, *waveobj.Run, error) {
	t.Helper()
	stubRunServer(t, "pi", nil)
	ch, err := wstore.CreateChannel(ctx, "landing", projectDir)
	if err != nil {
		t.Fatal(err)
	}
	if landing != nil {
		seedProfileMeta(t, ctx, ch.OID, &waveobj.ProfileOverride{Landing: landing})
	}
	rtn, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "g", Runtime: "pi", Mode: mode, DeferStart: true,
	})
	if err != nil {
		return ch, nil, err
	}
	return ch, rtn.Run, nil
}

func TestCreateRunLandsOnItsOwnBranch(t *testing.T) {
	ctx := context.Background()
	projectDir, execGit := newLandingRepo(t)
	base := execGit("rev-parse", "HEAD")
	_, run, err := createLandingRun(t, ctx, projectDir, jarvis.RunMode_Orchestrator, strPtr(jarvis.Landing_Branch))
	if err != nil {
		t.Fatalf("CreateRunCommand: %v", err)
	}
	want := filepath.Join(projectDir, ".waveterm", "worktrees", run.ID)
	if run.LandPath != want {
		t.Fatalf("landpath = %q, want %q", run.LandPath, want)
	}
	if got := execGit("-C", run.LandPath, "rev-parse", "--abbrev-ref", "HEAD"); got != "wave/"+run.ID {
		t.Fatalf("landing tree is on %q, want wave/%s", got, run.ID)
	}
	if got := execGit("rev-parse", "wave/"+run.ID); got != base {
		t.Fatalf("landing branch starts at %s, want the run's base %s", got, base)
	}
	if got := execGit("rev-parse", "--abbrev-ref", "HEAD"); got != "main" {
		t.Fatalf("the project checkout moved to %q", got)
	}
}

func TestCreateRunLandingLeavesLandPathEmpty(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name    string
		git     bool
		mode    string
		landing *string
	}{
		{"checkout landing", true, jarvis.RunMode_Orchestrator, strPtr(jarvis.Landing_Checkout)},
		{"no landing set", true, jarvis.RunMode_Orchestrator, nil},
		{"quick run", true, jarvis.RunMode_Quick, strPtr(jarvis.Landing_Branch)},
		{"not a git project", false, jarvis.RunMode_Orchestrator, strPtr(jarvis.Landing_Branch)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			projectDir := t.TempDir()
			if c.git {
				projectDir, _ = newLandingRepo(t)
			}
			_, run, err := createLandingRun(t, ctx, projectDir, c.mode, c.landing)
			if err != nil {
				t.Fatalf("CreateRunCommand: %v", err)
			}
			if run.LandPath != "" {
				t.Fatalf("landpath = %q, want empty", run.LandPath)
			}
			if _, err := os.Stat(filepath.Join(projectDir, ".waveterm", "worktrees")); !os.IsNotExist(err) {
				t.Fatalf("no landing tree should be created, stat err %v", err)
			}
		})
	}
}

// A run that asked for its own branch and cannot have one must not land in the checkout instead.
func TestCreateRunCancelsWhenTheLandingTreeFails(t *testing.T) {
	ctx := context.Background()
	projectDir, _ := newLandingRepo(t)
	// a file where the worktrees dir belongs makes `git worktree add` fail
	if err := os.MkdirAll(filepath.Join(projectDir, ".waveterm"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, ".waveterm", "worktrees"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	ch, _, err := createLandingRun(t, ctx, projectDir, jarvis.RunMode_Orchestrator, strPtr(jarvis.Landing_Branch))
	if err == nil || !strings.Contains(err.Error(), "landing") {
		t.Fatalf("error %v should name the landing tree", err)
	}
	runs, gerr := wstore.GetChannelRuns(ctx, ch.OID)
	if gerr != nil {
		t.Fatal(gerr)
	}
	if len(runs) != 1 || runs[0].Status != jarvis.RunStatus_Cancelled {
		t.Fatalf("the failed launch leaves one cancelled run, got %+v", runs)
	}
}

func TestSetChannelProfileRejectsUnknownLanding(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "profile-landing", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := (&WshServer{}).SetChannelProfileCommand(ctx, wshrpc.CommandSetChannelProfileData{
		ChannelId: ch.OID, Override: &waveobj.ProfileOverride{Landing: strPtr("elsewhere")},
	}); err == nil {
		t.Fatal("expected an unknown landing to be rejected")
	}
	if channelHasProfileMeta(t, ctx, ch.OID) {
		t.Fatal("a rejected landing must not write channel meta")
	}
}
