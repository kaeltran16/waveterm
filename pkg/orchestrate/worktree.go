package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

var ErrNotGitRepo = errors.New("not a git repo")

// worktreeDir is the per-run linked-worktree root inside the project.
func worktreeDir(projectPath, runID string) string {
	return filepath.Join(projectPath, ".waveterm", "worktrees", runID)
}

func git(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %v: %w: %s", args, err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// IsGitRepo reports whether projectPath is inside a git working tree.
func IsGitRepo(projectPath string) bool {
	_, err := git(context.Background(), projectPath, "rev-parse", "--is-inside-work-tree")
	return err == nil
}

// CreateRunWorktree links a worktree at <project>/.waveterm/worktrees/<runID> on branch
// wave/<runID>, checked out at baseCommit (empty = current branch head).
func CreateRunWorktree(ctx context.Context, projectPath, runID, baseCommit string) (string, error) {
	if !IsGitRepo(projectPath) {
		return "", ErrNotGitRepo
	}
	wt := worktreeDir(projectPath, runID)
	args := []string{"worktree", "add", "-b", "wave/" + runID, wt}
	if baseCommit != "" {
		args = append(args, baseCommit)
	}
	if _, err := git(ctx, projectPath, args...); err != nil {
		return "", fmt.Errorf("creating worktree: %w", err)
	}
	return wt, nil
}

// RemoveRunWorktree removes the linked worktree and its branch.
func RemoveRunWorktree(ctx context.Context, projectPath, runID string) error {
	wt := worktreeDir(projectPath, runID)
	if _, err := os.Stat(wt); err != nil {
		return nil // nothing to remove
	}
	if _, err := git(ctx, projectPath, "worktree", "remove", "--force", wt); err != nil {
		return fmt.Errorf("removing worktree: %w", err)
	}
	git(ctx, projectPath, "branch", "-D", "wave/"+runID) // best-effort
	return nil
}

// DumpRecoveryPatch writes the worktree's diff vs its base to a patch file so a cancelled
// run's work is not silently lost.
func DumpRecoveryPatch(ctx context.Context, projectPath, runID string) error {
	base := "wave/" + runID
	patch, err := git(ctx, projectPath, "diff", "HEAD", base)
	if err != nil {
		return err
	}
	recDir := filepath.Join(projectPath, ".waveterm", "recovery")
	if err := os.MkdirAll(recDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(recDir, runID+".patch"), []byte(patch), 0o644)
}

// WorktreeHeadCommit returns the worktree branch's HEAD sha.
func WorktreeHeadCommit(ctx context.Context, projectPath, runID string) (string, error) {
	return git(ctx, projectPath, "rev-parse", "wave/"+runID)
}
