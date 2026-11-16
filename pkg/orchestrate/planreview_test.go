// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// seedPlanReviewDag is a one-task dag submitted from a plan file: its plan review is open and nothing has run.
func seedPlanReviewDag(t *testing.T) (context.Context, *waveobj.TaskGroup) {
	t.Helper()
	ctx, dag := seedPendingDag(t)
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.PlanPath, g.SpecPath = "docs/superpowers/plans/p.md", "docs/superpowers/specs/s.md"
		g.PlanReview = NewPlanReview()
		RecomputeDagStatus(g)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return ctx, dag
}

// the review dialog sends an approval with quoted notes as text, which a lead not told otherwise takes for a
// change request; docreview.ts reads the header and the approve label.
func TestPlanReviewAskMentionsQuotedNotes(t *testing.T) {
	for _, want := range []string{
		"header `Plan review`",
		"an answer that starts with `Accept all and proceed` is an approval",
	} {
		if !strings.Contains(proceedPastPlanReview, want) {
			t.Fatalf("plan review ask missing %q:\n%s", want, proceedPastPlanReview)
		}
	}
}

func loadDag(t *testing.T, ctx context.Context, dagID string) *waveobj.TaskGroup {
	t.Helper()
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

// reviewerOf is the round's reviewer with lens.
func reviewerOf(t *testing.T, ctx context.Context, dagID, lens string) waveobj.PlanReviewer {
	t.Helper()
	for _, r := range loadDag(t, ctx, dagID).PlanReview.Reviewers {
		if r.Lens == lens {
			return r
		}
	}
	t.Fatalf("the round has no %s reviewer", lens)
	return waveobj.PlanReviewer{}
}

// passLenses records a pass from every reviewer still reviewing but the full one: the second pass.
func passLenses(t *testing.T, ctx context.Context, dagID string) {
	t.Helper()
	for _, r := range loadDag(t, ctx, dagID).PlanReview.Reviewers {
		if r.Lens != PlanReviewLens_Full && r.State == PlanReviewerState_Reviewing {
			if err := RecordPlanReviewVerdict(ctx, dagID, r.RunID, ReviewVerdict_Pass, r.Lens+" is fine", nil); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// startPlanReview runs the first tick, which spawns the round's reviewers, passes the second pass, and returns the
// full reviewer's run id: the round then settles on its verdict alone.
func startPlanReview(t *testing.T, ctx context.Context, dagID string) string {
	t.Helper()
	schedule(t, ctx, dagID)
	passLenses(t, ctx, dagID)
	runID := reviewerOf(t, ctx, dagID, PlanReviewLens_Full).RunID
	if runID == "" {
		t.Fatal("the first tick must spawn the plan reviewer")
	}
	return runID
}

func TestPlanReviewHoldsDispatchAndSpawnsTheReviewersInTheLandingTree(t *testing.T) {
	ctx, dag := seedPlanReviewDag(t)
	calls := captureSpawns(t)
	newFakeLead(t)
	schedule(t, ctx, dag.OID)
	schedule(t, ctx, dag.OID)
	g := loadDag(t, ctx, dag.OID)
	if g.Status != DagStatus_PlanReview || g.Tasks[0].State != TaskState_Pending || g.Tasks[0].RunID != "" {
		t.Fatalf("nothing may dispatch during plan review, got status %s task %s run %q", g.Status, g.Tasks[0].State, g.Tasks[0].RunID)
	}
	if len(*calls) != len(planRoundOneLenses) {
		t.Fatalf("want the round's %d reviewers across two ticks, got %d spawns", len(planRoundOneLenses), len(*calls))
	}
	owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range *calls {
		if c.cwd != owner.ProjectPath || c.opts.TaskId != "" {
			t.Fatalf("every reviewer runs in the landing tree with no task, got cwd %q task %q", c.cwd, c.opts.TaskId)
		}
	}
	c := (*calls)[0]
	if c.cwd != owner.ProjectPath || c.opts.TaskId != "" {
		t.Fatalf("the reviewer runs in the landing tree with no task, got cwd %q task %q", c.cwd, c.opts.TaskId)
	}
	for _, want := range []string{
		"plan reviewer for run " + g.RunID,
		filepath.Join(owner.ProjectPath, "docs/superpowers/specs/s.md"),
		filepath.Join(owner.ProjectPath, "docs/superpowers/plans/p.md"),
		"`wsh jarvis dag planreview pass \"<summary>\"`",
		"`wsh jarvis dag planreview fail \"<findings",
	} {
		if !strings.Contains(c.prompt, want) {
			t.Errorf("the brief must contain %q:\n%s", want, c.prompt)
		}
	}
	reviewer, err := wstore.GetRun(ctx, g.ChannelId, reviewerOf(t, ctx, dag.OID, PlanReviewLens_Full).RunID)
	if err != nil {
		t.Fatal(err)
	}
	if reviewer.StageRole != jarvis.UsageRole_PlanReviewer || reviewer.SessionId == "" || reviewer.DagORef != g.OID || reviewer.TaskId != "" {
		t.Fatalf("the reviewer's run must carry its role, session and dag and no task, got %+v", reviewer)
	}
}

func TestPlanReviewPassStartsDispatch(t *testing.T) {
	ctx, dag := seedPlanReviewDag(t)
	calls := captureSpawns(t)
	newFakeLead(t)
	reviewer := startPlanReview(t, ctx, dag.OID)
	if err := RecordPlanReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Pass, "every requirement has a task", nil); err != nil {
		t.Fatal(err)
	}
	if pr := loadDag(t, ctx, dag.OID).PlanReview; pr.State != PlanReviewState_Passed || pr.Findings != "every requirement has a task" {
		t.Fatalf("want passed with the summary, got %+v", pr)
	}
	schedule(t, ctx, dag.OID)
	g := loadDag(t, ctx, dag.OID)
	if n := len(*calls); g.Tasks[0].State != TaskState_Running || n != len(planRoundOneLenses)+1 || (*calls)[n-1].opts.TaskId != "t-0" {
		t.Fatalf("a pass dispatches the first layer, got task %s after %d spawns", g.Tasks[0].State, len(*calls))
	}
	if g.Status != DagStatus_Running {
		t.Fatalf("status = %s, want running", g.Status)
	}
}

func TestPlanReviewFailWakesTheLeadWithTheFindingsWhole(t *testing.T) {
	ctx, dag := seedPlanReviewDag(t)
	calls := captureSpawns(t)
	f := newFakeLead(t)
	reviewer := startPlanReview(t, ctx, dag.OID)
	findings := "Task 2 and Task 3 both edit engine.go with no Depends between them; add Depends on: Task 2 to Task 3. " +
		strings.Repeat("The spec's section 4.1 has no task. ", 20)
	if err := RecordPlanReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Fail, findings, nil); err != nil {
		t.Fatal(err)
	}
	pr := loadDag(t, ctx, dag.OID).PlanReview
	if pr.State != PlanReviewState_Failed || !strings.HasPrefix(pr.Findings, "[Full review] "+strings.TrimSpace(findings)+"\n\nPassed: ") {
		t.Fatalf("want failed with the findings whole, got %+v", pr)
	}
	joined := strings.Join(f.sends, "\n")
	if !strings.Contains(joined, flatLine(findings)) || !strings.Contains(joined, "run `wsh jarvis dag submit` again") {
		t.Fatalf("the wake must carry the findings whole and the resubmit, got %q", f.sends)
	}
	schedule(t, ctx, dag.OID)
	if g := loadDag(t, ctx, dag.OID); g.Status != DagStatus_PlanReview || g.Tasks[0].RunID != "" || len(*calls) != len(planRoundOneLenses) {
		t.Fatalf("a failed review dispatches nothing, got status %s after %d spawns", g.Status, len(*calls))
	}
}

func TestPlanReviewAfterTheLastRoundGoesToTheHuman(t *testing.T) {
	ctx, dag := seedPlanReviewDag(t)
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.PlanReview.Round = MaxPlanReviewRounds
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	calls := captureSpawns(t)
	f := newFakeLead(t)
	reviewer := startPlanReview(t, ctx, dag.OID)
	if err := AcceptPlanReview(ctx, dag.OID, "the human said go"); err == nil || !strings.Contains(err.Error(), "reviewing") {
		t.Fatalf("accept while the reviewer works must be refused, got %v", err)
	}
	if err := RecordPlanReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Fail, "still no task for 4.1", nil); err != nil {
		t.Fatal(err)
	}
	if want := "Put it to the human; " + proceedPastPlanReview; !strings.Contains(strings.Join(f.sends, "\n"), want) {
		t.Fatalf("after the last round the wake must say to forward, got %q", f.sends)
	}
	// the lead carries the accepted findings in while every task still waits: accept spawns the first ones (run 6c7652be)
	taskID := loadDag(t, ctx, dag.OID).Tasks[0].ID
	if err := AmendTask(ctx, dag.OID, taskID, "also cover 4.1"); err != nil {
		t.Fatalf("amend must reach a task while the plan review holds: %v", err)
	}
	if _, err := ReplacePlanReviewProposal(ctx, dag.OID, &waveobj.TaskGroup{PlanPath: "p.md", Tasks: []waveobj.TaskNode{{ID: "t-0", Label: "a", State: TaskState_Pending}}}); err == nil || !strings.Contains(err.Error(), "put it to the human") {
		t.Fatalf("a resubmit past the last round must be refused, got %v", err)
	}
	if err := AcceptPlanReview(ctx, dag.OID, " "); err == nil {
		t.Fatal("accept needs the human's reason")
	}
	if err := AcceptPlanReview(ctx, dag.OID, "the human said 4.1 is out of scope"); err != nil {
		t.Fatal(err)
	}
	schedule(t, ctx, dag.OID)
	g := loadDag(t, ctx, dag.OID)
	if g.PlanReview.State != PlanReviewState_Accepted || g.Tasks[0].State != TaskState_Running || len(*calls) != len(planRoundOneLenses)+1 {
		t.Fatalf("accept starts dispatch, got review %s task %s after %d spawns", g.PlanReview.State, g.Tasks[0].State, len(*calls))
	}
	if len(g.Tasks[0].LeadNotes) != 1 || g.Tasks[0].LeadNotes[0] != "also cover 4.1" {
		t.Fatalf("the spawned task must carry the note amended before accept, got %q", g.Tasks[0].LeadNotes)
	}
	if err := AcceptPlanReview(ctx, dag.OID, "again"); err == nil {
		t.Fatal("an accepted review cannot be accepted again")
	}
}

const autonomousAccept = "`wsh jarvis dag planreview accept \"autonomous run\"`"

func TestPlanReviewWakesAutonomous(t *testing.T) {
	for _, w := range []string{planReviewFailedWake(2, "no task for 4.1", true, true), planReviewLostWake(2, "exited", true, true)} {
		if !strings.Contains(w, "`wsh jarvis dag amend <task> \"<note>\"`") || !strings.Contains(w, autonomousAccept) || strings.Contains(w, proceedPastPlanReview) {
			t.Fatalf("an autonomous last round amends and accepts without the human, got %q", w)
		}
	}
	if w := planReviewFailedWake(1, "no task for 4.1", false, true); !strings.Contains(w, "run `wsh jarvis dag submit` again") {
		t.Fatalf("an autonomous earlier round revises and resubmits, got %q", w)
	}
	if planReviewLostWake(1, "exited", false, true) != planReviewLostWake(1, "exited", false, false) {
		t.Fatal("a lost reviewer before the last round is resubmitted either way")
	}

	// off, the last round goes to the human and an earlier one resubmits; each carries its round and reason
	for _, c := range []struct {
		got  string
		want []string
	}{
		{planReviewFailedWake(2, "no task for 4.1", true, false), []string{"round 2", "no task for 4.1", proceedPastPlanReview}},
		{planReviewFailedWake(1, "no task for 4.1", false, false), []string{"round 1", "no task for 4.1", "`wsh jarvis dag submit` again"}},
		{planReviewLostWake(2, "exited", true, false), []string{"round 2", "(exited)", proceedPastPlanReview}},
		{planReviewLostWake(1, "exited", false, false), []string{"round 1", "(exited)", "`wsh jarvis dag submit` again"}},
	} {
		for _, want := range c.want {
			if !strings.Contains(c.got, want) {
				t.Fatalf("off: %q is missing %q", c.got, want)
			}
		}
	}
}

// the verdict's caller reads the group's setting: an autonomous last round never reaches the human, and the refusal
// of a resubmit past it names the accept
func TestPlanReviewLastRoundAutonomous(t *testing.T) {
	ctx, dag := seedPlanReviewDag(t)
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.PlanReview.Round, g.Autonomous = MaxPlanReviewRounds, true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	captureSpawns(t)
	f := newFakeLead(t)
	reviewer := startPlanReview(t, ctx, dag.OID)
	if err := RecordPlanReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Fail, "still no task for 4.1", nil); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(f.sends, "\n")
	if !strings.Contains(joined, autonomousPastPlanReview) || strings.Contains(joined, proceedPastPlanReview) {
		t.Fatalf("an autonomous last round wakes the lead to amend and accept, got %q", f.sends)
	}
	_, err := ReplacePlanReviewProposal(ctx, dag.OID, &waveobj.TaskGroup{PlanPath: "p.md", Tasks: []waveobj.TaskNode{{ID: "t-0", Label: "a", State: TaskState_Pending}}})
	if err == nil || !strings.Contains(err.Error(), autonomousAccept) || strings.Contains(err.Error(), proceedPastPlanReview) {
		t.Fatalf("a resubmit past the last round on an autonomous run is refused with the accept, got %v", err)
	}
}

