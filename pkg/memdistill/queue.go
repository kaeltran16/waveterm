// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package memdistill owns the per-cwd pending-session queue and the batch distillation that turns
// finished coding sessions into memory. wavesrv enqueues sessions (via the SessionEnd hook over
// wshrpc) and this package flushes each cwd bucket through a single combined `claude -p` pass.
package memdistill

import (
	"encoding/json"
	"os"
)

type pendingSession struct {
	TranscriptPath string `json:"transcriptpath"`
	EnqueuedAt     string `json:"enqueuedat"` // RFC3339 UTC
}

type queueState struct {
	ClaudePath string                      `json:"claudepath"`
	Buckets    map[string][]pendingSession `json:"buckets"`
}

// loadQueue reads path; a missing or unparseable file yields an empty (non-nil) state.
func loadQueue(path string) queueState {
	st := queueState{Buckets: map[string][]pendingSession{}}
	b, err := os.ReadFile(path)
	if err != nil {
		return st
	}
	if json.Unmarshal(b, &st) != nil || st.Buckets == nil {
		return queueState{Buckets: map[string][]pendingSession{}}
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
// A non-empty claudePath refreshes the last-known-good path.
func addPending(st *queueState, cwd, transcriptPath, claudePath, enqueuedAt string) {
	if st.Buckets == nil {
		st.Buckets = map[string][]pendingSession{}
	}
	if claudePath != "" {
		st.ClaudePath = claudePath
	}
	for _, p := range st.Buckets[cwd] {
		if p.TranscriptPath == transcriptPath {
			return
		}
	}
	st.Buckets[cwd] = append(st.Buckets[cwd], pendingSession{TranscriptPath: transcriptPath, EnqueuedAt: enqueuedAt})
}
