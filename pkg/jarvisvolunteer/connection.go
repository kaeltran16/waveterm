// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"fmt"
	"sort"

	"github.com/wavetermdev/waveterm/pkg/jarvisattrib"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// ConnectionProducer reports an attribution edge that just formed on the run that reached rest. The
// three function fields are seams so tests run without a vault or a store.
type ConnectionProducer struct {
	allEdges     func(ctx context.Context) (map[string][]jarvisattrib.AttributedEdge, error)
	loadRun      func(ctx context.Context, channelID, runID string) (*waveobj.Run, error)
	dossierTitle func(ctx context.Context, dossierID string) string
}

func NewConnectionProducer() *ConnectionProducer {
	return &ConnectionProducer{
		allEdges: func(ctx context.Context) (map[string][]jarvisattrib.AttributedEdge, error) {
			v, err := wavevault.OpenVault(ctx)
			if err != nil {
				return nil, fmt.Errorf("jarvisvolunteer: opening vault: %w", err)
			}
			return jarvisattrib.AllEdges(ctx, v)
		},
		loadRun:      wstore.GetRun,
		dossierTitle: liveDossierTitle,
	}
}

func liveDossierTitle(ctx context.Context, dossierID string) string {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return dossierID
	}
	d, err := jarvisdossier.LoadDossier(v.Retriever(wavevault.Scope{Collections: []string{wavevault.CollTasks}}), dossierID)
	if err != nil || d == nil || d.Objective == "" {
		return dossierID
	}
	return d.Objective
}

func (p *ConnectionProducer) Name() string { return ClassConnection }

func (p *ConnectionProducer) Candidates(ctx context.Context, t *Trigger) ([]Candidate, error) {
	if t == nil || t.RunID == "" {
		return nil, nil
	}
	run, err := p.loadRun(ctx, t.ChannelID, t.RunID)
	if err != nil {
		return nil, fmt.Errorf("jarvisvolunteer: loading run %s: %w", t.RunID, err)
	}
	if run == nil || run.CompletedTs == 0 {
		return nil, nil // a run that has not sealed cannot be stamped from the fact
	}
	byDossier, err := p.allEdges(ctx)
	if err != nil {
		return nil, err
	}
	// AllEdges returns a map, and Go randomises map iteration. Walking dossier ids in sorted order is
	// what keeps the shortlist — and therefore the judge's prompt — the same for the same facts.
	dossierIDs := make([]string, 0, len(byDossier))
	for id := range byDossier {
		dossierIDs = append(dossierIDs, id)
	}
	sort.Strings(dossierIDs)

	wantORef := "run:" + run.OID
	var out []Candidate
	for _, dossierID := range dossierIDs {
		for _, e := range byDossier[dossierID] {
			if e.RunORef != wantORef || e.State == jarvisattrib.StateDetached {
				continue // a detached edge is a human correction, never something to volunteer
			}
			out = append(out, Candidate{
				Class:      ClassConnection,
				ID:         fmt.Sprintf("connection:%s:%s", dossierID, e.RunORef),
				At:         run.CompletedTs,
				Title:      p.dossierTitle(ctx, dossierID),
				Snippet:    connectionSnippet(run.Goal, e),
				SourceType: "dossier",
				SourceRef:  "task:" + dossierID,
			})
		}
	}
	return out, nil
}

// connectionSnippet carries the confidence bucket so the utterance can hedge: an informing layer-4
// edge is a guess, and saying it with the same certainty as a canonical dispatch reference is how a
// feature like this loses trust.
func connectionSnippet(goal string, e jarvisattrib.AttributedEdge) string {
	bucket := jarvisattrib.BucketFor(e.Layers)
	if bucket == "" {
		bucket = "unknown"
	}
	return fmt.Sprintf("%s (%s confidence, %s)", goal, bucket, e.State)
}
