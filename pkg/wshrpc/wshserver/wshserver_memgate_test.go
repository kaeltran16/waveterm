// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/memgate"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestResolveMemOwner(t *testing.T) {
	ctx := context.Background()
	repo, execGit := newLandingRepo(t)
	// a run's project path can be one of the project's worktrees: its learned peaks belong to the main checkout
	worktree := filepath.Join(t.TempDir(), "wt")
	execGit("worktree", "add", "-b", "memgate-wt", worktree)
	project := orchestrate.MemProjectKey(repo)
	if project == "" || orchestrate.MemProjectKey(worktree) != project {
		t.Fatalf("worktree key %q does not fold to the project key %q", orchestrate.MemProjectKey(worktree), project)
	}
	blockOwner := func(id string) jobobject.Owner { return jobobject.Owner{Kind: jobobject.OwnerKind_Block, Id: id} }

	agentBlock, _ := seedResMonTab(t, "agent", "claude")
	termBlock, _ := seedResMonTab(t, "terminal", "")
	leadBlock, leadTab := seedResMonTab(t, "lead tab", "claude")
	workerBlock, workerTab := seedResMonTab(t, "worker tab", "claude")
	reviewBlock, reviewTab := seedResMonTab(t, "review tab", "claude")
	for _, id := range []string{agentBlock, termBlock} {
		block, err := wstore.DBMustGet[*waveobj.Block](ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		block.Meta = waveobj.MetaMapType{waveobj.MetaKey_CmdCwd: worktree}
		if err := wstore.DBUpdate(ctx, block); err != nil {
			t.Fatal(err)
		}
	}
	lead := seedWorkerRun(t, "", leadTab, waveobj.Run{Mode: "orchestrator", ProjectPath: worktree, DagORef: uuid.NewString()})
	seedWorkerRun(t, lead.ChannelOID, workerTab, waveobj.Run{TaskId: "2", ProjectPath: worktree, DagORef: lead.DagORef})
	seedWorkerRun(t, lead.ChannelOID, reviewTab, waveobj.Run{TaskId: "2", Review: true, ProjectPath: worktree, DagORef: lead.DagORef})

	cases := []struct {
		name  string
		owner jobobject.Owner
		want  memgate.Key
	}{
		{"run command", jobobject.Owner{Kind: jobobject.OwnerKind_RunCmd, Id: lead.ID, Cmd: "Verify", Task: "2"}, memgate.Key{Project: project, Role: "Verify"}},
		{"run worker", blockOwner(workerBlock), memgate.Key{Project: project, Role: memgate.RoleWorker}},
		{"task reviewer", blockOwner(reviewBlock), memgate.Key{Project: project, Role: memgate.RoleReviewer}},
		{"run lead", blockOwner(leadBlock), memgate.Key{Project: project, Role: jarvis.UsageRole_Lead}},
		{"agent tab", blockOwner(agentBlock), memgate.Key{Project: project, Role: memgate.RoleAgent}},
		{"plain terminal", blockOwner(termBlock), memgate.Key{Project: project, Role: memgate.RoleTerminal}},
	}
	for _, c := range cases {
		got, ok := ResolveMemOwner(ctx, c.owner)
		if !ok || got != c.want {
			t.Errorf("%s: got %+v (ok %v), want %+v", c.name, got, ok, c.want)
		}
	}

	noCwd, _ := seedResMonTab(t, "no cwd", "")
	if got, ok := ResolveMemOwner(ctx, blockOwner(noCwd)); !ok || got != (memgate.Key{Role: memgate.RoleTerminal}) {
		t.Errorf("a block with no cwd: got %+v (ok %v), want a terminal with no project", got, ok)
	}
	for name, gone := range map[string]jobobject.Owner{
		"deleted block": blockOwner(uuid.NewString()),
		"deleted run":   {Kind: jobobject.OwnerKind_RunCmd, Id: uuid.NewString(), Cmd: "Verify"},
	} {
		if got, ok := ResolveMemOwner(ctx, gone); ok {
			t.Errorf("%s resolved to %+v, want false", name, got)
		}
	}
}

// the submit RPC runs the landing tree's Setup inline, so a gate that refuses every tree must not hold it: the
// caller would wait with no way to learn why
func TestSubmitSetupNeverWaits(t *testing.T) {
	ctx := context.Background()
	// a failing Setup is handed to the lead with its output, which shows it ran
	ch, _, plan, _ := newSetupPlanRun(t, "echo setup-ran && exit 3")
	prompt := stubLeadSpawn(t, nil)
	blocker, ok := memgate.TryAdmit(memgate.Request{Key: memgate.Key{Role: "test"}, Need: 1})
	if !ok {
		t.Fatal("an empty book must admit")
	}
	restoreFree := memgate.SetFreeForTest(func() (uint64, error) { return 0, nil })
	t.Cleanup(func() {
		restoreFree()
		blocker.Release()
	})

	done := make(chan error, 1)
	go func() {
		_, err := startPlanRun(ctx, ch, plan)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("a submit with a Setup must complete while the gate refuses everything: %v", err)
		}
		if !strings.Contains(*prompt, "setup-ran") {
			t.Fatalf("the Setup did not run: the lead's prompt is:\n%s", *prompt)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the submit's Setup waited at the memory gate")
	}
}
