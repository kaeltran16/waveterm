// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"os"
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

func TestRegionBodyExtractsOnlyTheManagedText(t *testing.T) {
	existing := applyRegion("# Mine\nkeep me\n", "rule one\nrule two")
	if got, want := regionBody(existing), "rule one\nrule two"; got != want {
		t.Fatalf("regionBody = %q, want %q", got, want)
	}
	if got := regionBody("# Mine\nno region here\n"); got != "" {
		t.Fatalf("regionBody without a region = %q, want empty", got)
	}
	// an unterminated region is malformed; report nothing rather than the rest of the file
	if got := regionBody(steeringBegin + "\nhalf a region\n"); got != "" {
		t.Fatalf("regionBody of an unterminated region = %q, want empty", got)
	}
}

func TestProjectionForReportsStateAndBody(t *testing.T) {
	p := testPaths(t, "canonical rules\n", ".codex")

	pi, err := ProjectionFor(p, "pi")
	if err != nil {
		t.Fatal(err)
	}
	if pi.Present || pi.State != "absent" {
		t.Fatalf("pi = %+v, want not present", pi)
	}

	before, err := ProjectionFor(p, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if !before.Present || before.State != "absent" || before.Body != "" {
		t.Fatalf("codex before projection = %+v, want present with no region", before)
	}

	if _, err := Apply(p, false); err != nil {
		t.Fatal(err)
	}
	after, err := ProjectionFor(p, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if after.State != "current" || after.Body != "canonical rules" {
		t.Fatalf("codex after projection = %+v, want current with the canonical body", after)
	}
	if after.Path == "" {
		t.Fatal("projection must name the file it read")
	}

	if err := os.WriteFile(p.SteeringDoc, []byte("changed rules\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stale, err := ProjectionFor(p, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if stale.State != "stale" || stale.Body != "canonical rules" {
		t.Fatalf("codex after a canonical edit = %+v, want stale showing what is still on disk", stale)
	}
}

func TestProjectionForRejectsAnUnknownRuntime(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex")
	if _, err := ProjectionFor(p, "nope"); err == nil {
		t.Fatal("an unknown runtime must be an error, not an empty projection")
	}
}
