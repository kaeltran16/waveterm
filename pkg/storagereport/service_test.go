// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const jobTimeout = 5 * time.Second

// useService gives the test a fresh service whose result file lives in its own temp dir, and returns that dir.
func useService(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	resetForTest(dir)
	prevScan, prevClear := scanFn, clearFn
	t.Cleanup(func() {
		waitIdle(t)
		scanFn, clearFn = prevScan, prevClear
	})
	return dir
}

func waitIdle(t *testing.T) *wshrpc.StorageReportData {
	t.Helper()
	deadline := time.Now().Add(jobTimeout)
	for {
		snap := Snapshot()
		if !snap.Scanning && !snap.Clearing {
			return snap
		}
		if time.Now().After(deadline) {
			t.Fatal("the storage job never finished")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// seed runs a scan that finds items and waits for it.
func seed(t *testing.T, items ...wshrpc.StorageItem) *wshrpc.StorageReportData {
	t.Helper()
	scanFn = func(context.Context) ([]wshrpc.StorageItem, []wshrpc.StorageScanError, error) {
		return items, nil, nil
	}
	if err := StartScan(); err != nil {
		t.Fatal(err)
	}
	return waitIdle(t)
}

func leftItem(id string, size int64) wshrpc.StorageItem {
	return wshrpc.StorageItem{Id: id, Kind: wshrpc.StorageKind_RunTree, Group: wshrpc.StorageGroup_Left, Path: id, Size: size, Clearable: true}
}

func itemIds(items []wshrpc.StorageItem) []string {
	var ids []string
	for _, item := range items {
		ids = append(ids, item.Id)
	}
	return ids
}

func TestServiceScanKeepsTheOldResultWhileScanning(t *testing.T) {
	useService(t)
	old := seed(t, leftItem("a", 1))
	if old.ScanTs == 0 {
		t.Fatal("a finished scan must set ScanTs")
	}

	release := make(chan struct{})
	scanFn = func(context.Context) ([]wshrpc.StorageItem, []wshrpc.StorageScanError, error) {
		<-release
		return []wshrpc.StorageItem{leftItem("b", 2)}, []wshrpc.StorageScanError{{ProjectName: "p", ProjectPath: "/p", Error: "gone"}}, nil
	}
	if err := StartScan(); err != nil {
		t.Fatal(err)
	}
	snap := Snapshot()
	if !snap.Scanning || snap.ScanStartTs == 0 || snap.ScanTs != old.ScanTs || len(snap.Items) != 1 || snap.Items[0].Id != "a" {
		t.Fatalf("while scanning the snapshot must keep the old result: %+v", snap)
	}
	if err := StartClear([]string{"a"}); !errors.Is(err, ErrBusy) {
		t.Fatalf("StartClear during a scan = %v, want ErrBusy", err)
	}
	if err := StartScan(); !errors.Is(err, ErrBusy) {
		t.Fatalf("StartScan during a scan = %v, want ErrBusy", err)
	}
	close(release)

	snap = waitIdle(t)
	if got := itemIds(snap.Items); len(got) != 1 || got[0] != "b" || len(snap.Errors) != 1 || snap.ScanStartTs != 0 {
		t.Fatalf("the finished scan must replace the result: %+v", snap)
	}
}

func TestServiceFailedScanKeepsTheResult(t *testing.T) {
	useService(t)
	old := seed(t, leftItem("a", 1))
	scanFn = func(context.Context) ([]wshrpc.StorageItem, []wshrpc.StorageScanError, error) {
		return nil, nil, errors.New("boom")
	}
	if err := StartScan(); err != nil {
		t.Fatal(err)
	}
	snap := waitIdle(t)
	if snap.JobError == "" || snap.ScanTs != old.ScanTs || len(snap.Items) != 1 {
		t.Fatalf("a failed scan must keep the result and say so: %+v", snap)
	}
}

func TestServiceClearMarksEachRow(t *testing.T) {
	dir := useService(t)
	seed(t, leftItem("cleared", 100), leftItem("held", 200), leftItem("changed", 300))

	var sawClearing bool
	clearFn = func(_ context.Context, item wshrpc.StorageItem, force bool, tip string) (int64, error) {
		if force || tip != "" {
			t.Errorf("Clear must not force: force=%v tip=%q", force, tip)
		}
		for _, row := range Snapshot().Items {
			if row.Id == item.Id && row.ClearState == wshrpc.StorageClear_Clearing {
				sawClearing = true
			}
		}
		switch item.Id {
		case "cleared":
			return item.Size, nil
		case "held":
			return 0, &ClearError{Msg: "a process has it open", Held: true}
		}
		return 0, &ClearError{Msg: "its run is executing again", Skipped: true}
	}
	if err := StartClear([]string{"cleared", "held", "changed"}); err != nil {
		t.Fatal(err)
	}
	snap := waitIdle(t)
	if !sawClearing {
		t.Error("a row being cleared must read as clearing")
	}
	assertClearResult(t, snap)

	// the result persists, with the rows' states and the clear's totals
	resetForTest(dir)
	assertClearResult(t, Snapshot())
}

func assertClearResult(t *testing.T, snap *wshrpc.StorageReportData) {
	t.Helper()
	if len(snap.Items) != 2 {
		t.Fatalf("the cleared row must leave the result, have %v", itemIds(snap.Items))
	}
	held, changed := snap.Items[0], snap.Items[1]
	if held.Id != "held" || held.ClearState != wshrpc.StorageClear_Failed || !held.ClearHeld || held.ClearError == "" {
		t.Errorf("held row = %+v, want failed and held", held)
	}
	if changed.Id != "changed" || changed.ClearState != wshrpc.StorageClear_Skipped || changed.ClearError == "" {
		t.Errorf("changed row = %+v, want skipped", changed)
	}
	lc := snap.LastClear
	if lc == nil || lc.Cleared != 1 || lc.Freed != 100 || lc.Ts == 0 || len(lc.Failed) != 1 || !lc.Failed[0].Held || lc.Failed[0].Id != "held" {
		t.Fatalf("LastClear = %+v, want 1 cleared, 100 freed, the held row failed", lc)
	}
	if snap.Clearing || snap.ClearTotal != 0 || snap.ClearDone != 0 {
		t.Errorf("a finished clear must leave no progress: %+v", snap)
	}
}

func TestServiceScanResetsClearState(t *testing.T) {
	useService(t)
	seed(t, leftItem("held", 1))
	clearFn = func(context.Context, wshrpc.StorageItem, bool, string) (int64, error) {
		return 0, &ClearError{Msg: "a process has it open", Held: true}
	}
	if err := StartClear([]string{"held"}); err != nil {
		t.Fatal(err)
	}
	waitIdle(t)
	snap := seed(t, leftItem("held", 1))
	if snap.LastClear != nil || snap.Items[0].ClearState != "" || snap.Items[0].ClearHeld {
		t.Fatalf("a scan must clear the last clear and every row's state: %+v", snap)
	}
}

func TestServiceResultReloads(t *testing.T) {
	dir := useService(t)
	want := seed(t, leftItem("a", 1))
	resetForTest(dir)
	got := Snapshot()
	if got.ScanTs != want.ScanTs || len(got.Items) != 1 || got.Items[0].Id != "a" {
		t.Fatalf("reloaded %+v, want the saved result %+v", got, want)
	}
}

func TestServiceUnusableFileLoadsAsNoResult(t *testing.T) {
	for name, content := range map[string]string{
		"corrupt":     "{not json",
		"older shape": `{"scants":5,"items":[{"id":"a","kind":"runtree","group":"left","size":1}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := useService(t)
			if err := os.WriteFile(filepath.Join(dir, reportFileName), []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
			resetForTest(dir)
			snap := Snapshot()
			if snap.ScanTs != 0 || len(snap.Items) != 0 || snap.JobError != "" {
				t.Fatalf("an unusable file must load as no result, got %+v", snap)
			}
			if snap := seed(t, leftItem("b", 1)); snap.ScanTs == 0 {
				t.Fatal("a scan after an unusable file must still save a result")
			}
		})
	}
}

func TestServiceRejectsWhatItMustNotClear(t *testing.T) {
	useService(t)
	inUse := leftItem("inuse", 1)
	inUse.Group, inUse.Clearable = wshrpc.StorageGroup_InUse, false
	commits := leftItem("commits", 1)
	commits.Clearable, commits.Skip, commits.BranchTip = false, wshrpc.StorageSkip_Commits, "abc123"
	seed(t, inUse, leftItem("clearable", 1), commits)

	if err := StartClear([]string{"inuse"}); err == nil {
		t.Error("StartClear must reject an In use id")
	}
	if err := StartClear([]string{"clearable", "unknown"}); err == nil {
		t.Error("StartClear must reject an unknown id")
	}
	if err := StartClear([]string{"commits"}); err == nil {
		t.Error("StartClear must reject a row Clear skips")
	}
	if err := StartDelete("clearable", ""); err == nil {
		t.Error("StartDelete must reject a Clearable id")
	}
	if err := StartDelete("inuse", ""); err == nil {
		t.Error("StartDelete must reject an In use id")
	}

	var gotForce bool
	var gotTip string
	clearFn = func(_ context.Context, item wshrpc.StorageItem, force bool, tip string) (int64, error) {
		gotForce, gotTip = force, tip
		return item.Size, nil
	}
	if err := StartDelete("commits", "abc123"); err != nil {
		t.Fatal(err)
	}
	snap := waitIdle(t)
	if !gotForce || gotTip != "abc123" {
		t.Fatalf("Delete anyway must force with the shown tip, got force=%v tip=%q", gotForce, gotTip)
	}
	if got := itemIds(snap.Items); len(got) != 2 {
		t.Fatalf("the deleted row must leave the result, have %v", got)
	}
}
