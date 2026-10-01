// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
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

func TestTaskCaveatsListTheWorkersThenTheReviewers(t *testing.T) {
	done := &waveobj.TaskNode{ID: "t-1", State: TaskState_Done, ReviewUnverified: "no screenshot"}
	structured := &waveobj.Run{Evidence: &waveobj.RunEvidence{Summary: caveatTestReport}}
	legacy := &waveobj.Run{Evidence: &waveobj.RunEvidence{Summary: " Added fmtDate. \n"}}
	cases := []struct {
		name   string
		task   *waveobj.TaskNode
		worker *waveobj.Run
		want   []string
	}{
		{"structured", done, structured, []string{"The CRLF path has no test.", "reviewer: no screenshot"}},
		{"legacy", done, legacy, []string{"Added fmtDate.", "reviewer: no screenshot"}},
		{"no worker run", done, nil, []string{"reviewer: no screenshot"}},
		{"nothing unverified", &waveobj.TaskNode{ID: "t-1", State: TaskState_Done}, &waveobj.Run{Evidence: &waveobj.RunEvidence{Summary: digestTestReport}}, nil},
		{"did not land", &waveobj.TaskNode{ID: "t-1", State: TaskState_Skipped, ReviewUnverified: "x"}, structured, nil},
	}
	for _, c := range cases {
		if got := taskCaveats(c.task, c.worker); !slices.Equal(got, c.want) {
			t.Errorf("%s: want %q, got %q", c.name, c.want, got)
		}
	}
}

// caveatDag stores a landed dag whose workers left caveats: t-1 a structured report and a reviewer's addition, t-2
// a legacy report, t-3 skipped. The final stage and the verifier read the workers' runs from the store.
func caveatDag(t *testing.T) (context.Context, *waveobj.TaskGroup) {
	t.Helper()
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "caveats-"+uuid.NewString(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for id, summary := range map[string]string{"w-1": caveatTestReport, "w-2": "Added fmtDate; did not run the e2e.", "w-3": caveatTestReport} {
		run := waveobj.Run{ID: id + "-" + ch.OID, Status: jarvis.RunStatus_Done, Evidence: &waveobj.RunEvidence{Summary: summary}}
		if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
			t.Fatal(err)
		}
	}
	g := &waveobj.TaskGroup{RunID: "run-1", ChannelId: ch.OID, Tasks: []waveobj.TaskNode{
		{ID: "t-1", Label: "a", State: TaskState_Done, RunID: "w-1-" + ch.OID, ReviewUnverified: "no screenshot"},
		{ID: "t-2", Label: "b", State: TaskState_Done, RunID: "w-2-" + ch.OID},
		{ID: "t-3", Label: "c", State: TaskState_Skipped, RunID: "w-3-" + ch.OID},
	}}
	return ctx, g
}

var caveatDagLines = []string{
	"t-1: The CRLF path has no test.",
	"t-1: reviewer: no screenshot",
	"t-2: Added fmtDate; did not run the e2e.",
}
