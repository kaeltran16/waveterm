package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
)

var ErrMergeConflict = errors.New("merge conflict")

// MergeRunWorktree squash-merges wave/<runID> into the project branch and returns the merge commit
// sha, or "" when the branch had nothing to land. fold names uncommitted files in the project checkout that
// belong in the same commit: the run's spec and plan, on its first merge. Worktree removal is the caller's step (CleanupTaskWorktree) so a cleanup
// failure can never obscure an already-landed merge. On conflict the tree is left mid-merge
// (ErrMergeConflict) and the caller resolves then calls MergeContinue.
func MergeRunWorktree(ctx context.Context, projectPath, runID, goal string, fold []string) (string, error) {
	if !IsGitRepo(projectPath) {
		return "", ErrNotGitRepo
	}
	branch := "wave/" + runID
	// Idempotency: if the branch is already gone, the squash commit landed on a
	// prior attempt that failed only on worktree cleanup. Return that commit without
	// re-merging so the caller can still stamp Merged/EndCommit and clean up.
	if _, err := git(ctx, projectPath, "rev-parse", "--verify", branch); err != nil {
		if sha, gerr := landedHead(ctx, projectPath, runID, goal); gerr == nil {
			return sha, nil
		}
		return "", fmt.Errorf("squash merge: %w", err)
	}
	if _, err := git(ctx, projectPath, "merge", "--squash", branch); err != nil {
		if strings.Contains(err.Error(), "CONFLICT") {
			return "", ErrMergeConflict
		}
		// the branch is an ancestor of HEAD: it has no commit of its own to land
		if strings.Contains(err.Error(), "Already up to date") {
			if sha, gerr := landedHead(ctx, projectPath, runID, goal); gerr == nil {
				return sha, nil
			}
		}
		return "", fmt.Errorf("squash merge: %w", err)
	}
	return finishMerge(ctx, projectPath, runID, goal, fold, false)
}

// MergeContinue completes a merge after the caller resolved conflicts in the project tree.
func MergeContinue(ctx context.Context, projectPath, runID, goal string, fold []string) (string, error) {
	status, err := git(ctx, projectPath, "status", "--porcelain")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(status, "\n") {
		if strings.HasPrefix(line, "UU ") || strings.HasPrefix(line, "AA ") || strings.HasPrefix(line, "DD ") {
			return "", fmt.Errorf("unresolved conflict: %s", line)
		}
	}
	return finishMerge(ctx, projectPath, runID, goal, fold, true)
}

// finishMerge stages fold after the squash, where the automatic path's clean-index check is already behind
// it, then commits. A path git refuses to stage, because it is ignored or outside the repository, is logged
// and left out: the docs are not worth failing a merge over. resolved is a continue after a conflict, whose
// resolver may already have committed the result under a message of their own.
func finishMerge(ctx context.Context, projectPath, runID, goal string, fold []string, resolved bool) (string, error) {
	for _, path := range fold {
		if _, err := git(ctx, projectPath, "add", "--", path); err != nil {
			log.Printf("merge %s: not committing %s with the squash: %v", runID, path, err)
		}
	}
	if _, err := git(ctx, projectPath, "commit", "-m", mergeMessage(runID, goal)); err != nil {
		// "nothing to commit": the resolver's own commit, a retry whose squash commit already landed on the
		// prior attempt, or a branch whose commits change nothing
		if strings.Contains(err.Error(), "nothing to commit") || strings.Contains(err.Error(), "no changes added") || strings.Contains(err.Error(), "nothing added") {
			if resolved {
				return git(ctx, projectPath, "rev-parse", "HEAD")
			}
			return landedHead(ctx, projectPath, runID, goal)
		}
		return "", fmt.Errorf("merge commit: %w", err)
	}
	return git(ctx, projectPath, "rev-parse", "HEAD")
}

func mergeMessage(runID, goal string) string {
	return fmt.Sprintf("run %s: %s", runID, firstLine(goal))
}

// landedHead is HEAD when it is this branch's squash commit, and "" otherwise. A merge that commits nothing
// finds some other commit at HEAD, the previous lane's or a human's, and crediting the branch with it
// overstates what landed.
func landedHead(ctx context.Context, projectPath, runID, goal string) (string, error) {
	out, err := git(ctx, projectPath, "log", "-1", "--format=%H %s")
	if err != nil {
		return "", err
	}
	sha, subject, _ := strings.Cut(out, " ")
	if subject != mergeMessage(runID, goal) {
		return "", nil
	}
	return sha, nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if idx := strings.Index(s, "\n"); idx >= 0 {
		s = s[:idx]
	}
	s = strings.TrimSpace(s)
	if len(s) > 200 {
		s = s[:200]
	}
	if s == "" {
		return "merge"
	}
	return s
}
