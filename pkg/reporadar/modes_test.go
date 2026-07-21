// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestCandidatesForModeCorrectnessReturnsAll(t *testing.T) {
	sigs := []waveobj.RadarSignal{
		newSignal(CollectorGit, "commit:1", 1, []string{"a.go"}, "x", nil, ""),
		newSignal(CollectorStructure, "struct:no-test:b.go", 2, []string{"b.go"}, "y", nil, ""),
	}
	got := candidatesForMode(ModeCorrectness, sigs)
	if len(got) != len(sigs) {
		t.Fatalf("correctness selector must return all signals, got %d of %d", len(got), len(sigs))
	}
}

func TestAdmissibleForModeCorrectness(t *testing.T) {
	// one weak structure signal, no explicit failure => not admissible (today's rule).
	weak := []waveobj.RadarSignal{newSignal(CollectorStructure, "struct:no-test:b.go", 2, []string{"b.go"}, "y", nil, "")}
	if admissibleForMode(ModeCorrectness, weak, StrengthLimited) {
		t.Fatal("a single weak structure signal must be withheld for correctness")
	}
	// one runs signal (explicit failure) => admissible even at limited strength.
	fail := []waveobj.RadarSignal{newSignal(CollectorRuns, "run:1:phase:0", 2, []string{"b.go"}, "failed", nil, "")}
	if !admissibleForMode(ModeCorrectness, fail, StrengthLimited) {
		t.Fatal("an explicit failure must be admissible for correctness")
	}
}

func TestModeTaskLineDefaultsToCorrectness(t *testing.T) {
	if got := modeTaskLine(ModeCorrectness); got == "" {
		t.Fatal("correctness task line must be non-empty")
	}
}
