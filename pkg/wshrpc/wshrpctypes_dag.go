// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// DagCommands is the deterministic orchestration engine surface (pkg/orchestrate).
type DagCommands interface {
	DagSubmitCommand(ctx context.Context, data CommandDagSubmitData) (*waveobj.TaskGroup, error)   // validate + persist a TaskGroup for an orchestrator run
	DagStatusCommand(ctx context.Context, data CommandDagStatusData) (*waveobj.TaskGroup, error)   // engine-owned status snapshot
	DagActionCommand(ctx context.Context, data CommandDagActionData) error                         // approve | sendback | retry | skip | escalate | cancel
	DagMergeCommand(ctx context.Context, data CommandDagMergeData) error                           // squash-merge a finished child's worktree back
	DagAsksCommand(ctx context.Context, data CommandDagStatusData) (*CommandDagAsksRtnData, error) // pending child asks (children block on one at a time)
	DagAnswerCommand(ctx context.Context, data CommandDagAnswerData) error                         // deliver an answer to a child's pending ask
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
	Action    string `json:"action"` // approve | sendback | retry | skip | escalate | cancel
	Tier      string `json:"tier,omitempty"`
}

type CommandDagMergeData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`  // the dag's owning (lead) run
	TaskId    string `json:"taskid"` // selects the child whose worktree merges
}

// DagAskItem is one pending child ask: the task that raised it, the question text + options, the child
// block the answer must be delivered to, and when it was raised.
type DagAskItem struct {
	TaskId    string         `json:"taskid"`
	Question  string         `json:"question"`
	Options   []DagAskOption `json:"options,omitempty"`
	BlockORef string         `json:"blockoref"`
	Ts        int64          `json:"ts"`
}

// DagAskOption is one selectable answer option of a pending child ask.
type DagAskOption struct {
	Label string `json:"label"`
}

type CommandDagAsksRtnData struct {
	Asks []DagAskItem `json:"asks"`
}

type CommandDagAnswerData struct {
	ChannelId string                   `json:"channelid"`
	RunId     string                   `json:"runid"`
	TaskId    string                   `json:"taskid"`
	Answers   []baseds.AgentAnswerItem `json:"answers"`
}
