// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memdistill

import (
	"context"
	"log"
	"path/filepath"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

const (
	thresholdN   = 8
	maxAge       = 24 * time.Hour
	tickInterval = time.Hour
	queueFile    = "memory-distill-queue.json"
)

type distiller struct {
	mu        sync.Mutex
	path      string
	inflight  map[string]bool
	distillFn func(claudePath, model, corpus string) (string, bool)
	routeFn   func(cwd string, cands []memvault.LearnCandidate, refs []string) (int, int, error)
	now       func() time.Time
}

func newDistiller(path string) *distiller {
	return &distiller{
		path:      path,
		inflight:  map[string]bool{},
		distillFn: runDistill,
		routeFn:   memvault.RouteLearnings,
		now:       time.Now,
	}
}

// shouldFlush reports whether a bucket has reached the size threshold or its oldest entry is past maxAge.
func shouldFlush(sessions []pendingSession, now time.Time) bool {
	if len(sessions) == 0 {
		return false
	}
	if len(sessions) >= thresholdN {
		return true
	}
	if ts, err := time.Parse(time.RFC3339, sessions[0].EnqueuedAt); err == nil {
		return now.Sub(ts) >= maxAge
	}
	return false
}

func (d *distiller) enqueue(cwd, transcriptPath, claudePath string) {
	d.mu.Lock()
	st := loadQueue(d.path)
	addPending(&st, cwd, transcriptPath, claudePath, d.now().UTC().Format(time.RFC3339))
	if err := saveQueue(d.path, st); err != nil {
		log.Printf("[memdistill] save queue: %v\n", err)
	}
	d.mu.Unlock()
	d.maybeFlush(cwd)
}

// maybeFlush launches a single-flight background flush when the bucket is due.
func (d *distiller) maybeFlush(cwd string) {
	d.mu.Lock()
	st := loadQueue(d.path)
	due := shouldFlush(st.Buckets[cwd], d.now()) && !d.inflight[cwd]
	if due {
		d.inflight[cwd] = true
	}
	d.mu.Unlock()
	if due {
		go d.flush(cwd)
	}
}

// flush distills the cwd bucket and, on success, routes the learnings and clears the bucket. Errors
// leave the bucket for a later retry. Always releases the single-flight slot.
func (d *distiller) flush(cwd string) {
	defer func() {
		panichandler.PanicHandler("memdistill.flush", recover())
	}()
	defer func() {
		d.mu.Lock()
		delete(d.inflight, cwd)
		d.mu.Unlock()
	}()

	d.mu.Lock()
	st := loadQueue(d.path)
	sessions := append([]pendingSession(nil), st.Buckets[cwd]...)
	claudePath := st.ClaudePath
	d.mu.Unlock()
	if len(sessions) == 0 {
		return
	}

	corpus, model := buildCorpus(sessions)
	raw, ok := d.distillFn(claudePath, model, corpus)
	if !ok {
		return
	}
	cands, refs, ok := parseDistillOutput(raw)
	if !ok {
		log.Printf("[memdistill] distill output unparseable for cwd %s; retaining bucket\n", cwd)
		return
	}
	if len(cands) > 0 || len(refs) > 0 {
		if _, _, err := d.routeFn(cwd, cands, refs); err != nil {
			log.Printf("[memdistill] route learnings: %v\n", err)
			return
		}
	}

	// clear only the sessions we distilled; anything enqueued during the flush is preserved.
	distilled := map[string]bool{}
	for _, s := range sessions {
		distilled[s.TranscriptPath] = true
	}
	d.mu.Lock()
	st = loadQueue(d.path)
	var kept []pendingSession
	for _, s := range st.Buckets[cwd] {
		if !distilled[s.TranscriptPath] {
			kept = append(kept, s)
		}
	}
	if len(kept) == 0 {
		delete(st.Buckets, cwd)
	} else {
		st.Buckets[cwd] = kept
	}
	if err := saveQueue(d.path, st); err != nil {
		log.Printf("[memdistill] save queue after flush: %v\n", err)
	}
	d.mu.Unlock()
}

// sweep evaluates every bucket against both trigger conditions (backstop + failed-flush retry).
func (d *distiller) sweep() {
	d.mu.Lock()
	st := loadQueue(d.path)
	cwds := make([]string, 0, len(st.Buckets))
	for cwd := range st.Buckets {
		cwds = append(cwds, cwd)
	}
	d.mu.Unlock()
	for _, cwd := range cwds {
		d.maybeFlush(cwd)
	}
}

var (
	defaultDistiller *distiller
	startOnce        sync.Once
)

func ensure() {
	startOnce.Do(func() {
		defaultDistiller = newDistiller(filepath.Join(wavebase.GetWaveDataDir(), queueFile))
	})
}

// Enqueue records a finished session for later batch distillation.
func Enqueue(cwd, transcriptPath, claudePath string) {
	ensure()
	defaultDistiller.enqueue(cwd, transcriptPath, claudePath)
}

// Start runs a startup sweep and an hourly backstop sweep until ctx is cancelled.
func Start(ctx context.Context) {
	ensure()
	go func() {
		defer func() {
			panichandler.PanicHandler("memdistill.sweep-loop", recover())
		}()
		defaultDistiller.sweep()
		t := time.NewTicker(tickInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				defaultDistiller.sweep()
			}
		}
	}()
}
