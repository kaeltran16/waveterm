// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"fmt"
	"log"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// InvestigationFromRun builds a finding investigation record from a run's state. For a terminal status
// (done/cancelled/failed) it sets CompletedTs and, when the run has sealed evidence, denormalizes the
// essentials so the finding is self-contained. For "executing" it records only identity + StartedTs.
func InvestigationFromRun(run *waveobj.Run, channelId, status string, ts int64) waveobj.RadarInvestigation {
	inv := waveobj.RadarInvestigation{
		RunID:     run.ID,
		ChannelID: channelId,
		Status:    status,
		StartedTs: run.CreatedTs,
	}
	if status != "executing" {
		inv.CompletedTs = ts
	}
	if ev := run.Evidence; ev != nil {
		inv.Summary = ev.Summary
		inv.FilesTouched = len(ev.Files)
		inv.AddTotal = ev.AddTotal
		inv.DelTotal = ev.DelTotal
		for _, v := range ev.Verifs {
			switch v.Result {
			case "pass":
				inv.VerifsPass++
			case "fail":
				inv.VerifsFail++
			}
		}
	}
	return inv
}

// RecordInvestigation writes/overwrites the latest Run outcome onto the finding identified by fingerprint in
// the NEWEST completed/partial report for projectPath. Reports rotate and findings carry forward by
// fingerprint (see reconcile), so the origin's ReportID/FindingID are not used — only the fingerprint. A
// missing report or absent fingerprint is a logged no-op: a Run command must never fail because a finding
// moved or was pruned. Only a real DB error propagates.
func RecordInvestigation(ctx context.Context, projectPath, fingerprint string, inv waveobj.RadarInvestigation) error {
	rpt := latestSuccessful(ctx, canonPath(projectPath))
	if rpt == nil {
		log.Printf("radar: no report for %q; skipping investigation writeback for %s", projectPath, fingerprint)
		return nil
	}
	found := false
	err := wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) {
		for i := range r.Findings {
			if r.Findings[i].Fingerprint == fingerprint {
				r.Findings[i].Investigation = &inv
				found = true
				return
			}
		}
	})
	if err != nil {
		return fmt.Errorf("recording investigation: %w", err)
	}
	if !found {
		log.Printf("radar: fingerprint %s not in report %s; investigation not recorded", fingerprint, rpt.OID)
		return nil
	}
	publish(rpt.OID)
	return nil
}
