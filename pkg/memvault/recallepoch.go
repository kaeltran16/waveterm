// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The recall epoch: the instant this installation first ran with recall instrumentation. Before it,
// "never referenced" is the absence of a measurement, not evidence of disuse, and the gardener must
// not archive on it. See docs/superpowers/specs/2026-09-22-memory-utilization-design.md.
package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// epochFile is the marker's path, keyed to the profile's data dir so dev and prod age
// independently. Same pattern as memroots' last-root marker. A var so tests can redirect it.
var epochFile = func() string {
	dir := wavebase.GetWaveDataDir()
	if dir == "" {
		return "" // no data dir (tests / embedded): no epoch to record
	}
	return filepath.Join(dir, "memory-recall-epoch.txt")
}

// EnsureRecallEpoch records now as the epoch if none exists yet, and returns the epoch in force.
// Called once per boot by the memory sweep — not by the first stamp — so the clock starts even on an
// installation where nothing is ever recalled.
func EnsureRecallEpoch(now time.Time) time.Time {
	if t := RecallEpoch(); !t.IsZero() {
		return t
	}
	path := epochFile()
	if path == "" {
		return time.Time{}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return time.Time{}
	}
	if err := os.WriteFile(path, []byte(now.UTC().Format(time.RFC3339)), 0o644); err != nil {
		return time.Time{}
	}
	return now.UTC()
}

// RecallEpoch reads the recorded epoch. Absent, empty or unparseable returns the zero time, which
// every caller must read as "the signal is not yet mature": an unreadable epoch can never authorize
// an archive.
func RecallEpoch() time.Time {
	path := epochFile()
	if path == "" {
		return time.Time{}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(string(data)))
	if err != nil {
		return time.Time{}
	}
	return t
}
