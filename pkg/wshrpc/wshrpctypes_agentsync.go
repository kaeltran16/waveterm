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
	AgentSyncSkillsCommand(ctx context.Context) (*CommandAgentSyncSkillsRtnData, error)
	AgentSyncProjectionCommand(ctx context.Context, data CommandAgentSyncProjectionData) (*CommandAgentSyncProjectionRtnData, error)
}

type AgentSyncHarness struct {
	Runtime        string `json:"runtime"`
	Label          string `json:"label"`
	Present        bool   `json:"present"`
	Steering       string `json:"steering"`
	SkillsLinked   int    `json:"skillslinked"`
	SkillsConflict int    `json:"skillsconflict"`
	Note           string `json:"note,omitempty"`
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
	Apply      bool              `json:"apply,omitempty"`
	Prefer     map[string]string `json:"prefer,omitempty"`
	AcceptLoss bool              `json:"acceptloss,omitempty"`
}

type AgentSyncCarriedLine struct {
	Runtime string `json:"runtime"`
	Line    string `json:"line"`
}

type AgentSyncSkillMove struct {
	Runtime string `json:"runtime"`
	Name    string `json:"name"`
	From    string `json:"from"`
}

type AgentSyncSkillCollision struct {
	Name    string   `json:"name"`
	Sources []string `json:"sources"`
}

type CommandAgentSyncAdoptRtnData struct {
	SeedFrom   string                    `json:"seedfrom,omitempty"`
	SeedLines  int                       `json:"seedlines"`
	Carried    []AgentSyncCarriedLine    `json:"carried,omitempty"`
	Moves      []AgentSyncSkillMove      `json:"moves,omitempty"`
	Collisions []AgentSyncSkillCollision `json:"collisions,omitempty"`
	Blocked    bool                      `json:"blocked"`
	Reasons    []string                  `json:"reasons,omitempty"`
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

// AgentSyncSkill is one canonical skill and its state in each harness that scans a skills directory.
type AgentSyncSkill struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// States maps runtime -> linked | pending | conflict | absent.
	States map[string]string `json:"states"`
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

type CommandAgentSyncProjectionData struct {
	Runtime string `json:"runtime"`
}

type CommandAgentSyncProjectionRtnData struct {
	Runtime string `json:"runtime"`
	Path    string `json:"path"`
	Present bool   `json:"present"`
	State   string `json:"state"`
	Body    string `json:"body"`
}
