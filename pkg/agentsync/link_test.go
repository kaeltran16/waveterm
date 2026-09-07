// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCreateReadRemoveLink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "canonical")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "SKILL.md"), []byte("body"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "linked")
	if err := createLink(link, target); err != nil {
		t.Fatal(err)
	}
	if !isLink(link) {
		t.Fatal("createLink did not produce a link")
	}
	got, err := linkTarget(link)
	if err != nil {
		t.Fatal(err)
	}
	if !sameTarget(got, target) {
		t.Fatalf("linkTarget = %q, want %q", got, target)
	}
	// the link is traversable: this is the assumption the whole skills half rests on
	if _, err := os.ReadFile(filepath.Join(link, "SKILL.md")); err != nil {
		t.Fatalf("reading through the link: %v", err)
	}
	if err := removeLink(link); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(target, "SKILL.md")); err != nil {
		t.Fatalf("removing the link destroyed the target: %v", err)
	}
}

func TestRemoveLinkRefusesRealDirectory(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := removeLink(real); err == nil {
		t.Fatal("removeLink must refuse a real directory")
	}
	if _, err := os.Stat(real); err != nil {
		t.Fatalf("the real directory was removed anyway: %v", err)
	}
}

func TestNormalizeAndWithinRoot(t *testing.T) {
	root := filepath.Join("C:", "vault", "skills")
	if !withinRoot(filepath.Join(root, "graphify"), root) {
		t.Error("a skill under the root must be within it")
	}
	if withinRoot(filepath.Join("C:", "elsewhere", "graphify"), root) {
		t.Error("a path outside the root must not be within it")
	}
	if !sameTarget(`\\?\C:\vault\skills\x`, `C:\vault\skills\x`) {
		t.Error("the \\\\?\\ prefix must not defeat comparison")
	}
}
