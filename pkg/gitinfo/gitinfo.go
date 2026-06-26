// pkg/gitinfo/gitinfo.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package gitinfo runs git queries for the Files cockpit surface and creates worktrees for the
// New Agent launcher. It shells out to the git binary (no go-git dependency) using fixed
// subcommands in a given working dir.
package gitinfo

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const gitTimeout = 10 * time.Second

type Changes struct {
	Branch  string
	StatusZ string
	Numstat string
	IsRepo  bool
}

type Diff struct {
	Diff      string
	Content   string
	Untracked bool
}

func run(ctx context.Context, cwd string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...)
	out, err := cmd.Output()
	return string(out), err
}

func GetChanges(ctx context.Context, cwd string) (*Changes, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &Changes{IsRepo: false}, nil
	}
	branch, _ := run(ctx, cwd, "rev-parse", "--abbrev-ref", "HEAD")
	statusZ, err := run(ctx, cwd, "status", "--porcelain=v1", "-z")
	if err != nil {
		return nil, err
	}
	// `diff --numstat HEAD` errors on a repo with no commits yet; status is still meaningful.
	numstat, _ := run(ctx, cwd, "diff", "--numstat", "HEAD")
	return &Changes{Branch: strings.TrimSpace(branch), StatusZ: statusZ, Numstat: numstat, IsRepo: true}, nil
}

func GetDiff(ctx context.Context, cwd, path string) (*Diff, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	st, _ := run(ctx, cwd, "status", "--porcelain=v1", "--", path)
	if strings.HasPrefix(strings.TrimSpace(st), "??") {
		content, err := os.ReadFile(filepath.Join(cwd, path))
		if err != nil {
			return nil, err
		}
		return &Diff{Content: string(content), Untracked: true}, nil
	}
	diff, err := run(ctx, cwd, "diff", "HEAD", "--", path)
	if err != nil {
		return nil, err
	}
	return &Diff{Diff: diff}, nil
}

type BranchInfo struct {
	Name string
	Age  string // relative committer date, e.g. "2 hours ago"
}

// ListBranches returns the local branches of the repo at repoPath, most-recently-committed first.
// It returns an empty slice (no error) when repoPath is not a git repository, so the caller can
// degrade to free-text input without surfacing an error.
func ListBranches(ctx context.Context, repoPath string) ([]BranchInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, repoPath, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return nil, nil
	}
	out, err := run(ctx, repoPath, "for-each-ref", "--sort=-committerdate",
		"--format=%(refname:short)\t%(committerdate:relative)", "refs/heads")
	if err != nil {
		return nil, err
	}
	var branches []BranchInfo
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		name, age, _ := strings.Cut(line, "\t")
		branches = append(branches, BranchInfo{Name: name, Age: age})
	}
	return branches, nil
}

// runErr is like run but captures stderr into the error (for write operations where the cause matters).
func runErr(ctx context.Context, cwd string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// flattenBranch makes a git ref safe for a filesystem path segment (feat/x -> feat-x).
func flattenBranch(branch string) string {
	return strings.ReplaceAll(branch, "/", "-")
}

// WorktreePath is the sibling-dir location for a worktree of branch off the repo at repoPath:
//
//	<parent>/<basename>-worktrees/<flattened-branch>
func WorktreePath(repoPath, branch string) string {
	return filepath.Join(filepath.Dir(repoPath), filepath.Base(repoPath)+"-worktrees", flattenBranch(branch))
}

// CreateWorktree creates (or reuses) a git worktree for branch off repoPath's current HEAD, in a
// sibling dir. If the worktree dir already exists it is reused; if the branch exists it is checked
// out, otherwise a new branch is created off HEAD. Returns the worktree path.
func CreateWorktree(ctx context.Context, repoPath, branch string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, repoPath, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return "", fmt.Errorf("not a git repository: %s", repoPath)
	}
	wt := WorktreePath(repoPath, branch)
	if _, statErr := os.Stat(wt); statErr == nil {
		return wt, nil // reuse existing worktree dir
	}
	if err := os.MkdirAll(filepath.Dir(wt), 0o755); err != nil {
		return "", err
	}
	_, brErr := run(ctx, repoPath, "rev-parse", "--verify", "refs/heads/"+branch)
	if brErr == nil {
		if _, err := runErr(ctx, repoPath, "worktree", "add", wt, branch); err != nil {
			return "", err
		}
	} else {
		if _, err := runErr(ctx, repoPath, "worktree", "add", wt, "-b", branch); err != nil {
			return "", err
		}
	}
	return wt, nil
}
