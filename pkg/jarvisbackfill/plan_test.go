// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisbackfill

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const day = int64(24 * 60 * 60 * 1000)

func run(oid, goal, status string, created, completed int64) *waveobj.Run {
	return &waveobj.Run{
		OID:         oid,
		Goal:        goal,
		Status:      status,
		ProjectPath: "/repo/waveterm",
		CreatedTs:   created,
		CompletedTs: completed,
	}
}

func findGroupKey(t *testing.T, goal string) string {
	t.Helper()
	return groupKey(goal)
}

func TestGroupKeyExtractsReferencedArtifact(t *testing.T) {
	cases := map[string]string{
		`check docs\superpowers\specs\deferred-appendix-briefs.md, start group 3`: "docs/superpowers/specs/deferred-appendix-briefs.md",
		"execute this plan docs/superpowers/plans/2026-07-22-agent-diff.md":       "docs/superpowers/plans/2026-07-22-agent-diff.md",
		"the usage tab still shows all-time stats when switching tabs":            "",
	}
	for goal, want := range cases {
		if got := findGroupKey(t, goal); got != want {
			t.Errorf("groupKey(%.40q) = %q, want %q", goal, got, want)
		}
	}
}

func TestGroupKeyIsSeparatorAndCaseInsensitive(t *testing.T) {
	a := groupKey(`check docs\Superpowers\Specs\Briefs.MD now`)
	b := groupKey("check docs/superpowers/specs/briefs.md now")
	if a == "" || a != b {
		t.Fatalf("separator/case normalization failed: %q vs %q", a, b)
	}
}

// The five real "deferred-appendix-briefs" runs must collapse into one dossier — that multi-run
// shape is the only thing in this corpus that exercises D's mixed confirmed/informing edges.
func TestBuildPlanGroupsRunsSharingAnArtifact(t *testing.T) {
	base := int64(1_000_000)
	runs := []*waveobj.Run{
		run("r1", `check docs\superpowers\specs\briefs.md, start group 1`, "done", base+2*day, base+3*day),
		run("r2", `check docs\superpowers\specs\briefs.md, start group 2`, "done", base+day, base+2*day),
		run("r3", "unrelated one-off fix", "done", base, base+day),
	}
	p := BuildPlan(runs, nil, base+10*day)
	if len(p.Dossiers) != 2 {
		t.Fatalf("want 2 dossiers, got %d", len(p.Dossiers))
	}
	var grouped *PlannedDossier
	for i := range p.Dossiers {
		if len(p.Dossiers[i].RunOIDs) == 2 {
			grouped = &p.Dossiers[i]
		}
	}
	if grouped == nil {
		t.Fatal("no 2-run dossier produced")
	}
	// owner is the earliest run, and it leads RunOIDs so apply writes its ref as the L1 edge
	if grouped.OwnerRun != "r2" {
		t.Errorf("owner = %q, want r2 (earliest CreatedTs)", grouped.OwnerRun)
	}
	if grouped.RunOIDs[0] != "r2" {
		t.Errorf("RunOIDs[0] = %q, want owner first", grouped.RunOIDs[0])
	}
}

// windowsOverlap needs rEnd >= d.Created. A dossier stamped "now" can never overlap a historical
// run, so backdating to the owner's CreatedTs is what makes L3 fire at all.
func TestBuildPlanBackdatesDossierToRunWindow(t *testing.T) {
	base := int64(1_000_000)
	runs := []*waveobj.Run{
		run("r1", `check docs\a\briefs.md group 1`, "done", base+2*day, base+3*day),
		run("r2", `check docs\a\briefs.md group 2`, "done", base+day, base+2*day),
	}
	p := BuildPlan(runs, nil, base+10*day)
	d := p.Dossiers[0]
	if d.Facts.Created != base+day {
		t.Errorf("Created = %d, want %d (earliest run)", d.Facts.Created, base+day)
	}
	if d.Updated != base+3*day {
		t.Errorf("Updated = %d, want %d (latest completion)", d.Updated, base+3*day)
	}
}

func TestBuildPlanMapsRunStatusToDossierStatus(t *testing.T) {
	base := int64(1_000_000)
	cases := map[string]string{
		"done":            "completed",
		"cancelled":       "archived",
		"executing":       "active",
		"blocked":         "active",
		"awaiting-review": "active",
	}
	for runStatus, want := range cases {
		p := BuildPlan([]*waveobj.Run{run("r1", "some goal", runStatus, base, 0)}, nil, base+day)
		if got := p.Dossiers[0].Status; got != want {
			t.Errorf("run status %q -> %q, want %q", runStatus, got, want)
		}
	}
}

