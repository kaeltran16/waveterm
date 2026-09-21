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

// runPlanCommand runs a plan command through a POSIX shell in dir and returns the tail of its output,
// on a pass as well as a failure. A var so engine tests can script Setup and Verify without running
// anything.
var runPlanCommand = execPlanCommand

func execPlanCommand(ctx context.Context, dir, command string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	c, err := shellCommand(ctx, command)
	if err != nil {
		return "", err
	}
	c.Dir = dir
	c.WaitDelay = planCommandWaitDelay
	out := &tailBuffer{max: MaxPlanOutputLen}
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

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	max int
	buf []byte
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.buf = append(b.buf, p...)
	if over := len(b.buf) - b.max; over > 0 {
		b.buf = append(b.buf[:0], b.buf[over:]...)
	}
	return len(p), nil
}

// String drops a multi-byte character the cut went through rather than rendering half of it.
func (b *tailBuffer) String() string {
	return strings.TrimSpace(strings.ToValidUTF8(string(b.buf), ""))
}
