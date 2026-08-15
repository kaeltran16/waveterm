package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
)

var ErrMergeConflict = errors.New("merge conflict")

// MergeRunWorktree squash-merges wave/<runID> into the project branch, removes the
// worktree, and returns the merge commit sha. On conflict the tree is left mid-merge
// (ErrMergeConflict) and the caller resolves then calls MergeContinue.
func MergeRunWorktree(ctx context.Context, projectPath, runID, goal string) (string, error) {
	if !IsGitRepo(projectPath) {
		return "", ErrNotGitRepo
	}
	branch := "wave/" + runID
	if _, err := git(ctx, projectPath, "merge", "--squash", branch); err != nil {
		if strings.Contains(err.Error(), "CONFLICT") {
			return "", ErrMergeConflict
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
	msg := fmt.Sprintf("run %s: %s", runID, goal)
	if _, err := git(ctx, projectPath, "commit", "-m", msg); err != nil {
		return "", fmt.Errorf("merge commit: %w", err)
	}
	sha, err := git(ctx, projectPath, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if err := RemoveRunWorktree(ctx, projectPath, runID); err != nil {
		return "", err
	}
	if _, err := os.Stat(worktreeDir(projectPath, runID)); err == nil {
		return "", fmt.Errorf("worktree still present after merge")
	}
	return sha, nil
}
