// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPlanCommandPassesQuotedArgumentsThrough(t *testing.T) {
	dir := newGitRepo(t)
	if err := execPlanCommand(context.Background(), dir, `git config wave.probe "two words"`, time.Minute); err != nil {
		t.Fatal(err)
	}
	if got := gitCmd(t, dir, "config", "wave.probe"); got != "two words" {
		t.Fatalf("the shell must hand the command over unchanged, got %q", got)
	}
}

func TestPlanCommandRunsInAPosixShell(t *testing.T) {
	dir := newGitRepo(t)
	// an inline VAR=value prefix and $(...), which cmd.exe rejected in acceptance 2, and a /-leading
	// argument Git Bash would otherwise rewrite into a Windows path
	command := `WAVE_PROBE="$(echo two) words" sh -c 'git config wave.one "$WAVE_PROBE"' && git config wave.two /usr`
	if err := execPlanCommand(context.Background(), dir, command, time.Minute); err != nil {
		t.Fatal(err)
	}
	if got := gitCmd(t, dir, "config", "wave.one"); got != "two words" {
		t.Fatalf("want the prefixed variable with its substitution, got %q", got)
	}
	if got := gitCmd(t, dir, "config", "wave.two"); got != "/usr" {
		t.Fatalf("want the argument unchanged, got %q", got)
	}
}

func TestPlanCommandReportsExitCodeAndOutput(t *testing.T) {
	err := execPlanCommand(context.Background(), newGitRepo(t), "git no-such-subcommand", time.Minute)
	var pe *planCommandError
	if !errors.As(err, &pe) {
		t.Fatalf("want a planCommandError, got %v", err)
	}
	if pe.reason() != "exit 1" || !strings.Contains(pe.output, "no-such-subcommand") {
		t.Fatalf("want exit 1 with git's message, got %q / %q", pe.reason(), pe.output)
	}
}

func TestPlanCommandTimesOut(t *testing.T) {
	err := execPlanCommand(context.Background(), t.TempDir(), "sleep 5", 200*time.Millisecond)
	var pe *planCommandError
	if !errors.As(err, &pe) || pe.reason() != "timed out after 200ms" {
		t.Fatalf("want a timeout, got %v", err)
	}
}

func TestTailBufferKeepsTheEnd(t *testing.T) {
	b := &tailBuffer{max: 5}
	b.Write([]byte("abc"))
	b.Write([]byte("defgh"))
	if got := b.String(); got != "defgh" {
		t.Fatalf("want the last 5 bytes, got %q", got)
	}
}
