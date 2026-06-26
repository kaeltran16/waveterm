// pkg/gitinfo/gitinfo.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package gitinfo runs read-only git queries for the Files cockpit surface. It shells out to the
// git binary (no go-git dependency) using fixed, read-only subcommands in a given working dir.
package gitinfo

import (
	"context"
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
