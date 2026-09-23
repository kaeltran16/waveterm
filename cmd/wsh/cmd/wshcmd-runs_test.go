// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestRunsStartData(t *testing.T) {
	cases := []struct {
		name    string
		opts    runsStartOpts
		wantErr string
		check   func(t *testing.T, d wshrpc.CommandCreateRunData)
	}{
		{name: "goal defaults to the server's mode", opts: runsStartOpts{goal: "fix it"}, check: func(t *testing.T, d wshrpc.CommandCreateRunData) {
			if d.Goal != "fix it" || d.Mode != "" {
				t.Fatalf("got goal %q mode %q", d.Goal, d.Mode)
			}
		}},
		{name: "plan implies orchestrator", opts: runsStartOpts{plan: "p.md"}, check: func(t *testing.T, d wshrpc.CommandCreateRunData) {
			if d.Mode != jarvis.RunMode_Orchestrator || d.PlanPath != "p.md" {
				t.Fatalf("got mode %q plan %q", d.Mode, d.PlanPath)
			}
		}},
		{name: "plan with quick is refused", opts: runsStartOpts{plan: "p.md", mode: jarvis.RunMode_Quick}, wantErr: "--plan needs an orchestrator"},
		{name: "deleted pipeline mode is refused", opts: runsStartOpts{goal: "g", mode: "pipeline"}, wantErr: "--mode must be quick or orchestrator"},
		{name: "needs a goal or a plan", opts: runsStartOpts{}, wantErr: "pass a goal"},
		{name: "parallelism needs orchestrator", opts: runsStartOpts{goal: "g", parallelism: 3}, wantErr: "need an orchestrator run"},
		{name: "worker model needs worker runtime", opts: runsStartOpts{goal: "g", mode: jarvis.RunMode_Orchestrator, workerModel: "m"}, wantErr: "--worker-model needs --worker-runtime"},
		{name: "effort without chunk", opts: runsStartOpts{goal: "g", effort: "e"}, wantErr: "--effort and --chunk go together"},
		{name: "chunk without effort", opts: runsStartOpts{goal: "g", chunk: "2"}, wantErr: "--effort and --chunk go together"},
		{name: "orchestrator dials and effort ref", opts: runsStartOpts{
			goal: "g", mode: jarvis.RunMode_Orchestrator, parallelism: 3, workerRuntime: "pi",
			effort: "effort:abc", chunk: "Build",
		}, check: func(t *testing.T, d wshrpc.CommandCreateRunData) {
			if d.Parallelism != 3 || d.WorkerRoute == nil || d.WorkerRoute.Runtime != "pi" {
				t.Fatalf("engine dials = %d %+v", d.Parallelism, d.WorkerRoute)
			}
			if d.EffortOID != "abc" || d.ChunkLabel != "Build" {
				t.Fatalf("effort ref = %q %q, want the oref prefix stripped", d.EffortOID, d.ChunkLabel)
			}
		}},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			d, err := runsStartData(tt.opts)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			tt.check(t, d)
		})
	}
}

func TestRunsRoutePrecedence(t *testing.T) {
	saved := &waveobj.ProfileOverride{Route: &waveobj.RoutePin{Runtime: "pi", Model: "saved"}}
	settings := wconfig.SettingsType{HarnessPreferredRuntime: "claude", HarnessPreferredModel: "pref"}

	if got, _ := runsRoute("claude", "explicit", saved, settings); got.Model != "explicit" {
		t.Fatalf("explicit route lost to %+v", got)
	}
	if got, _ := runsRoute("", "", saved, settings); got.Runtime != "pi" || got.Model != "saved" {
		t.Fatalf("project route lost to %+v", got)
	}
	if got, _ := runsRoute("", "", nil, settings); got.Runtime != "claude" || got.Model != "pref" {
		t.Fatalf("settings route = %+v", got)
	}
	if _, err := runsRoute("", "", nil, wconfig.SettingsType{}); err == nil {
		t.Fatal("no route anywhere must be an error, not an empty runtime the server rejects")
	}
	if _, err := runsRoute("", "m", saved, settings); err == nil {
		t.Fatal("--model without --runtime must be refused")
	}
}

