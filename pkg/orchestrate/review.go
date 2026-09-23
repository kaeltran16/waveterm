// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	// MaxReviewRounds is how many failed reviews a task takes before the lead judges it: one round back to a
	// worker with the findings, then the lead.
	MaxReviewRounds = 2
	// MaxReviewRespawns is how many times a round's reviewer is replaced after ending without a verdict.
	MaxReviewRespawns = 1
	// ReviewTimeout bounds one reviewer. Reading a diff against its task takes minutes; one silent past this
	// is stuck whatever its process says.
	ReviewTimeout = 20 * time.Minute
	// MaxReviewNoteLen bounds a verdict's note in runes: it goes into a worker's prompt and the lead's status.
	MaxReviewNoteLen = 2000
	// reviewEvidenceWait is how long review waits for the worker's evidence seal, which runs off the completion
	// RPC and carries the worker's closing note: the one account of its work the reviewer gets.
	reviewEvidenceWait = time.Minute
)

// reviewTreeHead reads the lane tree's HEAD, and resetReviewTree moves the lane's branch back to the worker's
// commit. Vars so tests need no repo.
var reviewTreeHead = func(ctx context.Context, wt string) (string, error) {
	return git(ctx, wt, "rev-parse", "HEAD")
}

var resetReviewTree = func(ctx context.Context, wt, commit string) error {
	_, err := git(ctx, wt, "reset", "--hard", commit)
	return err
}

func taskByReviewRunID(g *waveobj.TaskGroup, runID string) *waveobj.TaskNode {
	for i := range g.Tasks {
		if g.Tasks[i].ReviewRunID != "" && g.Tasks[i].ReviewRunID == runID {
			return &g.Tasks[i]
		}
	}
	return nil
}

// advanceReviews moves every reviewing task one step: a recorded verdict is applied, a reviewer that ended
// without one is replaced once, and a task with no reviewer gets one. It runs in the tick, before the task-done
// accounting, so a pass is counted done in the tick that applies it.
func advanceReviews(ctx, spawnCtx context.Context, g *waveobj.TaskGroup, owner *waveobj.Run, runs map[string]*waveobj.Run, now int64, afterCommit *[]func()) {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State != TaskState_Reviewing {
			continue
		}
		worker := runs[t.RunID]
		if worker == nil {
			continue // unreadable this tick; the next one retries
		}
		if t.ReviewRunID != "" && t.ReviewVerdict != "" {
			applyReviewVerdict(ctx, g, t, worker, afterCommit)
			continue
		}
		if t.ReviewRunID != "" {
			reason := reviewerLost(ctx, g, t, now)
			if reason == "" {
				continue
			}
			stopReviewer(ctx, g, t.ReviewRunID, afterCommit)
			t.ReviewRunID = ""
			if !spendReviewRespawn(ctx, g, t, reason, afterCommit) {
				continue
			}
		}
		if worker.Evidence == nil && now-workerDoneTs(worker) < reviewEvidenceWait.Milliseconds() {
			continue
		}
		spawnReviewer(ctx, spawnCtx, g, t, owner, worker, now, afterCommit)
	}
}

// workerDoneTs is when the worker's run finished: its latest phase completion.
func workerDoneTs(run *waveobj.Run) int64 {
	var ts int64
	for _, p := range run.Phases {
		if p.DoneTs > ts {
			ts = p.DoneTs
		}
	}
	return ts
}

