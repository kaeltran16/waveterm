// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/jarvisproactive"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// RecallProducer reads the suggestion jarvisproactive already judged and persisted at dispatch. It adds
// no embedding query and no model call: both already ran. The function fields are seams so tests supply
// a run without a store.
type RecallProducer struct {
	loadRun      func(ctx context.Context, channelID, runID string) (*waveobj.Run, error)
	parentRecord func(ctx context.Context, decisionID string) string
}

func NewRecallProducer() *RecallProducer {
	return &RecallProducer{loadRun: wstore.GetRun, parentRecord: liveParentRecord}
}

func (p *RecallProducer) Name() string { return ClassRecall }

func (p *RecallProducer) Candidates(ctx context.Context, t *Trigger) ([]Candidate, error) {
	if t == nil || t.RunID == "" {
		return nil, nil
	}
	run, err := p.loadRun(ctx, t.ChannelID, t.RunID)
	if err != nil {
		return nil, fmt.Errorf("jarvisvolunteer: loading run %s: %w", t.RunID, err)
	}
	sug, ok := jarvisproactive.ReadSuggestion(run)
	if !ok || sug.Status != jarvisproactive.StatusHit {
		return nil, nil // a pending marker or a reasoned sentinel is not something to say
	}
	if run.CreatedTs == 0 {
		return nil, nil // unstampable from the fact; see Candidate's doc comment
	}
	ref, anchor := p.address(ctx, sug.SourceType, sug.NodeID)
	return []Candidate{{
		Class:      ClassRecall,
		ID:         fmt.Sprintf("recall:%s:%s", run.OID, sug.NodeID),
		At:         run.CreatedTs,
		Title:      sug.Title,
		Snippet:    sug.Snippet,
		SourceType: sug.SourceType,
		SourceRef:  ref,
		Anchor:     anchor,
	}}, nil
}

// address builds the frontend navigation address for a vault node, plus the sub-object to highlight
// within it. A decision has no surface of its own — decisionlog.tsx renders it inside its parent
// record's thread — so a decision resolves to that record and names itself as the anchor. When the
// parent cannot be resolved the ref is dropped rather than faked: an utterance with no Open button is
// better than an Open button that navigates to a dossier id that does not exist.
func (p *RecallProducer) address(ctx context.Context, sourceType, nodeID string) (ref, anchor string) {
	switch sourceType {
	case "dossier":
		return "task:" + nodeID, ""
	case "decision":
		parent := ""
		if p.parentRecord != nil {
			parent = p.parentRecord(ctx, nodeID)
		}
		if parent == "" {
			return "", ""
		}
		return "task:" + parent, nodeID
	case "memory":
		return "memnote:" + nodeID, ""
	default:
		return "", ""
	}
}

// liveParentRecord finds the dossier whose refs block wikilinks this decision. AppendDecision writes
// that link on both sides, so this is the same reverse-lookup jarvisproactive.ownDossierID uses.
// Empty on any failure — the caller drops the address rather than emitting a broken one.
func liveParentRecord(ctx context.Context, decisionID string) string {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return ""
	}
	r := v.Retriever(wavevault.Scope{Collections: []string{wavevault.CollTasks}})
	owners, err := r.Query(wavevault.Filter{HasLink: decisionID})
	if err != nil || len(owners) == 0 {
		return ""
	}
	return owners[0].ID
}