// A missed reply is not a failed launch: the message must stop a retry, which would start the run twice.
func TestRunsStartErr(t *testing.T) {
	got := runsStartErr(errors.New("EC-TIME: timeout waiting for response"))
	if !strings.Contains(got.Error(), "may have launched") || !strings.Contains(got.Error(), "wsh runs list") {
		t.Fatalf("timeout message = %q", got)
	}
	other := errors.New("unsupported route runtime")
	if runsStartErr(other) != other {
		t.Fatal("a real refusal must pass through unchanged")
	}
}

func TestRunsPickWorkspace(t *testing.T) {
	one := []wshrpc.WorkspaceInfoData{{WorkspaceData: &waveobj.Workspace{OID: "ws-1"}}}
	if got, err := runsPickWorkspace(one); err != nil || got != "ws-1" {
		t.Fatalf("one workspace = %q %v", got, err)
	}
	two := append(one, wshrpc.WorkspaceInfoData{WorkspaceData: &waveobj.Workspace{OID: "ws-2"}})
	if _, err := runsPickWorkspace(two); err == nil {
		t.Fatal("two workspaces must not be guessed between")
	}
	if _, err := runsPickWorkspace(nil); err == nil {
		t.Fatal("no workspace must be an error")
	}
}

// An agent working in a worktree must land on the channel registered at the main checkout.
func TestRunsProjectRootResolvesWorktreeToMainCheckout(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	main := t.TempDir()
	git := func(dir string, args ...string) {
		t.Helper()
		out, err := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git(main, "init", "-q")
	git(main, "commit", "-q", "--allow-empty", "-m", "init")
	wt := filepath.Join(t.TempDir(), "wt")
	git(main, "worktree", "add", "-q", wt)

	chans := []*waveobj.Channel{{OID: "other", ProjectPath: t.TempDir()}, {OID: "proj", ProjectPath: main}}
	for _, dir := range []string{main, wt, filepath.Join(wt, ".")} {
		root, err := runsProjectRoot(context.Background(), dir)
		if err != nil {
			t.Fatal(err)
		}
		if ch := wstore.MatchChannelAtPath(chans, root); ch == nil || ch.OID != "proj" {
			t.Fatalf("%s resolved to %q, which matches no project channel", dir, root)
		}
	}

	plain := t.TempDir()
	if root, err := runsProjectRoot(context.Background(), plain); err != nil || root != plain {
		t.Fatalf("outside a repository the root is the dir itself: %q %v", root, err)
	}
}

func TestRunsNewestAndListLines(t *testing.T) {
	rows := []runsRow{
		{Channel: "a", Run: &waveobj.Run{ID: "old", Status: "done", Mode: "quick", Goal: "first", CreatedTs: 1_000}},
		{Channel: "b", Run: &waveobj.Run{ID: "new", Status: "executing", Mode: "orchestrator", Goal: "second", CreatedTs: 3_000}},
		{Channel: "a", Run: &waveobj.Run{ID: "mid", Status: "cancelled", Goal: "third", CreatedTs: 2_000}},
	}
	got := runsNewest(rows, 2)
	if len(got) != 2 || got[0].Run.ID != "new" || got[1].Run.ID != "mid" {
		t.Fatalf("newest two = %v, %v", got[0].Run.ID, got[1].Run.ID)
	}
	lines := runsListLines(got, true, 5_000)
	if !strings.HasPrefix(lines[0], "new") || !strings.Contains(lines[0], " b ") || !strings.Contains(lines[0], "second") {
		t.Fatalf("list line = %q", lines[0])
	}
	if !strings.Contains(lines[1], "pipeline") {
		t.Fatalf("a run with no mode is a legacy pipeline run: %q", lines[1])
	}
	if got := runsListLines(nil, false, 0); len(got) != 1 || got[0] != "no runs" {
		t.Fatalf("empty list = %v", got)
	}
}

func TestRunsLiveWorkers(t *testing.T) {
	run := &waveobj.Run{Phases: []waveobj.RunPhase{
		{State: jarvis.PhaseState_Done, WorkerOrefs: []string{"tab:a"}},
		{State: jarvis.PhaseState_Running, WorkerOrefs: []string{"tab:b", "tab:c"}},
	}}
	if got := runsLiveWorkers(run, nil); got != 2 {
		t.Fatalf("running phase workers = %d, want 2", got)
	}
	digest := &wshrpc.CommandDagStatusRtnData{Digest: wshrpc.DagStatusDigest{Counts: wshrpc.DagStatusCounts{Running: 3}}}
	if got := runsLiveWorkers(run, digest); got != 5 {
		t.Fatalf("with running tasks = %d, want 5", got)
	}
	if got := runsLiveWorkers(&waveobj.Run{}, nil); got != 0 {
		t.Fatalf("idle run = %d, want 0 so cancel needs no --yes", got)
	}
}

func TestRunsShowLines(t *testing.T) {
	ch := &waveobj.Channel{OID: "ch-1", Name: "waveterm"}
	run := &waveobj.Run{
		ID: "r-1", Goal: "ship it", Status: "done", Mode: "quick", Runtime: "claude", CreatedTs: 1,
		EffortRef:  &waveobj.RunEffortRef{EffortOID: "e-1", ChunkLabel: "Build"},
		BaseCommit: "aaaaaaaaaa", EndCommit: "bbbbbbbbbb", Report: "lead report",
	}
	out := strings.Join(runsShowLines(ch, run, nil, 2), "\n")
	for _, want := range []string{"r-1", "ship it", "waveterm (channel ch-1)", "effort:e-1", `"Build"`, "aaaaaaa..bbbbbbb", "lead report"} {
		if !strings.Contains(out, want) {
			t.Fatalf("show output lacks %q:\n%s", want, out)
		}
	}
	run.Evidence = &waveobj.RunEvidence{Summary: "sealed summary", AddTotal: 4, Files: []waveobj.EvidenceFile{{Path: "x"}}}
	out = strings.Join(runsShowLines(ch, run, nil, 2), "\n")
	if !strings.Contains(out, "sealed summary") || strings.Contains(out, "lead report") || !strings.Contains(out, "1 files  +4 -0") {
		t.Fatalf("a sealed run must show its sealed summary:\n%s", out)
	}
}

func TestRunsAttentionLines(t *testing.T) {
	if got := runsAttentionLines(nil, 0); got[0] != "nothing is waiting on you" {
		t.Fatalf("empty = %v", got)
	}
	items := []wshrpc.AttentionItem{
		{Kind: "gate", Action: "Review", ChannelName: "waveterm", RunId: "r-1", Source: "ship it", Text: "plan ready", WaitingSince: 1},
		{Kind: "ask", Action: "Answer", Source: "solo agent", Text: "which db?"},
	}
	lines := runsAttentionLines(items, 61_000)
	if !strings.Contains(lines[0], "Review") || !strings.Contains(lines[0], "r-1") || !strings.Contains(lines[0], "ship it: plan ready") {
		t.Fatalf("gate line = %q", lines[0])
	}
	if !strings.Contains(lines[1], " - ") {
		t.Fatalf("a channel-less item must show placeholders: %q", lines[1])
	}
}

func TestRunsClip(t *testing.T) {
	if got := runsClip("a  b\nc", 10); got != "a b c" {
		t.Fatalf("whitespace = %q", got)
	}
	if got := runsClip("abcdef", 4); got != "abc…" {
		t.Fatalf("clip = %q", got)
	}
}

func TestRunsIsTask(t *testing.T) {
	cases := []struct {
		name string
		run  waveobj.Run
		want bool
	}{
		{"quick run", waveobj.Run{Mode: jarvis.RunMode_Quick}, false},
		{"orchestrator owning its dag", waveobj.Run{Mode: jarvis.RunMode_Orchestrator, DagORef: "dag-1"}, false},
		{"engine task worker", waveobj.Run{Mode: jarvis.RunMode_Quick, DagORef: "dag-1"}, true},
		{"lead-spawned child", waveobj.Run{Mode: jarvis.RunMode_Quick, ParentLeadORef: "tab:lead"}, true},
	}
	for _, tt := range cases {
		if got := runsIsTask(&tt.run); got != tt.want {
			t.Errorf("%s: runsIsTask = %v, want %v", tt.name, got, tt.want)
		}
	}
}
