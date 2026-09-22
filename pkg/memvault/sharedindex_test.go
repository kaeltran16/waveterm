// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplySharedIndexRegionIsIdempotentAndLeavesHandEntriesAlone(t *testing.T) {
	hand := "# Memory index\n\n- [a hand-written entry](note-a.md) — kept by the memory tool\n"
	body := "### Shared project memory (from the Arc vault)\n\n- [x](../shared/x.md) — a fact\n"

	once := applySharedIndexRegion(hand, body)
	if !strings.Contains(once, "a hand-written entry") {
		t.Fatalf("hand-maintained content outside the region was lost:\n%s", once)
	}
	if !strings.Contains(once, "../shared/x.md") {
		t.Fatalf("region body missing:\n%s", once)
	}
	twice := applySharedIndexRegion(once, body)
	if twice != once {
		t.Fatalf("second apply changed the file:\n--- once ---\n%s\n--- twice ---\n%s", once, twice)
	}
}

func TestApplySharedIndexRegionEmptyBodyStripsTheRegion(t *testing.T) {
	hand := "# Memory index\n\n- [a](a.md)\n"
	withRegion := applySharedIndexRegion(hand, "### h\n\n- [x](../shared/x.md)\n")
	stripped := applySharedIndexRegion(withRegion, "")
	if strings.Contains(stripped, "ARC-SHARED") {
		t.Fatalf("empty body must remove the region entirely:\n%s", stripped)
	}
	if !strings.Contains(stripped, "- [a](a.md)") {
		t.Fatalf("stripping the region must not touch hand entries:\n%s", stripped)
	}
}

func TestWriteSharedIndexLinksEverySharedNote(t *testing.T) {
	hub := t.TempDir()
	shared := t.TempDir()
	if err := os.WriteFile(filepath.Join(shared, "fact-one.md"),
		[]byte("---\nname: fact-one\ndescription: \"the first fact\"\n---\n\nbody one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hub, "MEMORY.md"), []byte("# Memory index\n\n- [a](a.md)\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := WriteSharedIndex(hub, shared); err != nil {
		t.Fatalf("WriteSharedIndex: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(hub, "MEMORY.md"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if !strings.Contains(got, "[fact-one](../shared/fact-one.md)") {
		t.Fatalf("shared note not linked:\n%s", got)
	}
	if !strings.Contains(got, "the first fact") {
		t.Fatalf("description not carried into the index line:\n%s", got)
	}
	if !strings.Contains(got, "- [a](a.md)") {
		t.Fatalf("hand entry lost:\n%s", got)
	}
}

func TestWriteSharedIndexMissingHubIndexIsCreated(t *testing.T) {
	hub := t.TempDir()
	shared := t.TempDir()
	if err := os.WriteFile(filepath.Join(shared, "solo.md"), []byte("---\nname: solo\n---\n\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteSharedIndex(hub, shared); err != nil {
		t.Fatalf("WriteSharedIndex: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(hub, "MEMORY.md"))
	if err != nil {
		t.Fatalf("index not created: %v", err)
	}
	if !strings.Contains(string(data), "[solo](../shared/solo.md)") {
		t.Fatalf("link missing from a created index:\n%s", data)
	}
}
