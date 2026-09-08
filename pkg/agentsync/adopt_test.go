// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestAdoptSeedsTheFirstCopyIntoTheVault(t *testing.T) {
	p := testPaths(t, "", ".claude")
	writeFile(t, filepath.Join(p.Home, ".claude", "CLAUDE.md"), "# Prefs\n")
	writeFile(t, filepath.Join(p.Home, ".claude", "skills", "graphify", skillFile), "---\nname: graphify\n---\nbody\n")

	plan, err := Adopt(p, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Moves) != 1 || !plan.Moves[0].Seed {
		t.Fatalf("plan = %+v, want one seeding move", plan)
	}
	if got := readFile(t, filepath.Join(p.SkillsRoot, "graphify", skillFile)); got != "---\nname: graphify\n---\nbody\n" {
		t.Fatalf("canonical skill = %q", got)
	}
	// and it comes straight back as a managed copy
	back := filepath.Join(p.Home, ".claude", "skills", "graphify")
	if _, err := os.Stat(filepath.Join(back, managedMarkName)); err != nil {
		t.Fatalf("the adopted skill was not rendered back: %v", err)
	}
	if _, err := os.Stat(filepath.Join(p.SkillsRoot, "graphify", managedMarkName)); !os.IsNotExist(err) {
		t.Error("the canonical tree must not carry the ownership mark")
	}
}

func TestAdoptTurnsAFrontmatterVariantIntoADelta(t *testing.T) {
	p := testPaths(t, "", ".codex", ".config/opencode")
	writeFile(t, filepath.Join(p.Home, ".codex", "AGENTS.md"), "# Prefs\n")
	writeFile(t, filepath.Join(p.Home, ".codex", "skills", "orch", skillFile),
		"---\nname: orch\ntool: codex\n---\nsame body\n")
	writeFile(t, filepath.Join(p.Home, ".config", "opencode", "skills", "orch", skillFile),
		"---\nname: orch\ntool: opencode\n---\nsame body\n")

	plan, err := Adopt(p, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Unresolved) != 0 {
		t.Fatalf("a frontmatter-only variant must not be unresolved: %+v", plan.Unresolved)
	}
	if got := readFile(t, filepath.Join(p.SkillsRoot, "orch", deltaDirName, "opencode.yaml")); got != "tool: opencode\n" {
		t.Fatalf("opencode delta = %q, want only the differing key", got)
	}
	// each harness ends up with its own flavour of the same shared body
	codex := readFile(t, filepath.Join(p.Home, ".codex", "skills", "orch", skillFile))
	opencode := readFile(t, filepath.Join(p.Home, ".config", "opencode", "skills", "orch", skillFile))
	if codex != "---\nname: orch\ntool: codex\n---\nsame body\n" {
		t.Fatalf("codex copy = %q", codex)
	}
	if opencode != "---\nname: orch\ntool: opencode\n---\nsame body\n" {
		t.Fatalf("opencode copy = %q", opencode)
	}
}

func TestAdoptTurnsASidecarIntoADelta(t *testing.T) {
	p := testPaths(t, "", ".claude", ".codex")
	writeFile(t, filepath.Join(p.Home, ".claude", "CLAUDE.md"), "# Prefs\n")
	writeFile(t, filepath.Join(p.Home, ".claude", "skills", "simplify", skillFile), "---\nname: simplify\n---\nbody\n")
	writeFile(t, filepath.Join(p.Home, ".codex", "skills", "simplify", skillFile), "---\nname: simplify\n---\nbody\n")
	writeFile(t, filepath.Join(p.Home, ".codex", "skills", "simplify", "agents", "openai.yaml"), "display_name: Simplify\n")

	if _, err := Adopt(p, true); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(p.SkillsRoot, "simplify", deltaDirName, "codex", "agents", "openai.yaml")); got != "display_name: Simplify\n" {
		t.Fatalf("codex sidecar delta = %q", got)
	}
	if _, err := os.Stat(filepath.Join(p.Home, ".codex", "skills", "simplify", "agents", "openai.yaml")); err != nil {
		t.Errorf("codex lost its sidecar: %v", err)
	}
	if _, err := os.Stat(filepath.Join(p.Home, ".claude", "skills", "simplify", "agents", "openai.yaml")); !os.IsNotExist(err) {
		t.Error("codex's sidecar must not reach claude")
	}
}

func TestAdoptLeavesABodyConflictExactlyWhereItIs(t *testing.T) {
	p := testPaths(t, "", ".claude", ".codex")
	writeFile(t, filepath.Join(p.Home, ".claude", "CLAUDE.md"), "# Prefs\n")
	writeFile(t, filepath.Join(p.Home, ".claude", "skills", "review", skillFile), "---\nname: review\n---\nclaude body\n")
	writeFile(t, filepath.Join(p.Home, ".codex", "skills", "review", skillFile), "---\nname: review\n---\ncodex body\n")

	plan, err := Adopt(p, true)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan.Unresolved, []string{"review"}) {
		t.Fatalf("unresolved = %#v, want the body conflict named", plan.Unresolved)
	}
	if _, err := os.Stat(filepath.Join(p.SkillsRoot, "review")); !os.IsNotExist(err) {
		t.Error("nothing may be moved into the vault while the bodies disagree")
	}
	if got := readFile(t, filepath.Join(p.Home, ".claude", "skills", "review", skillFile)); got != "---\nname: review\n---\nclaude body\n" {
		t.Errorf("claude copy was touched: %q", got)
	}
	if got := readFile(t, filepath.Join(p.Home, ".codex", "skills", "review", skillFile)); got != "---\nname: review\n---\ncodex body\n" {
		t.Errorf("codex copy was touched: %q", got)
	}
}

func TestPlanAdoptWritesNothing(t *testing.T) {
	p := testPaths(t, "", ".claude")
	writeFile(t, filepath.Join(p.Home, ".claude", "CLAUDE.md"), "# Prefs\n")
	writeFile(t, filepath.Join(p.Home, ".claude", "skills", "graphify", skillFile), "---\nname: graphify\n---\nbody\n")

	plan, err := Adopt(p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Moves) != 1 {
		t.Fatalf("plan = %+v, want the move reported", plan)
	}
	if _, err := os.Stat(p.SkillsRoot); !os.IsNotExist(err) {
		t.Error("a dry run must not create the vault skills root")
	}
	if _, err := os.Stat(filepath.Join(p.Home, ".claude", "skills", "graphify", skillFile)); err != nil {
		t.Errorf("a dry run moved the source: %v", err)
	}
}

func TestAdoptSkipsWhatArcAlreadyOwns(t *testing.T) {
	p := testPaths(t, "", ".claude")
	writeFile(t, filepath.Join(p.Home, ".claude", "CLAUDE.md"), "# Prefs\n")
	seedSkill(t, p, "graphify")
	if _, err := Apply(p, false); err != nil {
		t.Fatal(err)
	}
	plan, err := Adopt(p, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Moves) != 0 {
		t.Fatalf("plan = %+v, want nothing to adopt", plan)
	}
}