// spawnReviewer starts a task's reviewer in the worker's lane tree, on the lead's route: the model picked for
// judgment, and not the worker's own.
func spawnReviewer(ctx, spawnCtx context.Context, g *waveobj.TaskGroup, t *waveobj.TaskNode, owner, worker *waveobj.Run, now int64, afterCommit *[]func()) {
	pin := waveobj.RoutePin{Runtime: runroute.DefaultRuntime(owner.Runtime), Model: owner.Model}
	capability, err := runroute.Resolve(pin)
	if err == nil {
		err = validateWorkerHarness(pin.Runtime)
	}
	if err != nil {
		failReview(ctx, g, t, "reviewer could not start: "+err.Error(), afterCommit)
		return
	}
	prompt := reviewPrompt(g, t, worker)
	runID, sessionId := uuid.NewString(), uuid.NewString()
	oref, err := spawnWorker(spawnCtx, capability, owner.WorkspaceId, "", worker.ProjectPath, prompt,
		jarvis.RunWorkerOptions{SessionId: sessionId, RunId: runID, TaskId: t.ID, Label: "review " + t.ID})
	if err != nil {
		spendReviewRespawn(ctx, g, t, "reviewer could not start: "+err.Error(), afterCommit)
		return
	}
	child := childRunFromSpec(g, t, owner, pin, worker.ProjectPath, worker.EndCommit, prompt)
	child.ID = runID
	child.SessionId = sessionId
	for i := range child.Phases {
		if child.Phases[i].State == jarvis.PhaseState_Running {
			child.Phases[i].WorkerOrefs = []string{oref}
			break
		}
	}
	if err := appendChildRun(spawnCtx, g.ChannelId, child); err != nil {
		if serr := stopSpawnedWorker(spawnCtx, oref); serr != nil {
			log.Printf("dag %s task %s: stopping unrecorded reviewer %s: %v", g.OID, t.ID, oref, serr)
		}
		spendReviewRespawn(ctx, g, t, "recording the reviewer failed: "+err.Error(), afterCommit)
		return
	}
	runORef := waveobj.MakeORef(waveobj.OType_Run, runID).String()
	channelORef := waveobj.MakeORef(waveobj.OType_Channel, g.ChannelId).String()
	if err := stampSpawnedWorker(spawnCtx, oref, runORef, channelORef); err != nil {
		log.Printf("dag %s task %s: stamp reviewer %s: %v", g.OID, t.ID, oref, err)
	}
	t.ReviewRunID, t.ReviewSpawnedTs = runID, now
	taskID := t.ID
	*afterCommit = append(*afterCommit, func() {
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Run, runID))
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, g.ChannelId))
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskReviewStarted, nil, map[string]any{"taskid": taskID, "runid": runID})
	})
}

// reviewerLost says why a reviewer with no verdict is done for, or "" while it is still working.
func reviewerLost(ctx context.Context, g *waveobj.TaskGroup, t *waveobj.TaskNode, now int64) string {
	if now-t.ReviewSpawnedTs > ReviewTimeout.Milliseconds() {
		return fmt.Sprintf("reviewer gave no verdict within %s", ReviewTimeout)
	}
	run, err := wstore.GetRun(ctx, g.ChannelId, t.ReviewRunID)
	if err != nil {
		return "" // unreadable this tick; the timeout still bounds it
	}
	switch run.Status {
	case jarvis.RunStatus_Done, jarvis.RunStatus_Cancelled, jarvis.RunStatus_Blocked:
		return "reviewer ended without a verdict"
	}
	if workerControllerGone(ctx, run) {
		return "reviewer exited without a verdict"
	}
	return ""
}

// stopReviewer cancels a reviewer being replaced and stops its process once the tick commits. A reviewer
// that already finished keeps the status it finished with.
func stopReviewer(ctx context.Context, g *waveobj.TaskGroup, runID string, afterCommit *[]func()) {
	*afterCommit = append(*afterCommit, func() {
		if err := wstore.UpdateRun(ctx, g.ChannelId, runID, func(r *waveobj.Run) error {
			if r.Status == jarvis.RunStatus_Executing || r.Status == jarvis.RunStatus_Planning {
				*r = jarvis.CancelRun(*r)
			}
			return nil
		}); err != nil {
			log.Printf("dag %s: cancelling reviewer run %s: %v", g.OID, runID, err)
			return
		}
		run, err := wstore.GetRun(ctx, g.ChannelId, runID)
		if err != nil {
			return
		}
		if err := stopRunWorkers(ctx, run); err != nil {
			log.Printf("dag %s: stopping reviewer run %s: %v", g.OID, runID, err)
		}
	})
}

