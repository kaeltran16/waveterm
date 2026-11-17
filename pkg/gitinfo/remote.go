// pkg/gitinfo/remote.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package gitinfo

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// networkGitEnv keeps a network git command from opening a credential prompt or dialog: wavesrv has no
// terminal to answer it, so a prompt would hold the command until its timeout instead of failing fast.
var networkGitEnv = []string{"GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never"}

func networkCmd(ctx context.Context, cwd string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...)
	cmd.Env = append(os.Environ(), networkGitEnv...)
	return cmd
}

// runNetwork is run for a command that talks to a remote. Its error carries stderr for failureOf.
func runNetwork(ctx context.Context, cwd string, args ...string) (string, error) {
	out, err := networkCmd(ctx, cwd, args...).Output()
	return string(out), err
}

// pushTimeout matches fetchTimeout: a push talks to the network.
const pushTimeout = 55 * time.Second

// publishRemote is where a branch with no upstream is pushed, the same default Fetch uses.
const publishRemote = "origin"

const detachedPushMessage = "HEAD is detached: check out a branch to push"

// PushResult mirrors FetchResult: git's refusal is a Failure the surface renders, not an error.
type PushResult struct {
	PushedAt int64       `json:"pushedat"` // unix seconds; 0 on failure
	Failure  *GitFailure `json:"failure,omitempty"`
	IsRepo   bool        `json:"isrepo"`
}

// Push pushes the branch checked out in cwd to its upstream, or publishes it to origin and sets the
// upstream when it has none. Never forced: a remote that moved on is git's rejection, shown as is.
func Push(ctx context.Context, cwd string) (*PushResult, error) {
	ctx, cancel := context.WithTimeout(ctx, pushTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &PushResult{IsRepo: false}, nil
	}
	branchArgs := []string{"symbolic-ref", "--quiet", "--short", "HEAD"}
	branch, err := run(ctx, cwd, branchArgs...)
	if err != nil {
		if gitFault(ctx, err) {
			return nil, describeGitError(branchArgs, err)
		}
		return &PushResult{IsRepo: true, Failure: &GitFailure{Command: "git push", ExitCode: -1, Stderr: detachedPushMessage}}, nil
	}
	args := []string{"push"}
	upArgs := []string{"rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"}
	if _, err := run(ctx, cwd, upArgs...); err != nil {
		if gitFault(ctx, err) {
			return nil, describeGitError(upArgs, err)
		}
		args = []string{"push", "-u", publishRemote, strings.TrimSpace(branch)}
	}
	if _, err := runNetwork(ctx, cwd, args...); err != nil {
		return &PushResult{IsRepo: true, Failure: failureOf(args, err)}, nil
	}
	return &PushResult{IsRepo: true, PushedAt: time.Now().Unix()}, nil
}

// RemoteFacts is where the checked-out branch stands against its upstream. Upstream is "" when the
// branch has none or HEAD is detached, and then Ahead and Behind are 0.
type RemoteFacts struct {
	HasRemote bool
	Upstream  string
	Ahead     int
	Behind    int
}

// RemoteStatus reads RemoteFacts from local refs only: Behind is as fresh as the last fetch.
func RemoteStatus(ctx context.Context, cwd string) (*RemoteFacts, error) {
	hasRemote, err := HasRemote(ctx, cwd)
	if err != nil {
		return nil, fmt.Errorf("git remote: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	facts := &RemoteFacts{HasRemote: hasRemote}
	upArgs := []string{"rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"}
	up, err := run(ctx, cwd, upArgs...)
	if err != nil {
		// git exiting non-zero is "no upstream" (or detached), a normal state; a fault is an error
		if gitFault(ctx, err) {
			return nil, describeGitError(upArgs, err)
		}
		return facts, nil
	}
	countArgs := []string{"rev-list", "--left-right", "--count", "@{u}...HEAD"}
	out, err := run(ctx, cwd, countArgs...)
	if err != nil {
		return nil, describeGitError(countArgs, err)
	}
	fields := strings.Fields(out)
	if len(fields) != 2 {
		return nil, fmt.Errorf("git %s: unexpected output %q", strings.Join(countArgs, " "), out)
	}
	behind, err1 := strconv.Atoi(fields[0])
	ahead, err2 := strconv.Atoi(fields[1])
	if err1 != nil || err2 != nil {
		return nil, fmt.Errorf("git %s: unexpected output %q", strings.Join(countArgs, " "), out)
	}
	facts.Upstream = strings.TrimSpace(up)
	facts.Ahead, facts.Behind = ahead, behind
	return facts, nil
}
