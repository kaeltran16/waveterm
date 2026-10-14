// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package storagereport finds what Arc and its agents keep on this machine, which run left each item, and
// clears the left-over items that lose nothing. Scan, clear and delete run one at a time as background jobs;
// the frontend polls Snapshot while one runs.
package storagereport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	reportFileName = "storage-report.json"
	// bump when the persisted shape changes: a file of another version loads as no result
	reportFileVersion = 1
)

var ErrBusy = errors.New("a storage scan or clear is already running")

// package vars so service tests stub them
var scanFn = scan
var clearFn = clearItem

// ClearError is clearItem's typed failure: Skipped when the item changed since the scan, Held when a process
// has it open.
type ClearError struct {
	Msg     string
	Held    bool
	Skipped bool
}

func (e *ClearError) Error() string { return e.Msg }

type persistedReport struct {
	Version   int                        `json:"version"`
	ScanTs    int64                      `json:"scants"`
	Items     []wshrpc.StorageItem       `json:"items"`
	Errors    []wshrpc.StorageScanError  `json:"errors,omitempty"`
	LastClear *wshrpc.StorageClearResult `json:"lastclear,omitempty"`
}

var state struct {
	mu     sync.Mutex
	loaded bool
	busy   bool
	file   string // "" = <wave data dir>/storage-report.json
	report wshrpc.StorageReportData
}

// Snapshot is a copy of the current result and job progress; it loads the persisted result on first call.
func Snapshot() *wshrpc.StorageReportData {
	state.mu.Lock()
	defer state.mu.Unlock()
	ensureLoadedLocked()
	return copyReport(&state.report)
}

// StartScan starts a background scan; ErrBusy while any job runs.
func StartScan() error {
	state.mu.Lock()
	defer state.mu.Unlock()
	ensureLoadedLocked()
	if state.busy {
		return ErrBusy
	}
	state.busy = true
	state.report.Scanning = true
	state.report.ScanStartTs = time.Now().UnixMilli()
	state.report.JobError = ""
	go func() {
		defer func() {
			if perr := panichandler.PanicHandler("storagereport:scan", recover()); perr != nil {
				finishScan(nil, nil, perr)
			}
		}()
		items, scanErrs, err := scanFn(context.Background())
		finishScan(items, scanErrs, err)
	}()
	return nil
}

func finishScan(items []wshrpc.StorageItem, scanErrs []wshrpc.StorageScanError, err error) {
	state.mu.Lock()
	defer state.mu.Unlock()
	r := &state.report
	state.busy = false
	r.Scanning, r.ScanStartTs = false, 0
	if err != nil {
		log.Printf("storage scan: %v", err)
		r.JobError = fmt.Sprintf("scan failed: %v", err)
		return
	}
	// a fresh scan's rows carry no clear state
	r.Items, r.Errors, r.ScanTs, r.LastClear = items, scanErrs, time.Now().UnixMilli(), nil
	persistLocked()
}

// StartClear clears the given Left over, Clearable items in the background; ErrBusy while any job runs.
func StartClear(ids []string) error {
	state.mu.Lock()
	defer state.mu.Unlock()
	ensureLoadedLocked()
	if state.busy {
		return ErrBusy
	}
	if len(ids) == 0 {
		return errors.New("nothing to clear")
	}
	var items []wshrpc.StorageItem
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		item := findItemLocked(id)
		if item == nil {
			return fmt.Errorf("%s is not in the storage report", id)
		}
		if item.Group != wshrpc.StorageGroup_Left || !item.Clearable {
			return fmt.Errorf("%s is not left over and clearable", id)
		}
		items = append(items, *item)
	}
	startClearLocked(items, false, "")
	return nil
}

// StartDelete deletes one Left over item Clear skips for its commits or uncommitted files, if its branch is
// still at tip; ErrBusy while any job runs.
func StartDelete(id, tip string) error {
	state.mu.Lock()
	defer state.mu.Unlock()
	ensureLoadedLocked()
	if state.busy {
		return ErrBusy
	}
	item := findItemLocked(id)
	if item == nil {
		return fmt.Errorf("%s is not in the storage report", id)
	}
	if item.Group != wshrpc.StorageGroup_Left || (item.Skip != wshrpc.StorageSkip_Commits && item.Skip != wshrpc.StorageSkip_Dirty) {
		return fmt.Errorf("%s is not a left over item with commits or uncommitted files", id)
	}
	startClearLocked([]wshrpc.StorageItem{*item}, true, tip)
	return nil
}

func startClearLocked(items []wshrpc.StorageItem, force bool, tip string) {
	r := &state.report
	state.busy = true
	r.Clearing, r.ClearTotal, r.ClearDone, r.JobError = true, len(items), 0, ""
	result := &wshrpc.StorageClearResult{}
	go func() {
		defer func() {
			if perr := panichandler.PanicHandler("storagereport:clear", recover()); perr != nil {
				finishClear(result, perr)
			}
		}()
		ctx := context.Background()
		for _, item := range items {
			setClearState(item.Id, wshrpc.StorageClear_Clearing, "", false)
			freed, err := clearFn(ctx, item, force, tip)
			recordClear(item, freed, err, result)
		}
		finishClear(result, nil)
	}()
}

