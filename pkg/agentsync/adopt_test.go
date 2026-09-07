// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestCarriedLinesFindsOnlyRealLosses(t *testing.T) {
	canonical := "# Prefs\n\n- rule one\n- rule two\n"
	block := "# Prefs\n\n- rule two\n- rule one\n- rule three\n\n"
	got := carriedLines(block, canonical)
	if !reflect.DeepEqual(got, []string{"- rule three"}) {
		t.Fatalf("carriedLines = %#v, want only the genuinely missing rule", got)
	}
	if len(carriedLines("   \n\n"+canonical, canonical)) != 0 {
		t.Fatal("blank lines and reordering must never block adoption")
	}
}

func TestCollisionsRefuseDuplicateNames(t *testing.T) {
	inventory := map[string][]SkillMove{
		"codex":    {{Runtime: "codex", Name: "1devtool-orchestrator", From: `C:\codex\1devtool-orchestrator`}},
		"opencode": {{Runtime: "opencode", Name: "1devtool-orchestrator", From: `C:\opencode\1devtool-orchestrator`}},
		"claude":   {{Runtime: "claude", Name: "graphify", From: `C:\claude\graphify`}},
	}
	got := collisions(inventory)
	if len(got) != 1 || got[0].Name != "1devtool-orchestrator" {
		t.Fatalf("collisions = %+v, want exactly the duplicated name", got)
	}
	if len(got[0].Sources) != 2 {
		t.Fatalf("sources = %v, want both holders named", got[0].Sources)
	}
}
func TestAdoptRefusesToDropACarriedRule(t *testing.T) {
	p := testPaths(t, "", ".claude", ".pi/agent")
	writeFile(t, filepath.Join(p.Home, ".claude", "CLAUDE.md"), "# Prefs\n- rule one\n")
	writeFile(t, filepath.Join(p.Home, ".pi", "agent", "AGENTS.md"), "# Prefs\n- rule one\n- pi only rule\n")

	plan, err := Adopt(p, true, nil, false)
	if err == nil {
		t.Fatal("apply must refuse while a carried line exists")
	}
	if !plan.Blocked || len(plan.Carried) != 1 || plan.Carried[0].Line != "- pi only rule" {
		t.Fatalf("plan = %+v, want the pi-only rule reported", plan)
	}
	body := readFile(t, filepath.Join(p.Home, ".pi", "agent", "AGENTS.md"))
	if !strings.Contains(body, "- pi only rule") {
		t.Fatal("a refused adoption must not have modified anything")
	}
}

func TestAdoptSeedsProjectsAndBacksUp(t *testing.T) {
	p := testPaths(t, "", ".claude", ".pi/agent")
	writeFile(t, filepath.Join(p.Home, ".claude", "CLAUDE.md"), "# Prefs\n- rule one\n")
	writeFile(t, filepath.Join(p.Home, ".pi", "agent", "AGENTS.md"), "# Prefs\n- rule one\n")

	if _, err := Adopt(p, true, nil, false); err != nil {
		t.Fatal(err)
	}
	canonical := readFile(t, p.SteeringDoc)
	if !strings.Contains(canonical, "- rule one") {
		t.Fatalf("canonical not seeded: %q", canonical)
	}
	pi := readFile(t, filepath.Join(p.Home, ".pi", "agent", "AGENTS.md"))
	if !strings.Contains(pi, steeringBegin) || strings.Count(pi, "- rule one") != 1 {
		t.Fatalf("pi steering not replaced by the region: %q", pi)
	}
	if _, err := os.Stat(filepath.Join(p.Home, ".pi", "agent", "AGENTS.md.bak")); err != nil {
		t.Fatalf("no backup written: %v", err)
	}
}

func TestAdoptMovesSkillsAndRefusesCollisions(t *testing.T) {
	p := testPaths(t, "", ".claude", ".codex")
	writeFile(t, filepath.Join(p.Home, ".claude", "CLAUDE.md"), "# Prefs\n")
	writeFile(t, filepath.Join(p.Home, ".claude", "skills", "graphify", "SKILL.md"), "claude copy\n")
	writeFile(t, filepath.Join(p.Home, ".codex", "skills", "graphify", "SKILL.md"), "codex copy\n")

	if _, err := Adopt(p, true, nil, false); err == nil {
		t.Fatal("a duplicated skill name must block apply")
	}
	if _, err := Adopt(p, true, map[string]string{"graphify": "codex"}, false); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(p.SkillsRoot, "graphify", "SKILL.md")); got != "codex copy\n" {
		t.Fatalf("canonical skill = %q, want the preferred copy", got)
	}
	for _, rel := range []string{filepath.Join(".claude", "skills", "graphify"), filepath.Join(".codex", "skills", "graphify")} {
		if !isLink(filepath.Join(p.Home, rel)) {
			t.Errorf("%s was not junctioned back", rel)
		}
	}
}
