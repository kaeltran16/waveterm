// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/effortstore"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/usagestats"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const usageTestRepo = "/home/u/repo"

// seedUsageRun stores a run in a fresh channel, or in channelId when one is given, and returns the stored run.
func seedUsageRun(t *testing.T, channelId string, run waveobj.Run) waveobj.Run {
	t.Helper()
	ctx := context.Background()
	if channelId == "" {
		ch, err := wstore.CreateChannel(ctx, "usage-"+uuid.NewString(), usageTestRepo)
		if err != nil {
			t.Fatal(err)
		}
		channelId = ch.OID
	}
	run.ID = uuid.NewString()
	run.OID, run.ChannelOID = run.ID, channelId
	if err := wstore.AppendRun(ctx, channelId, run); err != nil {
		t.Fatal(err)
	}
	return run
}

// seedUsageDag stores an orchestrator lead, its dag, and one child per given run, each under a new session id.
func seedUsageDag(t *testing.T, children ...waveobj.Run) (waveobj.Run, []string) {
	t.Helper()
	dagId := uuid.NewString()
	lead := seedUsageRun(t, "", waveobj.Run{
		Mode: "orchestrator", Goal: "ship the thing\nwith care", ProjectPath: usageTestRepo,
		SessionId: uuid.NewString(), DagORef: dagId,
	})
	dag := waveobj.TaskGroup{OID: dagId, ID: dagId, RunID: lead.ID, ChannelId: lead.ChannelOID,
		Tasks: []waveobj.TaskNode{{ID: "t-1", Label: "Wire types"}}}
	if err := wstore.AppendDag(context.Background(), &dag); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, len(children))
	for i, child := range children {
		child.DagORef, child.SessionId = dagId, uuid.NewString()
		// a child's own path is its lane, which must never name the project
		child.ProjectPath = usageTestRepo + "/.waveterm/worktrees/" + child.SessionId
		ids[i] = seedUsageRun(t, lead.ChannelOID, child).SessionId
	}
	return lead, ids
}

func usageSessionsOf(t *testing.T, metas ...usagestats.SessionMeta) []wshrpc.UsageSession {
	t.Helper()
	got, err := usageSessions(context.Background(), metas)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(metas) {
		t.Fatalf("got %d sessions for %d metas", len(got), len(metas))
	}
	return got
}

// usageTestProjectName is the name of the project registered at usageTestRepo, which every seeded run names
func usageTestProjectName(t *testing.T) string {
	t.Helper()
	ch, err := wstore.ChannelAtPath(context.Background(), usageTestRepo)
	if err != nil || ch == nil {
		t.Fatalf("the channel at %s: %v %v", usageTestRepo, ch, err)
	}
	return ch.Name
}

func claudeMeta(session string) usagestats.SessionMeta {
	return usagestats.SessionMeta{Harness: "claude", Session: session, Cwd: "/somewhere/else", Title: "a title"}
}

