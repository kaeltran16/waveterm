// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentobserve

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Go/no-go thresholds from the pilot spec. Building the full observer is justified only if observation
// closes most of the hook coverage gap AND flips to idle promptly after a process exits.
const (
	CoverageClosureThreshold       = 0.80      // fraction of hook-missed sessions the observer must cover
	StaleWorkingThresholdMs        = 20 * 1000 // observer median idle-after-exit must be under this
	staleNever               int64 = -1        // hook never went idle after exit (stuck-working)
)

// session accumulates one process lifetime (keyed by pid) across sweeps + its gone record.
type session struct {
	Pid              int32
	BlockID          string
	Sweeps           int
	ObserverCovered  bool  // observer resolved a transcript and produced a state at least once
	HookFired        bool  // the hook channel produced >=1 event for this block
	RosterChecked    bool  // the roster (retained agent:status) was queryable for this block
	RosterShown      bool  // the roster actually held a state for this block at some sweep
	MaxMatchCount    int   // discovery ambiguity (candidates sharing the cwd)
	AmbiguousResolve bool  // relied on the create-time tiebreaker among >1 candidates
	Comparable       int   // sweeps where observer and hook states were both known
	Disagreements    int   // of those, how many differed
	ExitMs           int64 // gone.Ts (0 if the process never exited during the run)
}

// Report is the go/no-go summary computed from a shadow log + the hook debug log.
type Report struct {
	Sessions             int     `json:"sessions"`
	HookCoverageGap      int     `json:"hookcoveragegap"`      // sessions the hook never reported
	ObserverClosedGap    int     `json:"observerclosedgap"`    // of those, ones the observer covered
	RosterSessions       int     `json:"rostersessions"`       // sessions where the roster was queryable
	RosterCoverageGap    int     `json:"rostercoveragegap"`    // of those, ones the roster never showed (the real symptom)
	ObserverClosedRoster int     `json:"observerclosedroster"` // of the roster gap, ones the observer covered
	AmbiguousSessions    int     `json:"ambiguoussessions"`    // sessions whose discovery leaned on the tiebreaker
	MaxMatchCount        int     `json:"maxmatchcount"`        // worst-case cwd ambiguity seen
	Disagreements        int     `json:"disagreements"`        // total sweeps where observer != hook
	ComparableSweeps     int     `json:"comparablesweeps"`     // total sweeps both tracks were known
	ExitedSessions       int     `json:"exitedsessions"`       // sessions that ended during the run
	HookStaleMsAfterExit []int64 `json:"hookstalemsafterexit"` // per exited session; staleNever(-1) => hook never idled
}

// AnalyzeShadowLog folds the shadow JSONL and the hook debug log into the Report. Hook idle latency
// after exit is joined from the hook log (the shadow log stops sweeping a process once it exits).
func AnalyzeShadowLog(shadowContent, hookContent string) Report {
	hooks := ParseHookLog(hookContent)
	hookIdle := hookIdleTimeline(hookContent)

	sessions := map[int32]*session{}
	for _, line := range strings.Split(shadowContent, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var rec ShadowRecord
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		s := sessions[rec.Pid]
		if s == nil {
			s = &session{Pid: rec.Pid, BlockID: rec.BlockID}
			sessions[rec.Pid] = s
		}
		if rec.Event == EventGone {
			s.ExitMs = rec.Ts
			continue
		}
		s.Sweeps++
		if rec.ObserverState != "" {
			s.ObserverCovered = true
		}
		if rec.HookCount > 0 {
			s.HookFired = true
		}
		if rec.RosterChecked {
			s.RosterChecked = true
			if rec.RosterState != "" {
				s.RosterShown = true
			}
		}
		if rec.MatchCount > s.MaxMatchCount {
			s.MaxMatchCount = rec.MatchCount
		}
		if rec.ResolveMethod == "createtime" && rec.MatchCount > 1 {
			s.AmbiguousResolve = true
		}
		if rec.ObserverState != "" && rec.HookState != "" {
			s.Comparable++
			if rec.ObserverState != rec.HookState {
				s.Disagreements++
			}
		}
	}

	rep := Report{Sessions: len(sessions)}
	for _, s := range sessions {
		// a block that appears in the hook log at all counts as hook-covered, even if the shadow
		// snapshot happened to catch HookCount==0 early
		if !s.HookFired {
			if hs, ok := hooks[NormalizeBlockID(s.BlockID)]; ok && hs.Count > 0 {
				s.HookFired = true
			}
		}
		if !s.HookFired {
			rep.HookCoverageGap++
			if s.ObserverCovered {
				rep.ObserverClosedGap++
			}
		}
		// roster coverage: the real user-facing symptom (hook + backend backstops). Only counted for
		// sessions where the roster was actually queryable.
		if s.RosterChecked {
			rep.RosterSessions++
			if !s.RosterShown {
				rep.RosterCoverageGap++
				if s.ObserverCovered {
					rep.ObserverClosedRoster++
				}
			}
		}
		if s.AmbiguousResolve {
			rep.AmbiguousSessions++
		}
		if s.MaxMatchCount > rep.MaxMatchCount {
			rep.MaxMatchCount = s.MaxMatchCount
		}
		rep.Disagreements += s.Disagreements
		rep.ComparableSweeps += s.Comparable
		if s.ExitMs > 0 {
			rep.ExitedSessions++
			rep.HookStaleMsAfterExit = append(rep.HookStaleMsAfterExit, hookStaleAfterExit(hookIdle[NormalizeBlockID(s.BlockID)], s.ExitMs))
		}
	}
	return rep
}

