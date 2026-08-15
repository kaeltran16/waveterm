// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// DagCommands is the deterministic orchestration engine surface (pkg/orchestrate).
type DagCommands interface {
	DagSubmitCommand(ctx context.Context, data CommandDagSubmitData) (*waveobj.TaskGroup, error) // validate + persist a TaskGroup for an orchestrator run
	DagStatusCommand(ctx context.Context, data CommandDagStatusData) (*waveobj.TaskGroup, error)   // engine-owned status snapshot
	DagActionCommand(ctx context.Context, data CommandDagActionData) error                         // approve | sendback | retry | skip | cancel
	DagMergeCommand(ctx context.Context, data CommandDagMergeData) error                           // squash-merge a finished child's worktree back
}

type CommandDagSubmitData struct {
	ChannelId   string             `json:"channelid"`
	RunId       string             `json:"runid"`
	Title       string             `json:"title,omitempty"`
	Parallelism int                `json:"parallelism"`
	Tasks       []waveobj.TaskNode `json:"tasks"`
}

type CommandDagStatusData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
}

type CommandDagActionData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
	TaskId    string `json:"taskid"`
	Action    string `json:"action"` // approve | sendback | retry | skip | cancel
}

type CommandDagMergeData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
}
