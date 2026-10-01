// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestCapSectionLeavesTextAtOrUnderTheLimit(t *testing.T) {
	for _, n := range []int{10, reportSectionMaxLen} {
		text := strings.Repeat("a", n)
		if got := capSection("t-1", "differs", text); got != text {
			t.Fatalf("%d runes must pass through, got %d", n, len(got))
		}
	}
}

func TestCapSectionCutsAtALineBoundaryAndNamesTheRest(t *testing.T) {
	first := strings.Repeat("a", 2000)
	second := strings.Repeat("b", 1000)
	got := capSection("t-1", "not-verified", first+"\n"+second)
	want := first + "\n… 1001 more characters: wsh jarvis dag report t-1 not-verified"
	if got != want {
		t.Fatalf("want the first line and the marker, got %q", got)
	}
}

func TestCapSectionWithoutAKeyNamesTheWholeReport(t *testing.T) {
	got := capSection("t-1", "", strings.Repeat("a", reportSectionMaxLen+5))
	if want := "\n… 5 more characters: wsh jarvis dag report t-1"; !strings.HasSuffix(got, want) {
		t.Fatalf("want the whole-report command, got %q", got[len(got)-80:])
	}
}

// Review Focus 4: a log line with no newline below the limit still cuts, at the limit
func TestCapSectionCutsAnOverlongSingleLineAtTheLimit(t *testing.T) {
	got := capSection("t-1", "done", strings.Repeat("a", reportSectionMaxLen+40))
	want := strings.Repeat("a", reportSectionMaxLen) + "\n… 40 more characters: wsh jarvis dag report t-1 done"
	if got != want {
		t.Fatalf("want the line cut at the limit, got %d bytes", len(got))
	}
}

func TestCapSectionCountsRunesNotBytes(t *testing.T) {
	text := strings.Repeat("é", reportSectionMaxLen)
	if got := capSection("t-1", "done", text); got != text {
		t.Fatal("2500 multi-byte runes are at the limit and must not be cut")
	}
	got := capSection("t-1", "done", text+"é")
	if want := strings.Repeat("é", reportSectionMaxLen) + "\n… 1 more characters"; !strings.HasPrefix(got, want) {
		t.Fatalf("want the cut counted in runes, got %q", got[len(got)-60:])
	}
}

func TestWorkerReportOfIsEmptyForANilRunOrEvidence(t *testing.T) {
	for _, run := range []*waveobj.Run{nil, {}} {
		rep, unstructured := workerReportOf(run)
		if rep != (jarvis.WorkerReport{}) || unstructured != "" {
			t.Fatalf("want nothing for %+v, got %+v %q", run, rep, unstructured)
		}
		if lines := leadSectionLines("t-1", run); len(lines) != 0 {
			t.Fatalf("want no lines, got %q", lines)
		}
	}
}
