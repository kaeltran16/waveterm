// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentworker

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/gitinfo"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/memgate"
	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// startParent is an agent tab a worker can be started from: its workspace, tab and agent block.
type startParent struct {
	workspaceId, tabId, blockId string
}

// seedParent opens an agent tab in a fresh workspace, with the given project tag and directory, and publishes the
// status its agent would report.
func seedParent(t *testing.T, status baseds.AgentStatusData, project, cwd string) startParent {
	t.Helper()
	ctx := context.Background()
	ws, err := wcore.CreateWorkspace(ctx, "", "", "", false, false)
	if err != nil {
		t.Fatal(err)
	}
	tabId, blockId, err := jarvis.OpenAgentTab(ctx, jarvis.AgentTabSpec{
		WorkspaceId: ws.OID, TabName: project,
		TabMeta:   waveobj.MetaMapType{"session:agent": status.Agent, "session:project": project},
		BlockMeta: waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "cmd", waveobj.MetaKey_CmdCwd: cwd},
	})
	if err != nil {
		t.Fatal(err)
	}
	status.ORef = waveobj.MakeORef(waveobj.OType_Block, blockId).String()
	status.Ts = time.Now().UnixMilli()
	wps.Broker.Publish(wps.WaveEvent{Event: wps.Event_AgentStatus, Scopes: []string{status.ORef}, Persist: 1, Data: status})
	return startParent{workspaceId: ws.OID, tabId: tabId, blockId: blockId}
}

func (p startParent) blockORef() string {
	return waveobj.MakeORef(waveobj.OType_Block, p.blockId).String()
}

func (p startParent) tabIds(t *testing.T) []string {
	t.Helper()
	ws, err := wstore.DBMustGet[*waveobj.Workspace](context.Background(), p.workspaceId)
	if err != nil {
		t.Fatal(err)
	}
	return ws.TabIds
}

// stubStart records each worker start instead of launching a process, failing with err when it is set.
func stubStart(t *testing.T, err error) *[]string {
	t.Helper()
	old := startAgentTab
	t.Cleanup(func() { startAgentTab = old })
	var started []string
	startAgentTab = func(_ context.Context, tabId, blockId string) error {
		started = append(started, tabId+"/"+blockId)
		return err
	}
	return &started
}

// isolateHome keeps a claude start's folder-trust write out of the real ~/.claude.json.
func isolateHome(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
}

