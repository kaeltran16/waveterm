// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// fingerprint is the stable cross-scan identity of a risk pattern. It hashes project + risk kind +
// the DETERMINISTIC canonical subsystem — never the model's title or advisory boundary label — so
// New/Recurring/Suppressed matching cannot drift when the model rephrases a boundary.
func fingerprint(projectPath, riskKind, subsystem string) string {
	return "RAD-" + shortHash(canonPath(projectPath)+"\x00"+riskKind+"\x00"+subsystem)[:8]
}

// evidenceStrength is computed from canonical independent sources — never model-controlled.
//   Strong:   corroborated across >=2 independent source categories with >=3 signals.
//   Moderate: multiple canonical signals (>=2), fewer independent categories.
//   Limited:  one signal / one explicit failure.
func evidenceStrength(sigs []waveobj.RadarSignal) string {
	sources := distinctCollectors(sigs)
	switch {
	case sources >= 2 && len(sigs) >= 3:
		return StrengthStrong
	case len(sigs) >= 2:
		return StrengthModerate
	default:
		return StrengthLimited
	}
}

// validateFindings rejects model findings that fail the deterministic checks, derives the
// canonical subsystem + fingerprint + evidence strength for the survivors, dedups within the
// report, and enforces the ten-finding cap with a deterministic keep-order. byID maps signal ID ->
// canonical signal for the current report.
func validateFindings(projectPath, mode string, resp *SynthResponse, byID map[string]waveobj.RadarSignal) []waveobj.RadarFinding {
	var out []waveobj.RadarFinding
	indexByFP := map[string]int{}
	for _, sf := range resp.Findings {
		if !ValidRiskKind(mode, sf.RiskKind) {
			continue
		}
		var supporting []waveobj.RadarSignal
		ok := len(sf.SignalIDs) > 0
		for _, id := range sf.SignalIDs {
			s, exists := byID[id]
			if !exists {
				ok = false
				break
			}
			supporting = append(supporting, s)
		}
		if !ok {
			continue // references a signal that doesn't exist
		}
		if !filesCoveredBySignals(sf.Files, supporting) {
			continue // references a file absent from its signals
		}
		subsystem := subsystemForSignals(supporting)
		if subsystem == "unknown" {
			continue // scope does not resolve from the referenced signals' paths
		}
		strength := evidenceStrength(supporting)
		if !admissibleForMode(mode, supporting, strength) {
			continue // fails this mode's admissibility gate
		}
		fp := fingerprint(projectPath, sf.RiskKind, subsystem)
		if i, seen := indexByFP[fp]; seen {
			// two proposals with one identity are one risk; dropping the second would lose its evidence
			mergeFinding(&out[i], sf, byID)
			continue
		}
		indexByFP[fp] = len(out)
		// ID is stamped once on the merged+reconciled set (see assignFindingIDs) — a per-lens index
		// here collides once lenses merge, and with findings carried forward from the prior report.
		out = append(out, waveobj.RadarFinding{
			Fingerprint:   fp,
			Group:         GroupNew, // Phase F reclassifies against the previous report
			Mode:          mode,
			RiskKind:      sf.RiskKind,
			Subsystem:     subsystem,
			BoundaryLabel: sf.BoundaryLabel,
			Risk:          sf.Risk,
			Why:           sf.Why,
			Severity:      normalizeSeverity(sf.Severity),
			Strength:      strength,
			SignalIDs:     sf.SignalIDs,
			Files:         sf.Files,
			Mission:       sf.Mission,
		})
	}
	return capFindings(out)
}

func filesCoveredBySignals(files []string, sigs []waveobj.RadarSignal) bool {
	set := map[string]bool{}
	for _, s := range sigs {
		for _, p := range s.Paths {
			set[canonPath(p)] = true
		}
	}
	for _, f := range files {
		if !set[canonPath(f)] {
			return false
		}
	}
	return true
}

// mergeFinding folds a same-fingerprint proposal into an accepted finding: evidence and files are
// unioned, severity takes the higher of the two, and strength is recomputed from the union.
func mergeFinding(f *waveobj.RadarFinding, sf SynthFinding, byID map[string]waveobj.RadarSignal) {
	for _, id := range sf.SignalIDs {
		f.SignalIDs = appendUnique(f.SignalIDs, id)
	}
	for _, file := range sf.Files {
		f.Files = appendUnique(f.Files, file)
	}
	if sev := normalizeSeverity(sf.Severity); severityRank[sev] > severityRank[f.Severity] {
		f.Severity = sev
	}
	var supporting []waveobj.RadarSignal
	for _, id := range f.SignalIDs {
		supporting = append(supporting, byID[id])
	}
	f.Strength = evidenceStrength(supporting)
}

// subsystemForSignals picks the subsystem most cited signals sit in. A common prefix over every path let
// one wide signal (a session touching many directories) collapse a finding's identity to the repo root,
// so unrelated risks shared a fingerprint. Signals whose own paths already span directories abstain;
// when every signal abstains the common prefix is the only honest answer.
func subsystemForSignals(sigs []waveobj.RadarSignal) string {
	votes := map[string]int{}
	var all []string
	for _, s := range sigs {
		all = append(all, s.Paths...)
		sub := subsystemForPaths(s.Paths)
		if sub == "unknown" || (sub == "." && spansDirectories(s.Paths)) {
			continue
		}
		votes[sub]++
	}
	if len(votes) == 0 {
		return subsystemForPaths(all)
	}
	best := ""
	for sub, n := range votes {
		if best == "" || preferSubsystem(sub, n, best, votes[best]) {
			best = sub
		}
	}
	return best
}

// preferSubsystem orders vote winners deterministically: more votes, then a named directory over the
// root, then the more specific directory, then lexical order.
func preferSubsystem(a string, aVotes int, b string, bVotes int) bool {
	if aVotes != bVotes {
		return aVotes > bVotes
	}
	if (a == ".") != (b == ".") {
		return b == "."
	}
	if da, db := strings.Count(a, "/"), strings.Count(b, "/"); da != db {
		return da > db
	}
	return a < b
}

func spansDirectories(paths []string) bool {
	for _, p := range paths {
		if subsystemForPaths([]string{p}) != "." {
			return true
		}
	}
	return false
}

func normalizeSeverity(s string) string {
	switch s {
	case SeverityHigh, SeverityMedium, SeverityLow:
		return s
	default:
		return SeverityMedium
	}
}

var severityRank = map[string]int{SeverityHigh: 3, SeverityMedium: 2, SeverityLow: 1}
var strengthRank = map[string]int{StrengthStrong: 3, StrengthModerate: 2, StrengthLimited: 1}

// capFindings keeps the top MaxFindings by severity, then evidence strength, then most-recent
// evidence, breaking ties by fingerprint for determinism.
func capFindings(findings []waveobj.RadarFinding) []waveobj.RadarFinding {
	sort.SliceStable(findings, func(i, j int) bool {
		if severityRank[findings[i].Severity] != severityRank[findings[j].Severity] {
			return severityRank[findings[i].Severity] > severityRank[findings[j].Severity]
		}
		if strengthRank[findings[i].Strength] != strengthRank[findings[j].Strength] {
			return strengthRank[findings[i].Strength] > strengthRank[findings[j].Strength]
		}
		return findings[i].Fingerprint < findings[j].Fingerprint
	})
	if len(findings) > MaxFindings {
		findings = findings[:MaxFindings]
	}
	return findings
}