// A mixed group must not read as finished just because one run completed.
func TestBuildPlanGroupStatusPrefersUnfinished(t *testing.T) {
	base := int64(1_000_000)
	runs := []*waveobj.Run{
		run("r1", `check docs\a\b.md one`, "done", base, base+day),
		run("r2", `check docs\a\b.md two`, "executing", base+day, 0),
	}
	p := BuildPlan(runs, nil, base+5*day)
	if p.Dossiers[0].Status != "active" {
		t.Errorf("status = %q, want active (one run still running)", p.Dossiers[0].Status)
	}
}

func TestNormalizeObjectiveStripsAttachmentTail(t *testing.T) {
	got := normalizeObjective("this should be at the bottom\n\nAttachments (read these files first):\n- /tmp/x.png")
	if got != "this should be at the bottom" {
		t.Errorf("got %q", got)
	}
}

func TestNormalizeObjectiveCollapsesWhitespaceAndBounds(t *testing.T) {
	if got := normalizeObjective("  a   b \n c  "); got != "a b c" {
		t.Errorf("collapse: got %q", got)
	}
	long := make([]byte, 500)
	for i := range long {
		long[i] = 'x'
	}
	if got := normalizeObjective(string(long)); len(got) > maxObjectiveChars {
		t.Errorf("bound: len = %d, want <= %d", len(got), maxObjectiveChars)
	}
}

func report(findings ...waveobj.RadarFinding) *waveobj.RadarReport {
	return &waveobj.RadarReport{OID: "rep1", Findings: findings}
}

func finding(id, risk string, inv *waveobj.RadarInvestigation) waveobj.RadarFinding {
	return waveobj.RadarFinding{ID: id, Risk: risk, Investigation: inv}
}

func TestBuildPlanDerivesDecisionsFromCompletedInvestigations(t *testing.T) {
	base := int64(1_000_000)
	runs := []*waveobj.Run{run("r1", "fix the thing", "done", base, base+day)}
	reps := []*waveobj.RadarReport{report(
		finding("f1", "leaky handle", &waveobj.RadarInvestigation{RunID: "r1", Status: "done", Summary: "closed by narrowing the scope"}),
	)}
	p := BuildPlan(runs, reps, base+5*day)
	if len(p.Decisions) != 1 {
		t.Fatalf("want 1 decision, got %d", len(p.Decisions))
	}
	d := p.Decisions[0]
	if d.Facts.Rationale != "closed by narrowing the scope" {
		t.Errorf("rationale = %q, want the recorded summary verbatim", d.Facts.Rationale)
	}
	if d.Facts.Provenance != provRadarInvestigation {
		t.Errorf("provenance = %q", d.Facts.Provenance)
	}
	if d.OwnerRunOID != "r1" {
		t.Errorf("OwnerRunOID = %q, want r1", d.OwnerRunOID)
	}
}

// Strict fidelity: an investigation with no recorded summary is not a decision, it is a gap.
func TestBuildPlanSkipsInvestigationsWithoutRecordedOutcome(t *testing.T) {
	base := int64(1_000_000)
	runs := []*waveobj.Run{run("r1", "fix the thing", "done", base, base+day)}
	reps := []*waveobj.RadarReport{report(
		finding("f1", "no summary", &waveobj.RadarInvestigation{RunID: "r1", Status: "done", Summary: ""}),
		finding("f2", "still running", &waveobj.RadarInvestigation{RunID: "r1", Status: "executing", Summary: "partial"}),
		finding("f3", "no investigation", nil),
	)}
	p := BuildPlan(runs, reps, base+5*day)
	if len(p.Decisions) != 0 {
		t.Fatalf("want 0 decisions, got %d", len(p.Decisions))
	}
	if len(p.Skipped) == 0 {
		t.Error("skips should be reported, not silent")
	}
}

func TestBuildPlanSkipsDecisionForUnknownRun(t *testing.T) {
	base := int64(1_000_000)
	reps := []*waveobj.RadarReport{report(
		finding("f1", "orphan", &waveobj.RadarInvestigation{RunID: "ghost", Status: "done", Summary: "did a thing"}),
	)}
	p := BuildPlan(nil, reps, base)
	if len(p.Decisions) != 0 {
		t.Fatalf("want 0 decisions for an unknown run, got %d", len(p.Decisions))
	}
	if len(p.Skipped) != 1 {
		t.Fatalf("want the orphan reported as skipped, got %d skips", len(p.Skipped))
	}
}

