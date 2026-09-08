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

func TestSkillRowsReportsPerHarnessState(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex", ".claude")
	seedSkill(t, p, "graphify")
	seedSkill(t, p, "effort-tracking")
	// a real directory under one canonical name; the other stays unlinked until Apply runs
	occupied := filepath.Join(p.Home, ".codex", "skills", "graphify")
	if err := os.MkdirAll(occupied, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(p, false); err != nil {
		t.Fatal(err)
	}
	rows, err := SkillRows(p)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]SkillRow{}
	for _, r := range rows {
		byName[r.Name] = r
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %+v, want one per canonical skill", rows)
	}
	if got := byName["graphify"].States["codex"]; got != "conflict" {
		t.Errorf("graphify codex = %q, want conflict", got)
	}
	if got := byName["graphify"].States["claude"]; got != "linked" {
		t.Errorf("graphify claude = %q, want linked", got)
	}
	if got := byName["effort-tracking"].States["codex"]; got != "linked" {
		t.Errorf("effort-tracking codex = %q, want linked", got)
	}
	// opencode has no config root here, so it is not synced at all
	if got := byName["graphify"].States["opencode"]; got != "absent" {
		t.Errorf("graphify opencode = %q, want absent", got)
	}
}

func TestSkillRowsPendingBeforeApply(t *testing.T) {
	p := testPaths(t, "canonical\n", ".claude")
	seedSkill(t, p, "graphify")
	rows, err := SkillRows(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].States["claude"] != "pending" {
		t.Fatalf("rows = %+v, want claude pending before the first Apply", rows)
	}
}

func TestSkillRowsReadsDescriptionFromFrontmatter(t *testing.T) {
	p := testPaths(t, "canonical\n", ".claude")
	seedSkill(t, p, "graphify")
	body := "---\nname: graphify\ndescription: turn any input into a knowledge graph\n---\n# Graphify\n"
	if err := os.WriteFile(filepath.Join(p.SkillsRoot, "graphify", "SKILL.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	rows, err := SkillRows(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Description != "turn any input into a knowledge graph" {
		t.Fatalf("rows = %+v, want the frontmatter description", rows)
	}
}

func TestSkillRowsSurvivesAMissingSkillDoc(t *testing.T) {
	p := testPaths(t, "canonical\n", ".claude")
	if err := os.MkdirAll(filepath.Join(p.SkillsRoot, "bare"), 0o755); err != nil {
		t.Fatal(err)
	}
	rows, err := SkillRows(p)
	if err != nil {
		t.Fatalf("a skill directory without SKILL.md must not fail the read: %v", err)
	}
	if len(rows) != 1 || rows[0].Description != "" {
		t.Fatalf("rows = %+v, want one row with an empty description", rows)
	}
}
