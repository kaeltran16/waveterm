// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func ptrPhases(p []waveobj.RunPhase) *[]waveobj.RunPhase { return &p }
func ptrStr(s string) *string                            { return &s }

func TestResolveProfileNilOverride(t *testing.T) {
	g := waveobj.JarvisProfile{Playbook: DefaultPlaybook(), Principles: "gp"}
	got := ResolveProfile(g, nil)
	if got.Principles != "gp" || len(got.Playbook) != len(DefaultPlaybook()) {
		t.Fatalf("nil override should equal global, got %+v", got)
	}
}

func TestResolveProfilePrinciplesOnly(t *testing.T) {
	g := waveobj.JarvisProfile{Playbook: DefaultPlaybook(), Principles: "gp"}
	got := ResolveProfile(g, &waveobj.ProfileOverride{Principles: ptrStr("op")})
	if got.Principles != "op" {
		t.Fatalf("principles should be overridden, got %q", got.Principles)
	}
	if len(got.Playbook) != len(DefaultPlaybook()) {
		t.Fatalf("playbook should inherit global, got %d phases", len(got.Playbook))
	}
}

func TestResolveProfilePlaybookOnly(t *testing.T) {
	g := waveobj.JarvisProfile{Playbook: DefaultPlaybook(), Principles: "gp"}
	pb := []waveobj.RunPhase{{Kind: PhaseKind_Custom, State: PhaseState_Pending}}
	got := ResolveProfile(g, &waveobj.ProfileOverride{Playbook: ptrPhases(pb)})
	if len(got.Playbook) != 1 || got.Principles != "gp" {
		t.Fatalf("playbook overridden + principles inherited expected, got %+v", got)
	}
}

func TestResolvePlaybookFallsBackWhenEmpty(t *testing.T) {
	g := waveobj.JarvisProfile{Playbook: []waveobj.RunPhase{}, Principles: "gp"}
	got := ResolvePlaybook(g, &waveobj.ProfileOverride{Playbook: ptrPhases([]waveobj.RunPhase{})})
	if len(got) != len(DefaultPlaybook()) {
		t.Fatalf("empty resolved playbook should fall back to default, got %d", len(got))
	}
}

func TestResolvePlaybookHonorsOverride(t *testing.T) {
	g := waveobj.JarvisProfile{Playbook: DefaultPlaybook()}
	pb := []waveobj.RunPhase{{Kind: PhaseKind_Execute, State: PhaseState_Pending}}
	got := ResolvePlaybook(g, &waveobj.ProfileOverride{Playbook: ptrPhases(pb)})
	if len(got) != 1 || got[0].Kind != PhaseKind_Execute {
		t.Fatalf("override playbook should be used, got %+v", got)
	}
}

func TestBuiltinProfile(t *testing.T) {
	b := BuiltinProfile()
	if len(b.Playbook) != len(DefaultPlaybook()) {
		t.Fatalf("builtin playbook should match default")
	}
	if b.Principles == "" {
		t.Fatalf("builtin principles should be non-empty")
	}
}

func TestLoadGlobalProfileMissing(t *testing.T) {
	old := wavebase.ConfigHome_VarCache
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = old })
	wavebase.ConfigHome_VarCache = t.TempDir() // empty dir → no file
	if LoadGlobalProfile().Principles != DefaultPrinciples {
		t.Fatalf("missing file should fall back to builtin")
	}
}

func TestLoadGlobalProfileMalformed(t *testing.T) {
	dir := t.TempDir()
	old := wavebase.ConfigHome_VarCache
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = old })
	wavebase.ConfigHome_VarCache = dir
	if err := os.WriteFile(filepath.Join(dir, globalProfileFileName), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if LoadGlobalProfile().Principles != DefaultPrinciples {
		t.Fatalf("malformed file should fall back to builtin")
	}
}

func TestLoadGlobalProfileValid(t *testing.T) {
	dir := t.TempDir()
	old := wavebase.ConfigHome_VarCache
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = old })
	wavebase.ConfigHome_VarCache = dir
	body := []byte(`{"playbook":[{"kind":"execute","state":"pending"}],"principles":"custom"}`)
	if err := os.WriteFile(filepath.Join(dir, globalProfileFileName), body, 0o644); err != nil {
		t.Fatal(err)
	}
	got := LoadGlobalProfile()
	if got.Principles != "custom" || len(got.Playbook) != 1 {
		t.Fatalf("valid file should parse, got %+v", got)
	}
}

func TestOverrideFromMetaAbsent(t *testing.T) {
	ch := &waveobj.Channel{Meta: waveobj.MetaMapType{}}
	if OverrideFromMeta(ch) != nil {
		t.Fatalf("absent key should be nil")
	}
}

func TestOverrideFromMetaPresent(t *testing.T) {
	// generic map, as after a DB round-trip
	ch := &waveobj.Channel{Meta: waveobj.MetaMapType{MetaKey_JarvisProfile: map[string]any{"principles": "op"}}}
	ov := OverrideFromMeta(ch)
	if ov == nil || ov.Principles == nil || *ov.Principles != "op" {
		t.Fatalf("present key should parse, got %+v", ov)
	}
}

func TestOverrideFromMetaMalformed(t *testing.T) {
	ch := &waveobj.Channel{Meta: waveobj.MetaMapType{MetaKey_JarvisProfile: "not-an-object"}}
	if OverrideFromMeta(ch) != nil {
		t.Fatalf("malformed override should degrade to nil")
	}
}
