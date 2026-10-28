// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func storageTestReport() *wshrpc.StorageReportData {
	return &wshrpc.StorageReportData{
		ScanTs: time.Date(2026, 10, 28, 14, 2, 0, 0, time.UTC).UnixMilli(),
		Items: []wshrpc.StorageItem{
			{Id: "runtree:C:/wt/a", Kind: wshrpc.StorageKind_RunTree, Group: wshrpc.StorageGroup_Left, Size: 2048, Clearable: true, ProjectName: "arc", RunTitle: "fix x", RunStatus: "done"},
			{Id: "branch:C:/p:wave/b", Kind: wshrpc.StorageKind_Branch, Group: wshrpc.StorageGroup_Left, Skip: wshrpc.StorageSkip_Commits, OnlyCount: 1, Branch: "wave/b", BranchTip: "0123456789abcdef",
				OnlyCommits: []wshrpc.StorageCommit{{Sha: "0123456789abcdef", Subject: "feat: half done"}}},
			{Id: "runtree:C:/wt/c", Kind: wshrpc.StorageKind_RunTree, Group: wshrpc.StorageGroup_Left, Size: 3 << 30, Skip: wshrpc.StorageSkip_Dirty, Dirty: 2},
			{Id: "runtree:C:/wt/live", Kind: wshrpc.StorageKind_RunTree, Group: wshrpc.StorageGroup_InUse, Size: 10, Clearable: false, RunStatus: "running"},
			{Id: "transcripts:claude", Kind: wshrpc.StorageKind_Transcripts, Group: wshrpc.StorageGroup_Kept, Size: 5 << 20},
		},
	}
}

func TestStorageClearableIdsTakesOnlyLeftOverClearableRows(t *testing.T) {
	r := storageTestReport()
	r.Items = append(r.Items, wshrpc.StorageItem{Id: "kept-but-flagged", Group: wshrpc.StorageGroup_Kept, Clearable: true})
	got := storageClearableIds(r)
	if !slices.Equal(got, []string{"runtree:C:/wt/a"}) {
		t.Fatalf("got %v", got)
	}
}

func TestFormatStorageSize(t *testing.T) {
	cases := map[int64]string{0: "0 B", 1023: "1023 B", 1024: "1.0 KB", 1536: "1.5 KB", 3 << 30: "3.0 GB"}
	for n, want := range cases {
		if got := formatStorageSize(n); got != want {
			t.Errorf("%d: got %q, want %q", n, got, want)
		}
	}
}

func TestFormatStorageReportGroupsRowsAndSaysWhyEachIsOrIsNotClearable(t *testing.T) {
	out := formatStorageReport(storageTestReport(), time.UTC)
	for _, want := range []string{
		"scanned 2026-10-28 14:02",
		"left over: 3 row(s), 3.0 GB, 2.0 KB clearable",
		"clearable, project arc, run \"fix x\" (done)",
		"1 unmerged commit(s), branch wave/b, tip 0123456789abcdef",
		"      01234567 feat: half done",
		"2 uncommitted file(s)",
		"in use: 1 row(s)",
		"kept: 1 row(s), 5.0 MB",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	left, inuse, kept := strings.Index(out, "left over:"), strings.Index(out, "in use:"), strings.Index(out, "kept:")
	if !(left < inuse && inuse < kept) {
		t.Errorf("groups out of order:\n%s", out)
	}
	// largest first within a group
	if strings.Index(out, "runtree:C:/wt/c") > strings.Index(out, "runtree:C:/wt/a") {
		t.Errorf("left over rows not sorted by size:\n%s", out)
	}
}

func TestFormatStorageReportShortensLongRunTitles(t *testing.T) {
	r := storageTestReport()
	r.Items[0].RunTitle = strings.Repeat("goal ", 100)
	out := formatStorageReport(r, time.UTC)
	if strings.Contains(out, strings.Repeat("goal ", 20)) || !strings.Contains(out, "...\" (done)") {
		t.Fatalf("long run title not shortened:\n%s", out)
	}
}

func TestFormatStorageReportNeverScanned(t *testing.T) {
	out := formatStorageReport(&wshrpc.StorageReportData{}, time.UTC)
	if !strings.HasPrefix(out, "never scanned\n") {
		t.Fatalf("got %q", out)
	}
}

func TestFormatStorageClearReportsOnlyTheRowsItWasGiven(t *testing.T) {
	r := &wshrpc.StorageReportData{
		LastClear: &wshrpc.StorageClearResult{Cleared: 2, Freed: 2048},
		Items: []wshrpc.StorageItem{
			{Id: "a", ClearState: wshrpc.StorageClear_Skipped, ClearError: "the branch moved since you looked"},
			{Id: "b", ClearState: wshrpc.StorageClear_Failed, ClearError: "access denied", ClearHeld: true},
			{Id: "older", ClearState: wshrpc.StorageClear_Failed, ClearError: "from an earlier clear"},
		},
	}
	out := formatStorageClear(r, []string{"a", "b"})
	for _, want := range []string{
		"cleared 2 row(s), freed 2.0 KB",
		"skipped a: the branch moved since you looked",
		"failed b: access denied\n  a process holds it open",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "older") {
		t.Errorf("reported a row outside this clear:\n%s", out)
	}
}