func recordClear(item wshrpc.StorageItem, freed int64, err error, result *wshrpc.StorageClearResult) {
	var ce *ClearError
	isClearErr := errors.As(err, &ce)
	switch {
	case err == nil:
		setClearState(item.Id, wshrpc.StorageClear_Cleared, "", false)
		result.Cleared++
		result.Freed += freed
	case isClearErr && ce.Skipped:
		setClearState(item.Id, wshrpc.StorageClear_Skipped, ce.Msg, false)
	default:
		held := isClearErr && ce.Held
		log.Printf("storage clear %s: %v", item.Id, err)
		setClearState(item.Id, wshrpc.StorageClear_Failed, err.Error(), held)
		result.Failed = append(result.Failed, wshrpc.StorageClearFailure{Id: item.Id, Path: item.Path, Error: err.Error(), Held: held})
	}
	state.mu.Lock()
	state.report.ClearDone++
	state.mu.Unlock()
}

func setClearState(id, clearState, msg string, held bool) {
	state.mu.Lock()
	defer state.mu.Unlock()
	if item := findItemLocked(id); item != nil {
		item.ClearState, item.ClearError, item.ClearHeld = clearState, msg, held
	}
}

// finishClear drops the cleared rows, keeps failed and skipped ones with their state, and persists. No rescan
// follows: the rows left are still the scan's.
func finishClear(result *wshrpc.StorageClearResult, err error) {
	state.mu.Lock()
	defer state.mu.Unlock()
	r := &state.report
	var kept []wshrpc.StorageItem
	for _, item := range r.Items {
		if item.ClearState == wshrpc.StorageClear_Cleared {
			continue
		}
		// a job that panicked leaves the row it was on mid-clear
		if item.ClearState == wshrpc.StorageClear_Clearing && err != nil {
			item.ClearState, item.ClearError = wshrpc.StorageClear_Failed, err.Error()
		}
		kept = append(kept, item)
	}
	r.Items = kept
	result.Ts = time.Now().UnixMilli()
	r.LastClear = result
	state.busy = false
	r.Clearing, r.ClearTotal, r.ClearDone = false, 0, 0
	if err != nil {
		log.Printf("storage clear: %v", err)
		r.JobError = fmt.Sprintf("clear failed: %v", err)
	}
	persistLocked()
}

func findItemLocked(id string) *wshrpc.StorageItem {
	for i := range state.report.Items {
		if state.report.Items[i].Id == id {
			return &state.report.Items[i]
		}
	}
	return nil
}

func reportFile() string {
	if state.file != "" {
		return state.file
	}
	return filepath.Join(wavebase.GetWaveDataDir(), reportFileName)
}

// ensureLoadedLocked loads the persisted result once. A file that cannot be read or parsed, or is of another
// version, is logged and loads as no result, so the section scans.
func ensureLoadedLocked() {
	if state.loaded {
		return
	}
	state.loaded = true
	path := reportFile()
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		log.Printf("storage report: reading %s: %v", path, err)
		return
	}
	var p persistedReport
	if err := json.Unmarshal(b, &p); err != nil {
		log.Printf("storage report: parsing %s: %v", path, err)
		return
	}
	if p.Version != reportFileVersion {
		log.Printf("storage report: %s is version %d, want %d; scanning anew", path, p.Version, reportFileVersion)
		return
	}
	state.report = wshrpc.StorageReportData{ScanTs: p.ScanTs, Items: p.Items, Errors: p.Errors, LastClear: p.LastClear}
}

// persistLocked writes the result; a failed write sets JobError.
func persistLocked() {
	r := &state.report
	p := persistedReport{Version: reportFileVersion, ScanTs: r.ScanTs, Items: r.Items, Errors: r.Errors, LastClear: r.LastClear}
	b, err := json.Marshal(p)
	if err == nil {
		err = fileutil.AtomicWriteFile(reportFile(), b, 0o644)
	}
	if err != nil {
		log.Printf("storage report: saving: %v", err)
		r.JobError = fmt.Sprintf("saving the storage report: %v", err)
	}
}

func copyReport(r *wshrpc.StorageReportData) *wshrpc.StorageReportData {
	c := *r
	c.Items = append([]wshrpc.StorageItem{}, r.Items...)
	c.Errors = append([]wshrpc.StorageScanError(nil), r.Errors...)
	if r.LastClear != nil {
		lc := *r.LastClear
		lc.Failed = append([]wshrpc.StorageClearFailure(nil), r.LastClear.Failed...)
		c.LastClear = &lc
	}
	return &c
}

// resetForTest clears the in-memory state and points the result file at dir; the file itself is kept.
func resetForTest(dir string) {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.loaded, state.busy = false, false
	state.file = filepath.Join(dir, reportFileName)
	state.report = wshrpc.StorageReportData{}
}