func TestStartOpensARunningWorkerUnderItsParent(t *testing.T) {
	isolateHome(t)
	isolateGate(t)
	started := stubStart(t, nil)
	dir := t.TempDir()
	parent := seedParent(t, baseds.AgentStatusData{Agent: "claude", State: baseds.AgentState_Working, Cwd: dir, PermissionMode: "acceptEdits"}, "proj", "")
	ctx := context.Background()

	rtn, err := Start(ctx, wshrpc.CommandAgentsStartData{FromORef: parent.blockORef(), Prompt: "fix the parser"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if rtn.Harness != "claude" || rtn.Cwd != dir || rtn.TabId == "" {
		t.Fatalf("returned %+v, want a claude worker tab in %s", rtn, dir)
	}
	if !slices.Contains(parent.tabIds(t), rtn.TabId) {
		t.Fatal("the worker's tab is not in its parent's workspace")
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, rtn.TabId)
	if err != nil {
		t.Fatal(err)
	}
	wantTabMeta := waveobj.MetaMapType{"session:agent": "claude", "session:project": "proj", MetaParentTab: parent.tabId}
	if !reflect.DeepEqual(tab.Meta, wantTabMeta) {
		t.Errorf("tab meta %v, want %v", tab.Meta, wantTabMeta)
	}
	blockId := tab.BlockIds[0]
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		t.Fatal(err)
	}
	m := block.Meta
	sessionId := m.GetString(MetaSessionId, "")
	args := m.GetStringList(waveobj.MetaKey_CmdArgs)
	if sessionId == "" || len(args) < 3 || !reflect.DeepEqual(args[len(args)-3:], []string{"--session-id", sessionId, "fix the parser"}) {
		t.Errorf("cmd:args %q, want the launch flags, then --session-id %s and the task", args, sessionId)
	}
	if !slices.Contains(args, "--permission-mode") || !slices.Contains(args, "acceptEdits") {
		t.Errorf("cmd:args %q: want the parent's permission mode", args)
	}
	if base := m.GetStringList("agent:baseargs"); !reflect.DeepEqual(base, args[:len(args)-3]) {
		t.Errorf("agent:baseargs %q, want the launch flags %q", base, args[:len(args)-3])
	}
	if m.GetString(waveobj.MetaKey_Cmd, "") != "claude" || m.GetString(waveobj.MetaKey_View, "") != "term" ||
		m.GetString(waveobj.MetaKey_Controller, "") != "cmd" || m.GetString(waveobj.MetaKey_CmdCwd, "") != dir {
		t.Errorf("block runs %q in %q (view %q, controller %q), want claude in %s as a cmd term",
			m.GetString(waveobj.MetaKey_Cmd, ""), m.GetString(waveobj.MetaKey_CmdCwd, ""), m.GetString(waveobj.MetaKey_View, ""), m.GetString(waveobj.MetaKey_Controller, ""), dir)
	}
	if !m.GetBool(waveobj.MetaKey_CmdJwt, false) || m.GetBool(waveobj.MetaKey_CmdShell, true) || !m.GetBool(waveobj.MetaKey_CmdKeepOnExit, false) || !m.GetBool(MetaNoticeOwed, false) {
		t.Errorf("block meta %v: want cmd:jwt, cmd:keeponexit and the notice owed, and cmd:shell false", m)
	}
	if env := m.GetMap(waveobj.MetaKey_CmdEnv); !reflect.DeepEqual(env, waveobj.MetaMapType{consult.PromptCacheTTLEnv: "5m"}) {
		t.Errorf("cmd:env %v, want only the 5-minute cache TTL (no %s)", env, jarvis.RunAgentEnv)
	}
	if !reflect.DeepEqual(*started, []string{rtn.TabId + "/" + blockId}) {
		t.Errorf("started %v, want the worker's tab once", *started)
	}
	events := wps.Broker.ReadEventHistory(wps.Event_AgentStatus, waveobj.MakeORef(waveobj.OType_Block, blockId).String(), 1)
	if len(events) != 1 || events[0].Data.(baseds.AgentStatusData).State != baseds.AgentState_Working {
		t.Errorf("want a retained working status for the worker, got %v", events)
	}

	// the claim is the worker's, pausable as a worker, and bound to its block
	memgate.SetFreeForTest(func() (uint64, error) { return 0, nil })
	_, why := memgate.TryAdmitOrWhy(memgate.Request{Tag: memgate.Tag{Role: memgate.RoleWorker, TabId: "probe"}})
	if why == nil || len(why.Holders) != 1 || why.Holders[0].Tag != (memgate.Tag{Role: memgate.RoleWorker, TabId: rtn.TabId}) {
		t.Fatalf("holders %+v, want the worker's claim tagged with its tab", why)
	}
	memgate.ReleaseOwner(jobobject.Owner{Kind: jobobject.OwnerKind_Block, Id: blockId})
	if n := memgate.LiveClaimsForTest(); n != 0 {
		t.Errorf("%d claims left after the worker's block released its own: the claim is not bound to it", n)
	}
}

func TestStartInANewWorktree(t *testing.T) {
	isolateGate(t)
	stubStart(t, nil)
	repo := gitRepo(t)
	parent := seedParent(t, baseds.AgentStatusData{Agent: "pi", State: baseds.AgentState_Working, Cwd: repo}, "proj", "")
	ctx := context.Background()
	head, err := gitinfo.HeadCommit(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}

	rtn, err := Start(ctx, wshrpc.CommandAgentsStartData{FromORef: parent.blockORef(), Prompt: "task", Worktree: "feat-x"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if want := gitinfo.WorktreePath(repo, "feat-x"); rtn.Cwd != want {
		t.Fatalf("cwd %q, want the new worktree %q", rtn.Cwd, want)
	}
	branch, err := gitinfo.CurrentBranch(ctx, rtn.Cwd)
	if err != nil || branch != "feat-x" {
		t.Errorf("worktree branch %q (%v), want feat-x", branch, err)
	}
	if got, err := gitinfo.HeadCommit(ctx, rtn.Cwd); err != nil || got != head {
		t.Errorf("worktree HEAD %s (%v), want the parent's HEAD %s", got, err, head)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, rtn.TabId)
	if err != nil {
		t.Fatal(err)
	}
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, tab.BlockIds[0])
	if err != nil {
		t.Fatal(err)
	}
	memgate.ReleaseOwner(jobobject.Owner{Kind: jobobject.OwnerKind_Block, Id: block.OID})
	if got := block.Meta.GetString(waveobj.MetaKey_CmdCwd, ""); got != rtn.Cwd {
		t.Errorf("the worker runs in %q, want its worktree %q", got, rtn.Cwd)
	}
}

func TestStartRefusesWithoutATabOrAClaim(t *testing.T) {
	existingBranch := func(t *testing.T) (string, wshrpc.CommandAgentsStartData) {
		repo := gitRepo(t)
		git(t, repo, "branch", "taken")
		return repo, wshrpc.CommandAgentsStartData{Prompt: "task", Worktree: "taken"}
	}
	outsideScratch := func(t *testing.T) (string, wshrpc.CommandAgentsStartData) {
		base := filepath.Join(t.TempDir(), "arc-snap")
		old := wavebase.DataHome_VarCache
		wavebase.DataHome_VarCache = filepath.Join(base, "data")
		t.Cleanup(func() { wavebase.DataHome_VarCache = old })
		t.Setenv(wavebase.ArcSnapshotVarName, "1")
		return t.TempDir(), wshrpc.CommandAgentsStartData{Prompt: "task"}
	}
	memoryShort := func(t *testing.T) (string, wshrpc.CommandAgentsStartData) {
		// an empty book always admits, so another claim must hold memory
		held, ok := memgate.TryAdmit(memgate.Request{Tag: memgate.Tag{RunId: "run-1", TaskId: "t-1", Role: memgate.RoleWorker}})
		if !ok {
			t.Fatal("an empty book must admit")
		}
		t.Cleanup(held.Release)
		memgate.SetFreeForTest(func() (uint64, error) { return 0, nil })
		return t.TempDir(), wshrpc.CommandAgentsStartData{Prompt: "task"}
	}
	cases := []struct {
		name  string
		setup func(t *testing.T) (string, wshrpc.CommandAgentsStartData)
		want  string
	}{
		{"an existing branch", existingBranch, `"taken" already exists`},
		{"a snapshot app outside its scratch dir", outsideScratch, "snapshot store"},
		{"memory short", memoryShort, "memory is short"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			isolateGate(t)
			started := stubStart(t, nil)
			dir, data := c.setup(t)
			parent := seedParent(t, baseds.AgentStatusData{Agent: "pi", State: baseds.AgentState_Working, Cwd: dir}, "proj", "")
			before, claims := parent.tabIds(t), memgate.LiveClaimsForTest()
			data.FromORef = parent.blockORef()

			_, err := Start(context.Background(), data)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want one saying %q", err, c.want)
			}
			if after := parent.tabIds(t); !reflect.DeepEqual(after, before) {
				t.Errorf("tabs %v -> %v: a refused start leaves no tab", before, after)
			}
			if n := memgate.LiveClaimsForTest(); n != claims || len(*started) != 0 {
				t.Errorf("claims %d -> %d, started %v: a refused start holds nothing and starts nothing", claims, n, *started)
			}
		})
	}
}

func TestStartThatFailsReleasesItsClaim(t *testing.T) {
	isolateGate(t)
	stubStart(t, errors.New("no pty"))
	parent := seedParent(t, baseds.AgentStatusData{Agent: "pi", State: baseds.AgentState_Working, Cwd: t.TempDir()}, "proj", "")
	before := parent.tabIds(t)

	_, err := Start(context.Background(), wshrpc.CommandAgentsStartData{FromORef: parent.blockORef(), Prompt: "task"})
	if err == nil || !strings.Contains(err.Error(), "no pty") {
		t.Fatalf("err = %v, want the start's failure", err)
	}
	if n := memgate.LiveClaimsForTest(); n != 0 {
		t.Errorf("%d claims left: a failed start releases its claim", n)
	}
	if after := parent.tabIds(t); !reflect.DeepEqual(after, before) {
		t.Errorf("tabs %v -> %v: a failed start removes its tab", before, after)
	}
}

// gitRepo is a repository with one commit.
func gitRepo(t *testing.T) string {
	t.Helper()
	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, repo, "init", "-q")
	git(t, repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
	return repo
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}
