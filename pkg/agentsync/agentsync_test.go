// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testPaths builds a temp home with a canonical steering doc and the given harness config roots.
func testPaths(t *testing.T, canonical string, configRoots ...string) Paths {
	t.Helper()
	home := t.TempDir()
	vault := filepath.Join(home, "vault")
	steeringDoc := filepath.Join(vault, "steering", "AGENTS.md")
	if err := os.MkdirAll(filepath.Dir(steeringDoc), 0o755); err != nil {
		t.Fatal(err)
	}
	if canonical != "" {
		if err := os.WriteFile(steeringDoc, []byte(canonical), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, rel := range configRoots {
		if err := os.MkdirAll(filepath.Join(home, filepath.FromSlash(rel)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return Paths{Home: home, SteeringDoc: steeringDoc, SkillsRoot: filepath.Join(vault, "skills")}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestProjectSteeringSkipsAbsentHarnesses(t *testing.T) {
	p := testPaths(t, "canonical rules\n", ".codex")
	actions, err := projectSteering(p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(actions) != 1 || actions[0].Runtime != "codex" {
		t.Fatalf("actions = %+v, want one codex write", actions)
	}
	if _, err := os.Stat(filepath.Join(p.Home, ".pi")); !os.IsNotExist(err) {
		t.Fatal("a harness config root that did not exist must never be created")
	}
}

func TestProjectSteeringInsertsBeforeExistingMemoryRegion(t *testing.T) {
	p := testPaths(t, "canonical rules\n", ".codex")
	target := filepath.Join(p.Home, ".codex", "AGENTS.md")
	if err := os.WriteFile(target, []byte("# old prefs\n\n<!-- ARC-MEMORY:BEGIN project=x -->\nfacts\n<!-- ARC-MEMORY:END -->\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := projectSteering(p, false); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	body := string(got)
	if !strings.Contains(body, "# old prefs") || !strings.Contains(body, "facts") {
		t.Fatalf("existing content lost: %q", body)
	}
	if strings.Index(body, steeringBegin) > strings.Index(body, memoryBeginMarker) {
		t.Fatalf("steering region must come first: %q", body)
	}
}

func TestProjectSteeringIsIdempotentAndDryRunWritesNothing(t *testing.T) {
	p := testPaths(t, "canonical rules\n", ".codex")
	if _, err := projectSteering(p, false); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(p.Home, ".codex", "AGENTS.md")
	first := readFile(t, target)
	actions, err := projectSteering(p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(actions) != 0 {
		t.Fatalf("second projection reported %+v, want no actions", actions)
	}
	if after := readFile(t, target); after != first {
		t.Fatal("an unchanged projection must not rewrite the file")
	}

	p2 := testPaths(t, "other rules\n", ".codex")
	dryActions, err := projectSteering(p2, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(dryActions) != 1 {
		t.Fatalf("dry run actions = %+v, want one", dryActions)
	}
	if _, err := os.Stat(filepath.Join(p2.Home, ".codex", "AGENTS.md")); !os.IsNotExist(err) {
		t.Fatal("dry run must not write")
	}
}