func TestResubmitReplacesAFailedPlanAndOpensTheNextRound(t *testing.T) {
	ctx, dag := seedPlanReviewDag(t)
	captureSpawns(t)
	newFakeLead(t)
	reviewer := startPlanReview(t, ctx, dag.OID)
	if PlanReviewReplaceable(loadDag(t, ctx, dag.OID)) {
		t.Fatal("a plan under review is not replaceable")
	}
	if err := RecordPlanReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Fail, "no task for 4.1", nil); err != nil {
		t.Fatal(err)
	}
	if !PlanReviewReplaceable(loadDag(t, ctx, dag.OID)) {
		t.Fatal("a failed review with nothing dispatched is replaceable")
	}
	revised := &waveobj.TaskGroup{Title: "revised", Parallelism: 1, PlanPath: "docs/superpowers/plans/p2.md", Verify: "go test ./...",
		Tasks: []waveobj.TaskNode{{ID: "t-1", Label: "a", State: TaskState_Pending}, {ID: "t-2", Label: "b", State: TaskState_Pending, Deps: []string{"t-1"}}}}
	if _, err := ReplacePlanReviewProposal(ctx, dag.OID, &waveobj.TaskGroup{Tasks: revised.Tasks}); err == nil {
		t.Fatal("a resubmit with no plan file would skip the review")
	}
	g, err := ReplacePlanReviewProposal(ctx, dag.OID, revised)
	if err != nil {
		t.Fatal(err)
	}
	if g.Title != "revised" || len(g.Tasks) != 2 || g.PlanPath != revised.PlanPath || g.Verify != "go test ./..." {
		t.Fatalf("the revision must replace the proposal, got %+v", g)
	}
	if pr := g.PlanReview; pr.State != PlanReviewState_Reviewing || pr.Round != 2 || len(pr.Reviewers) != 0 || pr.Findings != "" {
		t.Fatalf("want round 2 reviewing afresh, got %+v", pr)
	}
	if prior := g.PlanReview.Prior; prior == nil || !strings.HasPrefix(prior.Findings, "[Full review] no task for 4.1") {
		t.Fatalf("round 2 carries round 1's findings, got %+v", prior)
	}
	if stored := loadDag(t, ctx, dag.OID); stored.Status != DagStatus_PlanReview || len(stored.Tasks) != 2 {
		t.Fatalf("the replacement must be stored, got status %s with %d tasks", stored.Status, len(stored.Tasks))
	}
	if owner, err := wstore.GetRun(ctx, dag.ChannelId, dag.RunID); err != nil || owner.Title != "revised" {
		t.Fatalf("the owning run carries the revised plan's title, got %+v (err %v)", owner, err)
	}
}

