// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const gitTimeout = 10 * time.Second

// runGit runs `git -C dir args...` and returns stdout. Mirrors pkg/gitinfo's read path.
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
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
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}
