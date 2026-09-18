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
