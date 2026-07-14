// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func principles(items ...waveobj.Principle) waveobj.PrincipleList { return items }
func ptrPhases(p []waveobj.RunPhase) *[]waveobj.RunPhase          { return &p }

func TestResolvePrinciples(t *testing.T) {
	global := principles(
		waveobj.Principle{ID: "simple", Text: "Prefer simple solutions."},
		waveobj.Principle{ID: "errors", Text: "Handle errors at boundaries."},
		waveobj.Principle{ID: "measure", Text: "Measure before optimizing."},
	)
	patch := &waveobj.PrinciplePatch{
		Additions:    []waveobj.Principle{{ID: "project-api", Text: "Keep the public API stable."}, {ID: "project-tests", Text: "Test behavior."}},
		Replacements: map[string]string{"errors": "Return contextual boundary errors.", "measure": "ignored replacement"},
		Disabled:     []string{"measure"},
	}
	want := principles(
		waveobj.Principle{ID: "simple", Text: "Prefer simple solutions."},
		waveobj.Principle{ID: "errors", Text: "Return contextual boundary errors."},
		waveobj.Principle{ID: "project-api", Text: "Keep the public API stable."},
		waveobj.Principle{ID: "project-tests", Text: "Test behavior."},
	)

	got, diagnostics := ResolvePrinciples(global, patch)
	if !reflect.DeepEqual(got, want) || len(diagnostics) != 0 {
		t.Fatalf("resolved principles mismatch: got %#v diagnostics %#v", got, diagnostics)
	}
	if global[1].Text != "Handle errors at boundaries." || patch.Replacements["errors"] != "Return contextual boundary errors." {
		t.Fatal("resolution mutated its inputs")
	}
}

func TestResolvePrinciplesReportsStaleReferences(t *testing.T) {
	global := principles(waveobj.Principle{ID: "simple", Text: "Simple."})
	patch := &waveobj.PrinciplePatch{
		Replacements: map[string]string{"removed-replacement": "stale"},
		Disabled:     []string{"removed-disabled"},
	}
	got, diagnostics := ResolvePrinciples(global, patch)
	wantDiagnostics := []waveobj.PrincipleDiagnostic{
		{Code: DiagnosticMissingReplacement, PrincipleID: "removed-replacement"},
		{Code: DiagnosticMissingDisabled, PrincipleID: "removed-disabled"},
	}
	if !reflect.DeepEqual(got, global) || !reflect.DeepEqual(diagnostics, wantDiagnostics) {
		t.Fatalf("stale references mismatch: got %#v diagnostics %#v", got, diagnostics)
	}
}

