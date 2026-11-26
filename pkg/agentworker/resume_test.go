// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentworker

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/memgate"
	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

type startCall struct{ tabId, blockId string }

// stubStart records each process start in place of a pty, failing with err when it is set.
func stubStart(t *testing.T, err error) *[]startCall {
	t.Helper()
	calls := &[]startCall{}
	old := startAgentTab
	startAgentTab = func(_ context.Context, tabId, blockId string) error {
		*calls = append(*calls, startCall{tabId, blockId})
		return err
	}
	t.Cleanup(func() { startAgentTab = old })
	return calls
}

// seedStoppedWorker stores a claude worker as its stop leaves it: disarmed, with its session and launch flags.
func seedStoppedWorker(t *testing.T, cwd string) (tabId, blockId string) {
	t.Helper()
	return seedWorker(t,
		waveobj.MetaMapType{MetaParentTab: "parent-tab", "session:agent": "claude"},
		waveobj.MetaMapType{
			waveobj.MetaKey_Controller: "",
			waveobj.MetaKey_CmdCwd:     cwd,
			waveobj.MetaKey_CmdArgs:    []string{"--session-id", "sess-1", "--model", "opus", "the task"},
			MetaSessionId:              "sess-1",
			"agent:baseargs":           []string{"--model", "opus"},
		})
}

func TestResumeWorkerStartsItsSessionWithTheMessage(t *testing.T) {
	isolateGate(t)
	starts := stubStart(t, nil)
	updates := recordBlockUpdates(t)
	tabId, blockId := seedStoppedWorker(t, t.TempDir())

	if err := ResumeWorker(context.Background(), tabId, "and the docs"); err != nil {
		t.Fatalf("ResumeWorker: %v", err)
	}
	if c, heard := updates.controller(blockId); !heard || c != "cmd" {
		t.Errorf("the frontend last heard controller %q (heard %v), want the arm broadcast", c, heard)
	}
	t.Cleanup(func() { memgate.ReleaseOwner(jobobject.Owner{Kind: jobobject.OwnerKind_Block, Id: blockId}) })
	if want := (startCall{tabId, blockId}); len(*starts) != 1 || (*starts)[0] != want {
		t.Fatalf("starts = %+v, want one of %+v", *starts, want)
	}
	meta := blockMeta(t, blockId)
	if got := meta.GetString(waveobj.MetaKey_Controller, ""); got != "cmd" {
		t.Errorf("controller = %q, want the block armed as cmd", got)
	}
	wantArgs := []string{"--resume", "sess-1", "--model", "opus", "and the docs"}
	if got := meta.GetStringList(waveobj.MetaKey_CmdArgs); !slices.Equal(got, wantArgs) {
		t.Errorf("args = %q, want %q", got, wantArgs)
	}
	if n := memgate.LiveClaimsForTest(); n != 1 {
		t.Errorf("the gate holds %d claims, want the resumed worker's one", n)
	}
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId).String()
	events := wps.Broker.ReadEventHistory(wps.Event_AgentStatus, oref, 1)
	if len(events) != 1 || events[0].Data.(baseds.AgentStatusData).State != baseds.AgentState_Working {
		t.Errorf("retained status = %+v, want working", events)
	}
}

// each refusal leaves the worker as it was: disarmed, with no process started and no claim held
func TestResumeWorkerRefusalsLeaveItStopped(t *testing.T) {
	cases := []struct {
		name     string
		arrange  func(t *testing.T, setFree func(uint64))
		startErr error
		want     string
	}{
		{name: "gate refuses", arrange: func(t *testing.T, setFree func(uint64)) {
			// an empty book always admits, so another claim holds the memory
			held, ok := memgate.TryAdmit(memgate.Request{Tag: memgate.Tag{RunId: "run-1", TaskId: "t-2", Role: memgate.RoleWorker}})
			if !ok {
				t.Fatal("an empty book must admit")
			}
			t.Cleanup(held.Release)
			setFree(1 << 30)
		}, want: "memory is short"},
		{name: "snapshot app outside its scratch dir", arrange: func(t *testing.T, _ func(uint64)) {
			t.Setenv(wavebase.ArcSnapshotVarName, "1")
		}, want: "snapshot store"},
		{name: "process fails to start", startErr: errors.New("pty refused"), want: "pty refused"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			setFree := isolateGate(t)
			if c.arrange != nil {
				c.arrange(t, setFree)
			}
			before := memgate.LiveClaimsForTest()
			starts := stubStart(t, c.startErr)
			tabId, blockId := seedStoppedWorker(t, t.TempDir())

			err := ResumeWorker(context.Background(), tabId, "go on")
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want one containing %q", err, c.want)
			}
			if c.startErr == nil && len(*starts) != 0 {
				t.Errorf("a refused resume started the process: %+v", *starts)
			}
			if got := blockMeta(t, blockId).GetString(waveobj.MetaKey_Controller, ""); got != "" {
				t.Errorf("controller = %q, want the worker still disarmed", got)
			}
			if after := memgate.LiveClaimsForTest(); after != before {
				t.Errorf("the gate's book went from %d to %d claims", before, after)
			}
		})
	}
}