func TestBuildPlanIsDeterministic(t *testing.T) {
	base := int64(1_000_000)
	runs := []*waveobj.Run{
		run("r1", `check docs\a\b.md one`, "done", base, base+day),
		run("r2", "standalone", "done", base+day, base+2*day),
		run("r3", `check docs\a\b.md two`, "done", base+2*day, base+3*day),
	}
	first := BuildPlan(runs, nil, base+9*day)
	for i := 0; i < 5; i++ {
		got := BuildPlan(runs, nil, base+9*day)
		if len(got.Dossiers) != len(first.Dossiers) {
			t.Fatalf("dossier count varies across runs")
		}
		for j := range got.Dossiers {
			if got.Dossiers[j].OwnerRun != first.Dossiers[j].OwnerRun {
				t.Fatalf("ordering/owner not deterministic at %d", j)
			}
		}
	}
}

// boundedSlug truncates, so two goals sharing a long prefix map to the same filename and the second
// silently loses to a create-collision. Real case: two "execute this plan docs/superpowers/plans/
// 2026-07-22-..." runs naming different plan files.
func TestBuildPlanDisambiguatesCollidingDossierIDs(t *testing.T) {
	base := int64(1_000_000)
	runs := []*waveobj.Run{
		run("r1", `execute this plan docs/superpowers/plans/2026-07-22-agent-diff-base-selection.md`, "done", base, base+day),
		run("r2", `execute this plan docs/superpowers/plans/2026-07-22-cockpit-background-agents.md`, "done", base+day, base+2*day),
	}
	p := BuildPlan(runs, nil, base+5*day)
	if len(p.Dossiers) != 2 {
		t.Fatalf("want 2 dossiers, got %d", len(p.Dossiers))
	}
	a := jarvisdossier.DossierID(p.Dossiers[0].Facts)
	b := jarvisdossier.DossierID(p.Dossiers[1].Facts)
	if a == b {
		t.Fatalf("colliding dossier ids not disambiguated: both %q", a)
	}
}

func TestBuildPlanDisambiguatesCollidingDecisionSlugs(t *testing.T) {
	base := int64(1_000_000)
	runs := []*waveobj.Run{run("r1", "some work", "done", base, base+day)}
	long := "the input validation security boundary was modified in a way that may permit unchecked values"
	reps := []*waveobj.RadarReport{report(
		finding("f1", long+" in the parser", &waveobj.RadarInvestigation{RunID: "r1", Status: "done", Summary: "one"}),
		finding("f2", long+" in the writer", &waveobj.RadarInvestigation{RunID: "r1", Status: "done", Summary: "two"}),
	)}
	p := BuildPlan(runs, reps, base+5*day)
	if len(p.Decisions) != 2 {
		t.Fatalf("want 2 decisions, got %d", len(p.Decisions))
	}
	a := jarvisdossier.DecisionSlug(p.Decisions[0].Facts.Summary)
	b := jarvisdossier.DecisionSlug(p.Decisions[1].Facts.Summary)
	if a == b {
		t.Fatalf("colliding decision slugs not disambiguated: both %q", a)
	}
}

// Three colliding summaries on the same run: the discriminator alone is not enough, since it is the
// same run oid every time.
func TestBuildPlanDisambiguatesThreeWayDecisionCollision(t *testing.T) {
	base := int64(1_000_000)
	runs := []*waveobj.Run{run("r1", "some work", "done", base, base+day)}
	long := "the input validation security boundary was modified in a way that may permit unchecked values"
	reps := []*waveobj.RadarReport{report(
		finding("f1", long+" alpha", &waveobj.RadarInvestigation{RunID: "r1", Status: "done", Summary: "one"}),
		finding("f2", long+" bravo", &waveobj.RadarInvestigation{RunID: "r1", Status: "done", Summary: "two"}),
		finding("f3", long+" delta", &waveobj.RadarInvestigation{RunID: "r1", Status: "done", Summary: "three"}),
	)}
	p := BuildPlan(runs, reps, base+5*day)
	slugs := map[string]bool{}
	for _, d := range p.Decisions {
		s := jarvisdossier.DecisionSlug(d.Facts.Summary)
		if slugs[s] {
			t.Fatalf("duplicate decision slug %q", s)
		}
		slugs[s] = true
	}
	if len(slugs) != 3 {
		t.Fatalf("want 3 distinct slugs, got %d", len(slugs))
	}
}

// Runs with no goal text at all carry no objective, so they are not a dossier.
func TestBuildPlanSkipsRunsWithBlankGoal(t *testing.T) {
	base := int64(1_000_000)
	p := BuildPlan([]*waveobj.Run{run("r1", "   ", "done", base, base+day)}, nil, base+2*day)
	if len(p.Dossiers) != 0 {
		t.Fatalf("want 0 dossiers, got %d", len(p.Dossiers))
	}
	if len(p.Skipped) != 1 {
		t.Errorf("blank-goal run should be reported as skipped")
	}
}
