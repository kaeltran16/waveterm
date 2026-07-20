// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memdistill"
	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) MemoryScanCommand(ctx context.Context) (*wshrpc.CommandMemoryScanRtnData, error) {
	g, err := memvault.ScanVault(memvault.VaultRoots())
	if err != nil {
		return nil, fmt.Errorf("scanning memory vault: %w", err)
	}
	notes := make([]wshrpc.MemoryNote, len(g.Notes))
	for i, n := range g.Notes {
		notes[i] = wshrpc.MemoryNote{
			ID: n.ID, Title: n.Title, Description: n.Description, Type: n.Type,
			Scope: n.Scope, Source: n.Source, Path: n.Path, Links: n.Links, UpdatedTs: n.UpdatedTs,
			Reviewed: n.Reviewed, CapturedAt: n.CapturedAt, SupersededBy: n.SupersededBy, LastReferenced: n.LastReferenced,
		}
	}
	edges := make([]wshrpc.MemoryEdge, len(g.Edges))
	for i, e := range g.Edges {
		edges[i] = wshrpc.MemoryEdge{From: e.From, To: e.To}
	}
	return &wshrpc.CommandMemoryScanRtnData{Notes: notes, Edges: edges}, nil
}

func (ws *WshServer) MemoryReadCommand(ctx context.Context, data wshrpc.CommandMemoryReadData) (*wshrpc.CommandMemoryReadRtnData, error) {
	nb, err := memvault.ReadNote(data.Path, data.Source)
	if err != nil {
		return nil, fmt.Errorf("reading note: %w", err)
	}
	n := nb.Note
	return &wshrpc.CommandMemoryReadRtnData{
		Note: wshrpc.MemoryNote{
			ID: n.ID, Title: n.Title, Description: n.Description, Type: n.Type,
			Scope: n.Scope, Source: n.Source, Path: n.Path, Links: n.Links, UpdatedTs: n.UpdatedTs,
			Reviewed: n.Reviewed, CapturedAt: n.CapturedAt, SupersededBy: n.SupersededBy, LastReferenced: n.LastReferenced,
		},
		Body: nb.Body,
	}, nil
}

func (ws *WshServer) MemoryWriteCommand(ctx context.Context, data wshrpc.CommandMemoryWriteData) (*wshrpc.CommandMemoryWriteRtnData, error) {
	res, err := memvault.WriteNote(data.Path, data.Content, data.BaseMtime)
	if err != nil {
		return nil, fmt.Errorf("writing note: %w", err)
	}
	return &wshrpc.CommandMemoryWriteRtnData{Mtime: res.Mtime, Conflict: res.Conflict}, nil
}

func (ws *WshServer) MemoryCreateCommand(ctx context.Context, data wshrpc.CommandMemoryCreateData) (*wshrpc.CommandMemoryCreateRtnData, error) {
	vaultDir := memvault.DefaultVaultPath()
	if hub := memvault.HubDirForCwd(data.Cwd); hub != "" {
		vaultDir = hub
	}
	path, err := memvault.CreateNote(vaultDir, data.Name, data.Type, data.Scope, data.Body)
	if err != nil {
		return nil, fmt.Errorf("creating note: %w", err)
	}
	return &wshrpc.CommandMemoryCreateRtnData{Path: path}, nil
}

func (ws *WshServer) MemoryDeleteCommand(ctx context.Context, data wshrpc.CommandMemoryDeleteData) error {
	if err := memvault.DeleteNote(data.Path); err != nil {
		return fmt.Errorf("deleting note: %w", err)
	}
	return nil
}

func (ws *WshServer) MemoryProjectCommand(ctx context.Context, data wshrpc.CommandMemoryProjectData) error {
	if err := memvault.Project(data.Cwd); err != nil {
		return fmt.Errorf("projecting memory: %w", err)
	}
	return nil
}

func (ws *WshServer) MemoryProjectionStatusCommand(ctx context.Context) (*wshrpc.CommandMemoryProjectionStatusRtnData, error) {
	return &wshrpc.CommandMemoryProjectionStatusRtnData{Runtimes: memvault.ProjectionStatus()}, nil
}

