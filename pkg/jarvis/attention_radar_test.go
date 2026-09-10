// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// untriaged is a finding nobody has ruled on: no disposition, and a group that is still live. id and
// group are separate arguments on purpose — deriving one from the other made a fixture that silently
// tested the wrong thing.
func untriaged(id, group string) waveobj.RadarFinding {
	return waveobj.RadarFinding{ID: id, Group: group, Risk: "leaks", Severity: "high"}
}

func decided(id, group string) waveobj.RadarFinding {
	return waveobj.RadarFinding{
		ID:          id,
		Group:       group,
		Disposition: &waveobj.RadarDisposition{Action: "dismiss", Ts: 5},
	}
}

func report(oid, path, status string, findings ...waveobj.RadarFinding) *waveobj.RadarReport {
	return &waveobj.RadarReport{
		OID:         oid,
		ProjectName: "arc",
		ProjectPath: path,
		Status:      status,
		CompletedTs: 700,
		Findings:    findings,
	}
}

func triageItems(in AttentionInput) []string {
	var out []string
	for _, it := range BuildAttention(in) {
		if it.Kind == AttentionRadarTriage {
			out = append(out, it.Text)
		}
	}
	return out
}

func TestRadarTriageIsOneRowPerProjectNotPerFinding(t *testing.T) {
	// four findings, one row. The Brief's invariant is that nothing unbounded sits on the surface, and
	// a scan routinely produces dozens.
	in := AttentionInput{Radar: []*waveobj.RadarReport{
		report("r-1", "/a", "completed", untriaged("f1", "new"), untriaged("f2", "recurring"), untriaged("f3", "new"), untriaged("f4", "new")),
	}}
	got := triageItems(in)
	if len(got) != 1 {
		t.Fatalf("want one row for one project, got %d: %v", len(got), got)
	}
	if got[0] != "4 findings need triage." {
		t.Fatalf("count is not derived from the findings: %q", got[0])
	}
}

func TestRadarTriageCountsOnlyUndecidedLiveFindings(t *testing.T) {
	in := AttentionInput{Radar: []*waveobj.RadarReport{
		report("r-1", "/a",
			"completed",
			untriaged("f1", "new"),
			decided("f2", "new"),
			untriaged("f3", "nolonger"),
			untriaged("f4", "dismissed"),
			untriaged("f5", "suppressed"),
		),
	}}
	got := triageItems(in)
	if len(got) != 1 || got[0] != "1 finding needs triage." {
		t.Fatalf("want a singular row counting only the undecided live finding, got %v", got)
	}
}

func TestRadarTriageSkipsAFullyDecidedReport(t *testing.T) {
	in := AttentionInput{Radar: []*waveobj.RadarReport{
		report("r-1", "/a", "completed", decided("f1", "new"), untriaged("f2", "dismissed")),
	}}
	if got := triageItems(in); len(got) != 0 {
		t.Fatalf("nothing is waiting, so nothing should be reported: %v", got)
	}
}

// scan reconciliation carries an older report's live findings forward, so counting both would report
// the same risk twice. Reports arrive newest-first.
func TestRadarTriageUsesOnlyTheCurrentReportPerProject(t *testing.T) {
	in := AttentionInput{Radar: []*waveobj.RadarReport{
		report("r-new", "/a", "completed", untriaged("f1", "new")),
		report("r-old", "/a", "completed", untriaged("f1", "new"), untriaged("f2", "recurring")),
	}}
	got := triageItems(in)
	if len(got) != 1 || got[0] != "1 finding needs triage." {
		t.Fatalf("want only the newest report for the path, got %v", got)
	}
}

// a rescan in flight does not answer the last completed scan's findings, so it must not hide them.
func TestRadarTriageLooksPastAnInFlightRescan(t *testing.T) {
	in := AttentionInput{Radar: []*waveobj.RadarReport{
		report("r-live", "/a", "collecting"),
		report("r-done", "/a", "completed", untriaged("f1", "new")),
	}}
	if got := triageItems(in); len(got) != 1 {
		t.Fatalf("an in-flight rescan hid a completed scan's untriaged findings: %v", got)
	}
}

func TestRadarTriageIgnoresUntrustworthyScans(t *testing.T) {
	for _, status := range []string{"collecting", "clustering", "failed", "cancelled"} {
		in := AttentionInput{Radar: []*waveobj.RadarReport{report("r-1", "/a", status, untriaged("f1", "new"))}}
		if got := triageItems(in); len(got) != 0 {
			t.Fatalf("status %q should yield no triage row, got %v", status, got)
		}
	}
}

func TestRadarTriageReportsEachProjectSeparately(t *testing.T) {
	in := AttentionInput{Radar: []*waveobj.RadarReport{
		report("r-a", "/a", "completed", untriaged("f1", "new")),
		report("r-b", "/b", "completed", untriaged("f1", "new"), untriaged("f2", "recurring")),
	}}
	if got := triageItems(in); len(got) != 2 {
		t.Fatalf("want one row per project, got %v", got)
	}
}

// the row names no channel, so it can only be opened through the oref it carries.
func TestRadarTriageAddressesItsReportByORef(t *testing.T) {
	in := AttentionInput{Radar: []*waveobj.RadarReport{report("r-1", "/a", "completed", untriaged("f1", "new"))}}
	for _, it := range BuildAttention(in) {
		if it.Kind != AttentionRadarTriage {
			continue
		}
		if it.ORef != "radarreport:r-1" {
			t.Fatalf("triage row is unreachable: oref %q", it.ORef)
		}
		if it.ChannelId != "" {
			t.Fatalf("a scan belongs to a project, not a channel: %+v", it)
		}
		return
	}
	t.Fatal("no triage row produced")
}

// triage is the weakest claim in the list: an untriaged finding blocks nothing that is running.
func TestRadarTriageSortsBelowEveryOtherKind(t *testing.T) {
	in := AttentionInput{
		Radar: []*waveobj.RadarReport{report("r-1", "/a", "completed", untriaged("f1", "new"))},
		Dags:  []*waveobj.TaskGroup{dagWithStatus("awaiting-review")},
	}
	out := BuildAttention(in)
	if len(out) < 2 {
		t.Fatalf("expected a gate and a triage row, got %+v", out)
	}
	if out[len(out)-1].Kind != AttentionRadarTriage {
		t.Fatalf("triage is not last: %+v", out)
	}
	if !strings.HasPrefix(out[0].Kind, "dag-gate") {
		t.Fatalf("the gate lost its priority to triage: %+v", out)
	}
}
