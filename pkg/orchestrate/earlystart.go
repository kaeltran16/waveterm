// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// restartEarlyDependents sends every early-started lane whose base went back to work (earlyBaseLive) back to pending,
// and returns the restarted task ids. Its workers and reviewers are cancelled and stopped after the commit; its tree is
// discarded at the next dispatch, which is slow and needs the worker gone. A lane early-based on a restarted lane
// restarts too, to a fixed point. A restart is not a failure: Attempts and g.Failures are untouched.
func restartEarlyDependents(ctx context.Context, g *waveobj.TaskGroup, afterCommit *[]func()) []string {
	if !g.MergeRequired {
		return nil
	}
	var restarted []string
	for again := true; again; {
		again = false
		for _, lane := range jarvis.Lanes(g.Tasks) {
			head := taskByID(g, lane[0])
			if head == nil || earlyBaseLive(g, head) {
				continue
			}
			restarted = append(restarted, restartLane(ctx, g, lane, head, afterCommit)...)
			// the head lost its base record, so it is live now and the loop ends
			again = true
		}
	}
	return restarted
}

// restartLane is one lane's restart; head is lane[0], whose early base went back to work.
func restartLane(ctx context.Context, g *waveobj.TaskGroup, lane []string, head *waveobj.TaskNode, afterCommit *[]func()) []string {
	now := time.Now().UnixMilli()
	baseID := head.EarlyBaseTask
	reason := restartReason(taskByID(g, baseID))
	var ids []string
	var stops []*waveobj.Run
	for _, id := range lane {
		t := taskByID(g, id)
		if t == nil || t.State == TaskState_Skipped || t.State == TaskState_Cancelled {
			continue
		}
		if t.ReviewRunID != "" {
			stopReviewer(ctx, g, t.ReviewRunID, afterCommit)
		}
		if taskActive(t.State) {
			run, err := cancelTaskRun(ctx, g, t)
			if err != nil {
				log.Printf("dag %s: restarting task %s: %v", g.OID, id, err)
			} else if run != nil {
				stops = append(stops, run)
			}
		}
		resetForRestart(t)
		// every restarted task, not only the head: its runs before now started on the discarded branch
		t.RestartTs = now
		ids = append(ids, id)
	}
	head.DiscardTree = true
	head.EarlyRestarts++
	head.EarlyBaseTask, head.EarlyBaseCommit = "", ""
	headID := head.ID
	*afterCommit = append(*afterCommit, func() {
		for _, run := range stops {
			if err := stopRunWorkers(ctx, run); err != nil {
				log.Printf("dag %s: stopping restarted task %s's worker run %s: %v", g.OID, run.TaskId, run.ID, err)
			}
		}
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskRestarted, nil, map[string]any{
			"taskid": headID, "basetask": baseID, "reason": reason,
		})
		PostQuiet(ctx, g.ChannelId, g.RunID, fmt.Sprintf("%s restarted on %s's new work: %s", headID, baseID, reason))
	})
	return ids
}

// restartReason names what the base did: a fix round after a failed review, else its state.
func restartReason(base *waveobj.TaskNode) string {
	if base == nil {
		return "predecessor removed"
	}
	if base.State == TaskState_Pending && base.ReviewRound > 0 {
		return "predecessor review failed"
	}
	return "predecessor " + base.State
}

// resetForRestart returns a task to pending with no run and no review outcome. LeadNotes stay: the lead's notes are
// about the task, not the attempt.
func resetForRestart(t *waveobj.TaskNode) {
	t.State = TaskState_Pending
	t.RunID = ""
	t.ReviewRunID, t.ReviewSpawnedTs, t.ReviewRespawns, t.ReviewRound = "", 0, 0, 0
	t.ReviewVerdict, t.ReviewNote, t.ReviewDownstream, t.ReviewUnverified = "", "", "", ""
	t.ReviewDownstreamFor = nil
	t.ReviewBase, t.ReviewCommit = "", ""
}

// discardLaneTree drops a restarted lane's tree and branch wave/<key>, so the next dispatch cuts a new branch from the
// new base instead of taking the old one for a retry. The work is saved to a recovery patch first, best effort. A
// directory a process holds after git let go of it is left behind for the cleanup path (laneLeftovers). A missing
// tree or branch is not an error.
func discardLaneTree(ctx context.Context, projectPath, key string) error {
	// best effort, as EnsureRunWorktree's: a missing branch has nothing to save
	DumpRecoveryPatch(ctx, projectPath, key, "")
	wt := laneTree(ctx, projectPath, key)
	if _, err := os.Stat(wt); err == nil {
		if err := removeWorktreeDir(ctx, projectPath, wt); err != nil && !leftBehind(ctx, projectPath, wt) {
			return fmt.Errorf("discarding the restarted lane's tree: %w", err)
		}
	}
	// a registration whose directory is gone still holds the branch
	if _, err := gitLocked(ctx, projectPath, "worktree", "prune"); err != nil {
		return fmt.Errorf("discarding the restarted lane's tree: %w", err)
	}
	branch := "refs/heads/wave/" + key
	if _, err := git(ctx, projectPath, "show-ref", "--verify", "-q", branch); err != nil {
		return nil
	}
	// update-ref, not branch -D, as RemoveRunWorktree: branch -D rewrites .git/config
	if _, err := gitLocked(ctx, projectPath, "update-ref", "-d", branch); err != nil {
		return fmt.Errorf("deleting the restarted lane's branch wave/%s: %w", key, err)
	}
	return nil
}
