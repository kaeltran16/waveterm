// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	gitTimeout = 10 * time.Second
	// syncGitTimeout bounds the network commands (fetch, push); local ones keep gitTimeout.
	syncGitTimeout = 2 * time.Minute
)

// gitWaitDelay bounds the wait for a git command's pipes once git has exited or been killed. A var for
// tests.
var gitWaitDelay = 5 * time.Second

// syncGitEnv keeps a background sync from ever opening a credential prompt or dialog.
var syncGitEnv = []string{"GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never"}

// gitCommand builds `git -C dir args...`. WaitDelay: a timeout kills git only, and a helper it started
// (ssh, git-remote-https) can hold the output pipe open long past it, so without it the pipe, not the
// timeout, bounds the call, with the vault lock held.
func gitCommand(ctx context.Context, dir string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.WaitDelay = gitWaitDelay
	return cmd
}

// gitRunErr drops exec.ErrWaitDelay: git exited 0 and its output was read; only an abandoned pipe was cut.
func gitRunErr(err error) error {
	if errors.Is(err, exec.ErrWaitDelay) {
		return nil
	}
	return err
}

// runGitSync runs one sync git command. Stdout comes back untrimmed (a conflict stage must be
// written byte-exact), and an error names the command and its stderr.
func runGitSync(ctx context.Context, dir string, timeout time.Duration, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := gitCommand(ctx, dir, args...)
	cmd.Env = append(os.Environ(), syncGitEnv...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err := gitRunErr(err); err != nil {
		return out, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

// runGit runs `git -C dir args...` and returns stdout. Mirrors pkg/gitinfo's read path.
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	out, err := gitCommand(ctx, dir, args...).Output()
	return strings.TrimSpace(string(out)), gitRunErr(err)
}

// HeadAuthorForTest returns the author name of HEAD. A thin exported wrapper for sibling-package
// tests (jarvisdossier) that assert ownership-staged authorship.
func HeadAuthorForTest(ctx context.Context, root string) (string, error) {
	out, err := runGit(ctx, root, "log", "-1", "--format=%an")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// runGitErr is runGit for write operations: it captures stderr into the error so a failure's cause
// is visible.
func runGitErr(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	out, err := gitCommand(ctx, dir, args...).CombinedOutput()
	if err := gitRunErr(err); err != nil {
		return string(out), fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}