func (ws *WshServer) MemoryHarvestCommand(ctx context.Context, data wshrpc.CommandMemoryHarvestData) (*wshrpc.CommandMemoryHarvestRtnData, error) {
	ingested, skipped, err := memvault.Harvest(data.Cwd)
	if err != nil {
		return nil, fmt.Errorf("harvesting memory: %w", err)
	}
	return &wshrpc.CommandMemoryHarvestRtnData{Ingested: ingested, Skipped: skipped}, nil
}

func (ws *WshServer) MemoryLearnCommand(ctx context.Context, data wshrpc.CommandMemoryLearnData) (*wshrpc.CommandMemoryLearnRtnData, error) {
	cands := make([]memvault.LearnCandidate, len(data.Candidates))
	for i, c := range data.Candidates {
		cands[i] = memvault.LearnCandidate{Type: c.Type, Scope: c.Scope, Body: c.Body, IsCorrection: c.IsCorrection, Supersedes: c.Supersedes}
	}
	committed, queued, err := memvault.RouteLearnings(data.Cwd, cands, data.References)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandMemoryLearnRtnData{Committed: committed, Queued: queued}, nil
}

func (ws *WshServer) MemoryEnqueueSessionCommand(ctx context.Context, data wshrpc.CommandMemoryEnqueueSessionData) error {
	// real recall telemetry: stamp last_referenced from what the finished session actually recalled.
	memvault.RecordRecall(data.Cwd, data.TranscriptPath, time.Now())
	memdistill.Enqueue(data.Cwd, data.TranscriptPath, data.ClaudePath)
	return nil
}

func (ws *WshServer) MemoryReviewListCommand(ctx context.Context) (*wshrpc.CommandMemoryReviewListRtnData, error) {
	pns := memvault.ListPending(memvault.PendingDir())
	out := make([]wshrpc.MemoryPendingNote, len(pns))
	for i, p := range pns {
		out[i] = wshrpc.MemoryPendingNote{
			Path:       p.Path,
			Title:      p.Title,
			Type:       p.Type,
			Scope:      p.Scope,
			Source:     p.Source,
			Body:       p.Body,
			Cwd:        p.Cwd,
			CapturedAt: p.CapturedAt,
		}
	}
	return &wshrpc.CommandMemoryReviewListRtnData{Pending: out}, nil
}

func (ws *WshServer) MemoryReviewAcceptCommand(ctx context.Context, data wshrpc.CommandMemoryReviewAcceptData) error {
	if _, err := memvault.AcceptPending(data.Path); err != nil {
		return fmt.Errorf("accepting candidate: %w", err)
	}
	return nil
}

func (ws *WshServer) MemoryPruneListCommand(ctx context.Context) (*wshrpc.CommandMemoryPruneListRtnData, error) {
	cands := memvault.PruneCandidates(time.Now().UTC())
	out := make([]wshrpc.MemoryPruneCandidate, len(cands))
	for i, c := range cands {
		out[i] = wshrpc.MemoryPruneCandidate{ID: c.ID, Title: c.Title, Reason: c.Reason, Path: c.Path}
	}
	return &wshrpc.CommandMemoryPruneListRtnData{Candidates: out}, nil
}

func (ws *WshServer) MemoryArchiveListCommand(ctx context.Context) (*wshrpc.CommandMemoryArchiveListRtnData, error) {
	ans := memvault.ListArchived()
	out := make([]wshrpc.MemoryArchivedNote, len(ans))
	for i, a := range ans {
		out[i] = wshrpc.MemoryArchivedNote{
			ID: a.ID, Title: a.Title, Reason: a.Reason, ArchivedAt: a.ArchivedAt, Path: a.Path, OriginHub: a.OriginHub,
		}
	}
	return &wshrpc.CommandMemoryArchiveListRtnData{Archived: out}, nil
}

func (ws *WshServer) MemoryRestoreCommand(ctx context.Context, data wshrpc.CommandMemoryRestoreData) error {
	if _, err := memvault.Restore(data.Path); err != nil {
		return fmt.Errorf("restoring archived note: %w", err)
	}
	return nil
}
