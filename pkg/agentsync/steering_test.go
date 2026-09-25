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

// the shape codex and opencode had on disk: a region followed by a leftover memory block
func TestApplyRegionLeavesTextAroundTheRegionByteIdentical(t *testing.T) {
	before := "# Prefs\n\n"
	after := "\n<!-- ARC-MEMORY:BEGIN project=x -->\nfacts\n<!-- ARC-MEMORY:END -->\n"
	got := applyRegion(before+renderRegion("first")+after, "second")
	if want := before + renderRegion("second") + after; got != want {
		t.Fatalf("text outside the markers changed:\ngot:  %q\nwant: %q", got, want)
	}
}
