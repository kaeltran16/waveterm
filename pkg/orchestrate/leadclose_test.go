// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
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
