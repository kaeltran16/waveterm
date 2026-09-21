// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// stubLeadTabDelete makes DeleteTab queue the workspace and tab updates it would, then return err.
func stubLeadTabDelete(t *testing.T, err error) *[]waveobj.UpdatesRtnType {
	t.Helper()
	oldDelete, oldSend := deleteTab, sendLeadTabUpdates
	t.Cleanup(func() { deleteTab, sendLeadTabUpdates = oldDelete, oldSend })
	deleteTab = func(ctx context.Context, workspaceId, tabId string, _ bool) (string, error) {
		waveobj.ContextAddUpdate(ctx, waveobj.WaveObjUpdate{UpdateType: waveobj.UpdateType_Update, OType: waveobj.OType_Workspace, OID: workspaceId})
		waveobj.ContextAddUpdate(ctx, waveobj.WaveObjUpdate{UpdateType: waveobj.UpdateType_Delete, OType: waveobj.OType_Tab, OID: tabId})
		return "", err
	}
	var sent []waveobj.UpdatesRtnType
	sendLeadTabUpdates = func(u waveobj.UpdatesRtnType) { sent = append(sent, u) }
	return &sent
}

// the app drops a tab only on a broadcast workspace update; without one the closed lead stays a frozen row
func TestDeleteLeadTabBroadcastsTheWorkspaceChange(t *testing.T) {
	sent := stubLeadTabDelete(t, nil)
	if err := deleteLeadTab(context.Background(), "ws-1", "lead-tab"); err != nil {
		t.Fatal(err)
	}
	if len(*sent) != 1 || len((*sent)[0]) != 2 {
		t.Fatalf("want one broadcast of the workspace and tab updates, got %+v", *sent)
	}
}

// a DeleteTab that fails part-way may already have closed the blocks, so what it did is still broadcast
func TestDeleteLeadTabBroadcastsAfterAFailure(t *testing.T) {
	sent := stubLeadTabDelete(t, errors.New("boom"))
	if err := deleteLeadTab(context.Background(), "ws-1", "lead-tab"); err == nil {
		t.Fatal("the delete error must be returned")
	}
	if len(*sent) != 1 {
		t.Fatalf("want the partial updates broadcast, got %d broadcasts", len(*sent))
	}
}

// stubBlockShellStatus fakes the block controller's process status, "" meaning it has no controller.
func stubBlockShellStatus(t *testing.T, status string) {
	t.Helper()
	old := blockShellStatus
	t.Cleanup(func() { blockShellStatus = old })
	blockShellStatus = func(string) string { return status }
}

// deadLeadFixture is a finished dag under an owner run whose orchestrate phase carries a lead tab.
func deadLeadFixture(t *testing.T) (*waveobj.Run, *waveobj.TaskGroup) {
	t.Helper()
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "leadclose-"+uuid.NewString(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tabID, blockID := uuid.NewString(), uuid.NewString()
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: tabID, BlockIds: []string{blockID}, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(), 1)
	owner.Phases[0].WorkerOrefs = []string{"tab:" + tabID}
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	g.Status = DagStatus_Done
	g.Tasks[0].State = TaskState_Done
	return &owner, &g
}

func TestMaybeCompleteLeadFreeRunClosesARunWhoseLeadProcessIsGone(t *testing.T) {
	stubBlockShellStatus(t, blockcontroller.Status_Done)
	owner, g := deadLeadFixture(t)
	if !MaybeCompleteLeadFreeRun(context.Background(), owner, g) {
		t.Fatal("a lead tab with no live process must not keep a finished run open")
	}
	if owner.Status != jarvis.RunStatus_Done {
		t.Fatalf("run status = %q, want done", owner.Status)
	}
}

func TestMaybeCompleteLeadFreeRunLeavesARunWithALiveLead(t *testing.T) {
	stubBlockShellStatus(t, blockcontroller.Status_Running)
	owner, g := deadLeadFixture(t)
	before := owner.Status
	if MaybeCompleteLeadFreeRun(context.Background(), owner, g) {
		t.Fatal("a live lead still owes the human a summary")
	}
	if owner.Status != before {
		t.Fatalf("run status = %q, want unchanged %q", owner.Status, before)
	}
}

func TestMaybeCompleteLeadFreeRunLeavesALeadStillStarting(t *testing.T) {
	stubBlockShellStatus(t, blockcontroller.Status_Init)
	owner, g := deadLeadFixture(t)
	if MaybeCompleteLeadFreeRun(context.Background(), owner, g) {
		t.Fatal("a lead mid-launch must not be closed out from under it")
	}
}
