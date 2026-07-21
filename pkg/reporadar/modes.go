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
	default:
		return !(strength == StrengthLimited && !hasExplicitFailure(supporting))
	}
}

// modeTaskLine is the mode-specific task framing spliced into the synthesis prompt. Lens plans add
// their cases; the default is the correctness framing.
func modeTaskLine(mode string) string {
	switch mode {
	default:
		return "propose correctness-risk hypotheses"
	}
}
