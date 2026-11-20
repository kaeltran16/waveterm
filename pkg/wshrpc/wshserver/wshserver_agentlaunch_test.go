// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"reflect"
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func newLaunchWorkspace(t *testing.T) *waveobj.Workspace {
	t.Helper()
	ws, err := wcore.CreateWorkspace(context.Background(), "", "", "", false, false)
	if err != nil {
		t.Fatal(err)
	}
	return ws
}

func workspaceTabIds(t *testing.T, workspaceId string) []string {
	t.Helper()
	ws, err := wstore.DBMustGet[*waveobj.Workspace](context.Background(), workspaceId)
	if err != nil {
		t.Fatal(err)
	}
	return ws.TabIds
}

// stubAgentTabStart records each start instead of launching a process.
func stubAgentTabStart(t *testing.T) *[]string {
	t.Helper()
	old := startAgentTab
	t.Cleanup(func() { startAgentTab = old })
	var started []string
	startAgentTab = func(_ context.Context, tabId, blockId string) error {
		started = append(started, tabId+"/"+blockId)
		return nil
	}
	return &started
}

func TestLaunchAgentTabOpensTheTabItIsGiven(t *testing.T) {
	for _, start := range []bool{false, true} {
		started := stubAgentTabStart(t)
		ws := newLaunchWorkspace(t)
		tabMeta := waveobj.MetaMapType{"session:agent": "pi", "session:project": "proj"}
		args := []string{"--model", "a b", "say hi"}
		rtn, err := (&WshServer{}).LaunchAgentTabCommand(context.Background(), wshrpc.CommandLaunchAgentTabData{
			WorkspaceId: ws.OID, TabName: "proj", TabMeta: tabMeta, Start: start,
			BlockMeta: waveobj.MetaMapType{
				waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "cmd",
				waveobj.MetaKey_Cmd: "pi", waveobj.MetaKey_CmdArgs: args,
			},
		})
		if err != nil {
			t.Fatalf("start=%v: %v", start, err)
		}
		if rtn.StartError != "" {
			t.Fatalf("start=%v: starterror %q", start, rtn.StartError)
		}
		tab, err := wstore.DBMustGet[*waveobj.Tab](context.Background(), rtn.TabId)
		if err != nil {
			t.Fatal(err)
		}
		if tab.Name != "proj" || len(tab.BlockIds) == 0 || tab.BlockIds[0] != rtn.BlockId {
			t.Fatalf("start=%v: tab %q blocks %v, want proj with first block %s", start, tab.Name, tab.BlockIds, rtn.BlockId)
		}
		if !reflect.DeepEqual(tab.Meta, tabMeta) {
			t.Fatalf("start=%v: tab meta %v, want exactly %v", start, tab.Meta, tabMeta)
		}
		if !slices.Contains(workspaceTabIds(t, ws.OID), rtn.TabId) {
			t.Fatalf("start=%v: the tab is not in its workspace", start)
		}
		block, err := wstore.DBMustGet[*waveobj.Block](context.Background(), rtn.BlockId)
		if err != nil {
			t.Fatal(err)
		}
		if block.Meta.GetString(waveobj.MetaKey_Cmd, "") != "pi" || block.Meta.GetString(waveobj.MetaKey_Controller, "") != "cmd" ||
			!reflect.DeepEqual(block.Meta.GetStringList(waveobj.MetaKey_CmdArgs), args) {
			t.Fatalf("start=%v: block meta %v", start, block.Meta)
		}
		var want []string
		if start {
			want = []string{rtn.TabId + "/" + rtn.BlockId}
		}
		if !reflect.DeepEqual(*started, want) {
			t.Fatalf("start=%v: started %v, want %v", start, *started, want)
		}
	}
}

// the UI keys "failed to start" by block id and keeps the tab, so a refused start still returns both ids
func TestLaunchAgentTabKeepsTheTabWhenTheStartIsRefused(t *testing.T) {
	ws := newLaunchWorkspace(t)
	rtn, err := (&WshServer{}).LaunchAgentTabCommand(context.Background(), wshrpc.CommandLaunchAgentTabData{
		WorkspaceId: ws.OID, TabName: "proj", Start: true,
		BlockMeta: waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "no-such-controller"},
	})
	if err != nil {
		t.Fatalf("a refused start is not an error: %v", err)
	}
	if rtn.StartError == "" || rtn.TabId == "" || rtn.BlockId == "" {
		t.Fatalf("want both ids and the refusal, got %+v", rtn)
	}
	if !slices.Contains(workspaceTabIds(t, ws.OID), rtn.TabId) {
		t.Fatal("a refused start must keep its tab")
	}
}

func TestLaunchAgentTabRefusesBeforeOpeningLeavesNoTab(t *testing.T) {
	ws := newLaunchWorkspace(t)
	before := workspaceTabIds(t, ws.OID)
	useSnapshotBase(t, true)
	started := stubAgentTabStart(t)
	_, err := (&WshServer{}).LaunchAgentTabCommand(context.Background(), wshrpc.CommandLaunchAgentTabData{
		WorkspaceId: ws.OID, TabName: "proj", Start: true,
		BlockMeta: waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "cmd", waveobj.MetaKey_CmdCwd: t.TempDir()},
	})
	if err == nil {
		t.Fatal("a snapshot store must refuse a directory outside its scratch dir")
	}
	if after := workspaceTabIds(t, ws.OID); !reflect.DeepEqual(after, before) || len(*started) != 0 {
		t.Fatalf("tabs %v -> %v, started %v: a refusal before the start leaves no tab", before, after, *started)
	}
}