// hookIdleTimeline extracts, per block, the ascending timestamps at which the hook reported idle.
func hookIdleTimeline(hookContent string) map[string][]int64 {
	out := map[string][]int64{}
	for _, line := range strings.Split(hookContent, "\n") {
		line = strings.TrimSpace(line)
		if !strings.Contains(line, "published") || !strings.Contains(line, "state=idle") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		ts := parseRFC3339Ms(fields[0])
		oref := field(fields, "oref=")
		if ts == 0 || oref == "" {
			continue
		}
		id := NormalizeBlockID(oref)
		out[id] = append(out[id], ts)
	}
	for id := range out {
		sort.Slice(out[id], func(i, j int) bool { return out[id][i] < out[id][j] })
	}
	return out
}

// hookStaleAfterExit returns ms from process exit to the first hook idle at/after it, or staleNever if
// the hook never idled after exit (a stuck-working row in the roster).
func hookStaleAfterExit(idleTimes []int64, exitMs int64) int64 {
	for _, ts := range idleTimes {
		if ts >= exitMs {
			return ts - exitMs
		}
	}
	return staleNever
}

// MedianHookStaleMs returns the median hook idle-after-exit latency, treating staleNever as a large
// sentinel so a stuck session pushes the median up (never rewards a missing idle). Returns -1 when no
// sessions exited.
func (r Report) MedianHookStaleMs() int64 {
	if len(r.HookStaleMsAfterExit) == 0 {
		return -1
	}
	vals := make([]int64, len(r.HookStaleMsAfterExit))
	copy(vals, r.HookStaleMsAfterExit)
	for i, v := range vals {
		if v == staleNever {
			vals[i] = 1 << 62 // effectively infinite
		}
	}
	sort.Slice(vals, func(i, j int) bool { return vals[i] < vals[j] })
	return vals[len(vals)/2]
}

// CoverageClosure is the fraction of hook-missed sessions the observer covered (1.0 if there was no
// gap to close).
func (r Report) CoverageClosure() float64 {
	if r.HookCoverageGap == 0 {
		return 1.0
	}
	return float64(r.ObserverClosedGap) / float64(r.HookCoverageGap)
}

// RosterClosure is the fraction of roster-missed sessions the observer covered — the decision-grade
// number, since the roster is the real user-facing surface. 1.0 if there was no roster gap.
func (r Report) RosterClosure() float64 {
	if r.RosterCoverageGap == 0 {
		return 1.0
	}
	return float64(r.ObserverClosedRoster) / float64(r.RosterCoverageGap)
}

// Verdict formats the human-readable go/no-go table with PASS/FAIL against the spec thresholds.
func (r Report) Verdict() string {
	var b strings.Builder
	fmt.Fprintf(&b, "sessions observed:            %d\n", r.Sessions)
	fmt.Fprintf(&b, "\n-- hook channel (diagnostic) --\n")
	fmt.Fprintf(&b, "hook coverage gap:            %d/%d sessions the hook never reported\n", r.HookCoverageGap, r.Sessions)
	closure := r.CoverageClosure()
	fmt.Fprintf(&b, "observer closed hook gap:     %d/%d (%.0f%%)\n", r.ObserverClosedGap, r.HookCoverageGap, closure*100)

	fmt.Fprintf(&b, "\n-- roster = what the cockpit shows (hook + backstops; DECISION-GRADE) --\n")
	rClosure := r.RosterClosure()
	if r.RosterSessions == 0 {
		fmt.Fprintf(&b, "roster coverage:              NOT MEASURED (RPC unavailable — run the shadow inside a Wave block)\n")
	} else {
		fmt.Fprintf(&b, "roster coverage gap:          %d/%d queryable sessions the cockpit never showed\n", r.RosterCoverageGap, r.RosterSessions)
		fmt.Fprintf(&b, "observer closed roster gap:   %d/%d (%.0f%%)  [threshold >%.0f%%]  %s\n",
			r.ObserverClosedRoster, r.RosterCoverageGap, rClosure*100, CoverageClosureThreshold*100, pass(rClosure > CoverageClosureThreshold))
	}

	fmt.Fprintf(&b, "\n-- observer quality --\n")
	fmt.Fprintf(&b, "discovery ambiguity:          %d/%d sessions needed the create-time tiebreaker (max %d candidates)\n",
		r.AmbiguousSessions, r.Sessions, r.MaxMatchCount)
	fmt.Fprintf(&b, "observer/hook disagreements:  %d of %d comparable sweeps\n", r.Disagreements, r.ComparableSweeps)
	med := r.MedianHookStaleMs()
	if med < 0 {
		fmt.Fprintf(&b, "hook stale-working (exit->idle): no sessions exited during the run\n")
	} else {
		fmt.Fprintf(&b, "hook median stale-working:    %dms  [observer is <=poll-interval by the liveness floor; threshold <%dms]\n",
			med, StaleWorkingThresholdMs)
	}

	// The decision hinges on the roster gap (the real symptom), not the raw hook gap. Only a measured
	// roster gap can green-light; if the roster wasn't measured, the verdict is inconclusive.
	fmt.Fprintf(&b, "\nBUILD Approach 3?  ")
	switch {
	case r.RosterSessions == 0:
		fmt.Fprintf(&b, "INCONCLUSIVE (roster not measured)\n")
	case r.RosterCoverageGap == 0:
		fmt.Fprintf(&b, "NO — the roster already covers every session (backstops suffice)\n")
	default:
		fmt.Fprintf(&b, "%s (roster closure %.0f%%)\n", pass(rClosure > CoverageClosureThreshold), rClosure*100)
	}
	return b.String()
}

func pass(ok bool) string {
	if ok {
		return "PASS"
	}
	return "FAIL"
}
