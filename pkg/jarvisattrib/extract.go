// pkg/jarvisattrib/extract.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisattrib

import (
	"regexp"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// ticketRe matches a ticket-shaped identifier (e.g. PROJ-142) — used by layer-3 self-correction.
var ticketRe = regexp.MustCompile(`\b[A-Z][A-Z0-9]+-\d+\b`)

// contradictsTicket reports whether any ticket-shaped token in the commit subjects is a concrete
// ticket other than the dossier's — a signal the work belongs elsewhere. Used by layer-3 structural
// self-correction.
func contradictsTicket(dossierTicket string, commitSubjects []string) bool {
	for _, s := range commitSubjects {
		for _, m := range ticketRe.FindAllString(s, -1) {
			if !strings.EqualFold(m, dossierTicket) {
				return true
			}
		}
	}
	return false
}

// extractLayer2 fires when the dossier's ticket appears in the Run's Goal, its Channel name, or any
// commit subject in the Run's range. Deterministic, high confidence on hit.
func extractLayer2(d *jarvisdossier.Dossier, run *waveobj.Run, channelName string, commitSubjects []string) (AttributedEdge, bool) {
	if d.Ticket == "" {
		return AttributedEdge{}, false
	}
	needle := strings.ToLower(d.Ticket)
	haystacks := append([]string{run.Goal, channelName}, commitSubjects...)
	for _, h := range haystacks {
		if h != "" && strings.Contains(strings.ToLower(h), needle) {
			return AttributedEdge{
				DossierID:  d.ID,
				RunORef:    "run:" + run.OID,
				Layers:     []int{2},
				Provenance: provTicket,
				Confidence: weightLayer2,
				State:      StateInforming,
			}, true
		}
	}
	return AttributedEdge{}, false
}

// runEnd is the run's effective end: its completion, else now while it is still going. CompletedTs is set only
// when evidence is sealed, which a cancelled run never gets, so a terminal run without one ends at its creation
// (jarvisbackfill's rule) instead of reading as live forever.
func runEnd(run *waveobj.Run, now int64) int64 {
	if run.CompletedTs != 0 {
		return run.CompletedTs
	}
	if run.Status == jarvis.RunStatus_Done || run.Status == jarvis.RunStatus_Cancelled {
		return run.CreatedTs
	}
	return now
}

// windowsOverlap reports whether the run's active window intersects the dossier's. An active dossier's
// window extends to now.
func windowsOverlap(d *jarvisdossier.Dossier, run *waveobj.Run, now int64) bool {
	dEnd := d.Updated
	if d.Status == "active" {
		dEnd = now
	}
	return run.CreatedTs <= dEnd && runEnd(run, now) >= d.Created
}

// extractLayer3 fires a weak structural edge when the run is in one of the dossier's anchor repos and
// their windows overlap. Self-corrects: a concrete different ticket in the run's commits retracts it.
// Time-boxes: a never-reinforced run finished beyond the time-box decays (not returned).
func extractLayer3(d *jarvisdossier.Dossier, run *waveobj.Run, anchorPaths map[string]bool, commitSubjects []string, now int64) (AttributedEdge, bool) {
	if len(anchorPaths) == 0 || !anchorPaths[run.ProjectPath] {
		return AttributedEdge{}, false
	}
	if !windowsOverlap(d, run, now) {
		return AttributedEdge{}, false
	}
	if now-runEnd(run, now) > timeBoxMs {
		return AttributedEdge{}, false
	}
	// self-correction: a concrete different ticket in the commits contradicts.
	if contradictsTicket(d.Ticket, commitSubjects) {
		return AttributedEdge{}, false
	}
	return AttributedEdge{
		DossierID:  d.ID,
		RunORef:    "run:" + run.OID,
		Layers:     []int{3},
		Provenance: provStructural,
		Confidence: weightLayer3,
		State:      StateInforming,
	}, true
}

// edgeLookups injects the two I/O-backed resolvers assembleEdges needs, so the core stays pure and
// unit-testable. The integration layer (lifecycle.go) supplies wstore/gitinfo-backed implementations.
type edgeLookups struct {
	channelName func(channelOID string) string
	commits     func(run *waveobj.Run) []string
}

// mergeInto unions an edge into the accumulator by RunORef, recomputing confidence/provenance from the
// unioned layers and preserving a confirmed state.
func mergeInto(m map[string]AttributedEdge, e AttributedEdge) {
	cur, ok := m[e.RunORef]
	if !ok {
		cur = AttributedEdge{DossierID: e.DossierID, RunORef: e.RunORef}
	}
	cur.Layers = dedupSortLayers(append(cur.Layers, e.Layers...))
	cur.Confidence = confidenceFor(cur.Layers)
	cur.Provenance = provenanceFor(cur.Layers)
	if e.State == StateConfirmed || cur.State == StateConfirmed {
		cur.State = StateConfirmed
	} else {
		cur.State = StateInforming
	}
	m[e.RunORef] = cur
}

// worker and review children and engine stage sessions are bookkeeping, never a dossier's work.
func isLead(r *waveobj.Run) bool { return jarvis.UsageRole(r) == jarvis.UsageRole_Lead }

func runsByORef(runs []*waveobj.Run) map[string]*waveobj.Run {
	byORef := make(map[string]*waveobj.Run, len(runs))
	for _, r := range runs {
		byORef["run:"+r.OID] = r
	}
	return byORef
}

// keptRun is the layer-1 keep rule: a run in the store must be a lead run, and a run missing from the store is
// kept (its record still names it). r is nil for a missing run.
func keptRun(oref string, byORef map[string]*waveobj.Run) (r *waveobj.Run, ok bool) {
	r = byORef[oref]
	return r, r == nil || isLead(r)
}

// claimedRuns maps each run oref to the set of dossiers that claim it: a layer-1 ref assembleEdges keeps, or a
// human accept by a dossier in dossiers, less a human detach of that pair. A claimed run is no guess for any other dossier.
func claimedRuns(dossiers []*jarvisdossier.Dossier, runs []*waveobj.Run, overrides map[string]string) map[string]map[string]bool {
	byORef := runsByORef(runs)
	claims := map[string]map[string]bool{}
	claim := func(dossierID, oref string) {
		if overrides[dossierID+"|"+oref] == "detach" {
			return
		}
		if _, ok := keptRun(oref, byORef); !ok {
			return
		}
		if claims[oref] == nil {
			claims[oref] = map[string]bool{}
		}
		claims[oref][dossierID] = true
	}
	present := make(map[string]bool, len(dossiers))
	for _, d := range dossiers {
		present[d.ID] = true
		for _, ref := range d.Refs {
			if oref, ok := refToRunORef(ref); ok {
				claim(d.ID, oref)
			}
		}
	}
	for key, action := range overrides {
		if action != "accept" {
			continue
		}
		// the override log outlives a deleted record, whose accept would otherwise hide the run from every record.
		if dossierID, oref, ok := strings.Cut(key, "|"); ok && present[dossierID] {
			claim(dossierID, oref)
		}
	}
	return claims
}

// assembleEdges builds the merged dossier->Run edge set: layer-1 canonical refs (confirmed) plus the
// layer-2/3 extractors over candidate runs, deduped by run and ordered by confidence descending.
func assembleEdges(d *jarvisdossier.Dossier, runs []*waveobj.Run, lk edgeLookups, now int64) []AttributedEdge {
	byORef := runsByORef(runs)
	m := map[string]AttributedEdge{}
	anchorPaths := map[string]bool{}
	l1 := map[string]bool{}

	// layer 1: the dossier's canonical run references (written by F at dispatch, or hardened by D).
	for _, ref := range d.Refs {
		oref, ok := refToRunORef(ref)
		if !ok {
			continue
		}
		r, ok := keptRun(oref, byORef)
		if !ok {
			continue
		}
		mergeInto(m, AttributedEdge{DossierID: d.ID, RunORef: oref, Layers: []int{1}, State: StateConfirmed})
		l1[oref] = true
		if r != nil {
			anchorPaths[r.ProjectPath] = true
		}
	}

	// layers 2 & 3 over the remaining candidate runs.
	for _, r := range runs {
		oref := "run:" + r.OID
		if l1[oref] || !isLead(r) {
			continue
		}
		subs := lk.commits(r)
		if e, ok := extractLayer2(d, r, lk.channelName(r.ChannelOID), subs); ok {
			mergeInto(m, e)
		}
		if e, ok := extractLayer3(d, r, anchorPaths, subs, now); ok {
			mergeInto(m, e)
		}
	}

	out := make([]AttributedEdge, 0, len(m))
	for _, e := range m {
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Confidence > out[j].Confidence })
	return out
}