// spendReviewRespawn allows one more reviewer this round; past the limit the review fails for the lead with
// reason. It reports whether another reviewer may be spawned.
func spendReviewRespawn(ctx context.Context, g *waveobj.TaskGroup, t *waveobj.TaskNode, reason string, afterCommit *[]func()) bool {
	if t.ReviewRespawns >= MaxReviewRespawns {
		failReview(ctx, g, t, reason, afterCommit)
		return false
	}
	t.ReviewRespawns++
	return true
}

// applyReviewVerdict acts on a recorded verdict. The reviewer completes its own run after the verdict, so it
// is not stopped here.
func applyReviewVerdict(ctx context.Context, g *waveobj.TaskGroup, t *waveobj.TaskNode, worker *waveobj.Run, afterCommit *[]func()) {
	t.ReviewRunID = ""
	t.ReviewCommit = worker.EndCommit
	// a reviewer's commit would land with the lane; its uncommitted edits cannot, since a lane lands by squashing
	// its branch and the next dispatch rebuilds a dirty tree
	head, err := reviewTreeHead(ctx, worker.ProjectPath)
	if err != nil || head != worker.EndCommit {
		reason := "reviewer modified the worktree"
		if err != nil {
			reason = "reading the worktree after review: " + err.Error()
		} else if rerr := resetReviewTree(ctx, worker.ProjectPath, worker.EndCommit); rerr != nil {
			reason += "; resetting it failed: " + rerr.Error()
		}
		// the discarded verdict must not read as the review's outcome
		t.ReviewVerdict, t.ReviewDownstream = "", ""
		failReview(ctx, g, t, reason, afterCommit)
		return
	}
	taskID, note, downstream := t.ID, t.ReviewNote, t.ReviewDownstream
	if t.ReviewVerdict == ReviewVerdict_Pass {
		t.State = TaskState_Done
		t.LeadGuidance = ""
		*afterCommit = append(*afterCommit, func() {
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskReviewPassed, nil, map[string]any{"taskid": taskID, "note": note, "downstream": downstream})
			PostQuiet(ctx, g.ChannelId, g.RunID, fmt.Sprintf("%s passed review: %s", taskID, truncateNote(note, handoffMaxSummaryLen)))
			if downstream != "" {
				PostWake(ctx, g.ChannelId, g.RunID, downstreamWake(taskID, downstream))
			}
		})
		return
	}
	t.ReviewRound++
	if t.ReviewRound >= MaxReviewRounds {
		failReview(ctx, g, t, note, afterCommit)
		return
	}
	round := t.ReviewRound
	// back to a worker in the same lane tree, which still holds the rejected commit; taskPrompt carries the findings
	t.State = TaskState_Pending
	t.RunID = ""
	*afterCommit = append(*afterCommit, func() {
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskReviewFailed, nil, map[string]any{"taskid": taskID, "note": note, "round": round, "final": false})
	})
}

// failReview hands a task's review to the lead: failed rounds spent, or a reviewer that could not do its job.
// The worker's run stays on the task, so the lead's approve can land it as it is.
func failReview(ctx context.Context, g *waveobj.TaskGroup, t *waveobj.TaskNode, reason string, afterCommit *[]func()) {
	t.State = TaskState_ReviewFailed
	t.ReviewNote = reason
	taskID, round := t.ID, t.ReviewRound
	*afterCommit = append(*afterCommit, func() {
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskReviewFailed, nil, map[string]any{"taskid": taskID, "note": reason, "round": round, "final": true})
		PostWake(ctx, g.ChannelId, g.RunID, reviewFailedWake(taskID))
	})
}

