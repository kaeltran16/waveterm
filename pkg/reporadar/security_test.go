// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestFactClassesToleratesDBRoundTrip(t *testing.T) {
	inMem := waveobj.RadarSignal{Facts: map[string]any{"classes": []string{ClassSecurityBoundary}}}
	if !hasClass(inMem, ClassSecurityBoundary) {
		t.Fatal("in-memory []string classes must be readable")
	}
	// after a JSON/DB round-trip, classes arrive as []any — the helper must still read them.
	roundTripped := waveobj.RadarSignal{Facts: map[string]any{"classes": []any{ClassDependencyPin}}}
	if !hasClass(roundTripped, ClassDependencyPin) {
		t.Fatal("[]any classes (DB round-trip) must be readable")
	}
	if hasClass(inMem, ClassConfigSecurity) {
		t.Fatal("absent class must not match")
	}
}

func TestSecurityClassifiedAndConsequence(t *testing.T) {
	boundary := waveobj.RadarSignal{Collector: CollectorStructure, Facts: map[string]any{"classes": []string{ClassSecurityBoundary}}}
	dep := waveobj.RadarSignal{Collector: CollectorDependency, Facts: map[string]any{"classes": []string{ClassDependencyPin}}}
	cfg := waveobj.RadarSignal{Collector: CollectorConfig, Facts: map[string]any{"classes": []string{ClassConfigSecurity}}}
	churn := waveobj.RadarSignal{Collector: CollectorGit}
	noise := waveobj.RadarSignal{Collector: CollectorStructure, Facts: map[string]any{"classes": []string{"source-without-test"}}}

	// classified: the three security facts; NOT churn or a plain no-test structure fact.
	for _, s := range []waveobj.RadarSignal{boundary, dep, cfg} {
		if !isSecurityClassified(s) {
			t.Fatalf("%s/%v should be security-classified", s.Collector, s.Facts)
		}
	}
	for _, s := range []waveobj.RadarSignal{churn, noise} {
		if isSecurityClassified(s) {
			t.Fatalf("%s/%v must NOT be security-classified", s.Collector, s.Facts)
		}
	}
	// consequence: churn (git) + the self-sufficient facts (config/dep); NOT a structure boundary alone.
	if !isSecurityConsequence(churn) || !isSecurityConsequence(dep) || !isSecurityConsequence(cfg) {
		t.Fatal("git churn and config/dep facts must be consequences")
	}
	if isSecurityConsequence(boundary) {
		t.Fatal("a structure security-boundary alone is NOT a consequence")
	}
}

func TestSecurityBoundaryKind(t *testing.T) {
	cases := map[string]string{
		"src/auth/session.ts":      "auth",
		"internal/login/jwt.go":    "auth",
		"pkg/secretstore/vault.go": "secret",
		"src/api/validate.ts":      "input",
		"src/util/format.ts":       "",
	}
	for p, want := range cases {
		if got := securityBoundaryKind(p); got != want {
			t.Fatalf("securityBoundaryKind(%q) = %q, want %q", p, got, want)
		}
	}
}

func TestSecurityRelevantDepAndFloatingSpec(t *testing.T) {
	if !securityRelevantDep("jsonwebtoken") || !securityRelevantDep("passport-oauth") || securityRelevantDep("lodash") {
		t.Fatal("security-relevant dependency detection wrong")
	}
	floating := []string{"^9.0.0", "~1.2.0", "*", "latest", "1.x", ">=2.0.0"}
	pinned := []string{"9.0.0", "1.2.3", "git+https://x/y.git", "workspace:*"}
	for _, s := range floating {
		if !isFloatingSpec(s) {
			t.Fatalf("%q should be floating", s)
		}
	}
	for _, s := range pinned {
		if isFloatingSpec(s) {
			t.Fatalf("%q should be pinned/skipped", s)
		}
	}
}
