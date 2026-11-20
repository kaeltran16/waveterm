// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// a run's tree is merged and deleted by the engine, so a worker there would work outside review and landing
func TestAgentsStartRefusesARunsAgent(t *testing.T) {
	stamped := func(t *testing.T, tabId, blockId string) {
		if _, err := wstore.UpdateObjectMeta(context.Background(), waveobj.MakeORef(waveobj.OType_Block, blockId),
			waveobj.MetaMapType{"agent:runid": "run-1"}, false); err != nil {
			t.Fatal(err)
		}
	}
	listed := func(t *testing.T, tabId, blockId string) {
		id := uuid.NewString()
		run := &waveobj.Run{OID: id, ID: id, Phases: []waveobj.RunPhase{{WorkerOrefs: []string{"tab:" + tabId}}}}
		if err := wstore.DBInsert(context.Background(), run); err != nil {
			t.Fatal(err)
		}
	}
	for name, mark := range map[string]func(t *testing.T, tabId, blockId string){"its block names a run": stamped, "a run lists its tab": listed} {
		t.Run(name, func(t *testing.T) {
			ws := newLaunchWorkspace(t)
			tabId, blockId, err := jarvis.OpenAgentTab(context.Background(), jarvis.AgentTabSpec{
				WorkspaceId: ws.OID, TabName: "proj", TabMeta: waveobj.MetaMapType{"session:agent": "claude"},
				BlockMeta: waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "cmd", waveobj.MetaKey_CmdCwd: t.TempDir()},
			})
			if err != nil {
				t.Fatal(err)
			}
			mark(t, tabId, blockId)
			before := workspaceTabIds(t, ws.OID)

			// a harness no worker can run, so a refusal that regresses fails here without launching a process
			_, err = (&WshServer{}).AgentsStartCommand(context.Background(), wshrpc.CommandAgentsStartData{
				FromORef: waveobj.MakeORef(waveobj.OType_Block, blockId).String(), Prompt: "task", Harness: "none",
			})
			if err == nil || !strings.Contains(err.Error(), "delegate through their plan") {
				t.Fatalf("err = %v, want the run-delegation refusal", err)
			}
			if after := workspaceTabIds(t, ws.OID); !reflect.DeepEqual(after, before) {
				t.Errorf("tabs %v -> %v: a refused caller gets no tab", before, after)
			}
		})
	}
}
