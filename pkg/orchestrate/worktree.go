package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
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

func ProjectHeadCommit(ctx context.Context, projectPath string) (string, error) {
	return git(ctx, projectPath, "rev-parse", "HEAD")
}

// TaskWorktreeKey derives a worktree key from a task: <owner run ID>-<task ID>. Tasks share their lane's
// tree, so spawn, merge, cleanup and the cancel sweep all key through LaneWorktreeKey, which calls this
// with the lane's first task.
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
	if err := removeWorktreeDir(ctx, projectPath, wt); err != nil {
		return err
	}
	git(ctx, projectPath, "branch", "-D", "wave/"+runID) // best-effort
	return nil
}

// removeWorktreeDir unregisters and deletes a linked worktree's directory and keeps its branch.
func removeWorktreeDir(ctx context.Context, projectPath, wt string) error {
	// before git sees the tree: its forced removal deletes through a junction into the target
	if err := unlinkReparsePoints(wt); err != nil {
		return fmt.Errorf("removing worktree: %w", err)
	}
	if _, err := git(ctx, projectPath, "worktree", "remove", "--force", wt); err != nil {
		// On Windows the dir can remain locked by an idle child shell or by
		// junctioned node_modules/src-tauri/target/dist/bin. If git no longer
		// lists the worktree, the registration is gone and the lingering dir
		// should be treated as already removed.
		if !isWorktreeRegistered(ctx, projectPath, wt) {
			return nil
		}
		return fmt.Errorf("removing worktree: %w", err)
	}
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

// unlinkReparsePoints removes every symlink and junction inside wt without following it. A junction
// reads as ModeIrregular rather than ModeSymlink, so both bits are checked; WalkDir does not descend
// into either.
func unlinkReparsePoints(wt string) error {
	return filepath.WalkDir(wt, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == wt || d.Type()&(fs.ModeSymlink|fs.ModeIrregular) == 0 {
			return nil
		}
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("unlinking %s: %w", path, err)
		}
		return nil
	})
}

// EnsureRunWorktree returns a usable linked worktree for runID, the commit its next task starts at, and
// whether this call created the tree, so one-time preparation runs only on a fresh tree. An existing branch
// is continued, never discarded: its commits are the finished tasks earlier in the lane, or an earlier
// attempt's work, which the next task builds on and the lane's merge lands. A clean tree on the branch is
// reused; a dirty one has its uncommitted state dumped to a recovery patch, and a dirty or missing one is
// checked out again from the branch. With no branch, the tree is created at baseCommit.
func EnsureRunWorktree(ctx context.Context, projectPath, runID, baseCommit string) (string, string, bool, error) {
	wt := worktreeDir(projectPath, runID)
	_, statErr := os.Stat(wt)
	head, headErr := WorktreeHeadCommit(ctx, projectPath, runID)
	if headErr != nil {
		if statErr == nil {
			DumpRecoveryPatch(ctx, projectPath, runID) // best effort; rebuild proceeds either way
			if err := RemoveRunWorktree(ctx, projectPath, runID); err != nil {
				return "", "", false, fmt.Errorf("recreating stale worktree: %w", err)
			}
		}
		if _, err := CreateRunWorktree(ctx, projectPath, runID, baseCommit); err != nil {
			return "", "", false, err
		}
		created, err := WorktreeHeadCommit(ctx, projectPath, runID)
		if err != nil {
			return "", "", false, fmt.Errorf("reading new worktree head: %w", err)
		}
		return wt, created, true, nil
	}
	if statErr == nil {
		if worktreeOnBranch(ctx, wt, runID) {
			status, err := git(ctx, wt, "status", "--porcelain")
			if err == nil && strings.TrimSpace(status) == "" {
				return wt, head, false, nil
			}
			DumpRecoveryPatch(ctx, projectPath, runID) // best effort; rebuild proceeds either way
		}
		if err := removeWorktreeDir(ctx, projectPath, wt); err != nil {
			return "", "", false, fmt.Errorf("recreating worktree: %w", err)
		}
	}
	// a registration whose directory is already gone makes the add refuse
	if _, err := git(ctx, projectPath, "worktree", "prune"); err != nil {
		return "", "", false, fmt.Errorf("pruning worktrees: %w", err)
	}
	if _, err := git(ctx, projectPath, "worktree", "add", wt, "wave/"+runID); err != nil {
		return "", "", false, fmt.Errorf("checking out worktree from wave/%s: %w", runID, err)
	}
	return wt, head, true, nil
}

// worktreeOnBranch reports whether wt is a checked-out tree of wave/<runID>. A directory whose registration
// git already dropped is not one, and git run inside it acts on the project checkout above it.
func worktreeOnBranch(ctx context.Context, wt, runID string) bool {
	branch, err := git(ctx, wt, "rev-parse", "--abbrev-ref", "HEAD")
	return err == nil && branch == "wave/"+runID
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