// RecordReviewVerdict records a reviewer's verdict on the task it reviews. It does not schedule: the caller
// does, off the reviewer's RPC, because the tick that applies a fail can spawn the next worker.
func RecordReviewVerdict(ctx context.Context, dagID, reviewerRunID, verdict, note, downstream string) error {
	note, downstream = strings.TrimSpace(note), strings.TrimSpace(downstream)
	switch {
	case verdict != ReviewVerdict_Pass && verdict != ReviewVerdict_Fail:
		return fmt.Errorf("verdict must be %s or %s, got %q", ReviewVerdict_Pass, ReviewVerdict_Fail, verdict)
	case note == "":
		return fmt.Errorf("a %s verdict needs its note: the summary for a pass, the findings for a fail", verdict)
	case verdict == ReviewVerdict_Fail && downstream != "":
		return fmt.Errorf("--downstream goes with a pass; put what later tasks need in the findings")
	}
	return withDagMutation(dagID, func() error {
		g, err := wstore.GetDag(ctx, dagID)
		if err != nil {
			return fmt.Errorf("loading dag: %w", err)
		}
		t := taskByReviewRunID(g, reviewerRunID)
		if t == nil || t.State != TaskState_Reviewing {
			return fmt.Errorf("run %s is not reviewing a task of this dag", reviewerRunID)
		}
		if t.ReviewVerdict != "" {
			return fmt.Errorf("task %s already has a %s verdict", t.ID, t.ReviewVerdict)
		}
		t.ReviewVerdict = verdict
		t.ReviewNote = clipRunes(note, MaxReviewNoteLen)
		t.ReviewDownstream = clipRunes(downstream, MaxReviewNoteLen)
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
}

// reviewPrompt is a reviewer's whole brief: what the task asked for, where the spec and plan are, what the
// worker said it did, and the one diff to judge. It checks intent, not tests: Verify runs those at the merge.
func reviewPrompt(g *waveobj.TaskGroup, task *waveobj.TaskNode, worker *waveobj.Run) string {
	var b strings.Builder
	fmt.Fprintf(&b, "You are the reviewer for task %s", task.ID)
	if g.PlanPath != "" {
		fmt.Fprintf(&b, " of the plan at %s", g.PlanPath)
	}
	if g.SpecPath != "" {
		fmt.Fprintf(&b, " (spec: %s)", g.SpecPath)
	}
	b.WriteString(". A worker finished it; judge its change against what the task asked for before it lands.\n")
	fmt.Fprintf(&b, "The change: `git diff %s..%s` in this directory.\n", task.ReviewBase, worker.EndCommit)
	b.WriteString("Check it against the task below and the spec: every requirement met, nothing that contradicts the spec, no corners cut (stubs, skipped cases, weakened or deleted tests, TODOs), nothing outside the task's scope. The plan's Verify runs the tests after the merge, so don't run the full suite; run a focused test only to settle a doubt.\n")
	b.WriteString("Only read: never edit, stage or commit, and ask no questions, since nobody answers a reviewer.\n")
	b.WriteString("Finish with exactly one command, which ends your session:\n")
	b.WriteString("- `wsh jarvis dag review pass \"<one paragraph: what landed>\"`, adding `--downstream \"<what a later task must know>\"` when the change affects later tasks (a renamed API, a plan assumption that turned out wrong);\n")
	b.WriteString("- `wsh jarvis dag review fail \"<findings: each problem, where it is, and the fix>\"`.\n\n")
	if g.Preamble != "" {
		b.WriteString("The plan's header applies to every task:\n")
		b.WriteString(g.Preamble)
		b.WriteString("\n\n")
	}
	b.WriteString("The task:\n")
	goal := task.RunSpec.Goal
	if goal == "" {
		goal = task.Label
	}
	b.WriteString(goal)
	if task.Description != "" {
		b.WriteString("\n\n")
		b.WriteString(task.Description)
	}
	if worker.Evidence != nil {
		if note := truncateNote(worker.Evidence.Summary, handoffMaxSummaryLen); note != "" {
			fmt.Fprintf(&b, "\n\nThe worker reported: %s", note)
		}
	}
	return b.String()
}

// reviewFeedback is what a re-dispatched task is told about the attempt a reviewer rejected: the findings, and
// the lead's guidance when the lead sent it back. Empty for a task no reviewer has failed.
func reviewFeedback(task *waveobj.TaskNode) string {
	var parts []string
	if task.ReviewVerdict == ReviewVerdict_Fail && task.ReviewCommit != "" {
		parts = append(parts, fmt.Sprintf("A reviewer rejected the previous attempt (commit %s): %s\nFix these on top of that commit; don't restart.", task.ReviewCommit, task.ReviewNote))
	}
	if task.LeadGuidance != "" {
		parts = append(parts, "The lead's guidance: "+task.LeadGuidance)
	}
	return strings.Join(parts, "\n")
}
