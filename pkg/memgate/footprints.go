// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memgate

import (
	"cmp"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// Key is what a learned peak is kept under: the project's main checkout and a role or plan command.
type Key struct{ Project, Role string }

const (
	footprintsFile = "memfootprints.json"
	// a spike ages out after this many later trees; the estimate is the median of what is kept
	keepPeaks = 8
)

// defaultPeaks is the estimate of a role with no history. A worker's is its claude (~0.7 GB) plus the largest test
// peak measured in this repo (the typecheck, 2.8 GB).
var defaultPeaks = map[string]uint64{
	RoleWorker:   3584 * mib,
	"Verify":     3584 * mib,
	"Check":      3584 * mib,
	"Final":      3584 * mib,
	RoleReviewer: 1536 * mib,
}

const defaultPeakOther = gib

type footprintEntry struct {
	Project string   `json:"project"`
	Role    string   `json:"role"`
	Peaks   []uint64 `json:"peaks"`
}

var store = struct {
	mu     sync.Mutex
	dir    string // "" = the wave data dir
	loaded bool
	peaks  map[Key][]uint64
}{}

// Estimate is the memory a tree of k is expected to peak at: the median of its last recorded peaks, so one outlier
// does not set it, or the role's default with no history.
func Estimate(k Key) uint64 {
	store.mu.Lock()
	defer store.mu.Unlock()
	loadLocked()
	peaks := store.peaks[k]
	if len(peaks) == 0 {
		return defaultPeak(k.Role)
	}
	return median(peaks)
}

// median of an even count is the mean of the two middle values.
func median(peaks []uint64) uint64 {
	s := slices.Sorted(slices.Values(peaks))
	mid := len(s) / 2
	if len(s)%2 == 1 {
		return s[mid]
	}
	return s[mid-1]/2 + s[mid]/2 + (s[mid-1]%2+s[mid]%2)/2
}

func defaultPeak(role string) uint64 {
	if p, ok := defaultPeaks[role]; ok {
		return p
	}
	return defaultPeakOther
}

// Record keeps peak as k's latest and writes the store. A 0 peak (no job support, or a failed read) is ignored.
func Record(k Key, peak uint64) {
	if peak == 0 {
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	loadLocked()
	peaks := append(store.peaks[k], peak)
	if len(peaks) > keepPeaks {
		peaks = slices.Clone(peaks[len(peaks)-keepPeaks:])
	}
	store.peaks[k] = peaks
	if err := saveLocked(); err != nil {
		log.Printf("memgate: writing %s: %v", footprintsPathLocked(), err)
	}
}

func footprintsPathLocked() string {
	dir := store.dir
	if dir == "" {
		dir = wavebase.GetWaveDataDir()
	}
	return filepath.Join(dir, footprintsFile)
}

// loadLocked reads the store once. A missing or unreadable file means defaults: the footprints only size the gate,
// so they must never stop it. The next Record rewrites the file.
func loadLocked() {
	if store.loaded {
		return
	}
	store.loaded = true
	store.peaks = make(map[Key][]uint64)
	path := footprintsPathLocked()
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	if err != nil {
		log.Printf("memgate: reading %s, using defaults: %v", path, err)
		return
	}
	var entries []footprintEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		log.Printf("memgate: parsing %s, using defaults: %v", path, err)
		return
	}
	for _, e := range entries {
		store.peaks[Key{e.Project, e.Role}] = e.Peaks
	}
}

func saveLocked() error {
	entries := make([]footprintEntry, 0, len(store.peaks))
	for k, peaks := range store.peaks {
		entries = append(entries, footprintEntry{Project: k.Project, Role: k.Role, Peaks: peaks})
	}
	slices.SortFunc(entries, func(a, b footprintEntry) int {
		return cmp.Or(cmp.Compare(a.Project, b.Project), cmp.Compare(a.Role, b.Role))
	})
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	path := footprintsPathLocked()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return fileutil.AtomicWriteFile(path, data, 0o644)
}

// SetStoreDirForTest keeps the footprints in dir (reloaded from it), so tests stay off the real data dir.
func SetStoreDirForTest(dir string) (restore func()) {
	store.mu.Lock()
	defer store.mu.Unlock()
	old := store.dir
	store.dir, store.loaded, store.peaks = dir, false, nil
	return func() {
		store.mu.Lock()
		defer store.mu.Unlock()
		store.dir, store.loaded, store.peaks = old, false, nil
	}
}
