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
	DagSubmitCommand(ctx context.Context, data CommandDagSubmitData) (*waveobj.TaskGroup, error)       // validate + persist a TaskGroup for an orchestrator run
	DagStatusCommand(ctx context.Context, data CommandDagStatusData) (*CommandDagStatusRtnData, error) // engine-owned status snapshot: group + typed digest
	DagActionCommand(ctx context.Context, data CommandDagActionData) error                             // approve | sendback | retry | skip | escalate | cancel | forward
	DagMergeCommand(ctx context.Context, data CommandDagMergeData) error                               // squash-merge a finished child's worktree back
	DagMergeContinueCommand(ctx context.Context, data CommandDagMergeData) error                       // finish a squash merge after manual conflict resolution
	DagAsksCommand(ctx context.Context, data CommandDagStatusData) (*CommandDagAsksRtnData, error)     // pending child asks (children block on one at a time)
	DagAnswerCommand(ctx context.Context, data CommandDagAnswerData) error                             // deliver an answer to a child's pending ask
}

type CommandDagSubmitData struct {
	ChannelId   string             `json:"channelid"`
	RunId       string             `json:"runid"`
	Title       string             `json:"title,omitempty"`
	Parallelism int                `json:"parallelism"`
	Tasks       []waveobj.TaskNode `json:"tasks"`
	WorkerRoute *waveobj.RoutePin  `json:"workerroute,omitempty"` // nil = inherit lead; B1b workers default
	PlanPath    string             `json:"planpath,omitempty"`    // absolute path to a plan in jarvis.PlanFormat; replaces tasks
}

type CommandDagStatusData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
}

type CommandDagActionData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
	TaskId    string `json:"taskid"`
	Action    string `json:"action"`            // approve | sendback | retry | skip | escalate | cancel | forward | approve-plan | sendback-plan
	Model     string `json:"model,omitempty"`   // escalate target model (exact id); required
	Runtime   string `json:"runtime,omitempty"` // escalate target runtime; empty = task's current runtime
	Notes     string `json:"notes,omitempty"`   // sendback-plan: what the human wants changed, delivered to the lead. forward: what the lead checked and recommends, shown to the human
}

type CommandDagMergeData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`  // the dag's owning (lead) run
	TaskId    string `json:"taskid"` // selects the child whose worktree merges
}

// DagAskItem is one entry in a dag's question queue: the task that raised it, the registry's ask id (so
// the digest and lifecycle events can correlate one ask across raise/answer/clear), who holds it and
// why, every question with its options, the child block the answer is delivered to, and when it was
// raised.
type DagAskItem struct {
	TaskId    string                    `json:"taskid"`
	AskId     string                    `json:"askid,omitempty"`
	Owner     string                    `json:"owner,omitempty"`    // lead | user; empty when the raise could not resolve the dag
	Deadline  int64                     `json:"deadline,omitempty"` // UnixMilli past which a lead-held ask moves to the human
	Note      string                    `json:"note,omitempty"`     // why the holder has it: a forward note, a missed deadline, a failed delivery
	Questions []baseds.AgentAskQuestion `json:"questions"`
	BlockORef string                    `json:"blockoref"`
	Ts        int64                     `json:"ts"`
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

// DagStatus contract — the complete typed status digest promoted from the raw group (spec §5.1).
// The frontend must never re-derive scheduler policy from task state; it renders this digest as-is.

type CommandDagStatusRtnData struct {
	Group  *waveobj.TaskGroup `json:"group"`
	Digest DagStatusDigest    `json:"digest"`
	// PlanFeedback is set, with a nil Group, when the human sent this run's plan back: the dag it
	// describes no longer exists, and what the lead needs is the reason, not a status.
	PlanFeedback string `json:"planfeedback,omitempty"`
}

type DagStatusDigest struct {
	DagVersion int               `json:"dagversion"`
	Health     string            `json:"health"` // needs-you | stalled | healthy | done | cancelled
	Counts     DagStatusCounts   `json:"counts"`
	Next       DagNextStep       `json:"next"`
	Tasks      []DagTaskDigest   `json:"tasks"`
	Durations  DagDurationDigest `json:"durations"`
}

type DagStatusCounts struct {
	Total             int `json:"total"`
	Done              int `json:"done"`
	Running           int `json:"running"`
	Stalled           int `json:"stalled"`
	DependencyWaiting int `json:"dependencywaiting"`
	Attention         int `json:"attention"`
	RecoveredRetry    int `json:"recoveredretry"`
	MergeReady        int `json:"mergeready"`
}

type DagNextStep struct {
	Kind            string   `json:"kind"` // human-action | merge-ready | dispatch | parallelism-wait | dependency-wait | cleanup-wait | terminal
	TaskIds         []string `json:"taskids,omitempty"`
	BlockingTaskIds []string `json:"blockingtaskids,omitempty"`
	Actions         []string `json:"actions,omitempty"` // answer | approve | sendback | resolve-merge | retry | skip | escalate | retry-cleanup
	TerminalStatus  string   `json:"terminalstatus,omitempty"`
}

type DagTaskDigest struct {
	TaskId          string   `json:"taskid"`
	WaitReason      string   `json:"waitreason"` // none | dependency | parallelism | gate | ask | failure | merge | cleanup | terminal
	BlockingTaskIds []string `json:"blockingtaskids,omitempty"`
	HumanActions    []string `json:"humanactions,omitempty"` // answer | approve | sendback | resolve-merge | retry | skip | escalate | retry-cleanup
	AskId           string   `json:"askid,omitempty"`
	AskSummary      string   `json:"asksummary,omitempty"`
	AskTs           int64    `json:"askts,omitempty"`
	FreshnessTs     int64    `json:"freshnessts,omitempty"`
	RecoveredRetry  bool     `json:"recoveredretry,omitempty"`
	MergeState      string   `json:"mergestate"`   // not-required | waiting | ready | blocked | merged
	CleanupState    string   `json:"cleanupstate"` // not-required | clear | pending | failed
}

type DagDurationDigest struct {
	ElapsedMs int64             `json:"elapsedms"`
	Partial   bool              `json:"partial,omitempty"`
	Tasks     []DagTaskDuration `json:"tasks,omitempty"`
}

type DagTaskDuration struct {
	TaskId      string `json:"taskid"`
	RunMs       int64  `json:"runms,omitempty"`
	MergeWaitMs int64  `json:"mergewaitms,omitempty"`
	CleanupMs   int64  `json:"cleanupms,omitempty"`
	Partial     bool   `json:"partial,omitempty"`
}