func TestUsageSessionsLead(t *testing.T) {
	lead, _ := seedUsageDag(t)
	got := usageSessionsOf(t, claudeMeta(lead.SessionId))[0]
	want := wshrpc.UsageSession{
		Harness: "claude", Session: lead.SessionId, Title: "a title", Project: usageTestRepo,
		RunId: lead.ID, ChannelId: lead.ChannelOID, RunGoal: "ship the thing", RunMode: "orchestrator", Role: "lead",
		ProjectName: usageTestProjectName(t),
	}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestUsageSessionsLeadEarlierSession(t *testing.T) {
	earlier, current := uuid.NewString(), uuid.NewString()
	lead := seedUsageRun(t, "", waveobj.Run{
		Mode: "orchestrator", Goal: "relaunched", ProjectPath: usageTestRepo,
		SessionId: current, LeadSessionIds: []string{earlier, current},
	})
	for _, s := range usageSessionsOf(t, claudeMeta(earlier), claudeMeta(current)) {
		if s.RunId != lead.ID || s.ChannelId != lead.ChannelOID || s.Role != "lead" || s.RunMode != "orchestrator" ||
			s.RunGoal != "relaunched" || s.Project != usageTestRepo {
			t.Fatalf("a lead session links to its run as lead, got %+v", s)
		}
	}
}

func TestUsageSessionsWorkerAndReviewer(t *testing.T) {
	lead, ids := seedUsageDag(t,
		waveobj.Run{TaskId: "t-1"},
		waveobj.Run{TaskId: "t-1", Review: true},
		waveobj.Run{StageRole: "plan-reviewer"},
		waveobj.Run{StageRole: "verifier"},
	)
	wantRole := []string{"worker", "reviewer", "plan-reviewer", "verifier"}
	wantTask := []string{"t-1", "t-1", "", ""}
	wantTitle := []string{"Wire types", "Wire types", "", ""}
	got := usageSessionsOf(t, claudeMeta(ids[0]), usagestats.SessionMeta{Harness: "pi", Session: ids[1]}, claudeMeta(ids[2]), claudeMeta(ids[3]))
	for i, s := range got {
		if s.RunId != lead.ID || s.ChannelId != lead.ChannelOID || s.RunGoal != "ship the thing" || s.RunMode != "orchestrator" {
			t.Errorf("%s: want the owning run's id, goal and mode, got %+v", wantRole[i], s)
		}
		if s.Role != wantRole[i] || s.TaskId != wantTask[i] || s.TaskTitle != wantTitle[i] {
			t.Errorf("got role %q task %q %q, want %q %q %q", s.Role, s.TaskId, s.TaskTitle, wantRole[i], wantTask[i], wantTitle[i])
		}
		if s.Project != usageTestRepo {
			t.Errorf("%s: project %q, want the owning run's %q", wantRole[i], s.Project, usageTestRepo)
		}
	}
}

// a child launched before runs recorded their task has nothing UsageRole can read, and it is not the lead
func TestUsageSessionsLegacyChildIsNotLead(t *testing.T) {
	lead, ids := seedUsageDag(t, waveobj.Run{})
	got := usageSessionsOf(t, claudeMeta(ids[0]))[0]
	if got.RunId != lead.ID || got.Role != "worker" {
		t.Fatalf("want a worker of run %s, got %+v", lead.ID, got)
	}
}

func TestUsageSessionsQuickRun(t *testing.T) {
	run := seedUsageRun(t, "", waveobj.Run{Mode: "quick", Goal: "fix it", ProjectPath: usageTestRepo, SessionId: uuid.NewString()})
	got := usageSessionsOf(t, claudeMeta(run.SessionId))[0]
	want := wshrpc.UsageSession{
		Harness: "claude", Session: run.SessionId, Title: "a title", Project: usageTestRepo,
		RunId: run.ID, ChannelId: run.ChannelOID, RunGoal: "fix it", RunMode: "quick", ProjectName: usageTestProjectName(t),
	}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

// a builder check or judge is no run item, since no run list shows its run: it is its role in the brainstorming
// agent's session when its run names that agent, and its role alone when it predates the record
func TestUsageSessionsBrainstormSession(t *testing.T) {
	for _, role := range []string{jarvis.UsageRole_BrainstormJudge, jarvis.UsageRole_BuilderCheck} {
		for _, lead := range []string{"pi:lead-session", ""} {
			run := seedUsageRun(t, "", waveobj.Run{
				Mode: "quick", Goal: "weigh it", ProjectPath: usageTestRepo, SessionId: uuid.NewString(), StageRole: role,
				BrainstormLead: lead,
			})
			got := usageSessionsOf(t, claudeMeta(run.SessionId))[0]
			want := wshrpc.UsageSession{
				Harness: "claude", Session: run.SessionId, Title: "a title", Project: usageTestRepo, Role: role,
				ProjectName: usageTestProjectName(t),
			}
			if lead != "" {
				want.LeadHarness, want.LeadSession = "pi", "lead-session"
			}
			if got != want {
				t.Fatalf("%s with lead %q: got %+v, want %+v", role, lead, got, want)
			}
		}
	}
}

func TestUsageSessionsConsultSession(t *testing.T) {
	consult := uuid.NewString()
	run := seedUsageRun(t, "", waveobj.Run{
		Mode: "quick", Goal: "scan\nthe records", ProjectPath: usageTestRepo, SessionId: uuid.NewString(),
		ConsultSessions: []waveobj.ConsultSession{{SessionId: consult, Role: "workflow-scan"}},
	})
	got := usageSessionsOf(t, claudeMeta(consult), claudeMeta(run.SessionId))
	want := wshrpc.UsageSession{
		Harness: "claude", Session: consult, Title: "a title", Project: usageTestRepo,
		RunId: run.ID, ChannelId: run.ChannelOID, RunGoal: "scan", RunMode: "quick", Role: "workflow-scan",
		ProjectName: usageTestProjectName(t),
	}
	if got[0] != want {
		t.Fatalf("consult session: got %+v, want %+v", got[0], want)
	}
	if got[1].RunId != run.ID || got[1].RunMode != "quick" || got[1].Role != "" {
		t.Fatalf("the run's own session keeps its link and no role, got %+v", got[1])
	}
}

func TestUsageSessionsUnlinked(t *testing.T) {
	got := usageSessionsOf(t, claudeMeta(uuid.NewString()), usagestats.SessionMeta{Harness: "claude", Session: uuid.NewString()})
	want := wshrpc.UsageSession{Harness: "claude", Session: got[0].Session, Title: "a title", Project: "/somewhere/else"}
	if got[0] != want {
		t.Fatalf("got %+v, want %+v", got[0], want)
	}
	if got[1].Project != "" {
		t.Fatalf("no cwd and no run leaves the project empty, got %q", got[1].Project)
	}
}

func TestUsageSessionsWorktreeCwdFoldsToRepo(t *testing.T) {
	cases := []struct{ cwd, want string }{
		{"/home/u/repo/.worktrees/x", "/home/u/repo"},
		{"/home/u/repo/.claude/worktrees/x", "/home/u/repo"},
		{"/home/u/repo/.waveterm/worktrees/x", "/home/u/repo"},
		{`C:\Users\u\repo\.worktrees\x`, `C:\Users\u\repo`},
		{`C:\Users\u\repo\.claude\worktrees\x`, `C:\Users\u\repo`},
		{`C:\Users\u\repo\.claude/worktrees/x`, `C:\Users\u\repo`},
		{"/home/u/repo/.worktrees/x/", "/home/u/repo"},
		{"/home/u/lanes/repo-x", "/home/u/lanes/repo-x"},
		{"/home/u/repo-worktrees/x", "/home/u/repo-worktrees/x"},
		{"/home/u/repo/.worktrees", "/home/u/repo/.worktrees"},
		{"/home/u/repo", "/home/u/repo"},
	}
	for _, c := range cases {
		got := usageSessionsOf(t, usagestats.SessionMeta{Harness: "codex", Session: uuid.NewString(), Cwd: c.cwd})[0]
		if got.Project != c.want {
			t.Errorf("cwd %q: project %q, want %q", c.cwd, got.Project, c.want)
		}
	}
}

func TestUsageSessionsCodexNotLinked(t *testing.T) {
	lead, _ := seedUsageDag(t)
	for _, harness := range []string{"codex", "opencode"} {
		got := usageSessionsOf(t, usagestats.SessionMeta{Harness: harness, Session: lead.SessionId, Cwd: "/somewhere/else"})[0]
		want := wshrpc.UsageSession{Harness: harness, Session: lead.SessionId, Project: "/somewhere/else"}
		if got != want {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	}
}

func TestUsageSessionsRunEffort(t *testing.T) {
	lead := seedUsageRun(t, "", waveobj.Run{
		Mode: "quick", Goal: "build the chunk", ProjectPath: usageTestRepo, SessionId: uuid.NewString(),
		EffortRef: &waveobj.RunEffortRef{EffortOID: "effort-1", ChunkLabel: "Usage directory in Go"},
	})
	got := usageSessionsOf(t, claudeMeta(lead.SessionId))[0]
	if got.RunId != lead.ID || got.RunChunk != "Usage directory in Go" || got.Effort != "effort-1" {
		t.Fatalf("want the run's chunk and effort, got %+v", got)
	}
}

// a session no run claims belongs to the initiative its tab is tagged with, matched by the agent's transcript
func TestUsageSessionsTabEffort(t *testing.T) {
	ctx := context.Background()
	tagged, untagged := uuid.NewString(), uuid.NewString()
	for _, c := range []struct{ session, effort string }{{tagged, "effort:effort-2"}, {untagged, ""}} {
		meta := waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "claude"}
		if c.effort != "" {
			meta[waveobj.MetaKey_SessionEffort] = c.effort
		}
		_, blockId := seedAgentTab(t, ctx, meta)
		transcript := filepath.Join("projects", "C--repo", c.session+".jsonl")
		if _, err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Block, blockId),
			waveobj.MetaMapType{waveobj.MetaKey_AgentTranscriptPath: transcript}, false); err != nil {
			t.Fatal(err)
		}
	}
	got := usageSessionsOf(t, claudeMeta(tagged), claudeMeta(untagged), usagestats.SessionMeta{Harness: "pi", Session: tagged})
	if got[0].Effort != "effort-2" {
		t.Fatalf("the tagged tab's session: effort %q, want effort-2", got[0].Effort)
	}
	if got[1].Effort != "" || got[2].Effort != "" {
		t.Fatalf("an untagged tab, or another harness's session, has no effort: got %q and %q", got[1].Effort, got[2].Effort)
	}
}

