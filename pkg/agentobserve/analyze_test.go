// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentobserve

import (
	"strings"
	"testing"
)

// A synthetic scenario exercising all four metrics:
//   - session A (pid 1, block "a"): hook never fired, observer covered it -> gap closed
//   - session B (pid 2, block "b"): hook fired; ambiguous discovery; one disagreement sweep; exited,
//     and the hook went idle 5s after exit
func TestAnalyzeShadowLog(t *testing.T) {
	shadow := strings.Join([]string{
		`{"ts":1000,"event":"sweep","pid":1,"blockid":"a","observerstate":"working","matchcount":1,"hookcount":0}`,
		`{"ts":2000,"event":"sweep","pid":1,"blockid":"a","observerstate":"working","matchcount":1,"hookcount":0}`,
		`{"ts":1000,"event":"sweep","pid":2,"blockid":"b","observerstate":"working","resolvemethod":"createtime","matchcount":12,"hookstate":"working","hookcount":3}`,
		`{"ts":2000,"event":"sweep","pid":2,"blockid":"b","observerstate":"idle","resolvemethod":"createtime","matchcount":12,"hookstate":"working","hookcount":4}`,
		`{"ts":3000,"event":"gone","pid":2,"blockid":"b","observerstate":"idle"}`,
	}, "\n")
	// hook log: block b went idle at T=8000ms epoch (5s after the exit at 3000ms), aligned with the
	// toy millisecond timestamps used in the shadow fixture above
	hook := "1970-01-01T00:00:08Z published event=Stop state=idle oref=block:b\n"

	rep := AnalyzeShadowLog(shadow, hook)

	if rep.Sessions != 2 {
		t.Fatalf("Sessions = %d, want 2", rep.Sessions)
	}
	if rep.HookCoverageGap != 1 || rep.ObserverClosedGap != 1 {
		t.Fatalf("coverage gap = %d closed = %d, want 1/1", rep.HookCoverageGap, rep.ObserverClosedGap)
	}
	if rep.CoverageClosure() != 1.0 {
		t.Fatalf("CoverageClosure = %v, want 1.0", rep.CoverageClosure())
	}
	if rep.AmbiguousSessions != 1 || rep.MaxMatchCount != 12 {
		t.Fatalf("ambiguity = %d/%d, want 1/12", rep.AmbiguousSessions, rep.MaxMatchCount)
	}
	if rep.Disagreements != 1 { // pid2 sweep@2000: observer idle vs hook working
		t.Fatalf("Disagreements = %d, want 1", rep.Disagreements)
	}
	if rep.ExitedSessions != 1 {
		t.Fatalf("ExitedSessions = %d, want 1", rep.ExitedSessions)
	}
	if len(rep.HookStaleMsAfterExit) != 1 || rep.HookStaleMsAfterExit[0] != 5000 {
		t.Fatalf("HookStaleMsAfterExit = %v, want [5000]", rep.HookStaleMsAfterExit)
	}
	// this fixture carries no roster data, so the decision is INCONCLUSIVE regardless of the hook gap
	// (roster coverage is what gates the build) — verified separately in the roster-specific tests
	if !strings.Contains(rep.Verdict(), "INCONCLUSIVE") {
		t.Fatalf("verdict should be INCONCLUSIVE without roster data:\n%s", rep.Verdict())
	}
}

// The distinction that fix #1 is about: a session the HOOK missed but the ROSTER still showed (a
// backend backstop covered it) is NOT a real gap. Only roster-missed sessions count toward the
// decision. Here: pid 1 = hook-missed but roster-covered (no real gap); pid 2 = roster-missed and
// observer-covered (a real gap the observer closes).
func TestAnalyzeRosterCoverageSeparatesFromHook(t *testing.T) {
	shadow := strings.Join([]string{
		`{"ts":1000,"event":"sweep","pid":1,"blockid":"a","observerstate":"working","hookcount":0,"rosterstate":"working","rosterchecked":true}`,
		`{"ts":1000,"event":"sweep","pid":2,"blockid":"b","observerstate":"working","hookcount":0,"rosterstate":"","rosterchecked":true}`,
	}, "\n")
	rep := AnalyzeShadowLog(shadow, "")

	if rep.HookCoverageGap != 2 {
		t.Fatalf("HookCoverageGap = %d, want 2 (both missed by the hook)", rep.HookCoverageGap)
	}
	if rep.RosterSessions != 2 {
		t.Fatalf("RosterSessions = %d, want 2", rep.RosterSessions)
	}
	if rep.RosterCoverageGap != 1 { // only pid 2 was truly missing from the roster
		t.Fatalf("RosterCoverageGap = %d, want 1 (backstop covered pid 1)", rep.RosterCoverageGap)
	}
	if rep.ObserverClosedRoster != 1 {
		t.Fatalf("ObserverClosedRoster = %d, want 1", rep.ObserverClosedRoster)
	}
	if rep.RosterClosure() != 1.0 {
		t.Fatalf("RosterClosure = %v, want 1.0", rep.RosterClosure())
	}
	if !strings.Contains(rep.Verdict(), "roster closure") {
		t.Fatalf("verdict should be roster-driven:\n%s", rep.Verdict())
	}
}

func TestVerdictInconclusiveWhenRosterNotMeasured(t *testing.T) {
	shadow := `{"ts":1000,"event":"sweep","pid":1,"blockid":"a","observerstate":"working","hookcount":0}`
	v := AnalyzeShadowLog(shadow, "").Verdict()
	if !strings.Contains(v, "INCONCLUSIVE") {
		t.Fatalf("expected INCONCLUSIVE when roster unmeasured:\n%s", v)
	}
}

func TestHookStaleAfterExitNever(t *testing.T) {
	// hook idle only BEFORE exit -> counts as never-idled-after-exit (stuck working)
	if got := hookStaleAfterExit([]int64{500}, 1000); got != staleNever {
		t.Fatalf("hookStaleAfterExit = %d, want staleNever", got)
	}
	if got := hookStaleAfterExit(nil, 1000); got != staleNever {
		t.Fatalf("hookStaleAfterExit(nil) = %d, want staleNever", got)
	}
}
