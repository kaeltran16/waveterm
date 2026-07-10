// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func sig(collector, ref string) waveobj.RadarSignal {
	return newSignal(collector, ref, 1, []string{"src/coupons/a.ts"}, "s", nil, "")
}

func TestEvidenceStrength(t *testing.T) {
	strong := evidenceStrength([]waveobj.RadarSignal{sig(CollectorGit, "1"), sig(CollectorRuns, "2"), sig(CollectorTranscript, "3")})
	if strong != StrengthStrong {
		t.Fatalf("3 independent sources => strong, got %q", strong)
	}
	moderate := evidenceStrength([]waveobj.RadarSignal{sig(CollectorGit, "1"), sig(CollectorGit, "2")})
	if moderate != StrengthModerate {
		t.Fatalf("multiple signals one source => moderate, got %q", moderate)
	}
	limited := evidenceStrength([]waveobj.RadarSignal{sig(CollectorStructure, "1")})
	if limited != StrengthLimited {
		t.Fatalf("single non-failure signal => limited, got %q", limited)
	}
}
