// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// a run that was created but could not be read back must fail the RPC, not reply {run: null}
func TestCreateRunReportsAFailedReadBack(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "createrun-readback", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	stubRunServer(t, "pi", nil)
	var createdID string
	old := readCreatedRun
	readCreatedRun = func(_ context.Context, _ string, runID string) (*waveobj.Run, error) {
		createdID = runID
		return nil, errors.New("sql: transaction has already been committed or rolled back")
	}
	t.Cleanup(func() { readCreatedRun = old })

	rtn, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "test", Runtime: "pi",
		Mode: jarvis.RunMode_Orchestrator, DeferStart: true,
	})
	if err == nil || rtn != nil {
		t.Fatalf("want an error and no reply, got rtn=%+v err=%v", rtn, err)
	}
	if !strings.Contains(err.Error(), createdID) || !strings.Contains(err.Error(), "transaction has already been committed") {
		t.Fatalf("error must name the run and the cause, got %v", err)
	}
	if _, gerr := wstore.GetRun(ctx, ch.OID, createdID); gerr != nil {
		t.Fatalf("the run itself must still exist: %v", gerr)
	}
}

// A run whose read-back failed only because the handler's own budget expired is still durable: an engine
// launch builds a worktree and a worker per lane before the read, so it can outlast the budget. Retrying
// off that dead ctx must return the run rather than report a working launch as a failure.
func TestCreateRunRetriesTheReadBackAfterABudgetExpiry(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "createrun-budget", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	stubRunServer(t, "pi", nil)
	calls := 0
	old := readCreatedRun
	readCreatedRun = func(rctx context.Context, chID string, runID string) (*waveobj.Run, error) {
		calls++
		if calls == 1 {
			return nil, context.DeadlineExceeded
		}
		return old(rctx, chID, runID)
	}
	t.Cleanup(func() { readCreatedRun = old })

	rtn, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "test", Runtime: "pi",
		Mode: jarvis.RunMode_Orchestrator, DeferStart: true,
	})
	if err != nil {
		t.Fatalf("a read-back that succeeds on the retry must not fail the RPC: %v", err)
	}
	if rtn == nil || rtn.Run == nil {
		t.Fatalf("want the created run, got %+v", rtn)
	}
	if calls != 2 {
		t.Fatalf("want exactly two read attempts, got %d", calls)
	}
}
