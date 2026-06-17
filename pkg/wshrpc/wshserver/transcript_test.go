// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadTranscriptTail(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.jsonl")
	// blank line in the middle must be skipped
	if err := os.WriteFile(path, []byte("a\n\nb\nc\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	all, err := readTranscriptTail(path, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("want 3 non-empty lines, got %d (%v)", len(all), all)
	}

	tail, err := readTranscriptTail(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 2 || tail[0] != "b" || tail[1] != "c" {
		t.Fatalf("want [b c], got %v", tail)
	}

	if _, err := readTranscriptTail(filepath.Join(dir, "nope.jsonl"), 0); err == nil {
		t.Fatal("expected error for missing file")
	}
	if _, err := readTranscriptTail("", 0); err == nil {
		t.Fatal("expected error for empty path")
	}
	if _, err := readTranscriptTail(dir, 0); err == nil {
		t.Fatal("expected error when path is a directory")
	}
}