func TestPlanReviewerThatEndsWithoutAVerdictIsReplacedOnceThenFails(t *testing.T) {
	ctx, dag := seedPlanReviewDag(t)
	calls := captureSpawns(t)
	stubStopRunWorkers(t)
	f := newFakeLead(t)
	first := startPlanReview(t, ctx, dag.OID)
	endRun(t, ctx, dag.ChannelId, first)
	schedule(t, ctx, dag.OID)
	spawned := len(planRoundOneLenses) + 1
	full := reviewerOf(t, ctx, dag.OID, PlanReviewLens_Full)
	if pr := loadDag(t, ctx, dag.OID).PlanReview; len(*calls) != spawned || full.RunID == "" || full.RunID == first || full.Respawns != 1 || pr.State != PlanReviewState_Reviewing {
		t.Fatalf("want one replacement reviewer, got %d spawns and %+v", len(*calls), pr)
	}
	// the second one goes silent past the timeout
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.PlanReview.Reviewers[0].StartedTs = time.Now().Add(-ReviewTimeout - time.Minute).UnixMilli()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	schedule(t, ctx, dag.OID)
	pr := loadDag(t, ctx, dag.OID).PlanReview
	if len(*calls) != spawned || pr.State != PlanReviewState_Failed || !strings.Contains(pr.Findings, "[Full review] did not finish: it gave no verdict") {
		t.Fatalf("the second loss fails the review, got %d spawns and %+v", len(*calls), pr)
	}
	if !strings.Contains(strings.Join(f.sends, "\n"), "wake: the plan reviewer did not finish in round 1 (it gave no verdict within") {
		t.Fatalf("the lead must be woken, got %q", f.sends)
	}
}

