// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/pitasks"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) GetTasksCommand(ctx context.Context, data wshrpc.CommandGetTasksData) (*wshrpc.CommandGetTasksRtnData, error) {
	tasks, err := pitasks.Read(data.Cwd)
	if err != nil {
		return nil, fmt.Errorf("reading pi-tasks: %w", err)
	}
	out := make([]wshrpc.PiTask, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, wshrpc.PiTask{
			ID:          t.ID,
			Subject:     t.Subject,
			Description: t.Description,
			Status:      t.Status,
			Owner:       t.Owner,
			Blocks:      t.Blocks,
			BlockedBy:   t.BlockedBy,
			CreatedAt:   t.CreatedAt,
			UpdatedAt:   t.UpdatedAt,
		})
	}
	return &wshrpc.CommandGetTasksRtnData{Tasks: out}, nil
}
