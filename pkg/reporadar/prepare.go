// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"sort"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// CandidateGroup is a subsystem-scoped cluster of signals handed to the model. SourceCount is the
// number of distinct collectors contributing — the deterministic ranking signal.
type CandidateGroup struct {
	Subsystem   string                `json:"subsystem"`
	Signals     []waveobj.RadarSignal `json:"signals"`
	SourceCount int                   `json:"sourcecount"`
	latestTs    int64
}

// estimateTokens approximates token count as ceil(chars/4). Deliberately conservative; the payload
// budget is an estimate, not a hard provider cap.
func estimateTokens(s string) int {
	return (len(s) + 3) / 4
}

func signalTokens(s waveobj.RadarSignal) int {
	total := estimateTokens(s.Summary) + estimateTokens(s.Snippet) + estimateTokens(s.SourceRef)
	for _, p := range s.Paths {
		total += estimateTokens(p)
	}
	return total + 8 // per-signal structural overhead
}

// prepareCandidates groups signals by deterministic subsystem, ranks groups by (source diversity,
// recency), drops single-weak groups (one signal, no explicit failure), and packs groups until the
// estimated token budget is reached. Returns the packed groups and their estimated token total.
func prepareCandidates(sigs []waveobj.RadarSignal, budget int) ([]CandidateGroup, int) {
	byic := map[string]*CandidateGroup{}
	for _, s := range sigs {
		sub := s.Subsystem
		if sub == "" {
			sub = subsystemForPaths(s.Paths)
		}
		g := byic[sub]
		if g == nil {
			g = &CandidateGroup{Subsystem: sub}
			byic[sub] = g
		}
		g.Signals = append(g.Signals, s)
		if s.ObservedTs > g.latestTs {
			g.latestTs = s.ObservedTs
		}
	}
	var groups []CandidateGroup
	for _, g := range byic {
		g.SourceCount = distinctCollectors(g.Signals)
		if len(g.Signals) == 1 && !hasExplicitFailure(g.Signals) {
			continue // drop unchanged isolated low-value fact
		}
		groups = append(groups, *g)
	}
	sort.SliceStable(groups, func(i, j int) bool {
		if groups[i].SourceCount != groups[j].SourceCount {
			return groups[i].SourceCount > groups[j].SourceCount
		}
		if groups[i].latestTs != groups[j].latestTs {
			return groups[i].latestTs > groups[j].latestTs
		}
		return groups[i].Subsystem < groups[j].Subsystem
	})
	var packed []CandidateGroup
	total := 0
	for _, g := range groups {
		// pack this ranked group's signals up to the remaining budget. Truncating (rather than
		// dropping the whole group) matters: the busiest subsystem has the most tokens and would
		// otherwise be silently dropped in full — exactly the area the model should see.
		var fit []waveobj.RadarSignal
		gt := 0
		for _, s := range g.Signals {
			st := signalTokens(s)
			if total+gt+st > budget {
				break
			}
			fit = append(fit, s)
			gt += st
		}
		if len(fit) == 0 {
			continue // not even one signal fits in the remaining budget; try smaller groups
		}
		ng := g
		ng.Signals = fit
		ng.SourceCount = distinctCollectors(fit) // reflect the truncated reality, not the full group
		total += gt
		packed = append(packed, ng)
	}
	return packed, total
}

func distinctCollectors(sigs []waveobj.RadarSignal) int {
	set := map[string]bool{}
	for _, s := range sigs {
		set[s.Collector] = true
	}
	return len(set)
}

// hasExplicitFailure reports whether any signal represents a concrete failure (a run/transcript
// error), which justifies surfacing even a single-signal group.
func hasExplicitFailure(sigs []waveobj.RadarSignal) bool {
	for _, s := range sigs {
		if s.Collector == CollectorRuns || s.Collector == CollectorTranscript {
			return true
		}
	}
	return false
}
