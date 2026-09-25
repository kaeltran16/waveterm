// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Plan review states (TaskGroup.PlanReview.State).
const (
	PlanReviewState_Reviewing = "reviewing"
	PlanReviewState_Passed    = "passed"
	PlanReviewState_Failed    = "failed"
	PlanReviewState_Accepted  = "accepted" // failed, and the lead proceeded on the human's word
)

// MaxPlanReviewRounds is how many reviews a plan gets before the lead must put it to the human: the first, and
// one after the lead revised it.
const MaxPlanReviewRounds = 2

// NewPlanReview is the review a plan-file submit starts with.
func NewPlanReview() *waveobj.PlanReviewStage {
	return &waveobj.PlanReviewStage{State: PlanReviewState_Reviewing, Round: 1}
}

// planReviewHolds reports a plan the engine has not cleared yet. Workers would build on a plan whose gaps a
// reviewer is about to report, so nothing dispatches until the review passed or the lead accepted it.
func planReviewHolds(g *waveobj.TaskGroup) bool {
	pr := g.PlanReview
	return pr != nil && pr.State != PlanReviewState_Passed && pr.State != PlanReviewState_Accepted
}

// advancePlanReview keeps the plan reviewer going while the review is open. A reviewer that could not
// finish twice fails the review for the lead, like a failed verdict.
func advancePlanReview(ctx, spawnCtx context.Context, g *waveobj.TaskGroup, owner *waveobj.Run, now int64, afterCommit *[]func()) {
	pr := g.PlanReview
	if pr == nil || pr.State != PlanReviewState_Reviewing {
		return
	}
	tree := jarvis.LandPath(owner)
	session := func() StageSession {
		return StageSession{Role: jarvis.UsageRole_PlanReviewer, Label: "plan review", Tree: tree, Prompt: planReviewPrompt(g, tree)}
	}
	reason := tendStageSession(ctx, spawnCtx, g, owner, session, &pr.RunID, &pr.StartedTs, &pr.Respawns, now, afterCommit)
	if reason == "" {
		return
	}
	pr.State, pr.Findings = PlanReviewState_Failed, "the plan reviewer did not finish: "+reason
	round, findings, last := pr.Round, pr.Findings, pr.Round >= MaxPlanReviewRounds
	*afterCommit = append(*afterCommit, func() {
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindPlanReviewed, nil, map[string]any{"state": PlanReviewState_Failed, "round": round, "findings": findings})
		PostWake(ctx, g.ChannelId, g.RunID, planReviewLostWake(round, reason, last))
	})
}

// planReviewPrompt is the plan reviewer's brief. It reads the docs in tree, the landing tree, where a
// branch-landed dag committed them at submit.
func planReviewPrompt(g *waveobj.TaskGroup, tree string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "You are the plan reviewer for run %s. Before any worker starts, judge whether the plan can be run as written.\n", g.RunID)
	if g.SpecPath != "" {
		fmt.Fprintf(&b, "Read the spec at %s, ", DocPath(g, tree, g.SpecPath))
	} else {
		b.WriteString("There is no spec file. Read ")
	}
	fmt.Fprintf(&b, "the plan at %s, and the files they name.\n", DocPath(g, tree, g.PlanPath))
	b.WriteString("Check that:\n")
	b.WriteString("- every requirement in the spec has a task;\n")
	b.WriteString("- no two tasks edit the same file without a Depends between them, since tasks with nothing between them run at the same time;\n")
	b.WriteString("- types, functions and flags have the same names in every task that mentions them;\n")
	b.WriteString("- each task names its tests;\n")
	b.WriteString("- the commands the plan names (its Verify, Setup and Check lines, and those in its tasks) exist.\n")
	b.WriteString("Also report gaps in the spec, and places where the spec and the plan contradict each other.\n")
	b.WriteString("Only read: never edit, stage or commit, and ask no questions, since nobody answers a reviewer.\n")
	b.WriteString("Finish with exactly one command, which ends your session:\n")
	b.WriteString("- `wsh jarvis dag planreview pass \"<summary>\"`;\n")
	b.WriteString("- `wsh jarvis dag planreview fail \"<findings: each problem, where it is, and the fix>\"`.\n")
	fmt.Fprintf(&b, "Keep the text within %d characters; a longer one is refused.", MaxReviewNoteLen)
	return b.String()
}

// RecordPlanReviewVerdict applies the plan reviewer's verdict. A pass lets dispatch start; a fail goes to the
// lead with the findings whole, since it has to revise the plan from them. It does not schedule: the caller
// does, off the reviewer's RPC.
func RecordPlanReviewVerdict(ctx context.Context, dagID, reviewerRunID, verdict, text string) error {
	text = strings.TrimSpace(text)
	switch {
	case verdict != ReviewVerdict_Pass && verdict != ReviewVerdict_Fail:
		return fmt.Errorf("verdict must be %s or %s, got %q", ReviewVerdict_Pass, ReviewVerdict_Fail, verdict)
	case text == "":
		return fmt.Errorf("a %s verdict needs its text: the summary for a pass, the findings for a fail", verdict)
	}
	// refused rather than clipped: the lead revises the plan from these findings
	if count := utf8.RuneCountInString(text); count > MaxReviewNoteLen {
		return fmt.Errorf("the text is %d characters; the limit is %d. Shorten it and send the verdict again", count, MaxReviewNoteLen)
	}
	return mutatePlanReview(ctx, dagID, func(g *waveobj.TaskGroup, pr *waveobj.PlanReviewStage, afterCommit *[]func()) error {
		if pr.State != PlanReviewState_Reviewing || pr.RunID != reviewerRunID {
			return fmt.Errorf("run %s is not reviewing this dag's plan", reviewerRunID)
		}
		pr.Findings = text
		round, last := pr.Round, pr.Round >= MaxPlanReviewRounds
		if verdict == ReviewVerdict_Pass {
			pr.State = PlanReviewState_Passed
			*afterCommit = append(*afterCommit, func() {
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindPlanReviewed, nil, map[string]any{"state": PlanReviewState_Passed, "round": round, "findings": text})
				PostQuiet(ctx, g.ChannelId, g.RunID, "plan review passed; workers are starting: "+flatLine(text))
			})
			return nil
		}
		pr.State = PlanReviewState_Failed
		*afterCommit = append(*afterCommit, func() {
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindPlanReviewed, nil, map[string]any{"state": PlanReviewState_Failed, "round": round, "findings": text})
			PostWake(ctx, g.ChannelId, g.RunID, planReviewFailedWake(round, text, last))
		})
		return nil
	})
}

