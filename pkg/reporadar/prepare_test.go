// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestEstimateTokens(t *testing.T) {
	// ~4 chars per token heuristic
	if got := estimateTokens(strings.Repeat("x", 400)); got < 90 || got > 110 {
		t.Fatalf("estimateTokens(400 chars) = %d, want ~100", got)
	}
}

func TestPreparePacksWithinBudget(t *testing.T) {
	var sigs []waveobj.RadarSignal
	for i := 0; i < 50; i++ {
		s := newSignal(CollectorGit, "commit:"+strings.Repeat("a", i+1), int64(i),
			[]string{"src/x.ts"}, strings.Repeat("word ", 200), nil, "")
		sigs = append(sigs, s)
	}
	groups, tokens := prepareCandidates(sigs, 2000)
	if tokens > 2000 {
		t.Fatalf("payload %d exceeds budget", tokens)
	}
	if len(groups) == 0 {
		t.Fatal("expected at least one packed group")
	}
}

func TestPrepareRanksMultiSourceHigher(t *testing.T) {
	weak := newSignal(CollectorStructure, "struct:no-test:src/a.ts", 1, []string{"src/coupons/a.ts"}, "no test", nil, "")
	// two signals over the same subsystem from different sources rank above one isolated signal
	g1 := newSignal(CollectorGit, "commit:1", 2, []string{"src/coupons/a.ts"}, "changed", nil, "")
	g2 := newSignal(CollectorRuns, "run:1:phase:0", 3, []string{"src/coupons/a.ts"}, "failed phase", nil, "")
	groups, _ := prepareCandidates([]waveobj.RadarSignal{weak, g1, g2}, DefaultRadarPayloadBudget)
	if len(groups) == 0 || groups[0].Subsystem != "src/coupons" {
		t.Fatalf("expected coupons group first, got %+v", groups)
	}
	if groups[0].SourceCount < 2 {
		t.Fatalf("top group should span >=2 sources, got %d", groups[0].SourceCount)
	}
}
