// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/util/keyedmutex"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Land states (Run.Land.State).
const (
	LandState_Pending = "pending"
	LandState_Landed  = "landed"
	LandState_Held    = "held"
)

// LandTimeout bounds one land: a re-run of Check and then Verify, each under VerifyTimeout, and the merge.
const LandTimeout = 2*VerifyTimeout + 5*time.Minute

// landLocks keeps the automatic land after completion and a human's `wsh runs land` from merging one run twice.
var landLocks = keyedmutex.New()

// inProgressOps are the git operations a checkout can be stopped in the middle of. A merge on top of one would
// fold the run into the human's half-finished work.
var inProgressOps = []struct{ path, what string }{
	{"MERGE_HEAD", "a merge is in progress"},
	{"rebase-merge", "a rebase is in progress"},
	{"rebase-apply", "a rebase is in progress"},
	{"CHERRY_PICK_HEAD", "a cherry-pick is in progress"},
}

// LandRun merges a finished branch-landed run's wave/<runId> back into the branch the run started from, in the
// project checkout, then removes the landing tree and the branch. Anything that makes the merge unsafe holds it
// with a reason instead, and the checkout is left as it was. A run that landed in the checkout has nothing to
// merge and gets nil. force lands a run whose final stage failed; it is the human's call only.
func LandRun(ctx context.Context, channelID, runID string, force bool) (*waveobj.RunLand, error) {
	landLocks.Lock(runID)
	defer landLocks.Unlock(runID)
	run, err := wstore.GetRun(ctx, channelID, runID)
	if err != nil {
		return nil, fmt.Errorf("loading run: %w", err)
	}
	if run.Land != nil && run.Land.State == LandState_Landed {
		return run.Land, nil
	}
	if run.LandPath == "" {
		return nil, nil
	}
	if run.Status != jarvis.RunStatus_Done {
		return nil, fmt.Errorf("run %s is %s; only a done run lands", runID, run.Status)
	}
	var g *waveobj.TaskGroup
	if run.DagORef != "" {
		if g, err = wstore.GetDag(ctx, run.DagORef); err != nil {
			return nil, fmt.Errorf("loading dag: %w", err)
		}
	}
	if err := saveLand(ctx, channelID, runID, &waveobj.RunLand{State: LandState_Pending}); err != nil {
		return nil, err
	}
	land := landRun(ctx, run, g, force)
	if err := saveLand(ctx, channelID, runID, land); err != nil {
		return nil, err
	}
	if land.State == LandState_Held {
		appendRunEvent(ctx, channelID, runID, waveobj.RunEventKindLandHeld, nil, map[string]any{"reason": land.Reason})
	}
	return land, nil
}

