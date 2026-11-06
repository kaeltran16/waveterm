// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/memhygiene"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) ListMemoryHygieneCommand(ctx context.Context) (*wshrpc.CommandListMemoryHygieneRtnData, error) {
	projects, err := memhygiene.ListProjects()
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandListMemoryHygieneRtnData{Projects: projects}, nil
}

func (ws *WshServer) CheckMemoryHygieneCommand(ctx context.Context, data wshrpc.CommandCheckMemoryHygieneData) error {
	if wavebase.IsSnapshot() {
		return fmt.Errorf("snapshot store: not checking memory for %s, a check calls a model", data.Project)
	}
	return memhygiene.StartCheck(data.Project)
}

// keep and reopen write only the copied state, so they go through a snapshot
func (ws *WshServer) DecideMemoryChangeCommand(ctx context.Context, data wshrpc.CommandDecideMemoryChangeData) (*wshrpc.MemHygieneProject, error) {
	if wavebase.IsSnapshot() && (data.Verdict == wshrpc.MemVerdict_Apply || data.Verdict == wshrpc.MemVerdict_Undo) {
		return nil, fmt.Errorf("snapshot store: not running %s on a memory change in %s, it writes the real memory folders and repo settings", data.Verdict, data.Project)
	}
	return memhygiene.Decide(data.Project, data.ChangeId, data.Verdict)
}
