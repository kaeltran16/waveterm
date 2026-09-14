// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestInvestigationFromRunExecutingHasNoEvidence(t *testing.T) {
	run := &waveobj.Run{ID: "r1", CreatedTs: 100}
	inv := InvestigationFromRun(run, "chan1", "executing", 100)
	if inv.RunID != "r1" || inv.ChannelID != "chan1" || inv.Status != "executing" {
		t.Fatalf("identity fields wrong: %+v", inv)
	}
	if inv.StartedTs != 100 || inv.CompletedTs != 0 {
		t.Fatalf("executing must set StartedTs, not CompletedTs: %+v", inv)
	}
	if inv.FilesTouched != 0 || inv.VerifsPass != 0 {
		t.Fatalf("executing must have no evidence stats: %+v", inv)
	}
}

func TestInvestigationFromRunDoneDenormalizesEvidence(t *testing.T) {
	run := &waveobj.Run{
		ID: "r1", CreatedTs: 100,
		Evidence: &waveobj.RunEvidence{
			Summary:  "fixed the gap",
			Files:    []waveobj.EvidenceFile{{Path: "a.go"}, {Path: "b.go"}},
			AddTotal: 12, DelTotal: 3,
			Verifs: []waveobj.EvidenceVerif{{Result: "pass"}, {Result: "fail"}, {Result: "pass"}, {Result: "unknown"}},
		},
	}
	inv := InvestigationFromRun(run, "chan1", "done", 500)
	if inv.Status != "done" || inv.CompletedTs != 500 {
		t.Fatalf("done must set CompletedTs: %+v", inv)
	}
	if inv.Summary != "fixed the gap" || inv.FilesTouched != 2 || inv.AddTotal != 12 || inv.DelTotal != 3 {
		t.Fatalf("evidence denorm wrong: %+v", inv)
	}
	if inv.VerifsPass != 2 || inv.VerifsFail != 1 {
		t.Fatalf("verif counts wrong (pass=2 fail=1): %+v", inv)
	}
}

func TestRecordInvestigationWritesByFingerprint(t *testing.T) {
	ctx := context.Background()
	pp := canonPath("/repos/pay")
	rpt, _ := wstore.CreateRadarReport(ctx, "pay", pp)
	wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) {
		r.Status = StatusCompleted
		r.Findings = []waveobj.RadarFinding{{ID: "f1", Fingerprint: "RAD-abc", Group: GroupNew}}
	})
	inv := waveobj.RadarInvestigation{RunID: "r1", ChannelID: "chan1", Status: "done", FilesTouched: 2}
	if err := RecordInvestigation(ctx, pp, "RAD-abc", inv); err != nil {
		t.Fatalf("record: %v", err)
	}
	got, _ := wstore.GetRadarReport(ctx, rpt.OID)
	if got.Findings[0].Investigation == nil || got.Findings[0].Investigation.RunID != "r1" {
		t.Fatalf("investigation must be written, got %+v", got.Findings[0].Investigation)
	}
}

func TestRecordInvestigationNoopOnAbsentFingerprint(t *testing.T) {
	ctx := context.Background()
	pp := canonPath("/repos/nofp")
	rpt, _ := wstore.CreateRadarReport(ctx, "nofp", pp)
	wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) {
		r.Status = StatusCompleted
		r.Findings = []waveobj.RadarFinding{{ID: "f1", Fingerprint: "RAD-here", Group: GroupNew}}
	})
	if err := RecordInvestigation(ctx, pp, "RAD-missing", waveobj.RadarInvestigation{RunID: "r9"}); err != nil {
		t.Fatalf("absent fingerprint must be a no-op, not an error: %v", err)
	}
	got, _ := wstore.GetRadarReport(ctx, rpt.OID)
	if got.Findings[0].Investigation != nil {
		t.Fatalf("no finding should have been mutated, got %+v", got.Findings[0].Investigation)
	}
}

// An investigation whose terminal write-back never landed must settle from its run, or from the run's
// absence, instead of reading "Investigating" forever.
func TestRefreshInvestigationsSettlesFromRun(t *testing.T) {
	ctx := context.Background()
	doneID := "bbbbbbbb-0000-0000-0000-000000000001"
	run := &waveobj.Run{OID: doneID, ID: doneID, Status: "done", CreatedTs: 100, CompletedTs: 700,
		Evidence: &waveobj.RunEvidence{Summary: "fixed", Files: []waveobj.EvidenceFile{{Path: "a.go"}}}, Meta: make(waveobj.MetaMapType)}
	if err := wstore.DBInsert(ctx, run); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	executing := &waveobj.RadarInvestigation{RunID: doneID, ChannelID: "chan1", Status: "executing", StartedTs: 100}
	findings := []waveobj.RadarFinding{
		{Fingerprint: "RAD-done", Investigation: executing},
		{Fingerprint: "RAD-gone", Investigation: &waveobj.RadarInvestigation{RunID: "bbbbbbbb-0000-0000-0000-00000000dead", Status: "executing"}},
	}
	refreshInvestigations(ctx, findings)

	if inv := findings[0].Investigation; inv.Status != "done" || inv.CompletedTs != 700 || inv.FilesTouched != 1 || inv.ChannelID != "chan1" {
		t.Fatalf("a finished run must settle its investigation with evidence, got %+v", inv)
	}
	if executing.Status != "executing" {
		t.Fatal("refresh must replace the record, not mutate one other findings may share")
	}
	if inv := findings[1].Investigation; inv.Status != InvestigationOrphaned || inv.CompletedTs == 0 {
		t.Fatalf("a missing run must orphan its investigation, got %+v", inv)
	}
}

func TestRecordInvestigationNoopWhenNoReport(t *testing.T) {
	ctx := context.Background()
	if err := RecordInvestigation(ctx, canonPath("/repos/never-scanned"), "RAD-x", waveobj.RadarInvestigation{RunID: "r1"}); err != nil {
		t.Fatalf("no report must be a no-op, not an error: %v", err)
	}
}
