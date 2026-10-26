// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package workflowscan

import (
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	maxEditAdds    = 3
	maxEditRemoves = 3
)

// ValidateVerdicts checks the scan agent's result: one verdict per survivor, each well formed. Its errors name
// the id, so the agent can fix its file and resend.
func ValidateVerdicts(survivors []waveobj.WorkflowScanPattern, vs []waveobj.WorkflowScanVerdict) error {
	known := map[string]bool{}
	for _, s := range survivors {
		known[s.Id] = true
	}
	seen := map[string]bool{}
	for _, v := range vs {
		if !known[v.Id] {
			return fmt.Errorf("verdict %q: no survivor has that id", v.Id)
		}
		if seen[v.Id] {
			return fmt.Errorf("verdict %q: given twice; send one verdict per survivor", v.Id)
		}
		seen[v.Id] = true
		if err := checkVerdict(v); err != nil {
			return fmt.Errorf("verdict %q: %w", v.Id, err)
		}
	}
	for _, s := range survivors {
		if !seen[s.Id] {
			return fmt.Errorf("verdict %q: missing; send one verdict per survivor", s.Id)
		}
	}
	return nil
}

func blank(s string) bool {
	return strings.TrimSpace(s) == ""
}

func checkVerdict(v waveobj.WorkflowScanVerdict) error {
	switch v.Verdict {
	case waveobj.WorkflowScanVerdict_Suggest:
		for _, f := range []struct{ name, val string }{{"file", v.File}, {"where", v.Where}, {"fixproject", v.FixProject}} {
			if blank(f.val) {
				return fmt.Errorf("a suggest needs a %s", f.name)
			}
		}
		return checkEdit(v.Edit)
	case waveobj.WorkflowScanVerdict_Covered:
		if blank(v.Note) {
			return fmt.Errorf("a covered verdict needs a note naming the commit or file that covers it")
		}
	case waveobj.WorkflowScanVerdict_Declined:
		if v.DeclinedAt <= 0 {
			return fmt.Errorf("a declined verdict needs declinedat, the verified runs its Declined entry recorded")
		}
	default:
		return fmt.Errorf("verdict is %q; want suggest, covered or declined", v.Verdict)
	}
	return nil
}

func checkEdit(edit string) error {
	adds, removes := 0, 0
	for l := range strings.SplitSeq(edit, "\n") {
		switch {
		case blank(l):
		case strings.HasPrefix(l, "+"):
			adds++
		case strings.HasPrefix(l, "-"):
			removes++
		default:
			return fmt.Errorf("edit line %q is neither + nor -", l)
		}
	}
	if adds < 1 || adds > maxEditAdds {
		return fmt.Errorf("the edit has %d + lines; want 1 to %d", adds, maxEditAdds)
	}
	if removes > maxEditRemoves {
		return fmt.Errorf("the edit has %d - lines; want at most %d", removes, maxEditRemoves)
	}
	return nil
}

// ValidatePicks checks the owner's picks: each names a suggestion once, apply only where the fix is in the scan's
// own project, and drop with a reason, since the Declined entry is built from it.
func ValidatePicks(scan *waveobj.WorkflowScan, picks []waveobj.WorkflowScanPick) error {
	if scan == nil {
		return fmt.Errorf("not a workflow scan")
	}
	if len(picks) == 0 {
		return fmt.Errorf("no picks to send")
	}
	suggests := map[string]waveobj.WorkflowScanVerdict{}
	for _, v := range scan.Verdicts {
		if v.Verdict == waveobj.WorkflowScanVerdict_Suggest {
			suggests[v.Id] = v
		}
	}
	seen := map[string]bool{}
	for _, p := range picks {
		v, ok := suggests[p.Id]
		if !ok {
			return fmt.Errorf("pick %q: not a suggestion of this scan", p.Id)
		}
		if seen[p.Id] {
			return fmt.Errorf("pick %q: picked twice", p.Id)
		}
		seen[p.Id] = true
		switch p.Pick {
		case waveobj.WorkflowScanPick_Apply:
			if !strings.EqualFold(strings.TrimSpace(v.FixProject), strings.TrimSpace(scan.Project)) {
				return fmt.Errorf("pick %q: the fix is in %s, not %s; copy it there instead", p.Id, v.FixProject, scan.Project)
			}
		case waveobj.WorkflowScanPick_Drop:
			if blank(p.Reason) {
				return fmt.Errorf("pick %q: a drop needs a reason", p.Id)
			}
		default:
			return fmt.Errorf("pick %q: pick is %q; want apply or drop", p.Id, p.Pick)
		}
	}
	return nil
}
