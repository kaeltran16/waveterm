// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Decay: the gardener's decisive pillar. A machine-authored note provably unused (real recall
// telemetry) for N days and older than N days is auto-archived; a human note that is never-referenced
// and old is flagged (never auto-archived). Superseded and referenced-stale notes are left to the
// existing prune queue. Pure + deterministic (0 tokens).
// See docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md.
package memgarden

import (
	"time"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

// DecayAction is one gardener decision for a note. Archive=true -> move to archive (machine only);
// Archive=false -> flag into the cleanup queue.
type DecayAction struct {
	NoteID  string
	Path    string
	Reason  string // "decay" (archive) | "stale" (flag)
	Archive bool
}

// isMachine reports whether a note was machine-authored (harvested or distilled) rather than
// hand-written. Hand-written vault notes carry source "vault" (or none).
func isMachine(source string) bool {
	switch source {
	case "agent", "codex", "claude", "pi":
		return true
	}
	return false
}

// beforeCutoff reports whether an RFC3339 timestamp parses and precedes cutoff.
func beforeCutoff(ts string, cutoff time.Time) bool {
	t, err := time.Parse(time.RFC3339, ts)
	return err == nil && t.Before(cutoff)
}

// classifyDecay returns the decay actions for notes as of now. staleDays defines N. epoch is when
// recall instrumentation first ran on this installation; a zero epoch means the signal has never
// been able to fire.
//
// The rule the predicate exists to enforce: the absence of a measurement is not evidence of disuse.
// A never-referenced note is only archive-eligible once the signal itself has been alive for a full
// window — before that it is flagged into the cleanup queue, exactly like a human note.
func classifyDecay(notes []memvault.Note, now time.Time, staleDays int, epoch time.Time) []DecayAction {
	cutoff := now.AddDate(0, 0, -staleDays)
	signalMature := !epoch.IsZero() && epoch.Before(cutoff)
	var out []DecayAction
	for _, n := range notes {
		if n.SupersededBy != "" {
			continue // handled by the superseded queue
		}
		stamped := n.LastReferenced != ""
		unusedByRecall := (stamped && beforeCutoff(n.LastReferenced, cutoff)) ||
			(!stamped && signalMature)
		old := ageBeforeCutoff(n, cutoff)
		switch {
		case isMachine(n.Source) && unusedByRecall && old:
			out = append(out, DecayAction{NoteID: n.ID, Path: n.Path, Reason: "decay", Archive: true})
		case isMachine(n.Source) && !stamped && old:
			// the signal is not mature yet: surface the note for human judgment rather than removing it
			out = append(out, DecayAction{NoteID: n.ID, Path: n.Path, Reason: "stale", Archive: false})
		case !isMachine(n.Source) && !stamped && old:
			// the never-referenced-immortal leak, respecting hand-written notes: flag, never archive.
			out = append(out, DecayAction{NoteID: n.ID, Path: n.Path, Reason: "stale", Archive: false})
		}
	}
	return out
}

// ageBeforeCutoff reports whether the note's age basis (captured_at, else file mtime) precedes cutoff.
func ageBeforeCutoff(n memvault.Note, cutoff time.Time) bool {
	if n.CapturedAt != "" {
		return beforeCutoff(n.CapturedAt, cutoff)
	}
	if n.UpdatedTs > 0 {
		return time.UnixMilli(n.UpdatedTs).Before(cutoff)
	}
	return false
}