func TestValidatePrinciples(t *testing.T) {
	validGlobal := principles(waveobj.Principle{ID: "simple", Text: "Simple."})
	tests := []struct {
		name   string
		global waveobj.PrincipleList
		patch  *waveobj.PrinciplePatch
	}{
		{name: "blank global id", global: principles(waveobj.Principle{Text: "Simple."})},
		{name: "blank global text", global: principles(waveobj.Principle{ID: "simple"})},
		{name: "duplicate global id", global: principles(waveobj.Principle{ID: "simple", Text: "One."}, waveobj.Principle{ID: "simple", Text: "Two."})},
		{name: "blank addition id", global: validGlobal, patch: &waveobj.PrinciplePatch{Additions: []waveobj.Principle{{Text: "Added."}}}},
		{name: "blank addition text", global: validGlobal, patch: &waveobj.PrinciplePatch{Additions: []waveobj.Principle{{ID: "added"}}}},
		{name: "duplicate addition id", global: validGlobal, patch: &waveobj.PrinciplePatch{Additions: []waveobj.Principle{{ID: "added", Text: "One."}, {ID: "added", Text: "Two."}}}},
		{name: "addition global collision", global: validGlobal, patch: &waveobj.PrinciplePatch{Additions: []waveobj.Principle{{ID: "simple", Text: "Added."}}}},
		{name: "blank replacement text", global: validGlobal, patch: &waveobj.PrinciplePatch{Replacements: map[string]string{"simple": "  "}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.patch == nil {
				if err := ValidateGlobalPrinciples(tt.global); err == nil {
					t.Fatal("expected validation error")
				}
				return
			}
			if err := ValidatePrinciplePatch(tt.global, tt.patch); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
	if err := ValidatePrinciplePatch(validGlobal, &waveobj.PrinciplePatch{Disabled: []string{"stale"}}); err != nil {
		t.Fatalf("stale references are nonfatal: %v", err)
	}
}

func TestLegacyProjectReplacementAndNormalization(t *testing.T) {
	var patch waveobj.PrinciplePatch
	if err := json.Unmarshal([]byte(`"legacy project\ntext"`), &patch); err != nil {
		t.Fatal(err)
	}
	global := principles(
		waveobj.Principle{ID: "simple", Text: "Simple."},
		waveobj.Principle{ID: "errors", Text: "Errors."},
	)
	got, diagnostics := ResolvePrinciples(global, &patch)
	want := principles(waveobj.Principle{ID: waveobj.LegacyProjectPrincipleID, Text: "legacy project\ntext"})
	if !reflect.DeepEqual(got, want) || len(diagnostics) != 0 {
		t.Fatalf("legacy resolution mismatch: got %#v diagnostics %#v", got, diagnostics)
	}
	normalized := NormalizePrinciplePatch(global, &patch)
	if !reflect.DeepEqual(normalized.Disabled, []string{"simple", "errors"}) || !reflect.DeepEqual(normalized.Additions, []waveobj.Principle(want)) {
		t.Fatalf("legacy normalization mismatch: %#v", normalized)
	}
}

func TestRenderPrinciples(t *testing.T) {
	structured := principles(
		waveobj.Principle{ID: "simple", Text: "Prefer simple solutions."},
		waveobj.Principle{ID: "errors", Text: "Handle errors."},
	)
	if got := RenderPrinciples(structured); got != "- Prefer simple solutions.\n- Handle errors." {
		t.Fatalf("structured rendering mismatch: %q", got)
	}
	legacy := "preserve\nthis exact text"
	if got := RenderPrinciples(principles(waveobj.Principle{ID: waveobj.LegacyGlobalPrincipleID, Text: legacy})); got != legacy {
		t.Fatalf("legacy rendering changed text: %q", got)
	}
	if got := RenderPrinciples(nil); got != "" {
		t.Fatalf("empty rendering mismatch: %q", got)
	}
}

func TestResolveProfile(t *testing.T) {
	global := waveobj.JarvisProfile{Playbook: DefaultPlaybook(), Principles: principles(waveobj.Principle{ID: "simple", Text: "Simple."})}
	patch := &waveobj.PrinciplePatch{Additions: []waveobj.Principle{{ID: "project", Text: "Project."}}}
	got, diagnostics := ResolveProfileWithDiagnostics(global, &waveobj.ProfileOverride{Principles: patch})
	if len(diagnostics) != 0 || len(got.Principles) != 2 || len(got.Playbook) != len(DefaultPlaybook()) {
		t.Fatalf("resolved profile mismatch: %+v diagnostics %#v", got, diagnostics)
	}
	if plain := ResolveProfile(global, nil); !reflect.DeepEqual(plain.Principles, global.Principles) {
		t.Fatalf("nil override should inherit global: %+v", plain)
	}
}

func TestResolvePlaybook(t *testing.T) {
	global := waveobj.JarvisProfile{Playbook: DefaultPlaybook()}
	pb := []waveobj.RunPhase{{Kind: PhaseKind_Execute, State: PhaseState_Pending}}
	if got := ResolvePlaybook(global, &waveobj.ProfileOverride{Playbook: ptrPhases(pb)}); len(got) != 1 || got[0].Kind != PhaseKind_Execute {
		t.Fatalf("override playbook mismatch: %+v", got)
	}
	if got := ResolvePlaybook(global, &waveobj.ProfileOverride{Playbook: ptrPhases(nil)}); len(got) != len(DefaultPlaybook()) {
		t.Fatalf("empty playbook should fall back: %+v", got)
	}
}

func TestBuiltinProfile(t *testing.T) {
	builtin := BuiltinProfile()
	if len(builtin.Playbook) != len(DefaultPlaybook()) || !reflect.DeepEqual(builtin.Principles, DefaultPrinciples) {
		t.Fatalf("builtin profile mismatch: %+v", builtin)
	}
	if err := ValidateGlobalPrinciples(builtin.Principles); err != nil {
		t.Fatalf("builtin principles invalid: %v", err)
	}
}

func TestLoadGlobalProfile(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "malformed json", body: "{not json"},
		{name: "invalid principles", body: `{"principles":[{"id":"dup","text":"one"},{"id":"dup","text":"two"}]}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			withConfigHome(t, dir)
			if err := os.WriteFile(filepath.Join(dir, globalProfileFileName), []byte(tt.body), 0o644); err != nil {
				t.Fatal(err)
			}
			if got := LoadGlobalProfile(); !reflect.DeepEqual(got, BuiltinProfile()) {
				t.Fatalf("invalid file should fall back: %+v", got)
			}
		})
	}

	dir := t.TempDir()
	withConfigHome(t, dir)
	body := `{"playbook":[{"kind":"execute","state":"pending"}],"principles":"custom\nlegacy"}`
	if err := os.WriteFile(filepath.Join(dir, globalProfileFileName), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	got := LoadGlobalProfile()
	if len(got.Playbook) != 1 || RenderPrinciples(got.Principles) != "custom\nlegacy" {
		t.Fatalf("valid legacy file should parse exactly: %+v", got)
	}
}

func TestOverrideFromMeta(t *testing.T) {
	if OverrideFromMeta(&waveobj.Channel{Meta: waveobj.MetaMapType{}}) != nil {
		t.Fatal("absent key should be nil")
	}
	ch := &waveobj.Channel{Meta: waveobj.MetaMapType{MetaKey_JarvisProfile: map[string]any{"principles": "project-only"}}}
	ov := OverrideFromMeta(ch)
	if ov == nil || ov.Principles == nil {
		t.Fatalf("present key should parse: %+v", ov)
	}
	if text, ok := ov.Principles.LegacyReplacement(); !ok || text != "project-only" {
		t.Fatalf("legacy marker mismatch: %q %v", text, ok)
	}
	bad := &waveobj.Channel{Meta: waveobj.MetaMapType{MetaKey_JarvisProfile: "not-an-object"}}
	if OverrideFromMeta(bad) != nil {
		t.Fatal("malformed override should degrade to nil")
	}
}

func withConfigHome(t *testing.T, dir string) {
	t.Helper()
	old := wavebase.ConfigHome_VarCache
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = old })
	wavebase.ConfigHome_VarCache = dir
}

func TestDefaultPrincipleWordingIsBounded(t *testing.T) {
	for _, principle := range DefaultPrinciples {
		if strings.TrimSpace(principle.ID) == "" || strings.TrimSpace(principle.Text) == "" {
			t.Fatalf("blank builtin principle: %#v", principle)
		}
	}
}
