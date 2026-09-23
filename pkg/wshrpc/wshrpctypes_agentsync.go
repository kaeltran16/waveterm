// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

type AgentSyncCommands interface {
	AgentSyncStatusCommand(ctx context.Context) (*CommandAgentSyncStatusRtnData, error)
	AgentSyncApplyCommand(ctx context.Context, data CommandAgentSyncApplyData) (*CommandAgentSyncApplyRtnData, error)
	AgentSyncAdoptCommand(ctx context.Context, data CommandAgentSyncAdoptData) (*CommandAgentSyncAdoptRtnData, error)
	AgentSyncFoldCommand(ctx context.Context, data CommandAgentSyncFoldData) (*CommandAgentSyncFoldRtnData, error)
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

type CommandAgentSyncFoldData struct {
	Runtime string `json:"runtime"`
}

type CommandAgentSyncFoldRtnData struct {
	Runtime string   `json:"runtime"`
	Lines   []string `json:"lines,omitempty"`
	Seeded  bool     `json:"seeded"`
}
