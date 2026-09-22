// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const (
	// SetupTimeout bounds a plan's Setup command. It runs under the dag mutation lock, so Setup is for
	// preparing a worktree (junctions, a config file), not for an install.
	SetupTimeout = 2 * time.Minute
	// VerifyTimeout bounds a plan's Verify command at a merge point.
	VerifyTimeout = 20 * time.Minute
	// VerifyProgressInterval is how often a running Verify publishes its output tail. Verify is the only
	// engine step that runs a long command outside a block, so without this its output does not exist
	// anywhere until it exits and a 20-minute run is opaque for 20 minutes.
	VerifyProgressInterval = 10 * time.Second
	// MaxPlanOutputLen is how much of a plan command's output is kept: the tail. It is sized so a failing
	// early stage of a chained Verify is still in it after the later stages have run.
	MaxPlanOutputLen = 8000
	// a killed shell's children can hold its output pipe open; this bounds the wait for them.
	planCommandWaitDelay = 5 * time.Second
)

// planCommandError is a Setup or Verify command that did not exit 0.
type planCommandError struct {
	exitCode int           // -1 when there is no exit code to report
	timeout  time.Duration // set when the command was killed at its timeout
	output   string
}

// reason is the short cause a wake line carries.
func (e *planCommandError) reason() string {
	if e.timeout > 0 {
		return "timed out after " + shortDuration(e.timeout)
	}
	return fmt.Sprintf("exit %d", e.exitCode)
}

func (e *planCommandError) Error() string {
	if e.output == "" {
		return e.reason()
	}
	return e.reason() + ": " + e.output
}

// failureMarkers start a line of a failing stage's output. Heuristic and additive: a marker that does not
// match costs the old tail behavior, nothing worse.
var failureMarkers = []string{"FAIL", "--- FAIL", "error:", "panic:", "assert"}

// firstFailureExcerpt is a window of output, within MaxFailureDetailLen, that starts at the first line a
// failure marker opens. It reports "" when no line does.
func firstFailureExcerpt(output string) string {
	for rest := output; rest != ""; {
		line, next, _ := strings.Cut(rest, "\n")
		trimmed := strings.TrimSpace(line)
		for _, marker := range failureMarkers {
			if len(trimmed) >= len(marker) && strings.EqualFold(trimmed[:len(marker)], marker) {
				start := len(output) - len(rest) + strings.Index(line, trimmed)
				return strings.ToValidUTF8(truncateText(output[start:], MaxFailureDetailLen), "")
			}
		}
		rest = next
	}
	return ""
}

// failureDetail is the cause a failure event carries, within MaxFailureDetailLen. A plan command's output
// chains stages, so its first failing line is the cause and whatever ran after it is noise: the detail
// starts there. Output with no such line is cut from the front, like the tail it was kept as, so its end
// survives. Any other error keeps its head.
func failureDetail(err error) string {
	var pe *planCommandError
	if !errors.As(err, &pe) {
		return truncateText(err.Error(), MaxFailureDetailLen)
	}
	head := pe.reason() + ": "
	room := MaxFailureDetailLen - len(head)
	if excerpt := firstFailureExcerpt(pe.output); excerpt != "" {
		return head + strings.ToValidUTF8(truncateText(excerpt, room), "")
	}
	if len(pe.output) > room {
		return head + strings.ToValidUTF8(pe.output[len(pe.output)-room:], "")
	}
	return pe.Error()
}

func shortDuration(d time.Duration) string {
	if d >= time.Minute && d%time.Minute == 0 {
		return fmt.Sprintf("%dm", int(d/time.Minute))
	}
	return d.String()
}

// planProgress publishes a plan command's output tail while it is still running, reporting whether the
// tail was taken — a sink that declines (its dag was busy, or the task has stopped verifying) must not be
// recorded as having shown this tail, or it would go unpublished until the output changes again. nil for
// a command nobody watches: only Verify has a surface waiting on its progress.
type planProgress func(tail string) bool

// runPlanCommand runs a plan command through a POSIX shell in dir and returns the tail of its output,
// on a pass as well as a failure. A var so engine tests can script Setup and Verify without running
// anything; a stub calls progress itself to script mid-run output.
var runPlanCommand = execPlanCommand

func execPlanCommand(ctx context.Context, dir, command string, timeout time.Duration, progress planProgress) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	c, err := shellCommand(ctx, command)
	if err != nil {
		return "", err
	}
	c.Dir = dir
	c.WaitDelay = planCommandWaitDelay
	out := &tailBuffer{max: MaxPlanOutputLen, publish: progress, publishEvery: VerifyProgressInterval}
	c.Stdout, c.Stderr = out, out
	err = runShellCmd(c)
	if err == nil {
		return out.String(), nil
	}
	pe := &planCommandError{exitCode: -1, output: out.String()}
	var exitErr *exec.ExitError
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		pe.timeout = timeout
	case errors.As(err, &exitErr):
		pe.exitCode = exitErr.ExitCode()
	case pe.output == "":
		pe.output = err.Error()
	}
	return pe.output, pe
}

// lastOutputLine is the last non-blank line of a plan command's output: the one line a status row has
// room for. "" when there is nothing to show yet.
func lastOutputLine(output string) string {
	lines := strings.Split(output, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}
	return ""
}

// tailBuffer keeps the last max bytes written to it, and hands the tail to publish (when set) at most
// once per publishEvery. Publishing from the write path rather than a ticker goroutine keeps every
// publish inside the command's own lifetime — exec finishes copying output before Wait returns — so no
// publish can outlive the run and overwrite the result it records. Needs no lock: os/exec copies a
// command's output on one goroutine when Stdout and Stderr are the same writer.
type tailBuffer struct {
	max          int
	buf          []byte
	publish      planProgress
	publishEvery time.Duration
	lastPublish  time.Time
	lastSent     string
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.buf = append(b.buf, p...)
	if over := len(b.buf) - b.max; over > 0 {
		b.buf = append(b.buf[:0], b.buf[over:]...)
	}
	b.maybePublish(time.Now())
	return len(p), nil
}

// maybePublish hands the tail over no more than once per publishEvery, and only when it has CHANGED: a
// command whose tail has not moved costs no writes at all. The first write publishes immediately, so a
// command that prints once and then thinks is not reported as silent.
func (b *tailBuffer) maybePublish(now time.Time) {
	if b.publish == nil || now.Sub(b.lastPublish) < b.publishEvery {
		return
	}
	b.lastPublish = now
	if cur := b.String(); cur != b.lastSent && b.publish(cur) {
		b.lastSent = cur
	}
}

// String drops a multi-byte character the cut went through rather than rendering half of it.
func (b *tailBuffer) String() string {
	return strings.TrimSpace(strings.ToValidUTF8(string(b.buf), ""))
}
