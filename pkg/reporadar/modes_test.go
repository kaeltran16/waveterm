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

func TestCandidatesForSecurityFiltersPool(t *testing.T) {
	boundary := newSignal(CollectorStructure, "struct:security-boundary:src/auth/s.ts", 1, []string{"src/auth/s.ts"}, "b", map[string]any{"classes": []string{ClassSecurityBoundary}}, "")
	noTest := newSignal(CollectorStructure, "struct:no-test:src/x.ts", 1, []string{"src/x.ts"}, "n", map[string]any{"classes": []string{"source-without-test"}}, "")
	churn := newSignal(CollectorGit, "commit:1", 2, []string{"src/auth/s.ts"}, "c", nil, "")
	mem := newSignal(CollectorMemory, "mem:1", 3, []string{"src/auth/s.ts"}, "m", nil, "")
	dep := newSignal(CollectorDependency, "dep:floating:package.json:jsonwebtoken", 1, []string{"package.json"}, "d", map[string]any{"classes": []string{ClassDependencyPin}}, "")

	got := candidatesForMode(ModeSecurity, []waveobj.RadarSignal{boundary, noTest, churn, mem, dep})
	kept := map[string]bool{}
	for _, s := range got {
		kept[s.SourceRef] = true
	}
	if !kept["struct:security-boundary:src/auth/s.ts"] || !kept["commit:1"] || !kept["dep:floating:package.json:jsonwebtoken"] {
		t.Fatalf("security selector must keep boundary + churn + dep, got %v", kept)
	}
	if kept["struct:no-test:src/x.ts"] || kept["mem:1"] {
		t.Fatalf("security selector must drop no-test structure + memory noise, got %v", kept)
	}
}

func TestAdmissibleForSecurity(t *testing.T) {
	boundary := newSignal(CollectorStructure, "b", 1, []string{"src/auth/s.ts"}, "b", map[string]any{"classes": []string{ClassSecurityBoundary}}, "")
	churn := newSignal(CollectorGit, "c", 2, []string{"src/auth/s.ts"}, "c", nil, "")
	dep := newSignal(CollectorDependency, "d", 1, []string{"package.json"}, "d", map[string]any{"classes": []string{ClassDependencyPin}}, "")
	cfg := newSignal(CollectorConfig, "cfg", 1, []string{"config/app.yaml"}, "cfg", map[string]any{"classes": []string{ClassConfigSecurity}}, "")

	// boundary alone (no consequence) -> withheld.
	if admissibleForMode(ModeSecurity, []waveobj.RadarSignal{boundary}, StrengthLimited) {
		t.Fatal("a security boundary with no consequence must be withheld")
	}
	// churn alone (no boundary) -> withheld.
	if admissibleForMode(ModeSecurity, []waveobj.RadarSignal{churn}, StrengthLimited) {
		t.Fatal("churn with no security classification must be withheld")
	}
	// boundary + churn -> admitted.
	if !admissibleForMode(ModeSecurity, []waveobj.RadarSignal{boundary, churn}, StrengthLimited) {
		t.Fatal("boundary + consequence must be admitted")
	}
	// self-sufficient facts alone -> admitted.
	if !admissibleForMode(ModeSecurity, []waveobj.RadarSignal{dep}, StrengthLimited) {
		t.Fatal("a dependency-pin fact is self-sufficient and must be admitted")
	}
	if !admissibleForMode(ModeSecurity, []waveobj.RadarSignal{cfg}, StrengthLimited) {
		t.Fatal("a config-security fact is self-sufficient and must be admitted")
	}
}

func TestModeTaskLineSecurity(t *testing.T) {
	if got := modeTaskLine(ModeSecurity); got == modeTaskLine(ModeCorrectness) || got == "" {
		t.Fatalf("security task line must be distinct and non-empty, got %q", got)
	}
}
