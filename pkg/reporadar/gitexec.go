// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

const gitTimeout = 15 * time.Second

// git runs `git -C cwd <args...>` with an arg array (repo content is never interpolated into a
// shell). Mirrors pkg/gitinfo's safe invocation.
func git(ctx context.Context, cwd string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...)
	out, err := cmd.Output()
	return string(out), err
}

func gitHead(ctx context.Context, cwd string) (string, error) {
	out, err := git(ctx, cwd, "rev-parse", "HEAD")
	return strings.TrimSpace(out), err
}

// gitDirtyFingerprint returns a short digest of the porcelain status ("" when clean), so a scan can
// detect the working tree changing mid-scan.
func gitDirtyFingerprint(ctx context.Context, cwd string) string {
	out, err := git(ctx, cwd, "status", "--porcelain=v1")
	if err != nil {
		return ""
	}
	st := strings.TrimSpace(out)
	if st == "" {
		return ""
	}
	return shortHash(st)
}
