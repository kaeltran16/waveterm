// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"log"
	"runtime"
	"sort"
	"sync/atomic"
	"time"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

const (
	// IndexWindowDays is how far back the session list and search reach, for every runtime.
	IndexWindowDays = 30
	// syncParseMax bounds the transcripts one synchronous call reads, so a cold call answers in seconds and the
	// warm-up reads the rest.
	syncParseMax = 100
)

// syncParseBytes bounds the same reads by size: pi transcripts run to 40 MB and parse at ~25 ms per MB, so 100
// of them held the Brief for minutes. A var so tests can shrink it.
var syncParseBytes int64 = 64 << 20

// syncBudget is what one synchronous call may still parse before it answers from the cache and leaves the
// rest to the warm-up.
type syncBudget struct {
	files   int
	bytes   int64
	skipped bool
}

// entry is c's entry, parsed while the budget lasts. Past it a changed transcript keeps its stale entry, so a
// live session stays listed until the warm-up re-reads it; a transcript never read has none.
func (b *syncBudget) entry(c candidate) scanCacheEntry {
	e, ok := cachedEntry(c)
	if ok {
		return e
	}
	if b.files >= syncParseMax || b.bytes >= syncParseBytes {
		b.skipped = true
		return e
	}
	b.files++
	b.bytes += c.size
	return parseCandidate(c)
}

// IndexedSession is a session as the scan builds SessionInfo, plus its digest turns in transcript order. Turns
// is shared with the scan cache; callers must not modify it.
type IndexedSession struct {
	Info  SessionInfo
	Turns []Turn
}

// warming is set while the warm-up goroutine runs.
var warming atomic.Bool

// Indexed lists every session in the window, newest first. It stat-walks every provider, uses cached entries
// whose mtime+size still match, and parses uncached candidates, newest first, within one syncBudget. complete
// is false when it skipped any; it then starts the warm-up if it is not running.
func Indexed(windowDays int) (sessions []IndexedSession, complete bool) {
	cands := walkProviders(allProviders(), windowDays)
	// a narrower walk would drop entries the 30-day list and search still need
	if windowDays >= IndexWindowDays {
		pruneScanCache(cands)
	}
	var budget syncBudget
	for _, c := range cands {
		e := budget.entry(c)
		if e.info == nil {
			continue
		}
		sessions = append(sessions, IndexedSession{Info: sessionOf(c, e), Turns: e.turns})
	}
	sort.SliceStable(sessions, func(i, j int) bool { return sessions[i].Info.LastActiveTs > sessions[j].Info.LastActiveTs })
	complete = !budget.skipped
	if !complete {
		StartWarmup()
	}
	return sessions, complete
}

// pruneScanCache drops entries whose transcript is not among cands, so the cache holds the window's
// transcripts and never the deleted or aged-out ones.
func pruneScanCache(cands []candidate) {
	keep := make(map[string]bool, len(cands))
	for _, c := range cands {
		keep[c.path] = true
	}
	scanCacheMu.Lock()
	defer scanCacheMu.Unlock()
	for path := range scanCache {
		if !keep[path] {
			delete(scanCache, path)
		}
	}
}

// StartWarmup parses every uncached candidate of the IndexWindowDays window, newest first, on one background
// goroutine, one file at a time, yielding between files so it stays low priority. Idempotent while one runs.
func StartWarmup() {
	if !warming.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer warming.Store(false)
		defer func() {
			panichandler.PanicHandler("agentsessions:warmup", recover())
		}()
		started := time.Now()
		read := 0
		for _, c := range walkProviders(allProviders(), IndexWindowDays) {
			if _, ok := cachedEntry(c); ok {
				continue
			}
			parseCandidate(c)
			read++
			runtime.Gosched()
		}
		log.Printf("agentsessions: warm-up read %d transcripts in %v", read, time.Since(started).Round(time.Millisecond))
	}()
}