// setTabTranscript names transcript on a seeded agent tab's block
func setTabTranscript(t *testing.T, ctx context.Context, blockId, transcript string) {
	t.Helper()
	if _, err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Block, blockId),
		waveobj.MetaMapType{waveobj.MetaKey_AgentTranscriptPath: transcript}, false); err != nil {
		t.Fatal(err)
	}
}

// a session whose tab closed keeps the initiative recorded at close, unless an open tab tags it otherwise
func TestUsageCountsClosedTabSessionInEffort(t *testing.T) {
	ctx := context.Background()
	closed, reopened := uuid.NewString(), uuid.NewString()
	for _, session := range []string{closed, reopened} {
		tab := &waveobj.Tab{OID: uuid.NewString(), Meta: waveobj.MetaMapType{
			waveobj.MetaKey_SessionAgent: "claude", waveobj.MetaKey_SessionEffort: "effort:closed-effort",
		}}
		block := &waveobj.Block{OID: uuid.NewString(), ParentORef: "tab:" + tab.OID}
		if err := wstore.DBInsert(ctx, block); err != nil {
			t.Fatal(err)
		}
		tab.BlockIds = []string{block.OID}
		setTabTranscript(t, ctx, block.OID, filepath.Join("projects", "C--repo", session+".jsonl"))
		if err := wstore.RecordTabSessionEffort(ctx, tab); err != nil {
			t.Fatal(err)
		}
	}
	_, blockId := seedAgentTab(t, ctx, waveobj.MetaMapType{
		waveobj.MetaKey_SessionAgent: "claude", waveobj.MetaKey_SessionEffort: "effort:open-effort",
	})
	setTabTranscript(t, ctx, blockId, filepath.Join("projects", "C--repo", reopened+".jsonl"))

	got := usageSessionsOf(t, claudeMeta(closed), claudeMeta(reopened))
	if got[0].Effort != "closed-effort" {
		t.Fatalf("the closed tab's session: effort %q, want closed-effort", got[0].Effort)
	}
	if got[1].Effort != "open-effort" {
		t.Fatalf("an open tab's tag wins: effort %q, want open-effort", got[1].Effort)
	}
}