func saveLand(ctx context.Context, channelID, runID string, land *waveobj.RunLand) error {
	if err := wstore.UpdateRun(ctx, channelID, runID, func(r *waveobj.Run) error {
		r.Land = land
		return nil
	}); err != nil {
		return fmt.Errorf("saving the land: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Run, runID))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, channelID))
	return nil
}

func heldLand(reason string) *waveobj.RunLand {
	return &waveobj.RunLand{State: LandState_Held, Reason: reason}
}

// landRun makes the merge, or says why it may not. The cheap checks on the checkout run before the re-run of
// Check and Verify, so a held reason the human can fix at once is not minutes away, and again under the checkout
// claim, since the checkout can change while they run.
func landRun(ctx context.Context, run *waveobj.Run, g *waveobj.TaskGroup, force bool) *waveobj.RunLand {
	if reason := finalHold(g); reason != "" && !force {
		return heldLand(reason)
	}
	if run.BaseBranch == "" {
		return heldLand(fmt.Sprintf("the run started on a detached HEAD, so wave/%s has no branch to merge into", run.ID))
	}
	project, branch := run.ProjectPath, "wave/"+run.ID
	if reason := checkoutHold(ctx, run); reason != "" {
		return heldLand(reason)
	}
	if reason := reverifyHold(ctx, run, g); reason != "" {
		return heldLand(reason)
	}
	claim, err := claimProject(project, runDagID(run, g), "land-back")
	if err != nil {
		return heldLand(err.Error())
	}
	defer releaseProject(project, claim)
	if reason := checkoutHold(ctx, run); reason != "" {
		return heldLand(reason)
	}
	if reason := clearUntrackedCopies(ctx, project, branch); reason != "" {
		return heldLand(reason)
	}
	pre, err := ProjectHeadCommit(ctx, project)
	if err != nil {
		return heldLand("reading the checkout's head: " + err.Error())
	}
	if _, err := git(ctx, project, "merge", "--no-ff", "-m", landTitle(run, g), "-m", "Arc-Run: "+run.ID, branch); err != nil {
		return heldLand(mergeRefusal(ctx, project, run.BaseBranch, err))
	}
	land := &waveobj.RunLand{State: LandState_Landed}
	if land.Commit, err = ProjectHeadCommit(ctx, project); err != nil {
		log.Printf("run %s: reading the land's merge commit: %v", run.ID, err)
	}
	if note := movedBaseNote(ctx, run, pre); note != "" {
		land.Notes = append(land.Notes, note)
	}
	// the evidence keeps the branch's tip, so the tree and the branch are no longer needed
	if err := RemoveRunWorktree(ctx, project, run.ID); err != nil {
		log.Printf("run %s landed; removing its landing tree: %v", run.ID, err)
	}
	return land
}

func runDagID(run *waveobj.Run, g *waveobj.TaskGroup) string {
	if g != nil {
		return g.OID
	}
	return run.ID
}

// finalHold is why the final stage keeps a run from landing: only passed and unverified land. A run with no dag
// had no final stage, and the lead's own work lands.
func finalHold(g *waveobj.TaskGroup) string {
	switch {
	case g == nil:
		return ""
	case g.Final == nil || !finalTerminal(g.Final.State):
		return "the final stage has not finished"
	case g.Final.State == FinalState_Failed:
		return "the final stage failed"
	}
	return ""
}

// checkoutHold is why the project checkout cannot take the merge now: it is on another branch, stopped inside a
// git operation, or has staged changes the merge commit would sweep in.
func checkoutHold(ctx context.Context, run *waveobj.Run) string {
	project := run.ProjectPath
	cur, err := git(ctx, project, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return "reading the checkout's branch: " + err.Error()
	}
	if cur != run.BaseBranch {
		return fmt.Sprintf("the checkout is on %s, not %s", cur, run.BaseBranch)
	}
	args := []string{"rev-parse"}
	for _, op := range inProgressOps {
		args = append(args, "--git-path", op.path)
	}
	out, err := git(ctx, project, args...)
	if err != nil {
		return "reading the checkout's git state: " + err.Error()
	}
	for i, p := range strings.Split(out, "\n") {
		p = strings.TrimSpace(p)
		if !filepath.IsAbs(p) {
			p = filepath.Join(project, p)
		}
		if _, err := os.Stat(p); err == nil && i < len(inProgressOps) {
			return "the checkout is stopped mid-operation: " + inProgressOps[i].what
		}
	}
	if clean, _ := IndexClean(ctx, project); !clean {
		return "the checkout has staged changes"
	}
	return ""
}

// reverifyHold runs Check and Verify again in the landing tree when the branch moved past the commit the final
// stage verified: the lead's wrap-up commits land too, and nothing checked them.
func reverifyHold(ctx context.Context, run *waveobj.Run, g *waveobj.TaskGroup) string {
	if g == nil {
		return ""
	}
	head, err := WorktreeHeadCommit(ctx, run.ProjectPath, run.ID)
	if err != nil {
		return "reading the run's branch: " + err.Error()
	}
	if g.Final != nil && head == g.Final.Commit {
		return ""
	}
	if g.Check == "" && g.Verify == "" {
		return ""
	}
	if err := checkLandingTree(ctx, run); err != nil {
		return "the branch moved past what the final stage verified, and it cannot be checked again: " + err.Error()
	}
	for _, c := range []struct{ name, cmd string }{{"Check", g.Check}, {"Verify", g.Verify}} {
		if c.cmd == "" {
			continue
		}
		if _, err := runPlanCommand(ctx, run.LandPath, c.cmd, VerifyTimeout, nil); err != nil {
			return fmt.Sprintf("the branch moved past what the final stage verified, and %s `%s` failed on it (%s)", c.name, c.cmd, failureDetail(err))
		}
	}
	return ""
}

// clearUntrackedCopies removes an untracked file in the checkout that is the same as one the branch adds: the
// lead wrote its spec or plan there before submit, and the engine committed that file on the branch. git would
// refuse to overwrite it. One that differs is the human's, and holds the land.
func clearUntrackedCopies(ctx context.Context, project, branch string) string {
	base, err := git(ctx, project, "merge-base", "HEAD", branch)
	if err != nil {
		return "finding where the run's branch forked: " + err.Error()
	}
	added, err := git(ctx, project, "diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", base, branch)
	if err != nil {
		return "listing what the run adds: " + err.Error()
	}
	var copies []string
	for _, p := range strings.Split(added, "\x00") {
		if p == "" {
			continue
		}
		full := filepath.Join(project, filepath.FromSlash(p))
		if info, err := os.Stat(full); err != nil || !info.Mode().IsRegular() {
			continue
		}
		if _, err := git(ctx, project, "ls-files", "--error-unmatch", "--", p); err == nil {
			continue // tracked: git merges it or refuses on its own
		}
		// hash-object applies the checkout's filters, so a CRLF copy of an LF file still reads as the same
		theirs, err := git(ctx, project, "rev-parse", branch+":"+p)
		if err != nil {
			return "reading " + p + " on the run's branch: " + err.Error()
		}
		mine, err := git(ctx, project, "hash-object", "--", p)
		if err != nil {
			return "reading the untracked " + p + ": " + err.Error()
		}
		if mine != theirs {
			return fmt.Sprintf("an untracked %s in the checkout differs from the one the run adds; move it aside", p)
		}
		copies = append(copies, full)
	}
	for _, full := range copies {
		if err := os.Remove(full); err != nil {
			return "removing an untracked copy of what the run adds: " + err.Error()
		}
	}
	return ""
}

// mergeRefusal says why git would not make the merge. A conflict is aborted, so the checkout is left with no
// merge state; a refusal to overwrite uncommitted edits never started one, and the edits are untouched.
func mergeRefusal(ctx context.Context, project, base string, merr error) string {
	if conflicted, err := git(ctx, project, "diff", "--name-only", "--diff-filter=U"); err == nil && conflicted != "" {
		files := strings.Join(strings.Fields(conflicted), ", ")
		if _, err := git(ctx, project, "merge", "--abort"); err != nil {
			return fmt.Sprintf("the merge conflicts with %s in %s, and aborting it failed: %v", base, files, err)
		}
		return fmt.Sprintf("the merge conflicts with %s in %s; it was aborted", base, files)
	}
	var files []string
	for _, line := range strings.Split(merr.Error(), "\n") {
		if strings.HasPrefix(line, "\t") {
			files = append(files, strings.TrimSpace(line))
		}
	}
	if len(files) > 0 {
		return "git refused the merge because it would overwrite uncommitted changes in the checkout: " + strings.Join(files, ", ")
	}
	return "git refused the merge: " + merr.Error()
}

// landTitle is the merge commit's subject: the plan's title, else the goal's first line.
func landTitle(run *waveobj.Run, g *waveobj.TaskGroup) string {
	if g != nil && strings.TrimSpace(g.Title) != "" {
		return strings.TrimSpace(g.Title)
	}
	if goal, _, _ := strings.Cut(strings.TrimSpace(run.Goal), "\n"); strings.TrimSpace(goal) != "" {
		return strings.TrimSpace(goal)
	}
	return "Land run " + run.ID
}

// movedBaseNote is set when the base branch took commits while the run worked: the final stage verified the
// branch alone, never the two together. The run's own commits are excluded, should any reach the base.
func movedBaseNote(ctx context.Context, run *waveobj.Run, pre string) string {
	if run.BaseCommit == "" {
		return ""
	}
	out, err := git(ctx, run.ProjectPath, "rev-list", "--count", pre, "^"+run.BaseCommit, "^wave/"+run.ID)
	if err != nil {
		log.Printf("run %s: counting the base's new commits: %v", run.ID, err)
		return ""
	}
	n, err := strconv.Atoi(out)
	if err != nil || n == 0 {
		return ""
	}
	commits := "commits that"
	if n == 1 {
		commits = "commit that"
	}
	return fmt.Sprintf("merged onto %d %s landed on %s during the run; the combination was not verified", n, commits, run.BaseBranch)
}
