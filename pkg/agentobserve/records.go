// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentobserve

import "time"

// Event kinds for a ShadowRecord.
const (
	EventSweep = "sweep" // a live agent observed this sweep
	EventGone  = "gone"  // a previously-seen agent's process is no longer present (exit ground truth)
)

// ShadowRecord is one line of the pilot's three-way comparison log: the process anchor (ground truth),
// the observer's derived state + discovery confidence, and a snapshot of the hook channel's state for
// the same block. The offline analyzer joins these (plus the full hook debug log) into the go/no-go
// metrics. Log-only: nothing here drives the roster.
type ShadowRecord struct {
	Ts             int64  `json:"ts"`    // sweep wall-clock, ms epoch
	Event          string `json:"event"` // EventSweep | EventGone
	Pid            int32  `json:"pid"`
	BlockID        string `json:"blockid,omitempty"` // bare UUID from WAVETERM_BLOCKID; "" if agent ran outside a Wave block
	Cwd            string `json:"cwd,omitempty"`
	CreateMs       int64  `json:"createms,omitempty"`
	TranscriptPath string `json:"transcriptpath,omitempty"`
	ResolveMethod  string `json:"resolvemethod,omitempty"` // createtime | mtime | none
	MatchCount     int    `json:"matchcount"`              // cwd-matching transcripts; >1 => discovery was ambiguous
	ObserverState  string `json:"observerstate,omitempty"`
	MtimeAgeMs     int64  `json:"mtimeagems,omitempty"` // now - transcript mtime
	HookState      string `json:"hookstate,omitempty"`  // hook channel's last state for this block ("" => hook never fired)
	HookLastMs     int64  `json:"hooklastms,omitempty"`
	HookCount      int    `json:"hookcount"` // hook firings for this block so far; 0 => coverage gap
	// Roster track: the retained agent:status the cockpit actually shows for this block. This is
	// hook PLUS the backend backstops, so it measures the real "agent never appears" symptom — not
	// just the hook channel. RosterChecked distinguishes "roster showed nothing" from "RPC was off".
	RosterState   string `json:"rosterstate,omitempty"`
	RosterChecked bool   `json:"rosterchecked"`
}

// RosterProbe is the roster track's input for one block: the retained state the cockpit shows and
// whether we were able to check (RPC available). Kept separate from the RPC call so BuildRecord stays
// pure and testable.
type RosterProbe struct {
	State   string
	Checked bool
}

// BuildRecord assembles a sweep record for one live agent from the anchored process, its resolved
// transcript, the transcript tail, the hook channel's state, and the roster's retained state for the
// block. Pure over its inputs so the join logic is unit-testable without the OS or RPC.
func BuildRecord(proc ProcInfo, res Resolution, tail TailResult, hook HookState, roster RosterProbe, now time.Time, quiet time.Duration) ShadowRecord {
	rec := ShadowRecord{
		Ts:             now.UnixMilli(),
		Event:          EventSweep,
		Pid:            proc.Pid,
		BlockID:        proc.BlockID,
		Cwd:            proc.Cwd,
		CreateMs:       proc.CreateMs,
		TranscriptPath: res.Path,
		ResolveMethod:  res.Method,
		MatchCount:     res.MatchCount,
		HookState:      hook.LastState,
		HookLastMs:     hook.LastMs,
		HookCount:      hook.Count,
		RosterState:    roster.State,
		RosterChecked:  roster.Checked,
	}
	if res.Path != "" {
		rec.ObserverState = DeriveState(Snapshot{
			Lines:       tail.Lines,
			ModTime:     tail.ModTime,
			Now:         now,
			ProcAlive:   true,
			QuietWindow: quiet,
		})
		rec.MtimeAgeMs = now.Sub(tail.ModTime).Milliseconds()
	}
	return rec
}
