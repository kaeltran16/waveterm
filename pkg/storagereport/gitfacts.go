// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	waveBranchPrefix = "wave/"
	maxOnlyCommits   = 20
	// bounds the wait for git's output pipe after git exits: a descendant it left behind can hold the pipe open
	gitWaitDelay = 5 * time.Second
)

// runGit runs git in dir. A failure reads "git exited N, <git's first stderr line>", the words the section shows.
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.WaitDelay = gitWaitDelay
	// a scan's status must not take the index lock a live run's git needs
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if errors.Is(err, exec.ErrWaitDelay) {
		err = nil
	}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return "", fmt.Errorf("git exited %d, %s", ee.ExitCode(), gitReason(stderr.String()))
		}
		return "", fmt.Errorf("running git %s: %w", args[0], err)
	}
	return strings.TrimRight(stdout.String(), "\r\n"), nil
}

func gitReason(stderr string) string {
	for line := range strings.SplitSeq(stderr, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			line = strings.TrimPrefix(line, "fatal: ")
			return strings.TrimPrefix(line, "error: ")
		}
	}
	return "no output"
}

func lines(out string) []string {
	var rtn []string
	for line := range strings.SplitSeq(out, "\n") {
		if line = strings.TrimRight(line, "\r"); line != "" {
			rtn = append(rtn, line)
		}
	}
	return rtn
}

// pathKey compares paths the way the file system does.
func pathKey(path string) string {
	path = filepath.Clean(path)
	if runtime.GOOS == "windows" {
		return strings.ToLower(path)
	}
	return path
}

type branchRef struct {
	tip string
	ts  int64 // the tip's committer time (ms)
}

// project is what one git call pair says about a project: its tracked trees and its wave branches.
type project struct {
	name, path string
	err        error
	tracked    map[string]bool      // pathKey of every tree git worktree list names
	branches   map[string]branchRef // "wave/<key>"
	claimed    map[string]bool      // branches a tree row carries
}

func (p *project) isTracked(path string) bool { return p.tracked[pathKey(path)] }

func loadProject(ctx context.Context, name, path string) *project {
	p := &project{name: name, path: path, claimed: map[string]bool{}}
	fi, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		p.err = errors.New("the folder does not exist")
		return p
	}
	if err == nil && !fi.IsDir() {
		err = errors.New("it is not a folder")
	}
	if err != nil {
		p.err = err
		return p
	}
	if p.tracked, err = trackedTrees(ctx, path); err != nil {
		p.err = err
		return p
	}
	p.branches, p.err = waveBranches(ctx, path)
	return p
}

func trackedTrees(ctx context.Context, projectPath string) (map[string]bool, error) {
	out, err := runGit(ctx, projectPath, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	tracked := map[string]bool{}
	for _, line := range lines(out) {
		// forward slashes on Windows; Clean turns them back
		if p, ok := strings.CutPrefix(line, "worktree "); ok {
			tracked[pathKey(p)] = true
		}
	}
	return tracked, nil
}

func waveBranches(ctx context.Context, projectPath string) (map[string]branchRef, error) {
	out, err := runGit(ctx, projectPath, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:unix)", "refs/heads/"+waveBranchPrefix)
	if err != nil {
		return nil, err
	}
	branches := map[string]branchRef{}
	for _, line := range lines(out) {
		parts := strings.Split(line, "\x00")
		if len(parts) != 3 {
			return nil, fmt.Errorf("unexpected for-each-ref line %q", line)
		}
		secs, _ := strconv.ParseInt(parts[2], 10, 64)
		branches[strings.TrimPrefix(parts[0], "refs/heads/")] = branchRef{tip: parts[1], ts: secs * 1000}
	}
	return branches, nil
}

type branchFacts struct {
	OnlyCount   int
	OnlyCommits []wshrpc.StorageCommit
	AlsoOn      string
}

// branchGitFacts finds what deleting branch would lose: its commits on no other branch or remote, less those whose
// patch is already on base (squash or cherry-pick). base "" or a missing base skips the patch match.
func branchGitFacts(ctx context.Context, projectPath, branch, tip, base string) (branchFacts, error) {
	var f branchFacts
	// --exclude takes the name --branches sees, without refs/heads/
	out, err := runGit(ctx, projectPath, "log", "--format=%H%x00%h%x00%s", "refs/heads/"+branch, "--not", "--exclude="+branch, "--branches", "--remotes")
	if err != nil {
		return f, err
	}
	hasBase := base != "" && base != branch && refExists(ctx, projectPath, "refs/heads/"+base)
	patchEqual := map[string]bool{}
	if out != "" && hasBase {
		cherry, err := runGit(ctx, projectPath, "cherry", "refs/heads/"+base, "refs/heads/"+branch)
		if err != nil {
			return f, err
		}
		for _, line := range lines(cherry) {
			if sha, ok := strings.CutPrefix(line, "- "); ok {
				patchEqual[sha] = true
			}
		}
	}
	for _, line := range lines(out) {
		parts := strings.SplitN(line, "\x00", 3)
		if len(parts) != 3 {
			return f, fmt.Errorf("unexpected git log line %q", line)
		}
		if patchEqual[parts[0]] {
			continue
		}
		f.OnlyCount++
		if len(f.OnlyCommits) < maxOnlyCommits {
			f.OnlyCommits = append(f.OnlyCommits, wshrpc.StorageCommit{Sha: parts[1], Subject: parts[2]})
		}
	}
	if f.OnlyCount > 0 {
		return f, nil
	}
	if f.AlsoOn, err = containingBranch(ctx, projectPath, branch, tip, base); err != nil {
		return f, err
	}
	if f.AlsoOn == "" && len(patchEqual) > 0 {
		f.AlsoOn = base
	}
	return f, nil
}

func refExists(ctx context.Context, projectPath, ref string) bool {
	_, err := runGit(ctx, projectPath, "rev-parse", "--verify", "-q", ref)
	return err == nil
}

// containingBranch is a branch or remote branch other than branch that holds tip, base first.
func containingBranch(ctx context.Context, projectPath, branch, tip, base string) (string, error) {
	out, err := runGit(ctx, projectPath, "branch", "-a", "--contains", tip, "--format=%(refname)")
	if err != nil {
		return "", err
	}
	var first string
	for _, ref := range lines(out) {
		var name string
		if n, ok := strings.CutPrefix(ref, "refs/heads/"); ok {
			name = n
		} else if n, ok := strings.CutPrefix(ref, "refs/remotes/"); ok && !strings.HasSuffix(n, "/HEAD") {
			name = n
		}
		// a detached HEAD lists as "(HEAD detached at ...)"
		if name == "" || name == branch {
			continue
		}
		if name == base {
			return name, nil
		}
		if first == "" {
			first = name
		}
	}
	return first, nil
}
