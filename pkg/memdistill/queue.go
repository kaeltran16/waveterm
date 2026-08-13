// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package memdistill owns the per-cwd pending-session queue and the batch distillation that turns
// finished coding sessions into memory. wavesrv enqueues sessions (via the SessionEnd hook over
// wshrpc) and this package flushes each cwd bucket through a single consult.Run pass.
package memdistill

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

type pendingSession struct {
	TranscriptPath string `json:"transcriptpath"`
	EnqueuedAt     string `json:"enqueuedat"` // RFC3339 UTC
}

// PassRecord is one finished distill pass over a cwd bucket, kept durably so `wsh jarvis status`
// can answer "did it skip my session" — the activity feed's buffer is in-memory and dies with the
// server; the queue file is the durable record.
type PassRecord struct {
	Ts        int64 `json:"ts"`
	Sessions  int   `json:"sessions"`
	Committed int   `json:"committed"`
	Queued    int   `json:"queued"`
}

type queueState struct {
	Buckets  map[string][]pendingSession `json:"buckets"`
	LastPass map[string]PassRecord       `json:"lastpass,omitempty"`
}

// loadQueue reads path; a missing or unparseable file yields an empty (non-nil) state.
func loadQueue(path string) queueState {
	st := queueState{Buckets: map[string][]pendingSession{}, LastPass: map[string]PassRecord{}}
	b, err := os.ReadFile(path)
	if err != nil {
		return st
	}
	if json.Unmarshal(b, &st) != nil || st.Buckets == nil {
		return queueState{Buckets: map[string][]pendingSession{}, LastPass: map[string]PassRecord{}}
	}
	if st.LastPass == nil {
		st.LastPass = map[string]PassRecord{}
	}
	return st
}

// saveQueue writes st atomically (temp file + rename).
func saveQueue(path string, st queueState) error {
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// addPending appends the session to its cwd bucket unless transcriptPath is already queued there.
func addPending(st *queueState, cwd, transcriptPath, enqueuedAt string) {
	if st.Buckets == nil {
		st.Buckets = map[string][]pendingSession{}
	}
	for _, p := range st.Buckets[cwd] {
		if p.TranscriptPath == transcriptPath {
			return
		}
	}
	st.Buckets[cwd] = append(st.Buckets[cwd], pendingSession{TranscriptPath: transcriptPath, EnqueuedAt: enqueuedAt})
}

// CwdQueueSummary is one cwd's distill queue state: pending count plus the last recorded pass.
type CwdQueueSummary struct {
	Cwd      string      `json:"cwd"`
	Pending  int         `json:"pending"`
	LastPass *PassRecord `json:"lastpass,omitempty"`
}

// QueueSummary reports every cwd that has a pending bucket or a recorded pass, sorted by cwd.
func QueueSummary() ([]CwdQueueSummary, error) {
	return queueSummaryAt(filepath.Join(wavebase.GetWaveDataDir(), queueFile))
}

func queueSummaryAt(path string) ([]CwdQueueSummary, error) {
	st := loadQueue(path)
	cwds := map[string]bool{}
	for cwd := range st.Buckets {
		cwds[cwd] = true
	}
	for cwd := range st.LastPass {
		cwds[cwd] = true
	}
	out := make([]CwdQueueSummary, 0, len(cwds))
	for cwd := range cwds {
		var last *PassRecord
		if rec, ok := st.LastPass[cwd]; ok {
			last = &rec
		}
		out = append(out, CwdQueueSummary{Cwd: cwd, Pending: len(st.Buckets[cwd]), LastPass: last})
	}
	// Sort by Cwd for determinism.
	sort.Slice(out, func(i, j int) bool { return out[i].Cwd < out[j].Cwd })
	return out, nil
}
