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

// TaskWorktreeKey derives the per-task worktree key: <owner run ID>-<task ID>. Single source of
// truth for the key — engine spawn, merge, and cancel sweeps must all derive it identically.
func TaskWorktreeKey(ownerRunID, taskID string) string {
	return ownerRunID + "-" + taskID
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
		// On Windows the dir can remain locked by an idle child shell or by
		// junctioned node_modules/src-tauri/target/dist/bin. If git no longer
		// lists the worktree, the registration is gone and the lingering dir
		// should be treated as already removed.
		if !isWorktreeRegistered(ctx, projectPath, wt) {
			git(ctx, projectPath, "branch", "-D", "wave/"+runID) // best-effort
			return nil
		}
		return fmt.Errorf("removing worktree: %w", err)
	}
	git(ctx, projectPath, "branch", "-D", "wave/"+runID) // best-effort
	return nil
}

func isWorktreeRegistered(ctx context.Context, projectPath, wt string) bool {
	out, err := git(ctx, projectPath, "worktree", "list", "--porcelain")
	if err != nil {
		return true // can't tell — assume registered so caller surfaces the error
	}
	// porcelain lists "worktree <path>" per entry
	return strings.Contains(out, wt)
}

// EnsureRunWorktree returns a usable linked worktree for runID at baseCommit. An existing tree is
// reused only when its branch still exists and the tree is clean — a clean tree whose head sits
// past baseCommit is committed child work that merge needs later, so it stays; anything dirty or
// unverifiable gets its uncommitted state dumped to a recovery patch and is rebuilt from baseCommit.
func EnsureRunWorktree(ctx context.Context, projectPath, runID, baseCommit string) (string, error) {
	wt := worktreeDir(projectPath, runID)
	if _, err := os.Stat(wt); err == nil {
		usable := false
		if _, err := WorktreeHeadCommit(ctx, projectPath, runID); err == nil {
			status, serr := git(ctx, wt, "status", "--porcelain")
			// any dirt forces a rebuild (dump first); a clean tree is reused even when its head
			// sits past baseCommit — that divergence is committed child work merge needs later
			if serr == nil && strings.TrimSpace(status) == "" {
				usable = true
			}
		}
		if usable {
			return wt, nil
		}
		DumpRecoveryPatch(ctx, projectPath, runID) // best effort; rebuild proceeds either way
		if err := RemoveRunWorktree(ctx, projectPath, runID); err != nil {
			return "", fmt.Errorf("recreating stale worktree: %w", err)
		}
	}
	return CreateRunWorktree(ctx, projectPath, runID, baseCommit)
}

// DumpRecoveryPatch writes the worktree's diff vs the project head to a patch file so a cancelled
// or recreated run's work is not silently lost. Captures both committed divergence (branch tip vs
// project HEAD) and uncommitted changes inside the linked tree.
func DumpRecoveryPatch(ctx context.Context, projectPath, runID string) error {
	base := "wave/" + runID
	patch, err := git(ctx, projectPath, "diff", "HEAD", base)
	if err != nil {
		return err
	}
	wt := worktreeDir(projectPath, runID)
	if _, statErr := os.Stat(wt); statErr == nil {
		// dump paths are discard/rebuild paths, so staging here is safe — and it pulls untracked
		// files into the diff, which plain `diff HEAD` would silently drop
		git(ctx, wt, "add", "-A")
		dirty, derr := git(ctx, wt, "diff", "--cached", "HEAD")
		if derr == nil && strings.TrimSpace(dirty) != "" {
			patch += "\n" + dirty
		}
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
