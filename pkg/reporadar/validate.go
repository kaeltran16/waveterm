// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"sort"

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
	seenFP := map[string]bool{}
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
		if seenFP[fp] {
			continue // duplicate within this report
		}
		seenFP[fp] = true
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

// subsystemForSignals derives the canonical subsystem from all referenced signals' paths.
func subsystemForSignals(sigs []waveobj.RadarSignal) string {
	var paths []string
	for _, s := range sigs {
		paths = append(paths, s.Paths...)
	}
	return subsystemForPaths(paths)
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
