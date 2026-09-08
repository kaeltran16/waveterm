// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

type AgentSyncCommands interface {
	AgentSyncStatusCommand(ctx context.Context) (*CommandAgentSyncStatusRtnData, error)
	AgentSyncApplyCommand(ctx context.Context, data CommandAgentSyncApplyData) (*CommandAgentSyncApplyRtnData, error)
	AgentSyncAdoptCommand(ctx context.Context, data CommandAgentSyncAdoptData) (*CommandAgentSyncAdoptRtnData, error)
	AgentSyncSteeringReadCommand(ctx context.Context) (*CommandAgentSyncSteeringReadRtnData, error)
	AgentSyncSteeringWriteCommand(ctx context.Context, data CommandAgentSyncSteeringWriteData) (*CommandAgentSyncSteeringWriteRtnData, error)
	AgentSyncHarnessReadCommand(ctx context.Context, data CommandAgentSyncHarnessReadData) (*CommandAgentSyncHarnessReadRtnData, error)
	AgentSyncHarnessWriteCommand(ctx context.Context, data CommandAgentSyncHarnessWriteData) (*CommandAgentSyncHarnessWriteRtnData, error)
	AgentSyncFoldCommand(ctx context.Context, data CommandAgentSyncFoldData) (*CommandAgentSyncFoldRtnData, error)
	AgentSyncSkillsCommand(ctx context.Context) (*CommandAgentSyncSkillsRtnData, error)
}

type AgentSyncHarness struct {
	Runtime  string `json:"runtime"`
	Label    string `json:"label"`
	Present  bool   `json:"present"`
	Steering string `json:"steering"`
	// Own reports rules this harness still holds outside the shared region — what a fold would move.
	Own             bool   `json:"own"`
	SkillsManaged   int    `json:"skillsmanaged"`
	SkillsUnmanaged int    `json:"skillsunmanaged"`
	Note            string `json:"note,omitempty"`
}

type AgentSyncAction struct {
	Kind    string `json:"kind"`
	Runtime string `json:"runtime"`
	Path    string `json:"path"`
	Detail  string `json:"detail,omitempty"`
}

type CommandAgentSyncStatusRtnData struct {
	Harnesses   []AgentSyncHarness `json:"harnesses"`
	SteeringDoc string             `json:"steeringdoc"`
	SkillsRoot  string             `json:"skillsroot"`
}

type CommandAgentSyncApplyData struct {
	DryRun bool `json:"dryrun,omitempty"`
}

type CommandAgentSyncApplyRtnData struct {
	Actions []AgentSyncAction `json:"actions"`
}

type CommandAgentSyncAdoptData struct {
	Apply bool `json:"apply,omitempty"`
}

// AgentSyncSkillMove is one harness-local skill tree folded into the vault. Seed marks the copy that
// becomes the shared tree; Keys and Files are what a later copy overrides.
type AgentSyncSkillMove struct {
	Runtime  string   `json:"runtime"`
	Name     string   `json:"name"`
	From     string   `json:"from"`
	Seed     bool     `json:"seed"`
	Keys     []string `json:"keys,omitempty"`
	Files    []string `json:"files,omitempty"`
	BodyDiff bool     `json:"bodydiff"`
}

type CommandAgentSyncAdoptRtnData struct {
	Moves      []AgentSyncSkillMove `json:"moves,omitempty"`
	Unresolved []string             `json:"unresolved,omitempty"`
}

type CommandAgentSyncSteeringReadRtnData struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mtime   int64  `json:"mtime"`
}

type CommandAgentSyncSteeringWriteData struct {
	Content   string `json:"content"`
	BaseMtime int64  `json:"basemtime"`
}

type CommandAgentSyncSteeringWriteRtnData struct {
	Mtime    int64 `json:"mtime"`
	Conflict bool  `json:"conflict"`
}

type CommandAgentSyncHarnessReadData struct {
	Runtime string `json:"runtime"`
}

// CommandAgentSyncHarnessReadRtnData is one harness's steering file in the three zones the Steering
// tab shows: the rules it holds of its own, the shared block Arc projects, and the memory projection.
type CommandAgentSyncHarnessReadRtnData struct {
	Runtime string `json:"runtime"`
	Path    string `json:"path"`
	Present bool   `json:"present"`
	Own     string `json:"own"`
	Shared  string `json:"shared"`
	Memory  string `json:"memory"`
	State   string `json:"state"`
	Mtime   int64  `json:"mtime"`
	Carried int    `json:"carried"`
}

type CommandAgentSyncHarnessWriteData struct {
	Runtime   string `json:"runtime"`
	Own       string `json:"own"`
	BaseMtime int64  `json:"basemtime"`
}

type CommandAgentSyncHarnessWriteRtnData struct {
	Mtime    int64 `json:"mtime"`
	Conflict bool  `json:"conflict"`
}

type CommandAgentSyncFoldData struct {
	Runtime string `json:"runtime"`
}

type CommandAgentSyncFoldRtnData struct {
	Runtime string   `json:"runtime"`
	Lines   []string `json:"lines,omitempty"`
	Seeded  bool     `json:"seeded"`
}

// AgentSyncSkill is one canonical skill and its state in each harness that scans a skills directory.
type AgentSyncSkill struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// States maps runtime -> synced | differs | unmanaged | absent.
	States map[string]string `json:"states"`
	// Deltas maps runtime -> the frontmatter keys and sidecar files it overrides.
	Deltas map[string][]string `json:"deltas,omitempty"`
}

// AgentSyncSkillColumn is one column of the skills matrix: a harness with a fixed skills directory.
type AgentSyncSkillColumn struct {
	Runtime string `json:"runtime"`
	Label   string `json:"label"`
	Present bool   `json:"present"`
}

type CommandAgentSyncSkillsRtnData struct {
	Skills     []AgentSyncSkill       `json:"skills"`
	Columns    []AgentSyncSkillColumn `json:"columns"`
	SkillsRoot string                 `json:"skillsroot"`
}
