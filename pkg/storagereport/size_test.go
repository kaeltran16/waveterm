// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// linkDir makes link point at target: a junction on Windows, which needs no privilege, a symlink elsewhere.
func linkDir(t *testing.T, link, target string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
			t.Fatalf("mklink /J %s %s: %v\n%s", link, target, err, out)
		}
		return
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

func TestSizeSkipsLinks(t *testing.T) {
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "big.bin"), make([]byte, 1<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "tree")
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), make([]byte, 100), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sub", "b.txt"), make([]byte, 50), 0o644); err != nil {
		t.Fatal(err)
	}
	linkDir(t, filepath.Join(dir, "node_modules"), outside)

	size, _, err := pathSize(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if size != 150 {
		t.Fatalf("size = %d, want 150 (the junction's 1 MB target is not counted)", size)
	}
}

func TestSizeModTsIsTheNewest(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	newer := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(dir, old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(file, newer, newer); err != nil {
		t.Fatal(err)
	}
	_, modTs, err := pathSize(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if modTs != newer.UnixMilli() {
		t.Fatalf("modTs = %d, want the file's %d", modTs, newer.UnixMilli())
	}

	// the folder's own mtime counts
	if err := os.Chtimes(file, old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(dir, newer, newer); err != nil {
		t.Fatal(err)
	}
	if _, modTs, _ = pathSize(context.Background(), dir); modTs != newer.UnixMilli() {
		t.Fatalf("modTs = %d, want the folder's %d", modTs, newer.UnixMilli())
	}
}

func TestSizeOfAFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "out.log")
	if err := os.WriteFile(file, make([]byte, 42), 0o644); err != nil {
		t.Fatal(err)
	}
	if size, modTs, err := pathSize(context.Background(), file); err != nil || size != 42 || modTs == 0 {
		t.Fatalf("pathSize = %d %d %v, want 42 bytes", size, modTs, err)
	}
}
