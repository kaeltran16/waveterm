// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

type TasksCommands interface {
	// GetTasksCommand lists the pi-tasks records persisted under <cwd>/.pi/tasks
	// (read-only mirror; empty cwd → empty result, no error).
	GetTasksCommand(ctx context.Context, data CommandGetTasksData) (*CommandGetTasksRtnData, error)
}

type CommandGetTasksData struct {
	Cwd string `json:"cwd"`
}

type CommandGetTasksRtnData struct {
	Tasks []PiTask `json:"tasks"`
}

// PiTask is the wshrpc mirror of pkg/pitasks.Task (persisted subset; lowercase json tags, matching SessionInfo).
type PiTask struct {
	ID          string   `json:"id"`
	Subject     string   `json:"subject"`
	Description string   `json:"description"`
	Status      string   `json:"status"`
	Owner       string   `json:"owner"`
	Blocks      []string `json:"blocks"`
	BlockedBy   []string `json:"blockedby"`
	CreatedAt   int64    `json:"createdat"`
	UpdatedAt   int64    `json:"updatedat"`
}
