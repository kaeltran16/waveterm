// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"strings"
	"testing"
)

func TestApplyRegionAppendsWhenAbsent(t *testing.T) {
	got := applyRegion("# Notes\n\nsome hand-written text\n", "canonical body")
	if !strings.HasPrefix(got, "# Notes\n\nsome hand-written text\n") {
		t.Fatalf("existing content not preserved: %q", got)
	}
	if !strings.Contains(got, steeringBegin) || !strings.Contains(got, "canonical body") {
		t.Fatalf("region not appended: %q", got)
	}
}

func TestApplyRegionInsertsBeforeMemoryRegion(t *testing.T) {
	existing := "# Prefs\n\n<!-- ARC-MEMORY:BEGIN project=waveterm -->\nfacts\n<!-- ARC-MEMORY:END -->\n"
	got := applyRegion(existing, "canonical body")
	steerAt := strings.Index(got, steeringBegin)
	memAt := strings.Index(got, memoryBeginMarker)
	if steerAt < 0 || memAt < 0 || steerAt > memAt {
		t.Fatalf("steering region must precede the memory region: steer=%d mem=%d\n%s", steerAt, memAt, got)
	}
	if !strings.Contains(got, "facts") {
		t.Fatal("memory region body was lost")
	}
}

func TestApplyRegionReplacesInPlaceAndIsIdempotent(t *testing.T) {
	existing := "# Prefs\n\n<!-- ARC-MEMORY:BEGIN project=waveterm -->\nfacts\n<!-- ARC-MEMORY:END -->\n"
	once := applyRegion(existing, "first")
	updated := applyRegion(once, "second")
	if strings.Contains(updated, "first") {
		t.Fatalf("stale body survived the replace: %q", updated)
	}
	if strings.Count(updated, steeringBegin) != 1 {
		t.Fatalf("region duplicated: %q", updated)
	}
	if again := applyRegion(updated, "second"); again != updated {
		t.Fatalf("not idempotent:\nfirst:  %q\nsecond: %q", updated, again)
	}
}

func TestBlockBeforeReturnsHandWrittenPrefix(t *testing.T) {
	existing := "# Prefs\nrule one\n\n<!-- ARC-MEMORY:BEGIN project=x -->\nfacts\n<!-- ARC-MEMORY:END -->\n"
	if got, want := blockBefore(existing), "# Prefs\nrule one\n"; strings.TrimSpace(got) != strings.TrimSpace(want) {
		t.Fatalf("blockBefore = %q, want %q", got, want)
	}
	if got := blockBefore("no markers here\n"); strings.TrimSpace(got) != "no markers here" {
		t.Fatalf("blockBefore without markers = %q", got)
	}
}