func TestPlanReviewVerdictsAreRefusedWhenTheyCannotApply(t *testing.T) {
	ctx, dag := seedPlanReviewDag(t)
	captureSpawns(t)
	newFakeLead(t)
	reviewer := startPlanReview(t, ctx, dag.OID)
	cases := []struct{ name, run, verdict, text string }{
		{"not the reviewer", "some-other-run", ReviewVerdict_Pass, "ok"},
		{"unknown verdict", reviewer, "maybe", "ok"},
		{"no text", reviewer, ReviewVerdict_Fail, "  "},
		{"too long", reviewer, ReviewVerdict_Fail, strings.Repeat("x", MaxReviewNoteLen+1)},
	}
	for _, c := range cases {
		if err := RecordPlanReviewVerdict(ctx, dag.OID, c.run, c.verdict, c.text, nil); err == nil {
			t.Errorf("%s: want refused", c.name)
		}
	}
	if pr := loadDag(t, ctx, dag.OID).PlanReview; pr.State != PlanReviewState_Reviewing {
		t.Fatalf("a refused verdict changes nothing, got %+v", pr)
	}
	if err := RecordPlanReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Pass, "fine", nil); err != nil {
		t.Fatal(err)
	}
	if err := RecordPlanReviewVerdict(ctx, dag.OID, reviewer, ReviewVerdict_Fail, "second thoughts", nil); err == nil {
		t.Fatal("a second verdict must be refused")
	}
}

