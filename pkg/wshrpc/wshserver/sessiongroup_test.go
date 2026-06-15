// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"os"
	"path/filepath"
	"testing"
)

func mkfile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(""), 0o644); err != nil {
		t.Fatalf("writefile: %v", err)
	}
}

func TestComputeSessionGroupLabel(t *testing.T) {
	root := t.TempDir()

	// nearest pom.xml wins; label = its dir's base name
	svc := filepath.Join(root, "src", "CorrelationEngine")
	mkfile(t, filepath.Join(svc, "pom.xml"))
	deep := filepath.Join(svc, "src", "main", "java")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}

	// version-dir heuristic: marker in a version-named dir -> parent label
	verSvc := filepath.Join(root, "CYbersecurity", "version-1.1")
	mkfile(t, filepath.Join(verSvc, "pom.xml"))

	// git-root fallback: no marker, but a .git dir up the tree
	gitRoot := filepath.Join(root, "plainrepo")
	mkfile(t, filepath.Join(gitRoot, ".git", "HEAD"))
	gitSub := filepath.Join(gitRoot, "nested")
	if err := os.MkdirAll(gitSub, 0o755); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name      string
		cwd       string
		wantLabel string
		wantRoot  string
	}{
		{"nearest marker from deep dir", deep, "CorrelationEngine", svc},
		{"marker dir itself", svc, "CorrelationEngine", svc},
		{"version dir uses parent name", verSvc, "CYbersecurity", verSvc},
		{"git root fallback", gitSub, "plainrepo", gitRoot},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := computeSessionGroup(tt.cwd)
			if got.Label != tt.wantLabel {
				t.Errorf("label = %q, want %q", got.Label, tt.wantLabel)
			}
			if got.Root != tt.wantRoot {
				t.Errorf("root = %q, want %q", got.Root, tt.wantRoot)
			}
		})
	}

	// raw-cwd fallback: no marker, no .git
	bare := filepath.Join(root, "loose", "dir")
	if err := os.MkdirAll(bare, 0o755); err != nil {
		t.Fatal(err)
	}
	got := computeSessionGroup(bare)
	if got.Label != "dir" || got.Root != bare {
		t.Errorf("bare fallback = %+v, want label=dir root=%s", got, bare)
	}
}
