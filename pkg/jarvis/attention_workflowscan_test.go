// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func scanRun(id, state, status string, verdicts ...string) *waveobj.Run {
	scan := &waveobj.WorkflowScan{State: state}
	for i, v := range verdicts {
		scan.Verdicts = append(scan.Verdicts, waveobj.WorkflowScanVerdict{Id: string(rune('A' + i)), Verdict: v})
	}
	return &waveobj.Run{ID: id, Status: status, CreatedTs: 700, WorkflowScan: scan}
}

func TestAttentionWorkflowScan(t *testing.T) {
	run := scanRun("scan1", waveobj.WorkflowScanState_Picking, RunStatus_Executing,
		waveobj.WorkflowScanVerdict_Suggest, waveobj.WorkflowScanVerdict_Covered, waveobj.WorkflowScanVerdict_Suggest)
	items := BuildAttention(AttentionInput{Channels: []AttentionChannel{{OID: "c1", Name: "alpha", Runs: []*waveobj.Run{run}}}})
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d: %+v", len(items), items)
	}
	got := items[0]
	if got.Kind != AttentionWorkflowScan || got.Key != "workflow-scan:scan1" || got.RunId != "scan1" ||
		got.ChannelId != "c1" || got.ChannelName != "alpha" || got.ORef != "workflowscan:scan1" ||
		got.Action != "Decide" || got.Text != "2 suggestions to decide" || got.Source != "Workflow scan" ||
		got.WaitingSince != 700 {
		t.Fatalf("wrong workflow-scan item: %+v", got)
	}

	for _, c := range []struct{ name, state, status string }{
		{"scanning", waveobj.WorkflowScanState_Scanning, RunStatus_Executing},
		{"applying", waveobj.WorkflowScanState_Applying, RunStatus_Executing},
		{"failed", waveobj.WorkflowScanState_Failed, RunStatus_Executing},
		{"done", waveobj.WorkflowScanState_Picking, RunStatus_Done},
		{"cancelled", waveobj.WorkflowScanState_Picking, RunStatus_Cancelled},
	} {
		r := scanRun("scan2", c.state, c.status, waveobj.WorkflowScanVerdict_Suggest)
		if got := BuildAttention(AttentionInput{Channels: []AttentionChannel{{OID: "c1", Runs: []*waveobj.Run{r}}}}); len(got) != 0 {
			t.Fatalf("%s: want no item, got %+v", c.name, got)
		}
	}
}

func TestAttentionWorkflowScanSitsWithTheAsks(t *testing.T) {
	scan := scanRun("scan1", waveobj.WorkflowScanState_Picking, RunStatus_Executing, waveobj.WorkflowScanVerdict_Suggest)
	held := heldRun("r1", "refactor auth", 500)
	items := BuildAttention(AttentionInput{Channels: []AttentionChannel{{OID: "c1", Runs: []*waveobj.Run{scan, held}}}})
	if len(items) != 2 || items[0].Kind != AttentionRunLandHeld || items[1].Kind != AttentionWorkflowScan {
		t.Fatalf("want the hold before the scan item, got %+v", items)
	}
}
