// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPlanSkillsCoversEveryObservedState(t *testing.T) {
	root := filepath.Join("C:", "vault", "skills")
	canonical := []string{"correct", "missing", "retarget-me", "occupied"}
	observed := []ObservedEntry{
		{Name: "correct", IsLink: true, Target: filepath.Join(root, "correct")},
		{Name: "retarget-me", IsLink: true, Target: filepath.Join("C:", "old", "retarget-me")},
		{Name: "occupied", IsLink: false},
		{Name: "orphan", IsLink: true, Target: filepath.Join(root, "orphan")},
		{Name: "not-ours", IsLink: true, Target: filepath.Join("C:", "somewhere", "not-ours")},
	}
	got := planSkills(canonical, observed, root)
	want := []SkillAction{
		{Kind: "create", Name: "missing"},
		{Kind: "retarget", Name: "retarget-me"},
		{Kind: "conflict", Name: "occupied"},
		{Kind: "remove", Name: "orphan"},
	}
	if len(got) != len(want) {
		t.Fatalf("plan = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("action %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestPlanSkillsLeavesForeignLinksAlone(t *testing.T) {
	root := filepath.Join("C:", "vault", "skills")
	observed := []ObservedEntry{{Name: "plugin-skill", IsLink: true, Target: filepath.Join("C:", "plugins", "cache", "plugin-skill")}}
	if got := planSkills(nil, observed, root); len(got) != 0 {
		t.Fatalf("plan = %+v, want nothing: a link outside the vault is not ours", got)
	}
}

// seedSkill creates a canonical skill tree in the vault.
func seedSkill(t *testing.T, p Paths, name string) {
	t.Helper()
	dir := filepath.Join(p.SkillsRoot, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: "+name+"\n---\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReconcileSkillsLinksIntoPresentHarnesses(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex", ".claude")
	seedSkill(t, p, "graphify")
	actions, err := reconcileSkills(p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(actions) != 2 {
		t.Fatalf("actions = %+v, want one link per present harness", actions)
	}
	for _, rel := range []string{filepath.Join(".codex", "skills", "graphify"), filepath.Join(".claude", "skills", "graphify")} {
		link := filepath.Join(p.Home, rel)
		if !isLink(link) {
			t.Errorf("%s is not a link", rel)
		}
		if _, err := os.ReadFile(filepath.Join(link, "SKILL.md")); err != nil {
			t.Errorf("reading through %s: %v", rel, err)
		}
	}
	// pi has no fixed skills dir, so nothing is created for it even when its config root exists
	if _, err := os.Stat(filepath.Join(p.Home, ".pi", "agent", "skills")); !os.IsNotExist(err) {
		t.Error("pi must not get a skills directory")
	}
}

func TestReconcileSkillsIsIdempotentAndReportsConflicts(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex")
	seedSkill(t, p, "graphify")
	if _, err := reconcileSkills(p, false); err != nil {
		t.Fatal(err)
	}
	again, err := reconcileSkills(p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 0 {
		t.Fatalf("second reconcile = %+v, want no actions", again)
	}

	// a real directory occupying a canonical name is reported, never replaced
	p2 := testPaths(t, "canonical\n", ".codex")
	seedSkill(t, p2, "graphify")
	occupied := filepath.Join(p2.Home, ".codex", "skills", "graphify")
	if err := os.MkdirAll(occupied, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(occupied, "SKILL.md"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	acts, err := reconcileSkills(p2, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(acts) != 1 || acts[0].Kind != ActionSkillConflict {
		t.Fatalf("actions = %+v, want a single conflict", acts)
	}
	body, err := os.ReadFile(filepath.Join(occupied, "SKILL.md"))
	if err != nil || string(body) != "mine" {
		t.Fatalf("the user's directory was modified: %q %v", body, err)
	}
}
