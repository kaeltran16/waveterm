package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

var ErrMergeConflict = errors.New("merge conflict")

// MergeRunWorktree squash-merges wave/<runID> into the project branch and returns the merge commit
// sha. Worktree removal is the caller's step (CleanupTaskWorktree) so a cleanup failure can never
// obscure an already-landed merge. On conflict the tree is left mid-merge (ErrMergeConflict) and the
// caller resolves then calls MergeContinue.
func MergeRunWorktree(ctx context.Context, projectPath, runID, goal string) (string, error) {
	if !IsGitRepo(projectPath) {
		return "", ErrNotGitRepo
	}
	branch := "wave/" + runID
	// Idempotency: if the branch is already gone, the squash commit landed on a
	// prior attempt that failed only on worktree cleanup. Return HEAD without
	// re-merging so the caller can still stamp Merged/EndCommit and clean up.
	if _, err := git(ctx, projectPath, "rev-parse", "--verify", branch); err != nil {
		if sha, gerr := git(ctx, projectPath, "rev-parse", "HEAD"); gerr == nil {
			return strings.TrimSpace(sha), nil
		}
		return "", fmt.Errorf("squash merge: %w", err)
	}
	if _, err := git(ctx, projectPath, "merge", "--squash", branch); err != nil {
		if strings.Contains(err.Error(), "CONFLICT") {
			return "", ErrMergeConflict
		}
		// Idempotent retry: prior squash already landed, merge reports
		// "Already up to date" and there is nothing to commit.
		if strings.Contains(err.Error(), "Already up to date") {
			if sha, gerr := git(ctx, projectPath, "rev-parse", "HEAD"); gerr == nil {
				return strings.TrimSpace(sha), nil
			}
		}
		return "", fmt.Errorf("squash merge: %w", err)
	}
	return finishMerge(ctx, projectPath, runID, goal)
}

// MergeContinue completes a merge after the caller resolved conflicts in the project tree.
func MergeContinue(ctx context.Context, projectPath, runID, goal string) (string, error) {
	status, err := git(ctx, projectPath, "status", "--porcelain")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(status, "\n") {
		if strings.HasPrefix(line, "UU ") || strings.HasPrefix(line, "AA ") || strings.HasPrefix(line, "DD ") {
			return "", fmt.Errorf("unresolved conflict: %s", line)
		}
	}
	return finishMerge(ctx, projectPath, runID, goal)
}

func finishMerge(ctx context.Context, projectPath, runID, goal string) (string, error) {
	msg := fmt.Sprintf("run %s: %s", runID, firstLine(goal))
	if _, err := git(ctx, projectPath, "commit", "-m", msg); err != nil {
		// Idempotent retry: the squash commit already landed but the prior
		// attempt failed on worktree cleanup, so git commit reports
		// "nothing to commit". Treat as already merged.
		if strings.Contains(err.Error(), "nothing to commit") || strings.Contains(err.Error(), "no changes added") || strings.Contains(err.Error(), "nothing added") {
			return git(ctx, projectPath, "rev-parse", "HEAD")
		}
		return "", fmt.Errorf("merge commit: %w", err)
	}
	return git(ctx, projectPath, "rev-parse", "HEAD")
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
