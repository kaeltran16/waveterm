// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import "github.com/wavetermdev/waveterm/pkg/wshrpc"

var keptKinds = map[string]bool{
	wshrpc.StorageKind_FinalSlot:   true,
	wshrpc.StorageKind_FinalStores: true,
	wshrpc.StorageKind_FinalShots:  true,
	wshrpc.StorageKind_Transcripts: true,
}

func runFinished(status string) bool {
	return status == "done" || status == "cancelled"
}

// classify sets Group, Clearable and Skip from the item's facts. A Skip of unreadable on the way in is a fact the
// scan set (git state it could not read); a RunId without a RunStatus is a run row it could not read.
func classify(item *wshrpc.StorageItem) {
	unreadable := item.Skip == wshrpc.StorageSkip_Unreadable || (item.RunId != "" && item.RunStatus == "")
	item.Clearable, item.Skip = false, ""
	switch {
	case keptKinds[item.Kind]:
		item.Group = wshrpc.StorageGroup_Kept
	case item.RunStatus != "" && !runFinished(item.RunStatus):
		item.Group = wshrpc.StorageGroup_InUse
	case unreadable:
		item.Group, item.Skip = wshrpc.StorageGroup_Left, wshrpc.StorageSkip_Unreadable
	case item.Dirty > 0:
		item.Group, item.Skip = wshrpc.StorageGroup_Left, wshrpc.StorageSkip_Dirty
	case item.OnlyCount > 0:
		item.Group, item.Skip = wshrpc.StorageGroup_Left, wshrpc.StorageSkip_Commits
	default:
		item.Group, item.Clearable = wshrpc.StorageGroup_Left, true
	}
}