// closing a tagged agent tab through wcore.DeleteTab records its session's initiative before the block goes
func TestDeleteTabPersistsSessionEffort(t *testing.T) {
	ctx := context.Background()
	session := uuid.NewString()
	transcript := filepath.Join("projects", "C--repo", session+".jsonl")
	tabId, blockId := seedAgentTab(t, ctx, waveobj.MetaMapType{
		waveobj.MetaKey_SessionAgent: "claude", waveobj.MetaKey_SessionEffort: "effort:kept",
	})
	setTabTranscript(t, ctx, blockId, transcript)
	ws := &waveobj.Workspace{OID: uuid.NewString(), TabIds: []string{tabId}}
	if err := wstore.DBInsert(ctx, ws); err != nil {
		t.Fatal(err)
	}
	if _, err := wcore.DeleteTab(ctx, ws.OID, tabId, false); err != nil {
		t.Fatalf("closing tab %s: %v", tabId, err)
	}
	rows, err := wstore.GetSessionEfforts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if r.Transcript == transcript {
			if r.Harness != "claude" || r.EffortOID != "kept" {
				t.Fatalf("got %+v, want claude and effort kept", r)
			}
			return
		}
	}
	t.Fatalf("no row for the closed tab's transcript %s", transcript)
}

func TestUsageSessionsEffortTitles(t *testing.T) {
	ctx := context.Background()
	t.Cleanup(effortstore.UseRootForTest(t.TempDir()))
	e := &waveobj.Effort{Title: "Usage review fixes"}
	if err := effortstore.Create(ctx, e); err != nil {
		t.Fatal(err)
	}
	sessions := []wshrpc.UsageSession{{Effort: e.OID}, {Effort: e.OID}, {Effort: "gone"}, {}}
	got := usageEfforts(ctx, sessions)
	if len(got) != 1 || got[0] != (wshrpc.UsageEffort{OID: e.OID, Title: "Usage review fixes"}) {
		t.Fatalf("want the one readable effort once, got %+v", got)
	}
}

