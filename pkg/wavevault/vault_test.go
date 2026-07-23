// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenVaultAtScaffoldsAndInitsGit(t *testing.T) {
	root := t.TempDir()
	v, err := openVaultAt(context.Background(), root)
	if err != nil {
		t.Fatalf("openVaultAt: %v", err)
	}
	for _, sub := range []string{"memory", "tasks/active", "tasks/archive", "decisions", "attachments"} {
		if _, err := os.Stat(filepath.Join(root, sub)); err != nil {
			t.Fatalf("collection dir %q not created: %v", sub, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, ".git")); err != nil {
		t.Fatalf(".git not initialized: %v", err)
	}
	// fallback identity set so a human commit can't fail
	if out, err := runGit(context.Background(), root, "config", "user.email"); err != nil || out == "" {
		t.Fatalf("fallback user.email not set: out=%q err=%v", out, err)
	}
	if v.machineFiles == nil {
		t.Fatal("machineFiles map must be initialized")
	}
}

func TestOpenVaultAtIdempotent(t *testing.T) {
	root := t.TempDir()
	if _, err := openVaultAt(context.Background(), root); err != nil {
		t.Fatal(err)
	}
	// pre-set a distinct identity; a second open must not clobber it (idempotent init)
	if _, err := runGitErr(context.Background(), root, "config", "user.email", "kept@me"); err != nil {
		t.Fatal(err)
	}
	if _, err := openVaultAt(context.Background(), root); err != nil {
		t.Fatalf("second open: %v", err)
	}
	out, _ := runGit(context.Background(), root, "config", "user.email")
	if out == "" || out[:5] != "kept@" {
		t.Fatalf("second open clobbered identity: %q", out)
	}
}

func TestScopes(t *testing.T) {
	if got := WorkerScope().Collections; len(got) != 2 {
		t.Fatalf("WorkerScope = %v, want 2 collections (memory, decisions)", got)
	}
	for _, c := range WorkerScope().Collections {
		if c == CollTasks {
			t.Fatal("WorkerScope must NOT include tasks")
		}
	}
	all := AllScope().Collections
	hasTasks := false
	for _, c := range all {
		if c == CollTasks {
			hasTasks = true
		}
	}
	if !hasTasks {
		t.Fatalf("AllScope must include tasks, got %v", all)
	}
}
