// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"os"

	"github.com/wavetermdev/waveterm/pkg/agentsync"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// defaultPaths is a seam: tests point the agentsync RPCs at a temp home.
var defaultPaths = agentsync.DefaultPaths

func (ws *WshServer) AgentSyncStatusCommand(ctx context.Context) (*wshrpc.CommandAgentSyncStatusRtnData, error) {
	p := defaultPaths()
	rows, err := agentsync.Status(p)
	if err != nil {
		return nil, fmt.Errorf("reading harness sync status: %w", err)
	}
	out := make([]wshrpc.AgentSyncHarness, len(rows))
	for i, r := range rows {
		out[i] = wshrpc.AgentSyncHarness{
			Runtime: r.Runtime, Label: r.Label, Present: r.Present, Path: r.Path, Steering: r.Steering,
			SkillsManaged: r.SkillsManaged, SkillsUnmanaged: r.SkillsUnmanaged, Note: r.Note, NoteTone: r.NoteTone,
		}
	}
	return &wshrpc.CommandAgentSyncStatusRtnData{Harnesses: out, SteeringDoc: p.SteeringDoc, SkillsRoot: p.SkillsRoot}, nil
}

func (ws *WshServer) AgentSyncApplyCommand(ctx context.Context, data wshrpc.CommandAgentSyncApplyData) (*wshrpc.CommandAgentSyncApplyRtnData, error) {
	// a snapshot's vault is a copy, and applying it would write the harness homes the user's real agents read
	actions, err := agentsync.Apply(defaultPaths(), data.DryRun || wavebase.IsSnapshot())
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
	// adopting moves skills out of the real harness homes, which a snapshot must leave alone
	snapshot := wavebase.IsSnapshot()
	plan, err := agentsync.Adopt(defaultPaths(), data.Apply && !snapshot, data.Keep, data.Skip)
	rtn := &wshrpc.CommandAgentSyncAdoptRtnData{
		Moves: skillMoves(plan.Moves), Unresolved: plan.Unresolved, DryRun: data.Apply && snapshot,
	}
	if err != nil {
		// a partial plan is data the caller must see, not just an error string
		return rtn, fmt.Errorf("adopting harness skills: %w", err)
	}
	return rtn, nil
}

func (ws *WshServer) AgentSyncSteeringReadCommand(ctx context.Context) (*wshrpc.CommandAgentSyncSteeringReadRtnData, error) {
	path := defaultPaths().SteeringDoc
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
	res, err := agentsync.WriteSteering(defaultPaths(), data.Content, data.BaseMtime)
	if err != nil {
		return nil, fmt.Errorf("writing the shared steering doc: %w", err)
	}
	return &wshrpc.CommandAgentSyncSteeringWriteRtnData{Mtime: res.Mtime, Conflict: res.Conflict}, nil
}

func skillMoves(moves []agentsync.SkillMove) []wshrpc.AgentSyncSkillMove {
	out := make([]wshrpc.AgentSyncSkillMove, 0, len(moves))
	for _, m := range moves {
		out = append(out, wshrpc.AgentSyncSkillMove{
			Runtime: m.Runtime, Name: m.Name, From: m.From, Seed: m.Seed,
			Keys: m.Keys, Files: m.Files, BodyDiff: m.BodyDiff, Vault: m.Vault,
		})
	}
	return out
}

func (ws *WshServer) AgentSyncSkillsCommand(ctx context.Context) (*wshrpc.CommandAgentSyncSkillsRtnData, error) {
	p := defaultPaths()
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
	plan, err := agentsync.PlanAdopt(p, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("planning skill adoption: %w", err)
	}
	links, err := agentsync.SkillLinks(p)
	if err != nil {
		return nil, fmt.Errorf("listing linked skills: %w", err)
	}
	linked := make([]wshrpc.AgentSyncSkillLink, 0, len(links))
	for _, l := range links {
		linked = append(linked, wshrpc.AgentSyncSkillLink{Runtime: l.Runtime, Name: l.Name, Path: l.Path, Target: l.Target})
	}
	unresolved := plan.Unresolved
	if unresolved == nil {
		unresolved = []string{}
	}
	return &wshrpc.CommandAgentSyncSkillsRtnData{
		Skills: out, Columns: cols, SkillsRoot: p.SkillsRoot,
		Unmanaged: skillMoves(plan.Moves), Unresolved: unresolved, Linked: linked,
	}, nil
}