func TestUsageSessionsProjectName(t *testing.T) {
	ctx := context.Background()
	registered := `C:\Users\u\proj-` + uuid.NewString()
	ch, err := wstore.CreateChannel(ctx, "Registered", registered)
	if err != nil {
		t.Fatal(err)
	}
	cwd := strings.ReplaceAll(registered, `\`, "/") + "/"
	if runtime.GOOS == "windows" {
		cwd = "c" + cwd[1:]
	}
	got := usageSessionsOf(t, usagestats.SessionMeta{Harness: "codex", Session: uuid.NewString(), Cwd: cwd},
		usagestats.SessionMeta{Harness: "codex", Session: uuid.NewString(), Cwd: registered + "-other"})
	if got[0].ProjectName != ch.Name {
		t.Fatalf("cwd %q: project name %q, want %q", cwd, got[0].ProjectName, ch.Name)
	}
	if got[1].ProjectName != "" {
		t.Fatalf("an unregistered folder has no project name, got %q", got[1].ProjectName)
	}
}

// a linked worktree's .git file names its main checkout, so any worktree layout folds to the same subpath there
func TestRepoRootFoldsALinkedWorktree(t *testing.T) {
	main := t.TempDir()
	wt := filepath.Join(t.TempDir(), "repo-worktrees", "feature")
	sub := filepath.Join(wt, "pkg", "x")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	gitdir := filepath.ToSlash(filepath.Join(main, ".git", "worktrees", "feature"))
	if err := os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: "+gitdir+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := usageSessionsOf(t,
		usagestats.SessionMeta{Harness: "codex", Session: uuid.NewString(), Cwd: sub},
		usagestats.SessionMeta{Harness: "codex", Session: uuid.NewString(), Cwd: wt},
		usagestats.SessionMeta{Harness: "codex", Session: uuid.NewString(), Cwd: main},
	)
	for i, want := range []string{filepath.Join(main, "pkg", "x"), main, main} {
		if got[i].Project != want {
			t.Errorf("project %q, want %q", got[i].Project, want)
		}
	}
}

// keepUsageAt keeps one claude bucket for session on the local day daysAgo days before today, with a kept title
func keepUsageAt(t *testing.T, session string, daysAgo int) usagestats.Bucket {
	t.Helper()
	b := usagestats.Bucket{
		Harness: "claude", Provider: "anthropic", Model: "claude-opus-5-5", Session: session,
		Day: time.Now().AddDate(0, 0, -daysAgo).Format("2006-01-02"), Input: 10, Output: 20, CacheRead: 300, Msgs: 2,
	}
	meta := usagestats.SessionMeta{Harness: "claude", Session: session, Cwd: usageTestRepo, Title: "kept title"}
	if err := usagestats.Keep(context.Background(), []usagestats.Bucket{b}, []usagestats.SessionMeta{meta}); err != nil {
		t.Fatal(err)
	}
	return b
}

func getUsageStats(t *testing.T, windowDays int) *wshrpc.CommandGetUsageStatsRtnData {
	t.Helper()
	got, err := (&WshServer{}).GetUsageStatsCommand(context.Background(), wshrpc.CommandGetUsageStatsData{WindowDays: windowDays})
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func usageBucketsOf(got *wshrpc.CommandGetUsageStatsRtnData, session string) []wshrpc.UsageBucket {
	var out []wshrpc.UsageBucket
	for _, b := range got.Buckets {
		if b.Session == session {
			out = append(out, b)
		}
	}
	return out
}

// a session whose transcript is gone (none is on the test home's disk) still counts from what was kept
func TestGetUsageStatsAnswersFromTheKeptRecord(t *testing.T) {
	lead, _ := seedUsageDag(t)
	b := keepUsageAt(t, lead.SessionId, 0)
	got := getUsageStats(t, 7)
	want := []wshrpc.UsageBucket{{
		Harness: "claude", Provider: "anthropic", Model: "claude-opus-5-5", Session: lead.SessionId, Day: b.Day,
		Input: 10, Output: 20, CacheRead: 300, Msgs: 2,
	}}
	if bs := usageBucketsOf(got, lead.SessionId); !reflect.DeepEqual(bs, want) {
		t.Fatalf("buckets %+v, want %+v", bs, want)
	}
	var s *wshrpc.UsageSession
	for i := range got.Sessions {
		if got.Sessions[i].Session == lead.SessionId {
			s = &got.Sessions[i]
		}
	}
	if s == nil || s.Title != "kept title" || s.RunId != lead.ID || s.Role != "lead" || s.Project != usageTestRepo {
		t.Fatalf("want the kept session with its kept title and its run link, got %+v", s)
	}
}

func TestGetUsageStatsWindowLeavesOutEarlierKeptRows(t *testing.T) {
	firstDay, dayBefore, monthAgo := uuid.NewString(), uuid.NewString(), uuid.NewString()
	keepUsageAt(t, firstDay, 6)
	keepUsageAt(t, dayBefore, 7)
	keepUsageAt(t, monthAgo, 30)
	week := getUsageStats(t, 7)
	if len(usageBucketsOf(week, firstDay)) != 1 {
		t.Fatalf("the window's first day is in it")
	}
	for _, s := range []string{dayBefore, monthAgo} {
		if bs := usageBucketsOf(week, s); len(bs) != 0 {
			t.Fatalf("a kept row before the window is out of it, got %+v", bs)
		}
		for _, us := range week.Sessions {
			if us.Session == s {
				t.Fatalf("a session with no row in the window is out of it, got %+v", us)
			}
		}
	}
	all := getUsageStats(t, 0)
	for _, s := range []string{firstDay, dayBefore, monthAgo} {
		if len(usageBucketsOf(all, s)) != 1 {
			t.Fatalf("All time holds every kept row, missing %s", s)
		}
	}
}
