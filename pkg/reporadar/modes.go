// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import "github.com/wavetermdev/waveterm/pkg/waveobj"

// This file holds the per-mode seams a scan is parameterized by. Correctness is implemented here; the
// security and tech-debt lenses register their own selector / predicate / framing in their plans.

// candidatesForMode selects, from the shared signal pool, the signals a given mode should cluster over.
// Correctness clusters over every signal (its v1 behavior). A mode with no registered selector falls
// back to the full pool.
func candidatesForMode(mode string, sigs []waveobj.RadarSignal) []waveobj.RadarSignal {
	switch mode {
	case ModeCorrectness:
		return sigs
	case ModeSecurity:
		return candidatesForSecurity(sigs)
	default:
		return sigs
	}
}

// admissibleForMode is the per-mode admissibility gate applied after the shared validation checks
// (signals exist, files covered, subsystem resolves). It returns false to withhold a finding.
// Correctness reproduces today's rule: withhold a single weak signal with no explicit failure.
func admissibleForMode(mode string, supporting []waveobj.RadarSignal, strength string) bool {
	switch mode {
	case ModeCorrectness:
		return !(strength == StrengthLimited && !hasExplicitFailure(supporting))
	case ModeSecurity:
		return admissibleForSecurity(supporting)
	default:
		return !(strength == StrengthLimited && !hasExplicitFailure(supporting))
	}
}

// modeTaskLine is the mode-specific task framing spliced into the synthesis prompt. Lens plans add
// their cases; the default is the correctness framing.
func modeTaskLine(mode string) string {
	switch mode {
	case ModeSecurity:
		return "propose security-risk hypotheses — exploitable boundary fragility grounded in the evidence, never speculative vulnerabilities"
	default:
		return "propose correctness-risk hypotheses"
	}
}

// candidatesForSecurity narrows the shared pool to what the security lens clusters over: the
// security-classified signals (boundaries + self-sufficient facts) plus the churn/failure signals that
// can be their consequence. Correctness-only noise (plain no-test structure facts, memory) is dropped.
func candidatesForSecurity(sigs []waveobj.RadarSignal) []waveobj.RadarSignal {
	var out []waveobj.RadarSignal
	for _, s := range sigs {
		if isSecurityClassified(s) || isSecurityConsequence(s) {
			out = append(out, s)
		}
	}
	return out
}

// admissibleForSecurity enforces the security trust gate: a finding must cite BOTH a security-boundary
// classification AND a consequence signal. A config-security or dependency-pin fact satisfies both on
// its own (it is a standing security fact); a structure security boundary needs a separate churn/failure
// consequence — a boundary that never changed and never failed is not fragile.
func admissibleForSecurity(supporting []waveobj.RadarSignal) bool {
	hasBoundary, hasConsequence := false, false
	for _, s := range supporting {
		if isSecurityClassified(s) {
			hasBoundary = true
		}
		if isSecurityConsequence(s) {
			hasConsequence = true
		}
	}
	return hasBoundary && hasConsequence
}