// AcceptPlanReview proceeds past a failed plan review on the human's word, which reason records.
func AcceptPlanReview(ctx context.Context, dagID, reason string) error {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return fmt.Errorf("accept needs the human's reason for proceeding")
	}
	return mutatePlanReview(ctx, dagID, func(g *waveobj.TaskGroup, pr *waveobj.PlanReviewStage, afterCommit *[]func()) error {
		if pr.State != PlanReviewState_Failed {
			return fmt.Errorf("the plan review is %s; accept proceeds past a failed one only", pr.State)
		}
		pr.State = PlanReviewState_Accepted
		round := pr.Round
		*afterCommit = append(*afterCommit, func() {
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindPlanReviewed, nil, map[string]any{"state": PlanReviewState_Accepted, "round": round, "reason": reason})
		})
		return nil
	})
}

// PlanReviewReplaceable reports a dag whose proposal a resubmit replaces: its plan review failed and no task
// ever dispatched, so nothing has been built on the plan being revised.
func PlanReviewReplaceable(g *waveobj.TaskGroup) bool {
	if g.PlanReview == nil || g.PlanReview.State != PlanReviewState_Failed {
		return false
	}
	for i := range g.Tasks {
		if g.Tasks[i].RunID != "" || g.Tasks[i].State != TaskState_Pending || g.Tasks[i].Attempts != 0 {
			return false
		}
	}
	return true
}

// ReplacePlanReviewProposal puts a revised plan in place of one whose review failed, and opens the next
// review round on it. The run keeps its one dag; only the proposal changes.
func ReplacePlanReviewProposal(ctx context.Context, dagID string, proposed *waveobj.TaskGroup) (*waveobj.TaskGroup, error) {
	if proposed.PlanPath == "" {
		return nil, fmt.Errorf("resubmit the revised plan as a plan file, so it is reviewed again")
	}
	var out *waveobj.TaskGroup
	err := mutatePlanReview(ctx, dagID, func(g *waveobj.TaskGroup, pr *waveobj.PlanReviewStage, _ *[]func()) error {
		if !PlanReviewReplaceable(g) {
			return fmt.Errorf("dag conflict: run %s's plan review is %s, so its dag can no longer be replaced", g.RunID, pr.State)
		}
		if pr.Round >= MaxPlanReviewRounds {
			return fmt.Errorf("the plan review failed %d rounds, the most it gets; put it to the human, and if they say to proceed run `wsh jarvis dag planreview accept \"<the human's reason>\"`", pr.Round)
		}
		g.Title, g.Parallelism, g.WorkerRoute, g.Tasks = proposed.Title, proposed.Parallelism, proposed.WorkerRoute, proposed.Tasks
		g.Verify, g.Setup, g.Check, g.Preamble = proposed.Verify, proposed.Setup, proposed.Check, proposed.Preamble
		g.EffortOID, g.PlanPath, g.SpecPath = proposed.EffortOID, proposed.PlanPath, proposed.SpecPath
		g.PlanReview = &waveobj.PlanReviewStage{State: PlanReviewState_Reviewing, Round: pr.Round + 1}
		out = g
		return nil
	})
	return out, err
}

// mutatePlanReview changes a dag's plan review under the dag mutation lock, persists it, and then runs what
// fn queued for after the write.
func mutatePlanReview(ctx context.Context, dagID string, fn func(g *waveobj.TaskGroup, pr *waveobj.PlanReviewStage, afterCommit *[]func()) error) error {
	var afterCommit []func()
	err := withDagMutation(dagID, func() error {
		g, err := wstore.GetDag(ctx, dagID)
		if err != nil {
			return fmt.Errorf("loading dag: %w", err)
		}
		if g.PlanReview == nil {
			return fmt.Errorf("dag %s has no plan review", dagID)
		}
		if g.Status == DagStatus_Cancelled {
			return fmt.Errorf("dag %s is cancelled", dagID)
		}
		if err := fn(g, g.PlanReview, &afterCommit); err != nil {
			return err
		}
		RecomputeDagStatus(g)
		g.UpdatedTs = time.Now().UnixMilli()
		if err := wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
			*cur = *g
			return nil
		}); err != nil {
			return err
		}
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
		return nil
	})
	if err != nil {
		return err
	}
	for _, f := range afterCommit {
		f()
	}
	return nil
}

// planReviewOpen reports a plan review whose reviewer is still at work.
func planReviewOpen(g *waveobj.TaskGroup) bool {
	return g.PlanReview != nil && g.PlanReview.State == PlanReviewState_Reviewing
}
