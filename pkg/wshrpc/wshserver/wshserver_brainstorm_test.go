// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/brainstormcheck"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const testSpecRel = "docs/spec.md"

// seedBrainstorm writes a project with a brainstorm.json naming spec, and the spec file when writeSpec is set.
// It returns the project dir and the brainstorm file.
func seedBrainstorm(t *testing.T, spec string, writeSpec bool) (string, string) {
	t.Helper()
	project := t.TempDir()
	topic := filepath.Join(project, ".superpowers", "brainstorm", "lag-alerts")
	if err := os.MkdirAll(topic, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(topic, "brainstorm.json")
	body := `{"title":"Lag alerts"}`
	if spec != "" {
		body = `{"title":"Lag alerts","spec":"` + spec + `"}`
	}
	if err := os.WriteFile(file, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if writeSpec {
		path := filepath.Join(project, filepath.FromSlash(testSpecRel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("# spec"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return project, file
}

// seedAgentTab inserts a workspace holding a tab whose first block is the agent's. It returns the tab and block ids.
func seedAgentTab(t *testing.T, ctx context.Context, meta waveobj.MetaMapType) (string, string) {
	t.Helper()
	tabId, blockId := uuid.NewString(), uuid.NewString()
	if meta == nil {
		meta = waveobj.MetaMapType{}
	}
	for _, obj := range []waveobj.WaveObj{
		&waveobj.Workspace{OID: uuid.NewString(), TabIds: []string{tabId}},
		&waveobj.Tab{OID: tabId, BlockIds: []string{blockId}, Meta: meta},
		&waveobj.Block{OID: blockId, ParentORef: "tab:" + tabId},
	} {
		if err := wstore.DBInsert(ctx, obj); err != nil {
			t.Fatalf("DBInsert: %v", err)
		}
	}
	return tabId, blockId
}

func tabMeta(t *testing.T, ctx context.Context, tabId string) waveobj.MetaMapType {
	t.Helper()
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatalf("loading tab: %v", err)
	}
	return tab.Meta
}

func stubArmBuilderCheck(t *testing.T) *[]builderCheck {
	t.Helper()
	var armed []builderCheck
	old := armBuilderCheck
	armBuilderCheck = func(c builderCheck) { armed = append(armed, c) }
	t.Cleanup(func() { armBuilderCheck = old })
	return &armed
}

func stubLaunchBuilderCheck(t *testing.T, runId string, err error) *[]orchestrate.JudgingSession {
	t.Helper()
	var launched []orchestrate.JudgingSession
	old := launchBuilderCheck
	launchBuilderCheck = func(_ context.Context, s orchestrate.JudgingSession) (string, error) {
		launched = append(launched, s)
		return runId, err
	}
	t.Cleanup(func() { launchBuilderCheck = old })
	return &launched
}

func TestBrainstormCheckRefusals(t *testing.T) {
	ctx := context.Background()
	armed := stubArmBuilderCheck(t)
	_, noSpec := seedBrainstorm(t, "", false)
	_, missingSpec := seedBrainstorm(t, testSpecRel, false)
	_, good := seedBrainstorm(t, testSpecRel, true)
	_, block := seedAgentTab(t, ctx, nil)
	_, readingBlock := seedAgentTab(t, ctx, waveobj.MetaMapType{waveobj.MetaKey_BrainstormCheckState: builderCheckReading})

	for _, tc := range []struct {
		name, block, file, want string
	}{
		{"no file", block, "", "a block id and a brainstorm file are required"},
		{"no spec", block, noSpec, "names no spec"},
		{"a missing spec file", block, missingSpec, "does not exist"},
		{"already reading", readingBlock, good, "a builder check is already running"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := (&WshServer{}).BrainstormCheckCommand(ctx, wshrpc.CommandBrainstormCheckData{BlockId: tc.block, File: tc.file})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
		})
	}
	if len(*armed) != 0 {
		t.Fatalf("a refused check armed a watcher: %+v", *armed)
	}
}

func TestBrainstormCheckLaunchWritesReadingThenTheRun(t *testing.T) {
	ctx := context.Background()
	armed := stubArmBuilderCheck(t)
	launched := stubLaunchBuilderCheck(t, "run-1", nil)
	project, file := seedBrainstorm(t, testSpecRel, true)
	tabId, blockId := seedAgentTab(t, ctx, waveobj.MetaMapType{waveobj.MetaKey_SessionProject: "lag"})

	if err := (&WshServer{}).BrainstormCheckCommand(ctx, wshrpc.CommandBrainstormCheckData{BlockId: blockId, File: file}); err != nil {
		t.Fatalf("BrainstormCheckCommand: %v", err)
	}
	meta := tabMeta(t, ctx, tabId)
	if got := meta.GetString(waveobj.MetaKey_BrainstormCheckState, ""); got != builderCheckReading {
		t.Fatalf("checkstate = %q, want reading", got)
	}
	if meta.GetFloat(waveobj.MetaKey_BrainstormCheckTs, 0) == 0 || meta.HasKey(waveobj.MetaKey_BrainstormCheckRun) {
		t.Fatalf("reading record = %v, want a checkts and no checkrun yet", meta)
	}
	if len(*armed) != 1 {
		t.Fatalf("armed %d watchers, want 1", len(*armed))
	}
	c := (*armed)[0]
	if c.TabId != tabId || c.BlockId != blockId || c.File != file || c.Project != project {
		t.Fatalf("armed %+v, want the tab, block, file and project", c)
	}

	if err := startBuilderCheck(ctx, &c); err != nil {
		t.Fatalf("startBuilderCheck: %v", err)
	}
	ch, err := wstore.ChannelAtPath(ctx, project)
	if err != nil || ch == nil {
		t.Fatalf("the project's channel: %v %v", ch, err)
	}
	s := (*launched)[0]
	if s.ChannelId != ch.OID || s.WorkspaceId == "" || s.DagORef != "" || s.Role != jarvis.UsageRole_BuilderCheck ||
		s.Tree != project || s.Label != "Builder check · Lag alerts" {
		t.Fatalf("launched %+v, want a builder-check session in the project's channel and tree", s)
	}
	if spec := filepath.Join(project, filepath.FromSlash(testSpecRel)); !strings.Contains(s.Prompt, spec) {
		t.Fatalf("prompt does not name the spec %s", spec)
	}
	meta = tabMeta(t, ctx, tabId)
	if meta.GetString(waveobj.MetaKey_BrainstormCheckState, "") != builderCheckReading ||
		meta.GetString(waveobj.MetaKey_BrainstormCheckRun, "") != "run-1" ||
		meta.GetString(waveobj.MetaKey_BrainstormCheckChannel, "") != ch.OID {
		t.Fatalf("record after launch = %v, want reading with checkrun run-1 and checkchannel %s", meta, ch.OID)
	}
}

func TestBuilderCheckRouteChain(t *testing.T) {
	ctx := context.Background()
	profileRoute := &waveobj.RoutePin{Runtime: "pi", Model: "anthropic/claude-sonnet-5-5"}
	for _, tc := range []struct {
		name     string
		override *waveobj.ProfileOverride
		agent    string
		want     waveobj.RoutePin
	}{
		{"the profile's reviewer route", &waveobj.ProfileOverride{ReviewerRoute: profileRoute}, "claude", *profileRoute},
		{"the agent's runtime", nil, "pi", waveobj.RoutePin{Runtime: "pi"}},
		{"no agent falls to the default runtime", nil, "", waveobj.RoutePin{Runtime: "claude"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			launched := stubLaunchBuilderCheck(t, "run-1", nil)
			project, file := seedBrainstorm(t, testSpecRel, true)
			ch, err := wstore.CreateChannel(ctx, "route", project)
			if err != nil {
				t.Fatalf("CreateChannel: %v", err)
			}
			if tc.override != nil {
				seedProfileMeta(t, ctx, ch.OID, tc.override)
			}
			meta := waveobj.MetaMapType{}
			if tc.agent != "" {
				meta[waveobj.MetaKey_SessionAgent] = tc.agent
			}
			tabId, blockId := seedAgentTab(t, ctx, meta)
			c, err := readBrainstormForCheck(file)
			if err != nil {
				t.Fatal(err)
			}
			c.TabId, c.BlockId = tabId, blockId
			if err := startBuilderCheck(ctx, &c); err != nil {
				t.Fatalf("startBuilderCheck: %v", err)
			}
			if got := (*launched)[0].Route; got != tc.want {
				t.Fatalf("route = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestBuilderCheckDeliversTheReport(t *testing.T) {
	ctx := context.Background()
	_, file := seedBrainstorm(t, testSpecRel, true)
	tabId, blockId := seedAgentTab(t, ctx, nil)
	oldRead := readBuilderCheckRun
	readBuilderCheckRun = func(_ context.Context, _, runId string) (*waveobj.Run, error) {
		return &waveobj.Run{ID: runId, Status: jarvis.RunStatus_Done, Report: "1. Should a paused consumer page?"}, nil
	}
	t.Cleanup(func() { readBuilderCheckRun = oldRead })
	type sent struct{ block, text string }
	var delivered []sent
	oldDeliver := deliverAgentMessage
	deliverAgentMessage = func(block, text string) { delivered = append(delivered, sent{block, text}) }
	t.Cleanup(func() { deliverAgentMessage = oldDeliver })

	c := builderCheck{TabId: tabId, BlockId: blockId, File: file, RunId: "run-1", ChannelId: "ch-1", StartedTs: 1}
	if !tickBuilderCheck(ctx, c, time.Now().UnixMilli()) {
		t.Fatal("a done run with a report did not settle the check")
	}
	path := brainstormcheck.ReportPath(file)
	if got, err := os.ReadFile(path); err != nil || string(got) != "1. Should a paused consumer page?" {
		t.Fatalf("report file = %q, %v, want the run's report", got, err)
	}
	if len(delivered) != 1 || delivered[0] != (sent{blockId, brainstormcheck.Line(path)}) {
		t.Fatalf("delivered %+v, want the line for %s to block %s", delivered, path, blockId)
	}
	meta := tabMeta(t, ctx, tabId)
	if meta.GetString(waveobj.MetaKey_BrainstormCheckState, "") != builderCheckAnswered ||
		meta.GetString(waveobj.MetaKey_BrainstormCheckRun, "") != "run-1" || meta.HasKey(waveobj.MetaKey_BrainstormCheckReason) {
		t.Fatalf("record = %v, want answered for run-1 with no reason", meta)
	}
}

func TestBuilderCheckLostRunStopsAndFails(t *testing.T) {
	ctx := context.Background()
	_, file := seedBrainstorm(t, testSpecRel, true)
	tabId, blockId := seedAgentTab(t, ctx, nil)
	ch, err := wstore.CreateChannel(ctx, "lost", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("check", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	run.StageRole = jarvis.UsageRole_BuilderCheck
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	var stopped []string
	oldStop := stopStageSession
	stopStageSession = func(r waveobj.Run) { stopped = append(stopped, r.ID) }
	t.Cleanup(func() { stopStageSession = oldStop })

	now := time.Now().UnixMilli()
	c := builderCheck{TabId: tabId, BlockId: blockId, File: file, RunId: run.ID, ChannelId: ch.OID,
		StartedTs: now - orchestrate.ReviewTimeout.Milliseconds() - 1}
	if !tickBuilderCheck(ctx, c, now) {
		t.Fatal("a session past its timeout did not settle the check")
	}
	if len(stopped) != 1 || stopped[0] != run.ID {
		t.Fatalf("stopped %v, want the reviewer's run %s", stopped, run.ID)
	}
	meta := tabMeta(t, ctx, tabId)
	if meta.GetString(waveobj.MetaKey_BrainstormCheckState, "") != builderCheckFailed ||
		!strings.Contains(meta.GetString(waveobj.MetaKey_BrainstormCheckReason, ""), "no verdict") {
		t.Fatalf("record = %v, want failed with the lost reason", meta)
	}
}

func TestBuilderCheckLaunchErrorFails(t *testing.T) {
	ctx := context.Background()
	stubLaunchBuilderCheck(t, "", errors.New("pi is not installed"))
	_, file := seedBrainstorm(t, testSpecRel, true)
	tabId, blockId := seedAgentTab(t, ctx, nil)
	c, err := readBrainstormForCheck(file)
	if err != nil {
		t.Fatal(err)
	}
	c.TabId, c.BlockId, c.StartedTs = tabId, blockId, 1

	watchBuilderCheck(ctx, c) // returns at once: the launch failed

	meta := tabMeta(t, ctx, tabId)
	if meta.GetString(waveobj.MetaKey_BrainstormCheckState, "") != builderCheckFailed ||
		meta.GetString(waveobj.MetaKey_BrainstormCheckReason, "") != "Arc could not start the builder: pi is not installed" {
		t.Fatalf("record = %v, want failed with the launch error", meta)
	}
}

func TestResumeBuilderChecksRearmsOrFails(t *testing.T) {
	ctx := context.Background()
	armed := stubArmBuilderCheck(t)
	_, file := seedBrainstorm(t, testSpecRel, true)
	launchedTab, launchedBlock := seedAgentTab(t, ctx, waveobj.MetaMapType{
		waveobj.MetaKey_BrainstormCheckState:   builderCheckReading,
		waveobj.MetaKey_BrainstormCheckTs:      42,
		waveobj.MetaKey_BrainstormCheckRun:     "run-1",
		waveobj.MetaKey_BrainstormCheckChannel: "ch-1",
		waveobj.MetaKey_SessionBrainstorm:      file,
	})
	unlaunchedTab, _ := seedAgentTab(t, ctx, waveobj.MetaMapType{
		waveobj.MetaKey_BrainstormCheckState: builderCheckReading,
		waveobj.MetaKey_BrainstormCheckTs:    42,
		waveobj.MetaKey_SessionBrainstorm:    file,
	})

	ResumeBuilderChecks(ctx)

	var rearmed *builderCheck
	for i := range *armed {
		if (*armed)[i].TabId == launchedTab {
			rearmed = &(*armed)[i]
		}
		if (*armed)[i].TabId == unlaunchedTab {
			t.Fatal("a check with no run was re-armed")
		}
	}
	want := builderCheck{TabId: launchedTab, BlockId: launchedBlock, File: file, RunId: "run-1", ChannelId: "ch-1", StartedTs: 42}
	if rearmed == nil || *rearmed != want {
		t.Fatalf("re-armed %+v, want %+v", rearmed, want)
	}
	if got := tabMeta(t, ctx, launchedTab).GetString(waveobj.MetaKey_BrainstormCheckState, ""); got != builderCheckReading {
		t.Fatalf("re-armed check state = %q, want still reading", got)
	}
	meta := tabMeta(t, ctx, unlaunchedTab)
	if meta.GetString(waveobj.MetaKey_BrainstormCheckState, "") != builderCheckFailed ||
		meta.GetString(waveobj.MetaKey_BrainstormCheckReason, "") != builderCheckRestartedReason {
		t.Fatalf("unlaunched record = %v, want failed: %s", meta, builderCheckRestartedReason)
	}
}