// the watchdog never ticks a cancelled dag, so cancel itself must stop every live plan reviewer
func TestCancelStopsEveryPlanReviewer(t *testing.T) {
	ctx, dag := seedPlanReviewDag(t)
	captureSpawns(t)
	newFakeLead(t)
	schedule(t, ctx, dag.OID)
	reviewers := loadDag(t, ctx, dag.OID).PlanReview.Reviewers
	var stopped []string
	old := stopRunWorkers
	stopRunWorkers = func(_ context.Context, r *waveobj.Run) error {
		stopped = append(stopped, r.ID)
		return nil
	}
	restoreAfterStages(t, func() { stopRunWorkers = old })
	if err := Cancel(ctx, dag.OID); err != nil {
		t.Fatal(err)
	}
	if len(reviewers) != len(planRoundOneLenses) {
		t.Fatalf("want the round's reviewers running, got %+v", reviewers)
	}
	for _, r := range reviewers {
		run, err := wstore.GetRun(ctx, dag.ChannelId, r.RunID)
		if err != nil {
			t.Fatal(err)
		}
		if run.Status != jarvis.RunStatus_Cancelled {
			t.Fatalf("the %s reviewer's run must be cancelled, got %q", r.Lens, run.Status)
		}
		if !strings.Contains(strings.Join(stopped, ","), r.RunID) {
			t.Fatalf("the %s reviewer's session must be stopped, stopped %q", r.Lens, stopped)
		}
	}
}

// a dag submitted as JSON has no plan to review, so it dispatches on its first tick as before
func TestADagWithNoPlanReviewDispatchesAtOnce(t *testing.T) {
	ctx, dag := seedPendingDag(t)
	calls := captureSpawns(t)
	schedule(t, ctx, dag.OID)
	if g := loadDag(t, ctx, dag.OID); g.PlanReview != nil || g.Tasks[0].State != TaskState_Running || len(*calls) != 1 {
		t.Fatalf("want the task dispatched, got review %+v task %s", g.PlanReview, g.Tasks[0].State)
	}
}

// long findings would fill the lead's composer: the wake keeps whole findings up to the cap and names the command
// that prints the rest
func TestAPlanReviewFailedWakeCapsLongFindings(t *testing.T) {
	var blocks []string
	for i := 0; i < 5; i++ {
		blocks = append(blocks, fmt.Sprintf("[Lens %d] %s", i, strings.Repeat("x ", MaxReviewNoteLen/2)))
	}
	findings := strings.Join(blocks, "\n\n")
	for _, last := range []bool{false, true} {
		w := planReviewFailedWake(1, findings, last, false)
		if !strings.Contains(w, "[Lens 0]") || strings.Contains(w, "[Lens 4]") {
			t.Fatalf("the wake keeps the first findings and drops the rest, got %d chars", len(w))
		}
		if !strings.Contains(w, "more characters: "+planReviewFindingsCmd) || strings.Contains(w, "\n") {
			t.Fatalf("the wake is one line naming %q for the rest, got %q", planReviewFindingsCmd, w[len(w)-200:])
		}
		if n := len([]rune(w)); n > reportSectionMaxLen+len(proceedPastPlanReview)+300 {
			t.Fatalf("the wake is capped, got %d runes", n)
		}
	}
}
