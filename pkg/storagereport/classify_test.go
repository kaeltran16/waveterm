// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestClassify(t *testing.T) {
	const runID = "0d1f6a52-0000-4000-8000-000000000001"
	cases := []struct {
		name      string
		item      wshrpc.StorageItem
		group     string
		clearable bool
		skip      string
	}{
		{"a final slot is kept", wshrpc.StorageItem{Kind: wshrpc.StorageKind_FinalSlot, Slot: 1}, wshrpc.StorageGroup_Kept, false, ""},
		{"final stores are kept", wshrpc.StorageItem{Kind: wshrpc.StorageKind_FinalStores}, wshrpc.StorageGroup_Kept, false, ""},
		{"final shots are kept", wshrpc.StorageItem{Kind: wshrpc.StorageKind_FinalShots}, wshrpc.StorageGroup_Kept, false, ""},
		{"transcripts are kept", wshrpc.StorageItem{Kind: wshrpc.StorageKind_Transcripts, Harness: "claude"}, wshrpc.StorageGroup_Kept, false, ""},
		{"kept wins over a live run", wshrpc.StorageItem{Kind: wshrpc.StorageKind_FinalSlot, RunId: runID, RunStatus: "executing"}, wshrpc.StorageGroup_Kept, false, ""},
		{"an executing run is in use", wshrpc.StorageItem{Kind: wshrpc.StorageKind_RunTree, RunId: runID, RunStatus: "executing"}, wshrpc.StorageGroup_InUse, false, ""},
		{"a blocked run is in use", wshrpc.StorageItem{Kind: wshrpc.StorageKind_RunTree, RunId: runID, RunStatus: "blocked"}, wshrpc.StorageGroup_InUse, false, ""},
		{"a planning run's branch is in use", wshrpc.StorageItem{Kind: wshrpc.StorageKind_Branch, RunId: runID, RunStatus: "planning"}, wshrpc.StorageGroup_InUse, false, ""},
		{"in use wins over uncommitted files", wshrpc.StorageItem{Kind: wshrpc.StorageKind_RunTree, RunId: runID, RunStatus: "awaiting-review", Dirty: 3}, wshrpc.StorageGroup_InUse, false, ""},
		{"a run whose row could not be read", wshrpc.StorageItem{Kind: wshrpc.StorageKind_RunTree, RunId: runID}, wshrpc.StorageGroup_Left, false, wshrpc.StorageSkip_Unreadable},
		{"a done run whose git state could not be read", wshrpc.StorageItem{Kind: wshrpc.StorageKind_RunTree, RunId: runID, RunStatus: "done", Skip: wshrpc.StorageSkip_Unreadable}, wshrpc.StorageGroup_Left, false, wshrpc.StorageSkip_Unreadable},
		{"a no-run folder whose git state could not be read", wshrpc.StorageItem{Kind: wshrpc.StorageKind_RunTree, Tracked: true, Skip: wshrpc.StorageSkip_Unreadable}, wshrpc.StorageGroup_Left, false, wshrpc.StorageSkip_Unreadable},
		{"a done run with uncommitted files", wshrpc.StorageItem{Kind: wshrpc.StorageKind_RunTree, RunId: runID, RunStatus: "done", Tracked: true, HasGit: true, Dirty: 2}, wshrpc.StorageGroup_Left, false, wshrpc.StorageSkip_Dirty},
		{"dirty wins over commits", wshrpc.StorageItem{Kind: wshrpc.StorageKind_RunTree, RunId: runID, RunStatus: "done", Dirty: 1, OnlyCount: 4}, wshrpc.StorageGroup_Left, false, wshrpc.StorageSkip_Dirty},
		{"a done run with a held land and unique commits", wshrpc.StorageItem{Kind: wshrpc.StorageKind_Branch, RunId: runID, RunStatus: "done", RunLandState: "held", OnlyCount: 2}, wshrpc.StorageGroup_Left, false, wshrpc.StorageSkip_Commits},
		{"a cancelled run that loses nothing", wshrpc.StorageItem{Kind: wshrpc.StorageKind_RunTree, RunId: runID, RunStatus: "cancelled", Tracked: true, HasGit: true}, wshrpc.StorageGroup_Left, true, ""},
		{"a done run's branch on another branch", wshrpc.StorageItem{Kind: wshrpc.StorageKind_Branch, RunId: runID, RunStatus: "done", AlsoOn: "main"}, wshrpc.StorageGroup_Left, true, ""},
		{"a no-run untracked folder", wshrpc.StorageItem{Kind: wshrpc.StorageKind_RunTree}, wshrpc.StorageGroup_Left, true, ""},
		{"a legacy group", wshrpc.StorageItem{Kind: wshrpc.StorageKind_LegacyGroup, Count: 16, RunCount: 9}, wshrpc.StorageGroup_Left, true, ""},
		{"hand-run final output", wshrpc.StorageItem{Kind: wshrpc.StorageKind_FinalOut, Count: 21}, wshrpc.StorageGroup_Left, true, ""},
		{"a stale clearable flag is recomputed", wshrpc.StorageItem{Kind: wshrpc.StorageKind_RunTree, RunId: runID, RunStatus: "executing", Clearable: true, Group: wshrpc.StorageGroup_Left}, wshrpc.StorageGroup_InUse, false, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			item := c.item
			classify(&item)
			if item.Group != c.group || item.Clearable != c.clearable || item.Skip != c.skip {
				t.Fatalf("got group %q clearable %v skip %q, want %q %v %q", item.Group, item.Clearable, item.Skip, c.group, c.clearable, c.skip)
			}
		})
	}
}
