// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"os"

	"github.com/wavetermdev/waveterm/pkg/agentsync"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) AgentSyncStatusCommand(ctx context.Context) (*wshrpc.CommandAgentSyncStatusRtnData, error) {
	p := agentsync.DefaultPaths()
	rows, err := agentsync.Status(p)
	if err != nil {
		return nil, fmt.Errorf("reading harness sync status: %w", err)
	}
	out := make([]wshrpc.AgentSyncHarness, len(rows))
	for i, r := range rows {
		out[i] = wshrpc.AgentSyncHarness{
			Runtime: r.Runtime, Label: r.Label, Present: r.Present, Steering: r.Steering, Own: r.Own,
			SkillsManaged: r.SkillsManaged, SkillsUnmanaged: r.SkillsUnmanaged, Note: r.Note,
		}
	}
	return &wshrpc.CommandAgentSyncStatusRtnData{Harnesses: out, SteeringDoc: p.SteeringDoc, SkillsRoot: p.SkillsRoot}, nil
}

func (ws *WshServer) AgentSyncApplyCommand(ctx context.Context, data wshrpc.CommandAgentSyncApplyData) (*wshrpc.CommandAgentSyncApplyRtnData, error) {
	actions, err := agentsync.Apply(agentsync.DefaultPaths(), data.DryRun)
	if err != nil {
		return nil, fmt.Errorf("syncing harness config: %w", err)
	}
	out := make([]wshrpc.AgentSyncAction, len(actions))
	for i, a := range actions {
		out[i] = wshrpc.AgentSyncAction{Kind: a.Kind, Runtime: a.Runtime, Path: a.Path, Detail: a.Detail}
	}
	return &wshrpc.CommandAgentSyncApplyRtnData{Actions: out}, nil
}

func (ws *WshServer) AgentSyncAdoptCommand(ctx context.Context, data wshrpc.CommandAgentSyncAdoptData) (*wshrpc.CommandAgentSyncAdoptRtnData, error) {
	plan, err := agentsync.Adopt(agentsync.DefaultPaths(), data.Apply)
	rtn := &wshrpc.CommandAgentSyncAdoptRtnData{Unresolved: plan.Unresolved}
	for _, m := range plan.Moves {
		rtn.Moves = append(rtn.Moves, wshrpc.AgentSyncSkillMove{
			Runtime: m.Runtime, Name: m.Name, From: m.From, Seed: m.Seed,
			Keys: m.Keys, Files: m.Files, BodyDiff: m.BodyDiff,
		})
	}
	if err != nil {
		// a partial plan is data the caller must see, not just an error string
		return rtn, fmt.Errorf("adopting harness skills: %w", err)
	}
	return rtn, nil
}

func (ws *WshServer) AgentSyncSteeringReadCommand(ctx context.Context) (*wshrpc.CommandAgentSyncSteeringReadRtnData, error) {
	path := agentsync.DefaultPaths().SteeringDoc
	content, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("reading the shared steering doc: %w", err)
	}
	var mtime int64
	if st, statErr := os.Stat(path); statErr == nil {
		mtime = st.ModTime().UnixMilli()
	}
	return &wshrpc.CommandAgentSyncSteeringReadRtnData{Path: path, Content: string(content), Mtime: mtime}, nil
}

func (ws *WshServer) AgentSyncSteeringWriteCommand(ctx context.Context, data wshrpc.CommandAgentSyncSteeringWriteData) (*wshrpc.CommandAgentSyncSteeringWriteRtnData, error) {
	res, err := agentsync.WriteSteering(agentsync.DefaultPaths(), data.Content, data.BaseMtime)
	if err != nil {
		return nil, fmt.Errorf("writing the shared steering doc: %w", err)
	}
	return &wshrpc.CommandAgentSyncSteeringWriteRtnData{Mtime: res.Mtime, Conflict: res.Conflict}, nil
}

func (ws *WshServer) AgentSyncHarnessReadCommand(ctx context.Context, data wshrpc.CommandAgentSyncHarnessReadData) (*wshrpc.CommandAgentSyncHarnessReadRtnData, error) {
	doc, err := agentsync.ReadHarness(agentsync.DefaultPaths(), data.Runtime)
	if err != nil {
		return nil, fmt.Errorf("reading the %s steering file: %w", data.Runtime, err)
	}
	return &wshrpc.CommandAgentSyncHarnessReadRtnData{
		Runtime: doc.Runtime, Path: doc.Path, Present: doc.Present, Own: doc.Own, Shared: doc.Shared,
		Memory: doc.Memory, State: doc.State, Mtime: doc.Mtime, Carried: doc.Carried,
	}, nil
}

func (ws *WshServer) AgentSyncHarnessWriteCommand(ctx context.Context, data wshrpc.CommandAgentSyncHarnessWriteData) (*wshrpc.CommandAgentSyncHarnessWriteRtnData, error) {
	res, err := agentsync.WriteHarnessOwn(agentsync.DefaultPaths(), data.Runtime, data.Own, data.BaseMtime)
	if err != nil {
		return nil, fmt.Errorf("writing the %s steering file: %w", data.Runtime, err)
	}
	return &wshrpc.CommandAgentSyncHarnessWriteRtnData{Mtime: res.Mtime, Conflict: res.Conflict}, nil
}

func (ws *WshServer) AgentSyncFoldCommand(ctx context.Context, data wshrpc.CommandAgentSyncFoldData) (*wshrpc.CommandAgentSyncFoldRtnData, error) {
	res, err := agentsync.FoldIntoShared(agentsync.DefaultPaths(), data.Runtime)
	if err != nil {
		return nil, fmt.Errorf("folding %s into the shared doc: %w", data.Runtime, err)
	}
	return &wshrpc.CommandAgentSyncFoldRtnData{Runtime: res.Runtime, Lines: res.Lines, Seeded: res.Seeded}, nil
}

func (ws *WshServer) AgentSyncSkillsCommand(ctx context.Context) (*wshrpc.CommandAgentSyncSkillsRtnData, error) {
	p := agentsync.DefaultPaths()
	rows, err := agentsync.SkillRows(p)
	if err != nil {
		return nil, fmt.Errorf("reading canonical skills: %w", err)
	}
	out := make([]wshrpc.AgentSyncSkill, len(rows))
	for i, r := range rows {
		out[i] = wshrpc.AgentSyncSkill{Name: r.Name, Description: r.Description, States: r.States, Deltas: r.Deltas}
	}
	cols := make([]wshrpc.AgentSyncSkillColumn, 0)
	for _, c := range agentsync.SkillColumns(p) {
		cols = append(cols, wshrpc.AgentSyncSkillColumn{Runtime: c.Runtime, Label: c.Label, Present: c.Present})
	}
	return &wshrpc.CommandAgentSyncSkillsRtnData{Skills: out, Columns: cols, SkillsRoot: p.SkillsRoot}, nil
}
