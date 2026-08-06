// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// stalenessMs is how long a non-terminal dossier may go untouched before it is a loose end.
//
// MEASURED 2026-08-06 against the real vault (C:\Users\kael02\.waveterm\vault\tasks, 24 dossiers, all
// carrying an `updated` frontmatter stamp). Of those, 5 are non-terminal (4 active, 1 paused) with
// last-touched ages of 0, 2.7, 9.8, 9.8 and 14.9 days — median 9.8. Trip counts at candidate
// thresholds: 7 days flags 3 of 5, 10 days flags 1, 14 days flags 1, 21 days flags 0.
//
// Chosen at 14 days because it sits above the observed median, so ordinary in-progress work (a dossier
// touched a week or so ago is routine here) does not trip it, while still catching the 14.9-day tail.
// 7 days would have called 60% of open work "going quiet"; 21 days would never have fired on this
// corpus at all. Re-measure if the vault grows substantially — a constant that cannot say where it came
// from is the defect J5 tracks (docs/jarvis-second-brain-open-issues.md).
const stalenessMs int64 = 14 * 24 * 60 * 60 * 1000

// resurfaceBucketMs quantises a dossier's Updated stamp so an unchanged dossier keeps producing a
// byte-identical (At, ID) pair, which the frontend watermark then discards. It is what makes say-once
// work without a server-side said-log. A loose end therefore becomes eligible to speak again only once
// the dossier is actually touched and its stamp crosses into a new bucket — not merely with the passage
// of time. MUST be coarser than stalenessMs, or a resumed dossier could re-fire before it has gone
// stale again; asserted in looseend_test.go.
const resurfaceBucketMs int64 = 30 * 24 * 60 * 60 * 1000

// eligibleStatuses is the non-terminal half of the dossier vocabulary written by
// jarvisdossier.SetStatus (active | paused | completed | archived). An ALLOWLIST, not a terminal
// denylist: an unrecognised or missing status stays silent, because the failure modes are asymmetric —
// a missed loose end underdelivers, a wrong interruption gets the feature switched off.
var eligibleStatuses = map[string]bool{"active": true, "paused": true}

// LooseEndProducer reports a dossier going quiet. The two function fields are seams for tests.
type LooseEndProducer struct {
	listDossiers func(ctx context.Context) ([]jarvisdossier.Dossier, error)
	now          func() int64
}

func NewLooseEndProducer() *LooseEndProducer {
	return &LooseEndProducer{listDossiers: liveDossiers, now: func() int64 { return time.Now().UnixMilli() }}
}

func liveDossiers(ctx context.Context) ([]jarvisdossier.Dossier, error) {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("jarvisvolunteer: opening vault: %w", err)
	}
	r := v.Retriever(wavevault.Scope{Collections: []string{wavevault.CollTasks}})
	nodes, err := r.Query(wavevault.Filter{})
	if err != nil {
		return nil, fmt.Errorf("jarvisvolunteer: querying tasks: %w", err)
	}
	var out []jarvisdossier.Dossier
	for _, n := range nodes {
		d, err := jarvisdossier.LoadDossier(r, n.ID)
		if err != nil || d == nil {
			continue // tolerant, mirroring jarvisattrib.AllEdges
		}
		out = append(out, *d)
	}
	return out, nil
}

func (p *LooseEndProducer) Name() string { return ClassLooseEnd }

func (p *LooseEndProducer) Candidates(ctx context.Context, _ *Trigger) ([]Candidate, error) {
	ds, err := p.listDossiers(ctx)
	if err != nil {
		return nil, err
	}
	now := p.now()
	var out []Candidate
	for _, d := range ds {
		if !eligibleStatuses[d.Status] || d.Updated == 0 {
			continue
		}
		stale := now-d.Updated >= stalenessMs
		if !stale && len(d.Blockers) == 0 {
			continue
		}
		bucket := d.Updated - (d.Updated % resurfaceBucketMs)
		if bucket == 0 {
			continue // the gate's prefilter drops an At of 0; emitting one would just be silently discarded
		}
		title := d.Objective
		if title == "" {
			title = d.ID
		}
		out = append(out, Candidate{
			Class:      ClassLooseEnd,
			ID:         fmt.Sprintf("loose-end:%s:%d", d.ID, bucket),
			At:         bucket,
			Title:      title,
			Snippet:    looseEndSnippet(d, now),
			SourceType: "dossier",
			SourceRef:  "task:" + d.ID,
		})
	}
	// vault query order is not a contract, and the shortlist cap means order decides what the judge
	// ever sees; sort so the same vault yields the same shortlist
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func looseEndSnippet(d jarvisdossier.Dossier, now int64) string {
	if len(d.Blockers) > 0 {
		return fmt.Sprintf("blocked on %s", d.Blockers[0])
	}
	days := (now - d.Updated) / (24 * 60 * 60 * 1000)
	return fmt.Sprintf("untouched for %d days", days)
}
