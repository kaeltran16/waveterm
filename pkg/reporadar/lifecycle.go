// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// reconcile classifies the current scan's validated findings against the previous successful report
// and carries dismissal/suppression forward:
//   - fingerprint absent in prev        -> New
//   - prev open (new/recurring/nolonger)-> Recurring
//   - prev Suppressed                   -> stays Suppressed (same kind+subsystem => same fp)
//   - prev Dismissed, newer evidence     -> Recurring (reopened); else stays Dismissed
//   - prev-open fingerprint absent now   -> a No-longer-detected entry (carried from prev)
//
// "No longer detected" never means fixed — it means the supporting evidence disappeared.
// evidenceTs maps a finding's fingerprint to the newest supporting signal's ObservedTs (resolved by
// the scan wiring); it gates dismissal reopen without a shared mutable global.
func reconcile(projectPath string, current []waveobj.RadarFinding, prev *waveobj.RadarReport, evidenceTs map[string]int64) []waveobj.RadarFinding {
	prevByFP := map[string]waveobj.RadarFinding{}
	if prev != nil {
		for _, f := range prev.Findings {
			prevByFP[f.Fingerprint] = f
		}
	}
	currentFPs := map[string]bool{}
	var out []waveobj.RadarFinding
	for _, f := range current {
		currentFPs[f.Fingerprint] = true
		p, existed := prevByFP[f.Fingerprint]
		if !existed {
			f.Group = GroupNew
			out = append(out, f)
			continue
		}
		f.Investigation = p.Investigation // carry the loop's outcome forward, like Disposition (independent of it)
		switch p.Group {
		case GroupSuppressed:
			f.Group = GroupSuppressed
			f.Disposition = p.Disposition
		case GroupDismissed:
			if p.Disposition != nil && evidenceTs[f.Fingerprint] > p.Disposition.Ts {
				f.Group = GroupRecurring // newer canonical evidence reopens it
			} else {
				f.Group = GroupDismissed
				f.Disposition = p.Disposition
			}
		default: // new/recurring/nolonger were open
			f.Group = GroupRecurring
		}
		out = append(out, f)
	}
	// prev-open fingerprints that vanished -> No longer detected (carried from prev)
	if prev != nil {
		for _, p := range prev.Findings {
			if currentFPs[p.Fingerprint] {
				continue
			}
			if p.Group == GroupNew || p.Group == GroupRecurring {
				p.Group = GroupNoLonger
				out = append(out, p)
			}
		}
	}
	return out
}

// assignFindingIDs stamps report-unique, deterministic ids onto the final finding set. A finding id is a
// within-report handle the frontend keys selection and disposition on; it is NOT the cross-scan identity
// (that is the fingerprint). Per-lens numbering can't be unique — correctness/security/debt each number
// f1.. independently and then merge, and reconcile carries findings forward from the prior report with
// their old ids — so the whole reconciled set is renumbered here, once.
func assignFindingIDs(findings []waveobj.RadarFinding) []waveobj.RadarFinding {
	for i := range findings {
		findings[i].ID = fmt.Sprintf("f%d", i+1)
	}
	return findings
}

// SetDisposition atomically applies a disposition to one finding in a report:
//   dismiss     -> group=dismissed, records reason/note/ts
//   suppress    -> group=suppressed, records reason/note/ts
//   reopen      -> clears a dismissal, group=new
//   unsuppress  -> clears a suppression, group=new
func SetDisposition(ctx context.Context, reportId, findingId, action, reason, note string) error {
	return wstore.UpdateRadarReport(ctx, reportId, func(r *waveobj.RadarReport) {
		for i := range r.Findings {
			if r.Findings[i].ID != findingId {
				continue
			}
			switch action {
			case "dismiss":
				r.Findings[i].Group = GroupDismissed
				r.Findings[i].Disposition = &waveobj.RadarDisposition{Action: "dismiss", Reason: reason, Note: note, Ts: nowMilli()}
			case "suppress":
				r.Findings[i].Group = GroupSuppressed
				r.Findings[i].Disposition = &waveobj.RadarDisposition{Action: "suppress", Reason: reason, Note: note, Ts: nowMilli()}
			case "reopen", "unsuppress":
				r.Findings[i].Group = GroupNew
				r.Findings[i].Disposition = nil
			}
			return
		}
	})
}

// ApplyDisposition validates the action, applies it, and publishes the report update. It is the
// entry point the wshrpc command calls.
func ApplyDisposition(ctx context.Context, reportId, findingId, action, reason, note string) error {
	switch action {
	case "dismiss", "suppress", "reopen", "unsuppress":
	default:
		return fmt.Errorf("unknown disposition action %q", action)
	}
	if err := SetDisposition(ctx, reportId, findingId, action, reason, note); err != nil {
		return err
	}
	publish(reportId)
	return nil
}
